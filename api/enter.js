/* Вход в приложение. Страница присылает initData, а в ответ получает
   пропуск, по которому отдаётся наш код (`api/asset`). Отдельная ручка
   нужна потому, что остальные ждут готовую базу, а код страницы должен
   приезжать и тогда, когда база молчит.

   Свежесть здесь строже, чем у остальных ручек: initData нужны только что
   выданные Telegram, иначе подписью, подсмотренной в devtools, можно было
   бы открывать приложение в браузере сколько угодно долго. */

import { verify, isAdmin } from './_lib/telegram.js';
import { issue } from './_lib/pass.js';
import { json, body } from './_lib/http.js';

const MAX_AGE = 60 * 60;

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const input = await body(request);
    const user = verify(input.initData, MAX_AGE);
    if (!user) return json({ error: 'who' }, 401);

    const pass = issue(user.id, isAdmin(user.id));
    if (!pass) return json({ error: 'server' }, 503);

    return json({ pass: pass });
  }
};
