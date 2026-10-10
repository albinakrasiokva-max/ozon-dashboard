// Центр решений: раз в день и по кнопке собирает полную картину и выдаёт решения на сегодня.
// С ключом Claude список составляет ИИ (строгая JSON-схема), без ключа — встроенные правила.
import crypto from 'node:crypto';
import { getDb, saveDb, isoDay, daysAgo } from './db.js';
import { aiEnabled, ask } from './ai.js';

export const DIRECTIONS = ['Реклама', 'Склад', 'Цены', 'Финансы', 'Продажи', 'CRM', 'Документы'];
const URGENCY = ['high', 'med', 'low'];
const ACTIVE = ['progress', 'postponed'];

const rub = n => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const mln = n => (Math.abs(n) >= 1e6 ? (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' млн ₽' : rub(n));
const pct = (n, d = 1) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: d }) + '%';
const dayRu = (n, now) => daysAgo(-n, now).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const newId = () => crypto.randomBytes(5).toString('hex');

// Артикул: прибыль, маржа, ДРР и дни остатка — те же формулы, что на дашборде
export function skuCalc(s) {
  const profit = s.rev * (1 - s.cogs - s.fees) - s.ads, daily = Math.max(0, s.sold) / 28;
  return { ...s, profit, margin: s.rev ? profit / s.rev * 100 : 0, drr: s.rev ? s.ads / s.rev * 100 : 0, daily, days: daily ? s.stock / daily : Infinity };
}

// ---------- Встроенные правила (без ключа Claude или если ИИ не ответил) ----------

