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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(ROOT, '.env'));
process.env.TZ ||= 'Europe/Moscow'; // дни считаются по Москве, если не задано иное
process.chdir(ROOT); // settings.json и data/ — рядом с server.js

const STORES = ['tasks', 'docs', 'decisions', 'deals'];
const MAX_BODY = 5 * 1024 * 1024;

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error('Некорректный JSON'), { status: 400 }); }
}

function dashboard() {
  const db = getDb();
  return { ...buildDashboard({ raw: db.raw, enabled: enabledKeys(), settings: getSettings() }), lastSync: db.lastSync, syncing: isSyncing() };
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname, method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res);
  }
  if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
  if (method === 'GET' && p === '/api/dashboard') return send(res, 200, dashboard());
  if (method === 'GET' && p === '/api/status') {
    return send(res, 200, { sources: sourceStatus(), syncing: isSyncing(), lastSync: getDb().lastSync });
  }
  if (method === 'POST' && p === '/api/sync') {
    syncAll().catch(e => console.error('[sync]', e.message));
    return send(res, 202, { started: true });
  }

  // Общие данные команды: задачи, документы, решения, сделки (если CRM не подключена)
  const sm = p.match(/^\/api\/store\/([a-z]+)$/);
  if (sm && STORES.includes(sm[1])) {
    const db = getDb();
    if (method === 'GET') return send(res, 200, { items: db.store[sm[1]] ?? null });
    if (method === 'PUT') {
      const b = await readBody(req);
      if (!Array.isArray(b.items) && (typeof b.items !== 'object' || b.items === null)) return send(res, 400, { error: 'Ожидается поле items' });
      db.store[sm[1]] = b.items;
      saveDb();
      return send(res, 200, { ok: true });
    }
  }

  // Сделки CRM: перенос этапа и правки записываются обратно в amoCRM / Битрикс24
  const dm = p.match(/^\/api\/deals(?:\/([\w-]+))?$/);
  if (dm && (method === 'POST' || method === 'PATCH')) {
    const src = crmSource();
    if (!src) return send(res, 409, { error: 'CRM не подключена — сделки хранятся на дашборде' });
    const db = getDb(), raw = db.raw[src.key];
    if (!raw) return send(res, 409, { error: 'Данные CRM ещё не загружены — дождитесь синхронизации' });
    const b = await readBody(req);
    const v = { title: b.title ? String(b.title) : undefined, sum: b.sum, stage: b.stage ? String(b.stage) : undefined };
    try {
      if (method === 'PATCH') {
        await src.mod.updateDeal(raw, dm[1], v);
        const d = raw.deals.find(x => x.id === dm[1]);
        if (d) Object.assign(d, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)));
        saveDb();
        return send(res, 200, { ok: true });
      }
      const id = await src.mod.createDeal(raw, v);
      raw.deals.push({ id, title: v.title || 'Сделка', client: String(b.client || ''), sum: Number(v.sum) || 0, stage: v.stage || raw.stages[0]?.name, who: String(b.who || ''), note: '' });
      saveDb();
      return send(res, 201, { ok: true, id });
    } catch (e) {
      return send(res, 502, { error: e.message });
    }
  }

  send(res, 404, { error: 'Не найдено' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error(`[http] ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Внутренняя ошибка сервера' });
  });
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  const on = enabledKeys();
  console.log(`BrandOS: http://${HOST}:${PORT}`);
  console.log(on.length ? `Подключены источники: ${on.join(', ')}` : 'Ключей в .env нет — дашборд работает на демо-данных.');
  if (process.env.NO_SYNC === '1') return console.log('NO_SYNC=1 — синхронизация отключена, показываются сохранённые данные.');
  const min = startScheduler(getSettings().syncMinutes);
  if (on.length) {
    console.log(`Синхронизация каждые ${min} мин.`);
    syncAll().catch(() => {});
  }
});
