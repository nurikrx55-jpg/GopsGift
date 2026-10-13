/* Чужой профиль — как страница /view/:id у memgift: по строке топа
   покупателей открывается, кто это и какие подарки у него лежат.

   Подпись не спрашиваем, как и у топа: имя, фото и id и так видны в
   Telegram, а звёзды, купоны, TON и кошелёк сюда не попадают. */

import { configured } from './_lib/db.js';
import { publicProfile } from './_lib/data.js';
import { json } from './_lib/http.js';

export default {
  async fetch(request) {
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    if (!configured()) return json({ error: 'no-db' }, 503);

    const id = new URL(request.url, 'http://local').searchParams.get('id') || '';

    try {
      const person = await publicProfile(id);
      if (!person) return json({ error: 'none' }, 404);
      return json({ user: person });
    } catch (error) {
      console.error('profile:', error);
      return json({ error: 'db' }, 502);
    }
  }
};
