# 部署到 Cloudflare（Workers + Durable Objects）— 免信用卡 · 真 7×24

> 目标：把「斗地主联机模拟器」跑在 Cloudflare 边缘网络上，**你关机、断网，别人也能随时打开玩**。
> 好处：免信用卡、免服务器、免运维；Workers + Durable Objects 是 Serverless，永远在线。

---

## 一、方案概述

| 组件 | 作用 |
|------|------|
| **Worker**（`worker.js`） | 入口，路由请求：大厅列表 / 房间 WebSocket / 房间 API / 静态资源 |
| **Durable Object `Room`**（`room-do.js`） | 每个房间一个实例，持有房间状态、广播 WebSocket、定时推进（机器人/超时）、持久化 |
| **Durable Object `Lobby`**（`lobby-do.js`） | 全局单例，维护跨房间索引，供大厅浏览房间列表 |
| **静态资源**（`public/`） | 前端 HTML/JS/CSS，由 Cloudflare 边缘直接托管 |

业务逻辑（出牌/叫地主/机器人 AI）抽成 `src/` 下的平台无关模块，**本地 Node 版和云端 Cloudflare 版共用同一套代码**，不会出现两套逻辑分叉。

通信方式：前端用 **WebSocket**（取代旧版 SSE），彻底解决公网隧道下 SSE 被缓冲导致的延迟；并保留 500ms HTTP 轮询兜底，断线自动重连。

---

## 二、前置条件

1. **Cloudflare 账号（免费，免信用卡）**
   - 注册地址：https://dash.cloudflare.com/sign-up
   - 只需邮箱 + **手机号验证码**（无需信用卡、无需绑卡）。
2. **Node.js 18+** 已安装（本地用来跑 wrangler 部署工具）。
3. 本仓库代码（已经改造成 Cloudflare 架构，含 `worker.js` / `room-do.js` / `lobby-do.js` / `wrangler.toml`）。

---

## 三、本地准备

在 `doudizhu/` 目录下执行（依赖已写入 `package.json`，`npm install` 会装好 wrangler 3.x）：

```bash
cd doudizhu
npm install
```

> ⚠️ 我们用 `^3.78.0` 锁定 **wrangler 3.x**。不要把 package.json 改成 4.x，
> wrangler 4 的 `assets` 配置语法不同，会导致部署失败。
> 始终用项目里的 `npm run deploy`，它会调用本地安装的 3.x。

---

## 四、登录 wrangler（任选一种）

### 方式 A：浏览器 OAuth（最简单，推荐）

```bash
npx wrangler login
```

会自动打开浏览器，登录你的 Cloudflare 账号并授权。授权完即可关闭网页。

### 方式 B：API Token（无浏览器 / 服务器环境）

1. 打开 https://dash.cloudflare.com/profile/api-tokens
2. 点 **Create Token** → 使用模板 **Edit Cloudflare Workers**（或自定义：Account/Worker Scripts 读写、Durable Objects 读写）
3. 生成后复制 Token，设为环境变量：

```bash
# Windows PowerShell
$env:CLOUDFLARE_API_TOKEN = "你的token"
# 或写进 ~/.bashrc / 系统环境变量里，避免每次重设
```

---

## 五、本地验证打包（可选但推荐）

```bash
npm run dry-run
```

会做本地打包（`wrangler deploy --dry-run`），**不会真的上传**。看到类似输出即说明代码/配置无误：

```
Total Upload: 60.37 KiB / gzip: 13.43 KiB
Your worker has access to the following bindings:
- Durable Objects:
  - ROOM: Room
  - LOBBY: Lobby
--dry-run: exiting now.
```

---

## 六、一键部署

```bash
npm run deploy
```

首次部署会：
- 自动创建两个 Durable Object 命名空间（`wrangler.toml` 里 `migrations v1` 已声明 `Room`/`Lobby`）。
- 上传 Worker + 静态资源。

成功后命令行末尾会给出一个**永久的**二级域名，例如：

```
https://doudizhu.<你的子域>.workers.dev
```

把这个链接发给朋友，他们**任何时候都能打开**，无需你开机。

