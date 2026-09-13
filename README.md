# Karin

浏览器端纯静态前端项目。无构建步骤，无后端，打开即用。

数据保存在浏览器本地（`localStorage` / IndexedDB / OPFS 等）。

许可协议：[GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0）。

---

## 目录结构

```text
.
├── index.html          # 主页面入口
├── manifest.json       # PWA 清单
├── sw.js               # Service Worker
├── css/                # 样式
├── js1/                # 脚本（核心交互模块）
├── js2/                # 脚本（设置、数据层、懒加载等）
├── img/                # 图标与静态图
├── LICENSE             # AGPL-3.0
└── README.md
```

---

## 环境要求

- 现代浏览器（推荐最新版 Chrome / Edge / Safari / Firefox）
- 本地预览需要任意静态文件服务器（部分能力依赖 `http(s)://`，**不建议用 `file://` 直接打开**）
- 使用 AI 相关功能时，需在应用 **设置** 中自行填写可用的 API 地址与密钥（本仓库不包含任何第三方密钥）

---

## 快速开始

### 1. 克隆仓库

```bash
git clone <仓库地址>
cd <仓库目录>
```

### 2. 启动本地静态服务

任选一种即可。

**Python 3：**

```bash
python3 -m http.server 8080
```

**Node.js（需已安装 `npx`）：**

```bash
npx --yes serve -l 8080
```

**PHP：**

```bash
php -S 127.0.0.1:8080
```

### 3. 打开页面

```text
http://127.0.0.1:8080/
```

首次进入会看到启动页，随后进入桌面。在 **设置** 中配置 API 后即可使用相关能力。

### 手机预览

同一局域网下，用电脑的局域网 IP 访问：

```text
http://192.168.x.x:8080/
```

也可部署到任意静态托管（GitHub Pages、Cloudflare Pages、Nginx、对象存储静态站点等）。
部署后建议使用 HTTPS，以便 PWA / 持久存储等能力更完整。

---

## 常用操作

| 操作 | 说明 |
|------|------|
| 配置 API | 桌面 → **设置**，填写对话 API；论坛 API 可单独配置 |
| 备份数据 | 设置内的导入 / 导出（ZIP） |
| 换壁纸图标 | 桌面 → **美化** |
| 自定义布局 | 美化中切换自定义桌面，或主屏编辑小组件 |
| 清缓存异常 | 浏览器清除本站数据，或先注销 SW 后再强刷（开发时常用） |

---

## 排障

### 改了 JS / CSS 但页面没变化

静态资源 URL 带 `?v=` 版本参数，且 Service Worker 会缓存资源。按顺序试：

1. 递增 `index.html` 中对应资源的 `?v=` 版本号
2. 开发者工具 → Application → Service Workers → **Unregister**
3. 硬刷新（Mac：`Cmd+Shift+R`，Windows：`Ctrl+Shift+R`）

### Service Worker 导致白屏 / 打开是旧版本

1. 开发者工具 → Application → Service Workers → **Unregister**
2. Application → Storage → **Clear site data**
3. 重新加载页面

### 本地双击 `index.html` 打不开功能

必须通过 `http(s)://` 访问。用上面的静态服务器方式启动。

### 数据异常 / 怀疑数据丢失

打开开发者工具控制台，检查以下状态位：

| 状态位 | 含义 |
|---|---|
| `__miyaLastStorageError` | 最近一次本地存储写入失败（含 key 名、错误类型、时间、连续失败次数） |
| `__miyaLastMediaWriteError` | 最近一次媒体库（图片 / 音频）写入失败 |
| `__miyaSimulatorRedundancy` | 快照冗余度状态（`okCount` 低于 3 表示备份份数下降） |

控制台出现 `[miya-storage] 写盘失败` 表示**本地存储已满或不可用**（配额满 / 隐私模式）。
此时写入会被明确拒绝并留痕，不会静默丢弃。

处理方式：桌面 → **设置** → 导出备份，然后清理浏览器站点数据后重新导入。

---

## 二次开发提示

- 主入口几乎都在 `index.html`；业务逻辑按模块拆在 `js1/`、`js2/`，样式在 `css/`
- 新增非首屏 App 时，优先挂到 `js2/miya-lazy-boot.js` 的分组懒加载，避免拖慢启动
- 静态资源 URL 带有 `?v=` 版本参数；发版时如有缓存问题，可递增相关版本号
- 修改 `sw.js` 时记得同步更新其中的 `CACHE` 常量名，否则客户端仍读旧缓存
- **不要**把含密钥、用户名单、找回码等私密配置提交进公开仓库

---

## 许可协议

本项目以 **GNU Affero General Public License v3.0（AGPL-3.0）** 发布。

简要含义（非正式法律意见，细节以 [LICENSE](./LICENSE) 全文为准）：

- 可以自由使用、修改、分发本软件
- 分发修改版时，须继续以 AGPL-3.0（或兼容条款允许的方式）开源
- 若通过网络提供本程序的修改版服务，也须向用户提供对应源代码

Copyright © 2026 Karin contributors.

---

## 声明

- 本仓库为前端体验向项目，不包含商业登录后台
- 使用第三方 API 时，请遵守对应服务商条款与当地法律法规
