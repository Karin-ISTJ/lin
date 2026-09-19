# -*- coding: utf-8 -*-
"""
E2E：线上「删除角色消息」全链路
================================

背景
----
排查「删掉角色消息后重新生成，结果一模一样」时发现：
miya-chat-store.js 的 deleteMessage 内部有一处
    return purgeMemoryRowsBySource(chatId, removedIdList);
漏写了 store. 前缀。

后果：deleteMessage 每次调用都在 Promise 链里抛
ReferenceError: purgeMemoryRowsBySource is not defined，
整条链 reject。

本测试在**真实浏览器**里确认修复有效，并且删除后：
  1. deleteMessage 不再抛错、正常 resolve
  2. 消息真的从可见列表消失
  3. 记忆表里由该楼层写入的行被回收（溯源生效）

跑法：python3 test/e2e_delete_message_purge.py
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = "http://localhost:8099/index.html"


async def main():
    results = []

    def check(name, cond, detail=""):
        results.append({"name": name, "pass": bool(cond), "detail": str(detail)})

    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append("console.error: " + m.text)
              if m.type == "error" else None)

        await pg.goto(BASE, wait_until="load")
        await pg.wait_for_timeout(2500)

        # ── D0 依赖就绪 ───────────────────────────────────────
        ok = await pg.evaluate("""() => !!(window.miyaChatStore
            && window.miyaChatStore.deleteMessage
            && window.miyaChatStore.addMessage)""")
        check("D0 chat-store 就绪", ok)
        if not ok:
            await b.close()
            _report(results)
            return 1

        # ── D1 造数：联系人 → 会话 → 两条消息 ────────────────
        setup = await pg.evaluate("""async () => {
            const CS = window.miyaChatStore;
            if (CS.init) await CS.init();
            const cs = window.miyaContactsStore;
            if (cs && cs.upsertCharacter) {
                cs.upsertCharacter({ name: '删测', groupId: 'ct_default', persona: 'x' });
            }
            /*
             * 注意：addContactFromChronicle 会为联系人**自己生成 id**，
             * 传进去的 chronicleRow.id 只是「档案 id」。
             * 必须拿返回值的 contact.id 去 createChat，
             * 否则 findContact 查不到 → createChat 抛 contact_not_found。
             * （第一版就是直接用了 'ct_del'，报了 no_chat。）
             */
            const contact = await CS.addContactFromChronicle(
                { id: 'actor_del', characterId: 'actor_del', name: '删测' }
            ).catch(() => null);
            if (!contact || !contact.id) return { error: 'no_contact' };
            const chat = await CS.createChat({ contactId: contact.id }).catch(() => null);
            const cid = chat && chat.id ? String(chat.id) : null;
            if (!cid) return { error: 'no_chat' };
            const m1 = await CS.addMessage(cid, { role: 'user', content: '在吗' });
            const m2 = await CS.addMessage(cid, { role: 'assistant', content: '在的呀。' });
            const vis = CS.getMessages(cid) || [];
            return { cid, m2id: m2 && m2.id, visCount: vis.length };
        }""")
        check("D1 造数成功（会话 + 2 条消息）",
              not setup.get("error") and setup.get("visCount") == 2,
              json.dumps(setup, ensure_ascii=False))
        if setup.get("error"):
            await b.close()
            _report(results)
            return 1

        cid = setup["cid"]
        m2id = str(setup["m2id"])

        # ── D2 写一行记忆，溯源指向 m2 ───────────────────────
        #
        # 记忆表 API 与「聊天消息」不是一套，表结构是：
        #   tables = [ { id, name, columns: ['列名', ...], rows: [[值, ...], ...] } ]
        #   rowSource = { '表序号:行序号': '来源消息id' }
        # 必须**两个都写**，只写表格不写溯源，removeRowsBySource 就找不到它。
        seeded = await pg.evaluate("""async (args) => {
            const MTS = window.MiyaMemoryTableStore;
            if (!MTS || typeof MTS.setChatTables !== 'function') {
                return { error: 'no_mts' };
            }
            const cid = String(args.cid);
            const src = String(args.m2id);
            const tables = [{
                id: 't_test',
                name: '测试表',
                columns: ['内容'],
                rows: [['测试记忆：角色说她正在家。']]
            }];
            const rowSource = { '0:0': src };
            await MTS.setChatTables(cid, tables, rowSource);
            const back = MTS.getChatTables(cid) || [];
            const rows = (back[0] && back[0].rows) ? back[0].rows.length : null;
            const srcMap = MTS.getChatRowSource(cid) || {};
            return {
                rowCount: rows,
                srcMap: srcMap,
                srcPointsToM2: String(srcMap['0:0'] || '') === src
            };
        }""", {"cid": cid, "m2id": m2id})
        check("D2 记忆行写入且溯源指向被删楼层",
              seeded.get("rowCount") == 1 and seeded.get("srcPointsToM2") is True,
              json.dumps(seeded, ensure_ascii=False))

        # ── D3 核心：调用 deleteMessage，不得抛错 ─────────────
        delres = await pg.evaluate("""async (args) => {
            const CS = window.miyaChatStore;
            try {
                const r = await CS.deleteMessage(String(args.cid), String(args.m2id));
                return { ok: true, ret: r === undefined ? null : r };
            } catch (e) {
                return { ok: false, err: String(e && e.message) };
            }
        }""", {"cid": cid, "m2id": m2id})
        check("D3 deleteMessage 未抛错（ReferenceError 已修）",
              delres.get("ok") is True,
              json.dumps(delres, ensure_ascii=False))

        # ── D4 消息真的消失 ──────────────────────────────────
        after = await pg.evaluate("""(args) => {
            const CS = window.miyaChatStore;
            const vis = CS.getMessages(String(args.cid)) || [];
            return {
                visCount: vis.length,
                stillHas: vis.some(m => String(m.id) === String(args.m2id))
            };
        }""", {"cid": cid, "m2id": m2id})
        check("D4 被删消息不再出现在可见列表",
              after.get("visCount") == 1 and not after.get("stillHas"),
              json.dumps(after, ensure_ascii=False))

        # ── D5 记忆行被回收 ──────────────────────────────────
        purged = await pg.evaluate("""(args) => {
            const MTS = window.MiyaMemoryTableStore;
            if (!MTS || typeof MTS.getChatTables !== 'function') {
                return { error: 'no_mts' };
            }
            const cid = String(args.cid);
            const back = MTS.getChatTables(cid) || [];
            const rows = (back[0] && back[0].rows) ? back[0].rows.length : null;
            const srcMap = MTS.getChatRowSource(cid) || {};
            return { rowCount: rows, srcKeys: Object.keys(srcMap).length };
        }""", {"cid": cid, "m2id": m2id})
        check("D5 溯源记忆行随楼层删除被回收（整行为 0）",
              purged.get("rowCount") == 0,
              json.dumps(purged, ensure_ascii=False))

        # ── D6 无新增页面异常 ────────────────────────────────
        real = [e for e in errors if 'purgeMemoryRowsBySource' in e
                or 'ReferenceError' in e]
        check("D6 页面无 ReferenceError 类异常",
              not real, "; ".join(real[:3]) if real else "clean")

        await b.close()

    _report(results)
    return 0 if all(r["pass"] for r in results) else 1


def _report(results):
    print("=" * 74)
    print("E2E：线上「删除角色消息」全链路")
    print("=" * 74)
    for r in results:
        print(("  ✅ " if r["pass"] else "  ❌ ") + r["name"])
        if r["detail"]:
            print("       " + r["detail"])
    print("-" * 74)
    n = sum(1 for r in results if r["pass"])
    print("%d/%d 通过" % (n, len(results)))


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
