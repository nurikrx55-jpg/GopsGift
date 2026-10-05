/* Всё, что умеет админка. Каждый запрос несёт initData: сервер сам
   проверяет подпись Telegram и сверяет id со списком админов — подделать
   доступ из браузера нельзя. */

import { configured } from './_lib/db.js';
import { verify, isAdmin, authMode } from './_lib/telegram.js';
import {
  readContent, writeContent, cleanGift, cleanBanner, cleanTasks, InputError,
  listUsers, getUser, saveAccount, grantAll, stats, saveLottie, saveImage, dropFile
} from './_lib/data.js';
import { json, body } from './_lib/http.js';

// Админская подпись не старше суток: утёкшая ссылка не даст доступа навсегда
const MAX_AGE = 24 * 60 * 60;

function reorder(list, ids) {
  const order = Array.isArray(ids) ? ids : [];
  const byId = new Map(list.map((one) => [one.id, one]));
  const sorted = order.map((id) => byId.get(id)).filter(Boolean);
  // То, о чём порядок не знает, остаётся в конце, а не теряется
  list.forEach((one) => {
    if (sorted.indexOf(one) === -1) sorted.push(one);
  });
  return sorted;
}

const actions = {
  async session(payload, ctx) {
    const content = await readContent(true);
    return { content: content, stats: await stats(content), me: ctx.user };
  },

  async stats() {
    return { stats: await stats(await readContent(true)) };
  },

  // --- Подарки ---

  async 'gift.save'(payload) {
    const input = payload.gift || {};
    let art = input.art;
    if (payload.file) art = await saveLottie(payload.file);

    let stale = null;
    const content = await writeContent((state) => {
      state.gifts = state.gifts || [];
      const at = state.gifts.findIndex((one) => one.id === input.id);
      const gift = cleanGift(Object.assign({}, input, { art: art }));

      if (at === -1) {
        // Новый подарок не должен перезаписать чужой с тем же id
        while (state.gifts.some((one) => one.id === gift.id)) gift.id += '-2';
        state.gifts.push(gift);
      } else {
        if (state.gifts[at].art !== gift.art) stale = state.gifts[at].art;
        state.gifts[at] = gift;
      }
      return state;
    });

    if (stale) await dropFile(stale);
    return { content: content };
  },

  async 'gift.delete'(payload) {
    let gone = null;
    const content = await writeContent((state) => {
      gone = (state.gifts || []).find((one) => one.id === payload.id) || null;
      state.gifts = (state.gifts || []).filter((one) => one.id !== payload.id);
      if (state.defaults && Array.isArray(state.defaults.gifts)) {
        state.defaults.gifts = state.defaults.gifts.filter((one) => one !== payload.id);
      }
      return state;
    });

    if (gone) await dropFile(gone.art);
    return { content: content };
  },

  async 'gift.order'(payload) {
    const content = await writeContent((state) => {
      state.gifts = reorder(state.gifts || [], payload.ids);
      return state;
    });
    return { content: content };
  },

  // --- Баннеры ---

  async 'banner.save'(payload) {
    const input = payload.banner || {};
    let image = input.image;
    if (payload.file) image = await saveImage(payload.file, payload.type);

    let stale = null;
    const content = await writeContent((state) => {
      state.banners = state.banners || [];
      const banner = cleanBanner(Object.assign({}, input, { image: image }));
      const at = state.banners.findIndex((one) => one.id === input.id);

      if (at === -1) {
        while (state.banners.some((one) => one.id === banner.id)) banner.id += '-2';
        state.banners.push(banner);
      } else {
        if (state.banners[at].image !== banner.image) stale = state.banners[at].image;
        state.banners[at] = banner;
      }
      return state;
    });

    if (stale) await dropFile(stale);
    return { content: content };
  },

  async 'banner.delete'(payload) {
    let gone = null;
    const content = await writeContent((state) => {
      gone = (state.banners || []).find((one) => one.id === payload.id) || null;
      state.banners = (state.banners || []).filter((one) => one.id !== payload.id);
      return state;
    });

    if (gone) await dropFile(gone.image);
    return { content: content };
  },

  async 'banner.order'(payload) {
    const content = await writeContent((state) => {
      state.banners = reorder(state.banners || [], payload.ids);
      return state;
    });
    return { content: content };
  },

  // --- Задания, маркет, стартовый набор ---

  async 'tasks.save'(payload) {
    const tasks = cleanTasks(payload.tasks);
    const content = await writeContent((state) => {
      state.tasks = tasks;
      return state;
    });
    return { content: content };
  },

  async 'market.save'(payload) {
    const when = Date.parse(payload.opensAt);
    if (payload.opensAt && !Number.isFinite(when)) throw new InputError('Дата не читается');

    const content = await writeContent((state) => {
      state.market = Object.assign({}, state.market, {
        opensAt: payload.opensAt ? new Date(when).toISOString() : ''
      });
      return state;
    });
    return { content: content };
  },

  async 'defaults.save'(payload) {
    const content = await writeContent((state) => {
      const known = (state.gifts || []).map((gift) => gift.id);
      state.defaults = {
        stars: Math.max(0, Math.round(Number(payload.stars) || 0)),
        coupons: Math.max(0, Math.round(Number(payload.coupons) || 0)),
        gifts: (Array.isArray(payload.gifts) ? payload.gifts : []).filter((id) => known.indexOf(id) !== -1)
      };
      return state;
    });
    return { content: content };
  },

  // --- Люди ---

  async 'users.list'(payload) {
    return await listUsers(payload || {});
  },

  async 'user.get'(payload) {
    const user = await getUser(String(payload.id || ''));
    if (!user) throw new InputError('Такого пользователя нет');
    return { user: user };
  },

  async 'user.save'(payload) {
    const id = String(payload.id || '');
    if (!/^\d{1,20}$/.test(id)) throw new InputError('Неверный id');

    const content = await readContent(true);
    await saveAccount(id, payload.account || {}, content);
    return { user: await getUser(id) };
  },

  async 'users.grant'(payload) {
    return await grantAll(payload || {}, await readContent(true));
  }
};

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const input = await body(request);

    // Состояние подключения отдаём без входа: по нему админка показывает,
    // чего не хватает. Ничего секретного здесь нет
    if (input.action === 'status') {
      return json({ db: configured(), auth: authMode() });
    }

    if (!configured()) return json({ error: 'no-db' }, 503);
    if (!authMode()) return json({ error: 'no-auth' }, 503);

    const user = verify(input.initData, MAX_AGE);
    if (!user) return json({ error: 'unauthorized' }, 401);
    if (!isAdmin(user.id)) return json({ error: 'forbidden' }, 403);

    const run = actions[input.action];
    if (!run) return json({ error: 'unknown-action' }, 400);

    try {
      const result = await run(input.payload || {}, { user: user });
      return json(Object.assign({ ok: true }, result));
    } catch (error) {
      if (error instanceof InputError) return json({ error: 'input', message: error.message }, 400);
      console.error('admin ' + input.action + ':', error);
      return json({ error: 'server', message: 'Сервер не справился, попробуйте ещё раз' }, 500);
    }
  }
};
