// Бизнес-цифры, которых нет в API. Файл settings.json читается при каждом расчёте —
// после правки перезапуск не нужен.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  ownerName: 'Владелец',
  team: ['Владелец'],
  monthPlan: 0,
  cogsPercent: 40,
  cogsByArticle: {},
  fixedMonthly: 0,
  payments: [],
  maxDrr: 15,
  minStockDays: 14,
  syncMinutes: 30,
  decisionHour: 8,
  company: { name: '', inn: '' },
  assignees: {},
  payWithinDays: 3
};

export function getSettings() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(path.resolve(process.env.SETTINGS_FILE || 'settings.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('settings.json: ошибка в файле —', e.message);
  }
  for (const k of Object.keys(s)) if (k.startsWith('_')) delete s[k];
  return { ...DEFAULTS, ...s };
}
