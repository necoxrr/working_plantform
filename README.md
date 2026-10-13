# 工作管理平台

一个**个人自用**的轻量工作管理平台：记录每日工作内容、任务时间节点、打卡耗时、截止与提醒，并自动汇总成日报。

技术栈极简，**零原生依赖**（数据库用 Node.js 22 内置的 `node:sqlite`），`npm install` + `npm start` 即可运行。
存储可插拔：默认写本地 SQLite 文件，设好 `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` 就自动切到云端 libSQL，
进程变成彻底无状态，可部署到任意平台 —— 详见 [DEPLOY.md](DEPLOY.md)。

---

## 功能一览

| 模块 | 说明 |
|---|---|
| **任务管理** | 新建 / 编辑 / 删除任务，含标题、描述、计划时间、截止时间、状态 |
| **打卡** | 任务级打卡：点「开始打卡」→ 点「结束打卡」，自动算出实际耗时 |
| **时间节点** | 计划时间可手动填，也可按预估工时自动推算；实际时间由打卡记录 |
| **提醒** | 仅站内提醒；只有任务能设，一个任务可设**多个**提醒点（相对偏移 / 绝对时间）；打开平台时以**列表**形式补推错过的提醒 |
| **日报** | 左侧手写当日工作内容，右侧**自动汇总**当天任务（按实际活动日期）；可切换任意历史日期查看与修改 |
| **备份** | 页面右上角一键「导出备份 / 导入」JSON |

### 关键规则

- **任务状态**：未开始 / 进行中 / 已完成 为存储状态；**已逾期**由系统根据截止时间自动判定并标红。
- **提醒点**：
  - 相对偏移：如 `-1d`（截止前 1 天）、`-2h`（截止前 2 小时）、`-30m`（截止前 30 分钟）
  - 绝对时间：直接指定具体日期时间
- **日报归属**：按任务**实际打卡日期**归入日报；**跨天任务**在每个有活动的日期都出现，并标注「跨天」。
- **逾期任务**：当天继续出现在日报侧栏并标红。

---

## 环境要求

- **Node.js 22 或更高版本**（数据库依赖 Node 22 内置的 `node:sqlite`）
- npm

检查版本：

```bash
node -v   # 应 >= v22.0.0
```

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start
```

启动后打开浏览器访问：**http://localhost:3000**

> 首次启动会自动在 `data/` 目录创建 SQLite 数据库文件 `work.db`，无需手动建库。

如需换端口：

```bash
PORT=8080 npm start
```

---

## 在 VSCode 中运行

1. 用 VSCode 打开项目文件夹。
2. 打开终端（`Ctrl+` ` 或 菜单 终端 → 新建终端）。
3. 执行 `npm install`，再执行 `npm start`。
4. 浏览器打开 http://localhost:3000。

---

## 目录结构

```
work-manager/
├── server/
│   ├── index.js      # Express 服务与全部 API 路由
│   ├── db.js         # SQLite 初始化与建表
│   └── utils.js      # 提醒触发计算、状态推导等工具
├── public/
│   ├── index.html    # 页面结构
│   ├── style.css     # 样式
│   └── app.js        # 前端逻辑（原生 JS，无框架）
├── data/             # 数据库文件目录（已 gitignore，不会上传）
├── package.json
├── .gitignore
└── README.md
```

---

## 数据备份与迁移

- **界面备份**：页面右上角「导出备份」下载一个 JSON 文件；「导入」可恢复。
- **文件备份**：直接复制 `data/work.db` 文件即可。
- **迁移到新电脑**：把整个项目文件夹（含 `data/`）拷过去，`npm install` 后启动即可。

> ⚠️ `data/` 目录已在 `.gitignore` 中排除。**上传 GitHub 时你的个人工作数据不会被传上去。**

---

## 上传到 GitHub

```bash
git init
git add .
git commit -m "初始提交：个人工作管理平台"
git branch -M main
git remote add origin <你的仓库地址>
git push -u origin main
```

`.gitignore` 已排除 `node_modules/`、`data/` 与所有 `*.db` 文件，个人数据不会泄露。

---

## 主要 API（供参考）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 新建任务 |
| PUT | `/api/tasks/:id` | 更新任务 |
| DELETE | `/api/tasks/:id` | 删除任务 |
| POST | `/api/tasks/:id/start` | 开始打卡 |
| POST | `/api/tasks/:id/stop` | 结束打卡 |
| GET | `/api/reminders/pending` | 待处理提醒（补推列表） |
| POST | `/api/reminders/:id/read` | 标记提醒已读 |
| GET | `/api/reports/:date` | 某天日报手写内容 |
| POST | `/api/reports` | 保存某天日报 |
| GET | `/api/reports/:date/summary` | 某天任务自动汇总 |
| GET | `/api/export` | 导出全部数据 |
| POST | `/api/import` | 导入数据（覆盖） |

---

## 说明与边界

- 本工具为**个人自用**，无多用户、无登录、无权限体系。
- 数据**仅存本地**，不上云。
- 提醒为**站内提醒**：需打开页面才能看到；打开时会把已到时间、未读的提醒以列表形式补推。
- 无邮件 / 短信 / 企业微信等外部提醒（按需求刻意不做）。
