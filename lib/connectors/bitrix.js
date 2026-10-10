// Битрикс24: этапы и сделки через входящий вебхук с правами crm; перенос этапа пишется обратно.
// https://apidocs.bitrix24.ru
import { request } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

export const enabled = () => !!process.env.BITRIX_WEBHOOK_URL;
const call = (m, body, o = {}) => request(process.env.BITRIX_WEBHOOK_URL.replace(/\/?$/, '/') + m + '.json', { method: 'POST', body, source: 'Битрикс24', ...o });
const sem = s => String(s.EXTRA?.SEMANTICS || '').toLowerCase();

export async function sync() {
  const st = await call('crm.status.list', { filter: { ENTITY_ID: 'DEAL_STAGE' }, order: { SORT: 'ASC' } });
  const stages = (st?.result || [])
    .filter(s => !['failure', 'f'].includes(sem(s)))
    .sort((a, b) => a.SORT - b.SORT)
    .map(s => ({ id: s.STATUS_ID, name: s.NAME, won: ['success', 's'].includes(sem(s)) }));

  const users = {};
  try { const u = await call('user.get', {}); for (const x of u?.result || []) users[x.ID] = [x.NAME, x.LAST_NAME].filter(Boolean).join(' '); } catch { /* нет прав user — не критично */ }

  const oldest = isoDay(daysAgo(60)), deals = [];
  let start = 0;
  for (let i = 0; i < 40 && start !== undefined; i++) {
    const r = await call('crm.deal.list', {
      filter: { CATEGORY_ID: 0 }, start,
      select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'CLOSEDATE', 'CLOSED']
    });
    for (const d of r?.result || []) {
      const s = stages.find(x => x.id === d.STAGE_ID);
      if (!s) continue;
      const closed = d.CLOSED === 'Y' ? normDate(d.CLOSEDATE) : null;
      if (s.won && closed && closed < oldest) continue;
      deals.push({ id: String(d.ID), title: d.TITLE || `Сделка ${d.ID}`, client: '', sum: Number(d.OPPORTUNITY) || 0, stage: s.name, who: users[d.ASSIGNED_BY_ID] || '', note: '', created: normDate(d.DATE_CREATE), closed, won: s.won });
    }
    start = r?.next;
  }
  return { stages, deals };
}

export async function updateDeal(raw, id, v) {
  const fields = {};
  if (v.stage) {
    const s = raw.stages.find(x => x.name === v.stage);
    if (!s) throw new Error(`Этап «${v.stage}» не найден в Битрикс24`);
    fields.STAGE_ID = s.id;
  }
  if (v.title) fields.TITLE = v.title;
  if (v.sum != null) fields.OPPORTUNITY = Number(v.sum) || 0;
  await call('crm.deal.update', { id, fields });
}

export async function createDeal(raw, v) {
  const s = raw.stages.find(x => x.name === v.stage) || raw.stages[0];
  const r = await call('crm.deal.add', { fields: { TITLE: v.title, OPPORTUNITY: Number(v.sum) || 0, STAGE_ID: s.id } }, { retries: 0 }); // без повтора — чтобы не создать дубль
  return String(r?.result || '');
}
