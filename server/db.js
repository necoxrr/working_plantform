/**
 * 数据库层：使用 Node.js 内置的 node:sqlite 模块（Node 22+ 自带，无需安装原生依赖）。
 * 数据库文件存放在项目 data/ 目录下，已在 .gitignore 中排除，不会上传 GitHub。
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// 确保 data 目录存在
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'work.db');
const db = new DatabaseSync(dbPath);

// 开启外键约束
db.exec('PRAGMA foreign_keys = ON;');

/**
 * 建表。使用 IF NOT EXISTS，重复启动不会报错。
 *
 * 四张表：
 *  - tasks         任务
 *  - work_logs     工作记录（打卡，任务级）
 *  - reminders     提醒点（只有任务能设，可多个）
 *  - daily_reports 日报（手写内容）
 */
function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      description   TEXT DEFAULT '',
      plan_start    TEXT,
      plan_end      TEXT,
      deadline      TEXT,
      actual_start  TEXT,
      actual_end    TEXT,
      status        TEXT DEFAULT '未开始',
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL,
      start_at    TEXT,
      end_at      TEXT,
      duration_ms INTEGER,
      log_date    TEXT,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL,
      type        TEXT NOT NULL,
      value       TEXT NOT NULL,
      trigger_at  TEXT NOT NULL,
      is_read     INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL UNIQUE,
      content     TEXT DEFAULT '',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_logs_date ON work_logs(log_date);
    CREATE INDEX IF NOT EXISTS idx_reminders_task ON reminders(task_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at);
  `);
}

init();

/**
 * 统一查询辅助：把 node:sqlite 的 statement API 包一层，方便调用。
 */
function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

module.exports = { db, dbPath, all, get, run };
