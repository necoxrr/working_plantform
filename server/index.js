/**
 * 个人工作管理平台 · 后端服务
 * 技术：Node.js + Express + 可插拔存储（默认 node:sqlite 本地文件；设 TURSO_DATABASE_URL 即切云端 libSQL）
 *
 * 接口总览：
 *   任务    GET/POST/PUT/DELETE  /api/tasks
 *   打卡    POST /api/tasks/:id/start（开始/继续）| /pause（暂停）| /stop（完成）
 *   提醒    GET/POST/DELETE      /api/reminders  |  GET /api/reminders/pending
 *   日报    GET /api/reports/:date  |  POST /api/reports  |  GET /api/reports/:date/summary
 *   备份    GET /api/export  |  POST /api/import
 */
const path = require('path');
const express = require('express');
const db = require('./db');
const {
  init: initDb, all, get, run, transaction, backfillLogDates,
} = db;
const { startScheduler } = require('./backup');
const { requireAuth, checkPassword, setAuthCookie, clearAuthCookie, isAuthed } = require('./auth');
const {
  toDateStr, nowISO, calcTriggerAt, decorateTask, deriveStatus,
} = require('./utils');

const app = express();
app.use(express.json({ limit: '5mb' }));

// 访问口令：在任何静态资源与接口之前拦截（登录页与登录接口放行）
app.use(requireAuth);

app.use(express.static(path.join(__dirname, '..', 'public')));

/* ======================= 耗时聚合辅助 ======================= */

/**
 * 计算每个任务的累计耗时（所有打卡段之和）。
 * 进行中的会话（end_at 为空）用 now - start_at 计入，使进行中任务也有累计值。
 * 任务的状态检查保证每个任务至多一条未结束记录。
 * @returns {Promise<Map<number, number>>} task_id -> 累计毫秒
 */
async function totalMsMap() {
  const rows = await all(
    `SELECT task_id,
            COALESCE(SUM(duration_ms), 0) AS closed_ms,
            MAX(CASE WHEN end_at IS NULL THEN start_at END) AS open_start
     FROM work_logs
     GROUP BY task_id`
  );
  const map = new Map();
  const now = Date.now();
  for (const r of rows) {
    let total = r.closed_ms || 0;
    const openStart = r.open_start ? new Date(r.open_start).getTime() : NaN;
    if (!isNaN(openStart)) total += now - openStart;
    map.set(r.task_id, total);
  }
  return map;
}

/** 单个任务的累计耗时（毫秒） */
async function totalMsOf(id) {
  const r = await get(
    `SELECT COALESCE(SUM(duration_ms), 0) AS closed_ms,
            MAX(CASE WHEN end_at IS NULL THEN start_at END) AS open_start
     FROM work_logs
     WHERE task_id = ?`,
    id
  ) || {};
  let total = r.closed_ms || 0;
  const openStart = r.open_start ? new Date(r.open_start).getTime() : NaN;
  if (!isNaN(openStart)) total += Date.now() - openStart;
  return total;
}

/**
 * 统计每个任务在日报里被记录过多少条（用于任务卡片决定是否显示「日报记录」入口）。
 * @returns {Promise<Map<number, number>>} task_id -> 条目数
 */
async function reportCountMap() {
  const rows = await all(
    `SELECT task_id, COUNT(*) AS cnt
     FROM report_entries
     WHERE task_id IS NOT NULL
     GROUP BY task_id`
  );
  const map = new Map();
  for (const r of rows) map.set(r.task_id, r.cnt);
  return map;
}

/**
 * 每个任务有几段计时记录（用于任务卡片决定是否显示「计时记录」入口）。
 * @returns {Promise<Map<number, number>>} task_id -> 段数
 */
async function logCountMap() {
  const rows = await all('SELECT task_id, COUNT(*) AS cnt FROM work_logs GROUP BY task_id');
  const map = new Map();
  for (const r of rows) map.set(r.task_id, r.cnt);
  return map;
}

/**
 * 每个任务「最后一次有进展」的时刻：取打卡（结束优先、否则开始）与日报条目更新时间的最大值。
 * 用于「停滞提醒」——很久没有任何动作的任务主动浮出来。
 * @returns {Promise<Map<number, string>>} task_id -> ISO 时间
 */
async function lastActivityMap() {
  const map = new Map();
  const logs = await all(
    `SELECT task_id, MAX(COALESCE(end_at, start_at)) AS ts
     FROM work_logs
     WHERE COALESCE(end_at, start_at) IS NOT NULL
     GROUP BY task_id`
  );
  for (const r of logs) if (r.ts) map.set(r.task_id, r.ts);
  const entries = await all(
    `SELECT task_id, MAX(updated_at) AS ts
     FROM report_entries
     WHERE task_id IS NOT NULL
     GROUP BY task_id`
  );
  for (const r of entries) {
    if (!r.ts) continue;
    const prev = map.get(r.task_id);
    if (!prev || r.ts > prev) map.set(r.task_id, r.ts); // 同为 ISO（UTC），字符串比较即可
  }
  return map;
}

/**
 * 每个任务的计时段信息：
 *  - openStart：当前「未结束」段的开始时间（存在即表示正在计时）
 *  - lastSegMs：最近一段已结束段的时长（用于展示「本段耗时」）
 * 一个任务可以有多个段（开始→暂停→继续→暂停…），累计耗时就是各段之和。
 * @returns {Promise<Map<number, {openStart:string|null, lastSegMs:number|null}>>}
 */
