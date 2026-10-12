// Отдельный бот отзывов Ozon: черновик ответа → Telegram. Ozon, Claude и Telegram подменены тестовыми. Запуск: npm test
import { installMock, claudeMessage } from './fixtures.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brandos-reviews-'));
const SETTINGS_FILE = path.join(DIR, 'settings.json');
fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ reviews: { brand: 'Тест-Бренд', signature: 'Команда Тест-Бренд' } }));
Object.assign(process.env, {
  NO_SLEEP: '1', DATA_DIR: path.join(DIR, 'data'), SETTINGS_FILE,
  OZON_CLIENT_ID: '1', OZON_API_KEY: 'oz-test',
  ANTHROPIC_API_KEY: 'sk-ant-test', REVIEWS_BOT_TOKEN: 'tg-test', REVIEWS_ALLOWED_CHATS: '42'
});

const { getDb } = await import('../lib/db.js');
const { handleUpdate, maybeCheckReviews } = await import('../lib/reviewsBot.js');

const hoursAgo = h => new Date(Date.now() - h * 3600e3).toISOString();
const reviews = [
  { id: 'r-new', sku: 111, rating: 2, text: 'Маломерит, пришлось вернуть', published_at: hoursAgo(2), photos_amount: 1 },
  { id: 'r-old', sku: 111, rating: 5, text: 'Отлично', published_at: hoursAgo(24 * 10) }
];
const processed = [
  { id: 'p1', sku: 111, rating: 5, text: 'Сидит идеально', published_at: hoursAgo(300) },
  { id: 'p2', sku: 111, rating: 1, text: 'Порвался шов', published_at: hoursAgo(400) }
];
const sent = [], edited = [], claude = [], posted = [];
let n = 0;

before(() => installMock({}, {
  'api-seller.ozon.ru/v1/review/list': (u, opt) => ({ reviews: JSON.parse(opt.body).status === 'PROCESSED' ? processed : reviews, has_next: false, last_id: '' }),
  'api-seller.ozon.ru/v1/review/comment/list': (u, opt) => {
    const id = JSON.parse(opt.body).review_id;
    return { comments: [{ id: 'c-' + id, is_owner: true, text: id === 'p1' ? 'Спасибо, Анна! Ваша «Мамина забота» 💛' : 'Очень жаль! Напишите нам — разберёмся. «Мамина забота»' }] };
  },
  'api-seller.ozon.ru/v1/review/comment/create': (u, opt) => { posted.push(JSON.parse(opt.body)); return { comment_id: 'new' }; },
  'api-seller.ozon.ru/v3/product/info/list': () => ({ items: [{ sku: 111, name: 'Бандаж послеродовой', offer_id: 'BND-1' }] }),
  'api.anthropic.com/v1/messages': (u, opt) => {
    const body = JSON.parse(opt.body);
    claude.push(body);
    return claudeMessage(`Вариант ${++n}`);
  },
  'api.telegram.org/bottg-test/sendMessage': (u, opt) => { const b = JSON.parse(opt.body); sent.push(b); return { ok: true, result: { message_id: 100 + sent.length } }; },
  'api.telegram.org/bottg-test/editMessageText': (u, opt) => { edited.push(JSON.parse(opt.body)); return { ok: true, result: {} }; },
  'api.telegram.org/bottg-test/editMessageReplyMarkup': (u, opt) => { edited.push(JSON.parse(opt.body)); return { ok: true, result: {} }; },
  'api.telegram.org/bottg-test/answerCallbackQuery': () => ({ ok: true, result: true })
}));

test('чужой чат получает свой chat id и больше ничего', async () => {
  await handleUpdate({ update_id: 0, message: { message_id: 1, chat: { id: 777 }, text: 'Плохой товар, всё сломалось' } });
  assert.match(sent.at(-1).text, /chat id: 777/);
  assert.equal(claude.length, 0);
  sent.length = 0;
});

test('новый отзыв приходит в Telegram с товаром и черновиком, старые при первом запуске — нет', async () => {
  await maybeCheckReviews();
  assert.equal(sent.length, 2, 'карточка и черновик одного отзыва');
  assert.match(sent[0].text, /★★☆☆☆/);
  assert.match(sent[0].text, /Бандаж послеродовой/);
  assert.match(sent[0].text, /Маломерит/);
  assert.equal(sent[1].text, '<code>Вариант 1</code>');
  assert.equal(sent[1].reply_markup.inline_keyboard[0][0].callback_data, 'rv:send:r-new');
  assert.equal(posted.length, 0, 'без нажатия «Отправить» на Ozon ничего не уходит');
  const prompt = claude[0].messages[0].content;
  assert.match(prompt, /Товар: Бандаж послеродовой/);
  assert.match(prompt, /Оценка: 2 из 5/);
  assert.match(claude[0].system, /Команда Тест-Бренд/);
  // Образец стиля — прошлые ответы из кабинета, негативный идёт первым
  assert.match(claude[0].system, /Ответ продавца: Очень жаль! Напишите нам[\s\S]*Ответ продавца: Спасибо, Анна!/);
  assert.ok(getDb().state.reviews.seen['r-old'], 'старый отзыв помечен просмотренным');

  // Повторная проверка не присылает тот же отзыв
  sent.length = 0;
  await handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text: '/otzyvy' } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Новых отзывов нет/);
});