export function ruleDecisions(dash, store, S, now = new Date()) {
  const out = [], live = b => dash.demo?.[b] === false, due = n => isoDay(daysAgo(-n, now));
  const skus = (dash.skus || []).map(skuCalc);

  if (live('forecast') && dash.gap) {
    const g = dash.gap, need = Math.abs(Math.min(...dash.forecast.filter(p => p.i > 0).map(p => p.bal)));
    const big = (dash.cashEvents || []).filter(e => e.i >= g.i - 3 && e.i <= g.i);
    out.push({
      key: 'cash-gap', dir: 'Финансы', urg: 'high', title: `Закрыть кассовый разрыв до ${dayRu(g.i, now)}`,
      sit: `По прогнозу ${dayRu(g.i, now)} на счетах не хватит денег: минимум −${mln(need)}.${big.length ? ' Крупные платежи рядом: ' + big.map(e => `${e.name} ${mln(e.amt)}`).join(', ') + '.' : ''}`,
      why: 'Разрыв приведёт к просрочке платежей. Перенести закупку или подключить овердрафт заранее дешевле, чем платить пени.',
      steps: ['Договориться с поставщиком о переносе части платежа на 7–10 дней', 'Подключить овердрафт в банке на сумму разрыва', 'Проверить удержания маркетплейсов и ускорить выплаты'],
      effect: 0, due: due(Math.max(1, g.i - 5)), conf: 80, // эффект — снижение риска, сумма разрыва уже в ситуации metric: 'Минимальный остаток на счетах за 30 дней ≥ 0 ₽'
    });
  }
  if (live('stock')) {
    for (const s of skus.filter(s => s.sold > 0 && s.days < S.minStockDays).sort((a, b) => a.days - b.days)) {
      const qty = Math.max(10, Math.round(s.daily * 45 / 10) * 10);
      out.push({
        key: `stock:${s.ch}:${s.art}`, dir: 'Склад', urg: s.days < 7 ? 'high' : 'med', title: `Дозаказать арт. ${s.art} — ${qty} шт.`,
        sit: `«${s.name || s.art}» (${s.ch}): остаток ${s.stock} шт., продаём ≈ ${s.daily.toFixed(1)} шт./день — хватит на ${Math.floor(s.days)} дн. при пороге ${S.minStockDays}. Выручка за 28 дней ${mln(s.rev)}, тренд за 7 дней ${s.trend > 0 ? '+' : ''}${pct(s.trend)}.`,
        why: 'Если товар закончится, потеряем продажи и позиции в выдаче. Партии хватит примерно на 45 дней продаж.',
        steps: [`Запросить у поставщика счёт на ${qty} шт.`, 'Согласовать оплату и дату отгрузки', 'Создать поставку на склад маркетплейса'],
        effect: Math.max(0, Math.round(s.profit)), due: due(3), conf: 75, metric: `Остаток арт. ${s.art} ≥ ${S.minStockDays} дней продаж`
      });
    }
  }
  if (live('ads')) {
    const camps = (dash.campaigns || []).map(c => ({ ...c, drr: c.rev ? c.spend / c.rev * 100 : c.spend ? 999 : 0 }));
    for (const c of camps.filter(c => c.drr > S.maxDrr).sort((a, b) => b.drr - a.drr)) {
      const stop = c.drr > 25;
      out.push({
        key: `ads:${c.name}`, dir: 'Реклама', urg: stop ? 'high' : 'med', title: `${stop ? 'Остановить' : 'Урезать'} кампанию «${c.name}»`,
        sit: `ДРР за месяц ${c.rev ? pct(c.drr) : 'без заказов'} при пороге ${S.maxDrr}%, за неделю ${pct(c.drrWeek)}. Расход ${mln(c.spend)}, заказов ${c.orders}${c.orders ? `, цена заказа ${rub(c.spend / c.orders)}` : ''}, CTR ${pct(c.ctr)}.`,
        why: 'Кампания тратит больше допустимой доли выручки. Бюджет лучше перенести в кампании с ДРР ниже порога.',
        steps: stop ? ['Поставить кампанию на паузу', 'Перенести бюджет в кампании с ДРР ниже порога', 'Через неделю сравнить заказы по артикулу'] : ['Снизить ставки на 30% и отключить слабые ключевые фразы', 'Через 3 дня проверить ДРР', 'Если ДРР не снизился — остановить кампанию'],
        effect: Math.round(c.rev ? c.spend * (1 - S.maxDrr / c.drr) : c.spend), due: due(2), conf: 70, metric: `ДРР кампании ≤ ${S.maxDrr}%`
      });
    }
  }
  if (live('skus')) {
    for (const s of skus.filter(s => s.rev > 0 && s.profit < 0)) {
      out.push({
        key: `price:${s.ch}:${s.art}`, dir: 'Цены', urg: 'high', title: `Поднять цену или убрать из рекламы арт. ${s.art}`,
        sit: `«${s.name || s.art}» продаётся в минус: прибыль ${rub(s.profit)} за 28 дней, маржа ${pct(s.margin)}. Себестоимость ${pct(s.cogs * 100, 0)}, комиссии и логистика ${pct(s.fees * 100, 0)}, реклама ${mln(s.ads)} (ДРР ${pct(s.drr)}).`,
        why: 'Каждая продажа этого артикула уменьшает общую прибыль.',
        steps: ['Пересчитать цену с учётом комиссий и рекламы', 'Поднять цену на 8–10% и отключить рекламу артикула', 'Через 2 недели проверить маржу'],
        effect: Math.round(-s.profit), due: due(5), conf: 65, metric: `Маржа арт. ${s.art} > 0%`
      });
    }
  }
  const P = dash.plan;
  if (live('plan') && P?.plan && P.fc < P.plan * 0.97) {
    out.push({
      key: 'plan', dir: 'Продажи', urg: 'med', title: 'Догнать план месяца',
      sit: `Факт ${mln(P.fact)} — ${pct(P.fact / P.plan * 100, 0)} плана. Прогноз на конец месяца ${mln(P.fc)}, не хватает ${mln(P.plan - P.fc)}.`,
      why: 'При текущем темпе план не выполнится. Быстрее всего помогают акция на ходовых артикулах и оплата выставленных счетов.',
      steps: ['Запустить акцию на 3 самых продаваемых артикула', 'Проверить остатки этих артикулов перед акцией', 'Дожать сделки на этапе выставленного счёта'],
      // эффект — прибыль с недостающей выручки при текущей марже
      effect: Math.max(0, Math.round((P.plan - P.fc) * (dash.kpi?.margin?.v || 0) / 100)), due: due(7), conf: 55, metric: 'Прогноз выручки на конец месяца ≥ плана'
    });
  }
  const toPay = (store.docs || []).filter(d => (d.needPay || d.type === 'Счёт') && d.status !== 'Обработан');
  if (toPay.length) {
    out.push({
      key: 'docs:pay', dir: 'Документы', urg: toPay.some(d => d.due && d.due <= due(2)) ? 'high' : 'med',
      title: `Оплатить счета: ${toPay.length} шт. на ${mln(toPay.reduce((a, d) => a + (d.sum || 0), 0))}`,
      sit: toPay.slice(0, 5).map(d => `${d.cp || d.name} — ${d.sum ? rub(d.sum) : 'сумма не указана'}${d.due ? `, срок ${d.due.split('-').reverse().join('.')}` : ''}`).join('; ') + '.',
      why: 'Просрочка по счетам портит отношения с поставщиками и может остановить поставки.',
      steps: [...toPay.slice(0, 4).map(d => `Оплатить: ${d.cp || d.name}${d.sum ? ' — ' + rub(d.sum) : ''}`), 'Отметить документы обработанными'].slice(0, 5),
      effect: 0, due: due(1), conf: 90, metric: 'Нет неоплаченных счетов с истёкшим сроком'
    });
  }
  const deals = dash.crm?.deals || store.deals || [];
  const stuck = deals.filter(d => /сч[её]т/i.test(d.stage || ''));
  if (stuck.length) {
    out.push({
      key: 'crm:invoiced', dir: 'CRM', urg: 'low', title: `Дожать оплату по сделкам со счётом: ${stuck.length}`,
      sit: stuck.slice(0, 5).map(d => `${d.client || d.title} — ${rub(d.sum)}`).join('; ') + '.',
      why: 'Сделка с выставленным счётом — самая близкая к деньгам.',
      steps: ['Позвонить клиентам и уточнить дату оплаты', 'Отправить напоминание со ссылкой на счёт'],
      effect: Math.round(stuck.reduce((a, d) => a + (d.sum || 0), 0)), due: due(2), conf: 60, metric: 'Сделки перешли в успешный этап'
    });
  }
  return out;
}

