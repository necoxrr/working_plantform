/**
 * 极简访问口令（个人自用自托管场景）
 *
 * 设计要点：
 *  - 口令**只在服务端校验**，绝不下发到前端；浏览器只拿到一个由口令派生的令牌 cookie。
 *  - 通过一次后发长期 cookie（1 年），电脑 / 手机各输一次即可，之后免输。
 *  - 修改口令：设置环境变量 ACCESS_PASSWORD；未设置时用下面的 DEFAULT_PASSWORD。
 *  - 未通过校验：API 返回 401，页面跳转到 /login.html。
 */
const crypto = require('node:crypto');

// 默认口令（可改；也可以通过 ACCESS_PASSWORD 环境变量覆盖）
const DEFAULT_PASSWORD = 'workbuddy-2026';
const PASSWORD = process.env.ACCESS_PASSWORD || DEFAULT_PASSWORD;

const COOKIE_NAME = 'wb_key';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 365 天

// 用口令派生令牌，cookie 里不出现明文口令
const TOKEN = crypto.createHash('sha256').update('wb-access::' + PASSWORD).digest('hex');

// 免登录路径：登录页自身 + 登录接口 + 健康检查
//
// 健康检查必须免登录：托管平台（Render / Northflank / Railway …）会用一个
// 不带 Cookie 的 GET 探测服务是否存活，返回 401 会被判定为「部署失败」并反复重启。
// 因此 /api/health 放行，但接口内只对已登录用户暴露存储细节（见 index.js）。
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/api/health']);

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  return token === TOKEN;
}

/** 恒定时间比较，避免时序侧信道 */
function checkPassword(pw) {
  if (typeof pw !== 'string') return false;
  const a = Buffer.from(pw);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setAuthCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${TOKEN}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

/** 访问口令中间件 */
function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path) || isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '未登录' });
  }
  return res.redirect('/login.html');
}

module.exports = {
  requireAuth,
  checkPassword,
  setAuthCookie,
  clearAuthCookie,
  isAuthed,
  usingDefaultPassword: !process.env.ACCESS_PASSWORD,
};
