// Отзывы Ozon → черновик ответа от Claude в стиле ваших прошлых ответов → Telegram (отдельный бот reviews-bot.js).
// На Ozon ответ уходит только по кнопке «Отправить» — после вашей проверки.
// Роли ключа Seller API: «Review read only» — читать отзывы; «Review» — ещё и публиковать ответы из бота.
import { request, sleep } from './http.js';
import { getDb, saveDb } from './db.js';
import { ask, aiEnabled } from './ai.js';
import { getSettings } from './settings.js';

const BASE = 'https://api-seller.ozon.ru';
const post = (p, body) => request(BASE + p, {
  method: 'POST', body, source: `Ozon отзывы (${p})`,
  headers: { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY }
});

// OZON_REVIEWS=0 — не проверять отзывы
export const reviewsEnabled = () => !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY) && process.env.OZON_REVIEWS !== '0';
export const reviewsMinutes = () => Math.max(5, Number(process.env.OZON_REVIEWS_MINUTES) || 15);
const FIRST_RUN_DAYS = 3, PER_RUN = 10, KEEP_DAYS = 30, MAX_EXAMPLES = 12;

// «Ответ сервиса: «…»» из текста ошибки — что именно сказал Ozon
const ozonSays = msg => (String(msg).match(/Ответ сервиса: «.*»/) || [''])[0];

const state = () => (getDb().state.reviews ||= { seen: {}, items: {}, started: false });

function setStatus(ok, error) {
  const db = getDb(), now = new Date().toISOString();
  db.status.reviews = ok ? { ok: true, error: null, at: now, lastOkAt: now } : { ...(db.status.reviews || {}), ok: false, error, at: now };
}

export function normReview(x) {
  return {
    id: String(x.id),
    sku: Number(x.sku) || null,
    rating: Number(x.rating) || 0,
    text: String(x.text || '').trim(),
    pros: String(x.pros || x.positive || '').trim(),
    cons: String(x.cons || x.negative || '').trim(),
    date: x.published_at || x.created_at || null,
    photos: Number(x.photos_amount) || 0,
    videos: Number(x.videos_amount) || 0,
    product: ''
  };
}

// Отзывы, свежие сначала: UNPROCESSED — новые, PROCESSED — те, на которые уже ответили
export async function fetchReviews(status = 'UNPROCESSED', pages = 3) {
  const out = [];
  let last_id = '';
  for (let page = 0; page < pages; page++) {
    const r = await post('/v1/review/list', { limit: 100, sort_dir: 'DESC', status, ...(last_id ? { last_id } : {}) });
    out.push(...(r?.reviews || []).map(normReview));
    last_id = r?.last_id || '';
    if (!r?.has_next || !last_id) break;
  }
  return out;
}

// Названия товаров по SKU. Если у ключа нет роли на товары — отзыв придёт без названия.
async function productNames(skus) {
  if (!skus.length) return {};
  try {
    const r = await post('/v3/product/info/list', { sku: skus.map(String) });
    const names = {};
    for (const it of r?.items || []) {
      const name = it.name || it.offer_id || '';
      for (const s of [it.sku, ...(it.sources || []).map(x => x.sku)]) if (s) names[Number(s)] = name;
    }
    return names;
  } catch (e) {
    console.error('[reviews] названия товаров:', e.message);
    return {};
  }
}

// ---------- Ваши прошлые ответы — образец стиля ----------

// Берём обработанные отзывы и ваши ответы на них (комментарий продавца). Обновляем раз в сутки.
// Негативные отзывы в образцах обязательно: на них тон отличается сильнее всего.
export async function styleExamples() {
  const st = state();
  if (st.examples && Date.now() - st.examples.at < 864e5) return st.examples.list;
  const list = [];
  try {
    const done = (await fetchReviews('PROCESSED', 1)).filter(r => r.text || r.pros || r.cons);
    const order = [...done.filter(r => r.rating <= 3).slice(0, 5), ...done.filter(r => r.rating > 3)];
    for (const r of order.slice(0, 30)) {
      if (list.length >= MAX_EXAMPLES) break;
      const c = await post('/v1/review/comment/list', { review_id: r.id, limit: 20, offset: 0, sort_dir: 'ASC' });
      const own = (c?.comments || []).find(x => x.is_owner || x.is_official);
      if (own?.text) list.push({ rating: r.rating, review: [r.text, r.pros && `Достоинства: ${r.pros}`, r.cons && `Недостатки: ${r.cons}`].filter(Boolean).join('\n'), answer: String(own.text).trim() });
      await sleep(300);
    }
    st.examples = { at: Date.now(), list };
  } catch (e) {
    console.error('[reviews] прошлые ответы для образца стиля:', e.message);
    // Повторим через час, а пока — что было
    st.examples = { at: Date.now() - 864e5 + 3600e3, list: st.examples?.list || [] };
  }
  saveDb();
  return st.examples.list;
}

