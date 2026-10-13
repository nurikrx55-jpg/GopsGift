/* Сюда приходит сам Telegram.

   Про платёж бот узнаёт двумя событиями. Сперва pre_checkout_query —
   последняя возможность отказать: сверяем заказ с витриной и отвечаем в
   десять секунд, иначе Telegram отменит платёж сам. Потом
   successful_payment — деньги прошли, и подарок пора выдать.

   Адрес знает только Telegram, но знать его мало: в каждом запросе он
   присылает условленный заголовок, и без него сюда не попасть. Секрет
   задаётся переменной WEBHOOK_SECRET и ставится вместе с webhook —
   deploy/gapsgift-hook делает и то и другое. */

import crypto from 'node:crypto';
import { configured } from './_lib/db.js';
import { readContent, readOrder, settleOrder } from './_lib/data.js';
import { call, hasBot } from './_lib/bot.js';
import { json, body } from './_lib/http.js';

// Приветствие на /start: две строки, под ними кнопка в приложение и канал
const APP_URL = process.env.APP_URL || 'https://gapsgift.online/';
const CHANNEL_URL = 'https://t.me/GapsGift_Community';
const WELCOME = 'Welcome to GapsGift!\n\nSend unique gifts to your friends, sell your gifts';

function welcome(message) {
  return call('sendMessage', {
    chat_id: message.chat.id,
    text: WELCOME,
    link_preview_options: { is_disabled: true },
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Open', web_app: { url: APP_URL } }],
        [{ text: 'GapsGift Community', url: CHANNEL_URL }]
      ]
    }
  });
}

function sameSecret(given, secret) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Последняя проверка перед списанием звёзд. Отказ человек увидит текстом,
// поэтому причина — человеческая
async function precheck(query) {
  const order = await readOrder(query.invoice_payload);
  const content = await readContent(true);
  const gift = order && (content.gifts || []).find((one) => one.id === order.giftId);

  let problem = null;
  if (!order) problem = 'Заказ не найден — начните покупку заново';
  else if (order.status !== 'new') problem = 'Этот счёт уже оплачен';
  else if (String(query.from && query.from.id) !== order.userId) problem = 'Счёт выставлен другому человеку';
  else if (!gift) problem = 'Подарка больше нет на витрине';
  else if (query.total_amount !== order.amount) problem = 'Цена изменилась — начните покупку заново';
  else if (typeof gift.left === 'number' && gift.left < order.qty) problem = 'Подарок разобрали, пока вы платили';

  await call('answerPreCheckoutQuery', {
    pre_checkout_query_id: query.id,
    ok: !problem,
    error_message: problem || undefined
  });
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const secret = String(process.env.WEBHOOK_SECRET || '');
    // Без секрета webhook не настроен — чужому запросу здесь делать нечего
    if (!secret || !hasBot()) return json({ error: 'off' }, 404);
    if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token'), secret)) {
      return json({ error: 'who' }, 403);
    }
    if (!configured()) return json({ error: 'no-db' }, 503);

    const update = await body(request);

    try {
      if (update.pre_checkout_query) {
        await precheck(update.pre_checkout_query);
      } else if (update.message && update.message.successful_payment) {
        const payment = update.message.successful_payment;
        const done = await settleOrder(payment.invoice_payload, payment);
        // Заказа нет — повторять нечего, иначе Telegram будет стучаться вечно
        if (!done) console.warn('bot: платёж без заказа', payment.invoice_payload);
      } else if (update.message && update.message.chat && update.message.chat.type === 'private' &&
        /^\/start(\s|$)/.test(String(update.message.text || ''))) {
        // Приветствие не повторяем: упади отправка — Telegram пришлёт /start
        // снова, и человек получил бы два одинаковых сообщения
        await welcome(update.message).catch((error) => console.error('bot: приветствие не ушло —', error.message));
      }
    } catch (error) {
      // Ответ не «принял» заставит Telegram прислать событие ещё раз — для
      // оплаты это и нужно
      console.error('bot:', error);
      return json({ error: 'retry' }, 500);
    }

    return json({ ok: true });
  }
};
