# 部署与存储说明

## 一句话结论

**存储不再是部署的限制。** 同一套代码支持两种存储模式，用环境变量切换；
切到云端后，服务器上不留任何数据文件 —— 进程彻底无状态，可以部署到任意平台。

| | 本地模式（默认） | 云端模式 |
|---|---|---|
| 触发条件 | 不设 `TURSO_DATABASE_URL` | 设了 `TURSO_DATABASE_URL` |
| 数据位置 | 本机 `~/.work-manager/work.db`（`DATA_DIR` / `DB_PATH` 可覆盖） | Turso 托管的 libSQL |
| 服务器要求 | **需要持久磁盘 + 常驻进程** | **什么都不需要**（无状态） |
| 自动快照 | 启动时 + 每天一份（`VACUUM INTO`） | 自动停用，持久化由 Turso 负责 |
| 换机器 / 重新部署 | 数据在项目外，不会丢 | 数据在云端，不会丢 |

> 业务代码完全不需要关心数据存在哪里 —— 两种驱动实现同一套接口（`server/db.js`）。

---

## 一、接入 Turso（免费，不用绑卡）

### 1. 注册并建库

用 CLI（最省事）：

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup          # 或 turso auth login
turso db create work-manager
turso db show work-manager --url        # → libsql://work-manager-xxx.turso.io
turso db tokens create work-manager     # → 一串令牌
```

也可以全在网页控制台点：<https://turso.tech> → 创建数据库 → 复制 **URL** 和 **Token**。

### 2. 部署时设两个环境变量

```
TURSO_DATABASE_URL = libsql://work-manager-xxx.turso.io
TURSO_AUTH_TOKEN   = eyJhbGciOi...
```

`https://` / `wss://` 写法也认（会自动归一化）。
**只要这两个变量存在，服务就自动切到云端模式**；不设则一切照旧走本地文件。

本地想直接用云端模式跑，把变量写进 `.env.local`（该项目已在 `.gitignore` 里排除 `.env*`，
不会被提交；模板见 `.env.example`），然后：

```bash
npm run start:cloud     # 自动加载 .env.local
npm run migrate:cloud   # 同理，带 .env.local 跑迁移
```

### 3. 确认切换成功

启动日志会明确告诉你用的是哪种：

```
[db] 存储：云端 libSQL（libsql://work-manager-xxx.turso.io）
  [备份] 云端存储模式：本地快照已停用（持久化由 Turso 负责，需要副本请用「导出」）
```

登录后访问 `/api/health` 也能看到：`{"ok":true,"driver":"remote","storage":"turso/libSQL"}`。

---

## 二、把现有数据搬过去

### 方式 A：命令行迁移（推荐）

```bash
TURSO_DATABASE_URL=libsql://xxx.turso.io \
TURSO_AUTH_TOKEN=xxx \
node server/migrate-to-cloud.js
```

- 全程一个事务：中途失败整体回滚，云上不会留下半个库
- 幂等（`INSERT OR REPLACE`），可以反复执行
- 连 `sqlite_sequence`（自增计数器）一起搬，云端新记录 id 与本地延续
- 结束后自动核对 6 张表行数，不一致会明确报警
- 本地原库**只读**，不会被改动

可选参数：`--dry-run`（只看行数不写入）、`--force`（云端已有数据时强制覆盖）。
要指定别的本地库：加 `DB_PATH=/path/to/work.db`。

### 方式 B：图形界面

旧站顶栏「导出」下载 JSON → 新站顶栏「导入」选该文件。两者等价。

---

## 三、推荐部署目标

以前受「必须有持久磁盘」限制的免费平台，现在都能用了。
下表是 2026-10 核对过的免费政策（这类平台改动很勤，动手前建议再看一眼官网）：

| 平台 | 免费额度 | 是否休眠 | 备注 |
|---|---|---|---|
| **Northflank** | 2 个服务 + 1 个库，常驻 | **不休眠** | 首推。需信用卡做身份验证（Sandbox 本身不扣费） |
| **Render** | 750 实例小时/月 | 15 分钟无流量休眠，冷启动约 1 分钟 | 免费且**不需要信用卡**；2026-04 起免费带宽降到 5 GB/月 |
| **Zeabur** | 每月 $5 用量额度 | 不休眠 | 有港/新/日节点，国内访问友好 |
| **Oracle Cloud Always Free** | 2 OCPU / 12 GB（ARM） | 不休眠 | 额度最实在，但要自己装系统、配 SSL；2026-06 起额度已减半 |
| **Railway** | 30 天 $5 试用，之后每月 $1 赠送额度 | 不休眠 | 部署体验最顺，但 $1/月 撑不住常驻服务 |
| ~~Koyeb~~ | 免费计算已取消 | — | 2026 年被收购，付费起步 $29/月，不建议 |
| ~~Fly.io~~ | 免费额度已取消 | — | 新账号只有试用量 |