// ---------- Решения от Claude ----------

export const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['key', 'direction', 'urgency', 'title', 'situation', 'why', 'steps', 'effectRubPerMonth', 'dueDate', 'confidence', 'metric'],
        properties: {
          key: { type: 'string', description: 'Стабильный ключ темы решения, например stock:WB:BND-014 или ads:WB · Авто A1' },
          direction: { type: 'string', enum: DIRECTIONS },
          urgency: { type: 'string', enum: URGENCY, description: 'high — сегодня, med — на этой неделе, low — можно позже' },
          title: { type: 'string', description: 'Действие в повелительном наклонении: «Остановить кампанию X», «Дозаказать арт. Y 800 шт»' },
          situation: { type: 'string', description: 'Ситуация с конкретными цифрами из данных' },
          why: { type: 'string', description: 'Что сделать и почему' },
          steps: { type: 'array', items: { type: 'string' }, description: 'От 2 до 5 конкретных шагов' },
          effectRubPerMonth: { type: 'number', description: 'Оценка эффекта в рублях в месяц; 0, если эффект не денежный' },
          dueDate: { type: 'string', description: 'Срок, YYYY-MM-DD' },
          confidence: { type: 'integer', description: 'Уверенность, 0–100' },
          metric: { type: 'string', description: 'Метрика, по которой проверить результат' }
        }
      }
    }
  }
};

