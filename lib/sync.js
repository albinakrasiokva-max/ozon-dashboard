// Реестр источников и синхронизация: по расписанию и по кнопке «Обновить».
import { getDb, saveDb } from './db.js';
import * as wb from './connectors/wb.js';
import * as wbAds from './connectors/wbAds.js';
import * as ozon from './connectors/ozon.js';
import * as ozonPerf from './connectors/ozonPerf.js';
import * as amocrm from './connectors/amocrm.js';
import * as bitrix from './connectors/bitrix.js';
import * as tbank from './connectors/tbank.js';
import * as tochka from './connectors/tochka.js';

export const SOURCES = [
  { key: 'wb', name: 'Wildberries', env: ['WB_TOKEN'], mod: wb },
  { key: 'wbAds', name: 'Реклама WB', env: ['WB_TOKEN'], mod: wbAds },
  { key: 'ozon', name: 'Ozon Seller', env: ['OZON_CLIENT_ID', 'OZON_API_KEY'], mod: ozon },
  { key: 'ozonPerf', name: 'Ozon Performance', env: ['OZON_PERF_CLIENT_ID', 'OZON_PERF_CLIENT_SECRET'], mod: ozonPerf },
  { key: 'amocrm', name: 'amoCRM', env: ['AMO_SUBDOMAIN', 'AMO_TOKEN'], mod: amocrm },
  { key: 'bitrix', name: 'Битрикс24', env: ['BITRIX_WEBHOOK_URL'], mod: bitrix },
  { key: 'tbank', name: 'Т-Банк Бизнес', env: ['TBANK_TOKEN'], mod: tbank },
  { key: 'tochka', name: 'Точка', env: ['TOCHKA_TOKEN'], mod: tochka }
];

export const enabledKeys = () => SOURCES.filter(s => s.mod.enabled()).map(s => s.key);

// Если подключены обе CRM, используется amoCRM.
export function crmSource() {
  const k = enabledKeys();
  return k.includes('amocrm') ? SOURCES.find(s => s.key === 'amocrm') : k.includes('bitrix') ? SOURCES.find(s => s.key === 'bitrix') : null;
}

let running = null;
export const isSyncing = () => !!running;

export function syncAll() {
  if (running) return running;
  running = (async () => {
    const db = getDb();
    await Promise.all(SOURCES.filter(s => s.mod.enabled()).map(async s => {
      const t0 = Date.now();
      try {
        db.raw[s.key] = await s.mod.sync();
        db.status[s.key] = { ok: true, error: null, at: new Date().toISOString(), lastOkAt: new Date().toISOString(), ms: Date.now() - t0 };
      } catch (e) {
        // Прошлые настоящие данные остаются, но источник помечается ошибкой
        db.status[s.key] = { ...(db.status[s.key] || {}), ok: false, error: e.message, at: new Date().toISOString() };
        console.error(`[sync] ${s.name}: ${e.message}`);
      }
    }));
    db.lastSync = new Date().toISOString();
    saveDb();
  })().finally(() => { running = null; });
  return running;
}

export function sourceStatus() {
  const db = getDb(), crm = crmSource();
  return SOURCES.map(s => {
    const on = s.mod.enabled(), st = db.status[s.key] || {};
    const missing = s.env.filter(k => !process.env[k]);
    let error = on ? st.error || null : null;
    if (!on && missing.length < s.env.length) error = `Не хватает переменной ${missing.join(', ')} в .env`;
    if (on && s.key === 'bitrix' && crm?.key === 'amocrm') error = 'Подключены обе CRM — используется amoCRM. Уберите лишний ключ из .env.';
    return { key: s.key, name: s.name, enabled: on, ok: on && st.ok === true, error, at: st.at || null, lastOkAt: st.lastOkAt || null, hasData: !!db.raw[s.key] };
  });
}

let timer = null;
export function startScheduler(minutes) {
  clearInterval(timer);
  const m = Math.max(5, Number(minutes) || 30);
  timer = setInterval(() => syncAll().catch(() => {}), m * 60000);
  timer.unref?.();
  return m;
}
