/**
 * 个人工作管理平台 · 后端服务
 * 技术：Node.js + Express + node:sqlite（内置，零原生依赖）
 *
 * 接口总览：
 *   任务    GET/POST/PUT/DELETE  /api/tasks
 *   打卡    POST /api/tasks/:id/start  |  POST /api/tasks/:id/stop
 *   提醒    GET/POST/DELETE      /api/reminders  |  GET /api/reminders/pending
 *   日报    GET /api/reports/:date  |  POST /api/reports  |  GET /api/reports/:date/summary
 *   备份    GET /api/export  |  POST /api/import
 */
const path = require('path');
const express = require('express');
const { all, get, run } = require('./db');
const {
  toDateStr, nowISO, calcTriggerAt, decorateTask,
} = require('./utils');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

/* ============================ 任务 ============================ */

// 任务列表
app.get('/api/tasks', (req, res) => {
  const rows = all('SELECT * FROM tasks ORDER BY id DESC');
  res.json(rows.map(decorateTask));
});

// 单个任务详情（含打卡记录与提醒点）
app.get('/api/tasks/:id', (req, res) => {
  const task = get('SELECT * FROM tasks WHERE id = ?', Number(req.params.id));
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const logs = all('SELECT * FROM work_logs WHERE task_id = ? ORDER BY id DESC', task.id);
  const reminders = all('SELECT * FROM reminders WHERE task_id = ? ORDER BY trigger_at', task.id);
  res.json({ ...decorateTask(task), logs, reminders });
});

// 新建任务
app.post('/api/tasks', (req, res) => {
  const {
    title, description = '', plan_start = null, plan_end = null,
    deadline = null, reminders = [],
  } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: '任务标题不能为空' });
  }
  const now = nowISO();
  const info = run(
    `INSERT INTO tasks (title, description, plan_start, plan_end, deadline, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '未开始', ?, ?)`,
    String(title).trim(), description, plan_start, plan_end, deadline, now, now
  );
  const taskId = Number(info.lastInsertRowid);

  // 处理提醒点
  try {
    addReminders(taskId, reminders, deadline);
  } catch (e) {
    // 提醒失败不影响任务创建，但要告知
    return res.status(400).json({ error: `任务已建，但提醒设置有误：${e.message}` });
  }

  res.json(decorateTask(get('SELECT * FROM tasks WHERE id = ?', taskId)));
});

// 更新任务
app.put('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  const task = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });

  const {
    title = task.title, description = task.description,
    plan_start = task.plan_start, plan_end = task.plan_end,
    deadline = task.deadline, status = task.status,
    reminders, // 若传入则整体替换
  } = req.body || {};

  run(
    `UPDATE tasks SET title=?, description=?, plan_start=?, plan_end=?, deadline=?, status=?, updated_at=?
     WHERE id=?`,
    title, description, plan_start, plan_end, deadline, status, nowISO(), id
  );

  if (Array.isArray(reminders)) {
    run('DELETE FROM reminders WHERE task_id = ?', id);
    try {
      addReminders(id, reminders, deadline);
    } catch (e) {
      return res.status(400).json({ error: `任务已更新，但提醒设置有误：${e.message}` });
    }
  }

  res.json(decorateTask(get('SELECT * FROM tasks WHERE id = ?', id)));
});

// 删除任务
app.delete('/api/tasks/:id', (req, res) => {
  const id = Number(req.params.id);
  run('DELETE FROM tasks WHERE id = ?', id);
  res.json({ ok: true });
});

/* ============================ 打卡 ============================ */

// 开始打卡
app.post('/api/tasks/:id/start', (req, res) => {
  const id = Number(req.params.id);
  const task = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status === '进行中') {
    return res.status(400).json({ error: '该任务已在进行中' });
  }
  const now = nowISO();
  const today = toDateStr(new Date());
  run(
    `UPDATE tasks SET actual_start=?, actual_end=NULL, status='进行中', updated_at=? WHERE id=?`,
    now, now, id
  );
  // 新建一条工作记录
  run(
    `INSERT INTO work_logs (task_id, start_at, log_date, created_at) VALUES (?, ?, ?, ?)`,
    id, now, today, now
  );
  res.json(decorateTask(get('SELECT * FROM tasks WHERE id = ?', id)));
});

