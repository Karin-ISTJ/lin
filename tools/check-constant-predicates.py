#!/usr/bin/env python3
"""
恒真判据静态检查器（constant-return predicate checker）
=========================================================

背景
----
本项目多次出现同一类死代码：某个判定函数的返回值被**硬编码为单一常量**
（例如后端已废弃「固定布局」，`getLayoutMode()` 永远返回 `'custom'`），
但调用点仍写成 `if (getLayoutMode() === 'custom') { A } else { B }`。

这类代码的问题不是崩溃，而是：
  · B 分支永不执行（死代码），却让读代码的人以为存在两种运行态；
  · 后续维护者可能去「修」B 分支，白费功夫；
  · 一旦要恢复该能力，改动点分散、易漏（本项目 B14 就漏了 miya-desk-custom.js）。

本工具做什么
------------
1. 扫描全仓 JS，找出「返回单一常量的零参/单参函数」→ 记为恒值函数；
2. 找出这些函数的调用点，若调用结果被用于**比较或分支**，则报为「恒真判据」；
3. 输出：恒值函数清单 + 死分支位置，供人工决定「折叠」还是「恢复实现」。

用法
----
    python3 tools/check-constant-predicates.py [包目录] [--json]

退出码：发现恒真判据 => 1（可用于 CI 卡口）；否则 0。

设计取舍
--------
· 纯静态、零依赖，不执行目标代码；
· **宁缺毋滥**：只报告能确定「所有 return 同一常量」的函数，避免误报；
· 注释先剥离，防止注释里的示例代码造成假阳性（这是本项目踩过的坑）。
"""

import json
import os
import re
import sys

JS_DIRS = ['js1', 'js2']
SKIP_FILES = {'sw.js'}
SKIP_PATTERNS = ['.min.js', 'regression-test.js']


def strip_comments(src):
    """剥离块注释与行注释。避免「注释里提到某函数」被当成真实调用。"""
    src = re.sub(r'/\*[\s\S]*?\*/', ' ', src)
    # 行注释：不能吞掉 http:// 这类
    src = re.sub(r'(^|[^:\\])//[^\n]*', r'\1 ', src)
    return src


def collect_js_files(root):
    out = []
    for d in JS_DIRS:
        full = os.path.join(root, d)
        if not os.path.isdir(full):
            continue
        for f in sorted(os.listdir(full)):
            if not f.endswith('.js'):
                continue
            if f in SKIP_FILES or any(p in f for p in SKIP_PATTERNS):
                continue
            out.append(os.path.join(d, f))
    return out


def find_constant_functions(src):
    """
    找出「所有 return 都返回同一字面量常量」的函数。

    只识别形如：
        function name(args) {
            ... (不含其它 return) ...
            return 'CONST';
        }
    或
        global.name = function (args) { ... return CONST; };

    返回 {函数名: 常量值}。宁缺毋滥：只要出现多个不同的 return 值就跳过。
    """
    results = {}

    # 匹配 function 声明 或 global.xxx = function
    pattern = re.compile(
        r'(?:function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)|'
        r'(?:global|window|globalThis)\.([A-Za-z_$][\w$]*)\s*=\s*function\s*\(([^)]*)\))'
    )

    for m in pattern.finditer(src):
        name = m.group(1) or m.group(3)
        args = m.group(2) if m.group(1) else m.group(4)
        if not name:
            continue

        # 从函数体起点开始，做花括号配平找函数体结束
        brace_start = src.find('{', m.end())
        if brace_start < 0:
            continue
        depth = 0
        i = brace_start
        while i < len(src):
            if src[i] == '{':
                depth += 1
            elif src[i] == '}':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        body = src[brace_start:i + 1]
        if not body:
            continue

        # 收集该函数所有 return，判定「是否所有 return 的值都相同」。
        #
        # 关键不在于 return 有几条，而在于**值是否一致**：
        #   · getLayoutMode(): return 'custom' ×4        → 恒值 ✅ 要报
        #   · isPngBuffer():   return false, false, true → 不恒值 ❌ 不报
        #   · bubbleDedupeKey(): return '', return A+B   → 不恒值 ❌ 不报
        #
        # 因此策略是：取出所有 return 的**字面量**值，若全部相同（且至少 1 条），
        # 才判定为恒值函数。非字面量的 return（如拼接表达式）会导致该函数被跳过 ——
        # 这正是我们想要的保守方向（宁可漏报也不误报）。
        values = []
        has_nonliteral = False
        for rm in re.finditer(r'\breturn\b([^;\n]*)', body):
            raw = rm.group(1).strip().strip('()').strip()
            if not raw:
                has_nonliteral = True
                continue
            if re.fullmatch(r"'(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\"|-?\d+(?:\.\d+)?|true|false|null", raw):
                values.append(raw)
            else:
                has_nonliteral = True
        # 要求：至少一条字面量 return，且**全部** return 都是同一字面量
        if not values or has_nonliteral:
            continue
        if len(set(values)) != 1:
            continue
        results.setdefault(name, set()).add(values[0])

    # 同一函数名出现多次且常量不一致 → 不可靠，剔除
    return {k: next(iter(v)) for k, v in results.items() if len(v) == 1}


