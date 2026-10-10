// Ozon Seller API: выручка по дням и артикулам, финансы (комиссии, логистика, к выплате), остатки.
// https://docs.ozon.ru/api/seller — заголовки Client-Id и Api-Key, все методы POST.
import { request, sleep } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const BASE = 'https://api-seller.ozon.ru';
export const enabled = () => !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);
const post = (p, body) => request(BASE + p, {
  method: 'POST', body, source: 'Ozon Seller',
  headers: { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY }
});

export async function sync() {
  // Остатки по складам
  const stocks = {}, names = {}, skuArt = {};
  for (let off = 0; off < 20000; off += 1000) {
    const r = await post('/v2/analytics/stock_on_warehouses', { limit: 1000, offset: off, warehouse_type: 'ALL' });
    const rows = r?.result?.rows || [];
    for (const x of rows) {
      const a = x.item_code || String(x.sku);
      skuArt[x.sku] = a;
      if (x.item_name) names[a] = x.item_name;
      stocks[a] ??= { article: a, qty: 0, inWay: 0 };
      stocks[a].qty += Number(x.free_to_sell_amount) || 0;
      stocks[a].inWay += Number(x.promised_amount) || 0;
    }
    if (rows.length < 1000) break;
  }

  // Выручка и заказанные штуки по дням и SKU за 60 дней
  const sales = [];
  for (let off = 0; off < 100000; off += 1000) {
    if (off) await sleep(2000);
    const r = await post('/v1/analytics/data', {
      date_from: isoDay(daysAgo(60)), date_to: isoDay(new Date()),
      metrics: ['revenue', 'ordered_units'], dimension: ['sku', 'day'], limit: 1000, offset: off
    });
    const rows = r?.result?.data || [];
    for (const x of rows) {
      const sku = x.dimensions?.[0]?.id, a = skuArt[sku] || String(sku);
      if (x.dimensions?.[0]?.name) names[a] ??= x.dimensions[0].name;
      sales.push({ date: normDate(x.dimensions?.[1]?.id), article: a, mp: 'Ozon', revenue: Number(x.metrics?.[0]) || 0, qty: Number(x.metrics?.[1]) || 0, payout: null });
    }
    if (rows.length < 1000) break;
  }

  // Финансы: прошлый и текущий месяц. Комиссии и расходы приходят со знаком минус.
  const finance = [], now = new Date();
  for (const k of [1, 0]) {
    const s = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const e = k ? new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59) : now;
    const r = await post('/v3/finance/transaction/totals', { date: { from: s.toISOString(), to: e.toISOString() }, transaction_type: 'all' });
    const t = r?.result || {}, f = n => Number(t[n]) || 0;
    const row = {
      month: isoDay(s).slice(0, 7), accruals: f('accruals_for_sale'), commission: f('sale_commission'),
      logistics: f('processing_and_delivery'), refunds: f('refunds_and_cancellations'), services: f('services_amount'),
      compensation: f('compensation_amount'), other: f('others_amount')
    };
    row.payout = row.accruals + row.commission + row.logistics + row.refunds + row.services + row.compensation + row.other;
    finance.push(row);
  }
  return { sales, stocks: Object.values(stocks), names, finance };
}
