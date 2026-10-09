/* 工作管理平台 · 前端逻辑（原生 JS，无框架） */

const $ = (sel) => document.querySelector(sel);
const api = {
  async get(url) { return (await fetch(url)).json(); },
  async send(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  },
};

let editingId = null; // 当前编辑的任务 id

/* ---------- 工具函数 ---------- */
function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分钟`;
}
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ---------- 视图切换 ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    $(`#view-${tab.dataset.view}`).classList.add('active');
    if (tab.dataset.view === 'report') loadReport();
  });
});

/* ============================ 任务 ============================ */
async function loadTasks() {
  const tasks = await api.get('/api/tasks');
  const list = $('#task-list');
  list.innerHTML = '';
  $('#task-empty').classList.toggle('hidden', tasks.length > 0);

  for (const t of tasks) {
    const st = t.display_status;
    const card = document.createElement('div');
    card.className = 'task-card'
      + (st === '已逾期' ? ' overdue' : '')
      + (st === '已完成' ? ' done' : '');
    card.innerHTML = `
      <div class="task-info">
        <p class="task-title">${escapeHtml(t.title)}</p>
        ${t.description ? `<p class="task-desc">${escapeHtml(t.description)}</p>` : ''}
        <div class="task-meta">
          <span class="badge st-${st}">${st}</span>
          <span>截止：<b>${fmt(t.deadline)}</b></span>
          <span>计划：<b>${fmt(t.plan_start)} → ${fmt(t.plan_end)}</b></span>
          <span>实际耗时：<b>${fmtDuration(t.actual_duration_ms)}</b></span>
        </div>
      </div>
      <div class="task-ops">
        <button class="btn tiny ghost" data-act="edit" data-id="${t.id}">编辑</button>
        ${t.status === '进行中'
          ? `<button class="btn tiny primary" data-act="stop" data-id="${t.id}">结束打卡</button>`
          : `<button class="btn tiny primary" data-act="start" data-id="${t.id}">开始打卡</button>`}
      </div>`;
    list.appendChild(card);
  }
}

$('#task-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === 'edit') return openModal(id);
    if (btn.dataset.act === 'start') {
      await api.send(`/api/tasks/${id}/start`, 'POST');
      toast('已开始打卡');
    }
    if (btn.dataset.act === 'stop') {
      await api.send(`/api/tasks/${id}/stop`, 'POST');
      toast('已结束打卡，任务完成');
    }
    await loadTasks();
  } catch (err) { toast(err.message); }
});

/* ============================ 弹窗 ============================ */
function addReminderRow(type = 'relative', value = '-1d', absolute = '') {
  const row = document.createElement('div');
  row.className = 'reminder-row';
  row.innerHTML = `
    <select class="r-type">
      <option value="relative">截止前</option>
      <option value="absolute">指定时间</option>
    </select>
    <input class="r-value" placeholder="-1d / -2h" value="${value}" />
    <input class="r-abs" type="datetime-local" value="${absolute}" style="display:none" />
    <button type="button" class="btn tiny danger r-del">移除</button>`;
  const sel = row.querySelector('.r-type');
  const valInput = row.querySelector('.r-value');
  const absInput = row.querySelector('.r-abs');
  sel.value = type;
  const sync = () => {
    const rel = sel.value === 'relative';
    valInput.style.display = rel ? '' : 'none';
    absInput.style.display = rel ? 'none' : '';
  };
  sel.addEventListener('change', sync);
  row.querySelector('.r-del').addEventListener('click', () => row.remove());
  sync();
  $('#reminder-rows').appendChild(row);
}

function collectReminders() {
  const out = [];
  document.querySelectorAll('.reminder-row').forEach((row) => {
    const type = row.querySelector('.r-type').value;
    if (type === 'relative') {
      const v = row.querySelector('.r-value').value.trim();
      if (v) out.push({ type, value: v });
    } else {
      const v = row.querySelector('.r-abs').value;
      if (v) out.push({ type, value: new Date(v).toISOString() });
    }
  });
  return out;
}

async function openModal(id) {
  editingId = id || null;
  $('#reminder-rows').innerHTML = '';
  $('#f-status').disabled = false;

  if (id) {
    const t = await api.get(`/api/tasks/${id}`);
    $('#modal-title').textContent = '编辑任务';
    $('#f-title').value = t.title;
    $('#f-desc').value = t.description || '';
    $('#f-deadline').value = fmtDateInput(t.deadline);
    $('#f-plan-start').value = fmtDateInput(t.plan_start);
    $('#f-plan-end').value = fmtDateInput(t.plan_end);
    $('#f-status').value = t.status === '已完成' ? '已完成' : t.status;
    $('#btn-delete').classList.remove('hidden');
    // 回填提醒点
    (t.reminders || []).forEach((r) => {
      if (r.type === 'relative') addReminderRow('relative', r.value);
      else addReminderRow('absolute', '', fmtDateInput(r.trigger_at));
    });
    // 若已有实际打卡，开始时间不可随意改（仅提示）
  } else {
    $('#modal-title').textContent = '新建任务';
    $('#f-title').value = '';
    $('#f-desc').value = '';
    $('#f-deadline').value = '';
    $('#f-plan-start').value = fmtDateInput(new Date().toISOString()); // 自动填当前时间
    $('#f-plan-end').value = '';
    $('#f-status').value = '未开始';
    $('#f-est-hours').value = '';
    $('#btn-delete').classList.add('hidden');
    addReminderRow('relative', '-1d'); // 默认截止前 1 天
  }
  $('#modal').classList.remove('hidden');
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
}

