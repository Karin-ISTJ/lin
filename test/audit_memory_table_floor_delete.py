# -*- coding: utf-8 -*-
"""
记忆表 · 「删楼层不回收记忆」修复验证（行溯源）
================================================

用户报告（原话）：
  「线下ai生成新的楼层 更新了记忆表，如果我把这一层删了，
    记忆表对应的内容不会跟着一起被删」

定位结论（本测试要钉死的）：
  记忆表（localStorage['miya-memory-tables-v1']）与聊天消息（miya-chat-meta）
  是两套独立存储，且记忆表按 chatId 分桶。删除楼层**不改 chatId、不删会话**，
  于是桶、表、行原封不动，下一轮生成立刻被重新注入。

  四个删除入口里，只有 deleteMessage / deleteMessages 漏了记忆表收口
  （clearChatMessages 用 resetChat、deleteChat / removeContact 用 dropChat）。

  但这条路径**不能**照搬 resetChat / dropChat：它们清的是「整个会话」，
  而本路径删的是「某几层」，一刀清空等于「删一层 = 失忆」。
  正确解是行溯源：每行记录来源消息 id，删除时按来源精确回收。

本测试用 Node 直接加载**真实源文件**（不重写逻辑），验证 8 项：

  T1  写入后行溯源正确建立（insertRow 的行号 = 落地行号）
  T2  删楼层 → 该层写入的行被精确回收
  T3  未被删楼层写入的行**完整保留**（不误伤）
  T4  删多行时行号重排正确（不会因为前面删除而删错后面的行）
  T5  insertRow 触发 maxRows 头部裁剪时，溯源同步左移、被裁行的溯源被丢弃
  T6  deleteRow / updateRow 引起的行号位移，溯源同步重排
  T7  老数据（无 rowSource）→ 退化为不回收，绝不误删
  T8  UI 保存（不传 rowSource）不会把已有溯源清空

跑法：python3 test/audit_memory_table_floor_delete.py
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 用 Node 加载真实源文件：把两个 store/engine 模块在最小 DOM 壳里跑起来。
HARNESS = r"""
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2];

// ── 最小环境：localStorage + window ──
const store = {};
const localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const sandbox = { console, JSON, Date, Math, Object, Array, Number, String, Promise, RegExp };
sandbox.localStorage = localStorage;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
// sync 读写走真实函数签名
sandbox.miyaSyncReadJsonKey = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
sandbox.miyaWriteLsJsonKey = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); return Promise.resolve(); };
vm.createContext(sandbox);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

load('js2/miya-memory-table-store.js');
load('js2/miya-memory-table-engine.js');

const Store = sandbox.MiyaMemoryTableStore;
const Engine = sandbox.MiyaMemoryTableEngine;

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
}

const CHAT = 'chat_A';
const clear = () => { Object.keys(store).forEach((k) => delete store[k]); };

// ─────────────────────────────────────────────
// T1：写入建立溯源
// ─────────────────────────────────────────────
(function T1() {
  clear();
  const reply = '正文...\n<tableEdit><!-- insertRow(3, {0:"小满",1:"约定看海",2:"周末",3:"海边",4:"期待"}) --></tableEdit>';
  Engine.processAssistantReply(CHAT, reply, { sourceMsgIds: ['msg_001'] });
  const src = Store.getChatRowSource(CHAT);
  const key = Store.rowKey(3, 0);
  check('T1 溯源建立：insertRow 落地行号被记录', src[key] === 'msg_001',
    'rowSource=' + JSON.stringify(src));
  const tables = Store.getChatTables(CHAT);
  check('T1 行确实写入', tables[3].rows.length === 1 && tables[3].rows[0][1] === '约定看海',
    JSON.stringify(tables[3].rows));
})();

