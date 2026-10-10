// Тестовые ответы API в том формате, в каком их отдают WB, Ozon, Ozon Performance, amoCRM и Т-Банк.
// Числа подобраны так, чтобы результат можно было проверить вручную (см. calc.test.js).
process.env.TZ = 'Europe/Moscow';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isoDay, daysAgo } from '../lib/db.js';
import { paymentDates } from '../lib/aggregate.js';

export const D = n => isoDay(daysAgo(n));
export const SALARY_IN = 10; // зарплата через 10 дней
const salaryDay = daysAgo(-SALARY_IN).getDate();

export const SETTINGS = {
  ownerName: 'Тест', team: ['Тест'], monthPlan: 300000, cogsPercent: 40, cogsByArticle: {},
  fixedMonthly: 60000, payments: [{ name: 'Зарплата', day: salaryDay, amount: 800000 }],
  maxDrr: 15, minStockDays: 14, syncMinutes: 30, decisionHour: 8
};

const range = n => Array.from({ length: n }, (_, i) => i);
const past = paymentDates(SETTINGS.payments, daysAgo(29), daysAgo(0)).map(e => e.date);

const API = {
  // ---- Wildberries ----
  'statistics-api.wildberries.ru/api/v1/supplier/sales': () => [
    ...range(60).flatMap(d => [
      { date: D(d) + 'T10:00:00', saleID: `S${d}a`, supplierArticle: 'A1', nmId: 111, subject: 'Бандаж', priceWithDisc: 1000, forPay: 700 },
      { date: D(d) + 'T11:00:00', saleID: `S${d}b`, supplierArticle: 'A1', nmId: 111, subject: 'Бандаж', priceWithDisc: 1000, forPay: 700 },
      { date: D(d) + 'T12:00:00', saleID: `S${d}c`, supplierArticle: 'A2', nmId: 222, subject: 'Ортез', priceWithDisc: 2000, forPay: 1300 }
    ]),
    { date: D(3) + 'T15:00:00', saleID: 'R1', supplierArticle: 'A1', nmId: 111, subject: 'Бандаж', priceWithDisc: -1000, forPay: -700 }
  ],
  'statistics-api.wildberries.ru/api/v1/supplier/orders': () => range(60).flatMap(d => range(3).map(k => ({ date: D(d) + 'T09:00:00', supplierArticle: k ? 'A1' : 'A2', priceWithDisc: 1000, isCancel: false }))),
  'statistics-api.wildberries.ru/api/v1/supplier/stocks': () => [
    { supplierArticle: 'A1', nmId: 111, subject: 'Бандаж', quantity: 30, inWayFromClient: 1 },
    { supplierArticle: 'A1', nmId: 111, subject: 'Бандаж', quantity: 20, inWayFromClient: 0 },
    { supplierArticle: 'A2', nmId: 222, subject: 'Ортез', quantity: 10, inWayFromClient: 0 }
  ],
  // ---- Документы WB ----
  'documents-api.wildberries.ru/api/v1/documents/list': () => ({ data: { documents: [
    { serviceName: 'act-2026-1', name: 'Акт оказания услуг', category: 'Акты', extensions: ['pdf'], creationTime: D(2) + 'T10:00:00Z' },
    { serviceName: 'report-zip', name: 'Детализация', category: 'Отчёты', extensions: ['zip'], creationTime: D(3) + 'T10:00:00Z' }] } }),
  'documents-api.wildberries.ru/api/v1/documents/download': () => ({ data: { fileName: 'Акт WB.pdf', extension: 'pdf', document: Buffer.from('%PDF-1.4 акт WB').toString('base64') } }),
  // ---- Реклама WB ----
  'advert-api.wildberries.ru/adv/v1/promotion/count': () => ({ adverts: [{ type: 8, status: 9, count: 1, advert_list: [{ advertId: 101, changeTime: new Date().toISOString() }] }] }),
  'advert-api.wildberries.ru/adv/v1/promotion/adverts': () => [{ advertId: 101, name: 'Авто A1' }],
  'advert-api.wildberries.ru/adv/v3/fullstats': () => [{
    advertId: 101, sum: 9000, views: 30000, clicks: 900, orders: 30, sum_price: 45000,
    days: range(30).map(d => ({ date: D(d) + 'T00:00:00+03:00', sum: 300, views: 1000, clicks: 30, orders: 1, sum_price: 1500, apps: [{ nms: [{ nmId: 111 }] }] }))
  }],
  // ---- Ozon Seller ----
  'api-seller.ozon.ru/v2/analytics/stock_on_warehouses': () => ({ result: { rows: [{ sku: 555, item_code: 'B1', item_name: 'Подушка', free_to_sell_amount: 30, promised_amount: 5 }] } }),
  'api-seller.ozon.ru/v4/product/info/stocks': () => ({ cursor: '', total: 1, items: [{ offer_id: 'B1', product_id: 1, stocks: [{ type: 'fbo', sku: 555, present: 30, reserved: 2 }] }] }),
  'api-seller.ozon.ru/v1/analytics/data': () => ({ result: { data: range(60).map(d => ({ dimensions: [{ id: '555', name: 'Подушка' }, { id: D(d) }], metrics: [3000, 2] })) } }),
  'api-seller.ozon.ru/v3/finance/transaction/totals': () => ({ result: { accruals_for_sale: 90000, sale_commission: -15000, processing_and_delivery: -9000, refunds_and_cancellations: 0, services_amount: 0, compensation_amount: 0, others_amount: 0 } }),
  'api-seller.ozon.ru/v3/finance/transaction/list': () => ({ result: { page_count: 1, row_count: 6, operations: [
    { operation_type: 'OperationAgentDeliveredToCustomer', operation_type_name: 'Доставка покупателю', type: 'orders', amount: 1700, accruals_for_sale: 3000, sale_commission: -900,
      items: [{ name: 'Подушка', sku: 555 }, { name: 'Подушка', sku: 555 }],
      services: [{ name: 'MarketplaceServiceItemDirectFlowLogistic', price: -300 }, { name: 'MarketplaceRedistributionOfAcquiringOperation', price: -100 }] },
    { operation_type: 'MarketplaceRedistributionOfPointsForDiscounts', operation_type_name: 'Баллы за скидки', type: 'other', amount: 200, accruals_for_sale: 0, sale_commission: 0, items: [{ name: 'Подушка', sku: 555 }], services: [] },
    { operation_type: 'ClientReturnAgentOperation', operation_type_name: 'Получение возврата, отмены, невыкупа от покупателя', type: 'returns', amount: -1050, accruals_for_sale: -1500, sale_commission: 450, items: [{ name: 'Подушка', sku: 555 }], services: [] },
    { operation_type: 'OperationMarketplaceServiceStorage', operation_type_name: 'Услуга размещения товаров на складе', type: 'services', amount: -120, accruals_for_sale: 0, sale_commission: 0, items: [], services: [] },
    { operation_type: 'OperationElectronicServiceStencil', operation_type_name: 'Услуга продвижения Оплата за клик', type: 'services', amount: -500, accruals_for_sale: 0, sale_commission: 0, items: [], services: [] },
    { operation_type: 'OperationSubscriptionPremium', operation_type_name: 'Подписка Premium', type: 'services', amount: -990, accruals_for_sale: 0, sale_commission: 0, items: [], services: [] }
  ] } }),
  // Формат — как в реальном ответе Ozon (образец из лога Railway)
  'api-seller.ozon.ru/v1/finance/accrual/types': () => ({ accrual_types: [
    { id: 1, name: 'Acquiring', description: 'Эквайринг' }, { id: 32, name: 'Logistic', description: 'Логистика' },
    { id: 69, name: 'SaleCommission', description: 'Вознаграждение за продажу' }, { id: 76, name: 'PremiumSubscription', description: 'Подписка Premium' }] }),
  'api-seller.ozon.ru/v1/finance/accrual/by-day': (u, opt) => JSON.parse(opt.body).date !== D(0) ? { accruals: [], last_id: '' } : { last_id: '', accruals: [
    { accrual_id: 1, date: D(0), total_amount: { amount: '2000', currency: 'RUB' }, accrued_category: 'POSTING', item_fees: null, non_item_fee: null,
      posting: { posting_number: '1-1', products: [{ sku: 555, quantity: 2, delivery: { services: [{ type_id: 32, accrued: { amount: '-300', currency: 'RUB' } }] }, commission: { accrued: { amount: '-700', currency: 'RUB' } } }] } },
    { accrual_id: 2, date: D(0), total_amount: { amount: '-300', currency: 'RUB' }, accrued_category: 'ITEM', posting: null, non_item_fee: null,
      item_fees: { fees: [{ sku: 555, quantity: 2, fees: [{ type_id: 1, accrued: { amount: '-100', currency: 'RUB' } }, { type_id: 69, accrued: { amount: '-200' } }] }] } },
    { accrual_id: 3, date: D(0), total_amount: { amount: '-990', currency: 'RUB' }, accrued_category: 'NON_ITEM', posting: null, item_fees: null,
      non_item_fee: { type_id: 76, accrued: { amount: '-990', currency: 'RUB' } } }] },
  // ---- Ozon Performance ----
  'api-performance.ozon.ru/api/client/token': () => ({ access_token: 'test-token', expires_in: 1800 }),
  'api-performance.ozon.ru/api/client/campaign/9/objects': () => ({ list: [{ id: '555' }] }),
  'api-performance.ozon.ru/api/client/campaign': () => ({ list: [{ id: '9', title: 'Поиск B1', state: 'CAMPAIGN_STATE_RUNNING', advObjectType: 'SKU' }] }),
  'api-performance.ozon.ru/api/client/statistics/daily/json': () => ({ rows: range(30).map(d => ({ id: '9', title: 'Поиск B1', date: D(d), views: '2000', clicks: '20', moneySpent: '500,00', orders: '1', ordersMoney: '2500,00' })) }),
  // ---- amoCRM ----
  'test.amocrm.ru/api/v4/leads/pipelines': () => ({ _embedded: { pipelines: [{ id: 7, is_main: true, _embedded: { statuses: [
    { id: 1, name: 'Новый лид', sort: 10 }, { id: 2, name: 'Счёт выставлен', sort: 20 },
    { id: 142, name: 'Успешно реализовано', sort: 10000 }, { id: 143, name: 'Закрыто и не реализовано', sort: 11000 }] } }] } }),
  'test.amocrm.ru/api/v4/users': () => ({ _embedded: { users: [{ id: 5, name: 'Мария' }] } }),
  'test.amocrm.ru/api/v4/leads?': () => ({ _embedded: { leads: [
    { id: 1, name: 'Опт 500 шт.', price: 100000, status_id: 1, responsible_user_id: 5, created_at: 1700000000 },
    { id: 2, name: 'Клиника', price: 50000, status_id: 2, responsible_user_id: 5, created_at: 1700000000 },
    { id: 3, name: 'Спорт-магазин', price: 30000, status_id: 142, responsible_user_id: 5, closed_at: Math.floor(daysAgo(5).getTime() / 1000) },
    { id: 4, name: 'Отказ', price: 70000, status_id: 143, responsible_user_id: 5 }] } }),
  'test.amocrm.ru/api/v4/leads/1': () => ({ id: 1 }),
  // ---- Т-Банк ----
  'business.tbank.ru/openapi/api/v4/bank-accounts': () => [{ accountNumber: '40702810000000000001', name: 'Расчётный', currency: 'RUB', balance: { otb: 500000 } }],
  'business.tbank.ru/openapi/api/v1/statement': () => ({ operations: [
    ...range(30).map(d => ({ operationDate: D(d) + 'T12:00:00', operationAmount: 8000, typeOfOperation: 'Credit', counterParty: { name: 'Wildberries' }, payPurpose: 'Выплата' })),
    { operationDate: D(5) + 'T12:00:00', operationAmount: 100000, typeOfOperation: 'Debit', counterParty: { name: 'ООО Аренда' }, payPurpose: 'Аренда' },
    ...past.map(date => ({ operationDate: date + 'T10:00:00', operationAmount: 800000, typeOfOperation: 'Debit', counterParty: { name: 'Сотрудники' }, payPurpose: 'Зарплата' }))
  ] })
};

