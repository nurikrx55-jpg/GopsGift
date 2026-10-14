/* Маркет — как у memgift: лоты на продаже, история, выставить, снять и
   купить. Кто это, сервер узнаёт по подписи Telegram. Платят TON с
   баланса; цену, комиссию и владельца проверяет сервер, а не браузер. */

import { configured } from './_lib/db.js';
import { verify } from './_lib/telegram.js';
import {
  readContent, listLots, marketLog, createLot, removeLot, repriceLot, buyLot, getUser, InputError
} from './_lib/data.js';
import { giftSold } from './_lib/notify.js';
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
      if (input.action === 'list') return json({ lots: await listLots() });
      if (input.action === 'activity') return json({ log: await marketLog() });

      const content = await readContent(true);

      if (input.action === 'sell') {
        const lot = await createLot(user.id, input.nft, input.price, content);
        return json({ lot: lot, me: await getUser(user.id) });
      }

      if (input.action === 'reprice') {
        const lot = await repriceLot(user.id, input.lot, input.price, content);
        return json({ lot: lot, me: await getUser(user.id) });
      }

      if (input.action === 'unlist') {
        await removeLot(user.id, input.lot);
        return json({ me: await getUser(user.id) });
      }

      if (input.action === 'buy') {
        const sale = await buyLot(user.id, input.lot, content);
        // Продавцу — сообщение от бота. Покупку оно не держит
        const gift = (content.gifts || []).find((one) => one.id === sale.lot.nft.gift) || null;
        giftSold(sale, gift).catch((error) => console.warn('market: уведомление —', error.message));
        return json({ nft: sale.lot.nft.id, me: await getUser(user.id) });
      }

      return json({ error: 'action' }, 400);
    } catch (error) {
      if (error instanceof InputError) return json({ error: 'input', code: error.code || '', message: error.message }, 400);
      console.error('market:', error);
      return json({ error: 'server' }, 502);
    }
  }
};
