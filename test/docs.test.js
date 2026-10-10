// Этап 3: документы и ИИ. Ответы Claude, Telegram и письма подменены тестовыми. Запуск: npm test
import { calls, installMock, claudeMessage, D } from './fixtures.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brandos-docs-'));
const SETTINGS_FILE = path.join(DIR, 'settings.json');
fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
  ownerName: 'Тест', team: ['Алексей', 'Елена (бухгалтер)'], assignees: { sign: 'Алексей', pay: 'Елена (бухгалтер)' },
  company: { name: 'ООО Бренд', inn: '7700000000' }, payWithinDays: 3
}));
Object.assign(process.env, {
  NO_SLEEP: '1', DATA_DIR: path.join(DIR, 'data'), SETTINGS_FILE,
  ANTHROPIC_API_KEY: 'sk-ant-test', TELEGRAM_BOT_TOKEN: 'tg-test', TELEGRAM_ALLOWED_CHATS: '42'
});
for (const k of ['WB_TOKEN', 'OZON_CLIENT_ID', 'OZON_API_KEY', 'OZON_PERF_CLIENT_ID', 'AMO_SUBDOMAIN', 'TBANK_TOKEN', 'MAIL_USER', 'DIADOC_API_KEY', 'BITRIX_WEBHOOK_URL', 'TOCHKA_TOKEN']) delete process.env[k];

const { getDb } = await import('../lib/db.js');
const { ingest } = await import('../lib/docs.js');
const { chat } = await import('../lib/ai.js');
const { handleUpdate } = await import('../lib/telegram.js');
const { attachmentsFromSource } = await import('../lib/connectors/mail.js');
const { snapshotForAI } = await import('../lib/snapshot.js');
const { buildDashboard } = await import('../lib/aggregate.js');

const PDF = Buffer.from('%PDF-1.4\n% тестовый счёт\n');
const claudeRequests = [];

// «Claude»: по имени файла отдаёт поля счёта или акта, на вопрос в чате — ответ с цифрой из снимка
function fakeClaude(u, opt) {
  const body = JSON.parse(opt.body);
  claudeRequests.push({ body, headers: new Headers(opt.headers) });
  if (body.output_config?.format) {
    const text = body.messages[0].content.find(b => b.type === 'text').text;
    const isAct = /акт/i.test(text);
    return claudeMessage(JSON.stringify(isAct
      ? { type: 'Акт', number: '17', counterparty: 'ООО «Логистика»', counterpartyInn: '7701', amount: 56000, date: D(1), dueDate: null, needsSignature: true, needsPayment: false, section: 'Поставки', summary: 'Акт оказанных услуг доставки за сентябрь, нужно подписать.' }
      : { type: 'Счёт', number: '412', counterparty: 'ИП Сидоров', counterpartyInn: '7702', amount: 84000.5, date: D(2), dueDate: D(-5), needsSignature: false, needsPayment: true, section: 'Финансы', summary: 'Счёт за упаковку, оплатить до срока.' }));
  }
  const data = body.system.map(b => b.text).join('\n');
  const docsCount = JSON.parse(data.split('<business_data>\n')[1].split('\n</business_data>')[0]).documents.length;
  return claudeMessage(`В документах ${docsCount} шт.`);
}

const telegramSent = [];
const TG = {
  'api.anthropic.com/v1/messages': fakeClaude,
  'api.telegram.org/bottg-test/getFile': () => ({ ok: true, result: { file_path: 'documents/file_1.pdf' } }),
  'api.telegram.org/file/bottg-test/documents/file_1.pdf': () => Buffer.from('%PDF-1.4\n% акт из телеграма\n'),
  'api.telegram.org/bottg-test/sendMessage': (u, opt) => { telegramSent.push(JSON.parse(opt.body)); return { ok: true, result: {} }; }
};

before(() => installMock({}, TG));

