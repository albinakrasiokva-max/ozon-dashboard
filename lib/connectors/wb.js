// Wildberries, Statistics API: продажи, возвраты, заказы, остатки за 60 дней.
// https://dev.wildberries.ru — заголовок Authorization: <токен> (без Bearer).
import { request } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const STAT = 'https://statistics-api.wildberries.ru';
export const enabled = () => !!process.env.WB_TOKEN;
const opt = () => ({ headers: { Authorization: process.env.WB_TOKEN }, source: 'Wildberries', timeout: 90000 });

export async function sync() {
  const from = isoDay(daysAgo(60));
  // У каждого метода свой лимит (~1 запрос в минуту), разные методы можно вызывать подряд.
  const sales = await request(`${STAT}/api/v1/supplier/sales?dateFrom=${from}`, opt()) || [];
  const orders = await request(`${STAT}/api/v1/supplier/orders?dateFrom=${from}`, opt()) || [];
  const stocks = await request(`${STAT}/api/v1/supplier/stocks?dateFrom=2019-06-20T00:00:00`, opt()) || [];

  const names = {}, st = {};
  const art = r => r.supplierArticle || String(r.nmId);
  for (const r of stocks) {
    const a = art(r);
    st[a] ??= { article: a, nmId: r.nmId, qty: 0, inWay: 0 };
    st[a].qty += Number(r.quantity) || 0;
    st[a].inWay += Number(r.inWayFromClient) || 0;
    if (r.subject) names[a] = r.subject;
  }
  return {
    // saleID на «S» — продажа, на «R» — возврат (выручка и количество со знаком минус)
    sales: sales.map(r => {
      const sign = String(r.saleID || '').startsWith('R') ? -1 : 1;
      if (r.subject) names[art(r)] ??= r.subject;
      return {
        date: normDate(r.date), article: art(r), nmId: r.nmId, mp: 'WB', qty: sign,
        revenue: sign * Math.abs(Number(r.priceWithDisc) || 0),
        payout: sign * Math.abs(Number(r.forPay) || 0)
      };
    }),
    orders: orders.map(r => ({ date: normDate(r.date), article: art(r), mp: 'WB', sum: Number(r.priceWithDisc) || 0, cancel: !!r.isCancel })),
    stocks: Object.values(st),
    names
  };
}
