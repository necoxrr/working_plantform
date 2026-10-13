/* 工作管理平台 · 前端逻辑（原生 JS，无框架） */

const $ = (sel) => document.querySelector(sel);
// 登录态失效（未登录 / cookie 过期）→ 回登录页
function backToLogin() {
  window.location.href = '/login.html';
  throw new Error('未登录');
}
const api = {
  async get(url) {
    const res = await fetch(url);
    if (res.status === 401) return backToLogin();
    return res.json();
  },
  async send(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) return backToLogin();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败');
    return data;
  },
};

let editingId = null; // 当前编辑的任务 id
let allTasks = [];    // 任务清单缓存（日报条目挑选任务用）
let taskFilter = 'all';    // 任务页筛选：all | today
let pendingReminders = []; // 缓存的待处理提醒（与停滞任务一起渲染顶部提醒条）
const STALL_DAYS = 3;      // 超过这么多天没有任何进展 → 判为「停滞」

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
/** datetime-local 的原始值 → ISO 字符串。
 *  空值 → null；解析不了 → 抛出可读错误（避免 Invalid Date → toISOString 抛 RangeError，
 *  被静默吞掉后「改了时间却保存没反应」）。 */
function datetimeToISO(raw, label) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) throw new Error(`${label}格式不正确，请点右侧日历重新选择`);
  return d.toISOString();
}
function fmtDuration(ms) {
  if (ms == null) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分钟`;
}
/** 计时器用的「时钟」格式：h:mm:ss（不足 1 小时则 mm:ss），精确到秒，便于实时走字 */
function fmtClock(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
function todayStr() { return dateStrOf(new Date()); }

/* ---------- 日期 / 四象限 / 停滞 / 今日聚焦 ---------- */
function dateStrOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function endOfToday() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }

// 四象限：重要 × 紧急
const QUADRANTS = {
  '11': { rank: 0, name: '重要且紧急' },
  '10': { rank: 1, name: '重要不紧急' },
  '01': { rank: 2, name: '紧急不重要' },
  '00': { rank: 3, name: '不紧急不重要' },
};
function quadKey(important, urgent) { return `${important ? 1 : 0}${urgent ? 1 : 0}`; }
function quadOf(t) { return QUADRANTS[quadKey(t.important, t.urgent)]; }
function quadName(important, urgent) { return QUADRANTS[quadKey(important, urgent)].name; }

// 是否已开工：点过「开始」(actual_start)／打过卡(有计时记录)／状态为「进行中」。
// 从未开工的任务既不该被「快到期」打扰，也谈不上「停滞」——否则新建一个任务放着不动，
// 3 天后就被判「停滞」催你，而它其实还没开始。
function hasStarted(t) {
  return t.status === '进行中' || !!t.actual_start || (t.log_count > 0);
}
// 最后一次有进展的时刻：打卡/日报 → 实际开始 → 创建时间（依次兜底）
function lastActivityTs(t) {
  const src = t.last_activity_at || t.actual_start || t.created_at;
  const ts = src ? new Date(src).getTime() : 0;
  return isNaN(ts) ? 0 : ts;
}
function idleDays(t) { return Math.floor((Date.now() - lastActivityTs(t)) / 86400000); }
// 停滞：已开工、未完成，且距离「最后一次有进展」超过 STALL_DAYS 天
function isStalled(t) { return t.status !== '已完成' && hasStarted(t) && idleDays(t) >= STALL_DAYS; }

// 今日聚焦：进行中 / 停滞 / 今日到期或已逾期 / 计划覆盖今天
function isTodayTask(t) {
  if (t.status === '进行中') return true;
  if (isStalled(t)) return true;
  if (t.status === '已完成') return false;
  if (t.deadline && new Date(t.deadline).getTime() <= endOfToday()) return true;
  const ps = t.plan_start ? new Date(t.plan_start).getTime() : null;
  const pe = t.plan_end ? new Date(t.plan_end).getTime() : null;
  if (ps != null && ps <= endOfToday() && (pe == null || pe >= startOfToday())) return true;
  return false;
}

// 排序：四象限优先 → 截止越早越前 → 新建越前
function taskSort(a, b) {
  const ra = quadOf(a).rank, rb = quadOf(b).rank;
  if (ra !== rb) return ra - rb;
  const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
  const dbb = b.deadline ? new Date(b.deadline).getTime() : Infinity;
  if (da !== dbb) return da - dbb;
  return b.id - a.id;
}
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2200);
}

/* ---------- 视图切换 ---------- */
/** 只切视图、载入数据，不做任何校验（内部用） */
function applyView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view !== 'history') historyJustSaved = null; // 离开日报历史后不再挂「已保存」徽标
  if (view === 'report') loadReport();
  if (view === 'history') loadHistory();
  if (view === 'weekly') loadWeekly();
}

/** 点标签页切换：离开日报历史前，若有未保存的修改先问一句 */
function switchView(view) {
  const cur = document.querySelector('.tab.active');
  const from = cur ? cur.dataset.view : null;
  if (from === 'history' && view !== 'history'
    && !guardUnsaved('日报历史里有未保存的修改，切走会丢弃它们，确定吗？')) return;
  applyView(view);
}
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchView(tab.dataset.view));
});

/* ============================ 任务 ============================ */
async function loadTasks() {
  allTasks = await api.get('/api/tasks');
  renderTasks();
  renderBanner();
}

/** 按当前筛选渲染任务列表（从缓存 allTasks 出发，不发请求） */
function renderTasks() {
  const list = $('#task-list');
  list.innerHTML = '';
  const items = (taskFilter === 'today' ? allTasks.filter(isTodayTask) : allTasks.slice())
    .sort(taskSort);
  for (const t of items) list.appendChild(taskCardEl(t));

  const emptyEl = $('#task-empty');
  emptyEl.classList.toggle('hidden', items.length > 0);
  emptyEl.textContent = taskFilter === 'today'
    ? '今天没有需要推进的任务，休息一下，或切到「全部」看看。'
    : '还没有任务，点击右上角「新建任务」开始。';

  // 筛选按钮上带数量
  const allBtn = document.querySelector('#task-filter [data-filter="all"]');
  const todayBtn = document.querySelector('#task-filter [data-filter="today"]');
  if (allBtn) allBtn.textContent = `全部 ${allTasks.length}`;
  if (todayBtn) todayBtn.textContent = `今日 ${allTasks.filter(isTodayTask).length}`;

  // 今日页顶部聚焦说明
  const note = $('#task-focus-note');
  if (taskFilter === 'today' && items.length) {
    const parts = [];
    const running = allTasks.filter((t) => t.status === '进行中').length;
    const due = allTasks.filter((t) => t.status !== '已完成' && t.deadline
      && new Date(t.deadline).getTime() <= endOfToday()).length;
    const stalled = allTasks.filter(isStalled).length;
    if (running) parts.push(`进行中 ${running}`);
    if (due) parts.push(`今日到期/已逾期 ${due}`);
    if (stalled) parts.push(`停滞 ${stalled}`);
    note.textContent = `今天聚焦 ${items.length} 个任务${parts.length ? '（' + parts.join(' · ') + '）' : ''}`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}

/** 单个任务卡片 */
function taskCardEl(t) {
  const st = t.display_status;
  const stalled = isStalled(t);
  // 计时三态：计时中（有未结束段）/ 暂停中（在做但没计时）/ 未计时
  const running = !!t.timer_running;
  const paused = !running && t.status === '进行中';
  const openSince = t.open_start ? new Date(t.open_start).getTime() : null;

  const segText = t.actual_duration_ms == null ? '—' : fmtClock(t.actual_duration_ms);
  const totalText = t.total_duration_ms == null ? '—' : fmtClock(t.total_duration_ms);

  const card = document.createElement('div');
  card.className = 'task-card'
    + (st === '已逾期' ? ' overdue' : '')
    + (st === '已完成' ? ' done' : '')
    + (running ? ' ticking' : '');
  card.dataset.id = t.id;
  card.innerHTML = `
    <div class="task-info">
      <p class="task-title">${escapeHtml(t.title)}</p>
      ${t.description ? `<p class="task-desc">${escapeHtml(t.description)}</p>` : ''}
      <div class="task-meta">
        <span class="badge st-${st}">${st}</span>
        ${running ? `<span class="timer-pill on"><i></i>计时中</span>` : ''}
        ${paused ? `<span class="timer-pill off">已暂停</span>` : ''}
        ${stalled ? `<span class="badge stalled-badge">停滞 ${idleDays(t)} 天</span>` : ''}
        <span class="quad-chips" title="点一下切换：重要 / 紧急">
          <button class="chip imp${t.important ? ' on' : ''}" data-act="imp" data-id="${t.id}">重要</button>
          <button class="chip urg${t.urgent ? ' on' : ''}" data-act="urg" data-id="${t.id}">紧急</button>
          ${(t.important || t.urgent) ? `<span class="quad-name">${quadOf(t).name}</span>` : ''}
        </span>
        <span>截止：<b>${fmt(t.deadline)}</b></span>
        <span>计划：<b>${fmt(t.plan_start)} → ${fmt(t.plan_end)}</b></span>
        <span>本段耗时：<b ${running ? `class="live-seg" data-since="${openSince}"` : ''}>${segText}</b></span>
        <span>累计耗时：<b ${running ? `class="live-total" data-base-ms="${t.total_duration_ms}" data-base-at="${Date.now()}"` : ''}>${totalText}</b></span>
      </div>
      <div class="task-reports hidden"></div>
      <div class="task-logs hidden"></div>
    </div>
    <div class="task-ops">
      <button class="btn tiny ghost" data-act="edit" data-id="${t.id}">编辑</button>
      ${t.report_entry_count > 0
        ? `<button class="btn tiny ghost" data-act="reports" data-id="${t.id}">日报记录 (${t.report_entry_count})</button>`
        : ''}
      ${t.log_count > 0
        ? `<button class="btn tiny ghost" data-act="logs" data-id="${t.id}">计时记录 (${t.log_count})</button>`
        : ''}
      ${running
        ? `<button class="btn tiny primary" data-act="pause" data-id="${t.id}">暂停</button>
           <button class="btn tiny ghost" data-act="finish" data-id="${t.id}">完成</button>`
        : paused
          ? `<button class="btn tiny primary" data-act="start" data-resume="1" data-id="${t.id}">继续</button>
             <button class="btn tiny ghost" data-act="finish" data-id="${t.id}">完成</button>`
          : `<button class="btn tiny primary" data-act="start" data-id="${t.id}">开始</button>`}
    </div>`;
  return card;
}

/** 切换任务页筛选（全部 / 今日） */
function setTaskFilter(filter) {
  taskFilter = filter;
  document.querySelectorAll('#task-filter .seg-btn').forEach((x) =>
    x.classList.toggle('active', x.dataset.filter === filter));
  renderTasks();
}
document.querySelectorAll('#task-filter .seg-btn').forEach((b) => {
  b.addEventListener('click', () => setTaskFilter(b.dataset.filter));
});

/** 展开/收起任务卡片下的「日报记录」：列出这个任务在哪些天、写了什么 */
async function toggleTaskReports(btn) {
  const card = btn.closest('.task-card');
  const box = card.querySelector('.task-reports');
  if (!box) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  const collapsed = box.classList.toggle('hidden');
  btn.textContent = collapsed ? btn.dataset.label : '收起记录';
  if (collapsed || box.dataset.loaded) return;
  box.innerHTML = '<p class="muted small">加载中…</p>';
  try {
    const { entries } = await api.get(`/api/tasks/${btn.dataset.id}/report-entries`);
    box.dataset.loaded = '1';
    if (!entries.length) {
      box.innerHTML = '<p class="muted small">这个任务还没有在日报里记录过内容。</p>';
      return;
    }
    let html = '';
    let lastDate = null;
    for (const e of entries) {
      if (e.report_date !== lastDate) {
        lastDate = e.report_date;
        html += `<div class="tr-day">${cnDate(e.report_date)}</div>`;
      }
      html += `<div class="tr-item">${escapeHtml(e.content)}</div>`;
    }
    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = '';
    box.dataset.loaded = '';
    toast(err.message);
  }
}

/** 展开/收起任务卡片下的「计时记录」：列出每一段计时，可逐段删除或一键清空 */
async function toggleTaskLogs(btn) {
  const card = btn.closest('.task-card');
  const box = card.querySelector('.task-logs');
  if (!box) return;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  const collapsed = box.classList.toggle('hidden');
  btn.textContent = collapsed ? btn.dataset.label : '收起记录';
  if (collapsed) return;
  await renderLogsPanel(card, btn.dataset.id);
}

/** 渲染某任务的计时记录面板（每段一行：开始 → 结束、时长、删除） */
async function renderLogsPanel(card, taskId) {
  const box = card.querySelector('.task-logs');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<p class="muted small">加载中…</p>';
  try {
    const { logs } = await api.get(`/api/tasks/${taskId}`);
    if (!logs.length) {
      box.innerHTML = '<p class="muted small">这个任务还没有计时段。</p>';
      return;
    }
    let html = '';
    for (const l of logs) {
      const open = !l.end_at;
      const dur = open
        ? `计时中 ${fmtClock(Date.now() - new Date(l.start_at).getTime())}`
        : fmtClock(l.duration_ms || 0);
      html += `<div class="tl-row">
        <span class="tl-time">${fmt(l.start_at)} → ${open ? '<b class="tl-open">进行中</b>' : fmt(l.end_at)}</span>
        <span class="tl-dur">${dur}</span>
        <button class="btn tiny ghost" data-act="del-log" data-id="${l.id}" data-task="${taskId}">删除</button>
      </div>`;
    }
    html += `<div class="tl-footer">
      <span class="muted small">共 ${logs.length} 段</span>
      <button class="btn tiny danger" data-act="clear-logs" data-task="${taskId}">清空全部</button>
    </div>`;
    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = '';
    toast(err.message);
  }
}

/** 删除单段后：刷新任务列表并重新展开该任务的计时记录面板 */
async function refreshLogsPanel(taskId) {
  await loadTasks();
  const card = document.querySelector(`.task-card[data-id="${taskId}"]`);
  if (!card) return;
  const btn = card.querySelector('[data-act="logs"]');
  if (btn) btn.textContent = '收起记录';
  await renderLogsPanel(card, taskId);
}

$('#task-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  try {
    if (btn.dataset.act === 'edit') return openModal(id);
    if (btn.dataset.act === 'reports') return toggleTaskReports(btn);
    if (btn.dataset.act === 'logs') return toggleTaskLogs(btn);
    if (btn.dataset.act === 'del-log') {
      if (!confirm('删除这一段计时记录？此操作不可撤销。')) return;
      await api.send(`/api/logs/${btn.dataset.id}`, 'DELETE');
      toast('已删除该段计时记录');
      await refreshLogsPanel(Number(btn.dataset.task));
      return;
    }
    if (btn.dataset.act === 'clear-logs') {
      if (!confirm('清空该任务的全部计时记录？状态将回到「未开始」，此操作不可撤销。')) return;
      await api.send(`/api/tasks/${btn.dataset.task}/logs`, 'DELETE');
      toast('已清空全部计时记录');
      await loadTasks();
      await loadReminders(); // 清空记录后任务回到「未开始」，提醒应一并静默
      return;
    }
    if (btn.dataset.act === 'imp' || btn.dataset.act === 'urg') {
      const t = allTasks.find((x) => x.id === id);
      if (!t) return;
      // 只发改动的那一个维度，其余字段服务端保持原值
      const payload = btn.dataset.act === 'imp' ? { important: !t.important } : { urgent: !t.urgent };
      await api.send(`/api/tasks/${id}`, 'PUT', payload);
      await loadTasks();
      await loadReminders();
      return;
    }
    if (btn.dataset.act === 'start') {
      const resume = btn.dataset.resume === '1';
      await api.send(`/api/tasks/${id}/start`, 'POST');
      toast(resume ? '已继续计时' : '已开始计时');
    }
    if (btn.dataset.act === 'pause') {
      await api.send(`/api/tasks/${id}/pause`, 'POST');
      toast('已暂停计时，可稍后「继续」');
    }
    if (btn.dataset.act === 'finish') {
      await api.send(`/api/tasks/${id}/stop`, 'POST');
      toast('已完成该任务');
    }
    await loadTasks();
    await loadReminders(); // 开始/暂停/完成都会改变「该不该提醒」，同步刷新
  } catch (err) { toast(err.message); }
});

/* ============================ 弹窗 ============================ */
/* 提醒点用「方向 + 数字 + 单位」三个控件填写，存储仍是内部编码 -1d / -2h / -30m，
   已存的旧值能原样解析回来，读写都不受影响。 */
const R_DIR_OPTIONS = [['-', '截止前'], ['+', '截止后']];
const R_UNIT_OPTIONS = [['d', '天'], ['h', '小时'], ['m', '分钟']];

/** '-1d' → { dir, num, unit }；解析不出来时回退成「截止前 1 天」
 *  注意：旧数据里不带符号的 '1d'，底层引擎是按 '+1d'（截止后）算的，
 *  这里如实还原成「截止后」，避免一保存就把已有提醒的时刻悄悄改掉。 */
function parseReminderOffset(value) {
  const m = /^([+-]?)(\d+)\s*([dhm])$/.exec(String(value == null ? '' : value).trim());
  if (!m) return { dir: '-', num: 1, unit: 'd' };
  return { dir: m[1] === '-' ? '-' : '+', num: parseInt(m[2], 10), unit: m[3] };
}

/** { dir, num, unit } → 存储值，如 '-1d' / '+2h' */
function buildReminderOffset(dir, num, unit) {
  return `${dir === '+' ? '+' : '-'}${num}${unit}`;
}

/** 人话提示：将在截止时间前 1 天提醒 */
function reminderHintText(dir, num, unit) {
  if (!num) return '将在截止时刻提醒';
  const unitLabel = (R_UNIT_OPTIONS.find((u) => u[0] === unit) || ['', '天'])[1];
  return `将在截止时间${dir === '+' ? '后' : '前'} ${num} ${unitLabel}提醒`;
}

function addReminderRow(type = 'relative', value = '-1d', absolute = '') {
  const off = parseReminderOffset(value);
  const opts = (list) => list.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  const row = document.createElement('div');
  row.className = 'reminder-row';
  row.innerHTML = `
    <select class="r-type">
      <option value="relative">相对截止时间</option>
      <option value="absolute">指定时间</option>
    </select>
    <span class="r-rel">
      <select class="r-dir">${opts(R_DIR_OPTIONS)}</select>
      <input class="r-num" type="number" min="0" step="1" value="${off.num}" />
      <select class="r-unit">${opts(R_UNIT_OPTIONS)}</select>
    </span>
    <input class="r-abs" type="datetime-local" value="${absolute}" />
    <button type="button" class="btn tiny danger r-del">移除</button>
    <div class="r-hint muted small"></div>`;
  const sel = row.querySelector('.r-type');
  const rel = row.querySelector('.r-rel');
  const abs = row.querySelector('.r-abs');
  const hint = row.querySelector('.r-hint');
  const dirSel = row.querySelector('.r-dir');
  const numInput = row.querySelector('.r-num');
  const unitSel = row.querySelector('.r-unit');
  sel.value = type;
  dirSel.value = off.dir;
  unitSel.value = off.unit;

  const updateHint = () => {
    hint.textContent = reminderHintText(dirSel.value, parseInt(numInput.value, 10) || 0, unitSel.value);
  };
  const sync = () => {
    const isRel = sel.value === 'relative';
    rel.style.display = isRel ? '' : 'none';
    abs.style.display = isRel ? 'none' : '';
    hint.style.display = isRel ? '' : 'none';
    updateHint();
  };
  sel.addEventListener('change', sync);
  dirSel.addEventListener('change', updateHint);
  unitSel.addEventListener('change', updateHint);
  numInput.addEventListener('input', updateHint);
  row.querySelector('.r-del').addEventListener('click', () => row.remove());
  sync();
  $('#reminder-rows').appendChild(row);
}

function collectReminders() {
  const out = [];
  document.querySelectorAll('.reminder-row').forEach((row) => {
    const type = row.querySelector('.r-type').value;
    if (type === 'relative') {
      const num = parseInt(row.querySelector('.r-num').value, 10);
      if (!Number.isFinite(num)) return; // 没填数字 → 该行不生效
      out.push({
        type,
        value: buildReminderOffset(row.querySelector('.r-dir').value, num, row.querySelector('.r-unit').value),
      });
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
    $('#f-important').checked = !!t.important;
    $('#f-urgent').checked = !!t.urgent;
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
    $('#f-important').checked = false;
    $('#f-urgent').checked = false;
    $('#btn-delete').classList.add('hidden');
    addReminderRow('relative', '-1d'); // 默认截止前 1 天
  }
  $('#modal').classList.remove('hidden');
  updateQuadHint();
}

/** 弹窗里显示当前选择的四象限名 */
function updateQuadHint() {
  $('#f-quad-hint').textContent = quadName($('#f-important').checked, $('#f-urgent').checked);
}

function closeModal() {
  $('#modal').classList.add('hidden');
  editingId = null;
}

$('#btn-new-task').addEventListener('click', () => openModal(null));
$('#btn-cancel').addEventListener('click', closeModal);
$('#btn-add-reminder').addEventListener('click', () => addReminderRow());
$('#f-important').addEventListener('change', updateQuadHint);
$('#f-urgent').addEventListener('change', updateQuadHint);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* 日期 / 时间字段：Chrome 里只有点最右侧那个小小的日历图标才会弹出选择器，
   点在文字上毫无反应 —— 很容易被当成「这个时间改不了」。
   这里让「点整块字段」都能唤出原生选择器。
   （已实测：原生选择器已打开时再调 showPicker() 是幂等的，不会把它关掉，
   所以不必区分是否点在图标上，直接补一次即可。） */
document.addEventListener('click', (e) => {
  const el = e.target.closest && e.target.closest('input[type="datetime-local"], input[type="date"], input[type="time"]');
  if (!el || typeof el.showPicker !== 'function') return;
  try { el.showPicker(); } catch (err) { /* 浏览器不支持或被拒绝：忽略，字段仍可键盘编辑 */ }
});

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
  try {
    // 整个构造过程放进 try：任何一步出错都会给出明确提示，而不是静默失败
    const payload = {
      title: $('#f-title').value,
      description: $('#f-desc').value,
      deadline: datetimeToISO($('#f-deadline').value, '截止时间'),
      plan_start: datetimeToISO($('#f-plan-start').value, '计划开始时间'),
      plan_end: datetimeToISO($('#f-plan-end').value, '计划结束时间'),
      status: $('#f-status').value,
      important: $('#f-important').checked,
      urgent: $('#f-urgent').checked,
      reminders: collectReminders(),
    };
    if (!payload.title.trim()) return toast('请填写任务标题');
    if (editingId) await api.send(`/api/tasks/${editingId}`, 'PUT', payload);
    else await api.send('/api/tasks', 'POST', payload);
    closeModal();
    await loadTasks();
    await loadReminders(); // 提醒可能因状态/截止时间变化而增减，立即同步
    toast('已保存');
  } catch (err) { toast(err && err.message ? err.message : '保存失败'); }
});

// 删除任务
$('#btn-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('确定删除这个任务吗？相关打卡与提醒也会删除。')) return;
  try {
    await api.send(`/api/tasks/${editingId}`, 'DELETE');
    closeModal();
    await loadTasks();
    await loadReminders(); // 任务没了，它的提醒也该从通知条上消失
    toast('已删除');
  } catch (err) { toast(err.message); }
});

/* ============================ 站内提醒 ============================ */
async function loadReminders() {
  pendingReminders = await api.get('/api/reminders/pending');
  renderBanner();
}

/** 顶部提醒条：待处理提醒 + 停滞任务 一并展示 */
function renderBanner() {
  const banner = $('#reminder-banner');
  const ul = $('#reminder-list');
  const stalled = allTasks.filter(isStalled).sort((a, b) => idleDays(b) - idleDays(a));
  if (!pendingReminders.length && !stalled.length) { banner.classList.add('hidden'); return; }
  banner.classList.remove('hidden');
  const parts = [];
  if (pendingReminders.length) parts.push(`${pendingReminders.length} 条待处理提醒`);
  if (stalled.length) parts.push(`${stalled.length} 个任务停滞`);
  $('#reminder-count').textContent = `你有 ${parts.join(' · ')}`;
  ul.innerHTML = '';
  pendingReminders.forEach((r) => {
    const li = document.createElement('li');
    // 显示「提醒应该响的时刻」而不是任务截止时间：设了「截止前 2 天」时，
    // 原来这里显示的是截止日期，跟真正该响的时间差了 2 天。
    li.innerHTML = `任务「<b>${escapeHtml(r.task_title)}</b>」提醒时刻 ${fmt(r.trigger_at)}
      <button class="btn tiny ghost" data-read="${r.id}">标记已读</button>`;
    ul.appendChild(li);
  });
  stalled.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'banner-stalled';
    li.innerHTML = `<span class="stalled-tag">停滞 ${idleDays(t)} 天</span>任务「<b>${escapeHtml(t.title)}</b>」好久没动静了
      <button class="btn tiny ghost" data-goto="${t.id}">去处理</button>`;
    ul.appendChild(li);
  });
}

$('#reminder-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.read) {
    await api.send(`/api/reminders/${btn.dataset.read}/read`, 'POST');
    await loadReminders();
  } else if (btn.dataset.goto) {
    switchView('tasks');
    setTaskFilter('today');
    const card = document.querySelector(`.task-card[data-id="${btn.dataset.goto}"]`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});
$('#reminder-close').addEventListener('click', () => $('#reminder-banner').classList.add('hidden'));

/* ============================ 日报 ============================ */
let currentReportDate = todayStr();
// 表单当前对应的日期：与所选日期相同时不重复初始化，
// 这样切个标签回来正在写的内容不会被清掉。
let reportFormDate = null;

/* ---------- 任务分组（「日报历史」用：每个任务一组：内容条目 + 本任务自己的补充说明） ---------- */
const FREE_KEY = 'free'; // 「其他小事 / 不关联任务」这一组的键

function taskKeyOf(taskId) {
  return (taskId === null || taskId === undefined || taskId === '') ? FREE_KEY : String(taskId);
}

function entryOptionsHtml() {
  return ['<option value="">其他小事 / 不关联任务</option>']
    .concat(allTasks.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`))
    .join('');
}