// 结束打卡
app.post('/api/tasks/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  const task = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.status !== '进行中') {
    return res.status(400).json({ error: '该任务未在进行中，无法结束' });
  }
  const now = nowISO();
  const duration = task.actual_start
    ? new Date(now).getTime() - new Date(task.actual_start).getTime()
    : null;

  run(
    `UPDATE tasks SET actual_end=?, status='已完成', updated_at=? WHERE id=?`,
    now, now, id
  );
  // 更新最近一条未结束的工作记录
  const log = get(
    `SELECT * FROM work_logs WHERE task_id=? AND end_at IS NULL ORDER BY id DESC LIMIT 1`, id
  );
  if (log) {
    run(
      `UPDATE work_logs SET end_at=?, duration_ms=?, log_date=? WHERE id=?`,
      now, duration, toDateStr(new Date()), log.id
    );
  } else {
    run(
      `INSERT INTO work_logs (task_id, start_at, end_at, duration_ms, log_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id, task.actual_start, now, duration, toDateStr(new Date()), now
    );
  }
  res.json(decorateTask(get('SELECT * FROM tasks WHERE id = ?', id)));
});

/* ============================ 提醒 ============================ */

// 某任务的提醒列表
app.get('/api/tasks/:id/reminders', (req, res) => {
  res.json(all('SELECT * FROM reminders WHERE task_id = ? ORDER BY trigger_at', Number(req.params.id)));
});

// 未读且已到时间的提醒（站内补推，列表形式）
app.get('/api/reminders/pending', (req, res) => {
  const now = nowISO();
  const rows = all(
    `SELECT r.*, t.title AS task_title, t.deadline AS task_deadline
     FROM reminders r JOIN tasks t ON r.task_id = t.id
     WHERE r.is_read = 0 AND r.trigger_at <= ?
     ORDER BY r.trigger_at DESC`,
    now
  );
  res.json(rows);
});

// 标记提醒已读
app.post('/api/reminders/:id/read', (req, res) => {
  run('UPDATE reminders SET is_read = 1 WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

// 为任务新增提醒
app.post('/api/tasks/:id/reminders', (req, res) => {
  const id = Number(req.params.id);
  const task = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const { type, value } = req.body || {};
  try {
    const triggerAt = calcTriggerAt(type, value, task.deadline);
    run(
      `INSERT INTO reminders (task_id, type, value, trigger_at, is_read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      id, type, value, triggerAt, nowISO()
    );
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json(all('SELECT * FROM reminders WHERE task_id = ? ORDER BY trigger_at', id));
});

