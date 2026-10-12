// Отдельный Telegram-бот для ответов на отзывы Ozon. С дашбордом не связан: свой токен, своя база.
// Новые отзывы приходят в чат с черновиком ответа от Claude в стиле ваших прошлых ответов.
// На Ozon ответ уходит только по кнопке «Отправить» — после вашей проверки.
// Запуск: npm run bot. Ключи — в .env (раздел «Бот для отзывов»).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';
import { request, sleep } from './lib/http.js';
import { getDb, saveDb } from './lib/db.js';
import { aiEnabled } from './lib/ai.js';
import * as reviews from './lib/reviews.js';

const API = () => `https://api.telegram.org/bot${process.env.REVIEWS_BOT_TOKEN}`;
const SRC = 'Telegram (бот отзывов)';
const allowed = () => String(process.env.REVIEWS_ALLOWED_CHATS || '').split(/[\s,]+/).filter(Boolean);

const call = (method, body, timeout = 30000) => request(`${API()}/${method}`, { method: 'POST', body, source: SRC, timeout, retries: 0 });
// HTML-сообщение → его message_id (нужен, чтобы потом заменить черновик)
const sendHtml = async (chat_id, text, extra = {}) => (await call('sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra }))?.result?.message_id;
const reply = (chat_id, text, reply_to) => call('sendMessage', { chat_id, text, ...(reply_to ? { reply_parameters: { message_id: reply_to, allow_sending_without_reply: true } } : {}) }).catch(e => console.error('[bot]', e.message));
const replyTo = id => ({ reply_parameters: { message_id: id, allow_sending_without_reply: true } });

const HELP = 'Я присылаю новые отзывы Ozon с черновиком ответа в стиле ваших прошлых ответов. ' +
  'На Ozon ответ уходит, только когда вы нажмёте «✅ Отправить на Ozon».\n\n' +
  '• «🔄 Другой вариант» — перепишу ответ.\n' +
  '• «✏️ Свой текст» — пришлите исправленный ответ, я покажу его с кнопкой «Отправить».\n' +
  '• Ответьте (reply) на черновик пожеланием — «короче», «предложи размер побольше» — и я перепишу.\n' +
  '• Пришлите текст любого отзыва — напишу ответ на него.\n' +
  '/otzyvy — проверить новые отзывы сейчас';

// Чат ждёт исправленный текст ответа после кнопки «Свой текст»: chat → id отзыва
const waitingText = new Map();

// Черновик новым сообщением с кнопками
async function sendDraft(chat, id, draft, replyToId) {
  const mid = await sendHtml(chat, reviews.draftHtml(draft), { reply_markup: reviews.draftButtons(id), ...(replyToId ? replyTo(replyToId) : {}) });
  reviews.rememberMessage(id, chat, mid);
}

// Кнопки под черновиком: «Отправить на Ozon», «Другой вариант», «Свой текст»
async function handleCallback(q) {
  const chat = String(q.message?.chat?.id ?? '');
  const answer = text => call('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(e => console.error('[bot]', e.message));
  const [kind, action, id] = String(q.data || '').split(':');
  if (kind !== 'rv' || !allowed().includes(chat) || !q.message) return answer();
  const msg = { chat_id: chat, message_id: q.message.message_id };
  if (action === 'send') {
    await answer('Отправляю на Ozon…');
    try {
      const r = await reviews.sendReply(id, q.message.text); // ровно тот текст, что вы видите над кнопкой
      await call('editMessageText', { ...msg, text: reviews.sentHtml(r.text), parse_mode: 'HTML' }).catch(() => {});
      if (r.already) reply(chat, 'Этот ответ уже отправлен на Ozon.', q.message.message_id);
    } catch (e) { reply(chat, 'Не отправлено: ' + e.message, q.message.message_id); }
    return;
  }
  if (action === 'edit') {
    if (!reviews.reviewItem(id)) return answer('Отзыв уже не найден');
    waitingText.set(chat, id);
    await answer();
    return reply(chat, 'Пришлите исправленный текст ответа одним сообщением — я покажу его с кнопкой «Отправить». Передумали — /otmena.', q.message.message_id);
  }
  if (action === 'again') {
    await answer('Пишу другой вариант…');
    try {
      const draft = await reviews.redraft(id);
      await call('editMessageText', { ...msg, text: reviews.draftHtml(draft), parse_mode: 'HTML', reply_markup: reviews.draftButtons(id) });
    } catch (e) { reply(chat, 'Не получилось написать другой вариант: ' + e.message, q.message.message_id); }
  }
}

export async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const m = u.message;
  if (!m?.chat) return;
  const chat = String(m.chat.id);
  if (!allowed().includes(chat)) {
    return reply(chat, `Этот чат не подключён. Ваш chat id: ${chat}. Добавьте его в REVIEWS_ALLOWED_CHATS и перезапустите бота.`);
  }
  const text = String(m.text || '').trim();
  if (/^\/(otzyvy|reviews)|^отзывы$/i.test(text)) {
    if (!reviews.reviewsEnabled()) return reply(chat, 'Отзывы не проверяются: нужны OZON_CLIENT_ID и OZON_API_KEY.', m.message_id);
    return reviews.checkReviews(sendHtml, allowed())
      .then(n => { if (!n) reply(chat, 'Новых отзывов нет.', m.message_id); })
      .catch(e => reply(chat, 'Не получилось получить отзывы: ' + (getDb().status.reviews?.error || e.message), m.message_id));
  }
  if (/^\/(otmena|cancel)/i.test(text)) { waitingText.delete(chat); return reply(chat, 'Хорошо, ничего не меняю.', m.message_id); }
  // После «Свой текст»: сообщение — это готовый ответ, без ИИ
  if (text && !text.startsWith('/') && waitingText.has(chat)) {
    const id = waitingText.get(chat);
    waitingText.delete(chat);
    try { await sendDraft(chat, id, reviews.setDraft(id, text), m.message_id); }
    catch (e) { reply(chat, 'Не получилось: ' + e.message, m.message_id); }
    return;
  }
  if (!text || text.startsWith('/')) return reply(chat, HELP, m.message_id);
  if (!aiEnabled()) return reply(chat, 'Для ответов нужен ключ ANTHROPIC_API_KEY.', m.message_id);
  // Ответ (reply) на черновик — пожелание к нему: переписываем
  const target = m.reply_to_message && reviews.reviewByMessage(chat, m.reply_to_message.message_id);
  try {
    const { id, draft } = target
      ? { id: target.id, draft: await reviews.redraft(target.id, text) }
      : await reviews.manualDraft(text); // иначе текст — это отзыв, на который нужен ответ
    await sendDraft(chat, id, draft, m.message_id);
  } catch (e) { reply(chat, 'Не получилось написать ответ: ' + e.message, m.message_id); }
}

// Проверка новых отзывов раз в OZON_REVIEWS_MINUTES (по умолчанию 15). Вызывается раз в минуту.
let checkedAt = 0, lastCheckError = '';
export async function maybeCheckReviews() {
  if (!allowed().length || !reviews.reviewsEnabled()) return;
  if (Date.now() - checkedAt < reviews.reviewsMinutes() * 60000) return;
  checkedAt = Date.now();
  try {
    const n = await reviews.checkReviews(sendHtml, allowed());
    if (n) console.log(`[bot] прислано отзывов: ${n}`);
    lastCheckError = '';
  } catch (e) {
    // В лог — только когда ошибка сменилась
    const msg = getDb().status.reviews?.error || e.message;
    if (msg !== lastCheckError) console.error('[bot] отзывы:', msg);
    lastCheckError = msg;
  }
}

let running = false;
async function poll() {
  running = true;
  const db = getDb();
  let lastError = '';
  while (running) {
    try {
      const r = await call('getUpdates', { offset: (db.state.tgOffset || 0) + 1, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
      if (lastError) { console.log('[bot] снова получает сообщения'); lastError = ''; }
      for (const u of r?.result || []) {
        db.state.tgOffset = Math.max(db.state.tgOffset || 0, u.update_id);
        saveDb();
        await handleUpdate(u).catch(e => console.error('[bot]', e.message));
      }
    } catch (e) {
      if (e.message !== lastError) console.error('[bot] не получает сообщения:', e.message);
      lastError = e.message;
      await sleep(15000);
    }
  }
}

function main() {
  loadEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'));
  // Своя база, чтобы не смешиваться с дашбордом, если запущены из одной папки
  process.env.DATA_DIR ||= 'data-reviews';
  if (!process.env.REVIEWS_BOT_TOKEN) {
    console.error('Нет REVIEWS_BOT_TOKEN. В Telegram: @BotFather → /newbot → скопируйте токен в .env.');
    process.exit(1);
  }
  const missing = ['OZON_CLIENT_ID', 'OZON_API_KEY', 'ANTHROPIC_API_KEY', 'REVIEWS_ALLOWED_CHATS'].filter(k => !process.env[k]);
  if (missing.length) console.warn(`Не заданы: ${missing.join(', ')}. Бот запущен, но ${missing.includes('REVIEWS_ALLOWED_CHATS') ? 'напишите ему — он ответит вашим chat id' : 'часть функций не работает'}.`);

  // Хостинг (Railway) проверяет, что сервис жив: отвечаем на /api/health
  const port = Number(process.env.PORT) || 0;
  if (port) http.createServer((req, res) => {
    const st = getDb().status.reviews || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, reviews: { ok: st.ok ?? null, error: st.error || null, at: st.at || null } }));
  }).listen(port, process.env.HOST || '0.0.0.0');

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
    running = false;
    try { saveDb(); } catch {}
    process.exit(0);
  });

  console.log(`Бот для отзывов Ozon запущен. Проверка отзывов каждые ${reviews.reviewsMinutes()} мин.`);
  setInterval(() => maybeCheckReviews(), 60000).unref();
  maybeCheckReviews();
  poll();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
