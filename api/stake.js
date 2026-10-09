/* Стейкинг: подарок уходит со счёта в ставку.

   Срок, ставку и порог цены проверяет сервер — из браузера приходит только,
   что ставят и на сколько. Ставку записываем вместе с подарком: админ
   поменяет проценты завтра, а человеку обещано сегодняшнее.

   Забрать подарок раньше срока нельзя, поэтому обратного действия здесь
   нет вовсе: приложение предупреждает об этом до ставки. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { readContent, readStakes, addStake, getUser, InputError } from './_lib/data.js';
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
      if (input.action === 'add') {
        const content = await readContent(true);
        const done = await addStake(user.id, input, content);
        return json({ stakes: done.stakes, me: await getUser(user.id) });
      }

      return json({ stakes: await readStakes(user.id) });
    } catch (error) {
      if (error instanceof InputError) {
        return json({ error: 'input', message: error.message }, 400);
      }
      console.error('stake:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