$('#btn-new-task').addEventListener('click', () => openModal(null));
$('#btn-cancel').addEventListener('click', closeModal);
$('#btn-add-reminder').addEventListener('click', () => addReminderRow());
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// 按预估工时推算计划结束
$('#btn-calc-plan').addEventListener('click', () => {
  const start = $('#f-plan-start').value;
  const hours = parseFloat($('#f-est-hours').value);
  if (!start) return toast('请先填计划开始时间');
  if (!hours || hours <= 0) return toast('请填预估工时（小时）');
  const end = new Date(new Date(start).getTime() + hours * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  $('#f-plan-end').value =
    `${end.getFullYear()}-${p(end.getMonth()+1)}-${p(end.getDate())}T${p(end.getHours())}:${p(end.getMinutes())}`;
  toast('已按工时推算计划结束时间');
});

// 保存任务
$('#btn-save').addEventListener('click', async () => {
  const payload = {
    title: $('#f-title').value,
    description: $('#f-desc').value,
    deadline: $('#f-deadline').value ? new Date($('#f-deadline').value).toISOString() : null,
    plan_start: $('#f-plan-start').value ? new Date($('#f-plan-start').value).toISOString() : null,
    plan_end: $('#f-plan-end').value ? new Date($('#f-plan-end').value).toISOString() : null,
    status: $('#f-status').value,
    reminders: collectReminders(),
  };
  if (!payload.title.trim()) return toast('请填写任务标题');
  try {
    if (editingId) await api.send(`/api/tasks/${editingId}`, 'PUT', payload);
    else await api.send('/api/tasks', 'POST', payload);
    closeModal();
    await loadTasks();
    toast('已保存');
  } catch (err) { toast(err.message); }
});

// 删除任务
$('#btn-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('确定删除这个任务吗？相关打卡与提醒也会删除。')) return;
  try {
    await api.send(`/api/tasks/${editingId}`, 'DELETE');
    closeModal();
    await loadTasks();
    toast('已删除');
  } catch (err) { toast(err.message); }
});

/* ============================ 站内提醒 ============================ */
async function loadReminders() {
  const list = await api.get('/api/reminders/pending');
  const banner = $('#reminder-banner');
  if (!list.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  $('#reminder-count').textContent = `你有 ${list.length} 条待处理提醒`;
  const ul = $('#reminder-list');
  ul.innerHTML = '';
  list.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `任务「<b>${escapeHtml(r.task_title)}</b>」提醒 · 截止 ${fmt(r.task_deadline)}
      <button class="btn tiny ghost" data-read="${r.id}">标记已读</button>`;
    ul.appendChild(li);
  });
}
$('#reminder-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  await api.send(`/api/reminders/${btn.dataset.read}/read`, 'POST');
  loadReminders();
});
$('#reminder-close').addEventListener('click', () => $('#reminder-banner').classList.add('hidden'));

/* ============================ 日报 ============================ */
let currentReportDate = todayStr();

async function loadReport() {
  const date = $('#report-date').value || currentReportDate;
  currentReportDate = date;

  // 手写内容
  const report = await api.get(`/api/reports/${date}`);
  $('#report-content').value = report.content || '';
  $('#report-status').textContent = report.updated_at ? `上次保存：${fmt(report.updated_at)}` : '尚未保存';

  // 侧栏任务汇总
  const summary = await api.get(`/api/reports/${date}/summary`);
  const box = $('#report-summary');
  if (!summary.items.length) {
    box.innerHTML = '<p class="muted small">这一天还没有任务活动记录。</p>';
    return;
  }
  box.innerHTML = summary.items.map((it) => `
    <div class="sum-item">
      <div class="sum-title">${escapeHtml(it.title)}
        <span class="badge st-${it.display_status}">${it.display_status}</span>
        ${it.is_cross_day ? '<span class="badge">跨天</span>' : ''}
      </div>
      <div class="sum-line">打卡：${fmt(it.log_start)} → ${fmt(it.log_end)} · 耗时 ${fmtDuration(it.duration_ms)}</div>
    </div>`).join('');
}

$('#report-date').addEventListener('change', loadReport);
$('#btn-save-report').addEventListener('click', async () => {
  const date = $('#report-date').value || currentReportDate;
  try {
    await api.send('/api/reports', 'POST', { date, content: $('#report-content').value });
    $('#report-status').textContent = `已保存（${date}）`;
    toast('日报已保存');
  } catch (err) { toast(err.message); }
});

/* ============================ 导出 / 导入 ============================ */
$('#btn-export').addEventListener('click', () => {
  window.location.href = '/api/export';
});
$('#btn-import').addEventListener('click', () => $('#file-import').click());
$('#file-import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('导入将覆盖当前全部数据，确定继续吗？')) { e.target.value = ''; return; }
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const r = await api.send('/api/import', 'POST', data);
    toast(`导入成功，共 ${r.imported.tasks} 个任务`);
    await loadTasks();
    await loadReport();
    await loadReminders();
  } catch (err) { toast('导入失败：' + err.message); }
  e.target.value = '';
});

/* ---------- 简易防 XSS ---------- */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- 初始化 ---------- */
$('#report-date').value = todayStr();
(async function init() {
  await loadTasks();
  await loadReminders();
  await loadReport();
  // 每 60 秒刷新一次提醒
  setInterval(loadReminders, 60000);
})();
