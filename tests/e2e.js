/**
 * 端到端回归测试
 *
 * 对「正在运行的服务」打一遍完整业务流，全部断言基于 HTTP 响应 + 服务端读回的持久化结果：
 *   认证 → 任务增删改 → 提醒（含「编辑保存不重置已读」）→ 打卡起停 → 日报 → 导入导出 → 并发写 → 错误处理
 *
 * 用法（先启动服务，再跑；两种存储模式共用这一套断言）：
 *   BASE=http://127.0.0.1:3260 node tests/e2e.js
 *   BASE=http://127.0.0.1:3270 EXPECT_DRIVER=local E2E_PASSWORD=xxx node tests/e2e.js
 *
 * 环境变量：
 *   BASE            被测服务地址（默认 http://127.0.0.1:3000）
 *   EXPECT_DRIVER   期望的存储驱动 local / remote（默认 local）
 *   E2E_PASSWORD    访问口令（默认 workbuddy-2026）
 *   BASELINE_TASKS  跑之前已存在的任务数（默认 0）；测试会临时增删，结束后恢复到这个数
 *
 * 注意：本脚本会往被测库里写测试数据并在结束时清理。**不要对着正在使用的正式实例跑。**
 */
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const EXPECT_DRIVER = process.env.EXPECT_DRIVER || 'local';
const PASSWORD = process.env.E2E_PASSWORD || 'workbuddy-2026';
const BASELINE_TASKS = Number(process.env.BASELINE_TASKS || 0);

let COOKIE = '';
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  ✔ ' + label);
  } else {
    fail += 1;
    failures.push(label + (extra ? ' → ' + extra : ''));
    console.log('  ✘ ' + label + (extra ? ' → ' + extra : ''));
  }
}

function section(title) {
  console.log('\n【' + title + '】');
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, COOKIE ? { Cookie: COOKIE } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.get('set-cookie');
  if (setC) COOKIE = setC.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 HTML 404 页）保持 null */ }
  return { status: res.status, json, text };
}

const iso = (d) => new Date(d).toISOString();
const localDateStr = () => {
  const x = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};