async function segInfoMap() {
  const rows = await all('SELECT task_id, start_at, end_at, duration_ms FROM work_logs ORDER BY id');
  const map = new Map();
  for (const r of rows) {
    const cur = map.get(r.task_id) || { openStart: null, lastSegMs: null };
    if (r.end_at == null) cur.openStart = r.start_at;        // 有未结束段 → 正在计时
    else cur.lastSegMs = r.duration_ms;                      // 按 id 升序，最终留下最后一段
    map.set(r.task_id, cur);
  }
  return map;
}

/** 单个任务的计算视图（供各写接口返回统一的完整对象） */
async function taskCalc(id) {
  const [t, total, segs] = await Promise.all([get('SELECT * FROM tasks WHERE id = ?', id), totalMsOf(id), segInfoMap()]);
  return decorateTask(t, total, segs.get(id));
}

/* ============================ 任务 ============================ */

// 任务列表
app.get('/api/tasks', async (req, res) => {
  const rows = await all('SELECT * FROM tasks ORDER BY id DESC');
  const [totals, counts, activity, segs, logCounts] = await Promise.all([
    totalMsMap(), reportCountMap(), lastActivityMap(), segInfoMap(), logCountMap(),
  ]);
  res.json(rows.map((t) => ({
    ...decorateTask(t, totals.get(t.id) ?? 0, segs.get(t.id)),
    report_entry_count: counts.get(t.id) ?? 0,
    log_count: logCounts.get(t.id) ?? 0,
    last_activity_at: activity.get(t.id) || null,
  })));
});

// 某任务在日报中记录过的内容（按日期倒序，附当天序号）
app.get('/api/tasks/:id/report-entries', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: '无效的任务 id' });
  const entries = await all(
    `SELECT e.id, e.report_date, e.content, e.sort_order
     FROM report_entries e
     WHERE e.task_id = ?
     ORDER BY e.report_date DESC, e.sort_order, e.id`,
    id
  );
  res.json({ task_id: id, entries });
});

// 单个任务详情（含打卡记录与提醒点）
app.get('/api/tasks/:id', async (req, res) => {
  const task = await get('SELECT * FROM tasks WHERE id = ?', Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const [logs, reminders, calc] = await Promise.all([
    all('SELECT * FROM work_logs WHERE task_id = ? ORDER BY id DESC', task.id),
    all('SELECT * FROM reminders WHERE task_id = ? ORDER BY trigger_at', task.id),
    taskCalc(task.id),
  ]);
  res.json({ ...calc, logs, reminders });
});

// 新建任务
app.post('/api/tasks', async (req, res) => {
  const {
    title, description = '', plan_start = null, plan_end = null,
    deadline = null, reminders = [], important = 0, urgent = 0,
  } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '任务标题不能为空' });
  }
  const now = nowISO();
  const info = await run(
    `INSERT INTO tasks (title, description, plan_start, plan_end, deadline, status, important, urgent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '未开始', ?, ?, ?, ?)`,
    String(title).trim(), description, plan_start, plan_end, deadline,
    important ? 1 : 0, urgent ? 1 : 0, now, now
  );
  const taskId = Number(info.lastInsertRowid);

  // 处理提醒点
  try {
    await addReminders(taskId, reminders, deadline);
  } catch (e) {
    // 提醒失败不影响任务创建，但要告知
    return res.status(400).json({ error: `任务已建，但提醒设置有误：${e.message}` });
  }

  res.json(await taskCalc(taskId));
});

// 更新任务
app.put('/api/tasks/:id', async (req, res) => {
  const id = Number(req.params.id);
  const task = await get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const {
    title = task.title, description = task.description,
    plan_start = task.plan_start, plan_end = task.plan_end,
    deadline = task.deadline, status = task.status,
    important = task.important, urgent = task.urgent,
    reminders, // 若传入则整体替换
  } = req.body || {};

  const now = nowISO();
  await run(
    `UPDATE tasks SET title=?, description=?, plan_start=?, plan_end=?, deadline=?, status=?,
       important=?, urgent=?, updated_at=?
     WHERE id=?`,
    title, description, plan_start, plan_end, deadline, status,
    important ? 1 : 0, urgent ? 1 : 0, now, id
  );

  // 只要状态不再等于「进行中」（改成「未开始」或「已完成」），就关掉仍在计时的段。
  // 否则会出现「状态写着未开始、秒表却还在跳」的自相矛盾。
  if (status !== '进行中') {
    const log = await openLogOf(id);
    if (log) {
      const duration = new Date(now).getTime() - new Date(log.start_at).getTime();
      await run(`UPDATE work_logs SET end_at=?, duration_ms=? WHERE id=?`, now, duration, log.id);
    }
  }

  if (Array.isArray(reminders)) {
    // 提醒点是「整体替换」，但已经点过「标记已读」的提醒，不该因为改个标题就重新弹出来。
    // 做法：先算出新旧提醒的 (type,value,trigger_at) 指纹：
    //   · 指纹相同 → 原样保留老记录（is_read 不丢）
    //   · 指纹变了（如改了截止时间，相对提醒的触发时刻跟着变）→ 才当新提醒重算
    // 指纹里的时间只取到「分钟」：界面的时间控件精度就是分钟，
    // 若截止时间带秒/毫秒（导入或接口写入的），往返一趟会丢秒，逐字节比较就会误判成
    // 「提醒变了」→ 已读状态被重置。差 1 分钟以内绝不可能是用户的真实改动，按没变处理。
    let wanted;
    try {
      wanted = normalizeReminders(reminders, deadline);
    } catch (e) {
      return res.status(400).json({ error: `任务已更新，但提醒设置有误：${e.message}` });
    }
    const fp = (type, value, triggerAt) => `${type}|${value}|${minuteKey(triggerAt)}`;
    const olds = await all('SELECT * FROM reminders WHERE task_id = ?', id);
    const oldByKey = new Map(olds.map((r) => [fp(r.type, r.value, r.trigger_at), r]));
    const keep = new Set();
    const created = nowISO();
    await transaction(async (tx) => {
      for (const w of wanted) {
        const prev = oldByKey.get(fp(w.type, w.value, w.trigger_at));
        if (prev) { keep.add(prev.id); continue; } // 原样保留，已读状态不丢
        await tx.run(
          `INSERT INTO reminders (task_id, type, value, trigger_at, is_read, created_at)
           VALUES (?, ?, ?, ?, 0, ?)`,
          [id, w.type, w.value, w.trigger_at, created]
        );
      }
      for (const o of olds) if (!keep.has(o.id)) await tx.run('DELETE FROM reminders WHERE id = ?', [o.id]);
    });
  }

  res.json(await taskCalc(id));
});

