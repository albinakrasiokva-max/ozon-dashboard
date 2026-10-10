// Т-Банк Бизнес: остатки на счетах и выписка за 30 дней.
// https://developer.tbank.ru/docs/api — токен на чтение счетов и выписок.
// Поля операций разбираются с запасными вариантами — сверьте на реальном счёте.
import { request } from '../http.js';
import { isoDay, daysAgo, normDate } from '../db.js';

const BASE = 'https://business.tbank.ru/openapi';
export const enabled = () => !!process.env.TBANK_TOKEN;
const get = p => request(BASE + p, { source: 'Т-Банк', headers: { Authorization: 'Bearer ' + process.env.TBANK_TOKEN } });

export async function sync() {
  const list = await get('/api/v4/bank-accounts');
  const accounts = (Array.isArray(list) ? list : list?.accounts || [])
    .filter(a => !a.currency || a.currency === 'RUB' || a.currency === '643')
    .map(a => ({ bank: 'Т-Банк', id: a.accountNumber, name: a.name || a.accountNumber, balance: Number(a.balance?.otb ?? a.balance?.balance ?? a.balance) || 0 }));

  const ops = [];
  const from = isoDay(daysAgo(30)), to = isoDay(new Date());
  for (const a of accounts) {
    const r = await get(`/api/v1/statement?accountNumber=${encodeURIComponent(a.id)}&from=${from}&to=${to}`);
    for (const o of r?.operations || r?.items || []) {
      const amt = Math.abs(Number(o.operationAmount ?? o.accountAmount ?? o.amount) || 0);
      const out = /debit/i.test(o.typeOfOperation || o.direction || '') || o.isOutgoing === true;
      ops.push({
        date: normDate(o.operationDate || o.date || o.drawDate || o.chargeDate),
        amount: out ? -amt : amt,
        party: o.counterParty?.name || o.counterpartyName || o.payerName || o.recipientName || o.recipient || '',
        purpose: o.payPurpose || o.paymentPurpose || o.description || ''
      });
    }
  }
  return { accounts, ops };
}