// ─────────────────────────────────────────────
// T2/T3：精确回收 + 不误伤
// ─────────────────────────────────────────────
(function T23() {
  clear();
  // 第一轮：写入 2 行（来源 msg_001）
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- insertRow(3, {0:"小满",1:"事件A"}) --></tableEdit>',
    { sourceMsgIds: ['msg_001'] });
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- insertRow(3, {0:"小满",1:"事件B"}) --></tableEdit>',
    { sourceMsgIds: ['msg_001'] });
  // 第二轮：再写 1 行（来源 msg_002）
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- insertRow(3, {0:"小满",1:"事件C"}) --></tableEdit>',
    { sourceMsgIds: ['msg_002'] });

  let tables = Store.getChatTables(CHAT);
  check('T2 前置：共 3 行', tables[3].rows.length === 3, String(tables[3].rows.length));

  // 删掉第二轮那一层
  Store.removeRowsBySource(CHAT, ['msg_002']);

  tables = Store.getChatTables(CHAT);
  const texts = tables[3].rows.map((r) => r[1]);
  check('T2 被删楼层的行已回收', texts.indexOf('事件C') < 0, JSON.stringify(texts));
  check('T3 未被删楼层的行完整保留', texts.indexOf('事件A') >= 0 && texts.indexOf('事件B') >= 0,
    JSON.stringify(texts));
  check('T3 剩余行数 = 2', tables[3].rows.length === 2, String(tables[3].rows.length));

  const src = Store.getChatRowSource(CHAT);
  check('T3 溯源同步重排（msg_001 覆盖 0/1 行）',
    src[Store.rowKey(3, 0)] === 'msg_001' && src[Store.rowKey(3, 1)] === 'msg_001',
    JSON.stringify(src));
})();

// ─────────────────────────────────────────────
// T4：删多行时行号重排（从后往前删，不删错）
// ─────────────────────────────────────────────
(function T4() {
  clear();
  // 5 行，来源交替：m1 m2 m1 m2 m1  → 每行内容带序号便于核对
  const ops = ['m1', 'm2', 'm1', 'm2', 'm1'];
  ops.forEach((mid, i) => {
    Engine.processAssistantReply(CHAT,
      '<tableEdit><!-- insertRow(3, {0:"R' + i + '"}) --></tableEdit>',
      { sourceMsgIds: [mid] });
  });
  let tables = Store.getChatTables(CHAT);
  check('T4 前置：5 行', tables[3].rows.length === 5, String(tables[3].rows.length));

  // 一次性删掉 m1 的所有行（行号 0,2,4）—— 交错分布，最易删错
  Store.removeRowsBySource(CHAT, ['m1']);

  tables = Store.getChatTables(CHAT);
  const texts = tables[3].rows.map((r) => r[0]);
  // 期望只剩 m2 的行：R1, R3
  check('T4 交错多行删除结果正确', JSON.stringify(texts) === JSON.stringify(['R1', 'R3']),
    JSON.stringify(texts));

  const src = Store.getChatRowSource(CHAT);
  const ok = src[Store.rowKey(3, 0)] === 'm2' && src[Store.rowKey(3, 1)] === 'm2'
    && Object.keys(src).length === 2;
  check('T4 删除后溯源无残留、无错位', ok, JSON.stringify(src));
})();