export const calls = [];

// failing: { 'api-seller.ozon.ru': 401 } — сервис отвечает ошибкой
// extra: { 'адрес': (url, opt) => тело ответа | Buffer } — дополнительные ответы (Claude, Telegram)
const mock = { failing: {}, routes: API };
export function installMock(failing = {}, extra = {}) {
  calls.length = 0;
  mock.failing = failing;
  mock.routes = { ...API, ...extra };
  globalThis.fetch = mockFetch;
}
// Одна и та же функция: SDK Claude запоминает fetch при создании клиента
async function mockFetch(url, opt = {}) {
  const { failing, routes } = mock;
  {
    const u = String(url instanceof Request ? url.url : url).replace(/^https:\/\//, '');
    calls.push({ url: u, method: opt.method || 'GET', body: opt.body, headers: opt.headers });
    for (const [host, status] of Object.entries(failing)) {
      if (u.startsWith(host)) return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, message: 'Invalid token' }), { status, headers: { 'Content-Type': 'application/json' } });
    }
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => u.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: 'not mocked: ' + u }), { status: 404 });
    const body = await routes[key](u, opt);
    if (body?.__raw) return new Response(body.__raw, { status: 200, headers: { 'Content-Type': body.contentType } });
    if (Buffer.isBuffer(body)) return new Response(body, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}

// Ответ Claude Messages API в формате API
export const claudeMessage = text => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 }
});

export function setupEnv() {
  Object.assign(process.env, {
    NO_SLEEP: '1', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'brandos-test-')),
    WB_TOKEN: 'wb-test', OZON_CLIENT_ID: '1', OZON_API_KEY: 'oz-test',
    OZON_PERF_CLIENT_ID: 'p', OZON_PERF_CLIENT_SECRET: 's',
    AMO_SUBDOMAIN: 'test', AMO_TOKEN: 'amo-test', TBANK_TOKEN: 'tb-test'
  });
  for (const k of ['BITRIX_WEBHOOK_URL', 'TOCHKA_TOKEN', 'WB_ADS', 'WB_DOCS', 'AMO_PIPELINE_ID', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'MAIL_USER', 'DIADOC_API_KEY']) delete process.env[k];
}

// Тот же ответ Claude, но потоком событий (SSE) — для запросов со стримингом
export function claudeStream(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const msg = claudeMessage('');
  return {
    contentType: 'text/event-stream',
    __raw: ev('message_start', { message: { ...msg, content: [], stop_reason: null } }) +
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) +
      ev('content_block_stop', { index: 0 }) +
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }) +
      ev('message_stop', {})
  };
}