> 之后每次改代码，重新 `npm run deploy` 即可热更新。

---

## 七、绑定自定义域名（可选）

想要 `ddz.你的域名.com` 这种地址：

1. 把你的域名托管到 Cloudflare（免费版即可，按提示改 DNS NS）。
2. 在 `wrangler.toml` 加一行：

```toml
routes = [
  { pattern = "ddz.你的域名.com", custom_domain = true }
]
```

3. `npm run deploy`，按提示在 Cloudflare 控制台确认域名授权即可。

---

## 八、7×24 与免费额度说明

- **永远在线**：Workers 是 Serverless，没有「服务器」需要你保持开机。请求来了才运行，天然 7×24。
- **免费额度（足够小游戏长期使用）**：
  - Workers：每天 100,000 次请求。
  - Durable Objects：每天 100,000 次 DO 请求 + 一定量的存储/计时。
  - 静态资源（前端）走 Cloudflare 边缘 CDN，基本不计费。
- **WebSocket**：免费版支持。每个出/入消息计一次请求，3 人小房间完全够用。
- **超出免费额度**：按量计费（很便宜，约 $0.15/百万次 DO 请求），可在控制台设用量上限告警，避免意外。

---

## 九、与「本地运行 / 隧道」的区别

| 方式 | 是否需要你开机 | 地址有效期 | 适合 |
|------|----------------|------------|------|
| 本地 `npm start` + cloudflared 隧道 | 需要 | 临时（每次子域变） | 临时测试和朋友们玩一下 |
| **Cloudflare 部署（本方案）** | **不需要** | **永久** | **长期 7×24 公开服务** |

本地运行命令仍是 `npm start`（Node 进程，端口 3000）；云端部署用 `npm run deploy`。

---

## 十、常见坑

