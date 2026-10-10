// ЭДО Диадок: входящие документы за 30 дней (акты, УПД, счета-фактуры).
// https://developer.kontur.ru — ключ разработчика, логин и пароль.
// Экспериментальный коннектор: написан по документации, проверяйте на реальном ящике.
import { request, download } from '../http.js';
import { daysAgo, normDate } from '../db.js';

const BASE = 'https://diadoc-api.kontur.ru';
const SRC = 'Диадок';
export const docs = true;
export const enabled = () => !!(process.env.DIADOC_API_KEY && process.env.DIADOC_LOGIN && process.env.DIADOC_PASSWORD);

let token = null;
const auth = () => `DiadocAuth ddauth_api_client_id=${process.env.DIADOC_API_KEY}${token ? `,ddauth_token=${token}` : ''}`;

async function login() {
  token = null;
  const r = await request(`${BASE}/V3/Authenticate?type=password`, {
    method: 'POST', source: SRC, headers: { Authorization: auth() },
    body: { login: process.env.DIADOC_LOGIN, password: process.env.DIADOC_PASSWORD }
  });
  token = typeof r === 'string' ? r.trim() : r?.token;
  if (!token) throw new Error(`${SRC}: сервис не выдал токен — проверьте логин и пароль`);
}

const get = p => request(BASE + p, { source: SRC, headers: { Authorization: auth() } });
const pad = n => String(n).padStart(2, '0');
const ru = d => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;

export async function sync() {
  await login();
  const orgs = await get('/GetMyOrganizations');
  const boxId = process.env.DIADOC_BOX_ID || orgs?.Organizations?.[0]?.Boxes?.[0]?.BoxId;
  if (!boxId) throw new Error(`${SRC}: не найден ящик организации — укажите DIADOC_BOX_ID`);
  const r = await get(`/V3/GetDocuments?boxId=${encodeURIComponent(boxId)}&filterCategory=Any.InboundNotRevoked&fromDocumentDate=${ru(daysAgo(30))}`);
  const files = [];
  for (const d of (r?.Documents || []).slice(0, 100)) {
    const { buffer, mime } = await download(
      `${BASE}/V4/GetEntityContent?boxId=${encodeURIComponent(boxId)}&messageId=${encodeURIComponent(d.MessageId)}&entityId=${encodeURIComponent(d.EntityId)}`,
      { headers: { Authorization: auth() }, source: SRC }
    );
    const title = [d.TypeNamedId || d.DocumentType, d.DocumentNumber && `№${d.DocumentNumber}`].filter(Boolean).join(' ');
    files.push({
      source: 'ЭДО', name: (d.FileName || title || 'Документ Диадок').slice(0, 150), buffer,
      mime: mime || (buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : 'application/xml'),
      from: d.CounteragentBoxId || '', date: normDate(d.DocumentDate) || undefined, externalId: d.EntityId
    });
  }
  return files;
}
