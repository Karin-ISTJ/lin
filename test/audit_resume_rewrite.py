# -*- coding: utf-8 -*-
"""
静态审计：「删掉角色回复 → 自己再说一句」这条路径的改写约束
============================================================

对应用户的第二次反馈：
    「我发现删除消息后还是会有概率发一模一样的消息 而且『换个说法』
      这句话有歧义 是同一个意思换个说法还是换一种别的」

这是 e2e_delete_then_send_rewrite.py 的静态侧补强：
e2e 证明「跑起来是对的」，这里证明「结构上也是对的」——
比如守卫有没有漏、标记是不是一次性的、两个 store 有没有互相污染。

为什么这条路径需要单独一套断言：
    它的触发条件比「重新生成」隐晦得多。重新生成有显式的按钮，
    调用链上一路带着 isRegenerate:true；而这条路径走的是**普通回复**，
    只能靠 store 上的一个瞬时标记来识别。标记的写入时机、新鲜度、
    一次性语义，任何一处写错都会表现为「用户觉得改了但没生效」——
    这种「静默失效」正是这个项目里反复出现的一类缺陷。

断言：
    S1  store 侧具备标记的三件套（打标 / 判末尾 / 取用）
    S2  标记只在「删的是末尾那条可见角色消息」时打
    S3  打标发生在落盘成功之后（顺序不能反）
    S4  标记存在内存、不进 localStorage（刷新即失效）
    S5  取用是一次性的（consume 后 armed 置 false）
    S6  引擎侧只在「非重新生成 + 末条是用户发言」时才判定
    S7  引擎侧的新鲜度判定不能是等值比较（真实流程条数会 +1）
    S8  改写文案：引用原文 + 排除同义改写 + 保人设 + 禁元叙述
    S9  只污染线上引擎，不碰线下（isOffline 早退）
    S10 取不到原文时不能报错（降级为「不提原文」，仍给约束）

跑法：python3 test/audit_resume_rewrite.py
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
const ROOT = process.argv[2];
const results = [];
function check(name, cond, detail) {
  results.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const storeSrc = read('js1/miya-chat-store.js');
const engSrc = read('js1/miya-chat-engine.js');

/*
 * 这一层注释会干扰 regex 定位，先剥掉。
 * 本项目踩过好几次：注释里举例写了某段代码，静态扫描就误以为它存在。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const store = stripComments(storeSrc);
const eng = stripComments(engSrc);

/* ══════════ S1 标记三件套 ══════════ */
check('S1a store 导出 markRewriteResume', /markRewriteResume\s*:/.test(store));
check('S1b store 导出 consumeRewriteResume', /consumeRewriteResume\s*:/.test(store));
check('S1c store 导出 peekRewriteResume', /peekRewriteResume\s*:/.test(store));

/* ══════════ S2 只在「末尾那条可见角色消息」时才打标 ══════════ */
check('S2a 存在末尾可见角色消息判定函数',
  /function\s+isTrailingVisibleAssistantMessage\s*\(/.test(store));
/*
 * 必须是「末尾 + assistant」两个条件同时成立。
 * 少判 assistant 会把「删掉自己说的话」也当成要求重答，
 * 那显然不是用户的意思。
 */
const trailFn = (store.match(
  /function\s+isTrailingVisibleAssistantMessage[\s\S]*?\n    \}/) || [''])[0];
check('S2b 判定只认角色消息（role === assistant）',
  /role\s*!==\s*'assistant'/.test(trailFn) || /role\s*===\s*'assistant'/.test(trailFn),
  '函数体长度=' + trailFn.length);
check('S2c 判定要求是可见列表的最后一条',
  /visible\[visible\.length\s*-\s*1\]/.test(trailFn),
  '含取末条=' + /visible\[visible\.length\s*-\s*1\]/.test(trailFn));

/* ══════════ S3 打标必须在落盘之后 ══════════ */
const delFn = (store.match(/deleteMessage:\s*function[\s\S]*?\n        \},/) || [''])[0];
check('S3a 定位到 deleteMessage', !!delFn, '长度=' + delFn.length);
check('S3b 打标排在 flushSaveMeta 之后',
  /flushSaveMeta[\s\S]{0,400}?markRewriteResume\s*\(/.test(delFn),
  '命中=' + /flushSaveMeta[\s\S]{0,400}?markRewriteResume\s*\(/.test(delFn));
check('S3c 判断「是否末尾」发生在 filter 之前',
  delFn.indexOf('shouldMarkRewriteResume') < delFn.indexOf('filter('),
  '打标判定在 filter 前=' +
  (delFn.indexOf('shouldMarkRewriteResume') >= 0 &&
   delFn.indexOf('shouldMarkRewriteResume') < delFn.indexOf('filter(')));

/* ══════════ S4 标记是内存态 ══════════ */
check('S4a 标记变量声明为模块级 var（非 localStorage）',
  /var\s+rewriteResume\s*=\s*\{\s*\}/.test(store));
check('S4b 标记不写入 localStorage / saveMeta',
  !/rewriteResume[\s\S]{0,200}?localStorage/.test(store),
  '含localStorage=' + /rewriteResume[\s\S]{0,200}?localStorage/.test(store));

/* ══════════ S5 一次性 ══════════ */
const consumeFn = (store.match(/consumeRewriteResume:\s*function[\s\S]*?\n        \},/) || [''])[0];
check('S5a consume 会把 armed 置 false',
  /armed\s*=\s*false/.test(consumeFn),
  '命中=' + /armed\s*=\s*false/.test(consumeFn));
check('S5b consume 只在 armed 为真时才返回 true',
  /if\s*\([^)]*!?rewriteResume\[cid\]\.armed[^)]*\)\s*return\s+false/.test(consumeFn),
  '命中=' + /armed/.test(consumeFn));

/* ══════════ S6 引擎侧判定条件 ══════════ */
check('S6a 引擎存在 shouldApplyResumeRewrite',
  /function\s+shouldApplyResumeRewrite\s*\(/.test(eng));
const gateBlock = (eng.match(/if\s*\([\s\S]{0,200}?resumeRewrite\s*=\s*shouldApplyResumeRewrite/) || [''])[0];
check('S6b 判定排除重新生成路径（!opts.isRegenerate）',
  /!\s*opts\.isRegenerate/.test(gateBlock),
  '命中=' + /!\s*opts\.isRegenerate/.test(gateBlock));
check('S6c 判定要求末条是用户发言',
  /user_spoke_last/.test(gateBlock),
  '命中=' + /user_spoke_last/.test(gateBlock));
/*
 * S6d 是最容易写错的地方：这里**不能**要求 opts.skipUserMessage。
 * 引擎调用方一律传 buildApiMessages(chatId, '', options)，
 * 所以 extra 恒为空；而真正的普通发送，用户那句话是先落 store
 * 再以「历史末条」身份出现的，opts.skipUserMessage 是 undefined。
 * 早期版本照抄了 nudge 下发的条件，结果一条都没命中。
 */
check('S6d 判定不得要求 opts.skipUserMessage（否则真实流程全不命中）',
  !/opts\.skipUserMessage/.test(gateBlock),
  '含skipUserMessage=' + /opts\.skipUserMessage/.test(gateBlock));

/* ══════════ S7 新鲜度不能等值比较 ══════════ */
check('S7a 新鲜度用下界比较而非等值',
  /cur\s*<\s*mark\.floorAt\s*-\s*1/.test(eng),
  '命中=' + /cur\s*<\s*mark\.floorAt\s*-\s*1/.test(eng));
check('S7b 不得出现 cur === mark.floorAt 这类等值判定',
  !/cur\s*[!=]==\s*mark\.floorAt/.test(eng),
  '含等值=' + /cur\s*[!=]==\s*mark\.floorAt/.test(eng));

/* ══════════ S8 改写文案 ══════════ */
const rrFn = (eng.match(/function\s+buildResumeRewriteTailNudge[\s\S]*?\n    \}/) || [''])[0];
check('S8a 定位到 buildResumeRewriteTailNudge', !!rrFn, '长度=' + rrFn.length);
check('S8b 引用被弃版的原文', /avoidBlock/.test(rrFn) && /原话是/.test(rrFn));
check('S8c 显式排除「同义改写」歧义读法', /同义改写/.test(rrFn));
check('S8d 要求换回应方向', /换一个角度切入|换一个话题侧重/.test(rrFn));
check('S8e 保留人设连贯约束', /保持人设/.test(rrFn));
check('S8f 禁止元叙述（不许说自己在改）', /元叙述/.test(rrFn));
check('S8g 复用普通回复 nudge 正文（避免两处措辞漂移）',
  /buildManualReplyToUserTailNudgeInline/.test(rrFn));

/* ══════════ S9 不污染线下 ══════════ */
const appendFn = (eng.match(
  /function\s+appendManualActionTailNudge[\s\S]*?\n    \}/) || [''])[0];
check('S9a 线下/主动推/朋友圈/拟真有早退守卫',
  /opts\.isAutoPush\s*\|\|\s*opts\.isOffline/.test(appendFn),
  '命中=' + /opts\.isAutoPush\s*\|\|\s*opts\.isOffline/.test(appendFn));
check('S9b 通话/线下预约有早退守卫',
  /opts\.callMode\s*\|\|\s*opts\.appointmentMode/.test(appendFn));
check('S9c resumeRewrite 分支早于普通 user_spoke_last 分支',
  appendFn.indexOf('resumeRewrite') <
  appendFn.indexOf('tail = buildManualReplyToUserTailNudge()'),
  '顺序正确=' + (appendFn.indexOf('resumeRewrite') >= 0 &&
                appendFn.indexOf('resumeRewrite') <
                appendFn.indexOf('tail = buildManualReplyToUserTailNudge()')));

/* ══════════ S10 取不到原文要能降级 ══════════ */
const readFn = (eng.match(/function\s+readLastRawAssistantReply[\s\S]*?\n    \}/) || [''])[0];
check('S10a readLastRawAssistantReply 有 try/catch',
  /try\s*\{/.test(readFn) && /catch/.test(readFn));
check('S10b 取不到时返回空串（不是抛错）', /return\s+''/.test(readFn));
check('S10c 引用块在无原文时为空（avoidBlock 条件拼接）',
  /prev\s*\?\s*'/.test(rrFn) || /prev\s*\?\s*"/.test(rrFn),
  '命中=' + (/prev\s*\?/.test(rrFn)));
check('S10d 原文超长会截断（防撑爆 nudge）',
  /slice\(0,\s*400\)/.test(rrFn) || /length\s*>\s*400/.test(rrFn),
  '命中=' + (/slice\(0,\s*400\)/.test(rrFn) || /length\s*>\s*400/.test(rrFn)));
check('S10e 原文先剥思维链再引用',
  /normalizePrevReplyForNudge/.test(eng),
  '定义存在=' + /function\s+normalizePrevReplyForNudge/.test(eng));

console.log('__RESULT__' + JSON.stringify(results));
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
        print(out[:4000])
        return 1
    payload = out.split('__RESULT__', 1)[1].strip().splitlines()[0]
    results = json.loads(payload)

    print('=' * 74)
    print('静态审计：「删掉角色回复 → 自己再说一句」的改写约束')
    print('=' * 74)
    for r in results:
        print(('  ✅ ' if r['pass'] else '  ❌ ') + r['name'])
        if r['detail']:
            print('       ' + r['detail'])
    print('-' * 74)
    n = sum(1 for r in results if r['pass'])
    print('%d/%d 通过' % (n, len(results)))
    return 0 if n == len(results) else 1


if __name__ == '__main__':
    sys.exit(main())
