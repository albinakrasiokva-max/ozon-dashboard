// Ozon Seller API: выручка по дням и артикулам, финансы (комиссии, логистика, к выплате), остатки.
// https://docs.ozon.ru/api/seller — заголовки Client-Id и Api-Key, все методы POST.
import { request, sleep } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';
import { accrualsDataset, adsFromAccruals, stockDataset, financeFromOps, lastMonths } from '../ozonReports.js';

const BASE = 'https://api-seller.ozon.ru';
export const enabled = () => !!(process.env.OZON_CLIENT_ID && process.env.OZON_API_KEY);
// В тексте ошибки — адрес метода: так видно, какой именно метод Ozon отключил или не разрешил ключу
const post = (p, body) => request(BASE + p, {
  method: 'POST', body, source: `Ozon Seller (${p})`,
  headers: { 'Client-Id': process.env.OZON_CLIENT_ID, 'Api-Key': process.env.OZON_API_KEY }
});

// Остатки в виде строк stock_on_warehouses: {sku, item_code, item_name, free_to_sell_amount, reserved_amount, promised_amount}.
// Старый метод /v2/analytics/stock_on_warehouses Ozon отключает; если его нет (404), берём /v4/product/info/stocks.
async function stockRowsAll() {
  const rows = [];
  try {
    for (let off = 0; off < 20000; off += 1000) {
      const r = await post('/v2/analytics/stock_on_warehouses', { limit: 1000, offset: off, warehouse_type: 'ALL' });
      const part = r?.result?.rows || [];
      rows.push(...part);
      if (part.length < 1000) break;
    }
    return rows;
  } catch (e) {
    if (!/\(404\)/.test(e.message)) throw e;
  }
  // present — сколько товара на складах, reserved — из них в резерве под заказы
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    if (page) await sleep(500);
    const r = await post('/v4/product/info/stocks', { filter: { visibility: 'ALL' }, cursor, limit: 1000 });
    const items = r?.items || r?.result?.items || [];
    for (const it of items) for (const st of it.stocks || []) {
      if (!(Number(st.sku) > 0)) continue;
      const present = Number(st.present) || 0, reserved = Number(st.reserved) || 0;
      rows.push({ sku: Number(st.sku), item_code: it.offer_id || '', item_name: '', free_to_sell_amount: Math.max(0, present - reserved), reserved_amount: reserved, promised_amount: 0 });
    }
    cursor = r?.cursor || r?.result?.cursor || '';
    if (!cursor || !items.length) break;
  }
  return rows;
}

export async function sync() {
  // Остатки по складам
  const stocks = {}, names = {}, skuArt = {};
  const stockRows = await stockRowsAll();
  for (const x of stockRows) {
    const a = x.item_code || String(x.sku);
    skuArt[x.sku] = a;
    if (x.item_name) names[a] = x.item_name;
    stocks[a] ??= { article: a, qty: 0, inWay: 0 };
    stocks[a].qty += Number(x.free_to_sell_amount) || 0;
    stocks[a].inWay += Number(x.promised_amount) || 0;
  }

  // Выручка и заказанные штуки по дням и SKU за 60 дней
  const sales = [], units28 = {}, from28 = isoDay(daysAgo(27));
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
      const date = normDate(x.dimensions?.[1]?.id), qty = Number(x.metrics?.[1]) || 0;
      sales.push({ date, article: a, mp: 'Ozon', revenue: Number(x.metrics?.[0]) || 0, qty, payout: null });
      if (date >= from28) units28[sku] = (units28[sku] || 0) + qty;
    }
    if (rows.length < 1000) break;
  }

  // Операции за 3 месяца — для «Аналитики Ozon» и запасного расчёта итогов.
  // Ошибка здесь не должна ломать основной дашборд.
  const months = lastMonths(3);
  let opsByMonth = null, reportsError = null;
  try { opsByMonth = []; for (const m of months) opsByMonth.push(await operations(m)); }
  catch (e) { opsByMonth = null; reportsError = e.message; console.error('[sync] Аналитика Ozon:', e.message); }

  // Финансы: прошлый и текущий месяц. Комиссии и расходы приходят со знаком минус.
  // Если /v3/finance/transaction/totals отключён (404), итоги считаются по списку операций.
  const finance = [], now = new Date();
  for (const k of [1, 0]) {
    const s = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const e = k ? new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59) : now;
    let r;
    try { r = await post('/v3/finance/transaction/totals', { date: { from: s.toISOString(), to: e.toISOString() }, transaction_type: 'all' }); }
    catch (err) {
      // Без итогов дашборд оценит выплаты долей от выручки — продажи и остатки всё равно обновятся
      if (opsByMonth) finance.push(financeFromOps(opsByMonth[2 - k], isoDay(s).slice(0, 7)));
      else console.error('[sync] Ozon: итоги по финансам недоступны:', err.message);
      continue;
    }
    const t = r?.result || {}, f = n => Number(t[n]) || 0;
    const row = {
      month: isoDay(s).slice(0, 7), accruals: f('accruals_for_sale'), commission: f('sale_commission'),
      logistics: f('processing_and_delivery'), refunds: f('refunds_and_cancellations'), services: f('services_amount'),
      compensation: f('compensation_amount'), other: f('others_amount')
    };
    row.payout = row.accruals + row.commission + row.logistics + row.refunds + row.services + row.compensation + row.other;
    finance.push(row);
  }

  let rep = null;
  if (opsByMonth) {
    const names = {};
    for (const x of stockRows) names[x.sku] ??= { name: x.item_name || '', article: x.item_code || '' };
    rep = [stockDataset(stockRows, units28, isoDay(new Date()))];
    months.forEach((m, i) => {
      const period = { from: m.from, to: m.to };
      rep.push(accrualsDataset(opsByMonth[i], period, names));
      const ads = adsFromAccruals(opsByMonth[i], period, names);   // заменяется данными Performance, если они есть
      if (ads) rep.push(ads);
    });
  }
  return { sales, stocks: Object.values(stocks), names, finance, reports: rep, reportsError };
}

