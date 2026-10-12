/* Реферальная программа — как у memgift: своя ссылка и список тех, кто
   по ней пришёл. Ссылка ведёт в Mini App бота с `startapp=ref_<id>`;
   имя бота спрашиваем у Telegram один раз и держим, пока живёт процесс. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import { listReferrals } from './_lib/data.js';
import { call, hasBot } from './_lib/bot.js';
import { json, body } from './_lib/http.js';

const MAX_AGE = 30 * 24 * 60 * 60;
const PAGE = 20;

let botName = '';

async function username() {
  if (botName || !hasBot()) return botName;
  try {
    const me = await call('getMe');
    botName = (me && me.username) || '';
  } catch (_) {
    botName = '';
  }
  return botName;
}

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    if (!configured()) return json({ error: 'no-db' }, 503);

    const input = await body(request);
    const user = verify(input.initData, MAX_AGE);
    if (!user) return json({ error: 'who' }, 401);

    try {
      const [bot, list] = await Promise.all([username(), listReferrals(user.id, input.offset, PAGE)]);
      return json({
        link: bot ? 'https://t.me/' + bot + '?startapp=ref_' + user.id : '',
        total: list.total,
        items: list.items,
        more: (Number(input.offset) || 0) + list.items.length < list.total
      });
    } catch (error) {
      console.error('referrals:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