// ─────────────────────────────────────────────
// T5：maxRows 头部裁剪时溯源左移
// ─────────────────────────────────────────────
(function T5() {
  clear();
  const SLimit = Store.loadSettings();
  SLimit.maxRowsPerTable = 3;
  // 直接改全局设置（与 store 同源）
  const st = Store.loadSettings();
  st.maxRowsPerTable = 3;
  Store.saveSettings(st);

  // 依次写 4 行，来源 m1（第 1 行会被裁掉）
  for (let i = 0; i < 4; i++) {
    Engine.processAssistantReply(CHAT,
      '<tableEdit><!-- insertRow(3, {0:"V' + i + '"}) --></tableEdit>',
      { sourceMsgIds: ['m1'] });
  }
  let tables = Store.getChatTables(CHAT);
  check('T5 前置：裁剪到 3 行', tables[3].rows.length === 3, String(tables[3].rows.length));

  // 再写 1 行（来源 m2）
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- insertRow(3, {0:"VM"}) --></tableEdit>',
    { sourceMsgIds: ['m2'] });

  tables = Store.getChatTables(CHAT);
  const texts = tables[3].rows.map((r) => r[0]);
  check('T5 裁剪后最新行在尾部', texts[texts.length - 1] === 'VM', JSON.stringify(texts));

  const src = Store.getChatRowSource(CHAT);
  check('T5 溯源键都在合法行号范围内',
    Object.keys(src).every((k) => Store.parseRowKey(k).rowIndex < 3),
    JSON.stringify(src));
  check('T5 m2 的溯源指向最后一行',
    src[Store.rowKey(3, 2)] === 'm2', JSON.stringify(src));

  // 删 m2 → 只应删掉 VM 那一行
  Store.removeRowsBySource(CHAT, ['m2']);
  tables = Store.getChatTables(CHAT);
  const after = tables[3].rows.map((r) => r[0]);
  check('T5 删 m2 只回收 VM 行', after.indexOf('VM') < 0 && after.length === 2,
    JSON.stringify(after));

  // 还原默认上限，避免影响后续用例
  const st2 = Store.loadSettings();
  st2.maxRowsPerTable = 40;
  Store.saveSettings(st2);
})();

// ─────────────────────────────────────────────
// T6：deleteRow / updateRow 引起的位置重排
// ─────────────────────────────────────────────
(function T6() {
  clear();
  // 建立 3 行，来源 a b c
  ['a', 'b', 'c'].forEach((mid, i) => {
    Engine.processAssistantReply(CHAT,
      '<tableEdit><!-- insertRow(3, {0:"X' + i + '"}) --></tableEdit>',
      { sourceMsgIds: [mid] });
  });
  // 第四轮：删掉第 0 行 + 插入 1 行（来源 d）
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- deleteRow(3, 0)\ninsertRow(3, {0:"XD"}) --></tableEdit>',
    { sourceMsgIds: ['d'] });

  const tables = Store.getChatTables(CHAT);
  const texts = tables[3].rows.map((r) => r[0]);
  check('T6 前置：删首行+插尾行', JSON.stringify(texts) === JSON.stringify(['X1', 'X2', 'XD']),
    JSON.stringify(texts));

  const src = Store.getChatRowSource(CHAT);
  check('T6 删首行后 a 的溯源已消失', Object.values(src).indexOf('a') < 0,
    JSON.stringify(src));
  check('T6 d 的溯源指向最后一行', src[Store.rowKey(3, 2)] === 'd', JSON.stringify(src));
  check('T6 b/c 溯源各自前移一位',
    src[Store.rowKey(3, 0)] === 'b' && src[Store.rowKey(3, 1)] === 'c',
    JSON.stringify(src));

  // updateRow 应把该行归属改为本轮来源
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- updateRow(3, 0, {0:"改过"}) --></tableEdit>',
    { sourceMsgIds: ['e'] });
  const src2 = Store.getChatRowSource(CHAT);
  check('T6 updateRow 后该行归属本轮来源', src2[Store.rowKey(3, 0)] === 'e',
    JSON.stringify(src2));
})();

// ─────────────────────────────────────────────
// T7：老数据无溯源 → 不回收、不误删
// ─────────────────────────────────────────────
(function T7() {
  clear();
  // 手工塞入「老版本」桶：有表有行，但没有 rowSource
  const legacy = {
    chats: {
      [CHAT]: {
        tables: [{
          id: 't_event', name: '重要事件', note: '', enabled: true,
          columns: ['相关角色', '事件简述'],
          rows: [['小满', '旧数据行1'], ['小满', '旧数据行2']],
        }],
        updatedAt: Date.now(),
      },
    },
  };
  localStorage.setItem('miya-memory-tables-v1', JSON.stringify(legacy));

  const before = Store.getChatTables(CHAT)[0].rows.length;
  Store.removeRowsBySource(CHAT, ['whatever_msg']);
  const after = Store.getChatTables(CHAT)[0].rows.length;
  check('T7 老数据（无溯源）不被误删', before === 2 && after === 2,
    'before=' + before + ' after=' + after);
})();

