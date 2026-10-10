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
      const ds = accrualsDataset(opsByMonth[i], period, names);
      rep.push(ds);
      logMonth(m.from.slice(0, 7), opsByMonth[i], ds);
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
      // Один раз за запуск — образец начисления каждой категории (ITEM, POSTING, NON_ITEM…) в лог:
      // по нему сверяется разбор, в публичной документации полей нет
      for (const a of list) {
        // Отдельно — отправление с заполненной комиссией: так выглядит продажа
        const withComm = a.accrued_category === 'POSTING' && (a.posting?.products || []).some(p => p.commission);
        const key = withComm ? (money(a.total_amount) < 0 ? 'POSTING возврат' : 'POSTING с комиссией') : a.accrued_category;
        if (sampled.has(key)) continue;
        sampled.add(key);
        console.log(`[ozon] образец начисления ${key}:`, JSON.stringify(a).slice(0, 3000));
      }
      for (const a of list) ops.push(...accrualToOps(a, types));
      lastId = r?.last_id || r?.result?.last_id || '';
      if (!lastId || !list.length) break;
    }
  }
  return ops;
}

const sampled = new Set();
// Итоги месяца в лог — для сверки с «Финансы → Документы» в кабинете Ozon
function logMonth(month, ops, ds) {
  const r = v => Math.round(v);
  const items = Object.values(ds.data.items), t = { soldAmt: 0, soldLoyal: 0, retAmt: 0, retLoyal: 0 }, fees = {};
  for (const it of items) {
    for (const k in t) t[k] += it.sold[k];
    for (const k in it.fees) fees[k] = (fees[k] || 0) + it.fees[k];
  }
  for (const k in ds.data.unassigned) fees[k] = (fees[k] || 0) + ds.data.unassigned[k];
  const payout = ops.reduce((x, o) => x + (Number(o.amount) || 0), 0);
  const byName = {};
  for (const o of ops) byName[o.operation_type_name] = (byName[o.operation_type_name] || 0) + (Number(o.amount) || 0);
  console.log(`[ozon] итоги ${month}: операций ${ops.length}; продажи ${r(t.soldAmt)} + баллы ${r(t.soldLoyal)} − возвраты ${r(t.retAmt)} − баллы возвратов ${r(t.retLoyal)} = выручка ${r(t.soldAmt + t.soldLoyal - t.retAmt - t.retLoyal)}; ` +
    `удержания ${JSON.stringify(Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, r(v)])))}; реклама ${r(ds.data.adsOther)}, подписка ${r(ds.data.adsSub)}; к выплате ${r(payout)}; ` +
    `по видам: ${Object.entries(byName).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 25).map(([k, v]) => `${k} ${r(v)}`).join('; ')}`);
}
let typesCache = null;
// Справочник видов начислений: {id: название}
async function accrualTypes() {
  if (typesCache) return typesCache;
  typesCache = {};
  try {
    const r = await post('/v1/finance/accrual/types', {});
    const list = r?.accrual_types || r?.result?.accrual_types || r?.types || [];
    for (const t of list) typesCache[t.id] = t.description || t.name || '';
    console.log(`[ozon] справочник начислений (${list.length}): ${list.map(t => `${t.id} ${t.description || t.name}`).join('; ')}`);
  } catch (e) { console.error('[ozon] справочник начислений недоступен:', e.message); }
  return typesCache;
}

// Сумма из ответа: {"amount": "-21.75", "currency": "RUB"}, число, строка или 'value:"0.42"'
const money = v => {
  if (v && typeof v === 'object') v = v.amount ?? v.value;
  const s = String(v ?? 0).replace(/^value:"?|"$/g, '');
  return Number(s.replace(/[\s\u00a0]/g, '').replace(',', '.')) || 0;
};