// 删除任务
app.delete('/api/tasks/:id', async (req, res) => {
  const id = Number(req.params.id);
  await run('DELETE FROM tasks WHERE id = ?', id);
  res.json({ ok: true });
});

/* ============================ 打卡 ============================ */

/**
 * 计时模型：一个任务可以有多段打卡（work_logs 每段一行）。
 *  - 开始 / 继续：开一段（status → 进行中）
 *  - 暂停：关掉当前段（记下时长），status 保持「进行中」——这就是与「完成」分离的关键
 *  - 完成：关掉当前段（若有）并置 status = 已完成
 * 累计耗时 = 各段之和，暂停期间不计入。
 */

// 取当前未结束的打卡段（一个任务至多一条）
function openLogOf(id) {
  return get(
    `SELECT * FROM work_logs WHERE task_id=? AND end_at IS NULL ORDER BY id DESC LIMIT 1`, id
  );
}

// 开始 / 继续计时：只要当前没有未结束的段，就开一段新的
app.post('/api/tasks/:id/start', async (req, res) => {
  const id = Number(req.params.id);
  const task = await get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (await openLogOf(id)) {
    return res.status(400).json({ error: '该任务正在计时中' });
  }
  const now = nowISO();
  const today = toDateStr(new Date());
  await transaction(async (tx) => {
    await tx.run(
      `UPDATE tasks SET actual_start=?, actual_end=NULL, status='进行中', updated_at=? WHERE id=?`,
      [now, now, id]
    );
    await tx.run(
      `INSERT INTO work_logs (task_id, start_at, log_date, created_at) VALUES (?, ?, ?, ?)`,
      [id, now, today, now]
    );
  });
  res.json(await taskCalc(id));
});

// 暂停计时：关掉当前段，任务状态保持「进行中」，可稍后「继续」
app.post('/api/tasks/:id/pause', async (req, res) => {
  const id = Number(req.params.id);
  const task = await get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const log = await openLogOf(id);
  if (!log) return res.status(400).json({ error: '该任务当前没有在计时' });
  const now = nowISO();
  const duration = new Date(now).getTime() - new Date(log.start_at).getTime();
  // 只回填结束时间与耗时，不改 log_date：保持为「开始日」，跨天任务在开始日与结束日都能被日报命中。
  await run(`UPDATE work_logs SET end_at=?, duration_ms=? WHERE id=?`, now, duration, log.id);
  await run(`UPDATE tasks SET updated_at=? WHERE id=?`, now, id); // status 保持进行中
  res.json(await taskCalc(id));
});

// 完成：关掉当前段（若有）并置为已完成
app.post('/api/tasks/:id/stop', async (req, res) => {
  const id = Number(req.params.id);
  const task = await get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const now = nowISO();
  const log = await openLogOf(id);
  if (log) {
    const duration = new Date(now).getTime() - new Date(log.start_at).getTime();
    await run(`UPDATE work_logs SET end_at=?, duration_ms=? WHERE id=?`, now, duration, log.id);
  }
  // 注意：没有未结束段时（未开始 或 已暂停）不再补记一段，
  // 否则会把「暂停」那段时间重复计入耗时。
  await run(
    `UPDATE tasks SET actual_end=?, status='已完成', updated_at=? WHERE id=?`,
    now, now, id
  );
  res.json(await taskCalc(id));
});

/* ---------- 计时记录的删除与状态重算 ---------- */

/**
 * 依据「剩余的计时段」把任务重算到自洽状态。删段之后调用：
 *  - 一段不剩        → 「未开始」（即回到"从没打过卡"的状态）
 *  - 还有未结束段    → 「进行中」（正在计时）
 *  - 只剩已结束的段  → 原本已完成则保持「已完成」，否则「进行中」（已暂停）
 */
async function recomputeTaskFromLogs(taskId) {
  const task = await get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task) return;
  const logs = await all('SELECT * FROM work_logs WHERE task_id = ? ORDER BY id', taskId);
  const open = logs.find((l) => l.end_at == null) || null;
  let status = task.status;
  let actualStart = null;
  let actualEnd = null;
  if (logs.length === 0) {
    status = '未开始';
  } else if (open) {
    status = '进行中';
    actualStart = open.start_at;
  } else {
    status = task.status === '已完成' ? '已完成' : '进行中';
    actualEnd = logs[logs.length - 1].end_at || null;
  }
  await run(
    `UPDATE tasks SET status=?, actual_start=?, actual_end=?, updated_at=? WHERE id=?`,
    status, actualStart, actualEnd, nowISO(), taskId
  );
}

