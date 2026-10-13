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

以前受「必须有持久磁盘」限制的免费平台，现在都能用了：

| 平台 | 免费额度 | 备注 |
|---|---|---|
| **Render** | Web Service 免费实例 | 会休眠，冷启动慢；以前因临时盘不可用，现在可以 |
| **Northflank** | 1 服务 / 1GB | 不休眠，最省心 |
| **Railway** | 试用额度 | 部署体验最顺 |
| **Zeabur** | 每月 $5 额度 | 港/新/日节点，国内访问友好 |
| **Koyeb** | 1 服务 | 会 scale-to-zero |
| **任意 VPS** | — | Oracle Cloud Always Free 等 |

通用配置（以 Render/Northflank 为例）：

- **Build Command**：`npm install`（或 `npm ci`）
- **Start Command**：`npm start`
- **环境变量**：
  - `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`（见上）
  - `ACCESS_PASSWORD`（访问口令，不设则默认 `workbuddy-2026`）
  - `PORT` 一般由平台自动注入，无需手动设

> 因为数据在 Turso，平台给的是**临时磁盘也没关系**，重启/重新部署都不影响数据。

---

## 四、注意事项

1. **Turso 免费库 14 天无活动会暂停**（数据不丢，进控制台点一下恢复）。日常用就没事。
2. **备份策略变了**：本地模式每天自动生成 `.db` 快照；云端模式改用 Turso 平台自身的持久化与历史，
   需要离线副本就用顶栏「导出」。
3. **两套环境可以并存**：本地继续用文件模式开发（速度最快、离线可用），线上用云端模式。
4. **不要同时让两个实例写同一个本地文件**：云模式下没这个问题（Turso 负责并发）。
5. 新增依赖 `@libsql/client` 仅在有 `TURSO_*` 时才被加载，且用的是**默认（fetch/HTTP 管线）入口**
   —— 纯 JS，运行时不加载任何原生二进制，本地模式完全不受影响。
   （不要改成 `@libsql/client/ws`：自建 libsql-server 可以，但连 Turso 托管端点会 WebSocket 握手 400。）
6. 迁移会把 `sqlite_sequence`（自增计数器）一起搬过去，云端新建记录的 id 与本地延续，
   不会复用历史删除过的 id。

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

验证用的隔离规范：测试一律使用**独立数据库副本 + 独立端口（32xx）**，绝不碰正式端口与真实数据。
