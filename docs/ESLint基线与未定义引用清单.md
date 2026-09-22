# ESLint `no-undef` 工具说明与修复记录

> 目的：把「跑起来才崩」的**未定义引用**用静态检查揪出来。
> 本文件同时记录**工具怎么用**、**抓到了什么**、**修了什么**。

## 一、怎么用

```bash
npm run lint              # 全量检查（当前 0 error）
python3 test/lint_undef.py  # 同上，包成测试脚本的标准形式
python3 test/run-all.py --filter lint   # 经统一入口跑
npx eslint js1/xxx.js     # 单文件
```

**已接进测试流程**：`test/lint_undef.py` 包了一层，
`run-all.py` 会自动扫到（5 断言，约 2.3s），也计入全量断言数。

配置在 `eslint.config.mjs`。只开一条规则：

| 规则 | 级别 | 理由 |
|---|---|---|
| `no-undef` | **error** | 本工具的**唯一目标** |
| `no-redeclare` | **off** | 存量 19 处全是「互斥分支各声明同名 var」，无害；留 warn 反而刷屏淹没真问题 |

**刻意不开任何风格规则** —— 缩进、分号那些告警一多，真问题就没人看了。

> **反向守卫已验证**：把 `sw.js` 的 `data.careId` 故意改回 `careId`，
> 脚本立即报红并打印 `209:107 error 'careId' is not defined`，
> 退出码 1（能被 `run-all.py` 正确判定为失败）。

## 二、过滤过程

初跑 **168 条** → 最终 **1 条**（已修 11 条）：

| 阶段 | 剩余 | 说明 |
|---|---|---|
| 裸跑 | 168 | 先看规模 |
| 补全浏览器内置 API（约 40 个：`confirm`/`File`/`atob`/`Audio`/`Notification`/`MediaRecorder`…） | 63 | **配置缺失**，不是代码问题 |
| 登记 `global`（项目 IIFE 形参名，既定约定） | 31 | `js2/` 那批 30 条全是这个 |
| `no-redeclare` 关闭 | 12 | 剩 5→19 条 warn 全清掉 |
| **本轮修复** | **1** | 见第四、五节 |

`jszip.min.js` 等第三方库已在 ignores。

## 三、修复总览

| # | 位置 | 性质 | 修法 |
|---|---|---|---|
| 1 | `sw.js:209` | 🔴 真 bug | `careId` → `data.careId` |
| 2 | `js1/miya-beautify-app.js:200-205` | 🔴 真 bug | 删 6 行死赋值 |
| 3 | `js1/miya-chat-room.js:6193` | 🔴 真 bug | 删 `state.chatId = chatId;` |
| 4 | `js1/miya-chat-room.js:5889/5902` | ⚪ 无效守卫 | 删两处 `paintRoom` 分支 |
| 5 | `js2/miya-worldbook-app.js:1062` | ⚪ 无效守卫 | 删 `refresh` 分支 |
| 6 | `js2/miya-api-bridge.js:624` | 🔴 真 bug | 补本函数自己的 `markPartial` |

**全部 12 条已修完，lint 归零。**

版本：`beautify-app 50→51`、`worldbook-app 33→34`、`chat-room 116→117`、
SW `miya-v294-karin → v295-karin`、`sw-51 → sw-52`。
（`miya-api-bridge.js` 不在受管资源清单内，无需 bump。）

---

## 四、已修明细

### 1. `sw.js:209` — 漏了 `data.` 前缀

```js
if (data.kind === 'weather_care' && data.careId) {
    openUrl += ... + encodeURIComponent(careId);   // ❌
    openUrl += ... + encodeURIComponent(data.careId);  // ✅ 已修
}
```

判断用 `data.careId`，取值写成裸 `careId`。
**触发**：点天气关怀通知要跳转时 → `ReferenceError`。

### 2. `js1/miya-beautify-app.js:200-205` — 6 行死赋值 + 必崩

```js
function markIconSelection(key, gridKind) {
    if (gridKind === 'extra') selectedExtraKey = key;
    else if (gridKind === 'custom-icon') selectedCustomIconKey = key;
    else if (gridKind === 'p2-icon') selectedP2IconKey = key;   // ❌ 未声明
    ... 共 6 行
    else selectedIconKey = key;                                  // 保留
```

**误判纠正**：最初以为要「补 6 个声明」。查证后发现这 6 个变量
**全项目只写不读**（连已声明的那 3 个也是），赋值纯属残留。
所以正解是**删掉这 6 行** —— 补声明只是补 6 个死变量。

**为什么是必崩**：本文件第 2 行有 `'use strict'`（包裹整个 IIFE），
严格模式下给未声明变量赋值**直接抛 ReferenceError**。

**触发链**（真实路径）：
1. 点图标格子 `[data-bf-pick]` → 第 796 行
2. `gridKindFromPickBtn` 从 DOM 判出 `p2-icon` 等值
3. `markIconSelection(...)` → 走到第 200 行 → **抛异常**
4. 第 803 行的 `return` 走不到，**后续文件选择器也不弹出**

即：**点 p2/p3/p4 图标格 → 崩 + 换图功能失效。**

> ⚠️ 我最初的报告写「非严格模式静默建全局」——**那是错的**，本文件确实有 `'use strict'`。

### 3. `js1/miya-chat-room.js:6193` — `prepareShell` 的 `chatId`

```js
function prepareShell(contact) {     // 形参只有 contact
    ...
    state.chatId = chatId;           // ❌ 已删
```

