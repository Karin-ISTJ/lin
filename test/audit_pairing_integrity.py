# -*- coding: utf-8 -*-
"""
成对调用配平扫描（结构性缺陷家族）
==================================

起因
----
用户反馈：「线下停止生成键失效了」，且「以前是好的」。

定位后发现根因是一类**结构性**缺陷，而不是某一行写错：

    停止链路每一环都存在 → 静态阅读全部打勾
    但 controllers[scope] 运行时是空的 → 没人调用 begin()
    → stop() 拿到 undefined 静默跳过 → 功能是空的，却 return true

这类缺陷的共同特征：
  1. 调用方存在、被调用方存在、语法合法、不报错
  2. 缺的是「让机制真正生效的那一次登记/写入」
  3. 缺失的代码**不在文件里**，所以 grep "stop" 永远找不到它
  4. 常常伴随 return true 之类的**谎报成功**

本扫描针对这个家族，做「读侧必须有可达的写侧」的交叉验证。

扫什么
------
  P1  生命周期配平：每个 stop(scope) 的 scope 是否有可达的 begin(scope)
  P2  每处读取 controller/signal/getSignal 是否都有可达的写入者
  P3  signal 是否真的抵达 fetch（转发链不得断在没有赋值的一端）
  P4  return true 型谎报：stop 类函数是否如实回传「有没有真的停到东西」
  P5  事件监听配平：addEventListener 是否有对应 removeEventListener
  P6  定时器配平：setInterval 是否有对应 clearInterval

判定标准
--------
本扫描**只报可疑点，不擅自判错**。输出分三档：
  🔴 HIGH   明确的「有读无写」或「谎报成功」——基本可以确定是缺陷
  🟡 MEDIUM 疑似不配平，需人工确认（可能有动态注册等合理解释）
  ⚪ INFO   统计信息，供参考

跑法：python3 test/audit_pairing_integrity.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_FILES = {'jszip.min.js'}


def load_sources():
    """收集所有业务 JS 源文件（排除第三方库）。"""
    out = {}
    for sub in ('js1', 'js2'):
        d = os.path.join(ROOT, sub)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if not name.endswith('.js') or name in SKIP_FILES:
                continue
            p = os.path.join(d, name)
            try:
                with open(p, encoding='utf-8') as fh:
                    out['%s/%s' % (sub, name)] = fh.read()
            except (OSError, UnicodeDecodeError):
                pass
    return out


def line_of(src, idx):
    return src.count('\n', 0, idx) + 1


def strip_comments(src):
    """
    去掉注释，但要保持行数不变（用等长空白替换），
    否则行号会整体错位，报出来的位置全是假的。

    ⚠️ 必须同时识别**正则字面量**，否则会丢同步。

    踩过的坑：miya-api-config.js 有一行
        .replace(/[\\/:*?"<>|]/g, '_')
    正则里含一个 `"`。若扫描器只认「注释 + 字符串」，
    它会把这个 `"` 当成字符串起点，然后一路吃到下一个 `"`，
    导致这行之后**整个文件的注释剥离全部失效** ——
    表现为注释里的 getCached() / find() 被 P7 当成真代码，
    报了 6 个根本不存在的「漏写前缀」HIGH。
    """
    out = list(src)
    i, n = 0, len(src)
    # 判断当前位置是否处于「可以出现正则字面量」的位置：
    # 前一个非空白字符是运算符/开括号/分号/逗号/关键字之一
    prev_sig = ''

    def _regex_allowed():
        if not prev_sig:
            return True
        return prev_sig in '(,=:[!&|?{};+-*%~^<>'

    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = i
            while j < n and src[j] != '\n':
                out[j] = ' '
                j += 1
            i = j
        elif c == '/' and i + 1 < n and src[i + 1] == '*':
            j = i
            while j + 1 < n and not (src[j] == '*' and src[j + 1] == '/'):
                if src[j] != '\n':
                    out[j] = ' '
                j += 1
            for k in range(i, min(j + 2, n)):
                if out[k] != '\n':
                    out[k] = ' '
            i = j + 2
        elif c == '/' and _regex_allowed():
            # 正则字面量：/.../flags —— 跳过整段，避免其中的引号被误认
            j = i + 1
            in_class = False
            while j < n:
                ch = src[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == '\n':
                    break  # 正则不跨行，说明判断错了，按普通字符处理
                if ch == '[':
                    in_class = True
                elif ch == ']':
                    in_class = False
                elif ch == '/' and not in_class:
                    break
                j += 1
            if j < n and src[j] == '/':
                j += 1
                while j < n and src[j].isalpha():  # flags
                    j += 1
                i = j
                prev_sig = 'x'
                continue
            i += 1
        elif c in ('"', "'", '`'):
            quote = c
            j = i + 1
            while j < n:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == quote:
                    break
                if src[j] == '\n' and quote != '`':
                    break  # 未闭合，及时收手，避免吃穿整个文件
                j += 1
            i = j + 1
            prev_sig = 'x'
        else:
            if not c.isspace():
                prev_sig = c
            i += 1
    return ''.join(out)


def func_body(src, header_pat):
    """按大括号配平，取出某个函数的完整函数体（含签名）。"""
    m = re.search(header_pat, src)
    if not m:
        return None, 0
    start = m.start()
    brace = src.find('{', m.end() - 1)
    if brace < 0:
        return None, 0
    depth = 0
    i = brace
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                return src[start:i + 1], start
        i += 1
    return src[start:], start


class Finding(object):
    def __init__(self, level, code, file, line, msg, detail=''):
        self.level = level
        self.code = code
        self.file = file
        self.line = line
        self.msg = msg
        self.detail = detail


def main():
    sources = load_sources()
    cleaned = {k: strip_comments(v) for k, v in sources.items()}
    findings = []
    info = []

    # ══════════════════════════════════════════════════════════
    # P1/P2/P3：生成生命周期 —— scope 的「读侧 vs 写侧」
    #
    # 核心思路：把 lifecycle 的 stop(scope) / getController(scope)
    # 这类「读」调用，和 begin(scope) 这类「写」调用，按 scope 字面量
    # 归组。凡是有读的 scope，必须能找到写。
    # ══════════════════════════════════════════════════════════
    scope_writers = {}   # scope-expr -> [(file, line)]
    scope_readers = {}   # scope-expr -> [(file, line, api)]

    WRITE_RE = re.compile(
        r"""(?:genLife|life|Life|MiyaGenerationLifecycle)\s*\.\s*begin\s*\(\s*([^,)]+)""")
    READ_RE = re.compile(
        r"""(?:genLife|life|Life|MiyaGenerationLifecycle)\s*\.\s*(stop|getController|getSignal|isGenerating)\s*\(\s*([^,)]+)""")

    def canon(expr):
        """
        把 scope 表达式归一成一个「形状键」，用来跨变量名做同源匹配。

        为什么不能直接用字面量：
          写侧常写 'chat:' + String(chatId)
          读侧常写 'chat:' + id  或  'chat:' + String(state.chatId || '')
        变量名不同、取值其实是同一个 scope。按字面量比会全部误报成
        「有读无写」——第一版扫描就踩了这个坑，把线上正确的
        stopChatGeneration 误判成 HIGH。

        归一规则：剥掉 String()、空白、引号差异、下标访问，
        只留下「前缀字面量 + 拼接段数」这个形状。
        """
        e = expr or ''
        e = e.replace('"', "'")
        e = re.sub(r'\bString\s*\(', '(', e)
        e = re.sub(r'\s+', '', e)
        # (a||'') → ''（缺省兜底不影响 scope 身份）
        e = re.sub(r'\(([^()]*?)\|\|[^()]*?\)', 'X', e)
        e = re.sub(r'[A-Za-z_$][\w$]*(?:\.[\w$]+|\[[^\]]*\])*', 'V', e)
        e = re.sub(r'\bV(\+V)+\b', 'V', e)
        e = re.sub(r'V\+V', 'V', e)
        return e

    def prefix_of(expr):
        """取 scope 的字面前缀，如 'chat:' / 'offline:'，用于兜底同源判定。"""
        m = re.search(r"""['"]([^'"]*:)['"]""", expr or '')
        return m.group(1) if m else ''

    for fn, src in cleaned.items():
        for m in WRITE_RE.finditer(src):
            scope_writers.setdefault(canon(m.group(1)), []).append(
                (fn, line_of(src, m.start()), m.group(1)))
        for m in READ_RE.finditer(src):
            api, sc = m.group(1), m.group(2)
            scope_readers.setdefault(canon(sc), []).append(
                (fn, line_of(src, m.start()), api, sc))

    writers_c = {}
    for k, v in scope_writers.items():
        writers_c.setdefault(k, []).extend(v)
    readers_c = {}
    for k, v in scope_readers.items():
        readers_c.setdefault(k, []).extend(v)

    info.append('生命周期 scope：写侧 %d 种，读侧 %d 种'
                % (len(writers_c), len(readers_c)))

    for scope, reads in sorted(readers_c.items()):
        if scope in writers_c:
            continue
        # 形状键不同。退一步按「字面前缀」判同源
        # （'chat:' 的写与读即便表达式写法不同，也应视为同一族）
        pre = prefix_of(reads[0][3])
        same_prefix = [w for w in writers_c if prefix_of(writers_c[w][0][2]) == pre and pre]
        if same_prefix:
            findings.append(Finding(
                'INFO', 'P1', reads[0][0], reads[0][1],
                'scope 表达式形状不同但前缀同源（已按前缀配平，非缺陷）',
                '前缀 %-10s 读侧 %s:%d (%s)  ←  写侧 %s:%d (%s)'
                % (pre, reads[0][0], reads[0][1], reads[0][3],
                   same_prefix[0], writers_c[same_prefix[0]][0][1],
                   writers_c[same_prefix[0]][0][2])))
        else:
            findings.append(Finding(
                'HIGH', 'P1', reads[0][0], reads[0][1],
                '有读无写：该 scope 被 stop/getController 读取，但找不到对应 begin',
                'scope=%s  前缀=%s  读侧 %d 处，首处 %s:%d'
                % (scope, pre or '(无)', len(reads), reads[0][0], reads[0][1])))

    # ══════════════════════════════════════════════════════════
    # P3：signal 转发链 —— 每个「消费 signal」的点，是否有「生产 signal」的点
    #
    # 缺陷模式（停止键原样）：
    #   fetch 认真转发 handlers.signal，但 handlers.signal 从未被赋值。
    #   → 看起来链路完整，实际断在无人赋值的上游。
    # ══════════════════════════════════════════════════════════
    for fn, src in cleaned.items():
        produces = []   # handlers.signal = xxx
        consumes = []   # signal: handlers.signal
        for m in re.finditer(r'handlers\s*\.\s*signal\s*=', src):
            produces.append(line_of(src, m.start()))
        for m in re.finditer(r'signal\s*:\s*handlers\s*\.\s*signal', src):
            consumes.append(line_of(src, m.start()))
        if consumes and not produces:
            # 同文件内没有生产点。可能由上游文件传入 —— 报 MEDIUM
            findings.append(Finding(
                'MEDIUM', 'P3', fn, consumes[0],
                'signal 消费点存在但本文件无生产点（需确认上游是否赋值）',
                '消费 %d 处：%s' % (len(consumes), consumes[:5])))
        if consumes:
            info.append('%s：signal 生产 %d 处，消费 %d 处'
                        % (fn, len(produces), len(consumes)))

    # ══════════════════════════════════════════════════════════
    # P4：谎报成功 —— stop 类函数是否无脑 return true
    #
    # 缺陷模式：stopXxx() 无论有没有真的停到东西都 return true，
    # 调用方据此弹「已停止」。这是最误导用户的一种写法。
    # ══════════════════════════════════════════════════════════
    for fn, src in cleaned.items():
        for m in re.finditer(r'function\s+(stop\w*)\s*\(([^)]*)\)', src):
            name = m.group(1)
            body, off = func_body(src, re.escape('function %s(' % name))
            if not body:
                continue
            # 只看「停止/中止」语义的：体内应出现 abort / stop( / release
            looks_like_stopper = re.search(r'\.abort\s*\(|Lifecycle|\.stop\s*\(|release', body)
            if not looks_like_stopper:
                continue
            returns_true = re.search(r'return\s+true\s*;', body)
            # 是否误报：体内有基于条件的返回
            honest = re.search(r'return\s+!!|\?\s*true\s*:\s*false|return\s+had|return\s+ctl|return\s+stopped', body)
            if returns_true and not honest:
                findings.append(Finding(
                    'HIGH', 'P4', fn, line_of(src, off),
                    'stop 类函数无脑 return true（可能谎报成功）',
                    '函数 %s 未基于「是否真的停到东西」判断返回值' % name))

    # ══════════════════════════════════════════════════════════
    # P5：addEventListener / removeEventListener 配平
    #
    # 只报「同一文件内 add 明显多于 remove」且数量不大的情况，
    # 因为事件委托/一次性监听很常见，这条以 INFO/MEDIUM 为主。
    # ══════════════════════════════════════════════════════════
    for fn, src in cleaned.items():
        adds = len(re.findall(r'\.addEventListener\s*\(', src))
        rems = len(re.findall(r'\.removeEventListener\s*\(', src))
        if adds >= 5 and rems == 0:
            findings.append(Finding(
                'INFO', 'P5', fn, 1,
                '该文件 addEventListener 较多但完全无 removeEventListener',
                'add=%d  remove=0（面板类文件常如此，多为长生命周期节点，通常无害）'
                % adds))

    # ══════════════════════════════════════════════════════════
    # P6：setInterval / clearInterval 配平
    #
    # 关键：**页面级单例心跳**不需要 clearInterval。它随页面生灭，
    # 不存在「反复注册累积」的泄漏。所以必须先排除这类，否则全是误报
    # （第一版就把锁屏时钟、天气巡检两个正常实现报成了 MEDIUM）。
    #
    # 单例心跳的识别特征（命中任一即视为安全）：
    #   · 前面有幂等守卫   if (xxxTimer) return;
    #   · 包在 init()/startXxx() 里，且只被 DOMContentLoaded 调用一次
    #   · 走页面生命周期感知的封装  miyaBgSetInterval
    # 真正可疑的是「在事件回调/渲染函数里 setInterval」——那才会累积。
    # ══════════════════════════════════════════════════════════
    for fn, src in cleaned.items():
        clrs = len(re.findall(r'\bclearInterval\s*\(', src))
        if clrs:
            continue
        for m in re.finditer(r'\bsetInterval\s*\(', src):
            ln = line_of(src, m.start())
            # 往回 25 行找幂等守卫
            head = '\n'.join(src.splitlines()[max(0, ln - 26):ln])
            guarded = bool(re.search(
                r'if\s*\(\s*\w*(?:[Tt]imer|Interval)\w*\s*\)\s*return', head))
            lc = src.lower()
            lifecycle_wrapped = 'miyabgsetinterval' in lc
            """
            还有一个同样安全的形态：**模块初始化函数内的心跳**。

            特征：setInterval 位于 init()/startXxx() 内，而该函数只在
            文件尾部的 IIFE 里被调用一次（DOMContentLoaded 或立即执行）。
            这种「一次初始化、终身运行」的时钟/巡检是标准写法。

            反例才是真可疑：setInterval 写在事件回调或渲染函数里 ——
            每次进入都新注册一个，越叠越多。
            """
            initscope = False
            try:
                head_all = '\n'.join(src.splitlines()[:ln])
                # 向上找最近的函数声明，看它是不是初始化语义
                fm = list(re.finditer(r'function\s+(\w+)\s*\(', head_all))
                if fm:
                    cur = fm[-1].group(1)
                    if re.match(r'(init|start|boot|setup|mount)', cur, re.I):
                        # 该函数在文件尾只被裸调用（非事件回调内）
                        calls = len(re.findall(r'\b%s\s*\(\s*\)' % re.escape(cur), src))
                        declared = len(re.findall(
                            r'function\s+%s\s*\(' % re.escape(cur), src))
                        if calls <= 2 and declared == 1:
                            initscope = True
            except Exception:
                pass
            if guarded or lifecycle_wrapped or initscope:
                findings.append(Finding(
                    'INFO', 'P6', fn, ln,
                    'setInterval 属页面级单例心跳（幂等守卫/生命周期封装），无需 clear',
                    '守卫=%s  生命周期封装=%s  初始化作用域=%s' % (guarded, lifecycle_wrapped, initscope)))
            else:
                findings.append(Finding(
                    'MEDIUM', 'P6', fn, ln,
                    'setInterval 无 clearInterval 且无幂等守卫（可能累积泄漏）',
                    '若该行位于事件回调或渲染函数内，反复进入会导致定时器叠加'))

    # ══════════════════════════════════════════════════════════
    # P7：漏写对象前缀 —— 裸标识符引用本对象的方法
    #
    # 缺陷模式（本轮线删消息 bug 的成因）：
    #   store 对象里定义了一批方法（deleteMessage / purgeXxx / ...），
    #   在同一个「对象字面量」内部调用时**必须带 store. 前缀**，
    #   因为方法名不是本文件作用域里的函数，而是 store 的属性。
    #
    #   漏了前缀就是一个裸标识符引用 —— 语法完全合法、静态检查也不报，
    #   但运行时一执行到这行就抛 ReferenceError，整条 Promise 链 reject。
    #
    # 为什么难发现：
    #   · 同一个函数体里往往还有几处写对了（store.xxx），
    #     人眼扫过去只会确认「哦，它调用了 xxx」，不会注意少了个前缀
    #   · 只在走到那一行时炸，前面的逻辑全部正常执行
    #   · 调用方通常是 .then(...) 链，reject 落到用户手里就成了「静默失败」
    #
    # 判定：找形如  return bareName(  或  = bareName(  的调用，
    #      其中 bareName 恰好是本文件某对象字面量上定义的方法名，
    #      且该行的其他位置没有 store./self./this. 之类的前缀。
    #
    # 关键排除项：**同名模块级函数**。
    #   本项目大量存在「模块作用域同名函数 + store 方法」的写法，
    #   例如 refreshChatPreviewFromVisible / storeMediaBlob /
    #   dedupeContactsAndPrivateChats / renderDecoLayer 等，
    #   它们在文件顶部就有 function 声明，裸调用完全合法。
    #   第一版没有做这个排除，一下报了 39 个假 HIGH —— 全是这类同名函数。
    #   因此：只要该名字在本文件存在 `function name(` 声明，就跳过。
    # ══════════════════════════════════════════════════════════
    for fn, src in cleaned.items():
        # 收集该文件里「对象字面量方法名」：形如 `        name: function (`
        method_names = set()
        for mm in re.finditer(r'^\s{4,}([A-Za-z_$][\w$]*)\s*:\s*function\s*\(',
                              src, re.M):
            method_names.add(mm.group(1))
        if not method_names:
            continue
        # 本文件所有「模块级/局部函数声明」的名字 —— 裸调用它们是合法的
        declared = set(re.findall(r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', src))
        # 变量赋值形式的函数也算：var f = function ( / const f = (…)
        declared |= set(re.findall(
            r'\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function|\()', src))
        for mm in sorted(method_names - declared):
            # 裸调用：前面不是 . 也不是标识符字符
            pat = r'(?<![\w$.])' + re.escape(mm) + r'\s*\('
            for use in re.finditer(pat, src):
                ln = line_of(src, use.start())
                lines = src.splitlines()
                line = lines[ln - 1] if ln - 1 < len(lines) else ''
                # 排除「定义处本身」（`name: function (` 已由上面正则匹配）
                if re.search(re.escape(mm) + r'\s*:\s*function', line):
                    continue
                # 排除别的对象/命名空间上恰好同名的方法（this.xxx / foo.xxx）
                if re.search(r'\.\s*' + re.escape(mm) + r'\s*\(', line):
                    continue
                findings.append(Finding(
                    'HIGH', 'P7', fn, ln,
                    '疑似漏写对象前缀：%s( 为裸标识符' % mm,
                    '本文件存在方法 `%s`，此处却未带前缀 → 运行到该行必然 ReferenceError'
                    % mm))

    # ══════════════════════════════════════════════════════════
    # P8：捕获阶段监听器吞掉消息行的点击，未给多选让路
    #
    # 缺陷模式（本轮「点图片进预览、要点边边才能选中」的成因）：
    #   消息行内的可点元素（图片大图、生图重试、HTML 全屏…）
    #   由 **document 上的 capture 监听器**处理；而"多选选中"由
    #   **qq-room 上的 bubble 监听器**处理。
    #
    #   派发顺序：document(capture) → … → qq-room(bubble)
    #   前者先跑且调了 stopPropagation() ⇒ 后者永远收不到事件。
    #
    # 为什么难发现：
    #   两条监听器**各自都是对的**，语法、逻辑、单独测试都没问题。
    #   问题只存在于两者的**阶段差**上 —— 是一个纯粹的顺序缺陷，
    #   只读单个函数永远看不出来。
    #
    # 判定：在 document 级 capture click 处理函数里，
    #      若出现了 stopPropagation()，但整个函数体内**没有任何**
    #      multiSelect 相关的让路判断，则报警。
    #
    # ⚠️ 必须**逐分支**判断，不能整个函数体一起判断。
    #
    # 踩过的坑：bindGlobalImageClicks 这一个回调里连续处理了
    # 「生图重试 / 下载 / 关闭 / 大图预览」四个分支。我在重试分支
    # 加了让路判断后，整个函数体就"含 multiSelect"了 ——
    # 于是把**没有**让路的大图预览分支一起判成安全，
    # 修复回退后 P8 竟然一声不响。第一版就是这么漏的。
    #
    # 现在的做法：以每个 `e.target.closest('...')` 为锚点切段，
    # 每段内部**独立**检查是否既有 stopPropagation 又有让路判断。
    #
    # 三类必须排除的假阳性（都是实跑后确认过的）：
    #   1. 目标压根不在消息行内 —— 例如工具栏的 AI 回复按钮
    #      (#qq-room-ai)。点它不影响多选。
    #   2. 目标不在消息行内且尚未展开 —— 例如开场白抽屉，
    #      只有抽屉开着才会 stopPropagation，而抽屉不在消息列表里。
    #   3. 该页面没有多选功能 —— 例如朋友圈。没有多选，
    #      自然不需要让路。
    # 判定方式：看这一段是否**触及消息行标记**。
    # 消息行相关的选择器/属性：data-msg-id、qq-msg、qq-card、
    # data-mq-img-view、data-mq-img-gen-retry、data-miya-chat-html-fs。
    # ══════════════════════════════════════════════════════════
    MSG_ROW_HINTS = (
        'data-msg-id', 'qq-msg', 'qq-card',
        'data-mq-img-view', 'data-mq-img-gen-retry',
        'data-miya-chat-html-fs', 'findMsgRowFromTarget',
    )
    for fn, src in cleaned.items():
        if 'document.addEventListener' not in src:
            continue
        # 整个文件都没多选能力 → 不适用本检查（如朋友圈）
        if 'multiSelect' not in src:
            continue
        # 逐个抓 document 上的 capture 阶段 click 回调（第 3 参数为 true）
        pat = re.compile(
            r"document\.addEventListener\(\s*'click'\s*,\s*function\s*\(([^)]*)\)\s*\{")
        for m in pat.finditer(src):
            start = m.end()
            # 括号配平找函数体结束
            depth = 1
            i = start
            while i < len(src) and depth > 0:
                ch = src[i]
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                i += 1
            body = src[start:i]
            # 只看 capture 阶段：回调闭合后紧跟 , true)
            tail = src[i:i + 12]
            if not re.match(r'\s*,\s*true\s*\)', tail):
                continue
            if 'stopPropagation' not in body:
                continue
            # 以 closest 锚点切段，逐段独立判断
            anchors = [a.start() for a in re.finditer(r"\.closest\s*\(", body)]
            if not anchors:
                anchors = [0]
            segments = []
            for idx, a in enumerate(anchors):
                seg_end = anchors[idx + 1] if idx + 1 < len(anchors) else len(body)
                segments.append((a, body[a:seg_end]))
            for seg_off, seg in segments:
                if 'stopPropagation' not in seg:
                    continue
                ln = line_of(src, start + seg_off)
                # 该分支有让路判断 → 安全
                if re.search(r'multiSelect|isPicked|pickMode', seg):
                    findings.append(Finding(
                        'INFO', 'P8', fn, ln,
                        'document(capture) 点击分支已为多选让路',
                        '含 stopPropagation，且该分支已判断 multiSelect → 安全'))
                    continue
                # 该分支未触及消息行 → 与该缺陷无关
                if not any(h in seg for h in MSG_ROW_HINTS):
                    findings.append(Finding(
                        'INFO', 'P8', fn, ln,
                        'document(capture) 点击分支未触及消息行（无需让路）',
                        '含 stopPropagation，但目标元素不在消息行内 → 不影响多选'))
                    continue
                findings.append(Finding(
                    'MEDIUM', 'P8', fn, ln,
                    'document(capture) 点击分支会吞掉多选点击（未让路）',
                    '该 capture 分支调用了 stopPropagation() 却未判断 multiSelect；'
                    '其目标元素位于消息行内，多选模式下将无法选中该消息'))

    # ══════════════════════════════════════════════════════════
    # P9：跨文件「标记契约」——打标方与读标方的条件必须相容
    # ══════════════════════════════════════════════════════════
    #
    # 缺陷家族（v8.4 亲历）：
    #   store 侧打了「刚删掉末尾角色回复」的标记，
    #   engine 侧读取该标记的准入条件里却写着 `opts.skipUserMessage` ——
    #   而真实用户流程是「先打字发送，再点触发回复」，
    #   那一步的 opts.skipUserMessage 是 undefined。
    #   两边各自都「正确」，合起来却一条都命中不了。
    #
    # 这类缺陷和 P1–P8 是同一家族：调用点存在、被调方存在、语法合法、
    # 不报错，只是**契约不相容**导致机制空转，而且表现为静默失效。
    #
    # 这里无法做通用的语义证明，但可以抓住最典型的错法：
    # 读标方的准入条件里出现「只有某一条调用路径才会传」的私有选项。
    PRIVATE_OPTS = ('skipUserMessage',)
    # 读标/打标的两个关键名字。只要任一出现，就认为启用了这套标记契约。
    marker_present = any(
        ('peekRewriteResume' in s or 'shouldApplyResumeRewrite' in s)
        for s in cleaned.values()
    )
    if marker_present:
        for fn, src in cleaned.items():
            # 判定逻辑可能分散在两处：
            #   ① shouldApplyResumeRewrite 本体
            #   ② 它被调用处的那个 if 准入条件（v8.4 的 bug 就在这儿）
            # 两处都要看，否则会漏掉真正出问题的那一半。
            spans = []
            for pat in (r'function\s+shouldApplyResumeRewrite\s*\(',
                        r'function\s+buildApiMessages\s*\('):
                body, start = func_body(src, pat)
                if body:
                    spans.append((body, start))
            for body, start in spans:
                # 先定位所有 resumeRewrite 的判定点；只在它**附近**找私有选项，
                # 否则 buildApiMessages 里别处的 opts.skipUserMessage
                #（比如通话态的续说分支）会被误判成同一个问题。
                anchors = []
                pos = body.find('resumeRewrite')
                while pos >= 0:
                    anchors.append(pos)
                    pos = body.find('resumeRewrite', pos + 1)
                if not anchors:
                    continue
                for opt in PRIVATE_OPTS:
                    offset = 0
                    while True:
                        idx = body.find('opts.' + opt, offset)
                        if idx < 0:
                            break
                        offset = idx + 1
                        # 与该私有选项同处一个「判定块」：500 字符内出现 resumeRewrite
                        if not any(abs(idx - a) <= 500 for a in anchors):
                            continue
                        # 必须是判定条件的一部分（带取反 / && / if），
                        # 单纯把它当参数转交不算问题
                        line_start = body.rfind('\n', 0, idx) + 1
                        line_end = body.find('\n', idx)
                        if line_end < 0:
                            line_end = len(body)
                        seg = body[line_start:line_end]
                        if '!' not in seg and '&&' not in seg and 'if' not in seg:
                            continue
                        ln = line_of(src, start + idx)
                        findings.append(Finding(
                            'HIGH', 'P9', fn, ln,
                            '读标方准入条件与打标方契约不相容（%s）' % opt,
                            '该处把 opts.%s 当作「该不该套改写约束」的前提，'
                            '但真实调用路径（打字发送 → 点触发回复）不会传它，'
                            '结果是标记永远读不到、机制静默空转。'
                            '判定应只依赖历史状态与 store 上的标记' % opt))

    # ══════════════════════════════════════════════════════════
    # 输出
    # ══════════════════════════════════════════════════════════
    order = {'HIGH': 0, 'MEDIUM': 1, 'INFO': 2, '⚪': 3}
    findings.sort(key=lambda f: (order.get(f.level, 9), f.code, f.file, f.line))

    icon = {'HIGH': '🔴', 'MEDIUM': '🟡', 'INFO': '⚪'}
    print('=' * 78)
    print('成对调用配平扫描 · 结构性缺陷家族')
    print('=' * 78)
    print('扫描文件 %d 个（已排除第三方库）' % len(cleaned))
    for s in info:
        print('  · ' + s)
    print('')

    n_high = sum(1 for f in findings if f.level == 'HIGH')
    n_med = sum(1 for f in findings if f.level == 'MEDIUM')

    for lvl in ('HIGH', 'MEDIUM', 'INFO'):
        group = [f for f in findings if f.level == lvl]
        if not group:
            continue
        print('─' * 78)
        print('%s %s（%d 项）' % (icon[lvl], lvl, len(group)))
        print('─' * 78)
        for f in group:
            print('  [%s] %s:%d' % (f.code, f.file, f.line))
            print('        %s' % f.msg)
            if f.detail:
                print('        %s' % f.detail)
        print('')

    print('=' * 78)
    print('小结：HIGH %d 项，MEDIUM %d 项，INFO %d 项'
          % (n_high, n_med, sum(1 for f in findings if f.level == 'INFO')))
    print('=' * 78)

    # 退出码：只在 HIGH 时非零，方便接进 CI
    return 1 if n_high else 0


if __name__ == '__main__':
    sys.exit(main())
