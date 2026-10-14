/* Передача подарка другому человеку — как у memgift: поиск получателя и
   сама отправка. Кто отправляет, сервер узнаёт по подписи Telegram, а не
   по тому, что прислал браузер. */

import { configured } from './_lib/db.js';
import { verify, isAdmin } from './_lib/telegram.js';
import {
  findRecipients, transferGift, checkTransfer, createOrder, cleanFees, getUser, readContent, clearInbox, InputError
} from './_lib/data.js';
import { call, hasBot } from './_lib/bot.js';
import { giftReceived } from './_lib/notify.js';
import { json, body } from './_lib/http.js';

const MAX_AGE = 30 * 24 * 60 * 60;

async function invoice(user, input, stars) {
  const giftId = await checkTransfer(user.id, input.to, input.gift, input.nft);
  if (!hasBot() || !process.env.WEBHOOK_SECRET) throw new InputError('Оплата не настроена');

  const order = await createOrder({
    userId: user.id,
    giftId: giftId,
    qty: 1,
    price: stars,
    amount: stars,
    kind: 'transfer',
    toId: String(input.to || ''),
    nftId: input.nft ? String(input.nft) : ''
  });

  const link = await call('createInvoiceLink', {
    title: 'Gift transfer',
    description: 'Отправка подарка. Подарок уйдёт получателю сразу после оплаты.',
    payload: order.id,
    currency: 'XTR',
    prices: [{ label: 'Gift transfer', amount: stars }]
  });

  return { order: order.id, link: link, amount: stars };
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!configured()) return json({ error: 'no-db' }, 503);

    const input = await body(request);
    const user = verify(input.initData, MAX_AGE);
    if (!user) return json({ error: 'who' }, 401);

    try {
      if (input.action === 'search') {
        return json({ users: await findRecipients(input.query, user.id) });
      }

      if (input.action === 'send') {
        // Передача стоит звёзд — сначала счёт. Подарок уйдёт, когда Telegram
        // сообщит боту об оплате (api/bot.js). Админ отправляет бесплатно
        const stars = cleanFees((await readContent(true)).fees).transfer;
        if (stars > 0 && !isAdmin(user.id)) return json(await invoice(user, input, stars));

        const done = await transferGift(user.id, input.to, input.gift, input.nft);
        // Получателю — сообщение от бота. Ответа не ждём: подарок уже у него
        readContent().then((content) => {
          const gift = (content.gifts || []).find((one) => one.id === done.gift) || null;
          return giftReceived(done.to, done.from, gift, done.nft);
        }).catch((error) => console.warn('transfer: уведомление —', error.message));
        return json({ name: done.name, me: await getUser(user.id) });
      }

      // Страницу «Подарок получен» показали — до какого момента входящие прочитаны
      if (input.action === 'seen') {
        await clearInbox(user.id, input.until);
        return json({ ok: true });
      }

      return json({ error: 'action' }, 400);
    } catch (error) {
      if (error instanceof InputError) {
        return json({ error: 'input', message: error.message }, 400);
      }
      console.error('transfer:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
