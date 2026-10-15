// Собирает OZON_PLAN из HTML «Плана магазина» (артефакт Claude): node scripts/planFromArtifact.mjs plan.html [--b64]
// Берутся разделы с чек-листом (input type=checkbox): название, пояснение, срок из названия или раздела.
import fs from 'node:fs';
import crypto from 'node:crypto';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const DATE = new RegExp(`(\\d{1,2})(?:[–-]\\d{1,2})?\\s+(${MONTHS.join('|')})`, 'i');
// Срок в названии задачи — только «17 октября: …», «~20 октября», «До 28 октября», «конец октября», а не «от 24 сентября»
const TITLE_DATE = new RegExp(`(?:^\\s*(?:до\\s+)?|~\\s*|\\sдо\\s+)(\\d{1,2})(?:[–-]\\d{1,2})?\\s+(${MONTHS.join('|')})`, 'i');
const END = new RegExp(`конец\\s+(${MONTHS.join('|')})`, 'i');
const text = h => h.replace(/<li[^>]*>/gi, ' • ').replace(/<span class="quote">/gi, ' «').replace(/<\/span>\s*<ol>/gi, '» ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();

export function planFromHtml(html) {
  const upd = html.match(/план обновл[её]н\s+(\d{1,2})\s+(\S+)\s+(\d{4})/i);
  const year = upd ? +upd[3] : new Date().getFullYear(), updMonth = upd ? MONTHS.indexOf(upd[2].toLowerCase()) : new Date().getMonth();
  const iso = m => { if (!m) return ''; const mon = MONTHS.indexOf(m[2].toLowerCase()); const y = mon < updMonth - 6 ? year + 1 : year; return `${y}-${String(mon + 1).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`; };
  const tasks = [];
  const sections = html.split(/<section[^>]*>/i).slice(1);
  sections.forEach((sec, si) => {
    if (!/type="checkbox"/i.test(sec)) return;
    const title = text(sec.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || '');
    const when = text(sec.match(/class="when[^"]*">([\s\S]*?)<\/span>/i)?.[1] || '');
    const key = /понедельник/i.test(title) ? 'monday' : /стратег/i.test(when) ? 'strategy' : 's' + si;
    const secDue = /^(до\s|\d)/i.test(when) ? iso(when.match(DATE)) : '';
    // Пункт — от <input type=checkbox> до </label> (внутри пояснения бывают вложенные списки)
    for (const [, id, li] of sec.matchAll(/type="checkbox"\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/label>/gi)) {
      const t = text(li.match(/class="t">([\s\S]*?)<\/span>/i)?.[1] || '');
      const why = li.match(/class="why">([\s\S]*)<\/span>\s*<\/span>\s*$/i)?.[1] || '';
      const end = t.match(END), endIso = end ? (() => { const m = MONTHS.indexOf(end[1].toLowerCase()); return iso([0, String(new Date(year, m + 1, 0).getDate()), end[1]]); })() : '';
      const due = key === 'monday' || key === 'strategy' ? '' : iso(t.match(TITLE_DATE)) || endIso || secDue || iso(title.match(TITLE_DATE));
      tasks.push({ id, section: key, sectionTitle: title + (when && !/стратег/i.test(when) ? ` · ${when}` : ''), due, title: t, note: text(why) });
    }
  });
  const updated = upd ? `${upd[1]} ${upd[2]} ${upd[3]}` : '';
  const version = crypto.createHash('sha1').update(JSON.stringify(tasks)).digest('hex').slice(0, 12);
  return { version, updated, tasks };
}

if (process.argv[1] && process.argv[1].endsWith('planFromArtifact.mjs')) {
  const plan = planFromHtml(fs.readFileSync(process.argv[2], 'utf8'));
  const json = JSON.stringify(plan);
  process.stdout.write(process.argv.includes('--b64') ? 'b64:' + Buffer.from(json).toString('base64') : json);
}
