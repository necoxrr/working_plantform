/**
 * 把「本地 SQLite 文件」里的数据一次性迁移到云端 libSQL（Turso）。
 *
 * 用法：
 *   TURSO_DATABASE_URL=libsql://xxx.turso.io TURSO_AUTH_TOKEN=xxx \
 *     node server/migrate-to-cloud.js
 *
 * 可选项：
 *   DB_PATH=/path/to/work.db   指定要迁移的本地库（默认 ~/.work-manager/work.db）
 *   --dry-run                  只统计行数，不写任何数据
 *   --force                    云端已有数据时仍然继续（默认会中止，避免覆盖）
 *
 * 特点：
 *   · 全程一个事务：中途失败整体回滚，云上不会留下半个库
 *   · 使用 INSERT OR REPLACE：可以安全地重复执行（幂等）
 *   · 连 sqlite_sequence（自增计数器）一起搬，云端新记录 id 与本地延续
 *   · 迁移后自动核对各表行数，不一致会明确报警
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const TABLES = ['tasks', 'work_logs', 'reminders', 'daily_reports', 'report_entries', 'report_task_notes'];

/** 本地库路径：与 server/db.js 的规则保持一致 */
function localDbPath() {
  if (process.env.DB_PATH) return path.resolve(process.env.DB_PATH);
  const dir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(os.homedir(), '.work-manager');
  return path.join(dir, 'work.db');
}

(async () => {
  if (!process.env.TURSO_DATABASE_URL) {
    console.error('缺少 TURSO_DATABASE_URL（例如 libsql://xxx.turso.io）。');
    process.exit(1);
  }
  const src = localDbPath();
  if (!fs.existsSync(src)) {
    console.error(`找不到本地数据库：${src}`);
    process.exit(1);
  }

  // ---- 1. 读取本地库（只读，绝不改动你的原数据）----
  const { DatabaseSync } = require('node:sqlite');
  const local = new DatabaseSync(src, { readOnly: true });
  const dump = {};
  for (const t of TABLES) {
    dump[t] = local.prepare(`SELECT * FROM ${t}`).all();
  }
  // 顺带取一份自增计数器：本地历史上有过「已删除」的行，计数器比 max(id) 大；
  // 不一起搬过去的话，云端新建记录会复用曾经用过的 id（不影响正确性，但看着别扭）。
  let seqRows = [];
  try {
    seqRows = local.prepare(
      `SELECT name, seq FROM sqlite_sequence WHERE name IN (${TABLES.map(() => '?').join(',')})`
    ).all(...TABLES);
  } catch { /* 老库可能没有 sqlite_sequence，忽略 */ }
  local.close();

  console.log(`\n源库：${src}`);
  for (const t of TABLES) console.log(`  ${t.padEnd(20)} ${dump[t].length} 行`);

  if (DRY) {
    console.log('\n（--dry-run：只统计，未写入任何数据）');
    return;
  }

  // ---- 2. 连接云端（require('./db') 会因 TURSO_* 已设置而走远端驱动）----
  const cloud = require('./db');
  console.log(`\n目标：${process.env.TURSO_DATABASE_URL}`);
  await cloud.init(); // 建表 + 幂等迁移（表已存在则跳过）

  // ---- 3. 云端已有数据时先确认 ----
  const existing = (await cloud.get('SELECT COUNT(*) AS c FROM tasks')).c;
  if (existing > 0 && !FORCE) {
    console.error(`\n云端已有 ${existing} 条任务。为避免误覆盖，已中止。`);
    console.error('  确认要覆盖/合并，请加 --force 重跑。');
    await cloud.close();
    process.exit(1);
  }

  // ---- 4. 一个事务内灌入全部数据 ----
  const nn = (v) => (v === undefined ? null : v);
  await cloud.transaction(async (tx) => {
    // 先清空（--force 覆盖场景），再按依赖顺序插入
    for (const t of [...TABLES].reverse()) await tx.run(`DELETE FROM ${t}`);

    for (const t of dump.tasks) {
      await tx.run(
        `INSERT OR REPLACE INTO tasks (id, title, description, plan_start, plan_end, deadline,
          actual_start, actual_end, status, important, urgent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.id, t.title, t.description || '', nn(t.plan_start), nn(t.plan_end), nn(t.deadline),
          nn(t.actual_start), nn(t.actual_end), t.status || '未开始',
          t.important ? 1 : 0, t.urgent ? 1 : 0, t.created_at, t.updated_at]
      );
    }
    for (const l of dump.work_logs) {
      await tx.run(
        `INSERT OR REPLACE INTO work_logs (id, task_id, start_at, end_at, duration_ms, log_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [l.id, l.task_id, nn(l.start_at), nn(l.end_at), nn(l.duration_ms), nn(l.log_date), l.created_at]
      );
    }
    for (const r of dump.reminders) {
      await tx.run(
        `INSERT OR REPLACE INTO reminders (id, task_id, type, value, trigger_at, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.task_id, r.type, r.value, r.trigger_at, r.is_read || 0, r.created_at]
      );
    }
    for (const p of dump.daily_reports) {
      await tx.run(
        `INSERT OR REPLACE INTO daily_reports (id, report_date, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [p.id, p.report_date, p.content || '', p.created_at, p.updated_at]
      );
    }
    for (const e of dump.report_entries) {
      await tx.run(
        `INSERT OR REPLACE INTO report_entries (id, report_date, task_id, content, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [e.id, e.report_date, nn(e.task_id), e.content || '', e.sort_order || 0, e.created_at, e.updated_at]
      );
    }
    for (const n of dump.report_task_notes) {
      await tx.run(
        `INSERT OR REPLACE INTO report_task_notes (id, report_date, task_id, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [n.id, n.report_date, nn(n.task_id), n.note || '', n.created_at, n.updated_at]
      );
    }
  });

  // ---- 5. 同步自增计数器（可选步骤，失败不影响数据正确性）----
  if (seqRows.length) {
    try {
      await cloud.transaction(async (tx) => {
        for (const s of seqRows) {
          await tx.run('DELETE FROM sqlite_sequence WHERE name = ?', [s.name]);
          await tx.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [s.name, s.seq]);
        }
      });
      console.log('\n自增计数器已同步：' + seqRows.map((s) => `${s.name}=${s.seq}`).join('  '));
    } catch (e) {
      console.log('\n（自增计数器同步跳过：' + e.message + '）');
    }
  }

  // ---- 6. 核对行数 ----
  console.log('\n核对：');
  let bad = 0;
  for (const t of TABLES) {
    const c = (await cloud.get(`SELECT COUNT(*) AS c FROM ${t}`)).c;
    const same = c === dump[t].length;
    if (!same) bad += 1;
    console.log(`  ${t.padEnd(20)} 本地 ${dump[t].length} → 云端 ${c}  ${same ? '✔' : '✘ 不一致'}`);
  }

  await cloud.close();
  if (bad) {
    console.error('\n有表行数不一致，请检查后再使用。');
    process.exit(1);
  }
  console.log('\n✅ 迁移完成。云端现在是本地数据的完整副本（本地原库未做任何改动，可放心保留）。');
})().catch((e) => {
  console.error(`\n迁移失败：${e && e.message}`);
  if (e && e.stack) console.error(e.stack);
  process.exit(1);
});
