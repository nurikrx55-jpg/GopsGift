/* Задания — как у memgift. «start» отмечает, что человек открыл ссылку
   задания, «claim» начисляет купоны, если задание выполнено. Кто это,
   сервер узнаёт по подписи Telegram; что выполнено — считает сам.

   Подписку на канал не считаем, а спрашиваем у Telegram: бот — админ
   канала, и getChatMember отвечает, состоит ли в нём человек. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { readContent, startTask, claimTask, findTask, channelName, getUser, invitedCount, InputError } from './_lib/data.js';
import { call, BotError } from './_lib/bot.js';
import { json, body } from './_lib/http.js';

const MAX_AGE = 30 * 24 * 60 * 60;
const MEMBER = ['creator', 'administrator', 'member'];

/* strict — задание «Подписка на канал»: не смогли проверить — не даём.
   Мягкая проверка — у старых заданий-ссылок на t.me: канал, где бот админ,
   проверяется так же строго, а ссылка на бота, группу или чужой канал
   (Telegram ответит ошибкой) засчитывается, как раньше, за переход */
async function subscribed(channel, userId, strict) {
  let member;
  try {
    member = await call('getChatMember', { chat_id: '@' + channel, user_id: Number(userId) });
  } catch (error) {
    if (!strict) return true;
    // Бота убрали из админов или канал переименовали — человек не виноват
    console.error('tasks: подписку на @' + channel + ' не проверить —', error.message);
    throw new InputError('Не получилось проверить подписку, попробуйте позже');
  }
  return MEMBER.indexOf(member.status) !== -1 || (member.status === 'restricted' && member.is_member === true);
}

// Какой канал проверять у задания: у подписки — свой, у ссылки — если она
// ведёт прямо на t.me/<имя>
function channelOf(task) {
  if (!task) return '';
  if (task.type === 'subscribe') return task.channel;
  if (task.type === 'link' && /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?$/i.test(task.url || '')) return channelName(task.url);
  return '';
}

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
      else if (input.action === 'claim') {
        const task = findTask(content, input.task);
        const channel = channelOf(task);
        if (channel && !(await subscribed(channel, user.id, task.type === 'subscribe'))) {
          throw new InputError('Сначала подпишитесь на канал');
        }
        await claimTask(user.id, input.task, content);
      } else return json({ error: 'action' }, 400);

      const me = await getUser(user.id);
      if (me) me.invited = await invitedCount(user.id);
      return json({ me: me });
    } catch (error) {
      if (error instanceof InputError) return json({ error: 'input', message: error.message }, 400);
      if (error instanceof BotError) return json({ error: 'bot', message: error.message }, 502);
      console.error('tasks:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
