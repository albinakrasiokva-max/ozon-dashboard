// Сводка вкладки «План и рекомендации» для Telegram: те же окна (7 дней, недели), правила и пороги,
// что на странице. Себестоимость, налог и пороги страница присылает на сервер (store.ozonConfig).
import { getDb } from './db.js';

const FEES = ['commission', 'acquiring', 'logistics', 'storage', 'penalties', 'other'];
const GOALS = { drr: 8, campBad: 12, campGood: 6 };
const ok = v => typeof v === 'number' && isFinite(v);
const sum = (a, f = x => x) => a.reduce((s, x) => s + (+f(x) || 0), 0);
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
export const rub = v => `${v < 0 ? '−' : ''}${nf.format(Math.abs(Math.round(v)))} ₽`;
const pct = v => v == null ? '—' : v === Infinity ? 'без продаж' : nf1.format(v * 100) + '%';
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ru = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '';
const short = (s, n = 45) => { s = String(s || '').split('/')[0].trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const mskToday = (now = new Date()) => new Date(now.getTime() + 3 * 3600e3).toISOString().slice(0, 10);

export const config = () => getDb().store.ozonConfig || {};

/** Расчёт окна по SKU: выручка как в документах, удержания (комиссия за вычетом баллов), реклама, налог, себестоимость. */
export function windowCalc(w, perfAds, cfg = config(), names = {}) {
  const acc = w?.accruals?.data;
  if (!acc) return null;
  const camps = perfAds?.data?.campaigns || null;
  const costs = cfg.costs || {}, tax = ok(cfg.tax) ? cfg.tax / 100 : 0;
  const items = Object.values(acc.items || {});
  const netOf = it => Math.max(0, it.sold.soldAmt - it.sold.retAmt);
  const totalNet = sum(items, netOf);
  const sharedIncome = (acc.income?.compensation || 0) + (acc.income?.buyout || 0);
  const sharedAds = (acc.adsSub || 0) + (camps ? sum(camps.filter(c => !c.sku), c => c.spend) : sum(Object.values(acc.adsByCamp || {})) + (acc.adsOther || 0));
  const direct = {};
  if (camps) for (const c of camps) if (c.sku) direct[c.sku] = (direct[c.sku] || 0) + c.spend;
  const rows = items.map(it => {
    const share = totalNet > 0 ? netOf(it) / totalNet : 0;
    const income = it.sold.soldAmt - it.sold.retAmt + (it.comp || 0) + sharedIncome * share;
    const qty = it.sold.soldQty - it.sold.retQty;
    const fees = sum(FEES, k => (it.fees[k] || 0) + (acc.unassigned?.[k] || 0) * share) - (it.sold.soldLoyal - it.sold.retLoyal);
    const ads = (direct[it.sku] || 0) + sharedAds * share + (camps ? 0 : it.fees.ads || 0);
    const cost = ok(costs[it.sku]) ? costs[it.sku] : null;
    const taxV = Math.max(0, income) * tax;
    const sold = it.sold.soldQty > 0;
    const profit = sold && cost != null ? income - fees - ads - taxV - cost * qty : null;
    const name = it.name || names[it.article] || (it.article ? 'арт. ' + it.article : 'SKU ' + it.sku);
    const parts = [['логистика', it.fees.logistics], ['реклама', ads], ['хранение', it.fees.storage]].filter(p => p[1] > 0.5).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const main = parts.map(([n, v]) => income > 0 ? `${n} ${nf.format(v / income * 100)}%` : `${n} ${rub(v)}`).join(', ');
    return { sku: it.sku, name, income, qty, fees, ads, profit, ppu: profit != null && qty > 0 ? profit / qty : null, price: it.sold.soldQty ? (it.sold.soldAmt + (it.comp || 0)) / it.sold.soldQty : null, sold, cost, main, loss: sold ? 0 : Math.max(0, fees + ads) };
  });
  const known = rows.filter(r => r.profit != null), dead = rows.filter(r => !r.sold && r.loss > 50);
  return {
    w, rows, dead, income: sum(rows, r => r.income), qty: sum(rows, r => r.qty),
    profit: sum(known, r => r.profit) - sum(dead, r => r.loss), partial: rows.filter(r => r.sold && r.cost == null).length, taxSet: ok(cfg.tax)
  };
}

function campStats(c, w) {
  const r = { spend: 0, sales: 0, orders: 0, views: 0 };
  if (w) for (const d of c.daily || []) if (d.date >= w.from && d.date <= w.to) { r.spend += +d.spend || 0; r.sales += +d.ordersSum || 0; r.orders += +d.orders || 0; r.views += +d.views || 0; }
  r.drr = r.sales > 0 ? r.spend / r.sales : r.spend > 0 ? Infinity : null;
  return r;
}
export function campVerdict(s, status, G) {
  const a = s.d7, bad = G.campBad / 100, good = G.campGood / 100;
  if (status !== 'active') return ['gray', 'на паузе'];
  if (a.views === 0) return ['warn', '0 показов за 7 дней — проверьте, добавлен ли товар и не на модерации ли он'];
  if (a.spend >= 300 && a.orders === 0) return ['neg', `расход ${rub(a.spend)} за 7 дней без заказов — снизить ставку или выключить`];
  if (s.w0.spend > 0 && s.w1.spend > 0 && s.w0.drr > bad && s.w1.drr > bad) return ['neg', `ДРР выше ${G.campBad}% две недели подряд — снизить ставку или выключить`];
  if (a.drr != null && a.drr <= good && a.orders >= 3) return ['pos', `ДРР ${pct(a.drr)} — кандидат на больший бюджет`];
  if (a.drr != null && a.drr > bad) return ['warn', `ДРР ${pct(a.drr)} выше ${G.campBad}% — если и следующая неделя выше, снижайте ставку`];
  return ['gray', a.spend ? 'в норме' : 'нет расхода'];
}

/** Всё для сводки: окна, расчёты, кампании, поставки, задачи. null — данных за окна ещё нет. */
export function planData(db = getDb()) {
  const cfg = config(), G = { ...GOALS, ...(cfg.goals || {}) };
  const wins = db.raw.ozon?.windows;
  if (!wins?.length) return null;
  const perfWin = db.raw.ozonPerf?.windows || [], names = db.raw.ozon?.names || {};
  const calc = Object.fromEntries(wins.map(w => [w.key, windowCalc(w, perfWin.find(x => x.key === w.key)?.ads, cfg, names)]));
  const W = Object.fromEntries(wins.map(w => [w.key, w]));
  const camps = (db.raw.ozonPerf?.campaigns || []).map(c => {
    const s = { d7: campStats(c, W.d7), p7: campStats(c, W.p7), w0: campStats(c, W.w0), w1: campStats(c, W.w1) };
    return { name: c.name, status: c.status, s, verdict: campVerdict(s, c.status, G) };
  });
  const tot = k => { const t = { spend: sum(camps, c => c.s[k].spend), sales: sum(camps, c => c.s[k].sales) }; t.drr = t.sales > 0 ? t.spend / t.sales : null; return t; };
  // Поставки: остаток меньше stockWarn дней — заказать на supplyDays, кратно партии
  const stock = (db.raw.ozon?.reports || []).find(d => d.type === 'stock');
  const supply = [];
  for (const it of Object.values(stock?.data?.items || {})) {
    const vel = it.avgDaily; if (!(vel > 0)) continue;
    const days = Math.floor(it.available / vel);
    if (days >= (cfg.stockWarn || 14)) continue;
    const need = Math.max(0, Math.ceil(vel * (cfg.supplyDays || 30) - it.available - it.inbound)); if (!need) continue;
    const lot = Math.ceil(cfg.minLot ?? 300) || 0, qty = lot > 0 ? Math.ceil(need / lot) * lot : need;
    supply.push({ name: names[it.article] || it.name || 'арт. ' + it.article, days, qty });
  }
  return { cfg, G, W, calc, camps, tot, supply: supply.sort((a, b) => a.days - b.days), tasks: Array.isArray(db.store.plan) ? db.store.plan : [] };
}

const mondayOf = iso => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
const link = () => process.env.RAILWAY_PUBLIC_DOMAIN ? `\nПодробно: https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '';
const change = (a, b) => b > 0 ? ` (${a >= b ? '+' : '−'}${nf.format(Math.abs(a / b - 1) * 100)}% к прошлым 7 дням)` : '';

/** Ежедневная сводка: 7 дней против 7 дней до них и что сделать сегодня. */
export function dailyDigest(db = getDb()) {
  const P = planData(db);
  if (!P) return 'Данных за последние 7 дней пока нет — они появятся после ближайшей синхронизации.';
  const a = P.calc.d7, b = P.calc.p7, t7 = P.tot('d7');
  if (!a) return 'За последние 7 дней нет начислений Ozon.';
  const L = [`<b>Ozon · сводка за 7 дней</b> (${ru(a.w.from)}–${ru(a.w.to)})`,
    `Выручка: ${rub(a.income)}${b ? change(a.income, b.income) : ''}`,
    `Продано: ${nf.format(a.qty)} шт`,
    `Прибыль${a.taxSet ? ' после налога' : ''}: <b>${rub(a.profit)}</b>${a.partial ? ` (без себестоимости: ${a.partial} тов.)` : ''}`];
  if (P.camps.length) L.push(`ДРР рекламы: ${pct(t7.drr)} (цель ≤${P.G.drr}%)`);
  const R = [];
  for (const r of a.rows.filter(r => r.ppu != null && r.ppu < 0 && r.qty >= 2).sort((x, y) => x.profit - y.profit))
    R.push(`🔴 <b>${esc(short(r.name))}</b> в минусе: ${rub(r.ppu)} с продажи, ${rub(r.profit)} за 7 дней. Главное: ${r.main || '—'}`);
  for (const c of P.camps.filter(c => c.verdict[0] === 'neg')) R.push(`🔴 Реклама «${esc(c.name)}»: ${c.verdict[1]}`);
  for (const s of P.supply) R.push(`🔴 <b>${esc(short(s.name))}</b>: остатка на ${s.days} дн. — поставить ${nf.format(s.qty)} шт`);
  if (a.income > 0 && a.profit <= 0) R.push(`🔴 За 7 дней магазин ${a.profit < 0 ? 'в минусе' : 'в нуле'}: ${rub(a.profit)}`);
  for (const r of a.dead.sort((x, y) => y.loss - x.loss).slice(0, 5)) R.push(`🟠 <b>${esc(short(r.name))}</b>: ${rub(r.loss)} расходов без продаж — вывезти или утилизировать`);
  for (const c of P.camps.filter(c => c.verdict[0] === 'warn')) R.push(`🟠 Реклама «${esc(c.name)}»: ${c.verdict[1]}`);
  if (t7.drr != null && t7.drr > P.G.drr / 100) R.push(`🟠 ДРР всей рекламы ${pct(t7.drr)} — выше цели ${P.G.drr}%`);
  for (const c of P.camps.filter(c => c.verdict[0] === 'pos')) R.push(`🟢 Реклама «${esc(c.name)}»: ${c.verdict[1]}`);
  L.push('', '<b>Что сделать сегодня</b>', ...(R.length ? R : ['✅ Всё по плану: товаров в минусе, неликвида и проблемных кампаний нет.']));
  const today = mskToday(), tomorrow = new Date(Date.parse(today) + 864e5).toISOString().slice(0, 10);
  const open = P.tasks.filter(t => t.section !== 'monday' && !t.done && t.due);
  const late = open.filter(t => t.due < today), soon = open.filter(t => t.due >= today && t.due <= tomorrow);
  if (late.length || soon.length) L.push('', '<b>Задачи</b>', ...late.map(t => `⏰ просрочено (${ru(t.due)}): ${esc(t.title)}`), ...soon.map(t => `📌 до ${ru(t.due)}: ${esc(t.title)}`));
  return (L.join('\n') + link()).slice(0, 4000);
}

/** Еженедельный отчёт: прошлая неделя пн–вс против позапрошлой, кампании, задачи на понедельник. */
export function weeklyDigest(db = getDb()) {
  const P = planData(db);
  if (!P?.calc.w0) return 'Данных за прошлую неделю пока нет.';
  const a = P.calc.w0, b = P.calc.w1, t0 = P.tot('w0'), t1 = P.tot('w1');
  const was = (v, fmt) => b ? ` (было ${fmt(v)})` : '';
  const L = [`<b>Ozon · итоги недели</b> ${ru(a.w.from)}–${ru(a.w.to)}`,
    `Выручка: <b>${rub(a.income)}</b>${was(b?.income, rub)}`,
    `Продано: ${nf.format(a.qty)} шт${was(b?.qty, v => nf.format(v) + ' шт')}`,
    `Прибыль${a.taxSet ? ' после налога' : ''}: <b>${rub(a.profit)}</b>${was(b?.profit, rub)}`];
  if (P.camps.length) L.push(`Реклама: расход ${rub(t0.spend)}, ДРР ${pct(t0.drr)} (было ${pct(t1.drr)})`);
  const active = P.camps.filter(c => c.s.w0.spend > 0 || c.status === 'active').sort((x, y) => y.s.w0.spend - x.s.w0.spend);
  if (active.length) L.push('', '<b>Кампании</b> (ДРР прошлая / позапрошлая неделя)',
    ...active.map(c => `${{ neg: '🔴', warn: '🟠', pos: '🟢', gray: '⚪️' }[c.verdict[0]]} ${esc(c.name)}: ${pct(c.s.w0.drr)} / ${pct(c.s.w1.drr)} — ${c.verdict[1]}`));
  if (b) {
    const prev = Object.fromEntries(b.rows.map(r => [r.sku, r]));
    const ch = a.rows.filter(r => r.profit != null && prev[r.sku]?.profit != null).map(r => ({ r, d: r.profit - prev[r.sku].profit })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 3);
    if (ch.length) L.push('', '<b>Сильнее всего изменилась прибыль</b>', ...ch.map(x => `${x.d >= 0 ? '⬆️' : '⬇️'} ${esc(short(x.r.name))}: ${x.d >= 0 ? '+' : '−'}${rub(Math.abs(x.d))}`));
  }
  const mon = mondayOf(mskToday());
  const monday = P.tasks.filter(t => t.section === 'monday' && !(t.doneAt && t.doneAt >= mon));
  if (monday.length) L.push('', '<b>Каждый понедельник</b>', ...monday.map(t => `☐ ${esc(t.title)}`));
  return (L.join('\n') + link()).slice(0, 4000);
}

/** Пора ли слать утреннюю сводку (и по понедельникам — недельный отчёт). Вызывается раз в минуту. */
export function dueDigests(db = getDb(), now = new Date()) {
  const hour = Number(process.env.TELEGRAM_DIGEST_HOUR ?? 9);
  const msk = new Date(now.getTime() + 3 * 3600e3), today = msk.toISOString().slice(0, 10);
  if (msk.getUTCHours() < hour || db.state.digestDay === today) return [];
  const d7 = db.raw.ozon?.windows?.find(w => w.key === 'd7');
  const yesterday = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
  if (!d7 || d7.to !== yesterday) return [];   // ждём синхронизацию с данными по вчерашний день
  db.state.digestDay = today;
  return msk.getUTCDay() === 1 ? [dailyDigest(db), weeklyDigest(db)] : [dailyDigest(db)];
}
