/* Кошелёк, как у memgift: привязка адреса подключённого TON-кошелька,
   баланс с историей и проверка пополнений (`check` — смотрим новые
   переводы на наш адрес). Кто спрашивает, сервер узнаёт по подписи
   Telegram. Вывода здесь пока нет. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { bindWallet, tonState, checkDeposits, InputError } from './_lib/data.js';
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
      if (input.action === 'check') {
        await checkDeposits();
        return json(await tonState(user.id));
      }

      if (input.action === 'state') return json(await tonState(user.id));

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
