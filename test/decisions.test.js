// Этап 4: Центр решений. Данные — тестовые ответы API из fixtures.js, ответы Claude подменены. Запуск: npm test
import { SETTINGS, installMock, setupEnv, claudeStream, D, SALARY_IN } from './fixtures.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { daysAgo } from '../lib/db.js';

setupEnv();
const S = { ...SETTINGS, team: ['Алексей', 'Игорь (склад)'], assignees: { 'Склад': 'Игорь (склад)' }, decisionHour: 8 };
const { getDb } = await import('../lib/db.js');
const { syncAll, sourceStatus } = await import('../lib/sync.js');
const { buildDashboard } = await import('../lib/aggregate.js');
const { snapshotForAI } = await import('../lib/snapshot.js');
const { runDecisions, refreshStatuses, act, maybeDailyRun, decisionsList } = await import('../lib/decisions.js');
const { enabledKeys } = await import('../lib/sync.js');

// То же, что собирает server.js
const build = {
  settings: () => S,
  data() {
    const db = getDb(), dash = buildDashboard({ raw: db.raw, enabled: enabledKeys(), settings: S });
    return { dash, store: db.store, input: snapshotForAI(dash, db.store, sourceStatus()) };
  }
};
const byKey = k => decisionsList().find(d => d.key === k);
const claudeCalls = [];
let claudeAnswer = null;

before(async () => {
  installMock({}, { 'api.anthropic.com/v1/messages': (u, opt) => { claudeCalls.push(JSON.parse(opt.body)); return claudeStream(JSON.stringify(claudeAnswer)); } });
  await syncAll();
});

test('без ключа Claude — встроенные правила по подключённым данным', async () => {
  const run = await runDecisions(build);
  assert.equal(run.source, 'rules'); assert.equal(run.error, null);
  const keys = decisionsList().map(d => d.key).sort();
  assert.deepEqual(keys, ['ads:Ozon · Поиск B1', 'ads:WB · Авто A1', 'cash-gap', 'crm:invoiced', 'plan', 'stock:WB:A2']);

  const stock = byKey('stock:WB:A2');
  assert.equal(stock.title, 'Дозаказать арт. A2 — 50 шт.'); // 1 шт./день × 45 дней
  assert.equal(stock.urg, 'med'); assert.equal(stock.dir, 'Склад'); assert.equal(stock.status, 'new');
  assert.match(stock.sit, /хватит на 10 дн\. при пороге 14/);
  const ads = byKey('ads:WB · Авто A1');
  assert.equal(ads.title, 'Урезать кампанию «WB · Авто A1»'); // ДРР 20% — урезать, выше 25% — остановить
  assert.equal(ads.effect, 2250); // 9 000 × (1 − 15/20)
  const gap = byKey('cash-gap');
  assert.equal(gap.urg, 'high'); assert.equal(gap.effect, 0, 'разрыв — риск, а не доход в месяц');
  assert.match(gap.sit, /минимум −253\s333\s₽/);
  assert.equal(gap.due, D(-(SALARY_IN - 5)));
  for (const d of decisionsList()) assert.ok(d.steps.length >= 2 && d.steps.length <= 5, d.key);
});

test('«Принять»: каждый шаг становится задачей, решение закрывается, когда задачи выполнены', () => {
  const d = byKey('stock:WB:A2');
  act(d.id, 'accept', {}, S);
  assert.equal(d.status, 'progress');
  const tasks = getDb().store.tasks.filter(t => t.decision === d.id);
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map(t => t.title), d.steps);
  assert.ok(tasks.every(t => t.who === 'Игорь (склад)' && t.due === d.due && t.status === 'todo'));
  assert.throws(() => act(d.id, 'accept', {}, S), /уже принято/);

  tasks[0].status = 'done'; tasks[1].status = 'done';
  refreshStatuses(); assert.equal(d.status, 'progress', '2 из 3 — ещё в работе');
  tasks[2].status = 'done';
  refreshStatuses(); assert.equal(d.status, 'done');
});

test('«Отложить на 3 дня»: через 3 дня решение возвращается в «Новые»', () => {
  const d = byKey('ads:WB · Авто A1');
  act(d.id, 'postpone', {}, S);
  assert.equal(d.status, 'postponed'); assert.equal(d.until, D(-3));
  refreshStatuses(daysAgo(-2)); assert.equal(d.status, 'postponed');
  refreshStatuses(daysAgo(-3)); assert.equal(d.status, 'new');
  act(d.id, 'postpone', {}, S); // снова отложим для следующего теста
});

test('«Отклонить» с причиной: тема не возвращается при пересчёте, новые решения сохраняют id', async () => {
  const rej = byKey('ads:Ozon · Поиск B1');
  act(rej.id, 'reject', { reason: 'Это запуск новинки, ДРР высокий по плану' }, S);
  const gapId = byKey('cash-gap').id;
  await runDecisions(build);
  const list = decisionsList();
  assert.equal(list.filter(d => d.key === 'ads:Ozon · Поиск B1').length, 1, 'отклонённое не продублировано');
  assert.equal(byKey('ads:Ozon · Поиск B1').status, 'rejected');
  assert.equal(list.filter(d => d.key === 'ads:WB · Авто A1').length, 1, 'отложенное не продублировано');
  assert.equal(list.filter(d => d.key === 'stock:WB:A2').length, 1, 'выполненное недавно не предлагается снова');
  assert.equal(byKey('cash-gap').id, gapId, 'то же решение — тот же id');
});

