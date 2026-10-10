// Снимок живых данных для ИИ: только то, что пришло из подключённых источников и от команды.
// Демо-цифр здесь нет — блоки без источника перечислены в notConnected.
import { isoDay } from './db.js';

const DEMO_NAMES = {
  revenue: 'выручка', profit: 'прибыль', margin: 'маржа', cash: 'деньги на счетах', plan: 'план месяца', forecast: 'прогноз денег',
  channels: 'маржа по каналам', sales: 'продажи', stock: 'склад', skus: 'артикулы', ads: 'реклама',
  receivables: 'дебиторка', supplies: 'поставки', traffic: 'внешний трафик'
};

export function snapshotForAI(dash, store, sources) {
  const today = isoDay(new Date());
  const skus = (dash.skus || []).map(s => {
    const profit = s.rev * (1 - s.cogs - s.fees) - s.ads, daily = Math.max(0, s.sold) / 28;
    return {
      art: s.art, name: s.name, mp: s.ch, revenue28d: s.rev, trend7dPct: s.trend, sold28d: s.sold, stock: s.stock,
      daysOfStock: daily ? Math.round(s.stock / daily) : null, ads28d: s.ads, drrPct: s.rev ? +(s.ads / s.rev * 100).toFixed(1) : null,
      profit28d: Math.round(profit), marginPct: s.rev ? +(profit / s.rev * 100).toFixed(1) : null, estimated: !!s.est
    };
  });
  const campaigns = (dash.campaigns || []).map(c => ({
    name: c.name, status: c.status, spend30d: c.spend, ordersSum30d: c.rev, orders30d: c.orders,
    drrMonthPct: c.rev ? +(c.spend / c.rev * 100).toFixed(1) : null, drrWeekPct: c.drrWeek, ctrPct: c.ctr, costPerOrder: c.orders ? Math.round(c.spend / c.orders) : null
  }));
  const fc = dash.forecast?.filter(p => p.i > 0) || [];
  const min = fc.length ? fc.reduce((a, p) => (p.bal < a.bal ? p : a)) : null;
  const kpi = Object.fromEntries(Object.entries(dash.kpi || {}).map(([k, v]) => [k, { value: v.v, changePct: v.unit === 'pp' ? undefined : v.d, changePp: v.unit === 'pp' ? v.d : undefined }]));
  const tasks = (store.tasks || []).filter(t => t.status !== 'done').map(t => ({
    title: t.title, status: t.status === 'doing' ? 'в работе' : 'к выполнению', prio: t.prio, due: t.due || null,
    overdue: !!(t.due && t.due < today), who: t.who, createdByAI: !!t.ai
  }));
  const docs = (store.docs || []).slice().sort((a, b) => String(b.received || b.date).localeCompare(String(a.received || a.date))).slice(0, 60).map(d => ({
    name: d.name, source: d.source, type: d.type, counterparty: d.cp, amount: d.sum || null, date: d.date, due: d.due || null,
    status: d.status, needsPayment: !!d.needPay, needsSignature: !!d.needSign, section: d.section, summary: d.summary
  }));
  const deals = (dash.crm?.deals || store.deals || []).map(d => ({ title: d.title, client: d.client, sum: d.sum, stage: d.stage, who: d.who }));

  return {
    today,
    owner: dash.owner?.name,
    notConnected: [
      ...sources.filter(s => !s.enabled).map(s => s.name),
      ...Object.entries(dash.demo || {}).filter(([k, v]) => v && DEMO_NAMES[k]).map(([k]) => `${DEMO_NAMES[k]} (нет источника данных)`)
    ],
    sourceErrors: sources.filter(s => s.enabled && s.error).map(s => `${s.name}: ${s.error}`),
    notes: dash.notes,
    settings: dash.settings,
    kpiMonthToDate: kpi,
    profitAndLossMonthToDate: dash.pnl,
    plan: dash.plan,
    channels28d: dash.channels,
    sales14d: dash.sales,
    skus,
    campaigns,
    bankAccounts: dash.accounts,
    cashForecast30d: fc.length ? { minBalance: min.bal, minInDays: min.i, cashGapInDays: dash.gap?.i ?? null, cashGapBalance: dash.gap?.bal ?? null } : null,
    upcomingPayments: dash.cashEvents,
    crmStages: dash.crm?.stages,
    deals,
    openTasks: tasks,
    documents: docs,
    currentDecisions: (Array.isArray(store.decisions) ? store.decisions : []).filter(d => ['new', 'progress', 'postponed'].includes(d.status))
      .map(d => ({ key: d.key, title: d.title, direction: d.dir, status: d.status, due: d.due, effectRubPerMonth: d.effect }))
  };
}
