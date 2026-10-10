// Почта по IMAP: вложения из новых писем (PDF, фото, XML). Письма не помечаются прочитанными.
// Нужен пароль приложения (Яндекс ID / Google / Mail.ru → Безопасность → Пароли приложений).
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb, normDate, daysAgo } from '../db.js';
import { guessMime } from '../docs.js';

export const docs = true;
export const enabled = () => !!(process.env.MAIL_USER && process.env.MAIL_PASSWORD);

const HOSTS = { 'yandex.ru': 'imap.yandex.ru', 'ya.ru': 'imap.yandex.ru', 'gmail.com': 'imap.gmail.com', 'mail.ru': 'imap.mail.ru', 'bk.ru': 'imap.mail.ru', 'inbox.ru': 'imap.mail.ru', 'list.ru': 'imap.mail.ru' };
const host = () => process.env.MAIL_HOST || HOSTS[String(process.env.MAIL_USER).split('@')[1]?.toLowerCase()] || '';
const KEEP = /^(application\/pdf|image\/(jpeg|png|gif|webp)|application\/xml|text\/xml)$/;
const MAX_NEW = 200; // за один проход

// Вложения одного письма → файлы для ingest()
export async function attachmentsFromSource(source, key) {
  const m = await simpleParser(source);
  const f = m.from?.value?.[0];
  const from = f ? (f.name ? `${f.name} <${f.address}>` : f.address || '') : '';
  return (m.attachments || [])
    .map((a, i) => ({ a, i, mime: guessMime(a.filename, a.contentType) }))
    .filter(({ a, mime }) => KEEP.test(mime) && a.content?.length && a.content.length <= 20 * 1024 * 1024 && !(a.related && mime.startsWith('image/')))
    .map(({ a, i, mime }) => ({
      source: 'Почта', name: a.filename || `вложение-${i + 1}`, buffer: a.content, mime, from,
      date: normDate(m.date) || undefined, externalId: `${key}:${i}`
    }));
}

export async function sync() {
  if (!host()) throw new Error('Почта: не удалось определить IMAP-сервер — укажите MAIL_HOST в .env');
  const db = getDb(), st = (db.state.mail ??= {});
  const client = new ImapFlow({
    host: host(), port: Number(process.env.MAIL_PORT) || 993, secure: true, logger: false,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD }
  });
  try { await client.connect(); }
  catch (e) {
    throw new Error(e.authenticationFailed
      ? 'Почта: логин или пароль не приняты. Нужен пароль приложения, а не обычный пароль; IMAP должен быть включён в настройках ящика.'
      : `Почта: не удалось подключиться к ${host()} (${e.code || e.message}).`);
  }
  const files = [];
  const lock = await client.getMailboxLock(process.env.MAIL_FOLDER || 'INBOX');
  try {
    const validity = String(client.mailbox.uidValidity);
    if (st.uidValidity !== validity) { st.uidValidity = validity; st.lastUid = 0; }
    // Первый запуск — письма за 14 дней, дальше — только новые по UID
    const uids = st.lastUid
      ? (await client.search({ uid: `${st.lastUid + 1}:*` }, { uid: true })).filter(u => u > st.lastUid)
      : await client.search({ since: daysAgo(14) }, { uid: true });
    const take = (uids || []).sort((a, b) => a - b).slice(0, MAX_NEW);
    let last = st.lastUid || 0;
    if (take.length) {
      for await (const msg of client.fetch(take.join(','), { uid: true, source: true }, { uid: true })) {
        files.push(...await attachmentsFromSource(msg.source, `${validity}:${msg.uid}`));
        last = Math.max(last, msg.uid);
      }
    }
    // Курсор сдвигается только после успешного прохода — иначе письма перечитаются в следующий раз
    st.lastUid = last;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return files;
}
