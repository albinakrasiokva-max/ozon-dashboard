// Отчёты для страницы «Аналитика Ozon» (ozon.html), собранные из API.
// Формы данных — те же, что страница получает из Excel-выгрузок кабинета (см. PARSERS в ozon.html):
// начисления — из /v3/finance/transaction/list, остатки — из /v2/analytics/stock_on_warehouses,
// реклама — из Ozon Performance. Поэтому все расчёты страницы работают без изменений.
import { num } from './http.js';

const r2 = v => Math.round(v * 100) / 100;
const blankFees = () => ({ commission: 0, acquiring: 0, logistics: 0, storage: 0, penalties: 0, other: 0, ads: 0 });
const blankSold = () => ({ soldQty: 0, retQty: 0, soldAmt: 0, soldLoyal: 0, retAmt: 0, retLoyal: 0 });

// Статья расходов по названию операции (operation_type_name, по-русски)
export function classifyOperation(name) {
  const t = String(name || '').toLowerCase();
  if (/подписк|premium/.test(t)) return 'adsSub';
  if (/продвиж|реклам|трафарет|за клик|за заказ|бонусы продавца/.test(t)) return 'ads';
  if (/эквайр/.test(t)) return 'acquiring';
  if (/штраф|неустой|нарушен/.test(t)) return 'penalties';
  if (/хранен|размещен/.test(t)) return 'storage';
  if (/логист|доставк|магистрал|миль|возврат|невыкуп|отмен|кросс-?док|перемещ|обработк|сборк/.test(t)) return 'logistics';
  return 'other';
}
// Статья по коду услуги в services[] (MarketplaceServiceItemDirectFlowLogistic и т. п.)
export function classifyService(name) {
  const t = String(name || '').toLowerCase();
  if (/acquiring/.test(t)) return 'acquiring';
  if (/storage|placement/.test(t)) return 'storage';
  if (/logistic|deliv|flow|pickup|dropoff|fulfillment|return|lastmile|courier|crossdock|trans|packag/.test(t)) return 'logistics';
  return 'other';
}

// Начисления за период → dataset типа accruals. ops — result.operations из /v3/finance/transaction/list.
export function accrualsDataset(ops, period, names = {}) {
  const items = {}, unassigned = blankFees(), byType = {};
  let adsSub = 0, adsOther = 0;
  const item = sku => items[sku] ||= { sku: +sku, name: names[sku]?.name || '', article: names[sku]?.article || '', fees: blankFees(), sold: blankSold() };

  for (const op of ops) {
    const name = op.operation_type_name || op.operation_type || '';
    const amount = num(op.amount);
    const key = `${op.type || 'other'} → ${name}`;
    byType[key] = r2((byType[key] || 0) + amount);
    const list = (op.items || []).filter(x => Number(x.sku) > 0);

    if (!list.length) {   // операция без товара: подписка, реклама, общие услуги
      const cls = classifyOperation(name);
      if (cls === 'adsSub') adsSub += -amount;
      else if (cls === 'ads') adsOther += -amount;
      else unassigned[cls] += -amount;
      continue;
    }
    // В items каждая проданная штука — отдельная строка; суммы операции делим поровну
    const n = list.length;
    const acc = num(op.accruals_for_sale), comm = num(op.sale_commission);
    const services = (op.services || []).map(s => ({ cls: classifyService(s.name), v: num(s.price) }));
    const rest = amount - acc - comm - services.reduce((a, s) => a + s.v, 0);
    const loyal = /балл|партн/i.test(name);
    for (const x of list) {
      const it = item(x.sku);
      it.name ||= x.name || '';
      if (loyal) {   // баллы за скидки и программы партнёров — часть цены, которую доплачивает Ozon
        if (amount >= 0) it.sold.soldLoyal += amount / n; else it.sold.retLoyal += -amount / n;
        continue;
      }
      if (acc > 0) { it.sold.soldAmt += acc / n; it.sold.soldQty += 1; }
      else if (acc < 0) { it.sold.retAmt += -acc / n; it.sold.retQty += 1; }
      it.fees.commission += -comm / n;
      for (const s of services) it.fees[s.cls] += -s.v / n;
      if (Math.abs(rest) > 0.005) {
        const cls = classifyOperation(name);
        it.fees[cls === 'adsSub' ? 'ads' : cls] += -rest / n;
      }
    }
  }
  for (const it of Object.values(items)) {
    for (const k in it.fees) it.fees[k] = r2(it.fees[k]);
    for (const k in it.sold) it.sold[k] = r2(it.sold[k]);
  }
  for (const k in unassigned) unassigned[k] = r2(unassigned[k]);
  const hasSales = Object.values(items).some(it => it.sold.soldQty > 0);
  return {
    id: `api-accruals-${period.from.slice(0, 7)}`, type: 'accruals', source: 'api', fileName: 'Ozon API · начисления',
    loadedAt: new Date().toISOString(), period, snapshotDate: null,
    data: { items, unassigned, adsByCamp: {}, adsSub: r2(adsSub), adsOther: r2(adsOther), hasSales, byType },
    warnings: hasSales ? [] : ['за период нет продаж в начислениях']
  };
}

