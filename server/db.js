/**
 * 数据层：可插拔存储（同一套业务代码，数据放哪儿由环境变量决定）
 *
 *  · 本地模式（默认）—— Node 内置 node:sqlite，零原生依赖。
 *      数据库放在「项目目录之外」的固定目录（数据与代码分离，重新部署不会冲掉数据）。
 *      可用 DATA_DIR 覆盖目录；DB_PATH 单独指定某个库文件（隔离测试用）。
 *
 *  · 云端模式 —— 设好 TURSO_DATABASE_URL + TURSO_AUTH_TOKEN 即自动切换：
 *      数据存到托管的 libSQL（Turso），服务器上不留任何文件 ⇒ 进程彻底无状态，
 *      可部署到任意免费主机（Render / Northflank / Railway / Zeabur / 任意 VPS …）。
 *      用 @libsql/client/web 入口（纯 JS 的 fetch/HTTP 管线），
 *      **不加载任何平台相关的原生二进制** ⇒ Alpine / ARM / 任意架构都能跑。
 *      注：不要改用 /ws —— 自建 libsql-server 用 ws 可以，但 Turso 托管端点
 *      的 WebSocket 握手会返回 400；/web 两种环境都通，事务能力也已实测（提交/回滚正确）。
 *
 * 对外统一导出【异步】接口，两种驱动实现完全一致：
 *      init()                建表 + 幂等迁移 + 连接自检
 *      all(sql, ...params)   多行
 *      get(sql, ...params)   单行
 *      run(sql, ...params)   写入 → { changes, lastInsertRowid }
 *      exec(sql)             执行单条 DDL / PRAGMA
 *      transaction(fn)       事务；fn 收到一个 { all, get, run } 的 tx 句柄
 *      backfillLogDates()    幂等回填 log_date
 *      close()               关闭连接（优雅退出用）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { toDateStr } = require('./utils');

// —— 模式判定 ——
const TURSO_URL = (process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || '').trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || process.env.TURSO_TOKEN || '').trim();
const DRIVER = TURSO_URL ? 'remote' : 'local';

/**
 * URL 归一化：把各种写法统一成 libSQL 客户端认的协议。
 *  · 用户从 Turso 控制台复制的是 libsql://（有时是 https://）—— 默认入口两者都吃，原样保留
 *  · 若粘贴的是 ws/wss（走 WebSocket 的老写法）—— 转回 libsql:/// http://，默认入口不认 ws
 */
function toClientUrl(u) {
  if (u.startsWith('wss://')) return `libsql://${u.slice(6)}`;
  if (u.startsWith('ws://')) return `http://${u.slice(5)}`;
  return u;
}

/**
 * 参数归一化：两种驱动都不接受 undefined（会直接抛错），统一转成 null。
 * 布尔值顺手转 0/1（SQLite 没有布尔类型），避免以后有人直接传 true/false 踩坑。
 */
