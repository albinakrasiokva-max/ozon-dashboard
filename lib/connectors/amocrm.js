// amoCRM: этапы воронки и сделки; перенос этапа на дашборде записывается обратно.
// https://www.amocrm.ru/developers — долгосрочный токен интеграции.
import { request } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const WON = 142, LOST = 143;
export const enabled = () => !!(process.env.AMO_SUBDOMAIN && process.env.AMO_TOKEN);
const req = (p, o = {}) => request(`https://${process.env.AMO_SUBDOMAIN}.amocrm.ru/api/v4${p}`, {
  ...o, source: 'amoCRM', headers: { Authorization: 'Bearer ' + process.env.AMO_TOKEN }
});

export async function sync() {
  const pl = await req('/leads/pipelines');
  const pipes = pl?._embedded?.pipelines || [];
  const pipe = pipes.find(p => String(p.id) === process.env.AMO_PIPELINE_ID) || pipes.find(p => p.is_main) || pipes[0];
  if (!pipe) return { pipelineId: null, stages: [], deals: [] };
  const sts = (pipe._embedded?.statuses || []).filter(s => s.id !== LOST).sort((a, b) => a.sort - b.sort);

  const users = {};
  try { const u = await req('/users?limit=250'); for (const x of u?._embedded?.users || []) users[x.id] = x.name; } catch { /* нет прав на пользователей — не критично */ }

  const oldest = isoDay(daysAgo(60)), deals = [];
  for (let page = 1; page <= 40; page++) {
    const r = await req(`/leads?limit=250&page=${page}&filter[pipeline_id]=${pipe.id}`);
    const leads = r?._embedded?.leads || [];
    for (const l of leads) {
      const s = sts.find(x => x.id === l.status_id);
      if (!s) continue;
      const closed = l.closed_at ? normDate(l.closed_at) : null;
      if (s.id === WON && closed && closed < oldest) continue; // старые успешные не нужны
      deals.push({ id: String(l.id), title: l.name || `Сделка ${l.id}`, client: '', sum: Number(l.price) || 0, stage: s.name, who: users[l.responsible_user_id] || '', note: '', created: normDate(l.created_at), closed, won: s.id === WON });
    }
    if (leads.length < 250) break;
  }
  return { pipelineId: pipe.id, stages: sts.map(s => ({ id: s.id, name: s.name, won: s.id === WON })), deals };
}

export async function updateDeal(raw, id, v) {
  const body = {};
  if (v.stage) {
    const s = raw.stages.find(x => x.name === v.stage);
    if (!s) throw new Error(`Этап «${v.stage}» не найден в amoCRM`);
    body.status_id = s.id; body.pipeline_id = raw.pipelineId;
  }
  if (v.title) body.name = v.title;
  if (v.sum != null) body.price = Math.round(Number(v.sum) || 0);
  await req(`/leads/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

export async function createDeal(raw, v) {
  const s = raw.stages.find(x => x.name === v.stage) || raw.stages[0];
  const r = await req('/leads', { method: 'POST', retries: 0, body: [{ name: v.title, price: Math.round(Number(v.sum) || 0), status_id: s.id, pipeline_id: raw.pipelineId }] }); // без повтора — чтобы не создать дубль
  return String(r?._embedded?.leads?.[0]?.id || '');
}
