// Ozon Performance (реклама Ozon): расход, показы, клики, заказы по кампаниям за 30 дней.
// Отдельный кабинет и отдельные ключи: performance.ozon.ru → Настройки → API.
import { request, num } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const BASE = 'https://api-performance.ozon.ru';
const SRC = 'Ozon Performance';
export const enabled = () => !!(process.env.OZON_PERF_CLIENT_ID && process.env.OZON_PERF_CLIENT_SECRET);

let tok = null;
async function token() {
  if (tok && tok.exp > Date.now()) return tok.v;
  const r = await request(`${BASE}/api/client/token`, {
    method: 'POST', source: SRC,
    body: { client_id: process.env.OZON_PERF_CLIENT_ID, client_secret: process.env.OZON_PERF_CLIENT_SECRET, grant_type: 'client_credentials' }
  });
  if (!r?.access_token) throw new Error(`${SRC}: сервис не выдал токен — проверьте client_id и client_secret`);
  tok = { v: r.access_token, exp: Date.now() + ((r.expires_in || 1800) - 60) * 1000 };
  return tok.v;
}

export async function sync() {
  const headers = { Authorization: 'Bearer ' + await token() };
  const camps = await request(`${BASE}/api/client/campaign`, { headers, source: SRC });
  const st = await request(`${BASE}/api/client/statistics/daily/json?dateFrom=${isoDay(daysAgo(30))}&dateTo=${isoDay(new Date())}`, { headers, source: SRC });
  const blank = (id, name, status) => ({ mp: 'Ozon', id: String(id), name: name || `Кампания ${id}`, status, spend: 0, views: 0, clicks: 0, orders: 0, ordersSum: 0, articles: [], daily: [] });
  const by = {};
  for (const c of camps?.list || []) by[c.id] = blank(c.id, c.title, /RUNNING|ACTIVE/i.test(c.state || '') ? 'active' : 'paused');
  for (const r of st?.rows || []) {
    const c = by[r.id] ??= blank(r.id, r.title, 'active');
    const d = { date: normDate(r.date), spend: num(r.moneySpent), views: num(r.views), clicks: num(r.clicks), orders: num(r.orders), ordersSum: num(r.ordersMoney) };
    c.daily.push(d);
    for (const k of ['spend', 'views', 'clicks', 'orders', 'ordersSum']) c[k] += d[k];
  }
  return { campaigns: Object.values(by).filter(c => c.spend > 0 || c.status === 'active') };
}
