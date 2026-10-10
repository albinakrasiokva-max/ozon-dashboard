// Отчёт по расчётам на тестовых данных: npm run check
// Ничего не отправляет наружу: ответы API подменены тестовыми (test/fixtures.js).
import { SETTINGS, installMock, setupEnv } from './fixtures.js';

setupEnv();
installMock();
const { getDb } = await import('../lib/db.js');
const { syncAll, enabledKeys, sourceStatus } = await import('../lib/sync.js');
const { buildDashboard } = await import('../lib/aggregate.js');

await syncAll();
const d = buildDashboard({ raw: getDb().raw, enabled: enabledKeys(), settings: SETTINGS });
const rub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const line = (a, b) => console.log('  ' + a.padEnd(42, ' ') + b);

console.log('\nИсточники');
for (const s of sourceStatus().filter(s => s.enabled)) line(s.name, s.ok ? 'ok' : 'ошибка: ' + s.error);

console.log('\nМесяц (с 1-го числа по сегодня)');
line('Выручка', `${rub(d.kpi.revenue.v)} (${d.kpi.revenue.d > 0 ? '+' : ''}${d.kpi.revenue.d}% к прошлому месяцу)`);
line('Выплаты маркетплейсов', rub(d.pnl.payout));
line('− Себестоимость (40%)', rub(d.pnl.cogs));
line('− Реклама', rub(d.pnl.ads));
line('− Расходы (постоянные + график)', rub(d.pnl.exp));
line('= Чистая прибыль', `${rub(d.kpi.profit.v)}, маржа ${d.kpi.margin.v}%`);
line('План / прогноз на конец месяца', `${rub(d.plan.plan)} / ${rub(d.plan.fc)}`);

console.log('\nКаналы за 28 дней');
for (const c of d.channels) line(c.name, `доля ${c.share}%, маржа ${c.margin}%, ДРР ${c.drr}%${c.estimated ? ' (≈ оценка выплат)' : ''}`);

console.log('\nАртикулы за 28 дней');
for (const s of d.skus) {
  const daily = s.sold / 28, days = daily ? s.stock / daily : Infinity;
  const profit = s.rev * (1 - s.cogs - s.fees) - s.ads;
  line(`${s.art} ${s.name} (${s.ch})`, `выручка ${rub(s.rev)}, продано ${s.sold}, остаток ${s.stock} → хватит на ${days.toFixed(1)} дн., реклама ${rub(s.ads)}, прибыль ${rub(profit)}`);
}

console.log('\nРекламные кампании за 30 дней');
for (const c of d.campaigns) line(c.name, `расход ${rub(c.spend)}, заказы на ${rub(c.rev)}, ДРР ${Math.round(c.spend / c.rev * 1000) / 10}% (неделя ${c.drrWeek}%), CTR ${c.ctr}%`);

console.log('\nДеньги');
line('На счетах сейчас', rub(d.kpi.cash.v));
for (const e of d.cashEvents) line(`Платёж через ${e.i} дн.: ${e.name}`, '−' + rub(e.amt));
const min = d.forecast.filter(p => p.i > 0).reduce((a, p) => (p.bal < a.bal ? p : a));
line('Минимум за 30 дней', `${rub(min.bal)} через ${min.i} дн.`);
line('Кассовый разрыв', d.gap ? `через ${d.gap.i} дн., остаток ${rub(d.gap.bal)}` : 'нет');

console.log('\nCRM');
for (const st of d.crm.stages) { const ds = d.crm.deals.filter(x => x.stage === st); line(st, `${ds.length} сделок на ${rub(ds.reduce((a, x) => a + x.sum, 0))}`); }

console.log('\nДемо-блоки (нет источника): ' + Object.entries(d.demo).filter(([, v]) => v).map(([k]) => k).join(', '));
console.log('\nПримечания к расчётам:');
for (const n of d.notes) console.log('  • ' + n);