// 删除某一段计时记录（误点打卡后撤销）
app.delete('/api/logs/:id', async (req, res) => {
  const log = await get('SELECT * FROM work_logs WHERE id = ?', Number(req.params.id));
  if (!log) return res.status(404).json({ error: '计时记录不存在' });
  await run('DELETE FROM work_logs WHERE id = ?', log.id);
  await recomputeTaskFromLogs(log.task_id);
  res.json({ ok: true, task: await taskCalc(log.task_id) });
});

// 清空某任务的全部计时记录，状态回到「未开始」
app.delete('/api/tasks/:id/logs', async (req, res) => {
  const id = Number(req.params.id);
  const task = await get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  await run('DELETE FROM work_logs WHERE task_id = ?', id);
  await recomputeTaskFromLogs(id);
  res.json({ ok: true, task: await taskCalc(id) });
});

/* ============================ 提醒 ============================ */

// 某任务的提醒列表
app.get('/api/tasks/:id/reminders', async (req, res) => {
  res.json(await all('SELECT * FROM reminders WHERE task_id = ? ORDER BY trigger_at', Number(req.params.id)));
});

/**
 * 未读且已到时间的提醒（站内补推，列表形式）。
 *
 * 只推送「确实该被打扰」的任务，两道闸门：
 *  1. 任务已完成 → 不再提醒（事情都做完了，再报截止没有意义）；
 *  2. 任务从未开工 → 不提醒（本就没开始，谈不上「快到期了」）。
 *     「已开工」以实际动作为准：点过「开始」(actual_start 非空)／打过卡(有 work_logs)／状态为「进行中」。
 */
app.get('/api/reminders/pending', async (req, res) => {
  const now = nowISO();
  const rows = await all(
    `SELECT r.*, t.title AS task_title, t.deadline AS task_deadline,
            t.status AS task_status, t.actual_start AS task_actual_start
     FROM reminders r JOIN tasks t ON r.task_id = t.id
     WHERE r.is_read = 0
       AND r.trigger_at <= ?
       AND t.status <> '已完成'
       AND (
         t.status = '进行中'
         OR t.actual_start IS NOT NULL
         OR EXISTS (SELECT 1 FROM work_logs w WHERE w.task_id = t.id)
       )
     ORDER BY r.trigger_at DESC`,
    now
  );
  res.json(rows);
});

