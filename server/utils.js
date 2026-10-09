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
 * @param {string} value  相对：如 '-1d','-2h'；绝对：ISO 时间
 * @param {string} deadline 任务的截止时间 ISO
 * @returns {string} 触发时刻 ISO
 */
function calcTriggerAt(type, value, deadline) {
  if (type === 'absolute') {
    // 绝对时间：value 本身就是触发时刻
    return new Date(value).toISOString();
  }
  // 相对偏移：value 形如 '-1d' / '-2h' / '-30m'
  if (!deadline) {
    throw new Error('相对提醒需要任务有截止时间');
  }
  const m = /^(-?\d+)([dhm])$/.exec(String(value).trim());
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

/** 给任务对象附加计算字段 */
function decorateTask(task) {
  if (!task) return task;
  const out = { ...task };
  out.display_status = deriveStatus(task);
  // 实际耗时
  if (task.actual_start && task.actual_end) {
    out.actual_duration_ms =
      new Date(task.actual_end).getTime() - new Date(task.actual_start).getTime();
  } else {
    out.actual_duration_ms = null;
  }
  return out;
}

module.exports = { toDateStr, nowISO, calcTriggerAt, deriveStatus, decorateTask };