// Образцы: ответы, отправленные из бота (их вы уже проверили), плюс прошлые ответы из кабинета
async function examplesFor() {
  const fromBot = Object.values(state().items).filter(it => it.sentText && !it.review.manual)
    .sort((a, b) => b.sentAt - a.sentAt).slice(0, 6)
    .map(it => ({ rating: it.review.rating, review: [it.review.text, it.review.pros, it.review.cons].filter(Boolean).join('\n'), answer: it.sentText }));
  const fromOzon = reviewsEnabled() ? await styleExamples() : [];
  const seen = new Set(fromBot.map(x => x.answer));
  return [...fromBot, ...fromOzon.filter(x => !seen.has(x.answer))].slice(0, MAX_EXAMPLES);
}

// ---------- Черновик ответа ----------

function replySystem(cfg, examples = []) {
  return `Ты пишешь ответы продавца на отзывы покупателей на Ozon. Отвечай по-русски.
${cfg.brand ? `Бренд: ${cfg.brand}.` : ''}
Обращайся к покупателю на «${cfg.address || 'вы'}». Тон: ${cfg.tone || 'тёплый, живой, без канцелярита и шаблонных фраз'}.
Правила:
- 2–4 предложения, без смайлов-гирлянд (максимум один уместный эмодзи), без хэштегов и ссылок.
- Отвечай на то, что написал покупатель: упомяни конкретную деталь из отзыва.
- Положительный отзыв: поблагодари, подчеркни то, что понравилось, мягко пригласи вернуться.
- Отрицательный: извинись без оправданий, коротко объясни или предложи решение. Не спорь и не обвиняй покупателя.
- Отзыв без текста, только оценка: короткая благодарность (или сожаление, если оценка низкая).
- Не обещай того, чего продавец не может гарантировать (возврат денег, компенсации, замену), и не проси менять оценку.
- Не упоминай, что ты ИИ. Не используй имя покупателя, если его нет в отзыве.
${cfg.rules ? `- ${[].concat(cfg.rules).join('\n- ')}` : ''}
${cfg.signature ? `В конце подпись: «${cfg.signature}».` : ''}
${examples.length ? `
Ниже — настоящие прошлые ответы этого продавца. Это главный ориентир: пиши так же — та же длина, обращение,
приветствие, подпись, манера и характерные фразы. Не копируй их дословно, отвечай на новый отзыв.
${examples.map((x, i) => `<example ${i + 1}>\nОценка: ${x.rating || '?'} из 5\nОтзыв: ${x.review}\nОтвет продавца: ${x.answer}\n</example>`).join('\n')}
` : ''}
Верни только текст ответа, без кавычек и пояснений.`;
}

export function reviewPrompt(r, { hint, previous } = {}) {
  const lines = [
    r.product && `Товар: ${r.product}`,
    r.rating && `Оценка: ${r.rating} из 5`,
    r.text && `Отзыв: ${r.text}`,
    r.pros && `Достоинства: ${r.pros}`,
    r.cons && `Недостатки: ${r.cons}`,
    !r.text && !r.pros && !r.cons && 'Текста нет, только оценка.',
    r.photos || r.videos ? `Покупатель приложил ${[r.photos && `фото: ${r.photos}`, r.videos && `видео: ${r.videos}`].filter(Boolean).join(', ')}.` : ''
  ].filter(Boolean);
  if (previous) lines.push(`\nПрошлый вариант ответа: ${previous}\nНапиши другой вариант, не повторяй формулировки.`);
  if (hint) lines.push(`\nПожелание к ответу: ${hint}`);
  return lines.join('\n');
}