// 标记提醒已读
app.post('/api/reminders/:id/read', async (req, res) => {
  await run('UPDATE reminders SET is_read = 1 WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// 为任务新增提醒
app.post('/api/tasks/:id/reminders', async (req, res) => {
  const id = Number(req.params.id);
  const task = await get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const { type, value } = req.body || {};
  try {
    const triggerAt = calcTriggerAt(type, value, task.deadline);
    await run(
      `INSERT INTO reminders (task_id, type, value, trigger_at, is_read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      id, type, value, triggerAt, nowISO()
    );
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(await all('SELECT * FROM reminders WHERE task_id = ? ORDER BY trigger_at', id));
});

// 删除提醒
app.delete('/api/reminders/:id', async (req, res) => {
  await run('DELETE FROM reminders WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

/**
 * 把 ISO 时间截断到「分钟」，用于提醒指纹比较。
 * 解析不了的原样返回（宁可当它变了，也不能把不同的东西判成相同）。
 */
function minuteKey(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:mm'
}

/** 把「提醒设置」规范化成待写入的行（含算好的触发时刻）；任一条非法即抛错 */
function normalizeReminders(list, deadline) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (!r || !r.type || r.value === undefined) continue;
    out.push({
      type: r.type,
      value: String(r.value),
      trigger_at: calcTriggerAt(r.type, r.value, deadline),
    });
  }
  return out;
}

/** 批量写入提醒点（新建任务时用） */
async function addReminders(taskId, list, deadline) {
  const rows = normalizeReminders(list, deadline);
  const created = nowISO();
  await transaction(async (tx) => {
    for (const r of rows) {
      await tx.run(
        `INSERT INTO reminders (task_id, type, value, trigger_at, is_read, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [taskId, r.type, r.value, r.trigger_at, created]
      );
    }
  });
}

/* ============================ 日报 ============================ */

/** 读取某天的工作条目（带任务标题） */
function getReportEntries(date) {
  return all(
    `SELECT e.id, e.task_id, e.content, e.sort_order, t.title AS task_title
     FROM report_entries e
     LEFT JOIN tasks t ON e.task_id = t.id
     WHERE e.report_date = ?
     ORDER BY e.sort_order, e.id`,
    date
  );
}

/** 某天按任务的补充说明：同一 (日期, 任务) 若有多行则换行合并 */
async function getReportNotes(date) {
  return groupNotes(await all(
    'SELECT report_date, task_id, note FROM report_task_notes WHERE report_date = ? ORDER BY id',
    date
  )).get(date) || [];
}

/** 把 report_task_notes 的原始行按「日期 → 任务」归组（避免 N+1） */
function groupNotes(rows) {
  const acc = new Map(); // date -> Map(key -> text)
  for (const r of rows) {
    const text = (r.note || '').trim();
    if (!text) continue;
    const key = noteKey(r.task_id);
    if (!acc.has(r.report_date)) acc.set(r.report_date, new Map());
    const m = acc.get(r.report_date);
    m.set(key, m.has(key) ? `${m.get(key)}\n${text}` : text);
  }
  const out = new Map();
  for (const [date, m] of acc) {
    out.set(date, [...m.entries()].map(([k, note]) => ({
      task_id: k === 'free' ? null : Number(k),
      note,
    })));
  }
  return out;
}

/** 任务分组用的键：空任务统一算「其他小事」 */
function noteKey(taskId) {
  return (taskId === null || taskId === undefined || taskId === '')
    ? 'free' : String(taskId);
}

/**
 * 保存某天日报（工作条目 + 按任务的补充说明）。
 * mode='replace'（默认）整体替换该天的工作条目；
 * mode='append' 追加到该天已有条目之后（排序顺延）。
 * notes 传数组时按「替换 / 追加」处理该天的任务说明；传 null 表示**本次不碰任务说明**
 * （日报页只写平铺条目与整天补充说明，日报历史里的任务说明不能被它清掉）。
 * 空内容条目 / 空说明会被跳过；task_id 不存在时按「其他小事」处理。
 * 全程在一个事务内，中途失败不会留下「删一半、插一半」的残缺日报。
 * @returns {Promise<number>} 写入的条目数
 */
async function saveReport(date, { entries = [], notes = null }, mode = 'replace') {
  const now = nowISO();
  const append = mode === 'append';
  const hasNotes = Array.isArray(notes); // 是否要动「按任务的补充说明」

  return transaction(async (tx) => {
    // 任务 id 合法性：一次性查完（避免逐条往返），不存在的按「其他小事」处理
    const wanted = new Set();
    const collect = (v) => {
      if (v === null || v === undefined || v === '') return;
      const n = Number(v);
      if (Number.isFinite(n)) wanted.add(n);
    };
    for (const e of entries) collect(e && e.task_id);
    for (const n of (hasNotes ? notes : [])) collect(n && n.task_id);
    const valid = new Set();
    if (wanted.size) {
      const ids = [...wanted];
      const rows = await tx.all(
        `SELECT id FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`, ids
      );
      for (const r of rows) valid.add(r.id);
    }
    const taskIdOf = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) && valid.has(n) ? n : null;
    };

    let order = 0;
    if (append) {
      const mx = await tx.get('SELECT MAX(sort_order) AS m FROM report_entries WHERE report_date = ?', [date]);
      order = (mx && mx.m != null) ? mx.m + 1 : 0;
    } else {
      await tx.run('DELETE FROM report_entries WHERE report_date = ?', [date]);
      if (hasNotes) await tx.run('DELETE FROM report_task_notes WHERE report_date = ?', [date]);
    }

    let added = 0;
    for (const e of entries) {
      const content = (e && e.content != null) ? String(e.content) : '';
      if (!content.trim()) continue; // 跳过空条目
      await tx.run(
        `INSERT INTO report_entries (report_date, task_id, content, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [date, taskIdOf(e && e.task_id), content, order, now, now]
      );
      order += 1;
      added += 1;
    }

    for (const n of (hasNotes ? notes : [])) {
      const text = (n && n.note != null) ? String(n.note).trim() : '';
      if (!text) continue; // 跳过空说明
      const tid = taskIdOf(n && n.task_id);
      // 追加模式下先看该任务当天是否已有说明，有则换行合并
      const exist = append
        ? await tx.get(
          'SELECT id, note FROM report_task_notes WHERE report_date = ? AND '
          + (tid === null ? 'task_id IS NULL' : 'task_id = ?'),
          tid === null ? [date] : [date, tid]
        )
        : null;
      if (exist) {
        const merged = (exist.note || '').trim();
        await tx.run('UPDATE report_task_notes SET note=?, updated_at=? WHERE id=?',
          [merged ? `${merged}\n${text}` : text, now, exist.id]);
      } else {
        await tx.run(
          `INSERT INTO report_task_notes (report_date, task_id, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [date, tid, text, now, now]
        );
      }
    }
    return added;
  });
}

// 日报历史列表：按月/日倒序返回「已保存过」的日报（有工作条目或补充说明）
app.get('/api/reports', async (req, res) => {
  const rows = await all(
    `SELECT r.report_date, r.content, r.updated_at
     FROM daily_reports r
     WHERE TRIM(COALESCE(r.content, '')) <> ''
        OR EXISTS (SELECT 1 FROM report_entries e WHERE e.report_date = r.report_date)
        OR EXISTS (SELECT 1 FROM report_task_notes n WHERE n.report_date = r.report_date)
     ORDER BY r.report_date DESC`
  );
  // 一次性取出所有条目，按日期归组，避免 N+1
  const byDate = new Map();
  const entries = await all(
    `SELECT e.id, e.report_date, e.task_id, e.content, e.sort_order, t.title AS task_title
     FROM report_entries e
     LEFT JOIN tasks t ON e.task_id = t.id
     ORDER BY e.report_date DESC, e.sort_order, e.id`
  );
  for (const e of entries) {
    if (!byDate.has(e.report_date)) byDate.set(e.report_date, []);
    byDate.get(e.report_date).push({
      id: e.id, task_id: e.task_id, content: e.content,
      sort_order: e.sort_order, task_title: e.task_title,
    });
  }
  // 一次性取出所有任务说明，同样按日期归组
  const notesByDate = groupNotes(await all(
    'SELECT report_date, task_id, note FROM report_task_notes ORDER BY id'
  ));
  res.json({
    reports: rows.map((r) => {
      const list = byDate.get(r.report_date) || [];
      return {
        report_date: r.report_date,
        updated_at: r.updated_at,
        content: r.content || '',            // 整天补充说明（日报页写）
        entries: list,
        notes: notesByDate.get(r.report_date) || [], // 按任务的补充说明（日报历史写）
      };
    }),
  });
});

// 某天日报（工作条目 + 整天补充说明 + 按任务的补充说明）
app.get('/api/reports/:date', async (req, res) => {
  const date = req.params.date;
  const [report, entries, notes] = await Promise.all([
    get('SELECT * FROM daily_reports WHERE report_date = ?', date),
    getReportEntries(date),
    getReportNotes(date),
  ]);
  res.json({
    report_date: date,
    updated_at: report ? report.updated_at : null,
    content: (report && report.content) || '',
    entries,
    notes,
  });
});

// 保存某天日报（工作条目 + 整天补充说明 + 按任务的补充说明，支持修改历史日期）
// append=true 时「追加」：条目与补充说明都接在该天已有内容之后，不覆盖（日报页用，永远追加）
// 不传 notes（非数组）表示本次不改动「按任务的补充说明」——日报页不碰日报历史里写的内容
// 不传 content（非字符串）表示本次不改动「整天补充说明」——日报历史页不识别这个字段
// purge=true 表示「整条删除」：用户在日报历史里把条目与任务说明清空并确认后，删掉这天的全部日报记录
app.post('/api/reports', async (req, res) => {
  const body = req.body || {};
  const { date, entries, notes, append = false, purge = false } = body;
  if (!date) return res.status(400).json({ error: '缺少日期' });
  const now = nowISO();
  const hasContent = typeof body.content === 'string'; // 传了整天补充说明才改动它
  const hasNotes = Array.isArray(notes); // 传了 notes 才处理按任务的补充说明
  // 安全闸：不带 notes 又要求替换 = 日报页那种"整体盖掉当天"的调用。
  // 这种调用一旦携带空内容就会把整天已保存的条目清掉，所以一律拒绝。
  if (!hasNotes && !append) {
    return res.status(400).json({
      error: '日报仅支持追加保存；要修改已保存的内容请到「日报历史」',
    });
  }

  if (purge) {
    // 清空确认后：条目、任务说明、整天补充说明一并删除，这天从日报历史里消失
    try {
      await transaction(async (tx) => {
        await tx.run('DELETE FROM report_entries WHERE report_date = ?', [date]);
        await tx.run('DELETE FROM report_task_notes WHERE report_date = ?', [date]);
        await tx.run('DELETE FROM daily_reports WHERE report_date = ?', [date]);
      });
    } catch (e) {
      return res.status(400).json({ error: `删除失败：${e.message}` });
    }
    return res.json({
      report_date: date, deleted: true, updated_at: null,
      content: '', entries: [], notes: [],
    });
  }

  const exist = await get('SELECT * FROM daily_reports WHERE report_date = ?', date);

  // 整天补充说明：未显式传入时保持原值（历史页保存只改条目/任务说明）
  let nextContent = hasContent ? body.content : ((exist && exist.content) || '');
  if (append && exist) {
    // 追加模式下整天补充说明换行拼接，避免覆盖已保存的部分
    const oldText = (exist.content || '').trim();
    const newText = (body.content || '').trim();
    nextContent = oldText && newText ? `${oldText}\n${newText}` : (newText || oldText);
  }
  if (exist) {
    await run('UPDATE daily_reports SET content=?, updated_at=? WHERE report_date=?', nextContent, now, date);
  } else {
    await run(
      'INSERT INTO daily_reports (report_date, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
      date, nextContent, now, now
    );
  }

  if (Array.isArray(entries) || hasNotes) {
    try {
      await saveReport(date, { entries: entries || [], notes: hasNotes ? notes : null }, append ? 'append' : 'replace');
    } catch (e) {
      return res.status(400).json({ error: `保存失败：${e.message}` });
    }
  }
  const [saved, outEntries, outNotes] = await Promise.all([
    get('SELECT * FROM daily_reports WHERE report_date = ?', date),
    getReportEntries(date),
    getReportNotes(date),
  ]);
  res.json({
    report_date: date,
    updated_at: saved ? saved.updated_at : now,
    content: (saved && saved.content) || '',
    entries: outEntries,
    notes: outNotes,
    appended: !!append,
  });
});

// 某天任务自动汇总（侧栏数据）
// 规则：按任务"实际活动日期"归属；跨天任务在每个有活动的日期都出现（整段展示）
app.get('/api/reports/:date/summary', async (req, res) => {
  const date = req.params.date; // 'YYYY-MM-DD'（本地日期）
  // 计算本地当天的零点与次日零点，转成 UTC ISO 便于与库中时间字符串比较
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0);      // 本地当天零点
  const dayEnd = new Date(y, m - 1, d + 1, 0, 0, 0, 0);    // 本地次日零点（d+1 自动进位）
  const startISO = dayStart.toISOString();
  const endISO = dayEnd.toISOString();

  // 与该日区间 [dayStart, dayEnd) 有重叠的打卡记录（跨天任务会在覆盖到的每一天都命中）
  const logs = await all(
    `SELECT w.*, t.title, t.description, t.deadline, t.status, t.actual_start, t.actual_end,
            t.plan_start, t.plan_end
     FROM work_logs w JOIN tasks t ON w.task_id = t.id
     WHERE (w.start_at IS NOT NULL AND w.start_at < ? AND (w.end_at IS NULL OR w.end_at > ?))
        OR (w.start_at IS NULL AND w.log_date = ?)
     ORDER BY w.id DESC`,
    endISO, startISO, date
  );
  // 按任务聚合：一个任务当天可能有多段打卡（开始→暂停→继续…），
  // 合并为一条，时长相加，时间区间取最早开始~最晚结束。
  const now = Date.now();
  const byTask = new Map();
  for (const l of logs) {
    // 进行中的会话以「报告日」作为隐式终点，判断是否跨天
    const startDay = l.start_at ? toDateStr(new Date(l.start_at)) : null;
    const endDay = l.end_at ? toDateStr(new Date(l.end_at)) : date;
    const cross = !!(startDay && startDay !== endDay);
    const ms = l.duration_ms != null
      ? l.duration_ms
      : (l.start_at ? now - new Date(l.start_at).getTime() : 0);

    const cur = byTask.get(l.task_id);
    if (!cur) {
      byTask.set(l.task_id, {
        task_id: l.task_id,
        title: l.title,
        description: l.description,
        log_start: l.start_at,
        log_end: l.end_at,
        duration_ms: ms,
        display_status: deriveStatus({ status: l.status, deadline: l.deadline }),
        is_cross_day: cross,
      });
    } else {
      cur.duration_ms += ms;
      cur.is_cross_day = cur.is_cross_day || cross;
      if (l.start_at && (!cur.log_start || l.start_at < cur.log_start)) cur.log_start = l.start_at;
      if (l.end_at && (!cur.log_end || l.end_at > cur.log_end)) cur.log_end = l.end_at;
      if (!l.end_at) cur.log_end = null; // 有段仍在进行中
    }
  }
  res.json({ date, items: [...byTask.values()] });
});