// Все операции за месяц. Старый /v3/finance/transaction/list Ozon отключил (404) —
// тогда берём начисления по дням из /v1/finance/accrual/by-day и приводим их к виду операций.
async function operations(m) {
  const ops = [];
  try {
    for (let page = 1, pages = 1; page <= pages && page <= 100; page++) {
      if (page > 1) await sleep(500);
      const r = await post('/v3/finance/transaction/list', {
        filter: { date: { from: m.start.toISOString(), to: m.end.toISOString() }, operation_type: [], posting_number: '', transaction_type: 'all' },
        page, page_size: 1000
      });
      ops.push(...(r?.result?.operations || []));
      pages = Number(r?.result?.page_count) || 1;
    }
    return ops;
  } catch (e) {
    if (!/\((404|400)\)/.test(e.message)) throw e;
  }
  const types = await accrualTypes();
  for (let d = new Date(m.start); d <= m.end; d.setDate(d.getDate() + 1)) {
    let lastId = '';
    for (let page = 0; page < 50; page++) {
      await sleep(250);
      const r = await post('/v1/finance/accrual/by-day', lastId ? { date: isoDay(d), last_id: lastId } : { date: isoDay(d) });
      const list = r?.accruals || r?.result?.accruals || [];
      if (!sampleLogged && list.length) {
        // Один раз за запуск: структура ответа в лог — по ней сверяется разбор (в публичной документации полей нет)
        sampleLogged = true;
        console.log('[ozon] образец /v1/finance/accrual/by-day:', JSON.stringify(list.slice(0, 2)).slice(0, 6000));
      }
      ops.push(...list.map(a => accrualToOp(a, types)));
      lastId = r?.last_id || r?.result?.last_id || '';
      if (!lastId || !list.length) break;
    }
  }
  return ops;
}

let sampleLogged = false, typesCache = null;
// Справочник видов начислений: {id: название}
async function accrualTypes() {
  if (typesCache) return typesCache;
  typesCache = {};
  try {
    const r = await post('/v1/finance/accrual/types', {});
    const list = r?.accrual_types || r?.result?.accrual_types || r?.types || [];
    for (const t of list) typesCache[t.id] = t.description || t.name || '';
    console.log(`[ozon] справочник начислений: ${list.length} видов; пример: ${JSON.stringify(list.slice(0, 40)).slice(0, 3000)}`);
  } catch (e) { console.error('[ozon] справочник начислений недоступен:', e.message); }
  return typesCache;
}

// Сумма из ответа: {"amount": "-21.75", "currency": "RUB"}, число, строка или 'value:"0.42"'
const money = v => {
  if (v && typeof v === 'object') v = v.amount ?? v.value;
  const s = String(v ?? 0).replace(/^value:"?|"$/g, '');
  return Number(s.replace(/[\s\u00a0]/g, '').replace(',', '.')) || 0;
};

// Начисление by-day → операция в форме /v3/finance/transaction/list, чтобы работали прежние расчёты.
// Услуги — из posting.products[].delivery.services и item_fees.fees[].fees (type_id + accrued);
// выручка по товару = итог начисления минус все услуги и комиссия.
export function accrualToOp(a, types = {}) {
  const typeId = a.type_id ?? a.accrual_type_id ?? a.accrual_type?.id;
  const name = types[typeId] || a.accrual_type?.name || a.name || a.accrued_category || '';
  const amount = money(a.total_amount ?? a.amount);
  const posting = a.posting || {};
  const products = posting.products || a.products || [];
  const fees = [];
  for (const p of products) for (const sv of p.delivery?.services || []) fees.push(sv);
  for (const e of a.item_fees?.fees || []) for (const f of e.fees || []) fees.push(f);
  let comm = 0;
  const services = [];
  for (const f of fees) {
    const fname = types[f.type_id] || f.name || `type ${f.type_id}`, v = money(f.accrued ?? f.amount);
    if (/вознагражд|комисс/i.test(fname)) comm += v; else services.push({ name: fname, price: v });
  }
  const items = [];
  for (const p of products) {
    const sku = Number(p.sku ?? p.item?.sku ?? p.product?.sku);
    if (!(sku > 0)) continue;
    const qty = Math.min(50, Math.max(1, Math.round(Math.abs(Number(p.quantity ?? p.qty ?? 1)) || 1)));
    for (let i = 0; i < qty; i++) items.push({ sku, name: p.name || p.item?.name || '' });
  }
  const svc = services.reduce((x, y) => x + y.price, 0);
  const acc = items.length && !/балл|партн/i.test(name) ? amount - svc - comm : 0;
  return {
    operation_id: a.accrual_id ?? a.id, operation_type: String(typeId ?? ''), operation_type_name: name,
    operation_date: a.accrual_date || a.date || '', type: a.accrued_category || '',
    amount, accruals_for_sale: acc, sale_commission: acc ? comm : 0,
    services: acc ? services : [], items
  };
}