test('счёт распознаётся в строгий JSON и превращается в задачу «оплатить»', async () => {
  const { doc, done } = ingest({ source: 'Загрузка', name: 'Счёт 412.pdf', buffer: PDF, mime: 'application/pdf' });
  assert.equal(doc.ai, 'pending');
  const { tasks } = await done;
  assert.equal(doc.type, 'Счёт'); assert.equal(doc.cp, 'ИП Сидоров'); assert.equal(doc.sum, 84000.5);
  assert.equal(doc.due, D(-5)); assert.equal(doc.needPay, true); assert.equal(doc.ai, 'done');
  assert.equal(tasks.length, 1);
  const t = tasks[0];
  assert.match(t.title, /^Оплатить: Счёт №412 ИП Сидоров — 84\s000,5\s₽$/);
  assert.equal(t.doc, doc.id); assert.equal(t.who, 'Елена (бухгалтер)'); assert.equal(t.ai, true); assert.equal(t.due, D(-5));
  assert.ok(getDb().store.tasks.some(x => x.id === t.id), 'задача сохранена на сервере');
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'files', doc.file)), 'файл сохранён');

  // Запрос к Claude: PDF как document, схема, fallbacks
  const r = claudeRequests.at(-1);
  assert.equal(r.body.model, 'claude-opus-5-5');
  assert.equal(r.body.fallbacks, 'default');
  assert.match(r.headers.get('anthropic-beta'), /server-side-fallback-2026-07-01/);
  assert.equal(r.body.messages[0].content[0].type, 'document');
  assert.equal(r.body.messages[0].content[0].source.media_type, 'application/pdf');
  assert.equal(r.body.output_config.format.type, 'json_schema');
  assert.equal(r.body.output_config.format.schema.additionalProperties, false);
  assert.match(r.body.system, /ООО Бренд, ИНН 7700000000/);
});

test('тот же файл второй раз не дублируется', () => {
  const { duplicate } = ingest({ source: 'Почта', name: 'копия.pdf', buffer: PDF, mime: 'application/pdf' });
  assert.equal(duplicate, true);
  assert.equal(getDb().store.docs.length, 1);
});

test('Telegram: чужой чат получает свой chat id, свой — ответ, куда разложен документ', async () => {
  await handleUpdate({ update_id: 1, message: { message_id: 5, chat: { id: 777 }, text: 'привет' } });
  assert.match(telegramSent.at(-1).text, /chat id: 777/);
  assert.equal((getDb().store.docs || []).length, 1, 'из чужого чата ничего не принято');

  await handleUpdate({ update_id: 2, message: { message_id: 6, chat: { id: 42 }, from: { first_name: 'Мария' }, document: { file_id: 'F1', file_name: 'Акт 17.pdf', mime_type: 'application/pdf', file_size: 100 } } });
  const msg = telegramSent.at(-1);
  assert.equal(msg.chat_id, '42');
  assert.match(msg.text, /Акт, ООО «Логистика», 56\s000\s₽/);
  assert.match(msg.text, /Подписать: Акт №17 ООО «Логистика» \(Алексей\)/);
  const doc = getDb().store.docs.find(d => d.source === 'Telegram');
  assert.equal(doc.status, 'Ждёт подписи'); assert.equal(doc.from, 'Мария');
  assert.ok(!calls.some(c => c.url.includes('tg-test') && c.body?.includes?.('tg-test')), 'токен не в теле запросов');
});

test('почта: из письма берутся PDF-вложения, текст и подписи-картинки — нет', async () => {
  const b64 = PDF.toString('base64');
  const raw = [
    'From: Бухгалтерия <buh@vendor.ru>', 'To: owner@brand.ru', 'Subject: Счёт', 'Date: Fri, 09 Oct 2026 10:00:00 +0300',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', 'Добрый день, счёт во вложении.', '',
    '--b1', 'Content-Type: application/pdf; name="schet.pdf"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="schet.pdf"', '', b64, '',
    '--b1', 'Content-Type: application/zip; name="arch.zip"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="arch.zip"', '', 'UEsDBA==', '',
    '--b1--', ''
  ].join('\r\n');
  const files = await attachmentsFromSource(Buffer.from(raw), '1:99');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'schet.pdf'); assert.equal(files[0].mime, 'application/pdf');
  assert.equal(files[0].from, 'Бухгалтерия <buh@vendor.ru>'); assert.equal(files[0].externalId, '1:99:0');
  assert.equal(files[0].date, '2026-10-09');
  assert.ok(files[0].buffer.equals(PDF));
});

