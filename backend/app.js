import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { account, customer, distance, fail, normalize, password, text, image } from './validation.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fields = 'c.id,c.name,c.source,c.status,c.sales_id,c.note,c.created_at,c.updated_at,c.avatar_hash,u.name AS sales_name';
const own = (user, alias = 'c') => ({ sql: user.role === 'admin' ? 'TRUE' : `${alias}.sales_id=$1`, args: user.role === 'admin' ? [] : [user.id] });
const publicUser = u => ({ id: u.id, name: u.name, username: u.username, role: u.role, active: u.active, must_change_password: u.must_change_password });
function publicCustomer(c) { return { ...c, avatar: undefined, avatar_dhash: undefined, normalized_name: undefined, avatar_url: c.avatar_hash ? `/api/customers/${encodeURIComponent(c.id)}/avatar?v=${c.avatar_hash}` : '' }; }
export async function initialize(pool, env = process.env) {
  await pool.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(9001001)');
    const r = await c.query("SELECT id FROM users WHERE role='admin'");
    if (!r.rows.length) {
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 20) fail('首次启动需要设置至少 20 位随机 ADMIN_PASSWORD');
      const u = account({ name: '管理员', username: env.ADMIN_USERNAME || 'admin' });
      await c.query('INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,$3,$4,$5)', [randomUUID(), u.name, u.username, await bcrypt.hash(password(env.ADMIN_PASSWORD), 12), 'admin']);
    }
    const legacy = await c.query("SELECT id,name FROM customers WHERE normalized_name=''");
    for (const x of legacy.rows) await c.query('UPDATE customers SET normalized_name=$1 WHERE id=$2', [normalize(x.name), x.id]);
    await c.query('DELETE FROM sessions WHERE expires_at<NOW()');
    await c.query('DELETE FROM restore_previews WHERE expires_at<NOW()');
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
export function createApp(pool, { production = false } = {}) {
  const app = express(); app.set('trust proxy', 1); app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://esm.sh'], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', 'blob:'], workerSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'", 'https://esm.sh', 'https://huggingface.co', 'https://*.huggingface.co', 'https://*.hf.co', 'https://cdn-lfs.hf.co'],
    upgradeInsecureRequests: production ? [] : null
  } }, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '40mb' })); app.use(cookieParser());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let url; try { url = new URL(req.headers.origin); } catch { return res.status(403).json({ error: '请求来源不正确' }); }
      if (url.host !== req.get('host')) return res.status(403).json({ error: '请求来源不正确' });
    }
    next();
  });
  app.get('/health', wrap(async (req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }));
  const auth = wrap(async (req, res, next) => {
    const token = req.cookies.cr_session;
    if (!token || typeof token !== 'string') fail('请登录后继续', 401);
    const r = await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>NOW() AND u.active=TRUE', [hash(token)]);
    if (!r.rows.length) fail('会话已失效，请重新登录', 401);
    req.user = r.rows[0]; next();
  });
  const ready = (req, res, next) => req.user.must_change_password ? res.status(403).json({ error: '请先修改初始密码', code: 'CHANGE_PASSWORD' }) : next();
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: '仅管理员可以操作' });
  app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '登录尝试过多，请稍后再试' } }), wrap(async (req, res) => {
    const username = text(req.body.username, '账号', 40, true).toLowerCase();
    if (typeof req.body.password !== 'string' || req.body.password.length > 128) fail('账号或密码错误', 401);
    const r = await pool.query('SELECT * FROM users WHERE lower(username)=$1', [username]), u = r.rows[0];
    if (!u || !u.active || !await bcrypt.compare(req.body.password, u.password_hash)) fail('账号或密码错误', 401);
    const token = randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')", [hash(token), u.id]);
    res.cookie('cr_session', token, { httpOnly: true, secure: production, sameSite: 'strict', maxAge: 604800000, path: '/' }); res.json({ user: publicUser(u) });
  }));
  app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));
  app.post('/api/auth/logout', wrap(async (req, res) => { if (req.cookies.cr_session) await pool.query('DELETE FROM sessions WHERE token=$1', [hash(req.cookies.cr_session)]); res.clearCookie('cr_session', { path: '/', secure: production, sameSite: 'strict' }); res.json({ ok: true }); }));
  app.post('/api/auth/password', auth, wrap(async (req, res) => {
    const pw = password(req.body.password);
    if (typeof req.body.currentPassword !== 'string' || req.body.currentPassword.length > 128 || !await bcrypt.compare(req.body.currentPassword, req.user.password_hash)) fail('当前密码不正确', 400);
    if (pw === req.body.currentPassword) fail('新密码必须与当前密码不同');
    const c = await pool.connect(); try { await c.query('BEGIN'); await c.query('UPDATE users SET password_hash=$1,must_change_password=FALSE WHERE id=$2', [await bcrypt.hash(pw, 12), req.user.id]); await c.query('DELETE FROM sessions WHERE user_id=$1 AND token<>$2', [req.user.id, hash(req.cookies.cr_session)]); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    res.json({ ok: true });
  }));
  app.use('/api', auth, ready);
  app.get('/api/users', admin, wrap(async (req, res) => { const r = await pool.query('SELECT * FROM users ORDER BY created_at'); res.json({ users: r.rows.map(publicUser) }); }));
  app.post('/api/users', admin, wrap(async (req, res) => {
    const u = account(req.body), pw = password(req.body.password);
    const r = await pool.query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,$3,$4,'sales') RETURNING *", [randomUUID(), u.name, u.username, await bcrypt.hash(pw, 12)]); res.status(201).json({ user: publicUser(r.rows[0]) });
  }));
  app.patch('/api/users/:id', admin, wrap(async (req, res) => {
    const r = await pool.query("SELECT * FROM users WHERE id=$1 AND role='sales'", [req.params.id]); if (!r.rows.length) fail('业务员账号不存在', 404);
    const c = await pool.connect(); try {
      await c.query('BEGIN');
      if (req.body.password !== undefined) await c.query('UPDATE users SET password_hash=$1,must_change_password=TRUE WHERE id=$2', [await bcrypt.hash(password(req.body.password), 12), req.params.id]);
      if (req.body.active !== undefined) { if (typeof req.body.active !== 'boolean') fail('无效账号状态'); await c.query('UPDATE users SET active=$1 WHERE id=$2', [req.body.active, req.params.id]); }
      if (req.body.name !== undefined) await c.query('UPDATE users SET name=$1 WHERE id=$2', [text(req.body.name, '姓名', 80, true), req.params.id]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [req.params.id]); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    res.json({ ok: true });
  }));
  app.get('/api/customers', wrap(async (req, res) => {
    const scope = own(req.user), args = [...scope.args], filters = [scope.sql];
    const query = text(req.query.q, '搜索', 200); if (query) { args.push(`%${query}%`); filters.push(`(c.name ILIKE $${args.length} OR c.source ILIKE $${args.length} OR c.note ILIKE $${args.length})`); }
    if (req.query.status) { args.push(req.query.status); filters.push(`c.status=$${args.length}`); }
    if (req.user.role === 'admin' && req.query.salesId) { args.push(req.query.salesId); filters.push(`c.sales_id=$${args.length}`); }
    const where = filters.join(' AND '), count = await pool.query(`SELECT count(*)::int AS total FROM customers c WHERE ${where}`, args);
    const page = Math.max(1, Math.min(100000, parseInt(req.query.page) || 1)), size = 30;
    args.push(size, (page - 1) * size);
    const r = await pool.query(`SELECT ${fields} FROM customers c JOIN users u ON u.id=c.sales_id WHERE ${where} ORDER BY c.created_at DESC,c.id LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    res.json({ customers: r.rows.map(publicCustomer), total: count.rows[0].total, page, pageSize: size });
  }));
  app.get('/api/customers/:id/avatar', wrap(async (req, res) => {
    const r = await pool.query('SELECT avatar FROM customers WHERE id=$1 AND ($2::boolean OR sales_id=$3)', [req.params.id, req.user.role === 'admin', req.user.id]);
    if (!r.rows[0]?.avatar) fail('头像不存在或无权限', 404); res.type('png').send(Buffer.from(r.rows[0].avatar));
  }));
  async function matches(client, x, excludeId = '') {
    const r = await client.query('SELECT id,name,sales_id,avatar_hash,avatar_dhash FROM customers WHERE normalized_name=$1 AND id<>$2', [x.normalized_name, excludeId]);
    return r.rows.map(c => ({ ...c, exact: !!x.hash && c.avatar_hash === x.hash, avatarSimilar: !!x.dhash && distance(x.dhash, c.avatar_dhash) <= 8 }));
  }
  function matchPublic(c, user) { return { id: c.id, name: c.name, exact: c.exact, avatarSimilar: c.avatarSimilar, own: c.sales_id === user.id }; }
  app.post('/api/customers/check', wrap(async (req, res) => { const x = await customer(req.body); res.json({ matches: (await matches(pool, x)).map(c => matchPublic(c, req.user)) }); }));
  app.post('/api/customers', wrap(async (req, res) => {
    const x = await customer(req.body), c = await pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(9001002)'); const found = await matches(c, x);
      if (found.some(c => c.exact) || (found.length && req.body.confirmDifferent !== true)) { await c.query('ROLLBACK'); return res.status(409).json({ error: found.some(c => c.exact) ? '姓名与头像完全重复，已阻止登记' : '姓名可能重复，请核对', matches: found.map(c => matchPublic(c, req.user)) }); }
      const r = await c.query('INSERT INTO customers(id,name,normalized_name,source,status,sales_id,note,avatar,avatar_hash,avatar_dhash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [randomUUID(), x.name, x.normalized_name, x.source, x.status, req.user.id, x.note, x.bytes, x.hash, x.dhash]);
      await c.query('COMMIT'); res.status(201).json({ customer: publicCustomer(r.rows[0]) });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));
  app.patch('/api/customers/:id', wrap(async (req, res) => {
    const c = await pool.connect(); try {
      await c.query('BEGIN'); await c.query('SELECT pg_advisory_xact_lock(9001002)');
      const r = await c.query('SELECT * FROM customers WHERE id=$1 AND ($2::boolean OR sales_id=$3) FOR UPDATE', [req.params.id, req.user.role === 'admin', req.user.id]); if (!r.rows.length) fail('客户不存在或无权限', 404);
      const old = r.rows[0], x = await customer({ ...old, ...req.body, avatar: req.body.avatar === undefined ? '' : req.body.avatar });
      if (req.body.avatar === undefined) Object.assign(x, { bytes: old.avatar, hash: old.avatar_hash, dhash: old.avatar_dhash });
      if ((await matches(c, x, old.id)).some(c => c.exact)) fail('修改后姓名与头像完全重复', 409);
      const updated = await c.query('UPDATE customers SET name=$1,normalized_name=$2,source=$3,status=$4,note=$5,avatar=$6,avatar_hash=$7,avatar_dhash=$8,updated_at=NOW() WHERE id=$9 RETURNING *', [x.name, x.normalized_name, x.source, x.status, x.note, x.bytes, x.hash, x.dhash, old.id]); await c.query('COMMIT'); res.json({ customer: publicCustomer(updated.rows[0]) });
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }));
  app.delete('/api/customers/:id', wrap(async (req, res) => { const r = await pool.query('DELETE FROM customers WHERE id=$1 AND ($2::boolean OR sales_id=$3) RETURNING id', [req.params.id, req.user.role === 'admin', req.user.id]); if (!r.rows.length) fail('客户不存在或无权限', 404); res.json({ ok: true }); }));
  app.get('/api/stats', wrap(async (req, res) => {
    const scope = own(req.user);
    const r = await pool.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE (c.created_at AT TIME ZONE 'Asia/Taipei')::date=(NOW() AT TIME ZONE 'Asia/Taipei')::date)::int AS today,count(*) FILTER(WHERE c.status='跟进中')::int AS following,count(*) FILTER(WHERE c.status='已成交')::int AS won FROM customers c WHERE ${scope.sql}`, scope.args);
    const by = await pool.query(`SELECT u.id,u.name,count(c.id) FILTER(WHERE (c.created_at AT TIME ZONE 'Asia/Taipei')::date=(NOW() AT TIME ZONE 'Asia/Taipei')::date)::int AS today FROM users u LEFT JOIN customers c ON c.sales_id=u.id WHERE ($1::boolean OR u.id=$2) GROUP BY u.id,u.name ORDER BY u.name`, [req.user.role === 'admin', req.user.id]); res.json({ ...r.rows[0], bySales: by.rows });
  }));
  // Only public assets are served. Source, backups and environment files are never static files.
  app.use(express.static(`${root}public`, { dotfiles: 'deny', maxAge: '1h' }));
  app.get('/', (req, res) => res.sendFile(`${root}public/index.html`));
  app.use((req, res) => res.status(404).json({ error: '页面或接口不存在' }));
  app.use((err, req, res, next) => { const status = err.status || (err.code === '23505' ? 409 : 500); if (status === 500) console.error('Request failed:', err.code || err.message); res.status(status).json({ error: status === 500 ? '服务器暂时无法处理请求，请稍后重试' : err.code === '23505' ? '账号已存在或资料冲突' : err.message }); });
  return app;
}