> 一句话选法：**愿意交信用卡做验证 → Northflank（常驻不冷启动）；不想给卡 → Render（会休眠，但人家不要卡）。**

通用配置（Render / Northflank / Zeabur 都一样）：

- **Build Command**：`npm install`（或 `npm ci`）
- **Start Command**：`npm start`
- **环境变量**：
  - `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`（见上）
  - `ACCESS_PASSWORD`（访问口令，**上线公网必须改掉默认值**）
  - `PORT` 一般由平台自动注入，无需手动设
- **健康检查路径**：`/api/health`（该接口免登录，专门给平台探测用）

也可以直接用仓库里的 **`Dockerfile`**（Node 22 Alpine、纯 JS 客户端）—— 平台支持「用 Dockerfile 构建」时选它，
比自动探测更确定，且在任何架构上都能跑。

> 因为数据在 Turso，平台给的是**临时磁盘也没关系**，重启/重新部署都不影响数据。

---

## 三之二、从现在的 workbuddy 域名迁出去：照着做就行

数据**已经在 Turso 上**了，所以整个过程只剩「把代码挂到新平台 + 填 3 个环境变量」。

### 第 0 步：数据（已完成，无需你操作）

⚠️ **重要**：迁移时发现**旧线上站的数据比本机库更新**，已帮你处理好，不用你再动手：

| | 本机库 `~/.work-manager/work.db`（旧快照） | 旧线上站 | 现在云端 Turso |
|---|---|---|---|
| 任务 | 3 | 3 | **3** |
| 打卡 | 1 | **5** | **5** |
| 提醒 | 3 | 3 | **3** |
| 日报 | 1 | **2** | **2** |
| 日报条目 | 1 | **4** | **4** |
| 任务备注 | 0 | **1** | **1** |

也就是说：本机库停留在 10-09/10-10 的状态，而你 10-12 在线上站干的活（打卡、日报条目、
「授权验证码方案设计」等）**都不在本机库里**。直接拿本机库去迁会丢掉这些。
现已把旧站导出的 JSON 通过 `POST /api/import` 导进云端，并**逐字段核对一致**。

- 旧站导出原件备份在 `.workbuddy/backups/online-site-export-2026-10-13.json`
- 覆盖前的云端内容备份在 `.workbuddy/backups/cloud-before-import-*.json`
- 本机库**全程只读**，一个字节都没改

要注意的后续影响：**本机库现在比云端旧**。如果你以后在本地用文件模式跑，看到的还是旧数据；
想让本机库也跟上，从新站顶栏「导出」下载 JSON，再在本机用文件模式「导入」一次即可。

剩下三件事（都要你自己操作）：

### 第 1 步：把代码推到 GitHub（必须，平台从仓库拉代码）

```bash
git push origin main
```

仓库是私有的，会要求你登录 GitHub（浏览器弹窗或账号密码），登录一次即可。
推完确认：

```bash
git log --oneline -1 origin/main    # 应与本地 HEAD 一致
```

### 第 2 步：注册平台并新建服务

以 **Northflank** 为例：

1. 注册 / 登录 → 创建一个 Project
2. **Create Service** → 选 **Combined Service**（或 Web Service）
3. Repository 选 **GitHub** → 授权 → 选中本仓库、分支 `main`
4. Build 类型：选 **Buildpack**（会自动识别 Node），或选 **Dockerfile**（用仓库里的那个）
5. Instance 规格选 **Sandbox 免费档**
6. 端口：新建一个 **Public Port**，指向容器端口 **3000**，协议 HTTP

以 **Render** 为例：

1. 注册 → **New → Web Service** → 连接 GitHub 仓库（私有仓库需授权）
2. Runtime 选 **Node**
3. Build Command：`npm install`；Start Command：`npm start`；Instance Type 选 **Free**
4. Health Check Path 填 `/api/health`

### 第 3 步：填环境变量（这一步决定它连不连得上数据）

在平台的 Environment / Secrets 里加三行（值见项目根目录的 `.env.local`，可直接复制）：

| 变量名 | 值 |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://worker-necoxrr.aws-eu-west-1.turso.io` |
| `TURSO_AUTH_TOKEN` | 你之前生成的那串令牌（在 `.env.local` 里） |
| `ACCESS_PASSWORD` | **换成你自己的一串强口令**（不填就是默认的 `workbuddy-2026`，等于公开） |