/** 按 id 取任务名；查不到（任务已删）则算「其他小事」 */
function taskLabelById(taskId) {
  if (taskId === null || taskId === undefined || taskId === '') return '其他小事';
  const t = allTasks.find((x) => String(x.id) === String(taskId));
  return t ? t.title : '其他小事';
}

/** 一行「做了什么」 */
function makeLine(content = '') {
  const row = document.createElement('div');
  row.className = 'entry-row';
  row.innerHTML = `
    <textarea class="e-content" rows="1" placeholder="这个任务今天做了什么……"></textarea>
    <button type="button" class="btn tiny danger e-del" title="删除该条">删除</button>`;
  row.querySelector('.e-content').value = content || '';
  row.querySelector('.e-del').addEventListener('click', () => {
    const group = row.closest('.entry-group');
    row.remove();
    refreshGroupCount(group);
  });
  return row;
}

/** 更新分组标题上的「N 条」 */
function refreshGroupCount(group) {
  if (!group) return;
  const n = Array.from(group.querySelectorAll('.e-content'))
    .filter((t) => t.value.trim()).length;
  const box = group.querySelector('.eg-count');
  if (box) box.textContent = n ? `${n} 条` : '';
}

/**
 * 一个任务分组。
 * opts.fixed = true → 任务名固定显示（已在库里的分组，不可改）；
 * 否则任务栏是下拉框，用于新增分组时选择任务。
 */