function normArgs(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

/**
 * 单个 SQL 里的值归一化：BigInt → Number。
 * libSQL 客户端会把整数以 BigInt 返回，而 res.json() 无法序列化 BigInt（会直接抛错）；
 * 本应用里的 id / 计数 / 时长都远在安全整数范围内，统一转 Number 最稳妥。
 */
function normVal(v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** 把 @libsql/client 返回的一行（对象）归一化 */
function normRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = normVal(row[k]);
  return out;
}

/* ============================ 本地驱动 ============================ */

let dbPath = null;   // 本地库文件路径（云端模式为 null）
let local = null;    // node:sqlite 实例

function initLocal() {
  const seedDbPath = path.join(__dirname, '..', 'data', 'work.db'); // 随代码打包的「种子库」
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(os.homedir(), '.work-manager');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  dbPath = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(dataDir, 'work.db');

  // 首次运行（目标库还不存在）：用打包进来的种子库初始化；
  // 一旦已存在就【绝不覆盖】—— 这是保护线上数据的关键。
  if (!process.env.DB_PATH && !fs.existsSync(dbPath) && fs.existsSync(seedDbPath)) {
    fs.copyFileSync(seedDbPath, dbPath);
  }

  const { DatabaseSync } = require('node:sqlite');
  local = new DatabaseSync(dbPath);
}

const localApi = {
  async all(sql, params = []) { return local.prepare(sql).all(...params); },
  async get(sql, params = []) { return local.prepare(sql).get(...params); },
  async run(sql, params = []) {
    const r = local.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  async exec(sql) { local.exec(sql); },
};

/* ============================ 云端驱动 ============================ */

let client = null;   // @libsql/client 实例

function initRemote() {
  // 只用 /web 入口（= fetch / HTTP hrana 管线）——**纯 JS、零原生二进制**。
  //
  // 为什么不用默认入口 `@libsql/client`：它 require 后就会连带加载平台相关的原生
  // 二进制（如 @libsql/win32-x64-msvc、@libsql/linux-x64-gnu），
  // 服务器架构/发行版一变（Alpine musl、ARM）就可能装不上或加载失败；
  // 而且实测它比纯 JS 入口慢约 5 倍（1385ms vs 270ms，因为多了本地绑定初始化）。
  //
  // 不要改用 /ws：自建 libsql-server 可用，但连 Turso 托管端点会 WebSocket 握手 400。
  const { createClient } = require('@libsql/client/web');
  client = createClient({ url: toClientUrl(TURSO_URL), authToken: TURSO_TOKEN });
}

const remoteApi = {
  async all(sql, params = []) {
    const r = await client.execute({ sql, args: params });
    return r.rows.map(normRow);
  },
  async get(sql, params = []) {
    const r = await client.execute({ sql, args: params });
    return r.rows.length ? normRow(r.rows[0]) : undefined;
  },
  async run(sql, params = []) {
    const r = await client.execute({ sql, args: params });
    return {
      changes: Number(r.rowsAffected || 0),
      lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid),
    };
  },
  async exec(sql) { await client.execute(sql); },
};

/* ============================ 统一接口 ============================ */

let api = null; // 当前生效的驱动

/** 建表语句（逐条执行，避免依赖「一次执行多条」的方言差异） */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     title         TEXT NOT NULL,
     description   TEXT DEFAULT '',
     plan_start    TEXT,
     plan_end      TEXT,
     deadline      TEXT,
     actual_start  TEXT,
     actual_end    TEXT,
     status        TEXT DEFAULT '未开始',
     important     INTEGER DEFAULT 0,
     urgent        INTEGER DEFAULT 0,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS work_logs (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id     INTEGER NOT NULL,
     start_at    TEXT,
     end_at      TEXT,
     duration_ms INTEGER,
     log_date    TEXT,
     created_at  TEXT NOT NULL,
     FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS reminders (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id     INTEGER NOT NULL,
     type        TEXT NOT NULL,
     value       TEXT NOT NULL,
     trigger_at  TEXT NOT NULL,
     is_read     INTEGER DEFAULT 0,
     created_at  TEXT NOT NULL,
     FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS daily_reports (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     report_date TEXT NOT NULL UNIQUE,
     content     TEXT DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
  // 日报工作条目：每条可选择关联一个任务（task_id），或为空表示「其他小事」
  // 任务被删除时置空（不删条目），保留当天的工作记录
  `CREATE TABLE IF NOT EXISTS report_entries (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     report_date TEXT NOT NULL,
     task_id     INTEGER,
     content     TEXT DEFAULT '',
     sort_order  INTEGER DEFAULT 0,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
   )`,
  // 每个任务在某天的「补充说明」（与工作条目分开：条目是"做了什么"，说明是本任务的备注）
  // task_id 为空表示「其他小事 / 不关联任务」那一组；任务被删除时置空（不删备注）
  `CREATE TABLE IF NOT EXISTS report_task_notes (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     report_date TEXT NOT NULL,
     task_id     INTEGER,
     note        TEXT DEFAULT '',
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_work_logs_date ON work_logs(log_date)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_task ON reminders(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at)`,
  `CREATE INDEX IF NOT EXISTS idx_report_entries_date ON report_entries(report_date)`,
  `CREATE INDEX IF NOT EXISTS idx_report_notes_date ON report_task_notes(report_date)`,
];

/** 若某表缺少某列则补上（用于老库平滑升级） */
async function ensureColumn(table, column, ddl) {
  const cols = await api.all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await api.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    console.log(`[db] 已为 ${table} 新增字段 ${column}`);
  }
}

/** 初始化：选驱动 → 建表 → 幂等迁移 → 连接自检 */
async function init() {
  if (DRIVER === 'remote') {
    initRemote();
    api = remoteApi;
    console.log(`[db] 存储：云端 libSQL（${TURSO_URL.replace(/\/\/[^@]*@/, '//')}）`);
  } else {
    initLocal();
    api = localApi;
    if (DRIVER === 'local') {
      try { await api.exec('PRAGMA foreign_keys = ON;'); } catch { /* 某些环境不支持，忽略 */ }
    }
    console.log(`[db] 存储：本地文件（${dbPath}）`);
  }

  for (const stmt of SCHEMA) await api.exec(stmt);

  // 幂等迁移：给老库补上后加的字段（列已存在则跳过，重复启动不会报错）
  await ensureColumn('tasks', 'important', 'important INTEGER DEFAULT 0');
  await ensureColumn('tasks', 'urgent', 'urgent INTEGER DEFAULT 0');

  // 连接自检：连不上就早点炸，别等用户点开页面才发现
  const probe = await api.get('SELECT 1 AS ok');
  if (!probe) throw new Error('数据库连接自检失败');
}

/* ---------------------------- 导出（业务只用这几个） ---------------------------- */

/** 多行查询 */
function all(sql, ...params) { return api.all(sql, normArgs(params)); }
/** 单行查询 */
function get(sql, ...params) { return api.get(sql, normArgs(params)); }
/** 写入 → { changes, lastInsertRowid } */
function run(sql, ...params) { return api.run(sql, normArgs(params)); }
/** 执行单条 DDL / PRAGMA */
function exec(sql) { return api.exec(sql); }

/**
 * 事务：fn 收到一个 tx 句柄（all/get/run），在其中读到的数据都能看到自己刚写的。
 * 本地驱动用 BEGIN/COMMIT；云端用真正的 libSQL 交互式事务。任何异常都会回滚。
 */
async function transaction(fn) {
  if (DRIVER === 'local') {
    await api.exec('BEGIN');
    try {
      const r = await fn(api);
      await api.exec('COMMIT');
      return r;
    } catch (err) {
      try { await api.exec('ROLLBACK'); } catch { /* 无活动事务时忽略 */ }
      throw err;
    }
  }
  const tx = await client.transaction('write');
  const handle = {
    all: async (sql, params = []) => {
      const r = await tx.execute({ sql, args: params });
      return r.rows.map(normRow);
    },
    get: async (sql, params = []) => {
      const r = await tx.execute({ sql, args: params });
      return r.rows.length ? normRow(r.rows[0]) : undefined;
    },
    run: async (sql, params = []) => {
      const r = await tx.execute({ sql, args: params });
      return {
        changes: Number(r.rowsAffected || 0),
        lastInsertRowid: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid),
      };
    },
  };
  try {
    const r = await fn(handle);
    await tx.commit();
    return r;
  } catch (err) {
    try { await tx.rollback(); } catch { /* 已回滚或连接断开时忽略 */ }
    throw err;
  }
}

/**
 * 幂等回填：把 work_logs.log_date 规范为「开始日」的本地日期。
 * 起因：旧版结束打卡会把 log_date 覆盖成结束日，导致跨天任务在开始日缺席。
 * 现在日报按「时间区间重叠」查询，log_date 已不参与筛选，本函数只用于数据一致性。
 * 第二次运行即为 0 次修改，可安全重复执行。
 * @param {{all:Function, run:Function}} [a] 可传入事务句柄，让回填与导入同事务
 * @returns {Promise<number>} 本次修正的行数
 */
async function backfillLogDates(a) {
  const h = a || api;
  const rows = await h.all('SELECT id, start_at, log_date FROM work_logs WHERE start_at IS NOT NULL');
  let fixed = 0;
  for (const r of rows) {
    const dt = new Date(r.start_at);
    if (isNaN(dt.getTime())) continue; // 跳过无法解析的脏数据
    const correct = toDateStr(dt);
    if (correct !== r.log_date) {
      await h.run('UPDATE work_logs SET log_date = ? WHERE id = ?', [correct, r.id]);
      fixed += 1;
    }
  }
  if (fixed) console.log(`[db] 已回填 ${fixed} 条 work_logs.log_date 为开始日`);
  return fixed;
}

/** 关闭连接（优雅退出用） */
async function close() {
  try {
    if (DRIVER === 'remote' && client) client.close();
    else if (local) local.close();
  } catch { /* 已关闭时忽略 */ }
}

module.exports = {
  DRIVER,
  driver: DRIVER,
  get dbPath() { return dbPath; },
  init,
  all,
  get,
  run,
  exec,
  transaction,
  backfillLogDates,
  close,
};
