/* Разговор с ботом.

   Счёт за подарок выставляет сам бот: Mini App просит у сервера ссылку на
   счёт, сервер берёт её у Telegram методом createInvoiceLink и отдаёт
   обратно. Платит человек звёздами (валюта XTR), не выходя из приложения.

   Токен бота живёт только в окружении и только на сервере: из браузера эти
   методы вызвать нельзя, иначе цену подарка назначал бы покупатель. */

// Адрес подменяется на стенде: там отвечает не Telegram, а заглушка
const HOST = process.env.TELEGRAM_API || 'https://api.telegram.org';
// Telegram отвечает быстро; дольше ждать нечего — человек стоит у экрана
const TIMEOUT = 8000;

export class BotError extends Error {}

export function hasBot() {
  return Boolean(process.env.BOT_TOKEN);
}

export async function call(method, payload) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new BotError('Токен бота не настроен');

  let response;
  try {
    response = await fetch(HOST + '/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(TIMEOUT)
    });
  } catch (_) {
    throw new BotError('Telegram не ответил');
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new BotError('Telegram ответил не по-человечески');
  }

  if (!data || !data.ok) throw new BotError((data && data.description) || 'Telegram отказал');
  return data.result;
}
