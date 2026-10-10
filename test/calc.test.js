// Проверка коннекторов и расчётов на тестовых ответах API. Запуск: npm test
import { D, SETTINGS, SALARY_IN, calls, installMock, setupEnv } from './fixtures.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { daysAgo } from '../lib/db.js';

setupEnv();
const { getDb } = await import('../lib/db.js');
const { syncAll, enabledKeys, sourceStatus, crmSource } = await import('../lib/sync.js');
const { buildDashboard } = await import('../lib/aggregate.js');

const near = (a, b, eps = 1, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: получили ${a}, ожидали ${b}`);
let dash;

before(async () => {
  installMock();
  await syncAll();
  dash = buildDashboard({ raw: getDb().raw, enabled: enabledKeys(), settings: SETTINGS });
});

// Ожидаемые значения считаем «в лоб» по дням текущего месяца
function expected() {
  const now = new Date(), day = now.getDate(), dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const ratio = 66000 / 90000;
  const inMonth = d => daysAgo(d).getMonth() === now.getMonth();
  let rev = 0, payout = 0, ads = 0;
  for (let d = 0; d < day; d++) {
    rev += 4000 + 3000;
    payout += 2700 + 3000 * ratio;
    if (d < 30) ads += 300 + 500;
  }
  if (inMonth(3)) { rev -= 1000; payout -= 700; }
  const exp = (60000 + 800000) * day / dim;
  const profit = payout - rev * 0.4 - ads - exp;
  return { rev, payout, ads, exp, profit, day, dim };
}

test('все источники синхронизировались без ошибок', () => {
  for (const s of sourceStatus().filter(s => s.enabled)) assert.equal(s.error, null, s.name);
  assert.deepEqual(enabledKeys().sort(), ['amocrm', 'ozon', 'ozonPerf', 'tbank', 'wb', 'wbAds', 'wbDocs']);
  // Документы WB: PDF взят, zip пропущен; без ключа Claude документ не распознаётся
  assert.equal(getDb().raw.wbDocs.lastAdded, 1);
  const doc = getDb().store.docs.find(d => d.source === 'WB');
  assert.equal(doc.name, 'Акт WB.pdf'); assert.equal(doc.ai, 'off'); assert.equal(doc.date, D(2));
});

test('ключи уходят только в заголовках и только своим сервисам', () => {
  const wb = calls.find(c => c.url.startsWith('statistics-api'));
  assert.equal(wb.headers.Authorization, 'wb-test');
  const oz = calls.find(c => c.url.startsWith('api-seller'));
  assert.equal(oz.headers['Api-Key'], 'oz-test');
  for (const c of calls) assert.ok(!c.url.includes('test-token') && !c.url.includes('wb-test') && !c.url.includes('oz-test'), 'ключ в URL: ' + c.url);
  assert.ok(!JSON.stringify(dash).includes('wb-test'), 'ключ попал в ответ дашборда');
});

test('блоки с подключёнными источниками не помечены «демо», без источника — помечены', () => {
  for (const k of ['revenue', 'profit', 'margin', 'cash', 'plan', 'forecast', 'channels', 'sales', 'stock', 'skus', 'ads', 'crm', 'taxes']) assert.equal(dash.demo[k], false, k);
  for (const k of ['receivables', 'supplies', 'traffic']) assert.equal(dash.demo[k], true, k);
});

test('выручка, прибыль и маржа с начала месяца', () => {
  const e = expected();
  near(dash.kpi.revenue.v, e.rev, 1, 'выручка');
  near(dash.pnl.payout, e.payout, 1, 'выплаты');
  near(dash.pnl.ads, e.ads, 1, 'реклама');
  near(dash.pnl.exp, e.exp, 1, 'расходы');
  near(dash.kpi.profit.v, e.profit, 2, 'прибыль');
  near(dash.kpi.margin.v, Math.round(e.profit / e.rev * 1000) / 10, 0.1, 'маржа');
  near(dash.plan.fc, e.rev / e.day * e.dim, 1, 'прогноз на конец месяца');
  assert.equal(dash.kpi.revenue.spark.length, 14);
});

test('маржа и ДРР по каналам за 28 дней', () => {
  const wb = dash.channels.find(c => c.name === 'Wildberries'), oz = dash.channels.find(c => c.name === 'Ozon');
  // WB: выручка 28×4000−1000 = 111 000; выплаты 28×2700−700 = 74 900; себестоимость 40%; реклама 28×300
  near(wb.margin, (74900 - 44400 - 8400) / 111000 * 100, 0.1, 'маржа WB');
  near(wb.drr, 8400 / 111000 * 100, 0.1, 'ДРР WB');
  // Ozon: выручка 84 000; выплаты по доле 66/90; реклама 28×500
  near(oz.margin, (84000 * 66 / 90 - 33600 - 14000) / 84000 * 100, 0.1, 'маржа Ozon');
  near(oz.drr, 14000 / 84000 * 100, 0.1, 'ДРР Ozon');
  near(wb.share + oz.share, 100, 1, 'доли');
});

test('дни остатка по артикулам и реклама по артикулам', () => {
  const a1 = dash.skus.find(s => s.art === 'A1'), a2 = dash.skus.find(s => s.art === 'A2'), b1 = dash.skus.find(s => s.art === 'B1');
  assert.equal(a1.sold, 55); assert.equal(a1.stock, 50);
  near(a1.stock / (a1.sold / 28), 25.45, 0.01, 'A1 дней');
  near(a2.stock / (a2.sold / 28), 10, 0.01, 'A2 дней');
  near(b1.stock / (b1.sold / 28), 15, 0.01, 'B1 дней');
  assert.equal(a1.ads, 8400, 'реклама WB привязана к A1 по nmId');
  assert.equal(a2.ads, 0);
  assert.equal(b1.ads, 14000, 'реклама Ozon распределена на единственный артикул');
  assert.equal(b1.name, 'Подушка');
});

test('рекламные кампании: ДРР за месяц и за неделю', () => {
  const wb = dash.campaigns.find(c => c.ch === 'WB'), oz = dash.campaigns.find(c => c.ch === 'Ozon');
  assert.equal(wb.spend, 9000); assert.equal(wb.rev, 45000);
  assert.equal(oz.spend, 15000); assert.equal(oz.rev, 75000);
  assert.equal(wb.drrWeek, 20); assert.equal(oz.drrWeek, 20);
  assert.equal(oz.ctr, 1);
});

test('деньги и прогноз на 30 дней с кассовым разрывом', () => {
  assert.equal(dash.kpi.cash.v, 500000);
  assert.equal(dash.forecast.length, 41);
  // Поток без зарплаты: (30×8000 − 100 000) / 30 ≈ 4 667 в день; зарплата 800 000 через 10 дней
  const base = (30 * 8000 - 100000) / 30;
  const p = dash.forecast.find(x => x.i === SALARY_IN);
  near(p.bal, 500000 + base * SALARY_IN - 800000, 2, 'остаток в день зарплаты');
  assert.equal(dash.gap.i, SALARY_IN, 'кассовый разрыв — в день зарплаты');
  assert.equal(dash.taxes[0].name, 'Зарплата'); assert.equal(dash.taxes[0].in, SALARY_IN);
  // История: вчера вечером остаток был меньше на сегодняшние поступления
  near(dash.forecast.find(x => x.i === -1).bal, 500000 - 8000, 1, 'остаток вчера');
});

test('CRM: этапы без «закрыто и не реализовано», перенос пишется в amoCRM', async () => {
  assert.deepEqual(dash.crm.stages, ['Новый лид', 'Счёт выставлен', 'Успешно реализовано']);
  assert.equal(dash.crm.deals.length, 3);
  assert.equal(dash.crm.deals[0].who, 'Мария');
  const src = crmSource();
  calls.length = 0;
  await src.mod.updateDeal(getDb().raw.amocrm, '1', { stage: 'Счёт выставлен' });
  const c = calls.find(x => x.method === 'PATCH');
  assert.ok(c.url.endsWith('/leads/1'));
  assert.deepEqual(JSON.parse(c.body), { status_id: 2, pipeline_id: 7 });
});

test('продажи: заказы, средний чек, возвраты', () => {
  // 14 дней: WB 3 заказа/день + Ozon 2 шт./день
  assert.equal(dash.sales.orders, 14 * 5);
  near(dash.sales.returns, 1 / (28 * 3) * 100, 0.1, 'возвраты WB');
  assert.equal(dash.sales.byDay.length, 14);
  assert.equal(dash.sales.byDay[13], 7000 - (D(0) === D(3) ? 1000 : 0));
});

test('Аналитика Ozon: начисления, остатки и реклама в формате страницы ozon.html', () => {
  const { reports } = getDb().raw.ozon, ads = getDb().raw.ozonPerf.reports;
  const acc = reports.filter(d => d.type === 'accruals');
  const nMonths = new Date().getMonth() + 1;   // с января текущего года
  assert.equal(acc.length, nMonths, 'начисления помесячно с января');
  const cur = acc.at(-1);
  assert.equal(cur.period.from, D(0).slice(0, 8) + '01');
  assert.equal(cur.period.to, D(0));
  const it = cur.data.items[555];
  assert.deepEqual(it.sold, { soldQty: 2, retQty: 1, soldAmt: 3000, soldLoyal: 200, retAmt: 1500, retLoyal: 0 });
  assert.equal(it.fees.commission, 450, 'комиссия за продажу минус возвращённая при возврате');
  assert.equal(it.fees.logistics, 300); assert.equal(it.fees.acquiring, 100);
  assert.equal(it.article, 'B1', 'артикул подставлен из остатков');
  assert.equal(cur.data.unassigned.storage, 120, 'хранение без товара — общие удержания');
  assert.equal(cur.data.adsOther, 500); assert.equal(cur.data.adsSub, 990);
  assert.ok(cur.data.hasSales);

  const st = reports.find(d => d.type === 'stock').data.items[555];
  assert.equal(st.available, 30); assert.equal(st.inbound, 5);
  assert.equal(st.avgDaily, 2, '56 заказанных штук за 28 дней');
  assert.equal(st.daysLeft, 15);

  const fromAcc = reports.filter(d => d.data.spendOnly);
  assert.equal(fromAcc.length, nMonths, 'реклама из начислений — на случай, если нет ключей Performance');
  assert.deepEqual(fromAcc.at(-1).data.campaigns.map(c => [c.sku, c.tool, c.spend]), [[0, 'Услуга продвижения Оплата за клик', 500]], 'подписка Premium не входит — она учитывается отдельно');

  assert.equal(ads.length, nMonths);
  const c = ads[2].data.campaigns[0];
  assert.equal(c.sku, 555, 'кампания с одним товаром привязана к SKU');
  assert.equal(c.spend, 15000); assert.equal(c.impr, 60000); assert.equal(c.tool, 'Оплата за клик');
});

test('старый метод остатков отключён (404) — остатки берутся из /v4/product/info/stocks', async () => {
  installMock({ 'api-seller.ozon.ru/v2/analytics/stock_on_warehouses': 404 });
  await syncAll();
  const oz = sourceStatus().find(s => s.key === 'ozon');
  assert.equal(oz.error, null);
  assert.deepEqual(getDb().raw.ozon.stocks, [{ article: 'B1', qty: 28, inWay: 0 }], 'в наличии 30, из них 2 в резерве');
  const st = getDb().raw.ozon.reports.find(d => d.type === 'stock').data.items[555];
  assert.equal(st.available, 28); assert.equal(st.total, 30);
  installMock();
  await syncAll();
});

test('итоги по финансам отключены (404) — считаются по списку операций', async () => {
  installMock({ 'api-seller.ozon.ru/v3/finance/transaction/totals': 404 });
  await syncAll();
  assert.equal(sourceStatus().find(s => s.key === 'ozon').error, null);
  const f = getDb().raw.ozon.finance[1];
  assert.deepEqual({ ...f, month: undefined }, { month: undefined, accruals: 3000, commission: -450, logistics: -300, refunds: -1500, services: -1510, compensation: 0, other: 0, payout: -760 },
    'к выплате = сумма всех операций месяца');
  installMock();
  await syncAll();
});

test('старые финансовые методы отключены — начисления берутся из /v1/finance/accrual/by-day', async () => {
  installMock({ 'api-seller.ozon.ru/v3/finance/transaction/list': 404, 'api-seller.ozon.ru/v3/finance/transaction/totals': 404 });
  await syncAll();
  assert.equal(sourceStatus().find(s => s.key === 'ozon').error, null, 'синхронизация не падает');
  const raw = getDb().raw.ozon;
  const cur = raw.reports.filter(d => d.type === 'accruals').at(-1);
  const it = cur.data.items[555];
  assert.deepEqual(it.sold, { soldQty: 2, retQty: 0, soldAmt: 2400, soldLoyal: 600, retAmt: 0, retLoyal: 0 }, 'выручка по цене продавца: 2400 + 600 баллов');
  assert.equal(it.fees.commission, 900); assert.equal(it.fees.logistics, 300); assert.equal(it.fees.acquiring, 100);
  assert.equal(cur.data.adsSub, 990, 'подписка без товара');
  assert.equal(raw.finance[1].payout, 710, 'к выплате = сумма начислений месяца');
  installMock();
  await syncAll();
});

test('ошибка в начислениях не ломает основную синхронизацию Ozon', async () => {
  installMock({ 'api-seller.ozon.ru/v3/finance/transaction/list': 403 });
  await syncAll();
  const oz = sourceStatus().find(s => s.key === 'ozon');
  assert.equal(oz.error, null);
  assert.ok(getDb().raw.ozon.reports.some(d => d.type === 'accruals'), 'закрытые месяцы остаются из прошлой синхронизации');
  assert.match(getDb().raw.ozon.reportsError, /нет доступа \(403\)/);
  installMock();
  await syncAll();
});

test('ошибка ключа показывается понятным текстом, прошлые данные сохраняются', async () => {
  installMock({ 'api-seller.ozon.ru': 401 });
  await syncAll();
  const oz = sourceStatus().find(s => s.key === 'ozon');
  assert.equal(oz.ok, false);
  assert.match(oz.error, /Ozon Seller \(\/v[^)]+\): ключ не принят \(401\)/, 'в ошибке виден адрес метода');
  assert.ok(!oz.error.includes('oz-test'), 'ключ в тексте ошибки');
  assert.ok(getDb().raw.ozon.sales.length > 0, 'прошлые данные Ozon остались');
  installMock();
});

test('OZON_ONLY=1 — на главной «Аналитика Ozon»', async () => {
  const env = { PATH: process.env.PATH, PORT: '3918', OZON_ONLY: '1', DATA_DIR: process.env.DATA_DIR + '-srv2' };
  const p = spawn(process.execPath, ['server.js'], { env, cwd: new URL('..', import.meta.url).pathname });
  try {
    for (let i = 0; i < 50; i++) { try { await fetchReal('http://127.0.0.1:3918/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    assert.match(await (await fetchReal('http://127.0.0.1:3918/')).text(), /Аналитика магазина на Ozon/);
  } finally { p.kill(); }
});

test('сервер без ключей отдаёт index.html и демо-флаги', async () => {
  const env = { PATH: process.env.PATH, PORT: '3917', DATA_DIR: process.env.DATA_DIR + '-srv' };
  const p = spawn(process.execPath, ['server.js'], { env, cwd: new URL('..', import.meta.url).pathname });
  try {
    for (let i = 0; i < 50; i++) { try { await fetchReal('http://127.0.0.1:3917/api/health'); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    const html = await (await fetchReal('http://127.0.0.1:3917/')).text();
    assert.match(html, /BrandOS/);
    const d = await (await fetchReal('http://127.0.0.1:3917/api/dashboard')).json();
    assert.equal(d.demo.revenue, true); assert.equal(d.demo.cash, true);
    assert.equal(d.demo.crm, false, 'без CRM сделки ведутся вручную — это не демо');
    assert.equal(d.kpi.revenue, undefined, 'без источника цифры не выдумываются');
    const st = await (await fetchReal('http://127.0.0.1:3917/api/status')).json();
    assert.ok(st.sources.every(s => !s.enabled));
    assert.match(await (await fetchReal('http://127.0.0.1:3917/ozon')).text(), /Аналитика магазина на Ozon/);
    const oz = await (await fetchReal('http://127.0.0.1:3917/api/ozon/reports')).json();
    assert.equal(oz.seller.on, false); assert.deepEqual(oz.datasets, []);
    const r = await fetchReal('http://127.0.0.1:3917/.env');
    assert.equal(r.status, 404, '.env не отдаётся');
  } finally { p.kill(); }
});

// globalThis.fetch подменён моком — для настоящего HTTP берём undici-реализацию через новый процесс-независимый вызов
async function fetchReal(url) {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = request(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, text: async () => body, json: async () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('Ozon by-day: реальный образец продажи из кабинета раскладывается без потерь', async () => {
  const { accrualToOps } = await import('../lib/connectors/ozon.js');
  const { accrualsDataset } = await import('../lib/ozonReports.js');
  const types = { 29: 'Доставка до места выдачи', 32: 'Логистика' };
  const real = { accrual_id: 58425128776, date: '2026-08-01', total_amount: { amount: '318.23', currency: 'RUB' }, accrued_category: 'POSTING',
    posting: { delivery_schema: 'Fbo', products: [{ sku: 3019824560, quantity: 1,
      delivery: { total_accrued: { amount: '-74.5' }, services: [{ type_id: 32, accrued: { amount: '-67' } }, { type_id: 29, accrued: { amount: '-7.5' } }] },
      commission: { seller_price: { amount: '689' }, sale_price: { amount: '277.14' }, sale_commission: { amount: '-296.27' }, commission: { amount: '-296.27' },
        commission_ratio: 'value:"0.430000"', sale_amount: { amount: '689' }, coinvestment: { amount: '2.77' }, bonus: { amount: '409.09' } } }] },
    item_fees: null, non_item_fee: null, container_fees: null };
  const ops = accrualToOps(real, types);
  near(ops.reduce((s, o) => s + o.amount, 0), 318.23, 0.01, 'к выплате');
  const it = accrualsDataset(ops, { from: '2026-08-01', to: '2026-08-31' }).data.items[3019824560];
  assert.deepEqual(it.sold, { soldQty: 1, retQty: 0, soldAmt: 279.91, soldLoyal: 409.09, retAmt: 0, retLoyal: 0 }, 'выручка 689 = 279,91 + 409,09 баллов');
  assert.equal(it.fees.commission, 296.27);
  assert.equal(it.fees.logistics, 74.5);
});

test('Ozon: доходы как в документах — выкупы маркетплейсом и компенсации входят в выручку', async () => {
  const { accrualsDataset } = await import('../lib/ozonReports.js');
  const ops = [
    { operation_type_name: 'Доставка покупателю', amount: 700, accruals_for_sale: 1000, sale_commission: -300, items: [{ sku: 555 }], services: [] },
    { operation_type_name: 'Товарная компенсация', amount: 422, accruals_for_sale: 0, sale_commission: 0, items: [], services: [] }
  ];
  const ds = accrualsDataset(ops, { from: '2026-08-01', to: '2026-08-31' }, {}, [{ sku: 555, qty: 2, amount: 4093 }]);
  const it = ds.data.items[555];
  assert.equal(it.sold.soldAmt, 5093, 'выкуп — как продажа товара');
  assert.equal(it.sold.soldQty, 3);
  assert.equal(it.buyout, 4093);
  assert.equal(ds.data.income.compensation, 422, 'компенсация — доход, а не удержание');
  assert.equal(ds.data.unassigned.other, 0);
});

test('Ozon: повторное применение выкупов к месяцу не задваивает их', async () => {
  const { accrualsDataset, applyBuyouts } = await import('../lib/ozonReports.js');
  const ops = [{ operation_type_name: 'Доставка покупателю', amount: 700, accruals_for_sale: 1000, sale_commission: -300, items: [{ sku: 555 }], services: [] }];
  const ds = accrualsDataset(ops, { from: '2026-08-01', to: '2026-08-31' }, {}, [{ sku: 555, qty: 1, amount: 400 }]);
  applyBuyouts(ds, [{ sku: 555, qty: 2, amount: 900 }, { sku: 0, qty: 1, amount: 50 }]);
  assert.equal(ds.data.items[555].sold.soldAmt, 1900, '1000 продажа + 900 новые выкупы, старые 400 сняты');
  assert.equal(ds.data.items[555].sold.soldQty, 3);
  assert.equal(ds.data.income.buyout, 50);
});