// 删除提醒
app.delete('/api/reminders/:id', (req, res) => {
  run('DELETE FROM reminders WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
});

/** 批量写入提醒点 */
function addReminders(taskId, list, deadline) {
  if (!Array.isArray(list)) return;
  for (const r of list) {
    if (!r || !r.type || r.value === undefined) continue;
    const triggerAt = calcTriggerAt(r.type, r.value, deadline);
    run(
      `INSERT INTO reminders (task_id, type, value, trigger_at, is_read, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      taskId, r.type, String(r.value), triggerAt, nowISO()
    );
  }
}

/* ============================ 日报 ============================ */

// 某天日报（手写内容）
app.get('/api/reports/:date', (req, res) => {
  const date = req.params.date;
  const report = get('SELECT * FROM daily_reports WHERE report_date = ?', date);
  res.json(report || { report_date: date, content: '' });
});

// 保存某天日报（手写内容，支持修改历史日期）
app.post('/api/reports', (req, res) => {
  const { date, content = '' } = req.body || {};
  if (!date) return res.status(400).json({ error: '缺少日期' });
  const now = nowISO();
  const exist = get('SELECT * FROM daily_reports WHERE report_date = ?', date);
  if (exist) {
    run('UPDATE daily_reports SET content=?, updated_at=? WHERE report_date=?', content, now, date);
  } else {
    run(
      'INSERT INTO daily_reports (report_date, content, created_at, updated_at) VALUES (?, ?, ?, ?)',
      date, content, now, now
    );
  }
  res.json(get('SELECT * FROM daily_reports WHERE report_date = ?', date));
});

// 某天任务自动汇总（侧栏数据）
// 规则：按任务"实际活动日期"归属；跨天任务在每个有活动的日期都出现
app.get('/api/reports/:date/summary', (req, res) => {
  const date = req.params.date;
  // 该日期有打卡活动的任务
  const logs = all(
    `SELECT w.*, t.title, t.description, t.deadline, t.status, t.actual_start, t.actual_end,
            t.plan_start, t.plan_end
     FROM work_logs w JOIN tasks t ON w.task_id = t.id
     WHERE w.log_date = ?
     ORDER BY w.id DESC`,
    date
  );
  const items = logs.map((l) => ({
    task_id: l.task_id,
    title: l.title,
    description: l.description,
    log_start: l.start_at,
    log_end: l.end_at,
    duration_ms: l.duration_ms,
    display_status: (() => {
      if (l.status === '已完成') return '已完成';
      if (l.deadline && new Date(l.deadline).getTime() < Date.now()) return '已逾期';
      return l.status;
    })(),
    is_cross_day: !!(l.start_at && l.end_at && toDateStr(new Date(l.start_at)) !== toDateStr(new Date(l.end_at))),
  }));
  res.json({ date, items });
});

/* ============================ 备份 ============================ */

// 一键导出全部数据
app.get('/api/export', (req, res) => {
  const data = {
    exported_at: nowISO(),
    version: 1,
    tasks: all('SELECT * FROM tasks'),
    work_logs: all('SELECT * FROM work_logs'),
    reminders: all('SELECT * FROM reminders'),
    daily_reports: all('SELECT * FROM daily_reports'),
  };
  res.setHeader('Content-Disposition', `attachment; filename="work-manager-${toDateStr(new Date())}.json"`);
  res.json(data);
});

// 一键导入（覆盖式）
app.post('/api/import', (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.tasks)) {
    return res.status(400).json({ error: '导入文件格式不正确' });
  }
  try {
    run('DELETE FROM work_logs');
    run('DELETE FROM reminders');
    run('DELETE FROM daily_reports');
    run('DELETE FROM tasks');

    const insTask = require('./db').db.prepare(
      `INSERT INTO tasks (id, title, description, plan_start, plan_end, deadline,
        actual_start, actual_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const t of data.tasks) {
      insTask.run(t.id, t.title, t.description || '', t.plan_start, t.plan_end, t.deadline,
        t.actual_start, t.actual_end, t.status || '未开始', t.created_at || nowISO(), t.updated_at || nowISO());
    }
    const insLog = require('./db').db.prepare(
      `INSERT INTO work_logs (id, task_id, start_at, end_at, duration_ms, log_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of (data.work_logs || [])) {
      insLog.run(l.id, l.task_id, l.start_at, l.end_at, l.duration_ms, l.log_date, l.created_at || nowISO());
    }
    const insRem = require('./db').db.prepare(
      `INSERT INTO reminders (id, task_id, type, value, trigger_at, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of (data.reminders || [])) {
      insRem.run(r.id, r.task_id, r.type, r.value, r.trigger_at, r.is_read || 0, r.created_at || nowISO());
    }
    const insRep = require('./db').db.prepare(
      `INSERT INTO daily_reports (id, report_date, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const p of (data.daily_reports || [])) {
      insRep.run(p.id, p.report_date, p.content || '', p.created_at || nowISO(), p.updated_at || nowISO());
    }
    res.json({ ok: true, imported: { tasks: data.tasks.length } });
  } catch (e) {
    res.status(500).json({ error: `导入失败：${e.message}` });
  }
});

/* ============================ 启动 ============================ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  工作管理平台已启动`);
  console.log(`  打开浏览器访问： http://localhost:${PORT}\n`);
});
