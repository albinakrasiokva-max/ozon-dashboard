// Расчёты дашборда из нормализованных данных коннекторов. Чистая функция — легко проверить на тестовых данных.
// Блок, у которого нет подключённого источника, помечается demo[блок] = true и не заполняется:
// браузер показывает там демо-цифры с пометкой «демо».
import { isoDay, daysAgo } from './db.js';

const sum = (a, f = x => x) => a.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const r0 = n => Math.round(n);
const r1 = n => Math.round(n * 10) / 10;
const change = (a, b) => (b ? r1((a - b) / Math.abs(b) * 100) : 0);
const stdev = a => {
  if (a.length < 2) return 0;
  const m = sum(a) / a.length;
  return Math.sqrt(sum(a, x => (x - m) ** 2) / (a.length - 1));
};
const COLORS = { WB: '#9b5cff', Ozon: '#4f8cff' };
const MP_NAME = { WB: 'Wildberries', Ozon: 'Ozon' };

// Даты платежей из графика settings.payments ({name, day, amount}) в интервале [from, to]
export function paymentDates(payments, from, to) {
  const out = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const last = daysIn(d.getFullYear(), d.getMonth());
    for (const p of payments || []) {
      if (d.getDate() === Math.min(Number(p.day) || 1, last)) out.push({ date: isoDay(d), name: p.name, amt: Number(p.amount) || 0 });
    }
  }
  return out;
}

