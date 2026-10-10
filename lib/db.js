// Хранилище в JSON-файле: data/db.json (на хостинге data/ — постоянный диск).
import fs from 'node:fs';
import path from 'node:path';

export const dataDir = () => path.resolve(process.env.DATA_DIR || 'data');
const file = () => path.join(dataDir(), 'db.json');
// raw — данные источников, status — их состояние, store — задачи/сделки/документы/решения команды,
// state — курсоры источников документов (последнее письмо, offset Telegram)
const empty = () => ({ raw: {}, status: {}, lastSync: null, store: {}, state: {} });

let db = null;

export function getDb() {
  if (!db) {
    try { db = { ...empty(), ...JSON.parse(fs.readFileSync(file(), 'utf8')) }; }
    catch (e) {
      if (e.code !== 'ENOENT') console.error('data/db.json не читается, начинаю с пустой базы:', e.message);
      db = empty();
    }
  }
  return db;
}

export function saveDb() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(getDb()));
  fs.renameSync(tmp, file());
}

const pad = n => String(n).padStart(2, '0');
export const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const daysAgo = (n, from = new Date()) => { const d = new Date(from); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
// "2026-10-01T10:00:00", "01.10.2026", unix-время → "2026-10-01"
export function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isoDay(new Date(v < 1e12 ? v * 1000 : v));
  const s = String(v);
  const ru = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (ru) return `${ru[3]}-${ru[2]}-${ru[1]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? null : isoDay(d);
}