function makeGroup(opts = {}) {
  const taskId = (opts.taskId === null || opts.taskId === undefined || opts.taskId === '')
    ? '' : String(opts.taskId);
  const label = opts.title || taskLabelById(taskId);
  const el = document.createElement('div');
  el.className = 'entry-group';
  el.dataset.taskId = taskId;
  const headTask = opts.fixed
    ? `<span class="eg-name${taskId ? '' : ' free'}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`
    : `<select class="eg-task">${entryOptionsHtml()}</select>`;
  el.innerHTML = `
    <div class="eg-head">
      <span class="eg-caret" title="收起 / 展开">▾</span>
      ${headTask}
      <span class="eg-count muted small"></span>
      <span class="spacer"></span>
      <button type="button" class="btn tiny ghost eg-collapse">收起</button>
      <button type="button" class="btn tiny danger eg-del" title="移除该分组">移除</button>
    </div>
    <div class="eg-body">
      <div class="eg-lines"></div>
      <button type="button" class="btn tiny ghost eg-add">+ 添加一条</button>
      <label class="field-label eg-note-label">补充说明（仅本任务）</label>
      <textarea class="eg-note" rows="2" placeholder="与这个任务相关的补充、心得、备注……"></textarea>
    </div>`;
  const sel = el.querySelector('.eg-task');
  if (sel) sel.value = taskId;
  el.querySelector('.eg-note').value = opts.note || '';

  const lines = el.querySelector('.eg-lines');
  const contents = (opts.entries && opts.entries.length) ? opts.entries : [''];
  contents.forEach((c) => lines.appendChild(makeLine(c)));
  el.querySelector('.eg-add').addEventListener('click', () => {
    lines.appendChild(makeLine(''));
    refreshGroupCount(el);
  });
  lines.addEventListener('input', () => refreshGroupCount(el));

  const toggle = () => {
    el.classList.toggle('collapsed');
    el.querySelector('.eg-collapse').textContent =
      el.classList.contains('collapsed') ? '展开' : '收起';
  };
  el.querySelector('.eg-caret').addEventListener('click', toggle);
  el.querySelector('.eg-collapse').addEventListener('click', toggle);
  el.querySelector('.eg-del').addEventListener('click', () => el.remove());
  refreshGroupCount(el);
  return el;
}

