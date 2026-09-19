# -*- coding: utf-8 -*-
"""
线下 · 「停止生成」端到端验证（真实浏览器）
==========================================

对应缺陷（用户原话）：
  「好像线下功能的停止生成键失效了」

根因（见 audit_offline_stop_generation.py 的详述）：
  线下界面三条生成路径**全都**直连 runAppointmentCompletion()，
  而登记 AbortController 的 genLife.begin() 只在
  sendAppointment / regenerateAppointment 里调用 —— 那两个界面不走。
  于是 stopAppointment → genLife.stop() 找不到 controller，
  `if (ctl) ctl.abort()` 直接跳过，fetch 从未拿到 signal。

本测试在**真实浏览器**里验证修复，覆盖：

  G1  未开始生成时，[xw-writer-go] 是「发送」态（前置）
  G2  直连 runAppointmentCompletion 后，生命周期里 controller 就位
  G3  stopAppointment → controller.signal.aborted === true（真的中断）
  G4  abort 后 fetch 被中止（停止传导到网络层）
  G5  停止后 replyInFlight 被清理（不会「停止后发不出消息」）
  G6  外层包一层（sendAppointment）时 controller 被复用、不被顶掉
  G7  停止后 UI 回到可交互（is-stop 撤掉、输入框解锁）

跑法：
  在项目根目录起服务：python3 -m http.server 8099
  python3 test/e2e_offline_stop_generation.py
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

    const Life = window.MiyaGenerationLifecycle;
    const eng = window.MiyaAppointmentEngine;
    if (!Life || !eng) {
        return { fatal: 'modules_missing', have: { Life: !!Life, eng: !!eng } };
    }

    /*
     * 建一个**真实**的 chat + 线下卷宗。
     *
     * 不能用假的 chatId：引擎在拼 prompt 时会 findChat(chatId)，
     * 找不到就抛 chat_not_found，根本走不到 fetch —— 那样测的就不是
     * 停止链路，而是「会话不存在」。
     */
    const cs = window.miyaContactsStore;
    const st = window.miyaChatStore;
    const aps = window.MiyaAppointmentStore;
    let chatId = 'probe_chat';
    let sessionId = 'probe_sess';
    let contactId = '';
    let sceneOk = false;
    try {
        if (cs && st && aps) {
            if (cs.whenReady) await cs.whenReady();
            if (st.init) await st.init();
            if (aps.ensureHydrated) { try { await aps.ensureHydrated(); } catch (e) {} }
            cs.upsertCharacter({ name: '探针', groupId: 'ct_default', persona: '测试' });
            const chr = (cs.listCharacters() || [])[0];
            if (chr) {
                st.addContactFromChronicle({ id: chr.id, characterId: chr.id, name: '探针' });
                await sleep(300);
                const contact = (st.getContacts() || [])[0];
                if (contact) {
                    const chat = await st.createChat({ contactId: contact.id });
                    const sess = aps.startNewSession(String(chat.id), contact.id);
                    if (chat && sess) {
                        chatId = String(chat.id);
                        sessionId = String(sess.id);
                        contactId = String(contact.id);
                        sceneOk = true;
                    }
                }
            }
        }
    } catch (e) { log('场景搭建异常', String(e && e.message)); }
    log('G0b 真实会话就绪', sceneOk);
    log('G0b chatId', chatId);
    log('G0b sessionId', sessionId);
    log('G0b contactId', contactId);

    const SCOPE_KEY = 'offline:' + chatId + '::' + sessionId;
    const mkArgs = () => [chatId, sessionId, {}];

    /*
     * 必须先配好 API。
     *
     * runAppointmentCompletion 开头有一道 api_not_configured 闸门，
     * 配置不全就直接 reject —— 那时还没走到生命周期登记。
     * 这是**正确的**行为（没配置就没什么可停的），但会让本探针
     * 测不到目标路径，所以这里先塞一份能过闸门的配置。
     */
    if (typeof window.miyaSetApiConfig === 'function') {
        window.miyaSetApiConfig({
            baseUrl: 'https://probe.invalid/v1',
            apiKey: 'probe-key',
            model: 'probe-model'
        });
    }
    const cfgNow = (window.miyaGetApiConfigCached && window.miyaGetApiConfigCached()) || {};
    log('G0 配置就绪', !!cfgNow.baseUrl && !!cfgNow.apiKey && !!cfgNow.model);

    // 把 network 层换成「永不结束、但认 signal」的假 fetch。
    // 这样既能验证「停止是否传到网络层」，又不会真的打外部请求。
    let fetchSig = null;
    let fetchAborted = false;
    const realFetch = window.fetch;
    window.fetch = function (url, opts) {
        const sig = (opts && opts.signal) || null;
        fetchSig = sig;
        return new Promise(function (resolve, reject) {
            function onAbort() {
                fetchAborted = true;
                const e = new Error('aborted');
                e.name = 'AbortError';
                reject(e);
            }
            if (sig) {
                if (sig.aborted) return onAbort();
                if (typeof sig.addEventListener === 'function') sig.addEventListener('abort', onAbort);
            }
            /* 不 resolve：模拟长文生成中 */
        });
    };

    // ── G1 前置：初始是发送态 ──
    const go0 = document.getElementById('xw-writer-go');
    log('G1 初始 is-stop', !!(go0 && go0.classList.contains('is-stop')));

    // ── G2 直连 runAppointmentCompletion（界面真实调用方式）──
    Life.stop(SCOPE_KEY, { silent: true });
    let p = null;
    try { p = eng.runAppointmentCompletion.apply(eng, mkArgs()); }
    catch (e) { log('G2 调用异常', String(e && e.message)); }

    const ctl = Life.getController(SCOPE_KEY);
    log('G2 controller 就位', !!ctl);

    // ── G3 stopAppointment 是否真的 abort ──
    let aborted = null;
    if (ctl) {
        eng.stopAppointment(chatId, sessionId);
        aborted = ctl.signal.aborted;
    }
    log('G3 signal.aborted', aborted);

    await sleep(150);
    log('G4 fetch 收到 signal', !!fetchSig);
    log('G4 fetch 被中止', fetchAborted);

    // ── G5 停止后忙碌标记应被清掉 ──
    log('G5 isBusy', !!eng.isBusy(chatId, sessionId));

    if (p && typeof p.catch === 'function') p.catch(function () {});

    // ── G6 幂等：外层已 begin 时 controller 不被顶掉 ──
    Life.stop(SCOPE_KEY, { silent: true });
    const outerCtl = Life.begin(SCOPE_KEY, { kind: 'offline' });
    let p2 = null;
    try { p2 = eng.runAppointmentCompletion.apply(eng, mkArgs()); } catch (e) {}
    const afterCtl = Life.getController(SCOPE_KEY);
    log('G6 controller 引用复用', afterCtl === outerCtl);
    log('G6 复用后未被误 abort', outerCtl.signal.aborted === false);
    if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
    Life.stop(SCOPE_KEY, { silent: true });

    window.fetch = realFetch;

    // ── G7 UI 收尾：把线下界面真正打开，再点一次停止键 ──
    /*
     * 必须真的打开线下界面。
     *
     * 书写区的 DOM（xw-writer-go / xw-writer-input）是在 renderWriter 里
     * 生成的，界面没打开时 document.getElementById 全都返回 null ——
     * 那样 G7 测的是「元素不存在」，不是「停止后 UI 有没有复原」。
     */
    const offlineApp = window.miyaOfflineApp;
    if (offlineApp && typeof offlineApp.open === 'function') {
        try { await offlineApp.open({ chatId: chatId, contactId: contactId }); } catch (e) {
            log('G7 打开界面异常', String(e && e.message));
        }
    }
    await sleep(700);

    const app = document.getElementById('miya-offline-app');
    const go = document.getElementById('xw-writer-go');
    const inputEl = document.getElementById('xw-writer-input');
    log('G7 书写区就位', !!(app && go && inputEl));

    if (app) app.classList.add('xw-generating');
    if (go) { go.classList.add('is-stop'); go.disabled = false; }
    if (inputEl) inputEl.disabled = true;

    /* 直接调界面上的停止处理（不依赖生成真的在跑，只验 UI 收尾）*/
    const stopApi = window.miyaOfflineApp;
    if (stopApi && typeof stopApi.__testStopGeneration === 'function') {
        stopApi.__testStopGeneration();
    } else if (app) {
        /* 退而求其次：点发送键 —— 它会按 is-stop / xw-generating 分流 */
        if (go) go.click();
    }
    await sleep(120);

    log('G7 is-stop 已撤', !!(go && !go.classList.contains('is-stop')));
    log('G7 输入框已解锁', !!(inputEl && inputEl.disabled === false));

    return { steps: out.steps };
}
"""


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--no-sandbox'])
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))

        await page.goto(BASE, wait_until='domcontentloaded')
        await page.evaluate(SEED)
        await page.reload(wait_until='load')
        await page.wait_for_timeout(1500)

        res = await page.evaluate(PROBE)
        await browser.close()

    if res.get('fatal'):
        print('❌ 环境异常：%s' % res['fatal'])
        if res.get('have'):
            print(json.dumps(res['have'], ensure_ascii=False))
        return 1

    steps = res['steps']
    print('── 执行轨迹 ──')
    for k, v in steps:
        print('  %-24s %s' % (k, json.dumps(v, ensure_ascii=False)))
    d = {k: v for k, v in steps}

    checks = []

    def check(name, cond, detail=''):
        checks.append((name, bool(cond), detail))

    check('G0 前置：API 配置就绪（否则测不到目标路径）',
          d.get('G0 配置就绪') is True, str(d.get('G0 配置就绪')))
    check('G1 前置：初始为发送态（未误挂 is-stop）', d.get('G1 初始 is-stop') is False,
          str(d.get('G1 初始 is-stop')))
    check('G2 直连 runAppointmentCompletion 后 controller 就位',
          d.get('G2 controller 就位') is True, str(d.get('G2 controller 就位')))
    check('G3 stopAppointment 真的 abort 了 signal',
          d.get('G3 signal.aborted') is True, str(d.get('G3 signal.aborted')))
    check('G4 停止传导到网络层：fetch 收到 signal',
          d.get('G4 fetch 收到 signal') is True, str(d.get('G4 fetch 收到 signal')))
    check('G4 fetch 实际被中止（不再后台空跑）',
          d.get('G4 fetch 被中止') is True, str(d.get('G4 fetch 被中止')))
    check('G5 停止后忙碌标记被清理（不会"停止后发不出消息"）',
          d.get('G5 isBusy') is False, str(d.get('G5 isBusy')))
    check('G6 外层已 begin 时 controller 被复用（未被 supersede 顶掉）',
          d.get('G6 controller 引用复用') is True, str(d.get('G6 controller 引用复用')))
    check('G6 复用后 signal 未被误 abort',
          d.get('G6 复用后未被误 abort') is True, str(d.get('G6 复用后未被误 abort')))
    check('G7 停止后 is-stop 已撤', d.get('G7 is-stop 已撤') is True,
          str(d.get('G7 is-stop 已撤')))
    check('G7 停止后输入框已解锁', d.get('G7 输入框已解锁') is True,
          str(d.get('G7 输入框已解锁')))

    print('')
    print('─' * 64)
    passed = 0
    for name, ok, detail in checks:
        print('%s %s' % ('✓' if ok else '✗', name))
        if not ok and detail:
            print('    实际：%s' % detail)
        if ok:
            passed += 1
    """
    探针里那次 fetch 是被**故意** abort 的。

    引擎和界面都在 catch 里静默处理了它（app.js:3478 / 3815 / 3915 / 4584
    四处 isAbortError 早退），所以业务侧没有故障。剩下的「aborted」页面错误
    来自探针自己持有的那个裸 promise（没人 catch），属**测试脚手架噪音**，
    不计入失败；只有其他 message 才算真异常。
    """
    noise = [e for e in errors if 'abort' in e.lower()]
    real_errors = [e for e in errors if e not in noise]
    if noise:
        print('\n（已忽略 %d 条探针自产的 abort 噪音）' % len(noise))
    if real_errors:
        print('\n⚠️ 页面真实错误 %d 条：' % len(real_errors))
        for e in real_errors[:5]:
            print('  ' + e[:200])
    print('')
    print('%d/%d 通过' % (passed, len(checks)))
    return 0 if (passed == len(checks) and not real_errors) else 1


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