1. **`wrangler deploy` 报 `auth` / 401**：没登录。用方式 A 的 `npx wrangler login`，或确认方式 B 的 `CLOUDFLARE_API_TOKEN` 已导出且 Token 权限包含 Workers + DO。
2. **部署后房间列表为空 / 进不去**：首次部署会自动建 DO 命名空间；如果中途改过 `class_name`，需新增一条 `migrations`（递增 tag，如 v2 在 `new_classes` 里加新类）。本仓库已是 v1，正常不会遇到。
3. **WebSocket 连不上**：确认 `wrangler.toml` 里 `compatibility_date` 较新（已设 2024-09-23，支持 WS）。浏览器访问 `https://` 时前端自动用 `wss://`。
4. **改了前端没生效**：Cloudflare 静态资源有缓存，部署后用 `Ctrl+Shift+R` 硬刷新。
5. **机器人不动 / 出牌卡住**：房间必须有人通过 WebSocket 连着，定时推进才会跑（DO 在无连接时会休眠以省资源）。前端进房即自动建立 WS，正常不会卡；若全员的 WS 都断了，游戏会暂停，有人回来即继续。
6. **`npm` / `npx` 报"无法加载文件，因为在此系统上禁止运行脚本"**：Windows PowerShell 默认 **执行策略（Execution Policy）= Restricted**，禁止运行脚本；而 npm/npx 在 Windows 上有 `.ps1` 包装，所以被拦。两种解决：
   - **最简单（推荐）**：改用**命令提示符（CMD）**——在 doudizhu 文件夹里点地址栏输入 `cmd` 回车打开，再跑 `npm install` / `npx wrangler login` / `npm run deploy`（CMD 不受此限制，npm 走 `.cmd` 包装）。
   - **或**在当前 PowerShell 窗口先执行 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`（只对当前这个窗口有效，关掉即失效，不改系统全局设置，最安全），再跑命令。
7. **`wrangler` 报 "Timed out waiting for authorization code"**：浏览器 OAuth 回调超时（wrangler 在本地开 localhost 临时端口等授权回调，但没收到——常见原因：你点的是更早一次 `login` 的授权页而非本次 `deploy` 新开的页，或防火墙/杀软拦截了 localhost 回调）。这时**放弃浏览器登录，改用 API Token（见上文"方式 B"）**：关掉卡住的窗口 → 去 dash.cloudflare.com/profile/api-tokens 建 Token（模板 **Edit Cloudflare Workers**）→ 在 CMD 里 `set CLOUDFLARE_API_TOKEN=你的token`（CMD 语法，不是 PowerShell 的 `$env:`）→ 直接 `npm run deploy`。Token 方式不弹浏览器、不走回调，最稳。末尾那行 `Assertion failed: ...UV_HANDLE_CLOSING` 是 wrangler 退出时的 Windows 底层小崩溃，可忽略。
8. **免费计划报 "must create a namespace using a `new_sqlite_classes` migration" [code: 10097]**：Cloudflare 免费计划现在强制 Durable Objects 用 **SQLite 后端**，迁移声明必须用 `new_sqlite_classes` 而非旧的 `new_classes`。把 `wrangler.toml` 的 `[[migrations]]` 里 `new_classes = ["Room", "Lobby"]` 改成 `new_sqlite_classes = ["Room", "Lobby"]`，重跑 `npm run deploy` 即可。DO 代码里 `state.storage.get/put` 在 SQLite 后端**仍然兼容**，无需改业务代码。
9. **新账号首次部署报 "You need a workers.dev subdomain... [code: 10063]"**：首次部署前必须先创建 workers.dev 子域名。
   - **控制台创建**：dash.cloudflare.com → 左侧 **Workers & Pages** → 首次进入会在页面顶部/中间出现子域设置框（填前缀如 `zhanghong`，全局唯一、设后不可改）。若新版 UI 没弹框，直接访问 `https://dash.cloudflare.com/<ACCOUNT_ID>/workers` 或点右上角账户 → Account Home 找 Workers 区域。
   - **API 创建已禁用（重要）**：Cloudflare 已关闭创建子域的 API 端点——用 API Token 调返回 `10405 Method not allowed`，用 Global Key 调返回 `1001 method_not_allowed`。**curl 方案全部失效，只能走控制台 UI**。精确入口：打开 [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → 找 **Your subdomain** 一行，点右边的 **Change**（首次为空白待填）→ 输入前缀（如 `zhanghong`，全局唯一、设后不可改）→ 保存。若页面先让你建/选 Worker，进任意 Worker 的 **Settings → Domains & Routes** 也能看到 `workers.dev` 子域设置。兜底：在 Workers & Pages 点 **Create** 新建空白 Worker 并部署，流程会强制先设子域，设完可删该临时 Worker。
     返回 `{"success":true,...}` 即建好（前缀被占会提示 unavailable，换一个）。Global Key 权限很大，仅在本机命令行用即可。
   - 建好后回到 CMD 重跑 `npm run deploy`。最终网址形如 `https://doudizhu.<前缀>.workers.dev`（worker 名来自 wrangler.toml 的 `name`）。

---

## 十一、回滚与更新

- **更新代码**：改完直接 `npm run deploy` 覆盖。
- **回滚**：Cloudflare 控制台 → Workers & Pages → 你的 Worker → Settings/版本，可切回历史版本。
- **彻底下线**：在控制台删除该 Worker 即可，不产生费用。

---

## 十二、文件清单（改造后）

```
doudizhu/
├── worker.js          # Worker 入口（ESM 路由）
├── room-do.js         # Durable Object: Room（房间实例）
├── lobby-do.js        # Durable Object: Lobby（大厅索引）
├── wrangler.toml      # 部署配置（DO 绑定 + assets）
├── server.js          # 本地 Node 版（同一套 src/ 逻辑）
├── src/
│   ├── room.js        # 房间核心逻辑（纯函数，无平台依赖）
│   ├── game-api.js    # 房间动作 API 核心（processApi）
│   ├── view.js        # 玩家视角视图（viewFor）
│   ├── tick.js        # 定时推进（runTick：机器人/超时）
│   ├── bot.js         # 机器人 AI
│   ├── engine.js      # 牌型判定
│   └── cards.js       # 牌堆/洗牌
└── public/
    ├── index.html
    ├── app.js         # 前端（WebSocket + 轮询兜底）
    └── style.css
```

部署完成，关掉电脑，把 `https://doudizhu.<子域>.workers.dev` 发给大家即可。🂡