**误判纠正**：最初以为 `prepareShell` 是死代码（「零调用点」）——
**那是错的**，我只查了单文件。跨文件查发现：
- 第 6604 行**导出** `prepareShell`
- `js1/miya-chat-app.js:1378-1379` **真实调用**它

它像是从 `open(chatId, opts)` 拷贝的片段，**漏带 `chatId` 参数**。

**为什么删而不是补参数**：调用方在 1379 行时 `chatId` 还不存在 ——
会话在 1382 行才 `createChat`。此处本就无会话可绑，真正的 `state.chatId`
由随后的 `openChatById` → `open(chatId)` 写入。删掉既是修崩溃，也纠正语义。

**影响面**：抛点在第 8 行（函数中段），后面的
`closeEmojiPanel` / `renderQuoteBar` / `is-open` 等一整套初始化全被跳过 ——
所以「新建会话时房间壳没摆好」很可能就是这个引起的。

### 4-5. 无效守卫两处

```js
// miya-chat-room.js:5889 / 5902  —— paintRoom 全项目无定义
if (typeof renderMessages === 'function') renderMessages(...);
else if (typeof paintRoom === 'function') paintRoom(...);   // ❌ 已删

// miya-worldbook-app.js:1062  —— refresh 全文件无定义
if (typeof renderList === 'function') renderList();
else if (typeof refresh === 'function') refresh();          // ❌ 已删
```

`typeof x` 对**未声明变量**不抛错（`typeof` 的特殊行为），所以它们现在不炸 ——
但防的是个不存在的函数，等于白防。删掉。

---

## 五、`markPartial` 的设计意图（已修）

### 🔴 `js2/miya-api-bridge.js:624` — 该函数漏拷了 `markPartial` 定义

**现象**：`finishPartial`（622 行）调用的 `markPartial`，只存在于
`parseCompletionResponse`（207 行）内部，两个函数闭包链不相通。

**怎么定性的** —— 关键看两个函数的签名：

| 函数 | 行 | 签名 |
|---|---|---|
| `parseCompletionResponse` | 207 | `(res, reqOpts)` |
| `callCompletionsStreamWithConfig` | **497** | `(..., resolved, reqOpts)` |

`markPartial`(225) 属**前者**，`finishPartial`(622) 属**后者**。

再看第 549 行 —— `.then(function (res) {...})` **定义在 497 函数体内**，
所以对 622 行的 `finishPartial` 而言，**`reqOpts` 是可见的**（闭包链完整）。

**结论**：这不是「够不到外层」（那才需要挪位置或传参），而是
**`callCompletionsStreamWithConfig` 本该有自己的 `markPartial`，作者从 207
那个函数拷贝时只拷了调用、漏拷定义**。

**旁证**：`markPartial` 实现里那句
`err.name === 'StreamIdleTimeout' ? 'idle_timeout' : 'disconnected'` ——
而本函数的两个调用点传的恰好就是这两种错误：
- 648 行：`StreamIdleTimeout`（空闲超时）
- 672 行：reader 错误（断线）

说明这段实现就是为这个函数写的。

**修法**：在 `callCompletionsStreamWithConfig` 内补一份同款实现。

**修复前的影响**（两层，比预想更严重）：
1. 流式中断时**自己先崩**，正是最需要提示用户「话没说完」的时刻
2. 抛点在 `finishPartial` 内 → 紧随其后的 `finalizeAccum` 也走不到
   → **已收到的内容连正常收尾都拿不到**

---

## 六、回归验证

用 `--filter` 增量跑，避免动辄全量。

**第一批（sw / beautify / chat-room / worldbook）**：

| 批次 | 结果 |
|---|---|
| `--filter worldbook` | 110/110 ✅ |
| `--filter theme` | 14/14 ✅ |
| `--filter subview` | 45/45 ✅ |
| `--filter ui_fixes` | ✅ |
| `--filter settings` | 49/49 ✅ |
| `--filter data_boundary` | 32/32 ✅ |
| `--filter sw_cache` | 16/16 ✅ |
| `--filter e2e` | **17 脚本 / 336 断言 ✅** |

**第二批（api-bridge）**：

| 批次 | 结果 |
|---|---|
| `--filter api_presets` | 61/61 ✅ |
| `--filter api_model` | 33/33 ✅ |
| `--filter api_preset` | 88/88 ✅ |
| `--filter inject` | 78/78 ✅ |
| `--filter race` | 见下 |

语法检查：改动过的 5 个文件 `node --check` 全过。
版本校验：`node tools/version.js verify` 通过（155 资源 / sw-52 / miya-v295-karin）。


## 七、附带产出

- `eslint.config.mjs` —— 配置，globals 刻意登记得全（宁可错放，不可错杀）
- `test/lint_undef.py` —— 包成测试脚本，**已接进 run-all.py**（5 断言 / 约 2.3s）
- `package.json` —— 新增 `lint` / `lint:undef`
- `.gitignore` —— **新建**（此前没有），挡 `node_modules/` 出交付包

## 八、教训

本轮我自己**误判了两次**，都值得记：

1. **`beautify` 那条**：先看到「6 个变量未声明」就直奔「补声明」，
   但没先查「这些变量有没有人读」。查了才发现是死赋值，正解是删。
2. **`prepareShell` 那条**：只查单文件就断定「零调用点 = 死代码」，
   实际它在**另一个文件里被导出并调用**。

> 共同点：**下结论前证据不足**。第一次是「没查引用方向」，第二次是「没跨文件查」。
> 静态检查工具指位置很准，但「该补还是该删」必须靠完整调用链判断。