/** 渲染某天的内容：按任务分组，任务名固定，各分组有自己的补充说明 */
function renderGroups(container, entries, notes) {
  container.innerHTML = '';
  const groups = new Map(); // key -> { taskId, title, contents: [] }
  (entries || []).forEach((e) => {
    const key = taskKeyOf(e.task_id);
    if (!groups.has(key)) groups.set(key, { taskId: e.task_id, title: e.task_title, contents: [] });
    groups.get(key).contents.push(e.content);
  });
  const noteMap = new Map();
  (notes || []).forEach((n) => {
    const text = (n.note || '').trim();
    if (!text) return;
    const key = taskKeyOf(n.task_id);
    noteMap.set(key, noteMap.has(key) ? `${noteMap.get(key)}\n${text}` : text);
  });

  if (!groups.size && !noteMap.size) {
    container.appendChild(makeGroup()); // 空白表单：一个可选任务的新分组
    return;
  }
  for (const [key, g] of groups) {
    container.appendChild(makeGroup({
      taskId: g.taskId, title: g.title, fixed: true,
      note: noteMap.get(key) || '', entries: g.contents,
    }));
    noteMap.delete(key);
  }
  // 只有补充说明、没有内容条目的分组（例如从旧版合并过来的「整天补充说明」）
  for (const [key, note] of noteMap) {
    const tid = key === FREE_KEY ? null : Number(key);
    container.appendChild(makeGroup({
      taskId: tid, title: taskLabelById(tid), fixed: true, note, entries: [''],
    }));
  }
}