// Остатки на сегодня → dataset типа stock. rows — result.rows из /v2/analytics/stock_on_warehouses,
// units28 — заказано штук за 28 дней по SKU (для скорости продаж).
export function stockDataset(rows, units28, date) {
  const items = {};
  for (const x of rows) {
    const sku = Number(x.sku); if (!(sku > 0)) continue;
    const it = items[sku] ||= { sku, name: x.item_name || '', article: x.item_code || '', liquidity: '', daysLeft: null, avgDaily: null, daysNoSales: null, fee: 0, total: 0, available: 0, inbound: 0 };
    const free = num(x.free_to_sell_amount);
    it.available += free;
    it.total += free + num(x.reserved_amount);
    it.inbound += num(x.promised_amount);
  }
  for (const it of Object.values(items)) {
    it.avgDaily = r2((units28[it.sku] || 0) / 28);
    it.daysLeft = it.avgDaily > 0 ? Math.floor(it.available / it.avgDaily) : null;
  }
  return {
    id: 'api-stock', type: 'stock', source: 'api', fileName: 'Ozon API · остатки',
    loadedAt: new Date().toISOString(), period: null, snapshotDate: date,
    data: { items, cost: {}, hasVelocity: true },
    warnings: ['скорость продаж — по заказанным штукам за 28 дней (Ozon API)']
  };
}

// Реклама из начислений (без ключей Ozon Performance) → dataset типа ads.
// Расход берётся из операций продвижения: с товаром — на его SKU, без товара — «на все товары» по виду операции.
// Подписка Premium сюда не входит: страница учитывает её отдельно (adsSub в начислениях).
// Показов, кликов и заказов в начислениях нет — они есть только в Ozon Performance (spendOnly).
export function adsFromAccruals(ops, period, names = {}) {
  const by = {};
  for (const op of ops) {
    const name = op.operation_type_name || op.operation_type || '';
    if (classifyOperation(name) !== 'ads') continue;
    const amount = num(op.amount);
    const list = (op.items || []).filter(x => Number(x.sku) > 0);
    const parts = list.length ? list.map(x => ({ sku: Number(x.sku), title: x.name, v: amount / list.length })) : [{ sku: 0, title: '', v: amount }];
    for (const x of parts) {
      const c = by[`${x.sku}|${name}`] ||= { sku: x.sku, name: names[x.sku]?.name || x.title || '', tool: name, place: '', camp: '', spend: 0, sales: 0, orders: 0, impr: 0, clicks: 0, carts: 0 };
      c.spend += -x.v;
    }
  }
  const campaigns = Object.values(by).filter(c => Math.abs(c.spend) > 0.005);
  for (const c of campaigns) c.spend = r2(c.spend);
  if (!campaigns.length) return null;
  return {
    id: `api-adsacc-${period.from.slice(0, 7)}`, type: 'ads', source: 'api', fileName: 'Ozon API · реклама из начислений',
    loadedAt: new Date().toISOString(), period, snapshotDate: null,
    data: { campaigns, hasCarts: false, hasOrders: false, spendOnly: true },
    warnings: ['только расход: показы, клики и заказы из рекламы есть лишь в Ozon Performance']
  };
}

const TOOLS = { SKU: 'Оплата за клик', SEARCH_PROMO: 'Оплата за заказ', BANNER: 'Баннер', VIDEO_BANNER: 'Видеобаннер', BRAND_SHELF: 'Брендовая полка' };

// Реклама за период → dataset типа ads. rows — дневная статистика Performance API,
// camps — {id: {title, type, skus}}; если в кампании ровно один товар, расход привязывается к нему,
// иначе кампания считается «на все товары» (sku 0) и делится по выручке.
export function adsDataset(rows, camps, period) {
  const by = {};
  for (const r of rows) {
    const id = String(r.id);
    const c = camps[id] || {};
    const sku = c.skus?.length === 1 ? Number(c.skus[0]) || 0 : 0;
    const x = by[id] ||= { sku, name: r.title || c.title || `Кампания ${id}`, tool: TOOLS[c.type] || c.type || '', place: '', camp: id, spend: 0, sales: 0, orders: 0, impr: 0, clicks: 0, carts: 0 };
    x.spend += num(r.moneySpent); x.sales += num(r.ordersMoney); x.orders += num(r.orders);
    x.impr += num(r.views); x.clicks += num(r.clicks);
  }
  const campaigns = Object.values(by).filter(c => c.spend > 0 || c.impr > 0);
  for (const c of campaigns) for (const k of ['spend', 'sales']) c[k] = r2(c[k]);
  if (!campaigns.length) return null;
  return {
    id: `api-ads-${period.from.slice(0, 7)}`, type: 'ads', source: 'api', fileName: 'Ozon Performance API · реклама',
    loadedAt: new Date().toISOString(), period, snapshotDate: null,
    data: { campaigns, hasCarts: false, hasOrders: true },
    warnings: []
  };
}

// Последние n месяцев, включая текущий: [{from, to, start, end}], from/to — 'YYYY-MM-DD'
export function lastMonths(n, now = new Date()) {
  const pad = v => String(v).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const res = [];
  for (let k = n - 1; k >= 0; k--) {
    const start = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const end = k ? new Date(now.getFullYear(), now.getMonth() - k + 1, 0, 23, 59, 59) : now;
    res.push({ from: iso(start), to: iso(end), start, end });
  }
  return res;
}