const SYSTEM = `Ты — операционный директор бизнеса, который продаёт на Wildberries и Ozon. Каждое утро ты готовишь для владельца список решений на сегодня.
Работай только с данными в сообщении. Каждая цифра в решении должна быть взята из данных или посчитана из них. Ничего не придумывай.
Если блока нет в данных (см. notConnected) — не делай выводов о нём.

Как составлять список:
- Не больше 8 решений, самые важные и денежные — первыми.
- Каждое решение — конкретное действие с цифрами: что сделать, почему, 2–5 шагов, эффект в ₽ в месяц, срок, уверенность, метрика проверки.
- Эффект оценивай консервативно и только по данным; если эффект не денежный (риск, документы) — ставь 0.
- Смотри на всё: артикулы (остатки, тренд, маржа, ДРР), рекламные кампании (ДРР за месяц и за неделю, CTR, цена заказа), деньги и кассовый прогноз, план, CRM, документы к оплате и подписи, открытые и просроченные задачи.
- Пороги владельца: settings.maxDrr — предельная ДРР, settings.minDaysStock — порог дозаказа в днях.
- decisionHistory — прошлые ответы владельца. Не повторяй решения, которые уже в работе или отложены (тот же key). Если владелец отклонил решение, учти причину: не предлагай то же самое снова, пока ситуация заметно не изменилась, и не противоречь его доводам.
- key — стабильный ключ темы: одно и то же решение в разные дни должно получать один и тот же key (например stock:<канал>:<артикул>, ads:<название кампании>, price:<канал>:<артикул>, cash-gap, plan).
- Сроки — от сегодняшней даты (today), в формате YYYY-MM-DD.
- Пиши по-русски, коротко, деньги — в рублях с пробелами между разрядами.`;

export function validateDecision(x, now = new Date()) {
  const steps = (Array.isArray(x.steps) ? x.steps : []).map(s => String(s).trim()).filter(Boolean).slice(0, 5);
  if (!x.title || steps.length < 2) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(x.dueDate || '') ? x.dueDate : isoDay(daysAgo(-3, now));
  return {
    key: String(x.key || x.title).slice(0, 120),
    dir: DIRECTIONS.includes(x.direction) ? x.direction : 'Финансы',
    urg: URGENCY.includes(x.urgency) ? x.urgency : 'med',
    title: String(x.title).slice(0, 200), sit: String(x.situation || ''), why: String(x.why || ''), steps,
    effect: Math.max(0, Math.round(Number(x.effectRubPerMonth) || 0)),
    due: date < isoDay(now) ? isoDay(now) : date,
    conf: Math.min(100, Math.max(0, Math.round(Number(x.confidence) || 0))),
    metric: String(x.metric || '')
  };
}

export async function aiDecisions(input, now = new Date()) {
  const text = await ask({
    max_tokens: 32000,
    system: SYSTEM,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    messages: [{ role: 'user', content: `Данные бизнеса на сегодня:\n<business_data>\n${JSON.stringify(input)}\n</business_data>\nСоставь список решений на сегодня.` }]
  }, { stream: true });
  return (JSON.parse(text).decisions || []).map(d => validateDecision(d, now)).filter(Boolean).slice(0, 8);
}

// Прошлые ответы владельца — ИИ учитывает их в следующий раз
export function decisionHistory(list) {
  return list.filter(d => d.status !== 'new').sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || ''))).slice(0, 30)
    .map(d => ({
      key: d.key, title: d.title, direction: d.dir, decidedAt: d.decidedAt,
      answer: { progress: 'принято, в работе', postponed: `отложено до ${d.until}`, done: 'принято и выполнено', rejected: 'отклонено' }[d.status],
      rejectReason: d.status === 'rejected' ? d.reason || 'без причины' : undefined
    }));
}

// ---------- Хранение и действия ----------

export function decisionsList() {
  const db = getDb();
  if (!Array.isArray(db.store.decisions)) db.store.decisions = []; // прежний формат (до этапа 4) не переносим
  return db.store.decisions;
}

// Отложенные возвращаются в «Новые», принятые закрываются, когда выполнены все их задачи
export function refreshStatuses(now = new Date()) {
  const list = decisionsList(), tasks = getDb().store.tasks || [], today = isoDay(now);
  let changed = false;
  for (const d of list) {
    if (d.status === 'postponed' && d.until && d.until <= today) { d.status = 'new'; delete d.until; changed = true; }
    if (d.status === 'progress') {
      const ts = tasks.filter(t => t.decision === d.id);
      if (ts.length && ts.every(t => t.status === 'done')) { d.status = 'done'; d.decidedAt = new Date().toISOString(); changed = true; }
    }
  }
  if (changed) saveDb();
  return list;
}