/** 收集表单内容：扁平的工作条目 + 每个任务各自的补充说明 */
function collectGroups(container) {
  const entries = [];
  const notes = [];
  container.querySelectorAll('.entry-group').forEach((g) => {
    const sel = g.querySelector('.eg-task');
    const taskId = sel
      ? (sel.value ? Number(sel.value) : null)
      : (g.dataset.taskId ? Number(g.dataset.taskId) : null);
    g.querySelectorAll('.entry-row').forEach((row) => {
      const content = row.querySelector('.e-content').value;
      if (content.trim()) entries.push({ task_id: taskId, content });
    });
    const note = g.querySelector('.eg-note').value;
    if (note.trim()) notes.push({ task_id: taskId, note });
  });
  return { entries, notes };
}
/* ---------- 平铺的工作条目（「每日日报」页用：一行一条，任务可选） ---------- */
/** 一行：任务下拉 + 内容 */
function makeEntryRow(opts = {}) {
  const row = document.createElement('div');
  row.className = 'entry-row';
  row.innerHTML = `
    <select class="e-task">${entryOptionsHtml()}</select>
    <textarea class="e-content" rows="1" placeholder="今天做了什么……"></textarea>
    <button type="button" class="btn tiny danger e-del" title="删除该条">删除</button>`;
  const sel = row.querySelector('.e-task');
  const want = (opts.taskId === null || opts.taskId === undefined || opts.taskId === '')
    ? '' : String(opts.taskId);
  sel.value = want;
  if (sel.value !== want) sel.value = ''; // 任务已被删除 → 回落「其他小事」
  row.querySelector('.e-content').value = opts.content || '';
  row.querySelector('.e-del').addEventListener('click', () => {
    const box = row.parentElement;
    row.remove();
    if (box && !box.querySelector('.entry-row')) box.appendChild(makeEntryRow()); // 至少留一行
  });
  return row;
}

/** 渲染某天的工作条目（平铺）；没有条目时给一行空白 */
function renderEntries(container, entries) {
  container.innerHTML = '';
  const list = entries || [];
  if (!list.length) { container.appendChild(makeEntryRow()); return; }
  list.forEach((e) => container.appendChild(makeEntryRow({ taskId: e.task_id, content: e.content })));
}

/** 收集平铺条目（跳过空行） */
function collectEntries(container) {
  const out = [];
  container.querySelectorAll('.entry-row').forEach((row) => {
    const content = row.querySelector('.e-content').value;
    if (!content.trim()) return;
    const v = row.querySelector('.e-task').value;
    out.push({ task_id: v ? Number(v) : null, content });
  });
  return out;
}

/** 任务清单变化时刷新平铺条目的下拉可选项（保留已选） */
function refreshEntryOptions(container) {
  container.querySelectorAll('.entry-row').forEach((row) => {
    const sel = row.querySelector('.e-task');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = entryOptionsHtml();
    sel.value = cur;
    if (sel.value !== cur) sel.value = '';
  });
}

$('#btn-add-entry').addEventListener('click', () => {
  const box = $('#report-entries');
  box.appendChild(makeEntryRow());
  box.lastElementChild.querySelector('.e-content').focus();
});

// 把当天打过卡的任务带成条目草稿：只预选任务、内容留空，等用户补充「做了什么」
$('#btn-import-checkin').addEventListener('click', async () => {
  const date = $('#report-date').value || currentReportDate;
  try {
    const summary = await api.get(`/api/reports/${date}/summary`);
    if (!summary.items.length) return toast('这天还没有打卡记录');
    const box = $('#report-entries');
    const present = new Set();
    box.querySelectorAll('.entry-row').forEach((row) => {
      const v = row.querySelector('.e-task').value;
      if (v) present.add(String(v));
    });
    let added = 0;
    for (const it of summary.items) {
      const key = String(it.task_id);
      if (present.has(key)) continue; // 表单里已有该任务 → 不重复导入
      present.add(key);
      box.appendChild(makeEntryRow({ taskId: it.task_id, content: '' }));
      added += 1;
    }
    if (!added) return toast('今日打卡的任务都已在表单里');
    toast(`已导入 ${added} 个今日打卡任务，请补充做了什么`);
  } catch (err) { toast(err.message); }
});

/* ============================ 周复盘 ============================ */
let weekAnchor = todayStr();

function shiftWeek(days) {
  const d = new Date(`${weekAnchor}T00:00:00`);
  d.setDate(d.getDate() + days);
  weekAnchor = dateStrOf(d);
  loadWeekly();
}

async function loadWeekly() {
  const [data, tasks] = await Promise.all([
    api.get(`/api/weekly?date=${weekAnchor}`),
    api.get('/api/tasks'),
  ]);
  allTasks = tasks;
  renderWeekly(data);
}

