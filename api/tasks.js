/* Задания — как у memgift. «start» отмечает, что человек открыл ссылку
   задания, «claim» начисляет купоны, если задание выполнено. Кто это,
   сервер узнаёт по подписи Telegram; что выполнено — считает сам. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { readContent, startTask, claimTask, getUser, invitedCount, InputError } from './_lib/data.js';
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
      const content = await readContent(true);
      if (input.action === 'start') await startTask(user.id, input.task, content);
      else if (input.action === 'claim') await claimTask(user.id, input.task, content);
      else return json({ error: 'action' }, 400);

      const me = await getUser(user.id);
      if (me) me.invited = await invitedCount(user.id);
      return json({ me: me });
    } catch (error) {
      if (error instanceof InputError) return json({ error: 'input', message: error.message }, 400);
      console.error('tasks:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
