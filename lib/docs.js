// Приём документов из всех источников: сохранить файл → распознать ИИ → создать задачи «подписать» / «оплатить».
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDb, saveDb, dataDir, isoDay, daysAgo } from './db.js';
import { aiEnabled, readDocument, canRead } from './ai.js';
import { getSettings } from './settings.js';

const filesDir = () => path.join(dataDir(), 'files');
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'application/xml': 'xml', 'text/xml': 'xml', 'text/plain': 'txt', 'text/html': 'html', 'text/csv': 'csv', 'application/json': 'json' };
const BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
BY_EXT.jpeg = 'image/jpeg';

export function guessMime(name, mime) {
  const m = (mime || '').toLowerCase().split(';')[0].trim();
  if (m && m !== 'application/octet-stream') return m;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return BY_EXT[ext] || 'application/octet-stream';
}

const list = name => {
  const db = getDb();
  if (!Array.isArray(db.store[name])) db.store[name] = [];
  return db.store[name];
};
const newId = () => crypto.randomBytes(5).toString('hex');
const rub = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ₽';

// Распознавание идёт по одному документу за раз — так проще с лимитами API
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn, fn));

/**
 * file: {source, name, buffer, mime, from, date, externalId}
 * Возвращает {doc, duplicate, done}: done — промис, который завершится после распознавания.
 */
export function ingest(file) {
  const docs = list('docs');
  const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const ext = file.externalId ? `${file.source}:${file.externalId}` : null;
  const dup = docs.find(d => (ext && d.externalId === ext) || d.hash === hash);
  if (dup) return { doc: dup, duplicate: true, done: Promise.resolve({ doc: dup, tasks: [] }) };

  const mime = guessMime(file.name, file.mime);
  const id = newId();
  fs.mkdirSync(filesDir(), { recursive: true });
  const fileName = `${id}.${EXT[mime] || 'bin'}`;
  fs.writeFileSync(path.join(filesDir(), fileName), file.buffer);

  const doc = {
    id, name: String(file.name || 'документ').slice(0, 200), source: file.source, from: file.from || '',
    type: 'Документ', cp: '', sum: 0, date: file.date || isoDay(new Date()), received: new Date().toISOString(),
    due: null, needSign: false, needPay: false, section: '', summary: '', number: '',
    status: 'Новый', file: fileName, mime, size: file.buffer.length, hash, externalId: ext,
    ai: aiEnabled() ? (canRead(mime) ? 'pending' : 'unsupported') : 'off', aiError: ''
  };
  docs.push(doc);
  saveDb();
  const done = doc.ai === 'pending' ? enqueue(() => recognize(doc.id)) : Promise.resolve({ doc, tasks: [] });
  return { doc, duplicate: false, done };
}

export async function recognize(id) {
  const db = getDb(), doc = list('docs').find(d => d.id === id);
  if (!doc) return { doc: null, tasks: [] };
  const S = getSettings();
  try {
    const buffer = fs.readFileSync(path.join(filesDir(), doc.file));
    const r = await readDocument({ buffer, mime: doc.mime, name: doc.name, hint: doc.source + (doc.from ? `, от ${doc.from}` : ''), company: S.company });
    Object.assign(doc, {
      type: r.type, number: r.number || '', cp: r.counterparty || '', inn: r.counterpartyInn || '',
      sum: r.amount || 0, date: r.date || doc.date, due: r.dueDate, needSign: r.needsSignature, needPay: r.needsPayment,
      section: r.section, summary: r.summary, ai: 'done', aiError: '',
      status: r.needsSignature ? 'Ждёт подписи' : doc.status
    });
    const tasks = makeTasks(doc, S);
    saveDb();
    return { doc, tasks };
  } catch (e) {
    doc.ai = 'error';
    doc.aiError = e.message;
    saveDb();
    console.error(`[docs] «${doc.name}»: ${e.message}`);
    return { doc, tasks: [] };
  }
}

// Задачи со ссылкой на документ; повторно не создаются
export function makeTasks(doc, S = getSettings()) {
  const tasks = list('tasks'), out = [];
  const label = [doc.type, doc.number && `№${doc.number}`, doc.cp].filter(Boolean).join(' ');
  const team = S.team?.length ? S.team : ['Владелец'];
  const soon = d => d && d <= isoDay(daysAgo(-2));
  const add = (kind, title, due, who) => {
    if (tasks.some(t => t.doc === doc.id && t.kind === kind)) return;
    const t = { id: newId(), title, desc: doc.summary, status: 'todo', prio: soon(due) ? 'high' : 'med', due, who, ai: true, doc: doc.id, kind };
    tasks.push(t);
    out.push(t);
  };
  if (doc.needPay) {
    const due = doc.due || isoDay(daysAgo(-(Number(S.payWithinDays) || 3)));
    add('pay', `Оплатить: ${label}${doc.sum ? ' — ' + rub(doc.sum) : ''}`, due, S.assignees?.pay || team[0]);
  }
  if (doc.needSign) {
    add('sign', `Подписать: ${label}`, doc.due || isoDay(daysAgo(-2)), S.assignees?.sign || team[0]);
  }
  return out;
}

export const filePath = doc => path.join(filesDir(), path.basename(doc.file));

// Короткий ответ для Telegram-бота: куда разложили документ
export function describe({ doc, tasks }, duplicate) {
  if (duplicate) return `Этот файл уже есть в Документах: «${doc.name}».`;
  if (doc.ai === 'off') return `Принял «${doc.name}» — положил в Документы. Распознавание выключено: нет ключа Claude API.`;
  if (doc.ai === 'unsupported') return `Принял «${doc.name}» — положил в Документы. Этот формат ИИ не читает: пришлите PDF или фото.`;
  if (doc.ai === 'error') return `Принял «${doc.name}», но распознать не получилось: ${doc.aiError}`;
  const parts = [doc.type, doc.cp, doc.sum ? rub(doc.sum) : '', doc.due ? 'срок ' + doc.due.split('-').reverse().join('.') : ''].filter(Boolean).join(', ');
  return `Принял «${doc.name}»: ${parts}. Раздел: ${doc.section}.` +
    (tasks.length ? `\nСоздал задачи:\n${tasks.map(t => '• ' + t.title + ' (' + t.who + ')').join('\n')}` : '\nЗадачи не нужны: подпись и оплата не требуются.');
}