function renderWeekly(d) {
  const box = $('#weekly-body');
  $('#week-label').textContent = `${d.start_date} ~ ${d.end_date}`;
  const stalled = allTasks.filter(isStalled).sort((a, b) => idleDays(b) - idleDays(a));
  const hours = (ms) => (ms / 3600000);
  const maxDay = Math.max(1, ...d.days.map((x) => x.ms));
  const maxTask = Math.max(1, ...d.tasks.map((x) => x.ms));
  const dayName = ['一', '二', '三', '四', '五', '六', '日'];

  const cards = `
    <div class="wk-cards">
      <div class="wk-card"><div class="wk-num">${hours(d.total_ms).toFixed(1)}<span>h</span></div><div class="wk-lbl">本周投入</div></div>
      <div class="wk-card"><div class="wk-num">${d.completed.length}</div><div class="wk-lbl">完成任务</div></div>
      <div class="wk-card"><div class="wk-num">${d.tasks.length}</div><div class="wk-lbl">有活动任务</div></div>
      <div class="wk-card"><div class="wk-num">${stalled.length}</div><div class="wk-lbl">停滞中</div></div>
      <div class="wk-card"><div class="wk-num">${d.report_entry_count}</div><div class="wk-lbl">日报条目</div></div>
    </div>`;

  const daysHtml = d.days.map((x, i) => `
    <div class="wk-day">
      <span class="wk-day-name">周${dayName[i]}</span>
      <div class="wk-bar-track"><div class="wk-bar" style="width:${(x.ms / maxDay * 100).toFixed(1)}%"></div></div>
      <span class="wk-day-val">${x.ms ? fmtDuration(x.ms) : '—'}</span>
    </div>`).join('');

  const tasksHtml = d.tasks.length
    ? d.tasks.map((t) => `
      <div class="wk-task">
        <div class="wk-task-head">
          <span class="wk-task-title">${escapeHtml(t.title)}</span>
          <span class="badge st-${t.display_status}">${t.display_status}</span>
          <span class="wk-task-ms">${fmtDuration(t.ms)}</span>
        </div>
        <div class="wk-bar-track"><div class="wk-bar" style="width:${(t.ms / maxTask * 100).toFixed(1)}%"></div></div>
      </div>`).join('')
    : '<p class="muted small">本周还没有打卡记录。</p>';

  const completedHtml = d.completed.length
    ? d.completed.map((t) => `<div class="wk-li"><span class="wk-dot done"></span>${escapeHtml(t.title)}
        <span class="muted small">${fmt(t.actual_end)}</span></div>`).join('')
    : '<p class="muted small">本周还没有完成的任务。</p>';

  const stalledHtml = stalled.length
    ? stalled.map((t) => `<div class="wk-li"><span class="stalled-tag">停滞 ${idleDays(t)} 天</span>${escapeHtml(t.title)}</div>`).join('')
    : '<p class="muted small">没有停滞的任务，保持得不错。</p>';

  box.innerHTML = `
    ${cards}
    <div class="wk-sec"><h3>每日投入</h3><div class="wk-days">${daysHtml}</div></div>
    <div class="wk-sec"><h3>按任务的时间投入</h3><div class="wk-tasks">${tasksHtml}</div></div>
    <div class="wk-sec"><h3>本周完成</h3><div class="wk-list">${completedHtml}</div></div>
    <div class="wk-sec"><h3>停滞提醒</h3><div class="wk-list">${stalledHtml}</div></div>`;
}

$('#week-prev').addEventListener('click', () => shiftWeek(-7));
$('#week-next').addEventListener('click', () => shiftWeek(7));
$('#week-this').addEventListener('click', () => { weekAnchor = todayStr(); loadWeekly(); });

/** 状态栏：这天已保存多少条 + 最后保存时间（日报页不显示已保存内容，只给提示） */
function updateReportStatus(report) {
  const n = (report && report.entries ? report.entries.length : 0);
  const bits = [n ? `这天已保存 ${n} 条工作条目` : '这天还没有记录'];
  if (report && report.updated_at) bits.push(`最后保存 ${fmt(report.updated_at)}`);
  $('#report-status').textContent = bits.join(' · ');
}

