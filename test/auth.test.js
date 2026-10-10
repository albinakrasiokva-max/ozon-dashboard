// Этап 5: вход по паролю и запуск на хостинге. Запуск: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';

const ROOT = new URL('..', import.meta.url).pathname;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brandos-auth-'));
const PORT = 3961, base = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'верный-пароль-123';
let srv;

function req(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const login = pw => req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': '10.0.0.' + Math.random() }, body: new URLSearchParams({ password: pw }).toString() });
const cookieOf = r => String(r.headers['set-cookie'] || '').split(';')[0];

before(async () => {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(PORT), HOST: '0.0.0.0', DATA_DIR: path.join(DIR, 'data'), SETTINGS_FILE: path.join(DIR, 'data', 'settings.json'), DASHBOARD_PASSWORD: PASSWORD, NO_SYNC: '1' }
  });
  for (let i = 0; i < 50; i++) { try { await req(base + '/api/health'); return; } catch { await new Promise(r => setTimeout(r, 100)); } }
});
after(() => srv.kill());

test('без пароля в сеть не запускается, со слабым паролем — тоже', () => {
  const env = { PATH: process.env.PATH, PORT: '3962', HOST: '0.0.0.0', DATA_DIR: path.join(DIR, 'x') };
  const r = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /пароль не задан/);
  const weak = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env: { ...env, DASHBOARD_PASSWORD: '12345' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(weak.status, 1);
  assert.match(weak.stderr, /слишком короткий/);
});

test('без входа: страница ведёт на /login, API отвечает 401, health открыт', async () => {
  const page = await req(base + '/');
  assert.equal(page.status, 302); assert.equal(page.headers.location, '/login');
  assert.equal((await req(base + '/api/dashboard')).status, 401);
  assert.equal((await req(base + '/api/store/docs')).status, 401);
  assert.equal((await req(base + '/api/docs/abc/file')).status, 401);
  assert.equal((await req(base + '/api/health')).status, 200);
  const lp = await req(base + '/login');
  assert.equal(lp.status, 200); assert.match(lp.body, /Дашборд закрыт паролем/);
  assert.equal(lp.headers['x-frame-options'], 'DENY');
});

test('неверный пароль — 401, верный — cookie сессии и доступ', async () => {
  const bad = await login('не-тот-пароль');
  assert.equal(bad.status, 401); assert.match(bad.body, /Неверный пароль/);
  assert.equal(bad.headers['set-cookie'], undefined);

  const ok = await login(PASSWORD);
  assert.equal(ok.status, 302); assert.equal(ok.headers.location, '/');
  const set = String(ok.headers['set-cookie']);
  assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Lax/); assert.match(set, /Max-Age=2592000/);
  const cookie = cookieOf(ok);
  const page = await req(base + '/', { headers: { cookie } });
  assert.equal(page.status, 200); assert.match(page.body, /BrandOS/);
  const st = JSON.parse((await req(base + '/api/status', { headers: { cookie } })).body);
  assert.equal(st.auth, true);
  // Подделанная подпись не проходит
  const forged = cookie.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
  assert.equal((await req(base + '/api/dashboard', { headers: { cookie: forged } })).status, 401);
  // Продлённый срок без подписи не проходит
  const [name, val] = cookie.split('=');
  const parts = val.split('.');
  assert.equal((await req(base + '/api/dashboard', { headers: { cookie: `${name}=${Date.now() + 1e12}.${parts[1]}.${parts[2]}` } })).status, 401);
});

test('запрос с чужого сайта отклоняется, со своего — проходит', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  const evil = await req(base + '/api/store/tasks/t1', { method: 'PATCH', headers: { cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
  assert.equal(evil.status, 403);
  const own = await req(base + '/api/store/tasks/t1', { method: 'PATCH', headers: { cookie, Origin: base, 'Content-Type': 'application/json' }, body: '{"title":"x"}' });
  assert.equal(own.status, 200);
});

test('выход очищает cookie', async () => {
  const cookie = cookieOf(await login(PASSWORD));
  const out = await req(base + '/logout', { method: 'POST', headers: { cookie } });
  assert.equal(out.status, 302); assert.equal(out.headers.location, '/login');
  assert.match(String(out.headers['set-cookie']), /Max-Age=0/);
});

test('подбор пароля: после 10 ошибок с одного адреса — 429 на 15 минут', async () => {
  // без TRUST_PROXY адрес берётся из соединения, а не из X-Forwarded-For — его не подделать
  for (let i = 0; i < 10; i++) await login('ошибка-' + i);
  const r = await login(PASSWORD);
  assert.equal(r.status, 429); assert.match(r.body, /Слишком много неверных попыток/);
});

test('на постоянном диске создаются настройки и секрет сессий', () => {
  assert.ok(fs.existsSync(path.join(DIR, 'data', 'settings.json')), 'шаблон settings.json скопирован');
  const secret = path.join(DIR, 'data', 'session-secret');
  assert.ok(fs.existsSync(secret));
  assert.equal(fs.statSync(secret).mode & 0o077, 0, 'секрет доступен только владельцу');
});

test('настройки можно передать переменной SETTINGS_JSON', async () => {
  process.env.SETTINGS_JSON = JSON.stringify({ ownerName: 'Из переменной', maxDrr: 12 });
  const { getSettings } = await import('../lib/settings.js');
  const s = getSettings();
  assert.equal(s.ownerName, 'Из переменной'); assert.equal(s.maxDrr, 12); assert.equal(s.minStockDays, 14);
  delete process.env.SETTINGS_JSON;
});