test('с ключом Claude: на входе вся картина и прошлые ответы, на выходе — проверенные решения', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  claudeAnswer = { decisions: [
    { key: 'price:Ozon:B1', direction: 'Цены', urgency: 'high', title: 'Поднять цену арт. B1 на 7%', situation: 'Маржа B1 16,7% при ДРР 16,7%.', why: 'Реклама съедает маржу.', steps: ['Поднять цену на 7%', 'Через неделю проверить заказы'], effectRubPerMonth: 5880.4, dueDate: D(-2), confidence: 150, metric: 'Маржа B1 ≥ 20%' },
    { key: 'misc', direction: 'Неизвестное', urgency: 'soon', title: 'Сверить остатки', situation: '—', why: '—', steps: ['Выгрузить остатки', 'Сверить со складом'], effectRubPerMonth: -100, dueDate: '2020-01-01', confidence: 40, metric: 'Расхождение 0' },
    { key: 'one-step', direction: 'Склад', urgency: 'low', title: 'Мало шагов', situation: '', why: '', steps: ['Один шаг'], effectRubPerMonth: 0, dueDate: D(-1), confidence: 50, metric: '' },
    { key: 'ads:Ozon · Поиск B1', direction: 'Реклама', urgency: 'high', title: 'Остановить «Поиск B1»', situation: '', why: '', steps: ['Пауза', 'Перенос бюджета'], effectRubPerMonth: 3750, dueDate: D(-1), confidence: 70, metric: '' }
  ] };
  const run = await runDecisions(build);
  assert.equal(run.source, 'ai'); assert.equal(run.count, 2);

  const req = claudeCalls.at(-1);
  assert.equal(req.stream, true, 'длинный ответ — стримингом');
  assert.equal(req.output_config.effort, 'high');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.fallbacks, 'default');
  const input = JSON.parse(req.messages[0].content.split('<business_data>\n')[1].split('\n</business_data>')[0]);
  const a2 = input.skus.find(s => s.art === 'A2');
  assert.equal(a2.daysOfStock, 10); assert.equal(a2.revenue28d, 56000); assert.equal(a2.trend7dPct, 0);
  const camp = input.campaigns.find(c => c.name === 'WB · Авто A1');
  assert.equal(camp.drrMonthPct, 20); assert.equal(camp.drrWeekPct, 20); assert.equal(camp.costPerOrder, 300); assert.equal(camp.ctrPct, 3);
  assert.equal(input.cashForecast30d.cashGapInDays, SALARY_IN);
  assert.ok(input.deals.length && input.openTasks && input.documents);
  const hist = input.decisionHistory.find(h => h.key === 'ads:Ozon · Поиск B1');
  assert.equal(hist.answer, 'отклонено'); assert.equal(hist.rejectReason, 'Это запуск новинки, ДРР высокий по плану');
  assert.ok(input.decisionHistory.some(h => h.answer === 'принято и выполнено'));
  assert.equal(input.today, D(0));

  const price = byKey('price:Ozon:B1');
  assert.equal(price.source, 'ai'); assert.equal(price.conf, 100); assert.equal(price.effect, 5880);
  const misc = byKey('misc');
  assert.equal(misc.dir, 'Финансы'); assert.equal(misc.urg, 'med'); assert.equal(misc.effect, 0); assert.equal(misc.due, D(0));
  assert.equal(byKey('one-step'), undefined, 'решение с одним шагом отброшено');
  assert.equal(decisionsList().filter(d => d.key === 'ads:Ozon · Поиск B1').length, 1, 'отклонённая тема не вернулась');
  assert.equal(byKey('cash-gap'), undefined, 'старые «новые» заменены свежим списком');
});

test('ИИ не ответил — список составляют правила, причина видна', async () => {
  installMock({ 'api.anthropic.com': 401 });
  const run = await runDecisions(build);
  assert.equal(run.source, 'rules');
  assert.match(run.error, /ИИ не ответил \(Claude API: ключ не принят \(401\)/);
  assert.ok(byKey('cash-gap'));
  delete process.env.ANTHROPIC_API_KEY;
});

test('утренний разбор — один раз в день, не раньше часа из settings.json', async () => {
  const at = h => { const d = new Date(); d.setHours(h, 5, 0, 0); return d; };
  delete getDb().state.decisionsDaily;
  assert.equal(maybeDailyRun(build, at(7)), null, 'в 7:05 ещё рано');
  const r = maybeDailyRun(build, at(8));
  assert.ok(r, 'в 8:05 запускается');
  assert.equal((await r).reason, 'daily');
  assert.equal(maybeDailyRun(build, at(15)), null, 'второй раз за день — нет');
});