test('«Другой вариант» заменяет черновик, «Свой текст» — ваш текст, «Отправить» публикует его на Ozon один раз', async () => {
  await handleUpdate({ update_id: 2, callback_query: { id: 'q1', data: 'rv:again:r-new', message: { message_id: 102, chat: { id: 42 } } } });
  assert.equal(edited.at(-1).text, '<code>Вариант 2</code>');
  assert.match(claude.at(-1).messages[0].content, /Прошлый вариант ответа: Вариант 1/);

  // Свой текст: бот просит прислать, следующее сообщение становится черновиком без ИИ
  const beforeEdit = claude.length;
  await handleUpdate({ update_id: 20, callback_query: { id: 'q4', data: 'rv:edit:r-new', message: { message_id: 102, chat: { id: 42 } } } });
  assert.match(sent.at(-1).text, /Пришлите исправленный текст/);
  await handleUpdate({ update_id: 21, message: { message_id: 30, chat: { id: 42 }, text: 'Нам очень жаль, что не подошёл размер! Мамина забота' } });
  assert.equal(claude.length, beforeEdit, 'свой текст — без ИИ');
  assert.equal(sent.at(-1).text, '<code>Нам очень жаль, что не подошёл размер! Мамина забота</code>');
  const draftMsg = sent.length + 100;

  // «Отправить» под старым вариантом публикует именно его
  await handleUpdate({ update_id: 3, callback_query: { id: 'q2', data: 'rv:send:r-new', message: { message_id: 102, chat: { id: 42 }, text: 'Вариант 2' } } });
  assert.deepEqual(posted, [{ review_id: 'r-new', text: 'Вариант 2', mark_review_as_processed: true }]);
  posted.length = 0;
  delete getDb().state.reviews.items['r-new'].sentAt;
  await handleUpdate({ update_id: 30, callback_query: { id: 'q7', data: 'rv:send:r-new', message: { message_id: draftMsg, chat: { id: 42 }, text: 'Нам очень жаль, что не подошёл размер! Мамина забота' } } });
  assert.deepEqual(posted, [{ review_id: 'r-new', text: 'Нам очень жаль, что не подошёл размер! Мамина забота', mark_review_as_processed: true }]);
  assert.match(edited.at(-1).text, /Опубликовано на Ozon/);
  assert.equal(edited.at(-1).reply_markup, undefined, 'кнопки убраны');

  await handleUpdate({ update_id: 22, callback_query: { id: 'q5', data: 'rv:send:r-new', message: { message_id: draftMsg, chat: { id: 42 }, text: 'Нам очень жаль, что не подошёл размер! Мамина забота' } } });
  assert.equal(posted.length, 1, 'повторно не отправляется');
  assert.match(sent.at(-1).text, /уже отправлен/);

  // Отправленный ответ становится образцом стиля для следующих
  await handleUpdate({ update_id: 23, message: { message_id: 31, chat: { id: 42 }, text: 'Ткань приятная, но долго ехал' } });
  assert.match(claude.at(-1).system, /Ответ продавца: Нам очень жаль, что не подошёл размер!/);

  // Из чужого чата кнопки не работают
  const callsBefore = claude.length;
  await handleUpdate({ update_id: 4, callback_query: { id: 'q3', data: 'rv:again:r-new', message: { message_id: 102, chat: { id: 777 } } } });
  assert.equal(claude.length, callsBefore);
});

test('ответ на черновик с пожеланием — новый вариант; текст отзыва — черновик на него', async () => {
  sent.length = 0;
  await handleUpdate({ update_id: 5, message: { message_id: 7, chat: { id: 42 }, text: 'короче', reply_to_message: { message_id: 102 } } });
  assert.match(claude.at(-1).messages[0].content, /Пожелание к ответу: короче/);
  assert.match(sent.at(-1).text, /^<code>Вариант \d+<\/code>$/);

  await handleUpdate({ update_id: 6, message: { message_id: 8, chat: { id: 42 }, text: 'Хороший бандаж, но липучка слабая' } });
  assert.match(claude.at(-1).messages[0].content, /Отзыв: Хороший бандаж, но липучка слабая/);
  assert.match(sent.at(-1).text, /^<code>Вариант \d+<\/code>$/);
  assert.match(sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, /^rv:again:m/, 'присланный текстом отзыв на Ozon не отправить');
});

test('без роли «Review» отправка не проходит, бот говорит, что включить', async () => {
  reviews.push({ id: 'r-2', sku: 111, rating: 5, text: 'Супер', published_at: hoursAgo(1) });
  await handleUpdate({ update_id: 8, message: { message_id: 40, chat: { id: 42 }, text: '/otzyvy' } });
  installMock({ 'api-seller.ozon.ru/v1/review/comment/create': 403 }, { 'api.telegram.org/bottg-test/sendMessage': (u, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, result: { message_id: 1 } }; }, 'api.telegram.org/bottg-test/answerCallbackQuery': () => ({ ok: true, result: true }) });
  await handleUpdate({ update_id: 9, callback_query: { id: 'q6', data: 'rv:send:r-2', message: { message_id: 1, chat: { id: 42 } } } });
  assert.match(sent.at(-1).text, /Не отправлено: .*роль «Review»/);
  assert.equal(getDb().state.reviews.items['r-2'].sentAt, undefined);
});

test('без роли «Review read only» — понятная ошибка', async () => {
  installMock({ 'api-seller.ozon.ru/v1/review/list': 403 }, { 'api.telegram.org/bottg-test/sendMessage': (u, opt) => { sent.push(JSON.parse(opt.body)); return { ok: true, result: { message_id: 1 } }; } });
  sent.length = 0;
  await handleUpdate({ update_id: 7, message: { message_id: 9, chat: { id: 42 }, text: '/otzyvy' } });
  assert.match(sent.at(-1).text, /Review read only/);
});
