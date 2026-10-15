/* Заход в приложение: отдаём витрину и счёт того, кто зашёл, и заодно
   отмечаем его в списке пользователей. */

import { configured } from './_lib/db.js';
import { verify, isAdmin, startParam } from './_lib/telegram.js';
import { readContent, publicContent, touchUser, invitedCount, readInbox, isBanned } from './_lib/data.js';
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
      const tg = verify(input.initData, MAX_AGE);

      /* Забаненному не отдаём ничего — ни витрины, ни счёта. Приложение по
         этому ответу остаётся на заставке: бесконечная загрузка вместо
         объяснений. Отказом отвечать нельзя — на ошибку приложение
         переключается на содержимое из репозитория и открылось бы */
      if (tg && await isBanned(tg.id)) return json({ banned: true });

      const content = await readContent();
      const me = tg ? await touchUser(tg, startParam(input.initData)) : null;

      if (me) {
        me.admin = isAdmin(me.id);
        // Для задания «пригласить друзей» — сколько уже пришло по ссылке
        me.invited = await invitedCount(me.id);
        // Подарки от других, которые человек ещё не видел
        me.inbox = await readInbox(me.id);
      }

      return json({ content: publicContent(content), me: me });
    } catch (error) {
      console.error('boot:', error);
      return json({ error: 'db' }, 502);
    }
  }
};
