// BrandOS: сервер без фреймворков. Отдаёт index.html и API.
// Ключи читаются только здесь, из .env или переменных окружения хостинга, и никогда не уходят в браузер.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import { getDb, saveDb } from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { buildDashboard } from './lib/aggregate.js';
import { syncAll, isSyncing, enabledKeys, sourceStatus, startScheduler, crmSource } from './lib/sync.js';
import { ingest, recognize, filePath } from './lib/docs.js';
import { aiEnabled, chat } from './lib/ai.js';
import { snapshotForAI } from './lib/snapshot.js';
import { startTelegram } from './lib/telegram.js';
import { runDecisions, maybeDailyRun, refreshStatuses, act, isRunning } from './lib/decisions.js';
import { authEnabled, publicAccess, checkStartup, isAuthed, checkPassword, tooManyFails, clientIp, makeSession, sessionCookie, clearCookie, sameOrigin, loginPage } from './lib/auth.js';
import { stopTelegram } from './lib/telegram.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
process.env.TZ ||= 'Europe/Moscow'; // дни считаются по Москве, если не задано иное
process.chdir(ROOT); // settings.json и data/ — рядом с server.js

// На хостинге settings.json лежит на постоянном диске (SETTINGS_FILE); при первом запуске копируем шаблон
if (process.env.SETTINGS_FILE && !process.env.SETTINGS_JSON && !fs.existsSync(process.env.SETTINGS_FILE)) {
  fs.mkdirSync(path.dirname(process.env.SETTINGS_FILE), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'settings.json'), process.env.SETTINGS_FILE);
  console.log(`Создан ${process.env.SETTINGS_FILE} из шаблона — впишите туда цифры бизнеса.`);
}

const LISTS = ['tasks', 'docs', 'deals']; // массивы элементов с id; решения меняются только через /api/decisions
const MAPS = [];
const MAX_BODY = 5 * 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024;

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw fail(413, `Слишком большой файл (больше ${Math.round(limit / 1048576)} МБ)`);
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readBody(req) {
  const text = (await readRaw(req, MAX_BODY)).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { throw fail(400, 'Некорректный JSON'); }
}

function dashboard() {
  const db = getDb();
  return { ...buildDashboard({ raw: db.raw, enabled: enabledKeys(), settings: getSettings() }), lastSync: db.lastSync, syncing: isSyncing(), ai: aiEnabled() };
}

// Отчёты для ozon.html: только из подключённых источников
function ozonReports() {
  const db = getDb(), on = enabledKeys();
  const part = key => {
    const st = db.status[key] || {}, raw = db.raw[key];
    if (!on.includes(key)) return { on: false, datasets: [] };
    return { on: true, at: st.lastOkAt || null, error: st.error || raw?.reportsError || null, datasets: raw?.reports || [] };
  };
  const seller = part('ozon'), perf = part('ozonPerf');
  return {
    seller: { on: seller.on, at: seller.at, error: seller.error },
    perf: { on: perf.on, at: perf.at, error: perf.error },
    // Реклама из начислений нужна, только если за этот месяц нет данных Ozon Performance
    datasets: [...seller.datasets.filter(d => !(d.data?.spendOnly && perf.datasets.some(x => x.period?.from === d.period?.from))), ...perf.datasets],
    lastSync: db.lastSync, syncing: isSyncing()
  };
}

// Полная картина для Центра решений и ИИ-чата
const build = {
  settings: getSettings,
  data() {
    const db = getDb(), dash = dashboard();
    return { dash, store: db.store, input: snapshotForAI(dash, db.store, sourceStatus()) };
  }
};