### 第 4 步：部署并确认切换成功

部署日志里应出现：

```
[db] 存储：云端 libSQL（libsql://worker-necoxrr.aws-eu-west-1.turso.io）
[备份] 云端存储模式：本地快照已停用（持久化由 Turso 负责，需要副本请用「导出」）
```

然后打开平台给的网址 → 用 `ACCESS_PASSWORD` 登录 → 顶栏「导出」应能看到
3 任务 / 1 打卡 / 3 提醒 / 1 日报。看到这些就说明数据已经接上了。

也可以直接查健康检查（登录后带上 Cookie 才会显示 driver）：`{"ok":true,"driver":"remote","storage":"turso/libSQL"}`

### 第 5 步：收尾

1. 确认新站能正常用之后，旧站（workbuddy 域名）可以留着不动，也可以下线 ——
   数据不在它上面，下线不影响任何东西
2. 建议在 Turso 控制台**为线上单独建一个令牌**（只给这一个库、`rw` 权限），
   这样以后想单独吊销线上访问权时，不会连带影响本地开发
3. 换了域名之后，手机/电脑上的浏览器要重新登一次（旧 Cookie 绑在旧域名上）

---

## 四、注意事项

1. **Turso 免费库 14 天无活动会暂停**（数据不丢，进控制台点一下恢复）。日常用就没事。
2. **备份策略变了**：本地模式每天自动生成 `.db` 快照；云端模式改用 Turso 平台自身的持久化与历史，
   需要离线副本就用顶栏「导出」。
3. **两套环境可以并存**：本地继续用文件模式开发（速度最快、离线可用），线上用云端模式。
4. **不要同时让两个实例写同一个本地文件**：云模式下没这个问题（Turso 负责并发）。
5. 新增依赖 `@libsql/client` 只在你设了 `TURSO_*` 时才会被加载（懒加载），
   而且走的是 **`@libsql/client/web` 入口** —— 纯 JS 的 fetch/HTTP 管线，
   **不加载任何平台相关的原生二进制**，所以 Alpine / ARM / 任意架构都能跑，本地模式完全不受影响。
   - 不要改成默认入口 `@libsql/client`：它 require 后就会连带加载原生二进制
     （如 `@libsql/linux-x64-gnu`、`@libsql/win32-x64-msvc`），换架构/发行版可能加载失败，
     而且实测慢约 5 倍（1385 ms vs 270 ms）。
   - 不要改成 `@libsql/client/ws`：自建 libsql-server 可以，但连 Turso 托管端点会 WebSocket 握手 400。
   - 三个入口的 `SELECT` 与**事务回滚**都实测过，`/web` 与 `/http` 完全可用。
6. 迁移会把 `sqlite_sequence`（自增计数器）一起搬过去，云端新建记录的 id 与本地延续，
   不会复用历史删除过的 id。
7. **健康检查必须免登录**：托管平台的存活探测不带 Cookie，返回 401 会被判定成「部署失败」并反复重启。
   所以 `/api/health` 放在免登录白名单里，且对未登录访客只回 `{"ok":true}`，
   存储细节（`driver` / `storage`）仅登录后可见。

---

## 五、这套东西已经实测过什么

2026-10-13 用真实 Turso 库（`worker-necoxrr.aws-eu-west-1.turso.io`）跑过完整验证：

| 项目 | 结果 |
|---|---|
| 云端模式业务全流程 | **54 / 54** 断言通过（登录、任务增删改、打卡起停、提醒、日报、导入导出、并发写） |
| 本地文件模式同一套断言 | **54 / 54** 通过（证明两种驱动行为一致） |
| 迁移保真度 | 6 张表逐字段比对一致，含 `sqlite_sequence` |
| 无状态验证 | 云端模式跑完整轮业务后，本机 `~/.work-manager/work.db` 的 md5 与 mtime **完全未变** |
| 连接协议 | `libsql://` 与 `https://` 两种写法都通；`wss://` / `ws://` 会自动归一化 |
| 客户端入口 | `/web` 与 `/http` 均可用且事务回滚正确；**只有 `/web`、`/http` 是纯 JS**，默认入口会加载原生二进制 |
| 健康检查 | 未登录访问返回 `200 {"ok":true}`（不带存储细节）；业务接口仍 401；首页 302 到登录页 |

验证用的隔离规范：测试一律使用**独立数据库副本 + 独立端口（32xx）**，绝不碰正式端口与真实数据。
