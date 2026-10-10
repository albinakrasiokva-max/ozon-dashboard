// Claude API: распознавание документов в строгий JSON и чат по данным бизнеса.
// Официальный SDK @anthropic-ai/sdk, ключ — ANTHROPIC_API_KEY в .env.
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from './db.js';

export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-opus-5-5';

let client = null;
const getClient = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 180000, maxRetries: 2 }));

function humanAiError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API: ключ не принят (401). Проверьте ANTHROPIC_API_KEY в .env.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'Claude API: нет доступа (403). Проверьте ключ и настройки организации.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude API: превышен лимит запросов (429). Повторим позже.';
  if (e instanceof Anthropic.BadRequestError) return `Claude API: запрос отклонён (400): ${String(e.message).slice(0, 200)}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Claude API: нет соединения. Проверьте интернет на сервере.';
  if (e instanceof Anthropic.APIError) return `Claude API: ошибка ${e.status ?? ''}. Повторим позже.`;
  return 'Claude API: ' + e.message;
}

function setStatus(ok, error) {
  const db = getDb(), now = new Date().toISOString();
  db.status.ai = ok ? { ok: true, error: null, at: now, lastOkAt: now } : { ...(db.status.ai || {}), ok: false, error, at: now };
}

// Один запрос к Claude. Если модель откажется по соображениям безопасности, сервер сам повторит
// запрос на рекомендованной модели (fallbacks: "default").
async function ask(params) {
  let res;
  try {
    res = await getClient().beta.messages.create({
      model: MODEL(),
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      ...params
    });
  } catch (e) {
    const msg = humanAiError(e);
    setStatus(false, msg);
    throw new Error(msg);
  }
  setStatus(true);
  if (res.stop_reason === 'refusal') throw new Error('Claude отказался обрабатывать этот запрос.');
  if (res.stop_reason === 'max_tokens') throw new Error('Ответ Claude не поместился в лимит — документ слишком большой.');
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ---------- Распознавание документов ----------

export const DOC_TYPES = ['Счёт', 'Акт', 'УПД', 'Счёт-фактура', 'Договор', 'Доп. соглашение', 'Акт сверки', 'Накладная', 'Отчёт', 'Выписка', 'Претензия', 'Письмо', 'Прочее'];
export const DOC_SECTIONS = ['Финансы', 'Налоги', 'Поставки', 'Маркетплейсы', 'Реклама', 'Склад', 'CRM', 'Юридическое', 'Прочее'];
const nullable = t => ({ anyOf: [{ type: t }, { type: 'null' }] });

export const DOC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'number', 'counterparty', 'counterpartyInn', 'amount', 'date', 'dueDate', 'needsSignature', 'needsPayment', 'section', 'summary'],
  properties: {
    type: { type: 'string', enum: DOC_TYPES, description: 'Тип документа' },
    number: { ...nullable('string'), description: 'Номер документа' },
    counterparty: { ...nullable('string'), description: 'Контрагент — вторая сторона, не наша компания' },
    counterpartyInn: { ...nullable('string'), description: 'ИНН контрагента' },
    amount: { ...nullable('number'), description: 'Итоговая сумма в рублях с НДС' },
    date: { ...nullable('string'), description: 'Дата документа, YYYY-MM-DD' },
    dueDate: { ...nullable('string'), description: 'Срок оплаты или подписания, YYYY-MM-DD' },
    needsSignature: { type: 'boolean', description: 'Нужна ли наша подпись' },
    needsPayment: { type: 'boolean', description: 'Нужно ли нам оплатить' },
    section: { type: 'string', enum: DOC_SECTIONS, description: 'Раздел дашборда' },
    summary: { type: 'string', description: 'Кратко, 1–2 предложения: что это и что с ним сделать' }
  }
};

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const TEXT_TYPES = /^(text\/|application\/(xml|json))/;
export const canRead = mime => mime === 'application/pdf' || IMAGE_TYPES.includes(mime) || TEXT_TYPES.test(mime || '');

function docSystem(company) {
  return `Ты помогаешь владельцу бизнеса разбирать входящие документы. Бизнес продаёт товары на Wildberries и Ozon.