// ─────────────────────────────────────────────
// T9：跨桶扫描回收（线下路径：chatId 为空）
// ─────────────────────────────────────────────
(function T9() {
  clear();
  const CHAT_B = 'chat_B';
  // 两个桶各写一行，来源分别是线下 id 与线上 id
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- insertRow(3, {0:"线上行"}) --></tableEdit>',
    { sourceMsgIds: ['msg_online_1'] });
  Engine.processAssistantReply(CHAT_B,
    '<tableEdit><!-- insertRow(3, {0:"线下行"}) --></tableEdit>',
    { sourceMsgIds: ['msg_offline_1'] });

  let tA = Store.getChatTables(CHAT)[3].rows.length;
  let tB = Store.getChatTables(CHAT_B)[3].rows.length;
  check('T9 前置：两个桶各有 1 行', tA === 1 && tB === 1, 'A=' + tA + ' B=' + tB);

  // 传 chatId=null（线下路径不知道桶归属）→ 应全桶扫描
  Store.removeRowsBySource(null, ['msg_offline_1']);

  tA = Store.getChatTables(CHAT)[3].rows.length;
  tB = Store.getChatTables(CHAT_B)[3].rows.length;
  check('T9 跨桶回收命中线下行', tB === 0, 'B=' + tB);
  check('T9 另一个桶不受影响', tA === 1, 'A=' + tA);
})();

// ─────────────────────────────────────────────
// T8：UI 保存不传 rowSource 时不清空已有溯源
// ─────────────────────────────────────────────
(function T8() {
  clear();
  Engine.processAssistantReply(CHAT,
    '<tableEdit><!-- insertRow(3, {0:"UI保留检查"}) --></tableEdit>',
    { sourceMsgIds: ['msg_ui'] });
  const srcBefore = Store.getChatRowSource(CHAT);
  check('T8 前置：溯源已建立', srcBefore[Store.rowKey(3, 0)] === 'msg_ui',
    JSON.stringify(srcBefore));

  // 模拟 UI 保存：读表 → 写回，**不传第三个参数**
  const tables = Store.getChatTables(CHAT);
  Store.setChatTables(CHAT, tables);

  const srcAfter = Store.getChatRowSource(CHAT);
  check('T8 UI 保存后溯源仍在（未被清空）', srcAfter[Store.rowKey(3, 0)] === 'msg_ui',
    JSON.stringify(srcAfter));
})();

console.log(JSON.stringify(results));
"""


def main():
    harness_path = os.path.join(ROOT, '.tmp_mt_floor_delete_harness.js')
    with open(harness_path, 'w', encoding='utf-8') as f:
        f.write(HARNESS)
    try:
        proc = subprocess.run(
            ['node', harness_path, ROOT],
            capture_output=True, text=True, cwd=ROOT, timeout=120,
        )
    finally:
        try:
            os.remove(harness_path)
        except OSError:
            pass

    if proc.returncode != 0:
        print('❌ Node 执行失败：')
        print(proc.stdout[-4000:])
        print(proc.stderr[-4000:])
        return 1

    out = proc.stdout.strip().splitlines()
    payload = None
    for line in reversed(out):
        line = line.strip()
        if line.startswith('['):
            try:
                payload = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
    if payload is None:
        print('❌ 无法解析测试输出：')
        print(proc.stdout[-4000:])
        print(proc.stderr[-4000:])
        return 1

    passed = 0
    failed = []
    for r in payload:
        mark = '✓' if r['pass'] else '✗'
        print('%s %s' % (mark, r['name']))
        if not r['pass']:
            failed.append(r)
            if r['detail']:
                print('    实际：%s' % r['detail'])
        else:
            passed += 1

    print('')
    print('─' * 56)
    print('%d/%d 通过' % (passed, len(payload)))
    if failed:
        print('失败项：')
        for r in failed:
            print('  · %s' % r['name'])
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
