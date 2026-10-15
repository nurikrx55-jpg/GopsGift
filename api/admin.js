/* Всё, что умеет админка. Каждый запрос несёт initData: сервер сам
   проверяет подпись Telegram и сверяет id со списком админов — подделать
   доступ из браузера нельзя. */

import { configured } from './_lib/db.js';
import { verify, isAdmin, authMode } from './_lib/telegram.js';
import {
  readContent, writeContent, cleanGift, cleanBanner, cleanTasks, cleanTon, cleanMarket, cleanFees, TON_RECEIVER, InputError,
  listUsers, getUser, readRig, saveAccount, setBan, stats, saveLottie, saveSvg, saveImage, dropFile,
  listWithdrawals, resolveWithdraw, openWithdrawals, userLang, marketLog, lotCount, clearMarketLog, listLots, removeLot
} from './_lib/data.js';
import { withdrawClosed } from './_lib/notify.js';
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
    // Куда приходят пополнения TON — показываем в настройках
    return { content: content, stats: await stats(content), me: ctx.user, tonAddress: TON_RECEIVER };
  },

  async stats() {
    return { stats: await stats(await readContent(true)) };
  },

  // --- Оплата TON ---

  async 'ton.save'(payload) {
    const content = await writeContent((state) => {
      state.ton = cleanTon(payload.ton);
      return state;
    });

    return { content: content };
  },

  // --- Маркет: комиссия и минимальная цена ---

  async 'market.save'(payload) {
    const content = await writeContent((state) => {
      state.market = cleanMarket(payload.market);
      return state;
    });
    return { content: content };
  },

  // --- Рефералка и цена передачи ---

  async 'fees.save'(payload) {
    const content = await writeContent((state) => {
      state.fees = cleanFees(Object.assign({}, state.fees, payload.fees));
      return state;
    });
    return { content: content };
  },

  // История маркета — та же, что во вкладке «Активность» у людей
  async 'market.log'() {
    return { log: await marketLog(true), lots: await lotCount() };
  },

  // Лоты на продаже — админ может снять любой, например с ошибочной ценой
  async 'market.lots'() {
    return { lots: await listLots() };
  },

  async 'market.unlist'(payload) {
    await removeLot('', payload.lot, true);
    return { lots: await listLots() };
  },

  async 'market.clear'() {
    await clearMarketLog();
    return { log: [], lots: await lotCount() };
  },

  // --- Подарки ---

  // Модель для улучшения: файл грузим сразу, как только его выбрали, а в
  // подарок он попадёт ссылкой при сохранении
  async 'model.upload'(payload) {
    const svg = payload.kind === 'svg';
    const art = svg ? await saveSvg(payload.file) : await saveLottie(payload.file);
    return { art: art, artType: svg ? 'svg' : 'lottie' };
  },

  async 'gift.save'(payload) {
    const input = payload.gift || {};
    const svg = payload.kind === 'svg';
    let art = input.art;
    let artType = input.artType;

    if (payload.file) {
      art = svg ? await saveSvg(payload.file) : await saveLottie(payload.file);
      artType = svg ? 'svg' : 'lottie';
    }

    let stale = null;
    const content = await writeContent((state) => {
      state.gifts = state.gifts || [];
      const at = state.gifts.findIndex((one) => one.id === input.id);
      const gift = cleanGift(Object.assign({}, input, { art: art, artType: artType }));

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
    // Файлы убранных моделей не трогаем: на них ссылаются уже улучшенные
    return { content: content };
  },

  async 'gift.delete'(payload) {
    let gone = null;
    const content = await writeContent((state) => {
      gone = (state.gifts || []).find((one) => one.id === payload.id) || null;
      state.gifts = (state.gifts || []).filter((one) => one.id !== payload.id);
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

  // --- Задания ---

  async 'tasks.save'(payload) {
    const tasks = cleanTasks(payload.tasks);
    const content = await writeContent((state) => {
      state.tasks = tasks;
      return state;
    });
    return { content: content };
  },

  // --- Выводы ---

  async 'withdraw.list'(payload) {
    return await listWithdrawals(payload || {});
  },

  // Админ отправил TON сам или отказал: заявка закрывается, при отказе
  // сумма возвращается на баланс человека
  async 'withdraw.resolve'(payload, ctx) {
    const action = payload.action === 'done' ? 'done' : payload.action === 'reject' ? 'reject' : '';
    if (!action) throw new InputError('Неизвестное действие');
    const wd = await resolveWithdraw(payload.id, action, ctx.user.id);
    // Человеку — сообщение от бота: отправлено или отказ с возвратом
    const told = await withdrawClosed(wd, await userLang(wd.userId));
    return { withdrawal: wd, open: await openWithdrawals(), told: told };
  },

  // --- Люди ---

  async 'users.list'(payload) {
    return await listUsers(payload || {});
  },

  async 'user.get'(payload) {
    const user = await getUser(String(payload.id || ''));
    if (!user) throw new InputError('Такого пользователя нет');
    user.rigBackdrop = await readRig(user.id);
    return { user: user };
  },

  async 'user.save'(payload) {
    const id = String(payload.id || '');
    if (!/^\d{1,20}$/.test(id)) throw new InputError('Неверный id');

    const content = await readContent(true);
    await saveAccount(id, payload.account || {}, content);
    const user = await getUser(id);
    user.rigBackdrop = await readRig(id);
    return { user: user };
  },

  /* Бан и снятие бана. Забаненного не пускает ни заход в приложение, ни
     запрос в обход него. Админа забанить нельзя: иначе один владелец
     запер бы другого, да и себя заодно */
  async 'user.ban'(payload, ctx) {
    const id = String(payload.id || '');
    if (!/^\d{1,20}$/.test(id)) throw new InputError('Неверный id');

    const on = Boolean(payload.banned);
    if (on && isAdmin(id)) throw new InputError('Админа забанить нельзя');

    await setBan(id, on, ctx.user.id);
    const user = await getUser(id);
    user.rigBackdrop = await readRig(id);
    return { user: user };
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
