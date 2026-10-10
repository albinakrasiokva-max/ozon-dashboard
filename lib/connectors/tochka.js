// Банк Точка: остатки на счетах и выписка за 30 дней.
// https://enter.tochka.com/doc — JWT-токен. Выписка формируется асинхронно: запрос → ожидание → чтение.
// Коннектор написан по документации, на реальном счёте не проверен.
import { request, sleep } from '../http.js';
import { daysAgo, normDate } from '../db.js';

const BASE = 'https://enter.tochka.com/uapi/open-banking/v1.0';
export const enabled = () => !!process.env.TOCHKA_TOKEN;
const req = (p, o = {}) => request(BASE + p, { ...o, source: 'Точка', headers: { Authorization: 'Bearer ' + process.env.TOCHKA_TOKEN } });

export async function sync() {
  const r = await req('/balances');
  const byAcc = {};
  for (const b of r?.Data?.Balance || []) {
    const cur = byAcc[b.accountId];
    // предпочитаем доступный остаток на конец дня
    if (!cur || b.type === 'ClosingAvailable') byAcc[b.accountId] = b;
  }
  const accounts = Object.values(byAcc)
    .filter(b => !b.Amount?.currency || b.Amount.currency === 'RUB')
    .map(b => ({ bank: 'Точка', id: b.accountId, name: b.accountId, balance: Number(b.Amount?.amount) || 0 }));

  const ops = [];
  for (const a of accounts) {
    try {
      const init = await req('/statements', { method: 'POST', body: { Data: { Statement: { accountId: a.id, startDateTime: daysAgo(30).toISOString().slice(0, 10), endDateTime: new Date().toISOString().slice(0, 10) } } } });
      const sid = init?.Data?.Statement?.statementId;
      if (!sid) continue;
      for (let i = 0; i < 6; i++) {
        await sleep(3000);
        const s = await req(`/accounts/${encodeURIComponent(a.id)}/statements/${encodeURIComponent(sid)}`);
        const st = s?.Data?.Statement?.[0];
        if (st?.status !== 'Ready') continue;
        for (const t of st.Transaction || []) {
          const amt = Math.abs(Number(t.Amount?.amount) || 0), out = t.creditDebitIndicator === 'Debit';
          ops.push({
            date: normDate(t.documentProcessDate || t.bookingDateTime),
            amount: out ? -amt : amt,
            party: (out ? t.CreditorParty?.name : t.DebtorParty?.name) || '',
            purpose: t.description || ''
          });
        }
        break;
      }
    } catch (e) {
      // Остатки уже есть — без выписки прогноз просто будет без истории
      console.error('[sync] Точка, выписка:', e.message);
    }
  }
  return { accounts, ops };
}
