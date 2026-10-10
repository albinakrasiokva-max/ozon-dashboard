// Вход по паролю: один общий пароль команды (DASHBOARD_PASSWORD), сессия в подписанной cookie на 30 дней.
// Смена пароля сразу выкидывает все старые сессии. Неверные попытки ограничены: 10 за 15 минут с одного адреса.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db.js';

const COOKIE = 'bos_session';
const TTL = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 10, WINDOW = 15 * 60 * 1000;

export const authEnabled = () => !!process.env.DASHBOARD_PASSWORD;
const isLoopback = h => ['127.0.0.1', 'localhost', '::1'].includes(String(h));

// Без пароля сервер можно открыть только на этом компьютере
export function checkStartup(host) {
  if (!authEnabled() && !isLoopback(host)) {
    return 'Сервер открыт в сеть (HOST=' + host + '), но пароль не задан. Впишите DASHBOARD_PASSWORD в переменные окружения — без пароля дашборд не запустится.';
  }
  if (authEnabled() && process.env.DASHBOARD_PASSWORD.length < 10) {
    return 'DASHBOARD_PASSWORD слишком короткий — нужно не меньше 10 символов.';
  }
  return null;
}

let secret = null;
function getSecret() {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) return (secret = process.env.SESSION_SECRET);
  // Секрет сессий хранится на постоянном диске, чтобы перезапуск не разлогинивал команду
  const f = path.join(dataDir(), 'session-secret');
  try { secret = fs.readFileSync(f, 'utf8').trim(); } catch { /* создадим */ }
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(f, secret, { mode: 0o600 });
  }
  return secret;
}
const key = () => crypto.createHmac('sha256', getSecret()).update(process.env.DASHBOARD_PASSWORD || '').digest();
const sign = v => crypto.createHmac('sha256', key()).update(v).digest('base64url');
const same = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

export function makeSession() {
  const v = `${Date.now() + TTL}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${v}.${sign(v)}`;
}
export function validSession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const v = parts[0] + '.' + parts[1];
  return same(sign(v), parts[2]) && Number(parts[0]) > Date.now();
}

const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const trustProxy = () => process.env.TRUST_PROXY === '1' || !!process.env.RAILWAY_ENVIRONMENT;
export const clientIp = req => (trustProxy() && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const secure = req => process.env.COOKIE_SECURE === '1' || (trustProxy() && req.headers['x-forwarded-proto'] === 'https');

export function isAuthed(req) {
  return !authEnabled() || validSession(cookies(req)[COOKIE]);
}

export function sessionCookie(req, token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}${secure(req) ? '; Secure' : ''}`;
}
export function clearCookie(req) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req) ? '; Secure' : ''}`;
}

// Ограничение подбора пароля
const fails = new Map();
export function tooManyFails(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > WINDOW) return false;
  return f.n >= MAX_FAILS;
}
export function checkPassword(ip, password) {
  const ok = authEnabled() && same(password, process.env.DASHBOARD_PASSWORD);
  if (ok) { fails.delete(ip); return true; }
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > WINDOW) fails.set(ip, { n: 1, first: Date.now() });
  else f.n++;
  return false;
}

// Запросы, меняющие данные, принимаются только со своего же сайта
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function loginPage(error = '') {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Вход — BrandOS</title>
<style>
:root{--bg:#0a0c16;--card:#131629;--line:#242949;--text:#e9ebf8;--mut:#8a90b4;--red:#ff4d6d}
*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:16px;font-family:Inter,system-ui,sans-serif;color:var(--text);
background:var(--bg) radial-gradient(800px 500px at 80% -10%,rgba(155,92,255,.16),transparent)}
form{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 0 50px rgba(124,108,255,.2)}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;margin-bottom:6px}
.logo i{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#4f8cff,#9b5cff);display:grid;place-items:center;font-style:normal}
p{color:var(--mut);font-size:14px;margin-bottom:18px}label{display:block;font-size:13px;color:var(--mut);margin-bottom:6px}
input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--line);background:#0e1120;color:var(--text);font:inherit;outline:0}
input:focus{border-color:#4f8cff;box-shadow:0 0 0 3px rgba(79,140,255,.2)}
button{width:100%;margin-top:14px;padding:12px;border:0;border-radius:10px;font:inherit;font-weight:600;color:#fff;cursor:pointer;background:linear-gradient(135deg,#4f8cff,#9b5cff)}
.err{color:var(--red);font-size:13px;margin-top:10px}
</style></head><body>
<form method="post" action="/login">
<div class="logo"><i>⚡</i>BrandOS</div><p>Дашборд закрыт паролем. Пароль выдаёт владелец.</p>
<label for="pw">Пароль</label><input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Войти</button>${error ? `<div class="err">${esc(error)}</div>` : ''}
</form></body></html>`;
}
