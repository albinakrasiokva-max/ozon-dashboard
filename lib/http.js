// HTTP-запросы к внешним API: таймаут, повтор при 429/5xx, понятные ошибки на русском.
// Ключи и заголовки никогда не попадают в текст ошибки или в лог.

export class ApiError extends Error {}

export const sleep = ms => new Promise(r => setTimeout(r, process.env.NO_SLEEP ? 0 : ms));

function humanError(status, data, source) {
  const detail = typeof data === 'string' ? data
    : data && (data.error_description || data.message || data.detail || data.title || data.errorText || (typeof data.error === 'string' ? data.error : ''));
  const tail = detail ? ` Ответ сервиса: «${String(detail).slice(0, 200)}».` : '';
  const pre = source ? source + ': ' : '';
  if (status === 401) return `${pre}ключ не принят (401). Проверьте, что токен в .env скопирован целиком и не истёк.${tail}`;
  if (status === 403) return `${pre}нет доступа (403). У ключа не хватает прав или категорий — выпустите его заново с нужными правами.${tail}`;
  if (status === 404) return `${pre}метод не найден (404). Возможно, изменился адрес API или неверно указан поддомен/вебхук.${tail}`;
  if (status === 429) return `${pre}слишком много запросов (429). Сервис ограничивает частоту — следующая синхронизация повторит попытку.${tail}`;
  if (status >= 500) return `${pre}сервис временно недоступен (${status}). Попробуем при следующей синхронизации.${tail}`;
  return `${pre}ошибка запроса (${status}).${tail}`;
}

export async function request(url, { method = 'GET', headers = {}, body, timeout = 30000, retries = 2, source = '' } = {}) {
  const isJson = body !== undefined && typeof body !== 'string';
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : isJson ? JSON.stringify(body) : body,
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(2000 * (attempt + 1)); continue; }
      throw new ApiError(`${source ? source + ': ' : ''}${e.name === 'AbortError' ? `сервис не ответил за ${timeout / 1000} с` : 'нет соединения с сервисом'}. Проверьте интернет на сервере.`);
    }
    clearTimeout(timer);
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await sleep(res.status === 429 ? (ra > 0 ? ra * 1000 : 60000) : 3000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) throw new ApiError(humanError(res.status, data, source));
    return data;
  }
}

// Скачать файл целиком (Telegram, Диадок). Адрес с токеном в текст ошибки не попадает.
export async function download(url, { headers = {}, source = '', timeout = 60000, maxBytes = 20 * 1024 * 1024 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new ApiError(humanError(res.status, null, source));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ApiError(`${source}: файл больше ${Math.round(maxBytes / 1048576)} МБ`);
    return { buffer: buf, mime: (res.headers.get('content-type') || '').split(';')[0] };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(`${source}: не удалось скачать файл (${e.name === 'AbortError' ? 'таймаут' : 'нет соединения'})`);
  } finally { clearTimeout(timer); }
}

// Числа из API иногда приходят строками: "1 234,50"
export const num = v => Number(String(v ?? 0).replace(/[\s ]/g, '').replace(',', '.')) || 0;
