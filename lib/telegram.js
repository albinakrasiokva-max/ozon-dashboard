// Telegram-бот: принимает пересланные файлы и фото, кладёт в Документы и отвечает, куда разложил.
// Токен — от @BotFather. Принимает файлы только из чатов, перечисленных в TELEGRAM_ALLOWED_CHATS.
import { request, download, sleep } from './http.js';
import { getDb, saveDb } from './db.js';
import { ingest, describe } from './docs.js';
import { dailyDigest, weeklyDigest, dueDigests } from './ozonDigest.js';

const API = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const SRC = 'Telegram';
export const enabled = () => !!process.env.TELEGRAM_BOT_TOKEN;
const allowed = () => String(process.env.TELEGRAM_ALLOWED_CHATS || '').split(/[\s,]+/).filter(Boolean);

const call = (method, body, timeout = 30000) => request(`${API()}/${method}`, { method: 'POST', body, source: SRC, timeout, retries: 0 });
// Сообщение с разметкой HTML (жирный и т.п.) — для сводок «Аналитики Ozon»
export const sendTo = (chat_id, text) => call('sendMessage', { chat_id, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
const reply = (chat_id, text, reply_to) => call('sendMessage', { chat_id, text, ...(reply_to ? { reply_parameters: { message_id: reply_to, allow_sending_without_reply: true } } : {}) }).catch(e => console.error('[telegram]', e.message));

function setStatus(ok, error) {
  const db = getDb(), now = new Date().toISOString();
  db.status.telegram = ok ? { ok: true, error: null, at: now, lastOkAt: now } : { ...(db.status.telegram || {}), ok: false, error, at: now };
}

// Одно сообщение → файл для ingest() или null
export async function fileFromMessage(m) {
  let f = null;
  if (m.document) f = { id: m.document.file_id, name: m.document.file_name || 'документ', mime: m.document.mime_type, size: m.document.file_size };
  else if (m.photo?.length) { const p = m.photo[m.photo.length - 1]; f = { id: p.file_id, name: `фото-${m.message_id}.jpg`, mime: 'image/jpeg', size: p.file_size }; }
  if (!f) return null;
  if (f.size > 20 * 1024 * 1024) throw new Error('Файл больше 20 МБ — Telegram не даёт ботам скачивать такие файлы.');
  const info = await call('getFile', { file_id: f.id });
  const { buffer } = await download(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`, { source: SRC });
  const who = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || m.from?.username || '';
  return { source: 'Telegram', name: f.name, buffer, mime: f.mime, from: who, externalId: `${m.chat.id}:${m.message_id}` };
}

export async function handleUpdate(u) {
  const m = u.message || u.channel_post;
  if (!m?.chat) return;
  const chat = String(m.chat.id);
  if (!allowed().includes(chat)) {
    return reply(chat, `Этот чат не подключён к дашборду. Ваш chat id: ${chat}. Добавьте его в TELEGRAM_ALLOWED_CHATS в .env на сервере и перезапустите сервер.`);
  }
  const text = String(m.text || '').trim();
  if (/^\/(svodka|summary)|^сводк/i.test(text)) return sendTo(chat, dailyDigest()).catch(e => reply(chat, 'Не получилось собрать сводку: ' + e.message));
  if (/^\/(nedelya|week)|^недел/i.test(text)) return sendTo(chat, weeklyDigest()).catch(e => reply(chat, 'Не получилось собрать отчёт: ' + e.message));
  if (process.env.OZON_ONLY === '1' && !m.document && !m.photo) {
    return reply(chat, `Я присылаю сводку «Аналитики Ozon» каждое утро в ${process.env.TELEGRAM_DIGEST_HOUR ?? 9}:00 по Москве, по понедельникам — итоги недели.\n/svodka — сводка за 7 дней сейчас\n/nedelya — итоги прошлой недели`, m.message_id);
  }
  if (!m.document && !m.photo) {
    return reply(chat, 'Пришлите или перешлите мне счёт, акт или договор — файлом или фото. Я положу его в Документы, распознаю и создам задачи «подписать» и «оплатить».', m.message_id);
  }
  try {
    const file = await fileFromMessage(m);
    const { duplicate, done } = ingest(file);
    reply(chat, describe(await done, duplicate), m.message_id);
  } catch (e) {
    reply(chat, 'Не получилось принять файл: ' + e.message, m.message_id);
  }
}

let running = false;
export async function startTelegram() {
  if (!enabled() || running) return;
  running = true;
  const db = getDb();
  console.log('Telegram-бот запущен.');
  while (running) {
    try {
      const r = await call('getUpdates', { offset: (db.state.tgOffset || 0) + 1, timeout: 25, allowed_updates: ['message', 'channel_post'] }, 40000);
      setStatus(true);
      for (const u of r?.result || []) {
        db.state.tgOffset = Math.max(db.state.tgOffset || 0, u.update_id);
        saveDb();
        await handleUpdate(u);
      }
    } catch (e) {
      setStatus(false, e.message);
      await sleep(15000);
    }
  }
}
export const stopTelegram = () => { running = false; };

// Утренняя сводка и недельный отчёт во все чаты из TELEGRAM_ALLOWED_CHATS. Вызывается раз в минуту.
export async function maybeSendDigests() {
  if (!enabled() || !allowed().length) return;
  const msgs = dueDigests();
  if (!msgs.length) return;
  saveDb();
  for (const chat of allowed()) for (const text of msgs) await sendTo(chat, text).catch(e => console.error('[telegram] сводка:', e.message));
  console.log(`[telegram] отправлена сводка в ${allowed().length} чат(а)`);
}