// Начисление by-day → операции в форме /v3/finance/transaction/list, чтобы работали прежние расчёты.
// Формат проверен на реальном ответе: {accrual_id, date, total_amount:{amount}, accrued_category,
//   item_fees:{fees:[{sku, quantity, fees:[{type_id, accrued}]}]}, non_item_fee:{type_id, accrued}, posting, container_fees}.
// ITEM — удержания по товару (по одной операции на SKU), NON_ITEM — общие, POSTING — отправление с продажей:
// выручка по товару = итог начисления минус все удержания и комиссия.
export function accrualToOps(a, types = {}) {
  const amount = money(a.total_amount ?? a.amount);
  const tname = id => types[id] || `вид ${id}`;
  const base = { operation_id: a.accrual_id, operation_date: a.date || '', type: a.accrued_category || '' };
  const split = fees => {   // комиссия отдельно, остальное — услуги
    let comm = 0; const services = [];
    for (const f of fees) {
      const name = tname(f.type_id), v = money(f.accrued ?? f.amount);
      if (/вознагражд|комисс/i.test(name)) comm += v; else services.push({ name, price: v });
    }
    return { comm, services };
  };
  const units = (sku, qty, name = '') => Array.from({ length: Math.min(50, Math.max(1, Math.round(Math.abs(Number(qty)) || 1))) }, () => ({ sku: Number(sku), name }));

  // Без товара: подписка, реклама, хранение и прочее — по виду начисления
  if (a.non_item_fee) {
    return [{ ...base, operation_type: String(a.non_item_fee.type_id), operation_type_name: tname(a.non_item_fee.type_id), amount, accruals_for_sale: 0, sale_commission: 0, services: [], items: [] }];
  }
  const out = [];
  // Удержания по товарам: отдельная операция на каждый SKU, со своими суммами
  for (const e of a.item_fees?.fees || []) {
    const { comm, services } = split(e.fees || []);
    const sum = comm + services.reduce((x, y) => x + y.price, 0);
    if (!(Number(e.sku) > 0)) { out.push({ ...base, operation_type_name: services[0]?.name || 'Прочее', amount: sum, accruals_for_sale: 0, sale_commission: 0, services: [], items: [] }); continue; }
    out.push({ ...base, operation_type_name: services[0]?.name || (comm ? 'Вознаграждение' : ''), amount: sum, accruals_for_sale: 0, sale_commission: comm, services, items: units(e.sku, e.quantity) });
  }
  // Отправление: продажа или возврат. Формат по реальному ответу:
  // products[]: {sku, quantity, delivery:{services:[{type_id, accrued}]}, commission:null | {sale_amount (= цена продавца),
  //   sale_price (заплатил покупатель), bonus (баллы, доплатил Ozon), coinvestment, sale_commission, commission_ratio}}.
  // Пример: 689 − 296,27 (комиссия) − 74,50 (логистика) = 318,23 к выплате.
  const products = a.posting?.products || [];
  if (products.length || a.accrued_category === 'POSTING') {
    const fees = [], items = [];
    let comm = 0, sale = 0, bonus = 0, hasSale = false;
    for (const p of products) {
      for (const sv of p.delivery?.services || []) fees.push(sv);
      for (const f of p.fees || []) fees.push(f);
      const c = p.commission;
      if (c && typeof c === 'object') {
        comm += money(c.sale_commission ?? c.commission);
        if (c.sale_amount != null || c.seller_price != null) { hasSale = true; sale += money(c.sale_amount ?? c.seller_price); bonus += money(c.bonus); }
      }
      if (Number(p.sku) > 0) items.push(...units(p.sku, p.quantity, p.name || ''));
    }
    const s2 = split(fees);
    comm += s2.comm;
    const services = s2.services, svc = services.reduce((x, y) => x + y.price, 0);
    const own = amount - out.reduce((x, o) => x + o.amount, 0);
    // Выручка по цене продавца без баллов; баллы — отдельной операцией, как «Баллы за скидки» в отчёте кабинета
    const acc = !items.length ? 0 : hasSale ? sale - bonus : own - svc - comm;
    const name = acc < 0 ? 'Возврат' : 'Доставка покупателю';
    out.push({ ...base, operation_type_name: name, amount: own - (hasSale ? bonus : 0), accruals_for_sale: Math.abs(acc) < 0.005 ? 0 : acc, sale_commission: comm, services, items });
    if (hasSale && Math.abs(bonus) >= 0.005) {
      out.push({ ...base, operation_type_name: 'Баллы за скидки', amount: bonus, accruals_for_sale: 0, sale_commission: 0, services: [], items });
    }
  }
  for (const c of a.container_fees?.fees || a.container_fees || []) if (c?.type_id != null) {
    out.push({ ...base, operation_type_name: tname(c.type_id), amount: money(c.accrued), accruals_for_sale: 0, sale_commission: 0, services: [], items: [] });
  }
  if (!out.length) out.push({ ...base, operation_type_name: a.accrued_category || 'Прочее', amount, accruals_for_sale: 0, sale_commission: 0, services: [], items: [] });
  return out;
}