export function buildDashboard({ raw, enabled, settings: S, now = new Date() }) {
  const live = k => (enabled.includes(k) && raw[k]) || null;
  const wb = live('wb'), oz = live('ozon');
  const crm = enabled.includes('amocrm') ? live('amocrm') : live('bitrix');
  const banks = ['tbank', 'tochka'].map(live).filter(Boolean);
  const mps = [wb && 'WB', oz && 'Ozon'].filter(Boolean);
  const hasMp = mps.length > 0, hasBank = banks.length > 0;
  const hasAds = !!(live('wbAds') || live('ozonPerf'));
  const notes = [];

  const y = now.getFullYear(), m = now.getMonth(), day = now.getDate(), dim = daysIn(y, m);
  const today = isoDay(now), D = n => isoDay(daysAgo(n, now));
  const today0 = daysAgo(0, now);
  const monthStart = isoDay(new Date(y, m, 1));
  const prevDim = daysIn(y, m - 1), prevDays = Math.min(day, prevDim);
  const prevStart = isoDay(new Date(y, m - 1, 1)), prevEnd = isoDay(new Date(y, m - 1, prevDays));
  const inR = (d, a, b) => d >= a && d <= b;
  const a28 = D(27), a14 = D(13);

  const sales = [...(wb?.sales || []), ...(oz?.sales || [])].filter(r => r.date);
  const camps = [...(live('wbAds')?.campaigns || []), ...(live('ozonPerf')?.campaigns || [])];
  const names = { ...(oz?.names || {}), ...(wb?.names || {}) };

  // Ozon отдаёт выручку по дням, а выплату — только итогом за период. Доля выплаты берётся из финотчёта.
  let ozRatio = null;
  if (oz) {
    for (const mo of [today.slice(0, 7), prevStart.slice(0, 7)]) {
      const f = oz.finance?.find(x => x.month === mo);
      if (f && f.accruals > 0) { ozRatio = f.payout / f.accruals; break; }
    }
    if (ozRatio == null) { ozRatio = 0.65; notes.push('Ozon: нет финансового отчёта — выплаты оценены как 65% от выручки.'); }
    else notes.push(`Ozon: выплаты по дням и артикулам оценены по доле из финансового отчёта — ${r1(ozRatio * 100)}% от выручки.`);
  }
  const payoutOf = r => (r.payout != null ? r.payout : r.revenue * ozRatio);
  const cogsOf = r => (S.cogsByArticle?.[r.article] != null ? r.qty * S.cogsByArticle[r.article] : r.revenue * S.cogsPercent / 100);
  const monthExp = (Number(S.fixedMonthly) || 0) + sum(S.payments || [], p => p.amount);
  const adsIn = (a, b, mp) => sum(camps.filter(c => !mp || c.mp === mp).flatMap(c => c.daily || []).filter(d => inR(d.date, a, b)), d => d.spend);

  // Прибыль = выплаты МП − себестоимость − реклама − расходы (постоянные + платежи из графика, пропорционально дням).
  // Для канала (mp) — без постоянных расходов: маржинальный доход канала.
  function pnl(a, b, days, dimOf, mp) {
    const rows = sales.filter(r => inR(r.date, a, b) && (!mp || r.mp === mp));
    const revenue = sum(rows, r => r.revenue), payout = sum(rows, payoutOf), cogs = sum(rows, cogsOf), ads = adsIn(a, b, mp);
    const exp = mp ? 0 : monthExp * days / dimOf;
    const profit = payout - cogs - ads - exp;
    return { revenue, payout, cogs, ads, exp, profit, margin: revenue ? profit / revenue * 100 : 0 };
  }

  const out = {
    live: true, notes, demo: {}, generatedAt: new Date().toISOString(),
    owner: { name: S.ownerName }, team: S.team, decisionHour: Number(S.decisionHour) || 8,
    settings: { maxDrr: S.maxDrr, minDaysStock: S.minStockDays, monthPlan: S.monthPlan },
    kpi: {}
  };
  const demo = out.demo;
  for (const k of ['revenue', 'profit', 'margin', 'plan', 'channels', 'sales', 'stock', 'skus']) demo[k] = !hasMp;
  demo.cash = demo.forecast = !hasBank;
  demo.ads = !hasAds;
  demo.crm = false; // без CRM сделки ведутся вручную на дашборде — это не демо
  demo.docs = false; // документы приходят из источников и хранятся на сервере
  if (!crm) notes.push('CRM не подключена — сделки ведутся вручную на дашборде и хранятся на сервере.');
  demo.taxes = false;
  demo.receivables = demo.supplies = demo.traffic = true; // источников для них пока нет

  const days14 = Array.from({ length: 14 }, (_, i) => D(13 - i));

  if (hasMp) {
    const cur = pnl(monthStart, today, day, dim), prev = pnl(prevStart, prevEnd, prevDays, prevDim);
    const daily = days14.map(d => pnl(d, d, 1, dim));
    out.kpi.revenue = { v: r0(cur.revenue), d: change(cur.revenue, prev.revenue), spark: daily.map(x => r0(x.revenue)) };
    out.kpi.profit = { v: r0(cur.profit), d: change(cur.profit, prev.profit), spark: daily.map(x => r0(x.profit)) };
    out.kpi.margin = { v: r1(cur.margin), d: r1(cur.margin - prev.margin), unit: 'pp', spark: daily.map(x => r1(x.margin)) };
    out.pnl = { revenue: r0(cur.revenue), payout: r0(cur.payout), cogs: r0(cur.cogs), ads: r0(cur.ads), exp: r0(cur.exp), profit: r0(cur.profit) };
    out.plan = { fact: r0(cur.revenue), plan: Number(S.monthPlan) || 0, fc: r0(cur.revenue / day * dim), day, dim };
    if (!S.monthPlan) notes.push('План выручки не задан: впишите monthPlan в settings.json.');
    if (!hasAds) notes.push('Реклама не подключена — прибыль посчитана без расходов на рекламу.');
    else notes.push('Рекламные расходы загружаются за 30 дней — сравнение прибыли с прошлым месяцем приблизительное.');

    // Маржа и ДРР по каналам за 28 дней
    const ch = mps.map(mp => ({ mp, ...pnl(a28, today, 0, 1, mp) }));
    const tot = sum(ch, c => c.revenue);
    out.channels = ch.map(c => ({
      name: MP_NAME[c.mp], share: tot ? r0(c.revenue / tot * 100) : 0, margin: r1(c.margin),
      drr: c.revenue ? r1(c.ads / c.revenue * 100) : 0, color: COLORS[c.mp], estimated: c.mp === 'Ozon',
      adsLive: camps.some(x => x.mp === c.mp)
    }));

    // Продажи: заказы за 14 дней против предыдущих 14, средний чек, возвраты (WB)
    const p14a = D(27), p14b = D(14);
    const ord = (a, b) => (wb?.orders || []).filter(o => !o.cancel && inR(o.date, a, b)).length
      + sum((oz?.sales || []).filter(r => inR(r.date, a, b)), r => r.qty);
    const sold14 = sales.filter(r => inR(r.date, a14, today) && r.qty > 0);
    const wb28 = (wb?.sales || []).filter(r => inR(r.date, a28, today));
    const wbSold = sum(wb28.filter(r => r.qty > 0), r => r.qty), wbRet = -sum(wb28.filter(r => r.qty < 0), r => r.qty);
    out.sales = {
      orders: ord(a14, today), ordersDelta: change(ord(a14, today), ord(p14a, p14b)),
      avgCheck: sum(sold14, r => r.qty) ? r0(sum(sold14, r => r.revenue) / sum(sold14, r => r.qty)) : 0,
      returns: wb && wbSold ? r1(wbRet / wbSold * 100) : null,
      byDay: days14.map(d => r0(sum(sales.filter(r => r.date === d), r => r.revenue)))
    };

    // Артикулы за 28 дней: выручка, тренд 7/7, продано, остаток, реклама, себестоимость и комиссии (доли от выручки)
    const nm2art = {};
    for (const r of [...(wb?.sales || []), ...(wb?.stocks || [])]) if (r.nmId) nm2art[String(r.nmId)] = r.article;
    const key = (mp, a) => mp + '|' + a;
    const stockOf = {};
    for (const s of wb?.stocks || []) stockOf[key('WB', s.article)] = s;
    for (const s of oz?.stocks || []) stockOf[key('Ozon', s.article)] = s;
    const blank = (art, mp) => ({ art, ch: mp, rev: 0, payout: 0, cogs: 0, sold: 0, r7: 0, p7: 0 });
    const g = {};
    for (const r of sales.filter(r => inR(r.date, a28, today))) {
      const x = g[key(r.mp, r.article)] ??= blank(r.article, r.mp);
      x.rev += r.revenue; x.payout += payoutOf(r); x.cogs += cogsOf(r); x.sold += r.qty;
      if (r.date >= D(6)) x.r7 += r.revenue; else if (r.date >= D(13)) x.p7 += r.revenue;
    }
    for (const k in stockOf) { const [mp] = k.split('|'); g[k] ??= blank(stockOf[k].article, mp); }

    const adsBy = {};
    let adsSpread = false;
    for (const c of camps) {
      const spend = sum((c.daily || []).filter(d => inR(d.date, a28, today)), d => d.spend);
      if (!spend) continue;
      const arts = [...new Set((c.articles || []).map(a => (c.mp === 'WB' ? nm2art[a] : a)).filter(a => a && g[key(c.mp, a)]))];
      if (arts.length) { for (const a of arts) adsBy[key(c.mp, a)] = (adsBy[key(c.mp, a)] || 0) + spend / arts.length; continue; }
      const pool = Object.entries(g).filter(([, x]) => x.ch === c.mp && x.rev > 0), tr = sum(pool, ([, x]) => x.rev);
      if (!tr) continue;
      adsSpread = true;
      for (const [k, x] of pool) adsBy[k] = (adsBy[k] || 0) + spend * x.rev / tr;
    }
    if (adsSpread) notes.push('Реклама по артикулам частично распределена пропорционально выручке: у кампаний нет списка артикулов.');

    out.skus = Object.entries(g).map(([k, x]) => {
      const st = stockOf[k];
      return {
        art: x.art, name: names[x.art] || '', ch: x.ch, rev: r0(x.rev),
        trend: x.p7 ? r1((x.r7 - x.p7) / x.p7 * 100) : 0, sold: x.sold,
        stock: st?.qty ?? 0, inWay: st?.inWay ?? 0, ads: r0(adsBy[k] || 0),
        cogs: x.rev ? x.cogs / x.rev : 0, fees: x.rev ? 1 - x.payout / x.rev : 0, est: x.ch === 'Ozon'
      };
    }).sort((a, b) => b.rev - a.rev);
  }

  if (hasAds) {
    out.campaigns = camps.map(c => {
      const d7 = (c.daily || []).filter(d => d.date >= D(6));
      const s7 = sum(d7, d => d.spend), o7 = sum(d7, d => d.ordersSum);
      return {
        name: `${c.mp} · ${c.name}`, ch: c.mp, status: c.status, spend: r0(c.spend), rev: r0(c.ordersSum), orders: c.orders,
        drrWeek: o7 ? r1(s7 / o7 * 100) : s7 ? 999 : 0, ctr: c.views ? r1(c.clicks / c.views * 100) : 0, impr: c.views
      };
    }).sort((a, b) => b.spend - a.spend);
  }

  // Платежи из графика на 30 дней вперёд
  const ev = paymentDates(S.payments, daysAgo(-1, now), daysAgo(-30, now))
    .map(e => ({ ...e, i: Math.round((new Date(e.date + 'T00:00:00') - today0) / 864e5) }));
  out.cashEvents = ev.map(e => ({ i: e.i, name: e.name, amt: e.amt }));
  out.taxes = ev.map(e => ({ name: e.name, in: e.i, amount: e.amt }));
  if (!(S.payments || []).length) notes.push('График платежей пуст: впишите зарплату, налоги и взносы в settings.json (payments).');

  if (hasBank) {
    const accounts = banks.flatMap(b => b.accounts || []);
    const ops = banks.flatMap(b => b.ops || []).filter(o => o.date);
    const bal = sum(accounts, a => a.balance);
    const opsOn = d => sum(ops.filter(o => o.date === d), o => o.amount);
    // Остаток на конец каждого из 30 прошлых дней: идём от сегодняшнего остатка назад по выписке
    const hist = [bal];
    let b = bal;
    for (let k = 0; k < 30; k++) { b -= opsOn(D(k)); hist.unshift(b); }

    let base, sd;
    if (ops.length) {
      const net = Array.from({ length: 30 }, (_, k) => opsOn(D(k)));
      const paid = sum(paymentDates(S.payments, daysAgo(29, now), today0), e => e.amt);
      base = (sum(net) + paid) / 30; // средний дневной поток без платежей из графика — их добавляем по датам
      sd = stdev(net);
      notes.push('Прогноз денег: средний дневной поток по выписке за 30 дней (без платежей из графика) и платежи из settings.json по датам.');
    } else if (hasMp) {
      const p = pnl(a28, today, 0, 1);
      base = (p.payout - p.cogs - p.ads) / 28 - (Number(S.fixedMonthly) || 0) / 30;
      sd = stdev(days14.map(d => pnl(d, d, 0, 1).payout));
      notes.push('Выписки нет — прогноз денег по выплатам маркетплейсов за 28 дней, себестоимости и расходам.');
    } else {
      base = 0; sd = 0;
      notes.push('Нет выписки и маркетплейсов — прогноз денег учитывает только платежи из графика.');
    }
    const fc = [];
    for (let i = -10; i <= 0; i++) { const v = r0(hist[30 + i]); fc.push({ i, bal: v, lo: v, hi: v }); }
    let cur = bal;
    for (let i = 1; i <= 30; i++) {
      cur += base - sum(ev.filter(e => e.i === i), e => e.amt);
      const sp = sd * Math.sqrt(i);
      fc.push({ i, bal: r0(cur), lo: r0(cur - sp), hi: r0(cur + sp) });
    }
    out.forecast = fc;
    out.gap = fc.find(p => p.i > 0 && p.bal < 0) || null;
    out.accounts = accounts.map(a => ({ bank: a.bank, name: a.name, balance: r0(a.balance) }));
    out.kpi.cash = { v: r0(bal), d: change(bal, hist[0]), spark: hist.slice(17).map(r0) };
  }

  if (crm) out.crm = { stages: crm.stages.map(s => s.name), deals: crm.deals };
  return out;
}
