/* Заход в приложение: отдаём витрину и счёт того, кто зашёл, и заодно
   отмечаем его в списке пользователей. */

import { configured } from './_lib/db.js';
import { verify, isAdmin } from './_lib/telegram.js';
import { readContent, publicContent, touchUser } from './_lib/data.js';
import { json, body } from './_lib/http.js';

// Подпись Telegram живёт всю сессию Mini App; месяц — с запасом на тех,
// кто держит приложение открытым неделями
const MAX_AGE = 30 * 24 * 60 * 60;

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    // Базы ещё нет — приложение возьмёт содержимое из репозитория
    if (!configured()) return json({ error: 'no-db' }, 503);

    const input = await body(request);

    try {
      const content = await readContent();
      const tg = verify(input.initData, MAX_AGE);
      const me = tg ? await touchUser(tg) : null;

      if (me) me.admin = isAdmin(me.id);

      return json({ content: publicContent(content), me: me });
    } catch (error) {
      console.error('boot:', error);
      return json({ error: 'db' }, 502);
    }
  }
};