// Тон ответов: переменные REVIEWS_* (удобно на хостинге) или раздел reviews в settings.json
export function replyConfig() {
  const e = process.env, s = getSettings().reviews || {};
  return {
    brand: e.REVIEWS_BRAND || s.brand,
    address: e.REVIEWS_ADDRESS || s.address,
    tone: e.REVIEWS_TONE || s.tone,
    signature: e.REVIEWS_SIGNATURE || s.signature,
    rules: e.REVIEWS_RULES ? e.REVIEWS_RULES.split(/\s*;\s*/).filter(Boolean) : s.rules
  };
}

export async function draftReply(review, opts = {}) {
  if (!aiEnabled()) throw new Error('Для черновиков ответа нужен ключ ANTHROPIC_API_KEY в .env.');
  const text = await ask({
    system: replySystem(replyConfig(), await examplesFor()),
    max_tokens: 1500,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: reviewPrompt(review, opts) }]
  });
  return text.trim().replace(/^«|»$/g, '');
}

// ---------- Проверка новых отзывов ----------

const stars = n => '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Карточка отзыва (HTML)
export function reviewCard(r) {
  const head = `${r.rating <= 3 ? '⚠️' : '💬'} <b>Новый отзыв Ozon</b> ${stars(r.rating)}`;
  const prod = r.product ? `<b>${esc(cut(r.product, 120))}</b>` : '';
  const sku = r.sku ? `<a href="https://www.ozon.ru/product/${r.sku}/">SKU ${r.sku}</a>` : '';
  const body = [
    r.text && esc(cut(r.text, 2500)),
    r.pros && `<b>Достоинства:</b> ${esc(cut(r.pros, 600))}`,
    r.cons && `<b>Недостатки:</b> ${esc(cut(r.cons, 600))}`,
    !r.text && !r.pros && !r.cons && '<i>без текста, только оценка</i>',
    r.photos || r.videos ? `📎 ${[r.photos && `фото: ${r.photos}`, r.videos && `видео: ${r.videos}`].filter(Boolean).join(', ')}` : ''
  ].filter(Boolean).join('\n');
  return [head, [prod, sku].filter(Boolean).join(' · '), '', body, '', '👇 Проверьте черновик ответа. На Ozon он уйдёт, только когда вы нажмёте «Отправить».'].join('\n');
}

// Черновик в теге <code>: в Telegram нажатие копирует его целиком
export const draftHtml = text => `<code>${esc(text)}</code>`;

// Отзыв, присланный текстом, отправить на Ozon нельзя — только другой вариант
export const draftButtons = (id, manual = String(id).startsWith('m')) => ({
  inline_keyboard: [
    ...(manual ? [] : [[{ text: '✅ Отправить на Ozon', callback_data: `rv:send:${id}` }]]),
    [
      { text: '🔄 Другой вариант', callback_data: `rv:again:${id}` },
      { text: '✏️ Свой текст', callback_data: `rv:edit:${id}` }
    ]
  ]
});
export const sentHtml = text => `${draftHtml(text)}\n\n✅ <b>Опубликовано на Ozon</b>`;

let checking = null;
// send(chat, html, extra) → message_id. Возвращает число отправленных отзывов.
export function checkReviews(send, chats) {
  if (checking) return checking;
  checking = (async () => {
    const st = state();
    let list;
    try {
      list = await fetchReviews();
      setStatus(true);
    } catch (e) {
      setStatus(false, /\(403\)/.test(e.message)
        ? `Ozon не даёт ключу читать отзывы (403). ${ozonSays(e.message)} Проверьте: у ключа из OZON_API_KEY отмечена роль «Review» и сохранена; OZON_CLIENT_ID — от того же кабинета. Если всё так, а 403 остаётся — Ozon открывает отзывы через API только с подпиской Premium Plus.`.replace(/\s+/g, ' ')
        : e.message);
      throw e;
    }
    // Первый запуск: старые отзывы не присылаем, только за последние дни
    if (!st.started) {
      const from = Date.now() - FIRST_RUN_DAYS * 864e5;
      for (const r of list) if (r.date && Date.parse(r.date) < from) st.seen[r.id] = Date.now();
      st.started = true;
    }
    const fresh = list.filter(r => !st.seen[r.id]).reverse().slice(0, PER_RUN);
    const names = await productNames([...new Set(fresh.map(r => r.sku).filter(Boolean))]);
    let sent = 0;
    for (const r of fresh) {
      r.product = names[r.sku] || '';
      let draft = '', err = '';
      try { draft = await draftReply(r); } catch (e) { err = e.message; }
      const msgs = {};
      for (const chat of chats) {
        try {
          await send(chat, reviewCard(r));
          msgs[chat] = [draft
            ? await send(chat, draftHtml(draft), { reply_markup: draftButtons(r.id) })
            : await send(chat, `Черновик не получился: ${esc(err)}`)];
        } catch (e) { console.error('[reviews] telegram:', e.message); }
      }
      st.seen[r.id] = Date.now();
      st.items[r.id] = { review: r, draft, msgs, at: Date.now() };
      sent++;
      saveDb();
    }
    prune(st);
    saveDb();
    return sent;
  })().finally(() => { checking = null; });
  return checking;
}