(async () => {
  console.log(`\n端到端测试 → ${BASE}（期望驱动：${EXPECT_DRIVER}）`);

  section('1 认证');
  let r = await req('GET', '/api/tasks');
  ok(r.status === 401, '未登录访问接口被拦截', 'status=' + r.status);
  r = await req('POST', '/api/login', { password: PASSWORD });
  ok(r.json && r.json.ok === true, '登录成功');
  r = await req('GET', '/api/health');
  ok(r.json && r.json.ok === true, '健康检查通过');
  ok(r.json && r.json.driver === EXPECT_DRIVER, '驱动符合预期（' + EXPECT_DRIVER + '）', JSON.stringify(r.json));
  ok(r.json && r.json.storage === (EXPECT_DRIVER === 'remote' ? 'turso/libSQL' : 'local-file'),
    '存储标识正确', r.json && r.json.storage);

  section('2 任务列表读回');
  r = await req('GET', '/api/tasks');
  const baseTasks = r.json;
  ok(Array.isArray(baseTasks), '返回数组');
  ok(baseTasks.length === BASELINE_TASKS, `基线任务数 ${BASELINE_TASKS}`, '实际 ' + baseTasks.length);
  ok(baseTasks.every((t) => t.id != null && t.title), '每条任务都有 id 与标题');

  section('3 新建任务 + 时间字段落库');
  const s = new Date(Date.now() + 3600e3);
  const e = new Date(Date.now() + 7200e3);
  const dl = iso(new Date(Date.now() + 86400e3));
  r = await req('POST', '/api/tasks', {
    title: '【E2E】测试任务',
    description: '自动化测试用，结束会删除',
    plan_start: iso(s), plan_end: iso(e), deadline: dl,
    important: true, urgent: false,
    reminders: [{ type: 'relative', value: '-1h' }, { type: 'relative', value: '-10m' }],
  });
  const tid = r.json && r.json.id;
  ok(!!tid, '创建成功并返回 id', JSON.stringify(r.json).slice(0, 200));

  r = await req('GET', '/api/tasks');
  let mine = r.json.find((t) => t.id === tid);
  ok(!!mine, '新任务出现在列表里');
  ok(mine && mine.plan_start === iso(s), 'plan_start 落库正确');
  ok(mine && (mine.important === 1 || mine.important === true), '重要标记落库');
  ok(r.json.length === BASELINE_TASKS + 1, '任务数 +1', '实际 ' + r.json.length);

  section('4 编辑任务的三个时间');
  const s2 = new Date(Date.now() + 5400e3);
  const e2 = new Date(Date.now() + 10800e3);
  const dl2 = iso(new Date(Date.now() + 90000e3));
  r = await req('PUT', '/api/tasks/' + tid, {
    title: '【E2E】测试任务', description: '自动化测试用，结束会删除',
    plan_start: iso(s2), plan_end: iso(e2), deadline: dl2,
    status: '未开始', important: true, urgent: true,
  });
  ok(r.status === 200 && !(r.json && r.json.error), 'PUT 成功', JSON.stringify(r.json).slice(0, 200));
  r = await req('GET', '/api/tasks');
  mine = r.json.find((t) => t.id === tid);
  ok(mine && new Date(mine.plan_start).getTime() === s2.getTime(), '新的计划开始时间已生效', mine && mine.plan_start);
  ok(mine && new Date(mine.plan_end).getTime() === e2.getTime(), '新的计划结束时间已生效', mine && mine.plan_end);
  ok(mine && new Date(mine.deadline).getTime() === new Date(dl2).getTime(), '新的截止时间已生效', mine && mine.deadline);
  ok(mine && (mine.urgent === 1 || mine.urgent === true), '紧急标记改为真');

  section('5 提醒：编辑保存不重置已读');
  const remApi = () => req('GET', `/api/tasks/${tid}/reminders`).then((x) => x.json || []);
  let rems = await remApi();
  ok(rems.length === 2, '自动生成了 2 条提醒', '实际 ' + rems.length);
  ok(rems.every((x) => x.trigger_at), '每条提醒都有触发时刻');
  // 前端保存时【一定会】把提醒原样回传 —— 这是「改个标题提醒又弹出来」的复现条件
  const asForm = () => rems.map((x) => ({ type: x.type, value: x.value }));

  r = await req('PUT', '/api/tasks/' + tid, {
    title: '【E2E】测试任务', description: '自动化测试用，结束会删除',
    plan_start: iso(s2), plan_end: iso(e2), deadline: dl2,
    status: '未开始', important: true, urgent: true, reminders: asForm(),
  });
  ok(r.status === 200 && !r.json.error, '基线保存成功', JSON.stringify(r.json).slice(0, 160));
  rems = await remApi();

  await req('POST', `/api/reminders/${rems[0].id}/read`, {});
  const readId = rems[0].id;
  rems = await remApi();
  ok((rems.find((x) => x.id === readId) || {}).is_read === 1, '标记已读成功');

  const beforeIds = rems.map((x) => x.id).sort().join(',');
  const beforeTriggers = rems.map((x) => x.trigger_at).sort().join(',');
  await req('PUT', '/api/tasks/' + tid, {
    title: '【E2E】测试任务（改标题）', description: '改一下描述',
    plan_start: iso(s2), plan_end: iso(e2), deadline: dl2,
    status: '未开始', important: true, urgent: true, reminders: asForm(),
  });
  const rems2 = await remApi();
  ok(rems2.map((x) => x.id).sort().join(',') === beforeIds, '只改标题/描述时提醒行未被重建',
    rems2.map((x) => x.id).join(',') + ' vs ' + beforeIds);
  ok(rems2.map((x) => x.trigger_at).sort().join(',') === beforeTriggers, '触发时刻未变');
  ok((rems2.find((x) => x.id === readId) || {}).is_read === 1, '已读状态被保留（没有重新弹出来）',
    JSON.stringify(rems2));

  // 界面时间控件只有分钟精度：库里若存了带秒的截止时间，编辑一次会丢秒
  const base = Math.floor((Date.now() + 95000e3) / 60000) * 60000;
  const dl3 = new Date(base + 37437).toISOString();
  const dl3Ui = new Date(base).toISOString();
  await req('PUT', '/api/tasks/' + tid, {
    title: '【E2E】测试任务（改标题）', description: '改一下描述',
    plan_start: iso(s2), plan_end: iso(e2), deadline: dl3,
    status: '未开始', important: true, urgent: true, reminders: asForm(),
  });
  rems = await remApi();
  const idsAfterDl3 = rems.map((x) => x.id).sort().join(',');
  await req('POST', `/api/reminders/${rems[0].id}/read`, {});
  const readId3 = rems[0].id;
  await req('PUT', '/api/tasks/' + tid, {
    title: '【E2E】测试任务（改标题）', description: '改一下描述',
    plan_start: iso(s2), plan_end: iso(e2), deadline: dl3Ui, // 只丢了几十秒
    status: '未开始', important: true, urgent: true, reminders: asForm(),
  });
  const rems3 = await remApi();
  ok(rems3.map((x) => x.id).sort().join(',') === idsAfterDl3, '秒级抖动（界面往返丢秒）不触发提醒重建',
    rems3.map((x) => x.id).join(',') + ' vs ' + idsAfterDl3);
  ok((rems3.find((x) => x.id === readId3) || {}).is_read === 1, '秒级抖动时已读状态也保留',
    JSON.stringify(rems3.map((x) => x.id + ':' + x.is_read)));

  // 真正改截止时间 → 相对提醒的触发时刻必须跟着重算，并恢复未读
  const dl4 = iso(new Date(Date.now() + 260000e3));
  await req('PUT', '/api/tasks/' + tid, {
    title: '【E2E】测试任务（改截止）', description: '改一下描述',
    plan_start: iso(s2), plan_end: iso(e2), deadline: dl4,
    status: '未开始', important: true, urgent: true, reminders: asForm(),
  });
  const rems4 = await remApi();
  const expected = new Date(new Date(dl4).getTime() - 3600e3).toISOString();
  ok(rems4.length === 2, '改截止后提醒仍是 2 条', '实际 ' + rems4.length);
  ok(rems4.some((x) => x.value === '-1h' && x.trigger_at === expected),
    '改了截止时间后相对提醒的触发时刻已重算',
    JSON.stringify(rems4.map((x) => x.value + '@' + x.trigger_at)) + ' 期望 -1h@' + expected);
  ok(rems4.every((x) => x.is_read === 0), '重算后的提醒恢复未读（该重新提醒）',
    JSON.stringify(rems4.map((x) => x.is_read)));

  section('6 打卡：开始 / 暂停 / 完成');
  r = await req('POST', `/api/tasks/${tid}/start`, {});
  ok(r.status === 200 && !(r.json && r.json.error), '开始打卡', JSON.stringify(r.json).slice(0, 160));
  r = await req('GET', '/api/tasks');
  mine = r.json.find((t) => t.id === tid);
  ok(mine && mine.actual_start, 'actual_start 已写入');
  ok(mine && mine.status === '进行中', '状态变为进行中', mine && mine.status);

  r = await req('POST', `/api/tasks/${tid}/pause`, {});
  ok(r.status === 200 && !(r.json && r.json.error), '暂停打卡', JSON.stringify(r.json).slice(0, 160));
  r = await req('POST', `/api/tasks/${tid}/stop`, {});
  ok(r.status === 200 && !(r.json && r.json.error), '完成打卡', JSON.stringify(r.json).slice(0, 160));
  r = await req('GET', '/api/tasks');
  mine = r.json.find((t) => t.id === tid);
  ok(mine && mine.status === '已完成', '状态变为已完成', mine && mine.status);
  ok(mine && Number(mine.total_duration_ms) > 0, '累计耗时已统计', mine && mine.total_duration_ms);

  section('7 提醒闸门：已完成的任务不再提醒');
  r = await req('GET', '/api/reminders/pending');
  const pend = r.json || [];
  ok(!pend.some((x) => x.task_id === tid), '已完成任务的提醒不在待提醒列表里',
    JSON.stringify(pend.filter((x) => x.task_id === tid)).slice(0, 160));

  section('8 日报：工作条目 + 整天补充说明 + 任务备注');
  const today = localDateStr();
  r = await req('POST', '/api/reports', {
    date: today,
    content: '【E2E】今天的整天补充说明',
    entries: [{ task_id: tid, content: '【E2E】做联调' }],
    notes: [{ task_id: tid, note: '【E2E】这条任务的备注' }],
  });
  ok(r.status === 200 && !(r.json && r.json.error), '保存日报成功', JSON.stringify(r.json).slice(0, 200));
  r = await req('GET', '/api/reports/' + today);
  const rep = r.json;
  ok(rep && rep.content === '【E2E】今天的整天补充说明', '整天补充说明读回正确', rep && rep.content);
  ok(Array.isArray(rep.entries) && rep.entries.some((x) => x.content === '【E2E】做联调'), '工作条目读回正确');
  ok(Array.isArray(rep.notes) && rep.notes.some((x) => x.note === '【E2E】这条任务的备注'), '任务备注读回正确');

  section('9 导出 / 导入');
  r = await req('GET', '/api/export');
  const dump = r.json;
  ok(dump && Array.isArray(dump.tasks), '导出包含 tasks 数组');
  ok(dump && dump.tasks.length === BASELINE_TASKS + 1, '导出任务数正确', dump && dump.tasks.length);
  ok(dump && Array.isArray(dump.work_logs) && dump.work_logs.length >= 1, '导出包含打卡记录');

  section('10 删除任务 + 级联');
  r = await req('DELETE', '/api/tasks/' + tid);
  ok(r.status === 200 && !(r.json && r.json.error), '删除成功', JSON.stringify(r.json).slice(0, 160));
  r = await req('GET', '/api/tasks');
  ok(r.json.length === BASELINE_TASKS, '任务数恢复基线', '实际 ' + r.json.length);
  ok(!r.json.some((t) => t.id === tid), '被删任务不在列表里');
  ok((await remApi()).length === 0, '该任务的提醒已级联删除');
  // 清理日报，避免留下测试数据
  await req('POST', '/api/reports', { date: today, purge: true });

  section('11 并发写入');
  const created = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      req('POST', '/api/tasks', { title: '【E2E】并发' + i, description: '', status: '未开始' })
        .then((x) => x.json && x.json.id))
  );
  ok(created.every((x) => x != null), '5 个并发创建都返回了 id', JSON.stringify(created));
  ok(new Set(created).size === 5, '5 个 id 互不相同', JSON.stringify(created));
  r = await req('GET', '/api/tasks');
  ok(r.json.length === BASELINE_TASKS + 5, '任务数正确', '实际 ' + r.json.length);
  for (const id of created) await req('DELETE', '/api/tasks/' + id);
  r = await req('GET', '/api/tasks');
  ok(r.json.length === BASELINE_TASKS, '清理后恢复基线', '实际 ' + r.json.length);

  section('12 错误处理');
  r = await req('GET', '/api/tasks/not-a-number');
  ok(r.json != null, '非法路径参数返回 JSON 而不是 HTML', r.text.slice(0, 120));

  console.log('\n══════════════════════════════════');
  console.log(`  通过 ${pass} / ${pass + fail}`);
  if (fail) {
    console.log('  失败项：');
    failures.forEach((f) => console.log('    · ' + f));
  }
  console.log('══════════════════════════════════\n');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('测试脚本异常: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
