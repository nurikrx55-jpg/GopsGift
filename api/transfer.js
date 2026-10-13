/* Передача подарка другому человеку — как у memgift: поиск получателя и
   сама отправка. Кто отправляет, сервер узнаёт по подписи Telegram, а не
   по тому, что прислал браузер. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { findRecipients, transferGift, getUser, InputError } from './_lib/data.js';
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
        const done = await transferGift(user.id, input.to, input.gift, input.nft);
        return json({ name: done.name, me: await getUser(user.id) });
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
