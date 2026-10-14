/* Передача подарка другому человеку — как у memgift: поиск получателя и
   сама отправка. Кто отправляет, сервер узнаёт по подписи Telegram, а не
   по тому, что прислал браузер. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { findRecipients, transferGift, getUser, readContent, clearInbox, InputError } from './_lib/data.js';
import { giftReceived } from './_lib/notify.js';
import { json, body } from './_lib/http.js';

const MAX_AGE = 30 * 24 * 60 * 60;

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
        const done = await transferGift(user.id, input.to, input.gift, input.nft, await readContent(true));
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