test('ИИ-чат получает живые данные, демо-цифр в снимке нет', async () => {
  const dash = buildDashboard({ raw: {}, enabled: ['ai'], settings: { cogsPercent: 40, payments: [], team: [] } });
  const snap = snapshotForAI(dash, getDb().store, [{ name: 'Wildberries', enabled: false }]);
  assert.equal(snap.kpiMonthToDate.revenue, undefined, 'без WB/Ozon выручки нет');
  assert.ok(snap.notConnected.includes('Wildberries'));
  assert.ok(snap.notConnected.some(x => x.startsWith('выручка')));
  assert.equal(snap.documents.length, 2);
  assert.ok(snap.openTasks.some(t => t.title.startsWith('Оплатить')));
  const text = await chat([{ role: 'user', text: 'Сколько документов?' }], snap);
  assert.equal(text, 'В документах 2 шт.');
  const r = claudeRequests.at(-1);
  assert.match(r.body.system[0].text, /Ничего не выдумывай/);
  assert.deepEqual(r.body.system[1].cache_control, { type: 'ephemeral' });
});

test('неверный ключ Claude: документ помечен ошибкой понятным текстом', async () => {
  installMock({ 'api.anthropic.com': 401 }, TG);
  const { doc, done } = ingest({ source: 'Загрузка', name: 'Счёт 2.pdf', buffer: Buffer.from('%PDF-1.4\n% другой\n'), mime: 'application/pdf' });
  await done;
  assert.equal(doc.ai, 'error');
  assert.match(doc.aiError, /ключ не принят \(401\)/);
  assert.equal(getDb().status.ai.ok, false);
  installMock({}, TG);
});

test('сервер: загрузка без ключа ИИ, файл, задачи по одной, чат без ключа', async () => {
  const PORT = 3931, base = `http://127.0.0.1:${PORT}`;
  const env = { PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: path.join(DIR, 'srv'), SETTINGS_FILE, NO_SYNC: '1' };
  const p = spawn(process.execPath, ['server.js'], { env, cwd: new URL('..', import.meta.url).pathname });
  try {
    for (let i = 0; i < 50; i++) { try { await req(base + '/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const up = await req(base + '/api/docs/upload', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('Счёт №5.pdf') }, body: PDF });
    assert.equal(up.status, 201);
    const doc = JSON.parse(up.body).doc;
    assert.equal(doc.name, 'Счёт №5.pdf'); assert.equal(doc.ai, 'off');
    const file = await req(`${base}/api/docs/${doc.id}/file`);
    assert.equal(file.status, 200); assert.equal(file.headers['content-type'], 'application/pdf');
    assert.match(file.headers['content-security-policy'], /sandbox/);

    // правки по одному элементу не затирают друг друга
    await req(`${base}/api/store/tasks/t1`, { method: 'PATCH', body: JSON.stringify({ title: 'A', status: 'todo' }) });
    await req(`${base}/api/store/tasks/t2`, { method: 'PATCH', body: JSON.stringify({ title: 'B', status: 'todo' }) });
    await req(`${base}/api/store/tasks/t1`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    await req(`${base}/api/store/docs/${doc.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'Обработан', file: '../../etc/passwd' }) });
    const tasks = JSON.parse((await req(`${base}/api/store/tasks`)).body).items;
    assert.deepEqual(tasks.map(t => [t.id, t.title, t.status]), [['t1', 'A', 'done'], ['t2', 'B', 'todo']]);
    const d2 = JSON.parse((await req(`${base}/api/store/docs`)).body).items[0];
    assert.equal(d2.status, 'Обработан'); assert.equal(d2.file, doc.file, 'служебное поле не меняется из браузера');
    await req(`${base}/api/store/tasks/t2`, { method: 'DELETE' });
    assert.equal(JSON.parse((await req(`${base}/api/store/tasks`)).body).items.length, 1);

    const c = await req(base + '/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', text: 'привет' }] }) });
    assert.equal(c.status, 409);
    assert.match(JSON.parse(c.body).error, /Нет ключа Claude API/);
  } finally { p.kill(); }
});

// globalThis.fetch подменён — для настоящего HTTP к своему серверу используем node:http
async function req(url, { method = 'GET', headers = {}, body } = {}) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const r = request(url, { method, headers: body && !headers['Content-Type'] ? { 'Content-Type': 'application/json', ...headers } : headers }, res => {
      const chunks = [];
      res.on('data', ch => chunks.push(ch));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