def find_predicate_usages(src, const_fns):
    """
    在源码中找出对恒值函数的「分支/比较」用法。
    返回 [(行号, 函数名, 常量, 代码片段)]。

    收窄策略（避免把 stub 函数算进来）：
      只有当返回值**真的参与比较**（===/!==/==/!=）或**作为裸 if 条件**时才算判据。
      空实现的 stub（return '' / null）通常只会被赋值或拼接，不会进入比较，
      因此会被自然滤掉，无需维护函数名白名单。
    """
    hits = []
    lines = src.split('\n')
    for idx, line in enumerate(lines, 1):
        for fn, val in const_fns.items():
            # 比较式： name(args) === X / !== / == / !=
            cmp_pat = re.compile(
                r'\b' + re.escape(fn) + r'\s*\([^)]*\)\s*(===|!==|==|!=)\s*([^;){&\n]+)'
            )
            for m in cmp_pat.finditer(line):
                hits.append((idx, fn, val, m.group(0).strip()))
            # 裸 if 判断（仅对 true/false 常量有意义）
            if val in ('true', 'false'):
                bare = re.compile(r'\bif\s*\(\s*' + re.escape(fn) + r'\s*\([^)]*\)\s*\)')
                for m in bare.finditer(line):
                    hits.append((idx, fn, val, m.group(0).strip()))
    return hits


def is_predicate_like(fn, val, src):
    """
    判断该恒值函数是否**有资格**被当作「判据」对待。
    判据的特征：返回值是布尔、或字符串枚举（被用于状态比较），
    且**不是**明显的内容构造器（build*/render*/format*/toast* 等）。
    这样可以把几百个 stub/构造器挡在外面，只留下真正需要注意的。
    """
    # 内容构造器/渲染器：即便恒返回空串也无害，不算判据
    NOISE_PREFIX = (
        'build', 'render', 'format', 'toast', 'html', 'cast',
        'download', 'export', 'get', 'resolve', 'extract', 'create',
    )
    # 但 get* / resolve* 里也可能有真判据（如 getLayoutMode），
    # 故仅当它**确实出现在比较表达式中**时才保留 —— 由调用方过滤。
    low = fn.lower()
    if val in ('true', 'false'):
        return True                      # 布尔返回最有判据价值
    if re.fullmatch(r"'(custom|fixed|builtin|none|idb|url|all|middle)'", val):
        return True                      # 状态枚举
    if low.startswith(NOISE_PREFIX):
        return bool(re.fullmatch(r"'(custom|fixed|builtin|none|idb|url|all|middle)'", val))
    return True


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    as_json = '--json' in sys.argv
    root = args[0] if args else os.getcwd()

    files = collect_js_files(root)
    if not files:
        print(f'未在 {root} 下找到 js1/js2 目录', file=sys.stderr)
        return 2

    # 汇总：全仓范围内统计每个恒值函数
    per_file = {}
    all_const = {}
    for rel in files:
        src = strip_comments(open(os.path.join(root, rel), encoding='utf-8', errors='ignore').read())
        consts = find_constant_functions(src)
        if consts:
            per_file[rel] = consts
            for k, v in consts.items():
                all_const.setdefault(k, set()).add(v)

    # 只保留「全仓定义一致」的恒值函数
    const_fns = {k: next(iter(v)) for k, v in all_const.items() if len(v) == 1}

    findings = []
    for rel in files:
        src = strip_comments(open(os.path.join(root, rel), encoding='utf-8', errors='ignore').read())
        for line_no, fn, val, snippet in find_predicate_usages(src, const_fns):
            if not is_predicate_like(fn, val, src):
                continue
            findings.append({
                'file': rel, 'line': line_no, 'fn': fn,
                'constant': val, 'code': snippet
            })

    if as_json:
        print(json.dumps({
            'root': root,
            'constant_functions': const_fns,
            'findings': findings,
        }, ensure_ascii=False, indent=2))
        return 1 if findings else 0

    print('恒值函数静态检查')
    print('=' * 60)
    print(f'扫描目录: {root}')
    print(f'扫描文件: {len(files)} 个')
    print(f'识别恒值函数: {len(const_fns)} 个（其中多数为空实现 stub，属正常）')
    print()

    if not findings:
        print('✅ 未发现「对恒值判据做分支/比较」的死代码。')
        return 0

    # 按函数名聚合，便于看整体规模
    by_fn = {}
    for f in findings:
        by_fn.setdefault(f['fn'], {'constant': f['constant'], 'sites': []})
        by_fn[f['fn']]['sites'].append(f)

    print(f'⚠️  发现 {len(findings)} 处恒真/恒假判据，涉及 {len(by_fn)} 个函数：')
    print()
    for fn, info in sorted(by_fn.items(), key=lambda x: -len(x[1]['sites'])):
        print(f"  ▸ {fn}() 恒为 {info['constant']}  —— {len(info['sites'])} 处")
        for s in info['sites']:
            print(f"      {s['file']}:{s['line']}   {s['code']}")
        print()
    print('处理建议：')
    print('  · 若该能力确已废弃 → 折叠分支、删除死代码（参考本项目 B14）')
    print('  · 若需保留该能力   → 恢复被硬编码的实现，使判据重新有意义')
    print()
    print('注意：恒值函数若本身是空实现 stub（return '' / null），属正常占位，')
    print('      本工具只在它被用于「比较/分支」时才报告。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
