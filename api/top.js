/* Топ покупателей подарка: кто сколько штук купил. Отдаём первую десятку и
   общее число купивших — ровно то, что показывает лист подарка.

   Подпись не спрашиваем: имена и фото и так видны в Telegram, а счёт и
   прочее про человека сюда не попадает. */

import { configured } from './_lib/db.js';
import { topBuyers } from './_lib/data.js';
import { json } from './_lib/http.js';

const LIMIT = 10;

export default {
  async fetch(request) {
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    if (!configured()) return json({ error: 'no-db' }, 503);

    const gift = new URL(request.url, 'http://local').searchParams.get('gift') || '';

    try {
      return json(await topBuyers(gift, LIMIT));
    } catch (error) {
      console.error('top:', error);
      return json({ error: 'db' }, 502);
    }
  }
};
