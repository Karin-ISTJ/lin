# -*- coding: utf-8 -*-
"""
线上 · 「删掉角色消息后重新生成，结果一模一样」排查
==================================================

用户报告（原话）：
  「线上功能把角色发来的消息删掉 重新生成 还是会生成一模一样的消息」

怀疑方向
--------
1. 已删消息仍在 API 上下文里 → 模型看到旧答案，原样复读
2. regenerate 的「要求改写」提示词没有送达 → 模型没有改写动机
3. 采样参数退化（temperature/top_p）→ 输出高度确定
4. 消息去重/缓存把新回复当成旧的

本测试逐条验证，用 Node 加载**真实源文件**：

  Q1  已删消息是否被排除出 API 上下文
  Q2  重新生成时，末尾 assistant 轮次是否被 omit
  Q3  regenerate 的注入块是否存在（给了模型「这是重答」的信号）
  Q4  historyTailState 在「删掉assistant后」是否仍能正确判定
  Q5  采样参数是否随 regenerate 变化（不应完全相同）
  Q6  线上是否存在「请求级缓存/key复用」导致直接返回旧结果

跑法：python3 test/audit_online_regenerate_repeat.py
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HARNESS = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = process.argv[2];

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripC(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const engSrc = read('js1/miya-chat-engine.js');
const eng = stripC(engSrc);

// ═══════════════════════════════════════════════════════════
// Q1 已删消息排除
// ═══════════════════════════════════════════════════════════
const storeSrc = read('js1/miya-chat-store.js');
const mApi = storeSrc.match(/getMessagesForApi:\s*function[\s\S]{0,600}?\n        \},/);
const apiBody = mApi ? mApi[0] : storeSrc.slice(storeSrc.indexOf('getMessagesForApi'), storeSrc.indexOf('getMessagesForApi') + 700);
check('Q1a getMessagesForApi 排除 deleted 消息',
  /!\s*m\s*\.\s*deleted/.test(apiBody),
  apiBody ? '含 !m.deleted=' + /!\s*m\s*\.\s*deleted/.test(apiBody) : '未匹配到函数体');

// ═══════════════════════════════════════════════════════════
// Q2 重生成时 omit 末尾 assistant 轮次
// ═══════════════════════════════════════════════════════════
check('Q2a 存在 omitTrailingAssistantRound 实现',
  /function\s+omitTrailingAssistantRound\s*\(/.test(eng),
  'ok');
check('Q2b buildApiMessages 在 isRegenerate 时调用 omit',
  /opts\.isRegenerate[\s\S]{0,300}?omitTrailingAssistantRound\s*\(/.test(eng),
  'isRegenerate 分支内调用=' +
  /opts\.isRegenerate[\s\S]{0,300}?omitTrailingAssistantRound\s*\(/.test(eng));

// ═══════════════════════════════════════════════════════════
// Q3 regenerate 注入块
// ═══════════════════════════════════════════════════════════
check('Q3a 引擎会为 isRegenerate 追加【重回】注入块',
  /opts\.isRegenerate[\s\S]{0,300}?buildRegenerateRoundInjectBlock/.test(eng),
  '注入块调用=' +
  /opts\.isRegenerate[\s\S]{0,300}?buildRegenerateRoundInjectBlock/.test(eng));

const fmtSrc = read('js1/miya-chat-online-format.js');
check('Q3b 【重回】注入块实现存在且非空',
  /function\s+buildRegenerateRoundInjectBlock\s*\(/.test(fmtSrc),
  'ok');

// ═══════════════════════════════════════════════════════════
// Q4 historyTailState 判定：必须跳过已删行
// ═══════════════════════════════════════════════════════════
const tailFn = eng.match(/function\s+getTrailingSpeakerState\s*\([\s\S]{0,700}?\n    \}/);
const tailBody = tailFn ? tailFn[0] : '';
check('Q4a getTrailingSpeakerState 跳过已删行',
  /row\s*\.\s*deleted/.test(tailBody),
  tailBody ? '含 row.deleted=' + /row\s*\.\s*deleted/.test(tailBody) : '未匹配到函数体');

// ═══════════════════════════════════════════════════════════
// Q5 采样参数：regenerate 是否带来差异
// ═══════════════════════════════════════════════════════════
/*
 * 关键怀疑点：如果重答与首发用**完全相同**的采样参数，
 * 且上下文也相同，那么输出接近甚至相同是**数学上的必然**，
 * 不是 bug 而是缺设计。
 *
 * 检查引擎有没有为 regenerate 做任何采样侧扰动
 * （提高温度 / 给差异化指令 等）。
 */
const payloadBlock = eng.match(/function\s+callWithSlice\s*\([\s\S]{0,2600}?\n            \}/);
const pb = payloadBlock ? payloadBlock[0] : '';
check('Q5a 构造 payload 时读取 ST 生成参数（temperature 等）',
  /getStGenerationSettings\s*\(/.test(pb),
  pb ? 'ok' : '未匹配到 payload 构造');
check('Q5b regenerate 未单独调整 temperature（采样无差异）',
  !/isRegenerate[\s\S]{0,200}?temperature/.test(pb),
  '若为 true 表示重答与首发温度相同 —— 输出易复读');
check('Q5c regenerate 未附加「换一种说法」类扰动指令到 payload',
  !/isRegenerate[\s\S]{0,400}?(换一种|不同|改写|avoid repeating|do not repeat)/i.test(eng),
  '存在差异化指令=' +
  /isRegenerate[\s\S]{0,400}?(换一种|不同|改写|avoid repeating|do not repeat)/i.test(eng));

// ═══════════════════════════════════════════════════════════
// Q6 是否存在请求级缓存
// ═══════════════════════════════════════════════════════════
check('Q6a 线上引擎无「按 chatId+内容」的回复缓存直返',
  !/replyCache\s*\[|cachedReply|lastReplyCache/i.test(eng),
  'ok');

// ═══════════════════════════════════════════════════════════
// 运行时：用真实 store 验证「删除后上下文确实不含该条」
// ═══════════════════════════════════════════════════════════
const store = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const sandbox = {
  console: { log() {}, warn() {}, error() {} },
  JSON, Date, Math, Object, Array, Number, String, Promise, RegExp, Error,
  setTimeout, clearTimeout,
  localStorage,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = function () {};
sandbox.removeEventListener = function () {};
sandbox.dispatchEvent = function () { return true; };
sandbox.indexedDB = undefined;
sandbox.document = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  getElementById() { return null; }, querySelector() { return null; },
  querySelectorAll() { return []; },
  createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, appendChild() {} }; },
  body: { classList: { add() {}, remove() {}, contains() { return false; } } },
  readyState: 'complete',
};
sandbox.CustomEvent = function (t, o) { this.type = t; Object.assign(this, o || {}); };
sandbox.miyaSyncReadJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
sandbox.miyaWriteLsJsonKey = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); };
sandbox.miyaWriteLsJsonKeySync = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); };
sandbox.fetch = function () { return Promise.reject(new Error('no network in test')); };
vm.createContext(sandbox);

(async function runtimePart() {
  try {
    vm.runInContext(storeSrc, sandbox, { filename: 'js1/miya-chat-store.js' });
  } catch (e) {
    check('R0 store 加载', false, String(e && e.message));
    console.log('__RESULT__' + JSON.stringify(results));
    return;
  }
  const CS = sandbox.miyaChatStore || sandbox.MiyaChatStore;
  check('R0 线上 chat-store 加载成功', !!CS, CS ? 'ok' : '未导出');

  if (CS) {
    try {
      if (CS.init) await CS.init();

      /*
       * 用**真实 API** 造数据，而不是直接塞 localStorage。
       *
       * 原因：store 首次访问会从缓存/磁盘水合，直接改 localStorage
       * 不会反映到内存里的 metaCache —— 上一版就是这么写的，
       * 结果上下文读出来是 0 条（数据根本没进去）。
       * 走 addMessage 才和真实使用路径一致。
       */
      const cs2 = sandbox.miyaContactsStore;
      if (cs2 && cs2.upsertCharacter) {
        cs2.upsertCharacter({ name: '测试', groupId: 'ct_default', persona: 'x' });
      }
      await CS.addContactFromChronicle({ id: 'ct1', characterId: 'ct1', name: '测试' })
        .catch(function () {});
      const chat = await CS.createChat({ contactId: 'ct1' }).catch(function () { return null; });
      const cid = chat && chat.id ? String(chat.id) : 'c1';

      await CS.addMessage(cid, { role: 'user', content: '你好' });
      await CS.addMessage(cid, { role: 'assistant', content: '你好呀，好久不见。' });
      await CS.addMessage(cid, { role: 'user', content: '今天天气不错' });
      const m4 = await CS.addMessage(cid, { role: 'assistant', content: '是呀，阳光很好，适合出门走走。' });

      let ctx = CS.getMessagesForApi(cid) || [];
      check('R1 造数成功：上下文含 4 条', ctx.length === 4,
        '实际 ' + ctx.length + '，chatId=' + cid);

      /* 删掉最后一条 assistant（用户描述的操作）*/
      const m4id = m4 && m4.id ? String(m4.id) : null;
      if (m4id) {
        await CS.deleteMessage(cid, m4id);
        ctx = CS.getMessagesForApi(cid) || [];
        const hasM4 = ctx.some(function (m) { return String(m.id) === m4id; });
        check('R2 删掉角色消息后，该条不再出现在 API 上下文',
          !hasM4, '上下文 id=' + JSON.stringify(ctx.map(function (m) { return m.id; })));

        const last = ctx.length ? ctx[ctx.length - 1] : null;
        check('R3 删除后末条为 user（重答语义正确）',
          !!last && last.role === 'user',
          last ? ('末条 role=' + last.role) : '上下文为空');

        /* R4：重新生成时末尾 assistant 轮被 omit —— 但此时末条已是 user，
           所以 omit 不生效，模型看到的是「用户在等回复」，属正确行为 */
        check('R4 删除后重答 = 正常「回复用户」，非「重回」语义',
          !!last && last.role === 'user',
          '这正是问题所在：删掉后走的是普通回复，不是重答流程');

        /*
         * R5：决定性证据 —— 采样参数在两种流程下是否逐字相同。
         *
         * reqPayload.temperature 只来自 ST 生成设置，
         * 没有任何 isRegenerate 分支、没有 seed、没有差异化指令。
         * 也就是说：上下文相同 + 采样相同 ⇒ 输出趋同是必然。
         */
        var tempExpr = /temperature:\s*stGen\.temperature\s*!=\s*null\s*\?\s*Number\(stGen\.temperature\)\s*:\s*slice\.temperature/;
        check('R5a 线上 temperature 表达式不含 isRegenerate 分支',
          tempExpr.test(eng),
          '命中固定表达式 ⇒ 首发与重答温度完全一致');

        check('R5b 线上请求体不含 seed（无随机种子扰动）',
          !/reqPayload\.seed\s*=|seed:\s*/.test(eng),
          '存在 seed=true，不存在 seed=False（无扰动）');

        var engNoStream = eng.replace(/stream\s*=\s*false;/g, '');
        check('R5c 线上请求体不含「重答请改写」类差异化字段',
          !/(repeat_penalty|differentiate|forceRewrite|rewriteHint)/i.test(engNoStream),
          '存在差异化字段=false → 模型没有改写动机');
      } else {
        check('R2 addMessage 返回了消息 id', false, 'm4=' + JSON.stringify(m4));
      }
    } catch (e) {
      check('R1-R4 运行时验证', false, '异常：' + String(e && e.message));
    }
  }

  console.log('__RESULT__' + JSON.stringify(results));
})();
"""


def main():
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False,
                                     encoding='utf-8') as fh:
        fh.write(HARNESS)
        hp = fh.name
    try:
        proc = subprocess.run(['node', hp, ROOT], capture_output=True, text=True)
    finally:
        try:
            os.unlink(hp)
        except OSError:
            pass

    out = proc.stdout + proc.stderr
    if '__RESULT__' not in out:
        print('HARNESS FAILED —— 原始输出：')
        print(out[:5000])
        return 1
    payload = out.split('__RESULT__', 1)[1].strip().splitlines()[0]
    results = json.loads(payload)

    passed = sum(1 for r in results if r['pass'])
    total = len(results)
    print('=' * 74)
    print('线上「删除后重新生成仍一模一样」排查')
    print('=' * 74)
    for r in results:
        print(('  ✅ ' if r['pass'] else '  ⚠️  ') + r['name'])
        if r['detail']:
            print('       ' + r['detail'])
    print('-' * 74)
    print('%d/%d 成立' % (passed, total))
    return 0


if __name__ == '__main__':
    sys.exit(main())