/* ============================ 周复盘 ============================ */

// 周复盘：给定任意一天（默认今天），汇总「所在自然周（周一~周日）」的投入与完成情况
app.get('/api/weekly', async (req, res) => {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date : toDateStr(new Date());
  const [y, m, d] = anchor.split('-').map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // 0 = 周一
  const dayAt = (offset) => new Date(y, m - 1, d - dow + offset); // 本周第 offset 天的本地零点
  const winStart = dayAt(0).getTime();
  const winEnd = dayAt(7).getTime();
  const startDate = toDateStr(dayAt(0));
  const endDate = toDateStr(dayAt(6));
  const startISO = dayAt(0).toISOString();
  const endISO = dayAt(7).toISOString();

  // 与该周有重叠的打卡段（含进行中的会话）
  const logs = await all(
    `SELECT w.task_id, w.start_at, w.end_at, w.duration_ms, w.log_date,
            t.title, t.status, t.deadline
     FROM work_logs w JOIN tasks t ON w.task_id = t.id
     WHERE (w.start_at IS NOT NULL AND w.start_at < ? AND (w.end_at IS NULL OR w.end_at > ?))
        OR (w.start_at IS NULL AND w.log_date >= ? AND w.log_date <= ?)`,
    endISO, startISO, startDate, endDate
  );

  const now = Date.now();
  const dayMs = new Array(7).fill(0);
  const perTask = new Map(); // task_id -> 统计
  for (const l of logs) {
    const s = l.start_at ? new Date(l.start_at).getTime() : null;
    const e = l.end_at ? new Date(l.end_at).getTime() : (s != null ? now : null);
    let ms = 0;
    if (s != null && e != null) {
      const from = Math.max(s, winStart);
      const to = Math.min(e, winEnd);
      if (to > from) ms = to - from;
      for (let i = 0; i < 7; i++) {
        const a = Math.max(s, dayAt(i).getTime());
        const b = Math.min(e, dayAt(i + 1).getTime());
        if (b > a) dayMs[i] += b - a;
      }
    } else if (l.duration_ms) {
      ms = l.duration_ms;
    }
    if (!perTask.has(l.task_id)) {
      perTask.set(l.task_id, {
        task_id: l.task_id, title: l.title, status: l.status, deadline: l.deadline,
        display_status: deriveStatus({ status: l.status, deadline: l.deadline }),
        ms: 0, sessions: 0,
      });
    }
    const item = perTask.get(l.task_id);
    item.ms += ms;
    item.sessions += 1;
  }

  const days = dayMs.map((ms, i) => ({ date: toDateStr(dayAt(i)), ms }));

  // 本周完成（按实际结束时间落在本周）
  const completed = await all(
    `SELECT id, title, actual_end FROM tasks
     WHERE actual_end >= ? AND actual_end < ?
     ORDER BY actual_end`,
    startISO, endISO
  );

  const rc = await get(
    `SELECT COUNT(*) AS n FROM report_entries WHERE report_date >= ? AND report_date <= ?`,
    startDate, endDate
  );

  res.json({
    start_date: startDate,
    end_date: endDate,
    total_ms: dayMs.reduce((a, b) => a + b, 0),
    tasks: [...perTask.values()].sort((a, b) => b.ms - a.ms),
    days,
    completed,
    report_entry_count: (rc && rc.n) || 0,
  });
});

