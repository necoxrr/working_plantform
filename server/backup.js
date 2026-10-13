/**
 * 数据备份：本地模式下用 SQLite 原生 `VACUUM INTO` 生成「一致性快照」。
 *
 * 为什么不直接 copy 文件：
 *   服务运行中若有写入，cp 可能抓到事务进行到一半的状态；
 *   `VACUUM INTO` 由 SQLite 保证快照原子、一致，且顺带整理碎片。
 *
 * 策略：
 *   - 服务启动时备一份（当天已有则跳过，避免频繁重启刷屏）
 *   - 之后每 24 小时备一份
 *   - 快照存 <数据库目录>/backups/work-YYYYMMDD-HHMMSS.db，只保留最近 KEEP 份
 *   - 手动备份：`node server/backup.js`
 *
 * 云端模式（Turso）：服务器上没有数据库文件，`VACUUM INTO` 不适用；
 *   持久化与历史备份由 Turso 平台负责，本模块自动停用（需要离线副本就用顶栏「导出」）。
 *
 * 恢复方式（任选）：
 *   - 文件级：停服 → 用快照文件覆盖数据库文件 → 重启
 *   - 数据级：顶栏「导入」，选任意一次「导出」出的 JSON
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const KEEP = 30;                      // 最多保留的快照份数
const DAY_MS = 24 * 60 * 60 * 1000;   // 定时备份间隔
const NAME_RE = /^work-\d{8}-\d{6}\.db$/;

/** 备份目录跟随数据库位置（数据与代码分离）；云端模式没有路径 → null */
function backupDir() {
  return db.dbPath ? path.join(path.dirname(db.dbPath), 'backups') : null;
}

const pad = (n) => String(n).padStart(2, '0');
const dayStamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const fullStamp = (d) => `${dayStamp(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** 列出已有快照，按时间从新到旧。 */
function listSnapshots() {
  const dir = backupDir();
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .map((f) => {
      const file = path.join(dir, f);
      return { name: f, file, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 生成一份一致快照，返回文件名；同一秒内重复调用返回 null。 */
async function snapshot(now = new Date()) {
  const dir = backupDir();
  if (!dir || !db.dbPath) throw new Error('当前为云端存储模式，无本地数据库文件可备份');
  const file = path.join(dir, `work-${fullStamp(now)}.db`);
  if (fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  // SQLite 字符串字面量里反斜杠不是转义符，但统一用正斜杠更稳妥
  const target = file.replace(/\\/g, '/').replace(/'/g, "''");
  await db.exec(`VACUUM INTO '${target}'`);
  return path.basename(file);
}

/** 只保留最近 keep 份，返回被删除的文件名数组。 */
function prune(keep = KEEP) {
  const removed = [];
  for (const s of listSnapshots().slice(keep)) {
    fs.rmSync(s.file);
    removed.push(s.name);
  }
  return removed;
}

/**
 * 备份一次（快照 + 清理）。
 * @param {{skipIfToday?: boolean, now?: Date}} opts
 * @returns {Promise<{name?: string|null, removed?: string[], skipped?: boolean, disabled?: boolean, error?: string}>}
 */
async function runBackup({ skipIfToday = false, now = new Date() } = {}) {
  if (db.driver === 'remote') return { disabled: true };
  try {
    if (skipIfToday) {
      const today = dayStamp(now);
      if (listSnapshots().some((s) => s.name.startsWith(`work-${today}-`))) {
        return { skipped: true };
      }
    }
    const name = await snapshot(now);
    const removed = prune();
    if (name) {
      console.log(`  [备份] 已生成快照 ${name}${removed.length ? `，清理 ${removed.length} 份旧快照` : ''}`);
    }
    return { name, removed };
  } catch (e) {
    console.error(`  [备份] 失败：${e.message}`);
    return { error: e.message };
  }
}

/** 启动调度：立即备一份（当天已有则跳过）+ 每 24h 一份。云端模式自动跳过。 */
function startScheduler() {
  if (db.driver === 'remote') {
    console.log('  [备份] 云端存储模式：本地快照已停用（持久化由 Turso 负责，需要副本请用「导出」）');
    return null;
  }
  runBackup({ skipIfToday: true });
  const timer = setInterval(() => runBackup(), DAY_MS);
  if (typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出
  return timer;
}

module.exports = { runBackup, snapshot, prune, listSnapshots, startScheduler, backupDir, KEEP };

// 手动备份：node server/backup.js
if (require.main === module) {
  (async () => {
    await db.init();
    const r = await runBackup();
    if (r.disabled) console.log('当前为云端存储模式，无需本地备份。');
    else if (r.name) console.log(`备份完成 → ${path.join(backupDir(), r.name)}`);
    else if (r.error) process.exitCode = 1;
    await db.close();
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