${company?.name ? `Наша компания: ${company.name}${company.inn ? `, ИНН ${company.inn}` : ''}. Контрагент — вторая сторона документа.` : 'Если в документе две стороны, контрагент — та, что выставила документ нам.'}
Заполни поля строго по тексту документа. Если поля в документе нет — верни null. Ничего не придумывай.
Сумма — итог к оплате в рублях числом, с НДС. Даты — в формате YYYY-MM-DD.
needsPayment = true, только если по документу платить должны мы (счёт или требование оплаты нам). Отчёты, выписки и документы, по которым платят нам, — false.
needsSignature = true, если документ ждёт нашей подписи: акт, УПД, договор, доп. соглашение, акт сверки, которые ещё не подписаны с нашей стороны.
Раздел: налоги и взносы — «Налоги»; закупки товара и накладные — «Поставки»; документы WB и Ozon — «Маркетплейсы»; договоры и претензии — «Юридическое»; прочие оплаты и услуги — «Финансы».`;
}

// buffer + mime → поля документа. hint — откуда пришёл (почта, Диадок…), помогает с контекстом.
export async function readDocument({ buffer, mime, name, hint, company }) {
  if (!canRead(mime)) throw new Error('Формат не поддерживается для распознавания — пришлите PDF или фото.');
  if (buffer.length > 25 * 1024 * 1024) throw new Error('Файл больше 25 МБ — слишком большой для распознавания.');
  const data = buffer.toString('base64');
  const file = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : IMAGE_TYPES.includes(mime)
      ? { type: 'image', source: { type: 'base64', media_type: mime, data } }
      : { type: 'text', text: `Содержимое файла «${name}»:\n\n${buffer.toString('utf8')}` };
  const text = await ask({
    system: docSystem(company),
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DOC_SCHEMA } },
    messages: [{ role: 'user', content: [file, { type: 'text', text: `Файл: «${name}». Источник: ${hint || 'не указан'}. Заполни поля документа.` }] }]
  });
  return validateDoc(JSON.parse(text));
}

// Структурированный вывод гарантирует схему, но перепроверяем то, что важно для задач
export function validateDoc(x) {
  const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    type: DOC_TYPES.includes(x.type) ? x.type : 'Прочее',
    number: x.number || null,
    counterparty: x.counterparty || null,
    counterpartyInn: x.counterpartyInn || null,
    amount: typeof x.amount === 'number' && isFinite(x.amount) ? Math.round(x.amount * 100) / 100 : null,
    date: date(x.date),
    dueDate: date(x.dueDate),
    needsSignature: x.needsSignature === true,
    needsPayment: x.needsPayment === true,
    section: DOC_SECTIONS.includes(x.section) ? x.section : 'Прочее',
    summary: String(x.summary || '').slice(0, 500)
  };
}

// ---------- Чат ----------

const CHAT_SYSTEM = `Ты — ИИ-ассистент владельца бизнеса, который продаёт на Wildberries и Ozon. Отвечай по-русски, коротко и по делу.
Ниже, в теге <business_data>, — актуальные данные дашборда в JSON: показатели, артикулы, реклама, деньги, задачи, сделки, документы.
Правила:
- Отвечай только по этим данным и называй конкретные цифры. Ничего не выдумывай и не достраивай.
- Если нужных данных нет (источник не подключён — см. notConnected) — прямо скажи, каких данных нет и какой источник подключить.
- Оценки (поля est, estimated, примечания notes) называй оценками.
- Если вопрос не про бизнес, коротко ответь, что ты помогаешь с данными дашборда.
- Деньги пиши в рублях с пробелами между разрядами: 1 250 000 ₽.`;

// history: [{role: 'user'|'assistant', text}], последнее сообщение — вопрос пользователя
export async function chat(history, snapshot) {
  const messages = history.map(m => ({ role: m.role, content: m.text }));
  return ask({
    system: [
      { type: 'text', text: CHAT_SYSTEM },
      { type: 'text', text: `<business_data>\n${JSON.stringify(snapshot)}\n</business_data>`, cache_control: { type: 'ephemeral' } }
    ],
    output_config: { effort: 'medium' },
    messages
  });
}