/* ============================ 备份 ============================ */

// 一键导出全部数据
app.get('/api/export', async (req, res) => {
  const [tasks, work_logs, reminders, daily_reports, report_entries, report_task_notes] = await Promise.all([
    all('SELECT * FROM tasks'),
    all('SELECT * FROM work_logs'),
    all('SELECT * FROM reminders'),
    all('SELECT * FROM daily_reports'),
    all('SELECT * FROM report_entries'),
    all('SELECT * FROM report_task_notes'),
  ]);
  const data = {
    exported_at: nowISO(),
    version: 1,
    tasks, work_logs, reminders, daily_reports, report_entries, report_task_notes,
  };
  res.setHeader('Content-Disposition', `attachment; filename="work-manager-${toDateStr(new Date())}.json"`);
  res.json(data);
});

// 一键导入（覆盖式）
app.post('/api/import', async (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.tasks)) {
    return res.status(400).json({ error: '导入文件格式不正确' });
  }
  try {
    // 整个导入包在一个事务里：中途任何一步失败都回滚，绝不留「删一半、插一半」的残缺库
    await transaction(async (tx) => {
      await tx.run('DELETE FROM work_logs');
      await tx.run('DELETE FROM reminders');
      await tx.run('DELETE FROM report_task_notes');
      await tx.run('DELETE FROM report_entries');
      await tx.run('DELETE FROM daily_reports');
      await tx.run('DELETE FROM tasks');

      // 旧备份/手工编辑的 JSON 可能缺字段：把 undefined 归一为 null，否则无法绑定参数
      const nn = (v) => (v === undefined ? null : v);

      for (const t of data.tasks) {
        await tx.run(
          `INSERT INTO tasks (id, title, description, plan_start, plan_end, deadline,
            actual_start, actual_end, status, important, urgent, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [t.id, t.title, t.description || '', nn(t.plan_start), nn(t.plan_end), nn(t.deadline),
            nn(t.actual_start), nn(t.actual_end), t.status || '未开始',
            t.important ? 1 : 0, t.urgent ? 1 : 0, t.created_at || nowISO(), t.updated_at || nowISO()]
        );
      }
      for (const l of (data.work_logs || [])) {
        await tx.run(
          `INSERT INTO work_logs (id, task_id, start_at, end_at, duration_ms, log_date, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [l.id, l.task_id, nn(l.start_at), nn(l.end_at), nn(l.duration_ms), nn(l.log_date), l.created_at || nowISO()]
        );
      }
      for (const r of (data.reminders || [])) {
        await tx.run(
          `INSERT INTO reminders (id, task_id, type, value, trigger_at, is_read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [r.id, r.task_id, r.type, r.value, r.trigger_at, r.is_read || 0, r.created_at || nowISO()]
        );
      }
      for (const p of (data.daily_reports || [])) {
        await tx.run(
          `INSERT INTO daily_reports (id, report_date, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [p.id, p.report_date, p.content || '', p.created_at || nowISO(), p.updated_at || nowISO()]
        );
      }
      // 工作条目（旧备份可能没有该字段）
      for (const en of (data.report_entries || [])) {
        const taskId = (en.task_id === null || en.task_id === undefined) ? null : en.task_id;
        await tx.run(
          `INSERT INTO report_entries (id, report_date, task_id, content, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [en.id, en.report_date, taskId, en.content || '', en.sort_order || 0,
            en.created_at || nowISO(), en.updated_at || nowISO()]
        );
      }
      // 按任务的补充说明（旧备份可能没有该字段）
      for (const n of (data.report_task_notes || [])) {
        const taskId = (n.task_id === null || n.task_id === undefined) ? null : n.task_id;
        await tx.run(
          `INSERT INTO report_task_notes (id, report_date, task_id, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [n.id, n.report_date, taskId, n.note || '',
            n.created_at || nowISO(), n.updated_at || nowISO()]
        );
      }
      // 导入的历史备份可能带有被覆盖的 log_date，回填为开始日（与导入同事务）
      await backfillLogDates(tx);
    });
    res.json({ ok: true, imported: { tasks: data.tasks.length } });
  } catch (e) {
    res.status(500).json({ error: `导入失败：${e.message}` });
  }
});

/* ============================ 访问口令 ============================ */

// 校验口令 → 通过则下发长期 cookie（电脑 / 手机各输一次即可）
app.post('/api/login', (req, res) => {
  const pw = req.body && req.body.password;
  if (!checkPassword(pw)) {
    return res.status(401).json({ error: '口令不正确' });
  }
  setAuthCookie(res);
  res.json({ ok: true });
});

// 退出登录：清掉 cookie
app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

/* ============================ 健康检查 ============================ */

// 健康检查（免登录）：托管平台的存活探测会不带 Cookie 打这个地址，必须返回 2xx，
// 否则平台会认为部署失败并反复重启。所以这里只回答「活着没」，
// 存储细节（driver / storage）仅对已登录用户可见，避免对外泄露后端类型。
app.get('/api/health', async (req, res) => {
  try {
    const probe = await get('SELECT 1 AS ok');
    const body = { ok: !!probe };
    if (isAuthed(req)) {
      body.driver = db.driver;
      body.storage = db.driver === 'remote' ? 'turso/libSQL' : 'local-file';
    }
    res.json(body);
  } catch (e) {
    // 数据库连不通：对未登录用户也只回 503，不泄露错误细节
    const body = { ok: false };
    if (isAuthed(req)) {
      body.driver = db.driver;
      body.error = e.message;
    }
    res.status(503).json(body);
  }
});

/* ============================ 错误兜底 ============================ */

// 异步处理器抛出的异常（比如云端数据库连不上）也返回 JSON，而不是默认的 HTML 报错页
app.use((err, req, res, next) => {
  console.error(`[接口错误] ${req.method} ${req.originalUrl} → ${err && err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: `服务器内部错误：${(err && err.message) || '未知错误'}` });
});

/* ============================ 启动 ============================ */

(async () => {
  await initDb();            // 建表 + 迁移 + 连接自检（本地或云端）
  await backfillLogDates();  // 幂等回填 log_date

  // 数据安全：本地模式启动时生成一份一致性快照（当天已有则跳过），此后每 24h 一份；云端模式自动跳过
  startScheduler();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n  工作管理平台已启动（存储：${db.driver === 'remote' ? '云端 libSQL' : '本地文件'}）`);
    console.log(`  打开浏览器访问： http://localhost:${PORT}\n`);
  });
})().catch((e) => {
  console.error(`\n  [启动失败] ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
