/**
 * 业务工具函数：提醒触发时间计算、任务状态推导、日期处理。
 */

/** 取本地日期字符串 YYYY-MM-DD */
function toDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 当前时间 ISO 字符串 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * 根据提醒类型计算实际触发时刻。
 * @param {'relative'|'absolute'} type
 * @param {string} value  相对：如 '-1d','-2h','+1d'（正负号表示截止前/后）；绝对：ISO 时间
 * @param {string} deadline 任务的截止时间 ISO
 * @returns {string} 触发时刻 ISO
 */
function calcTriggerAt(type, value, deadline) {
  if (type === 'absolute') {
    // 绝对时间：value 本身就是触发时刻
    return new Date(value).toISOString();
  }
  // 相对偏移：value 形如 '-1d' / '-2h' / '-30m'（'+' 表示截止后）
  if (!deadline) {
    throw new Error('相对提醒需要任务有截止时间');
  }
  const m = /^([+-]?\d+)([dhm])$/.exec(String(value).trim());
  if (!m) {
    throw new Error(`无法解析偏移量: ${value}，正确格式如 -1d / -2h / -30m`);
  }
  const num = parseInt(m[1], 10);
  const unit = m[2];
  const unitMs = { d: 86400000, h: 3600000, m: 60000 }[unit];
  const base = new Date(deadline).getTime();
  return new Date(base + num * unitMs).toISOString();
}

/**
 * 推导任务的状态。
 * 存储的 status 只有 未开始/进行中/已完成 三种；
 * "已逾期" 是根据截止时间 + 是否完成动态计算的展示状态。
 */
function deriveStatus(task) {
  if (task.status === '已完成') return '已完成';
  // 未完成时，判断是否超过截止时间
  if (task.deadline && new Date(task.deadline).getTime() < Date.now()) {
    return '已逾期';
  }
  return task.status || '未开始';
}

/**
 * 给任务对象附加计算字段。
 * @param {object} task 任务行
 * @param {number} [totalMs] 该任务累计耗时（所有打卡段之和，含进行中会话）；不传则 total_duration_ms 为 null
 * @param {{openStart?:string|null, lastSegMs?:number|null}} [seg]
 *        计时段信息：openStart=当前未结束段的开始时间（有=正在计时）；
 *        lastSegMs=最近一段已结束的时长（用于「本段耗时」）
 */
function decorateTask(task, totalMs, seg) {
  if (!task) return task;
  const out = { ...task };
  out.display_status = deriveStatus(task);

  const openStart = seg && seg.openStart ? seg.openStart : null;
  // 是否正在计时（存在未结束的打卡段）。与 status 正交：暂停时 status 仍是「进行中」，但不再计时。
  out.timer_running = !!openStart;
  out.open_start = openStart;

  // 本段耗时：正在计时 → 现在 - 本段开始；否则 → 最近一段的实际时长
  if (openStart) {
    const ms = Date.now() - new Date(openStart).getTime();
    out.actual_duration_ms = Number.isFinite(ms) && ms >= 0 ? ms : null;
  } else if (seg && typeof seg.lastSegMs === 'number') {
    out.actual_duration_ms = seg.lastSegMs;
  } else if (task.actual_start && task.actual_end) {
    out.actual_duration_ms =
      new Date(task.actual_end).getTime() - new Date(task.actual_start).getTime();
  } else {
    out.actual_duration_ms = null;
  }

  // 累计耗时：全部打卡段之和（由调用方聚合后传入）
  out.total_duration_ms = (typeof totalMs === 'number') ? totalMs : null;
  return out;
}

module.exports = { toDateStr, nowISO, calcTriggerAt, deriveStatus, decorateTask };