// Элементы задач/сделок/документов меняются по одному — так правки разных людей не затирают друг друга
function storeOp(name, id, method, body) {
  const db = getDb();
  if (MAPS.includes(name)) {
    const map = (db.store[name] && typeof db.store[name] === 'object' && !Array.isArray(db.store[name])) ? db.store[name] : (db.store[name] = {});
    if (method === 'DELETE') delete map[id]; else map[id] = { ...(map[id] || {}), ...body };
    return map[id] ?? null;
  }
  const list = Array.isArray(db.store[name]) ? db.store[name] : (db.store[name] = []);
  const i = list.findIndex(x => x.id === id);
  if (method === 'DELETE') {
    if (i < 0) return null;
    const [gone] = list.splice(i, 1);
    if (name === 'docs' && gone.file) fs.rm(filePath(gone), () => {});
    return gone;
  }
  const clean = { ...body };
  for (const k of ['id', 'file', 'hash', 'mime', 'size', 'externalId']) delete clean[k]; // служебные поля не меняются из браузера
  if (i < 0) { const item = { ...clean, id }; list.push(item); return item; }
  Object.assign(list[i], clean);
  return list[i];
}

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin'
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, method = req.method;
  let m;

  if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true });

  // Вход по паролю
  if (p === '/login' && authEnabled()) {
    if (method === 'GET') { res.writeHead(200, HTML_HEADERS); return res.end(loginPage()); }
    if (method === 'POST') {
      const ip = clientIp(req);
      if (tooManyFails(ip)) { res.writeHead(429, HTML_HEADERS); return res.end(loginPage('Слишком много неверных попыток. Попробуйте через 15 минут.')); }
      const form = new URLSearchParams((await readRaw(req, 10000)).toString('utf8'));
      if (!checkPassword(ip, form.get('password') || '')) {
        console.warn(`[auth] неверный пароль с ${ip}`);
        res.writeHead(401, HTML_HEADERS); return res.end(loginPage('Неверный пароль'));
      }
      res.writeHead(302, { Location: '/', 'Set-Cookie': sessionCookie(req, makeSession()) });
      return res.end();
    }
  }
  // Без пароля страницы входа нет — старые ссылки на /login ведут на главную
  if (p === '/login' && !authEnabled()) { res.writeHead(302, { Location: '/' }); return res.end(); }
  if (p === '/logout' && method === 'POST') {
    res.writeHead(302, { Location: authEnabled() ? '/login' : '/', 'Set-Cookie': clearCookie(req) });
    return res.end();
  }
  if (!isAuthed(req)) {
    if (p.startsWith('/api/')) return send(res, 401, { error: 'Нужно войти' });
    res.writeHead(302, { Location: '/login' });
    return res.end();
  }
  if (method !== 'GET' && !sameOrigin(req)) throw fail(403, 'Запрос с чужого сайта отклонён');

  // OZON_ONLY=1 — отдельный сервис «Аналитика Ozon»: на главной сразу эта страница, BrandOS не показывается
  const ozonOnly = process.env.OZON_ONLY === '1';
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, HTML_HEADERS);
    return fs.createReadStream(path.join(ROOT, ozonOnly ? 'ozon.html' : 'index.html')).pipe(res);
  }
  // «Аналитика Ozon»: та же страница, что работает с Excel-выгрузками, но данные приходят из API
  if (method === 'GET' && (p === '/ozon' || p === '/ozon.html')) {
    res.writeHead(200, HTML_HEADERS);
    return fs.createReadStream(path.join(ROOT, 'ozon.html')).pipe(res);
  }
  if (method === 'GET' && p === '/api/ozon/reports') return send(res, 200, ozonReports());
  if (method === 'GET' && p === '/api/dashboard') return send(res, 200, dashboard());
  if (method === 'GET' && p === '/api/status') {
    return send(res, 200, { sources: sourceStatus(), syncing: isSyncing(), lastSync: getDb().lastSync, ai: aiEnabled(), auth: authEnabled() });
  }
  if (method === 'POST' && p === '/api/sync') {
    syncAll().catch(e => console.error('[sync]', e.message));
    return send(res, 202, { started: true });
  }

  // Общие данные команды
  if ((m = p.match(/^\/api\/store\/([a-z]+)$/)) && method === 'GET' && [...LISTS, ...MAPS].includes(m[1])) {
    return send(res, 200, { items: getDb().store[m[1]] ?? (MAPS.includes(m[1]) ? {} : []) });
  }
  if ((m = p.match(/^\/api\/store\/([a-z]+)\/([\w-]{1,64})$/)) && [...LISTS, ...MAPS].includes(m[1]) && ['PATCH', 'DELETE'].includes(method)) {
    const body = method === 'PATCH' ? await readBody(req) : {};
    if (typeof body !== 'object' || Array.isArray(body) || body === null) throw fail(400, 'Ожидается объект');
    const item = storeOp(m[1], m[2], method, body);
    saveDb();
    return send(res, 200, { ok: true, item });
  }

  // Документы: загрузка файла, скачивание, повторное распознавание
  if (method === 'POST' && p === '/api/docs/upload') {
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'документ')).slice(0, 200);
    const buffer = await readRaw(req, MAX_UPLOAD);
    if (!buffer.length) throw fail(400, 'Пустой файл');
    const { doc, duplicate } = ingest({ source: 'Загрузка', name, buffer, mime: req.headers['content-type'], from: 'вручную' });
    return send(res, duplicate ? 200 : 201, { doc, duplicate });
  }
  if ((m = p.match(/^\/api\/docs\/([\w-]{1,64})\/file$/)) && method === 'GET') {
    const doc = (getDb().store.docs || []).find(d => d.id === m[1]);
    if (!doc?.file || !fs.existsSync(filePath(doc))) throw fail(404, 'Файл не найден');
    res.writeHead(200, {
      'Content-Type': doc.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    });
    return fs.createReadStream(filePath(doc)).pipe(res);
  }
  if ((m = p.match(/^\/api\/docs\/([\w-]{1,64})\/recognize$/)) && method === 'POST') {
    if (!aiEnabled()) throw fail(409, 'Нет ключа Claude API — распознавание выключено');
    const doc = (getDb().store.docs || []).find(d => d.id === m[1]);
    if (!doc) throw fail(404, 'Документ не найден');
    doc.ai = 'pending'; doc.aiError = '';
    const r = await recognize(doc.id);
    return send(res, 200, r);
  }

  // Центр решений
  if (method === 'GET' && p === '/api/decisions') {
    return send(res, 200, { items: refreshStatuses(), run: getDb().state.decisionsRun || null, running: isRunning(), ai: aiEnabled(), hour: getSettings().decisionHour });
  }
  if (method === 'POST' && p === '/api/decisions/recalc') {
    const run = await runDecisions(build, { reason: 'manual' });
    return send(res, 200, { items: refreshStatuses(), run });
  }
  if ((m = p.match(/^\/api\/decisions\/([\w-]{1,64})\/(accept|postpone|reject|restore)$/)) && method === 'POST') {
    const body = m[2] === 'reject' ? await readBody(req) : {};
    const d = act(m[1], m[2], body, getSettings());
    return send(res, 200, { item: d, items: refreshStatuses(), tasks: getDb().store.tasks || [] });
  }

  // ИИ-чат по живым данным
  if (method === 'POST' && p === '/api/chat') {
    if (!aiEnabled()) throw fail(409, 'Нет ключа Claude API — чат работает на встроенных правилах');
    const b = await readBody(req);
    const history = (Array.isArray(b.messages) ? b.messages : [])
      .filter(x => (x.role === 'user' || x.role === 'assistant') && typeof x.text === 'string' && x.text.trim())
      .slice(-20).map(x => ({ role: x.role, text: x.text.slice(0, 4000) }));
    while (history.length && history[0].role !== 'user') history.shift();
    if (!history.length || history[history.length - 1].role !== 'user') throw fail(400, 'Нет вопроса');
    const snap = build.data().input;
    try {
      return send(res, 200, { text: await chat(history, snap) });
    } catch (e) {
      throw fail(502, e.message);
    }
  }

  // Сделки CRM: перенос этапа и правки записываются обратно в amoCRM / Битрикс24
  if ((m = p.match(/^\/api\/deals(?:\/([\w-]+))?$/)) && (method === 'POST' || method === 'PATCH')) {
    const src = crmSource();
    if (!src) throw fail(409, 'CRM не подключена — сделки хранятся на дашборде');
    const db = getDb(), raw = db.raw[src.key];
    if (!raw) throw fail(409, 'Данные CRM ещё не загружены — дождитесь синхронизации');
    const b = await readBody(req);
    const v = { title: b.title ? String(b.title) : undefined, sum: b.sum, stage: b.stage ? String(b.stage) : undefined };
    try {
      if (method === 'PATCH') {
        await src.mod.updateDeal(raw, m[1], v);
        const d = raw.deals.find(x => x.id === m[1]);
        if (d) Object.assign(d, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)));
        saveDb();
        return send(res, 200, { ok: true });
      }
      const id = await src.mod.createDeal(raw, v);
      raw.deals.push({ id, title: v.title || 'Сделка', client: String(b.client || ''), sum: Number(v.sum) || 0, stage: v.stage || raw.stages[0]?.name, who: String(b.who || ''), note: '' });
      saveDb();
      return send(res, 201, { ok: true, id });
    } catch (e) {
      throw fail(502, e.message);
    }
  }

  send(res, 404, { error: 'Не найдено' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!e.status) console.error(`[http] ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера' });
  });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const startupError = checkStartup(HOST);
if (startupError) {
  console.error(startupError);
  process.exit(1);
}

// Хостинг останавливает контейнер сигналом SIGTERM: дописываем базу и закрываемся
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log('Останавливаюсь…');
    stopTelegram();
    try { saveDb(); } catch (e) { console.error('Не удалось сохранить базу:', e.message); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

server.listen(PORT, HOST, () => {
  const on = enabledKeys();
  console.log(`BrandOS: http://${HOST}:${PORT}${authEnabled() ? ' (вход по паролю)' : ''}`);
  if (publicAccess()) console.warn('ВНИМАНИЕ: PUBLIC_ACCESS=1 — дашборд открыт без пароля, его видит любой, у кого есть ссылка.');
  console.log(on.length ? `Подключены: ${on.join(', ')}` : 'Ключей в .env нет — дашборд работает на демо-данных.');
  if (process.env.NO_SYNC === '1') return console.log('NO_SYNC=1 — синхронизация и бот отключены, показываются сохранённые данные.');
  const min = startScheduler(getSettings().syncMinutes);
  // Утренний разбор: после первой синхронизации и дальше раз в минуту проверяем, не пора ли
  const daily = () => { const r = maybeDailyRun(build); if (r) r.then(x => console.log(`Центр решений: ${x.count} новых (${x.source === 'ai' ? 'ИИ' : 'правила'})`)).catch(e => console.error('[decisions]', e.message)); };
  if (on.length) {
    console.log(`Синхронизация каждые ${min} мин.`);
    syncAll().catch(() => {}).finally(daily);
  } else daily();
  setInterval(daily, 60000).unref();
  startTelegram();
});