function merge(generated, source, now) {
  const db = getDb(), list = decisionsList(), at = new Date().toISOString();
  const recent = (d, days) => d.decidedAt && d.decidedAt >= daysAgo(days, now).toISOString();
  // Темы, которые сейчас не предлагаем: в работе, отложены, недавно отклонены или выполнены
  const blocked = new Set(list.filter(d => ACTIVE.includes(d.status) || (d.status === 'rejected' && recent(d, 14)) || (d.status === 'done' && recent(d, 7))).map(d => d.key));
  const oldNew = new Map(list.filter(d => d.status === 'new').map(d => [d.key, d]));
  const seen = new Set();
  const fresh = generated.filter(g => !blocked.has(g.key) && !seen.has(g.key) && seen.add(g.key))
    .map(g => ({ ...g, id: oldNew.get(g.key)?.id || newId(), status: 'new', source, createdAt: oldNew.get(g.key)?.createdAt || at, updatedAt: at }));
  db.store.decisions = [...list.filter(d => d.status !== 'new'), ...fresh];
  return fresh;
}

let running = null;
export const isRunning = () => !!running;

// build() → {dash, store, sources, snapshot} — собирается в server.js, чтобы не тянуть сюда весь сервер
export function runDecisions(build, { now = new Date(), reason = 'manual' } = {}) {
  if (running) return running;
  running = (async () => {
    const db = getDb(), S = build.settings();
    refreshStatuses(now);
    const { dash, store, input } = build.data();
    const run = { at: new Date().toISOString(), reason, source: 'rules', error: null };
    let generated;
    if (aiEnabled()) {
      try {
        generated = await aiDecisions({ ...input, decisionHistory: decisionHistory(decisionsList()) }, now);
        run.source = 'ai';
      } catch (e) {
        run.error = `ИИ не ответил (${e.message}) — список составлен встроенными правилами.`;
      }
    }
    generated ??= ruleDecisions(dash, store, S, now);
    run.count = merge(generated, run.source, now).length;
    db.state.decisionsRun = run;
    saveDb();
    return run;
  })().finally(() => { running = null; });
  return running;
}

// Утренний пересчёт: один раз в день, в час из settings.json (decisionHour)
export function maybeDailyRun(build, now = new Date()) {
  const db = getDb(), S = build.settings(), today = isoDay(now);
  if (now.getHours() < (Number(S.decisionHour) || 8)) return null;
  if (db.state.decisionsDaily === today) return null;
  db.state.decisionsDaily = today;
  saveDb();
  return runDecisions(build, { now, reason: 'daily' });
}

function assignee(S, dir) {
  return S.assignees?.[dir] || S.team?.[0] || 'Владелец';
}

export function act(id, action, body, S, now = new Date()) {
  const db = getDb(), list = refreshStatuses(now), d = list.find(x => x.id === id);
  if (!d) throw Object.assign(new Error('Решение не найдено'), { status: 404 });
  const at = new Date().toISOString();
  if (action === 'accept') {
    if (!['new', 'postponed'].includes(d.status)) throw Object.assign(new Error('Решение уже принято или закрыто'), { status: 409 });
    const tasks = Array.isArray(db.store.tasks) ? db.store.tasks : (db.store.tasks = []);
    const prio = { high: 'high', med: 'med', low: 'low' }[d.urg] || 'med';
    d.taskIds = d.steps.map((step, i) => {
      const t = { id: newId(), title: step, desc: `${d.title}. Шаг ${i + 1} из ${d.steps.length}.`, status: 'todo', prio, due: d.due, who: assignee(S, d.dir), ai: d.source === 'ai', doc: '', decision: d.id };
      tasks.push(t);
      return t.id;
    });
    Object.assign(d, { status: 'progress', decidedAt: at });
    delete d.until;
  } else if (action === 'postpone') {
    Object.assign(d, { status: 'postponed', until: isoDay(daysAgo(-3, now)), decidedAt: at });
  } else if (action === 'reject') {
    Object.assign(d, { status: 'rejected', reason: String(body.reason || '').slice(0, 500), decidedAt: at });
  } else if (action === 'restore') {
    Object.assign(d, { status: 'new', decidedAt: at });
    delete d.until; delete d.reason;
  } else throw Object.assign(new Error('Неизвестное действие'), { status: 400 });
  saveDb();
  return d;
}