async function loadReport(opts = {}) {
  const date = $('#report-date').value || currentReportDate;
  currentReportDate = date;

  // 任务清单（供条目选择关联任务）
  allTasks = await api.get('/api/tasks');

  // 「日报」页只负责写新内容：进入/切换日期时表单永远是空白的，
  // 不把当天已保存的内容填进来 —— 保存永远走追加，不可能覆盖历史。
  // 同一天再次进入本页时保持现状，正在写的内容不会被清掉。
  const report = await api.get(`/api/reports/${date}`);
  if (opts.force || reportFormDate !== date) {
    renderEntries($('#report-entries'), []);
    $('#report-content').value = '';
    reportFormDate = date;
  } else {
    // 任务清单可能刚变过（新增/改名/删除），刷新条目下拉的可选项
    refreshEntryOptions($('#report-entries'));
  }
  updateReportStatus(report);

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
        ${it.is_cross_day ? '<span class="badge cross-day">跨天</span>' : ''}
      </div>
      <div class="sum-line">打卡：${fmt(it.log_start)} → ${fmt(it.log_end)} · 耗时 ${fmtDuration(it.duration_ms)}</div>
    </div>`).join('');
}

$('#report-date').addEventListener('change', () => loadReport());
$('#btn-save-report').addEventListener('click', async () => {
  const date = $('#report-date').value || currentReportDate;
  const entries = collectEntries($('#report-entries'));
  const content = $('#report-content').value;
  if (!entries.length && !content.trim()) return toast('先写点内容再保存');
  // 永远追加：接在当天已有内容之后，不会覆盖已保存的条目。
  // 不提交 notes：日报页不认识「按任务的补充说明」，不能把日报历史里写的内容清掉。
  try {
    await api.send('/api/reports', 'POST', { date, content, entries, append: true });
    // 保存成功后复位成空白，方便接着往下写；要改已保存的内容去「日报历史」。
    renderEntries($('#report-entries'), []);
    $('#report-content').value = '';
    reportFormDate = date;
    updateReportStatus(await api.get(`/api/reports/${date}`));
    toast('已追加到当天日报');
  } catch (err) { toast(err.message); }
});

/* ============================ 日报历史 ============================ */
const historyData = new Map(); // report_date -> 日报对象
let historyOpenDate = null;    // 当前展开编辑的日期
let historyJustSaved = null;   // { date, at } 刚保存成功的那天 → 条目头显示绿色「已保存 HH:MM:SS」

function cnDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y, m - 1, d).getDay()];
  return `${m}月${String(d).padStart(2, '0')}日 ${wd}`;
}
function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return `${y} 年 ${m} 月`;
}
function timeShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 精确到秒的时分秒，用于保存成功徽标（分钟级时间戳同一分钟内看不出变化） */
function timeSec(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 只读展示：按任务分组（任务标签 + 它的条目 + 它自己的补充说明）+ 末尾的整天补充说明 */
function histViewHtml(r) {
  const entries = r.entries || [];
  const notes = r.notes || [];
  const dayNote = (r.content || '').trim(); // 「日报」页写的整天补充说明，存在 daily_reports.content
  if (!entries.length && !notes.length && !dayNote) return '<div class="muted small">（无内容）</div>';

  const groups = new Map(); // key -> { task_id, title, contents: [], note }
  entries.forEach((e) => {
    const key = taskKeyOf(e.task_id);
    if (!groups.has(key)) groups.set(key, { task_id: e.task_id, title: e.task_title, contents: [] });
    groups.get(key).contents.push(e.content);
  });
  notes.forEach((n) => {
    const key = taskKeyOf(n.task_id);
    if (!groups.has(key)) {
      groups.set(key, { task_id: n.task_id, title: taskLabelById(n.task_id), contents: [] });
    }
    const g = groups.get(key);
    g.note = g.note ? `${g.note}\n${n.note}` : n.note;
  });

  let html = '';
  for (const [, g] of groups) {
    const tag = g.task_id
      ? `<span class="hist-task">${escapeHtml(g.title || '任务')}</span>`
      : '<span class="hist-task free">其他小事</span>';
    html += `<div class="hist-group-block"><div class="hist-group-head">${tag}</div>`;
    g.contents.forEach((c) => { html += `<div class="hist-entry">${escapeHtml(c)}</div>`; });
    if (g.note) html += `<div class="hist-content">补充说明：${escapeHtml(g.note)}</div>`;
    html += '</div>';
  }
  // 整天补充说明：不属于任何任务，单独一块放在末尾（与「日报」页的书写顺序一致）
  if (dayNote) {
    html += '<div class="hist-group-block hist-day-block">'
      + '<div class="hist-group-head"><span class="hist-task day">补充说明（整天）</span></div>'
      + `<div class="hist-content">${escapeHtml(dayNote)}</div>`
      + '</div>';
  }
  return html;
}

function buildHistoryItem(r) {
  const item = document.createElement('div');
  item.className = 'hist-item';
  item.dataset.date = r.report_date;
  // 刚保存成功：在日期旁挂一个精确到秒的绿色徽标，让"存进去了"这件事一眼可见
  const saved = historyJustSaved && historyJustSaved.date === r.report_date
    ? `<span class="hist-saved">已保存 ${timeSec(historyJustSaved.at)}</span>`
    : '';
  item.innerHTML = `
    <div class="hist-head">
      <div class="hist-date">${cnDate(r.report_date)}${saved}</div>
      <div class="hist-meta muted small">${(r.entries || []).length} 条工作条目 · 最后保存 ${timeShort(r.updated_at)}</div>
      <div class="hist-ops">
        <button class="btn tiny ghost" data-act="toggle">编辑</button>
        <button class="btn tiny ghost" data-act="open">去日报页继续写</button>
      </div>
    </div>
    <div class="hist-view">${histViewHtml(r)}</div>
    <div class="hist-edit hidden"></div>`;
  return item;
}

function ensureHistoryEditor(item, r) {
  const box = item.querySelector('.hist-edit');
  if (!box.dataset.built) {
    box.innerHTML = `
      <div class="hist-entries"></div>
      <button type="button" class="btn tiny ghost" data-act="add-entry">+ 添加任务</button>
      <div class="hist-day-note">
        <label class="field-label eg-note-label">补充说明（整天）</label>
        <textarea class="hist-day-note-input" rows="3" placeholder="今天整体的备注、心得、明天要接着做的事……"></textarea>
      </div>
      <div class="hist-edit-footer">
        <span class="muted small">工作条目按任务分组，每组有自己的补充说明</span>
        <span class="hist-edit-actions">
          <button class="btn tiny ghost" data-act="cancel">取消</button>
          <button class="btn tiny primary" data-act="save">保存</button>
        </span>
      </div>`;
    const entriesBox = box.querySelector('.hist-entries');
    renderGroups(entriesBox, r.entries, r.notes);
    // 回填「整天补充说明」（「日报」页写的、此前在历史里看不到的那部分）
    const dayNoteEl = box.querySelector('.hist-day-note-input');
    if (dayNoteEl) dayNoteEl.value = (r.content || '').trim();
    // 基线快照：记录"服务器上已保存的样子"，用来判断有没有未保存的改动
    box.dataset.baseline = snapshotOf(box);
    box.querySelector('[data-act="add-entry"]').addEventListener('click', () => {
      entriesBox.appendChild(makeGroup()); // 新增分组：任务可下拉选择
    });
    box.dataset.built = '1';
  }
  return box;
}

/** 表单当前内容的规范化快照（工作条目 + 任务说明 + 整天补充说明，用于比较是否被改动过） */
function snapshotOf(editBox) {
  if (!editBox) return JSON.stringify({ entries: [], notes: [], content: '' });
  const { entries, notes } = collectGroups(editBox.querySelector('.hist-entries'));
  const dayNoteEl = editBox.querySelector('.hist-day-note-input');
  return JSON.stringify({ entries, notes, content: dayNoteEl ? dayNoteEl.value.trim() : '' });
}

/** 当前展开的编辑区里有没有还没保存的改动 */
function historyHasUnsaved() {
  if (!historyOpenDate) return false;
  const item = document.querySelector(`.hist-item[data-date="${historyOpenDate}"]`);
  if (!item) return false;
  const box = item.querySelector('.hist-edit');
  if (!box || !box.dataset.built || box.classList.contains('hidden')) return false;
  return snapshotOf(box) !== box.dataset.baseline;
}

/** 有未保存改动时先问一句；返回 true 表示可以继续 */
function guardUnsaved(msg) {
  if (!historyHasUnsaved()) return true;
  return confirm(msg || '这天日报有未保存的修改，继续会丢弃它们，确定吗？');
}

/** 把某天的编辑区恢复成服务器上已保存的样子，并把基线重置回去 */
function revertHistoryEditor(date) {
  const item = document.querySelector(`.hist-item[data-date="${date}"]`);
  if (!item) return;
  const box = item.querySelector('.hist-edit');
  if (!box || !box.dataset.built) return;
  const r = historyData.get(date) || {};
  const entriesBox = box.querySelector('.hist-entries');
  renderGroups(entriesBox, r.entries || [], r.notes || []);
  const dayNoteEl = box.querySelector('.hist-day-note-input');
  if (dayNoteEl) dayNoteEl.value = (r.content || '').trim();
  box.dataset.baseline = snapshotOf(box);
}

/** 收起某天的编辑区（不改内容） */
function collapseHistoryItem(date) {
  const item = document.querySelector(`.hist-item[data-date="${date}"]`);
  if (!item) return;
  const box = item.querySelector('.hist-edit');
  if (box) box.classList.add('hidden');
  const btn = item.querySelector('[data-act="toggle"]');
  if (btn) btn.textContent = '编辑';
  if (historyOpenDate === date) historyOpenDate = null;
}

function toggleHistoryItem(date) {
  const item = document.querySelector(`.hist-item[data-date="${date}"]`);
  if (!item) return;
  const edit = ensureHistoryEditor(item, historyData.get(date));
  const toggleBtn = item.querySelector('[data-act="toggle"]');

  if (!edit.classList.contains('hidden')) {
    // 收起：有未保存改动先确认，确认后恢复成已保存的样子
    if (!guardUnsaved('这天日报有未保存的修改，收起后会恢复成已保存的样子，确定吗？')) return;
    revertHistoryEditor(date);
    collapseHistoryItem(date);
    return;
  }
  // 展开另一天前：先把别的开着的收起来（有未保存改动先确认）
  if (historyOpenDate && historyOpenDate !== date) {
    if (!guardUnsaved('另一天的日报有未保存的修改，继续会丢弃它们，确定吗？')) return;
    const prev = historyOpenDate;
    revertHistoryEditor(prev);
    collapseHistoryItem(prev);
  }
  edit.classList.remove('hidden');
  toggleBtn.textContent = '收起';
  historyOpenDate = date;
  // 基线只在编辑区首次构建时记录，展开/收起不会重置它
}

/** 取消：丢弃本次改动，恢复成服务器上已保存的样子（保持展开） */
function cancelHistoryEdit(date) {
  const item = document.querySelector(`.hist-item[data-date="${date}"]`);
  if (!item) return;
  if (historyHasUnsaved() && !confirm('丢弃未保存的修改，恢复成已保存的样子？')) return;
  revertHistoryEditor(date);
  toast('已还原');
}

async function saveHistoryItem(date) {
  const item = document.querySelector(`.hist-item[data-date="${date}"]`);
  if (!item) return;
  const box = item.querySelector('.hist-edit');
  const entriesBox = box.querySelector('.hist-entries');
  const saveBtn = box.querySelector('[data-act="save"]');
  const { entries, notes } = collectGroups(entriesBox);
  const dayNoteEl = box.querySelector('.hist-day-note-input');
  const content = dayNoteEl ? dayNoteEl.value : '';
  // 条目、任务说明与整天补充说明全空 → 这天的日报将被整条删除，先确认
  const empty = !entries.length && !notes.length && !content.trim();
  if (empty && !confirm('工作条目与补充说明都空了。保存后这天的日报会被整条删除，确定吗？')) return;

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
  try {
    await api.send('/api/reports', 'POST', { date, entries, notes, content, purge: empty });
    historyJustSaved = { date, at: new Date() };
    historyOpenDate = null; // 保存后收起编辑区，回到只读视图看结果
    toast(empty ? '已清空并删除这天' : '已保存');
    await loadHistory();
  } catch (err) {
    toast(err.message);
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
  }
}

/** 从日报历史跳到「日报」页：定位到那天继续追加（表单会复位成空白，不动已保存内容） */
function openReportDate(date) {
  const pending = collectEntries($('#report-entries')).length || $('#report-content').value.trim();
  if (pending && !confirm('「日报」页还有没保存的内容，切过去会清空，继续吗？')) return;
  if (!guardUnsaved('日报历史里有未保存的修改，切走会丢弃它们，确定吗？')) return;
  $('#report-date').value = date;
  currentReportDate = date;
  reportFormDate = null; // 强制把表单复位成空白
  applyView('report');
}

async function loadHistory() {
  allTasks = await api.get('/api/tasks'); // 供条目选择关联任务
  const { reports } = await api.get('/api/reports');

  historyData.clear();
  reports.forEach((r) => historyData.set(r.report_date, r));

  const box = $('#history-list');
  box.innerHTML = '';
  $('#history-empty').classList.toggle('hidden', reports.length > 0);

  let group = null;
  for (const r of reports) {
    const ml = monthLabel(r.report_date);
    if (ml !== group) {
      group = ml;
      const h = document.createElement('div');
      h.className = 'hist-group-title';
      h.textContent = ml;
      box.appendChild(h);
    }
    box.appendChild(buildHistoryItem(r));
  }
  if (historyOpenDate && historyData.has(historyOpenDate)) toggleHistoryItem(historyOpenDate);
}

$('#history-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const item = e.target.closest('.hist-item');
  if (!item) return;
  const date = item.dataset.date;
  const act = btn.dataset.act;
  if (act === 'toggle') toggleHistoryItem(date);
  else if (act === 'open') openReportDate(date);
  else if (act === 'cancel') cancelHistoryEdit(date);
  else if (act === 'save') await saveHistoryItem(date);
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

/* ---------- 计时器实时走字 ---------- */
// 只更新正在计时的卡片：本段耗时（自段开始）与累计耗时（基准值 + 流逝时间）。
// 暂停/完成的卡片是静态值，不参与。
function tickTimers() {
  const now = Date.now();
  document.querySelectorAll('.live-seg').forEach((el) => {
    const since = Number(el.dataset.since);
    if (Number.isFinite(since)) el.textContent = fmtClock(now - since);
  });
  document.querySelectorAll('.live-total').forEach((el) => {
    const base = Number(el.dataset.baseMs);
    const at = Number(el.dataset.baseAt);
    if (Number.isFinite(base) && Number.isFinite(at)) el.textContent = fmtClock(base + (now - at));
  });
}

/* ---------- 初始化 ---------- */
$('#report-date').value = todayStr();
(async function init() {
  await loadTasks();
  await loadReminders();
  await loadReport();
  // 每 60 秒刷新一次提醒
  setInterval(loadReminders, 60000);
  // 每 1 秒刷新一次正在计时的卡片
  setInterval(tickTimers, 1000);
})();

/* ============================ 小樱魔法特效 ============================ */
/* 动效开关：默认开；关闭时给 <html> 加 .no-motion（可覆盖系统「减少动态」） */
const MOTION_KEY = 'wm-motion';
function motionOn() { return !document.documentElement.classList.contains('no-motion'); }
function setMotion(on) {
  document.documentElement.classList.toggle('no-motion', !on);
  try { localStorage.setItem(MOTION_KEY, on ? 'on' : 'off'); } catch (e) {}
  const btn = document.getElementById('btn-motion');
  if (btn) btn.textContent = on ? '✦ 动效：开' : '✦ 动效：关';
}
(function initMotion() {
  let on = true;
  try { on = localStorage.getItem(MOTION_KEY) !== 'off'; } catch (e) {}
  setMotion(on);
  const btn = document.getElementById('btn-motion');
  if (btn) btn.addEventListener('click', () => {
    const next = !motionOn();
    setMotion(next);
    toast(next ? '动效已开启 ✦' : '动效已关闭');
  });
})();

/* 樱花瓣：纯 DOM + CSS 动画，数量随屏宽自适应 */
(function sakuraPetals() {
  const layer = document.getElementById('petal-layer');
  if (!layer) return;
  const count = window.innerWidth < 820 ? 6 : 10;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('i');
    p.className = 'petal';
    p.style.left = (Math.random() * 100).toFixed(1) + '%';
    const size = (9 + Math.random() * 7).toFixed(1);
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.animationDuration = (11 + Math.random() * 10).toFixed(1) + 's';
    p.style.animationDelay = (-Math.random() * 20).toFixed(1) + 's';
    layer.appendChild(p);
  }
})();

/* 星空：随机撒点，各自闪烁（大小/亮度/周期/相位都随机，避免"齐闪"） */
(function starField() {
  const layer = document.getElementById('starfield');
  if (!layer) return;
  const n = window.innerWidth < 820 ? 18 : 38;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const s = document.createElement('i');
    s.className = 'star';
    s.style.left = (Math.random() * 100).toFixed(2) + '%';
    s.style.top = (Math.random() * 100).toFixed(2) + '%';
    s.style.setProperty('--s', (1 + Math.random() * 2.2).toFixed(1) + 'px');
    s.style.setProperty('--o', (.35 + Math.random() * .6).toFixed(2));
    s.style.setProperty('--d', (1.8 + Math.random() * 3.4).toFixed(1) + 's');
    s.style.setProperty('--dl', (-Math.random() * 5).toFixed(1) + 's');
    frag.appendChild(s);
  }
  layer.appendChild(frag);
})();

/* 流星：几条不同周期/相位的划过光尾 */
(function shootingStars() {
  const layer = document.getElementById('starfield');
  if (!layer) return;
  for (let i = 0; i < 2; i++) {
    const el = document.createElement('i');
    el.className = 'shooting';
    el.style.left = (-10 + Math.random() * 20) + '%';
    el.style.top = (Math.random() * 40) + '%';
    el.style.setProperty('--d', (8 + Math.random() * 8).toFixed(1) + 's');
    el.style.setProperty('--dl', (i * 3 + Math.random() * 4).toFixed(1) + 's');
    layer.appendChild(el);
  }
})();

/* 漂浮光尘：缓缓上升的魔法微光 */
(function magicDust() {
  const layer = document.getElementById('dust-layer');
  if (!layer) return;
  const n = window.innerWidth < 820 ? 6 : 12;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const d = document.createElement('i');
    d.className = 'dust';
    d.style.left = (Math.random() * 100).toFixed(2) + '%';
    d.style.setProperty('--s', (3 + Math.random() * 5).toFixed(1) + 'px');
    d.style.setProperty('--o', (.35 + Math.random() * .5).toFixed(2));
    d.style.setProperty('--d', (12 + Math.random() * 12).toFixed(1) + 's');
    d.style.setProperty('--dl', (-Math.random() * 20).toFixed(1) + 's');
    d.style.setProperty('--dx', (-40 + Math.random() * 80).toFixed(0) + 'px');
    frag.appendChild(d);
  }
  layer.appendChild(frag);
})();

/* 打卡 / 完成：在按钮处迸发一圈星芒 */
function burstStars(cx, cy) {
  if (!motionOn()) return;
  const N = 10;
  for (let i = 0; i < N; i++) {
    const s = document.createElement('span');
    s.className = 'burst-star';
    const ang = (Math.PI * 2 * i) / N + Math.random() * 0.3;
    const dist = 46 + Math.random() * 42;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
    s.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
    s.style.animationDelay = (Math.random() * 0.08).toFixed(2) + 's';
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}
/* 事件委托触发（不侵入原有点击逻辑）：点「打卡 / 完成」时点亮星芒 */
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="finish"]');
  if (!b) return;
  const r = b.getBoundingClientRect();
  burstStars(r.left + r.width / 2, r.top + r.height / 2);
});
