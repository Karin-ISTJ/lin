# -*- coding: utf-8 -*-
"""
线下工程 · 「删除卷宗后内容仍进 API」端到端验证
================================================

与 audit_mirror_survival_after_delete.py 的分工：
  · 那份是**纯函数级**取证，证明 shouldKeepOfflineMirror 的判定语义；
  · 本份是**端到端**验证，在真实浏览器里走完整链路：

      建角色 → 建联系人与线上聊天 → 开一场线下卷宗 → 往卷宗里写密文
      → 该密文被镜像进线上线程（offlineMeet 行）
      → 记下「删除前」API 上下文是否能看到密文（应当看到）
      → 删掉卷宗
      → 再取 API 上下文，密文**必须消失**

跑法：python3 test/e2e_mirror_leak_after_delete.py
（需要本地 http 服务：python3 -m http.server 8099）
"""
import asyncio
import json
import sys

from playwright.async_api import async_playwright

BASE = 'http://127.0.0.1:8099/index.html'
SEED = "try{localStorage.clear();}catch(e){}"

PROBE = r"""
async () => {
    const out = { steps: [] };
    const log = (k, v) => out.steps.push([k, v]);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const SECRET = '【绝密】去年海边约定：小满最怕打雷，雷雨天要抱着她。';

    const cs = window.miyaContactsStore;
    const st = window.miyaChatStore;
    const aps = window.MiyaAppointmentStore;
    const mem = window.MiyaAppointmentMemory;

    if (!cs || !st || !aps) {
        return { fatal: 'modules_missing', have: {
            cs: !!cs, st: !!st, aps: !!aps, mem: !!mem } };
    }

    await cs.whenReady();
    if (st.init) await st.init();
    if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
    await sleep(300);

    // ── 建角色 / 联系人 / 聊天 ──
    cs.upsertCharacter({ name: '小满', groupId: 'ct_default', persona: '温柔、怕打雷' });
    const chr = (cs.listCharacters() || [])[0];
    if (!chr) return { fatal: 'no_character' };
    st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '小满' });
    await sleep(400);
    const contact = (st.getContacts() || [])[0];
    if (!contact) return { fatal: 'no_contact' };
    const chat = await st.createChat({ contactId: contact.id });
    const chatId = String((chat && chat.id) || '').trim();
    if (!chatId) return { fatal: 'no_chat' };
    log('chatId', chatId);

    // ── 开一场线下卷宗，写入密文 ──
    const sess = aps.startNewSession(chatId, contact.id);
    const sid = String((sess && sess.id) || '').trim();
    if (!sid) return { fatal: 'no_session' };
    log('sessionId', sid);

    aps.addMessage(chatId, sid, { role: 'user', content: SECRET });
    aps.addMessage(chatId, sid, { role: 'assistant', content: '嗯，我记住了。' });
    await sleep(600);

    // 触发镜像同步
    if (typeof aps.syncAllSessionsToChat === 'function') {
        try { aps.syncAllSessionsToChat(chatId, contact.id); } catch (e) {}
    }
    await sleep(600);

    // ── 统计线上线程里的镜像 ──
    function countMirrors() {
        let n = 0, withSecret = 0;
        const meta = st.getMeta ? st.getMeta() : null;
        const mbc = (meta && meta.messagesByChat) || {};
        Object.keys(mbc).forEach(function (tid) {
            (mbc[tid] || []).forEach(function (m) {
                if (!m || !m.offlineMeet || m.deleted) return;
                n++;
                if (String(m.content || '').indexOf('绝密') >= 0) withSecret++;
            });
        });
        return { total: n, withSecret: withSecret };
    }

    // ── 抽取真正的 API 上下文文本 ──
    const engine = window.miyaChatEngine;
    function apiContextText() {
        if (!engine || typeof engine.buildApiMessages !== 'function') return null;
        try {
            const r = engine.buildApiMessages(chatId, '你在吗', {});
            const msgs = (r && r.messages) || [];
            return msgs.map(function (m) { return String((m && m.content) || ''); }).join('\n');
        } catch (e) {
            return 'ERR:' + (e && e.message);
        }
    }

    const before = countMirrors();
    const ctxBefore = apiContextText();
    log('删除前 存活的 offlineMeet 镜像数', before.total);
    log('删除前 含密文的镜像数', before.withSecret);
    log('删除前 API 上下文含密文', ctxBefore == null ? 'no_engine' : (ctxBefore.indexOf('绝密') >= 0));

    // ── 删除卷宗 ──
    aps.deleteSession(chatId, sid);
    await sleep(900);

    // 删除后重新取（走新一次 buildApiMessages，确保读到最新存储）
    const after = countMirrors();
    const ctxAfter = apiContextText();
    log('删除后 存活的 offlineMeet 镜像数', after.total);
    log('删除后 含密文的镜像数', after.withSecret);
    log('删除后 API 上下文含密文', ctxAfter == null ? 'no_engine' : (ctxAfter.indexOf('绝密') >= 0));

    // ── 墓碑状态 ──
    let tomb = [];
    try { tomb = aps.getDeletedSessionIds ? aps.getDeletedSessionIds() : []; } catch (e) {}
    log('墓碑里的 session 数', (tomb || []).length);
    log('本卷宗已进墓碑', (tomb || []).map(String).indexOf(sid) >= 0);

    // ── 卷宗是否还在列表 ──
    const list = aps.getSessions(chatId) || [];
    log('删除后卷宗列表长度', list.length);

    // ── 镜像内容是否被物理清空 ──
    let emptyMirrors = 0, nonEmptyMirrors = 0;
    const meta2 = st.getMeta ? st.getMeta() : null;
    const mbc2 = (meta2 && meta2.messagesByChat) || {};
    Object.keys(mbc2).forEach(function (tid) {
        (mbc2[tid] || []).forEach(function (m) {
            if (!m || !m.offlineMeet) return;
            if (m.deleted) return;
            if (String(m.content || '').trim()) nonEmptyMirrors++;
            else emptyMirrors++;
        });
    });
    log('残留非空镜像', nonEmptyMirrors);
    log('残留空镜像', emptyMirrors);

    return { steps: out.steps };
}
"""


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context()
        ctx.add_init_script(SEED)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(BASE, wait_until='domcontentloaded')
        await page.wait_for_timeout(2500)

        res = await page.evaluate(PROBE)
        await browser.close()

    if 'fatal' in res:
        print('探测失败：', res)
        return 1

    print('\n' + '=' * 62)
    print('端到端链路：建卷宗 → 写密文 → 镜像 → 删除 → 复检 API 上下文')
    print('=' * 62)
    for k, v in res['steps']:
        print('  %-34s %s' % (k, v))

    d = {k: v for k, v in res['steps']}

    def g(key):
        return d.get(key)

    checks = [
        ('删除前 API 上下文能看到密文（确认镜像确实进了上下文）',
         g('删除前 API 上下文含密文') is True),
        ('删除前存在含密文的镜像（复现前提成立）',
         isinstance(g('删除前 含密文的镜像数'), int) and g('删除前 含密文的镜像数') >= 1),
        ('本卷宗已写入墓碑',
         g('本卷宗已进墓碑') is True),
        ('删除后卷宗列表为空',
         g('删除后卷宗列表长度') == 0),
        ('删除后 API 上下文**不再**含密文（核心断言）',
         g('删除后 API 上下文含密文') is False),
        ('删除后无含密文的存活镜像',
         g('删除后 含密文的镜像数') == 0),
    ]

    print('\n' + '-' * 62)
    ok_n = 0
    for tag, ok in checks:
        print('  %s %s' % ('✓' if ok else '✗', tag))
        if ok:
            ok_n += 1

    print('\n%d/%d 通过' % (ok_n, len(checks)))
    if errors:
        print('\n页面错误：')
        for e in errors[:8]:
            print('  -', e)

    return 0 if ok_n == len(checks) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
