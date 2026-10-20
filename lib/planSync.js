// Задачи «Плана магазина» (артефакт в Claude) → чек-лист вкладки «План и рекомендации».
// План приходит в переменной OZON_PLAN (JSON, можно с префиксом b64:), собранной scripts/planFromArtifact.mjs.
// Большой план можно разрезать на части: OZON_PLAN, OZON_PLAN_2, OZON_PLAN_3… — они склеиваются по порядку.
// При новой версии плана задачи обновляются: новые добавляются, исчезнувшие из плана удаляются
// (кроме добавленных вручную в дашборде — id с «u»), отметки «выполнено» сохраняются для тех же задач.
import { getDb, saveDb } from './db.js';

export function planEnv(env = process.env) {
  let raw = env.OZON_PLAN || '';
  for (let i = 2; env[`OZON_PLAN_${i}`]; i++) raw += env[`OZON_PLAN_${i}`];
  return raw;
}

export function readPlan(raw = planEnv()) {
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw.startsWith('b64:') ? Buffer.from(raw.slice(4), 'base64').toString('utf8') : raw);
    return Array.isArray(plan?.tasks) ? plan : null;
  } catch (e) { console.error('[plan] OZON_PLAN не читается:', e.message); return null; }
}

const head = s => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/g, ' ').trim().slice(0, 30);

export function applyPlan(db = getDb(), plan = readPlan()) {
  if (!plan || db.state.planVersion === plan.version) return false;
  const list = Array.isArray(db.store.plan) ? db.store.plan : [];
  const byId = new Map(list.map(t => [t.id, t]));
  const next = plan.tasks.map((t, i) => {
    const old = byId.get(t.id), same = old && head(old.title) === head(t.title);   // та же задача — отметка остаётся
    return { id: String(t.id), section: t.section, sectionTitle: t.sectionTitle || '', due: t.due || '', title: t.title, note: t.note || '', order: i,
      done: same ? !!old.done : false, doneAt: same ? old.doneAt || '' : '' };
  });
  db.store.plan = [...next, ...list.filter(t => String(t.id).startsWith('u'))];
  db.state.planVersion = plan.version;
  saveDb();
  console.log(`[plan] план магазина от ${plan.updated || '—'}: задач ${next.length}`);
  return true;
}
