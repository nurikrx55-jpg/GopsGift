/* Покупка подарка за звёзды.

   Приложение просит счёт («start»), сервер сверяет цену с витриной, заводит
   заказ и берёт у Telegram ссылку на счёт. Открывает её Mini App прямо на
   своём экране — никуда уходить не надо.

   Цену и остаток считает только сервер: браузер присылает, что берут и
   сколько, а не почём. Оплату засчитывает не этот файл, а api/bot.js — к
   нему Telegram приходит сам, когда деньги прошли. Приложение потом
   спрашивает «уже?» («check») и забирает обновлённый счёт. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import {
  readContent, publicContent, createOrder, readOrder, getUser, InputError
} from './_lib/data.js';
import { call, hasBot, BotError } from './_lib/bot.js';
import { json, body } from './_lib/http.js';

// Подпись живёт столько же, сколько на заходе: приложение держат открытым
// неделями, и платить из него должно быть можно
const MAX_AGE = 30 * 24 * 60 * 60;
const MAX_QTY = 99;
// Потолок одного счёта в звёздах — столько же разрешает сам Telegram
const MAX_STARS = 1000000;

/* Отказ, который увидит человек. Словами он назван в приложении, а не
   здесь: язык выбирает тот, кто смотрит на экран. Сюда кладём код и числа
   к нему, а русский текст остаётся запасным — для логов и старых клиентов. */
function refuse(code, text, vars) {
  const error = new InputError(text);
  error.code = code;
  error.vars = vars || null;
  return error;
}

async function start(input, user) {
  const content = await readContent(true);
  const gift = (content.gifts || []).find((one) => one.id === String(input.giftId || ''));

  if (!gift) throw refuse('pay.gone', 'Такого подарка больше нет');
  if (!gift.price) throw refuse('pay.free', 'Этот подарок не продаётся');

  const qty = Math.min(Math.max(Math.round(Number(input.qty)) || 1, 1), MAX_QTY);
  if (typeof gift.left === 'number' && gift.left < qty) {
    throw gift.left
      ? refuse('pay.left', 'Осталось всего ' + gift.left, { n: gift.left })
      : refuse('pay.soldout', 'Подарок распродан');
  }

  const full = gift.price * qty;
  if (full > MAX_STARS) throw refuse('pay.toomuch', 'Столько звёзд за один раз Telegram не примет');

  /* Купоны идут в скидку: один купон — одна звезда. Сколько их на счету,
     знает только сервер, поэтому число из браузера здесь лишь потолок.
     Совсем до нуля цену они не сводят: счёт меньше звезды Telegram не
     примет, и одну звезду всегда оставляем. */
  const me = await getUser(user.id);
  const want = Math.max(0, Math.round(Number(input.coupons) || 0));
  const coupons = Math.min(want, me ? me.coupons || 0 : 0, full - 1);
  const amount = full - coupons;

  const order = await createOrder({
    userId: user.id,
    giftId: gift.id,
    qty: qty,
    price: gift.price,
    amount: amount,
    coupons: coupons
  });

  // По payload бот узнает заказ, когда Telegram сообщит об оплате
  const link = await call('createInvoiceLink', {
    title: gift.name.slice(0, 32),
    description: (qty > 1 ? gift.name + ' — ' + qty + ' шт.' : gift.name) +
      (coupons ? '. Купонами списано ' + coupons : '') +
      '. Подарок уйдёт в ваш профиль сразу после оплаты.',
    payload: order.id,
    currency: 'XTR',
    prices: [{ label: gift.name.slice(0, 32), amount: amount }]
  });

  return { order: order.id, link: link, amount: amount, coupons: coupons };
}

// Оплату засчитывает webhook, и приходит он своим ходом. Приложение
// переспрашивает, пока заказ не станет оплаченным, и забирает сразу и счёт,
// и витрину: остаток подарка после покупки тоже другой
async function check(input, user) {
  const order = await readOrder(input.order);
  if (!order || order.userId !== String(user.id)) throw refuse('pay.noorder', 'Заказ не найден');

  const out = { status: order.status };

  if (order.status === 'paid') {
    out.me = await getUser(user.id);
    out.content = publicContent(await readContent(true));
  }

  return out;
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!configured()) return json({ error: 'no-db' }, 503);
    if (!hasBot()) return json({ error: 'no-bot' }, 503);

    // Без webhook платёж всё равно сорвался бы: ответить Telegram на
    // pre_checkout_query было бы некому, и он отменил бы списание сам.
    // Лучше сказать об этом до счёта, чем после
    if (!process.env.WEBHOOK_SECRET) {
      return json({ error: 'no-hook', code: 'pay.nohook', message: 'Оплата на сервере ещё не включена' }, 503);
    }

    const input = await body(request);
    const user = verify(input.initData, MAX_AGE);
    if (!user) return json({ error: 'who' }, 401);

    try {
      const result = input.action === 'check' ? await check(input, user) : await start(input, user);
      return json(result);
    } catch (error) {
      // Понятные человеку отказы — отдельно от поломок: их приложение
      // показывает как есть
      if (error instanceof InputError || error instanceof BotError) {
        return json({ error: 'input', code: error.code, vars: error.vars, message: error.message }, 400);
      }
      console.error('pay:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
