/* Привязка TON-кошелька, как у memgift: адрес подключённого кошелька
   записывается в профиль, при отвязке стирается. Кто привязывает, сервер
   узнаёт по подписи Telegram. Ни пополнения, ни вывода здесь нет. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { bindWallet, InputError } from './_lib/data.js';
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
      const address = input.action === 'unbind' ? '' : input.address;
      return json({ wallet: await bindWallet(user.id, address) });
    } catch (error) {
      if (error instanceof InputError) {
        return json({ error: 'input', message: error.message }, 400);
      }
      console.error('wallet:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
