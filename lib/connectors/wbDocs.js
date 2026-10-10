// Документы из кабинета Wildberries (отчёты, акты) за 30 дней.
// Тот же WB_TOKEN, у токена должна быть отмечена категория «Документы».
import { request } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const BASE = 'https://documents-api.wildberries.ru';
export const docs = true;
export const enabled = () => !!process.env.WB_TOKEN && process.env.WB_DOCS !== '0';
const opt = () => ({ headers: { Authorization: process.env.WB_TOKEN }, source: 'Документы WB', timeout: 60000 });

export async function sync() {
  const r = await request(`${BASE}/api/v1/documents/list?locale=ru&beginTime=${isoDay(daysAgo(30))}&endTime=${isoDay(new Date())}`, opt());
  const files = [];
  for (const d of (r?.data?.documents || []).slice(0, 50)) {
    const ext = (d.extensions || []).includes('pdf') ? 'pdf' : null;
    if (!ext) continue; // zip/xlsx ИИ не читает — такие документы смотрите в кабинете WB
    const f = await request(`${BASE}/api/v1/documents/download?serviceName=${encodeURIComponent(d.serviceName)}&extension=${ext}`, opt());
    const b64 = f?.data?.document;
    if (!b64) continue;
    files.push({
      source: 'WB', name: f.data.fileName || `${d.name || 'Документ WB'}.pdf`, buffer: Buffer.from(b64, 'base64'),
      mime: 'application/pdf', from: 'Wildberries', date: normDate(d.creationTime) || undefined, externalId: d.serviceName
    });
  }
  return files;
}
