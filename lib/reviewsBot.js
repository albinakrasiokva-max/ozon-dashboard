// Отдельный Telegram-бот для ответов на отзывы Ozon. С дашбордом не связан: свой токен, своя база.
// Новые отзывы приходят в чат с черновиком ответа от Claude в стиле ваших прошлых ответов.
// На Ozon ответ уходит только по кнопке «Отправить» — после вашей проверки.
// Запуск: npm run bot (reviews-bot.js вызывает main()). Ключи — в .env (раздел «Бот для отзывов»).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.js';
import { request, download, sleep } from './http.js';
import { getDb, saveDb } from './db.js';
import { aiEnabled } from './ai.js';
import * as reviews from './reviews.js';

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
  '• Пришлите текст или скриншот отзыва — напишу ответ на него. В подписи к скриншоту можно добавить пожелание.\n\n' +
  'Образцы вашего стиля:\n' +
  '/primer — включить приём образцов: присылайте свои прошлые ответы текстом («Отзыв: … Ответ: …» или просто ответ) или скриншотами с вашим ответом под отзывом\n' +
  '/gotovo — закончить приём образцов\n' +
  '/primery — сколько образцов сохранено\n' +
  '/primery_udalit — удалить все образцы\n\n' +
  '/otzyvy — проверить новые отзывы сейчас';

// Чат ждёт исправленный текст ответа после кнопки «Свой текст»: chat → id отзыва
const waitingText = new Map();
// Чаты в режиме приёма образцов (/primer … /gotovo)
const primerMode = new Set();

// Самое крупное фото или картинка-файл из сообщения → { buffer, mime } или null
async function imageFromMessage(m) {
  let f = null;
  if (m.photo?.length) { const p = m.photo[m.photo.length - 1]; f = { id: p.file_id, mime: 'image/jpeg', size: p.file_size }; }
  else if (m.document && /^image\//.test(m.document.mime_type || '')) f = { id: m.document.file_id, mime: m.document.mime_type, size: m.document.file_size };
  if (!f) return null;
  if (f.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы.');
  const info = await call('getFile', { file_id: f.id });
  const { buffer } = await download(`https://api.telegram.org/file/bot${process.env.REVIEWS_BOT_TOKEN}/${info.result.file_path}`, { source: SRC });
  return { buffer, mime: f.mime };
}

const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;
const primersCount = () => plural(reviews.primers().length, 'образец', 'образца', 'образцов');

// Скриншот в режиме образцов: сохраняем ваши ответы, что видны под отзывами
async function primerFromShot(chat, m, img) {
  const found = (await reviews.readReviewShot(img.buffer, img.mime)).filter(r => r.sellerAnswer);
  if (!found.length) return reply(chat, 'На скриншоте не нашёл ответа продавца. Пришлите скриншот, где под отзывом виден ваш ответ, или ответ текстом.', m.message_id);
  for (const r of found) reviews.addPrimer({ review: [r.text, r.pros && `Достоинства: ${r.pros}`, r.cons && `Недостатки: ${r.cons}`].filter(Boolean).join('\n'), answer: r.sellerAnswer, rating: r.rating });
  return reply(chat, `Сохранил ${plural(found.length, 'ответ', 'ответа', 'ответов')} со скриншота. Всего ${primersCount()}. Ещё образцы — или /gotovo.`, m.message_id);
}

// Скриншот отзыва: распознаём и пишем черновик на каждый отзыв
async function draftsFromShot(chat, m, img) {
  await reply(chat, 'Читаю скриншот…', m.message_id);
  const found = await reviews.readReviewShot(img.buffer, img.mime);
  if (!found.length) return reply(chat, 'На картинке не нашёл отзыва. Пришлите скриншот отзыва из кабинета или с сайта Ozon — или текст отзыва.', m.message_id);
  const hint = String(m.caption || '').trim();
  for (const r of found) {
    const { id, draft } = await reviews.manualDraft(r, { hint });
    await sendHtml(chat, reviews.reviewCard({ ...r, manual: true }, 'Отзыв со скриншота'), replyTo(m.message_id));
    await sendDraft(chat, id, draft);
  }
}

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
  if (/^\/(otmena|cancel)/i.test(text)) { waitingText.delete(chat); primerMode.delete(chat); return reply(chat, 'Хорошо, ничего не меняю.', m.message_id); }
  if (/^\/primer\b/i.test(text) && !/^\/primery/i.test(text)) {
    primerMode.add(chat);
    return reply(chat, `Присылайте свои прошлые ответы на отзывы — по одному в сообщении. Можно так:\nОтзыв: текст отзыва\nОтвет: ваш ответ\n\nили просто текст ответа, или скриншот, где под отзывом виден ваш ответ. Лучше 5–10 штук, обязательно пару ответов на негатив.\nСейчас сохранено: ${primersCount()}. Закончить — /gotovo.`, m.message_id);
  }
  if (/^\/gotovo/i.test(text)) {
    primerMode.delete(chat);
    return reply(chat, `Готово, сохранено ${primersCount()}. Теперь пишу ответы в этом стиле.`, m.message_id);
  }
  if (/^\/primery_udalit/i.test(text)) { reviews.clearPrimers(); return reply(chat, 'Все образцы удалены.', m.message_id); }
  if (/^\/primery/i.test(text)) {
    const list = reviews.primers();
    if (!list.length) return reply(chat, 'Образцов пока нет. Добавить — /primer.', m.message_id);
    const last = list.slice(-3).map((x, i) => `${i + 1}. ${x.answer.length > 150 ? x.answer.slice(0, 149) + '…' : x.answer}`).join('\n');
    return reply(chat, `Сохранено ${primersCount()}. Последние:\n${last}\n\nДобавить — /primer, удалить все — /primery_udalit.`, m.message_id);
  }
  // Скриншот: образец (в режиме /primer) или отзыв, на который нужен ответ
  if (m.photo || m.document) {
    if (!aiEnabled()) return reply(chat, 'Для скриншотов нужен ключ ANTHROPIC_API_KEY.', m.message_id);
    try {
      const img = await imageFromMessage(m);
      if (!img) return reply(chat, 'Пришлите скриншот картинкой (фото) или текст отзыва.', m.message_id);
      return await (primerMode.has(chat) ? primerFromShot(chat, m, img) : draftsFromShot(chat, m, img));
    } catch (e) { return reply(chat, 'Не получилось прочитать скриншот: ' + e.message, m.message_id); }
  }
  // Режим образцов: текст — ваш прошлый ответ
  if (primerMode.has(chat) && text && !text.startsWith('/')) {
    try { reviews.addPrimer(reviews.parsePrimer(text)); reply(chat, `Сохранил. Всего ${primersCount()}. Ещё — или /gotovo.`, m.message_id); }
    catch (e) { reply(chat, e.message, m.message_id); }
    return;
  }
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

export function main() {
  loadEnv(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'));
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

