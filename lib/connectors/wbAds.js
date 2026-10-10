// Реклама Wildberries (Продвижение): расход, показы, клики, заказы по кампаниям за 30 дней.
// Тот же WB_TOKEN, у токена должна быть отмечена категория «Продвижение».
import { request, sleep } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const ADV = 'https://advert-api.wildberries.ru';
export const enabled = () => !!process.env.WB_TOKEN && process.env.WB_ADS !== '0';
const opt = () => ({ headers: { Authorization: process.env.WB_TOKEN }, source: 'Реклама WB', timeout: 60000 });
const STATUS = { 9: 'active', 11: 'paused', 7: 'finished' };

export async function sync() {
  const cnt = await request(`${ADV}/adv/v1/promotion/count`, opt());
  const since = daysAgo(30).getTime();
  const ids = [], statusOf = {};
  for (const g of cnt?.adverts || []) {
    if (!STATUS[g.status]) continue;
    for (const a of g.advert_list || []) {
      if (g.status === 7 && new Date(a.changeTime).getTime() < since) continue; // давно завершённые не нужны
      ids.push(a.advertId); statusOf[a.advertId] = STATUS[g.status];
    }
  }
  if (!ids.length) return { campaigns: [] };

  const names = {};
  for (let i = 0; i < ids.length; i += 50) {
    const info = await request(`${ADV}/adv/v1/promotion/adverts`, { ...opt(), method: 'POST', body: ids.slice(i, i + 50) }).catch(() => []);
    for (const c of Array.isArray(info) ? info : []) names[c.advertId] = c.name;
  }

  const begin = isoDay(daysAgo(30)), end = isoDay(new Date()), out = [];
  for (let i = 0; i < ids.length; i += 50) {
    if (i) await sleep(20000); // строгий лимит на статистику
    const st = await request(`${ADV}/adv/v3/fullstats?ids=${ids.slice(i, i + 50).join(',')}&beginDate=${begin}&endDate=${end}`, opt()) || [];
    for (const s of st) {
      const days = s.days || [];
      out.push({
        mp: 'WB', id: String(s.advertId), name: names[s.advertId] || `Кампания ${s.advertId}`, status: statusOf[s.advertId] || 'active',
        spend: Number(s.sum) || 0, views: Number(s.views) || 0, clicks: Number(s.clicks) || 0,
        orders: Number(s.orders) || 0, ordersSum: Number(s.sum_price) || 0,
        // артикулы кампании — nmId; в расчётах сопоставляются с артикулом продавца
        articles: [...new Set(days.flatMap(d => (d.apps || []).flatMap(a => (a.nms || a.nm || []).map(n => String(n.nmId)))))],
        daily: days.map(d => ({ date: normDate(d.date), spend: Number(d.sum) || 0, views: Number(d.views) || 0, clicks: Number(d.clicks) || 0, orders: Number(d.orders) || 0, ordersSum: Number(d.sum_price) || 0 }))
      });
    }
  }
  return { campaigns: out };
}