function prune(st) {
  const old = Date.now() - KEEP_DAYS * 864e5;
  for (const [id, it] of Object.entries(st.items)) if (it.at < old) delete st.items[id];
  // seen храним дольше: Ozon может долго держать отзыв необработанным
  const seenOld = Date.now() - 180 * 864e5;
  for (const [id, at] of Object.entries(st.seen)) if (at < seenOld) delete st.seen[id];
}

export const reviewItem = id => state().items[id] || null;

// Отзыв, присланный боту текстом (например, скопированный из кабинета) → черновик
export async function manualDraft(text) {
  const id = 'm' + Date.now().toString(36);
  const review = { ...normReview({ id, text }), manual: true };
  const draft = await draftReply(review);
  state().items[id] = { review, draft, msgs: {}, at: Date.now() };
  saveDb();
  return { id, draft };
}

export function rememberMessage(id, chat, messageId) {
  const it = reviewItem(id);
  if (!it || !messageId) return;
  const ids = ((it.msgs ||= {})[chat] ||= []);
  ids.push(messageId);
  if (ids.length > 20) ids.shift();
  saveDb();
}

// Сообщение-черновик (любой из вариантов), на которое ответили в Telegram → отзыв
export function reviewByMessage(chat, messageId) {
  for (const [id, it] of Object.entries(state().items)) if ([].concat(it.msgs?.[chat] ?? []).includes(messageId)) return { id, ...it };
  return null;
}

// Новый вариант (с пожеланием или без) — запоминается как текущий черновик
export async function redraft(id, hint) {
  const it = reviewItem(id);
  if (!it) throw new Error('Отзыв уже не найден — он старше 30 дней.');
  it.draft = await draftReply(it.review, { hint, previous: it.draft });
  saveDb();
  return it.draft;
}

// Ваш собственный текст ответа — становится черновиком как есть
export function setDraft(id, text) {
  const it = reviewItem(id);
  if (!it) throw new Error('Отзыв уже не найден — он старше 30 дней.');
  it.draft = String(text).trim();
  saveDb();
  return it.draft;
}

const sending = new Set();
// Публикация на Ozon — только по кнопке «Отправить». text — тот вариант, под которым нажата кнопка
// (по умолчанию последний черновик). Повторно не отправляется.
export async function sendReply(id, text) {
  const it = reviewItem(id);
  if (!it) throw new Error('Отзыв уже не найден — он старше 30 дней.');
  if (it.review.manual) throw new Error('Этот отзыв прислан текстом — опубликуйте ответ в кабинете Ozon сами.');
  if (it.sentAt) return { already: true, text: it.sentText };
  const answer = String(text || it.draft || '').trim();
  if (sending.has(id)) return { already: true, text: answer };
  if (!answer) throw new Error('Черновика нет — нажмите «Другой вариант».');
  sending.add(id);
  try {
    await post('/v1/review/comment/create', { review_id: id, text: answer, mark_review_as_processed: true });
  } catch (e) {
    throw new Error(/\(403\)/.test(e.message)
      ? `Ozon не дал опубликовать ответ (403). ${ozonSays(e.message)} В кабинете: Настройки → Seller API → ключ → отметьте роль «Review» (управление отзывами) и сохраните. Пока можно скопировать черновик и вставить его в кабинете.`.replace(/\s+/g, ' ')
      : e.message);
  } finally { sending.delete(id); }
  it.sentAt = Date.now();
  it.sentText = it.draft = answer;
  saveDb();
  return { text: it.sentText };
}
