/* Запасной двигатель на время, пока нет общей базы.

   Приложение и админка ходят на сервер (/api/boot, /api/admin). Пока база
   не подключена, сервер отвечает 503 — и оба переключаются сюда: те же
   действия, но хранилище в самом браузере. Так проект работает и
   проверяется целиком уже сейчас.

   Набор действий и формат записей совпадают с серверными намеренно: когда
   база появится, всё переедет на неё без правок в коде экранов.

   Чего локальное хранилище не умеет и уметь не может: правки видит только
   это устройство, а в списке людей оказываются лишь те, кто открывал
   приложение здесь же. */
(() => {
  'use strict';

  const SEED = 'data/content.json';
  const KEY_CONTENT = 'gg:local:content';
  const KEY_ACCOUNTS = 'gg:local:accounts';
  const KEY_USERS = 'gg:local:users';
  const DB_NAME = 'gopsgift';
  const DB_VERSION = 1;
  const FILES = 'files';
  // Ссылка на загруженный файл: в адресе его нет, он лежит в базе браузера
  const LOCAL = 'local:';
  const DAY = 24 * 60 * 60 * 1000;

  let content = null;
  let ready = null;

  // --- Хранилище ---

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // Загруженные анимации и картинки крупные, поэтому им отдельное место:
  // в localStorage они бы не поместились
  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function withFiles(mode, run) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(FILES, mode);
      const request = run(tx.objectStore(FILES));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve(request ? request.result : undefined);
    }));
  }

  function newId(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 10);
  }

  function putFile(blob, prefix) {
    const id = newId(prefix);
    return withFiles('readwrite', (store) => store.put(blob, id)).then(() => LOCAL + id);
  }

  // Приходит то же, что ушло бы на сервер: файл строкой base64
  function bytesFrom(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  let pakoReady = null;

  function loadPako() {
    if (!pakoReady) {
      pakoReady = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
        script.onload = () => resolve(window.pako);
        script.onerror = () => reject(new Error('pako'));
        document.head.appendChild(script);
      });
    }
    return pakoReady;
  }

  // .tgs — это json под gzip. Браузер читает только json, поэтому в базу
  // кладём уже распакованным: на сервере то же делает /api/file
  function putLottie(base64) {
    const bytes = bytesFrom(base64);
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;

    const unpack = !gzipped
      ? Promise.resolve(bytes)
      : (typeof window.DecompressionStream === 'function'
        ? new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')))
          .arrayBuffer().then((buffer) => new Uint8Array(buffer))
        : loadPako().then((pako) => pako.inflate(bytes)));

    return unpack.then((json) => putFile(new Blob([json], { type: 'application/json' }), 'a'));
  }

  function putImage(base64, type) {
    return putFile(new Blob([bytesFrom(base64)], { type: type || 'image/webp' }), 'i');
  }

  function dropFile(ref) {
    if (!ref || String(ref).indexOf(LOCAL) !== 0) return Promise.resolve();
    return withFiles('readwrite', (store) => store.delete(String(ref).slice(LOCAL.length))).catch(() => {});
  }

  // Адреса на время сеанса: разметка работает с обычными ссылками и не знает,
  // что файл лежит в браузере
  const urls = new Map();

  function linkFor(ref) {
    if (urls.has(ref)) return Promise.resolve(urls.get(ref));

    return withFiles('readonly', (store) => store.get(String(ref).slice(LOCAL.length)))
      .then((blob) => {
        if (!blob) return '';
        const url = URL.createObjectURL(blob);
        urls.set(ref, url);
        return url;
      })
      .catch(() => '');
  }

  // Подменяем ссылки на файлы прямо в копии содержимого — остальной код
  // дальше работает с обычными адресами
  function hydrate(state) {
    const copy = clone(state);
    const jobs = [];

    (copy.gifts || []).forEach((gift) => {
      if (String(gift.art).indexOf(LOCAL) !== 0) return;
      jobs.push(linkFor(gift.art).then((url) => { gift.art = url || gift.art; }));
    });

    (copy.banners || []).forEach((banner) => {
      if (String(banner.image).indexOf(LOCAL) !== 0) return;
      jobs.push(linkFor(banner.image).then((url) => { banner.image = url || banner.image; }));
    });

    return Promise.all(jobs).then(() => copy);
  }

  // --- Содержимое ---

  function load() {
    if (ready) return ready;

    const saved = read(KEY_CONTENT, null);
    if (saved) {
      content = saved;
      ready = Promise.resolve(content);
      return ready;
    }

    ready = fetch(SEED, { cache: 'no-cache' })
      .then((response) => response.json())
      .catch(() => ({ gifts: [], banners: [], tasks: [], market: {}, defaults: {} }))
      .then((seed) => {
        content = {
          gifts: seed.gifts || [],
          banners: seed.banners || [],
          tasks: seed.tasks || [],
          market: seed.market || {},
          defaults: seed.defaults || { stars: 0, coupons: 0, gifts: [] },
          updatedAt: Date.now()
        };
        return content;
      });

    return ready;
  }

  function save(change) {
    const next = change(clone(content)) || content;
    next.updatedAt = Date.now();
    content = next;
    write(KEY_CONTENT, content);
    return hydrate(content);
  }

  // --- Люди ---

  function accounts() {
    return read(KEY_ACCOUNTS, {});
  }

  function users() {
    return read(KEY_USERS, {});
  }

  function starter() {
    const defaults = content.defaults || {};
    return {
      stars: Number(defaults.stars) || 0,
      coupons: Number(defaults.coupons) || 0,
      gifts: (defaults.gifts || []).slice(),
      gold: false,
      verified: false
    };
  }

  function account(id) {
    const saved = accounts()[String(id)];
    if (!saved) return starter();
    return {
      stars: Number(saved.stars) || 0,
      coupons: Number(saved.coupons) || 0,
      gifts: Array.isArray(saved.gifts) ? saved.gifts : [],
      gold: Boolean(saved.gold),
      verified: Boolean(saved.verified)
    };
  }

  function person(id) {
    const profile = users()[String(id)] || { id: String(id) };
    return Object.assign({ id: String(id) }, profile, account(id));
  }

  // Заход в приложение: запоминаем профиль и заводим счёт новичку
  function touch(tg) {
    const id = String(tg.id);
    const all = users();
    const now = Date.now();
    const before = all[id] || {};

    all[id] = {
      id: id,
      username: tg.username || '',
      firstName: tg.first_name || '',
      lastName: tg.last_name || '',
      photo: /^https:\/\//.test(tg.photo_url || '') ? tg.photo_url : '',
      lang: tg.language_code || '',
      tgPremium: Boolean(tg.is_premium),
      firstSeen: before.firstSeen || now,
      lastSeen: now,
      visits: (Number(before.visits) || 0) + 1
    };
    write(KEY_USERS, all);

    const money = accounts();
    if (!money[id]) {
      money[id] = starter();
      write(KEY_ACCOUNTS, money);
    }

    return person(id);
  }

  function everyone() {
    return Object.keys(users())
      .map(person)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  function matches(one, query) {
    const q = query.toLowerCase().replace(/^@/, '');
    return [one.id, one.username, one.firstName, one.lastName,
      (one.firstName || '') + ' ' + (one.lastName || '')]
      .some((value) => String(value || '').toLowerCase().indexOf(q) !== -1);
  }

  function stats() {
    const all = everyone();
    const now = Date.now();
    return {
      users: all.length,
      active: all.filter((one) => now - (one.lastSeen || 0) < DAY).length,
      fresh: all.filter((one) => now - (one.firstSeen || 0) < DAY).length,
      week: all.filter((one) => now - (one.lastSeen || 0) < 7 * DAY).length,
      gifts: (content.gifts || []).length,
      banners: (content.banners || []).length
    };
  }

  // --- Действия админки: те же имена, что на сервере ---

  function reorder(list, ids) {
    const byId = new Map(list.map((one) => [one.id, one]));
    const sorted = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    list.forEach((one) => {
      if (sorted.indexOf(one) === -1) sorted.push(one);
    });
    return sorted;
  }

  const actions = {
    session: () => hydrate(content).then((state) => ({ content: state, stats: stats() })),
    stats: () => Promise.resolve({ stats: stats() }),

    'gift.save': (payload) => {
      const input = payload.gift || {};
      const start = payload.file ? putLottie(payload.file) : Promise.resolve(input.art);

      return start.then((art) => {
        let stale = null;
        return save((state) => {
          state.gifts = state.gifts || [];
          const at = state.gifts.findIndex((one) => one.id === input.id);
          const gift = {
            id: input.id || newId('gift'),
            name: String(input.name || '').trim(),
            art: art,
            price: Number(input.price) || 0,
            badge: String(input.badge || '').trim(),
            kind: input.kind || 'default',
            total: Number(input.total) || 0,
            left: Math.min(Number(input.left) || 0, Number(input.total) || 0),
            status: String(input.status || '').trim() || 'Non-Unique'
          };

          if (at === -1) state.gifts.push(gift);
          else {
            if (state.gifts[at].art !== gift.art) stale = state.gifts[at].art;
            state.gifts[at] = gift;
          }
          return state;
        }).then((state) => dropFile(stale).then(() => ({ content: state })));
      });
    },

    'gift.delete': (payload) => {
      let gone = null;
      return save((state) => {
        gone = (state.gifts || []).find((one) => one.id === payload.id) || null;
        state.gifts = (state.gifts || []).filter((one) => one.id !== payload.id);
        if (state.defaults && Array.isArray(state.defaults.gifts)) {
          state.defaults.gifts = state.defaults.gifts.filter((one) => one !== payload.id);
        }
        return state;
      }).then((state) => dropFile(gone && gone.art).then(() => ({ content: state })));
    },

    'gift.order': (payload) => save((state) => {
      state.gifts = reorder(state.gifts || [], payload.ids);
      return state;
    }).then((state) => ({ content: state })),

    'banner.save': (payload) => {
      const input = payload.banner || {};
      const start = payload.file ? putImage(payload.file, payload.type) : Promise.resolve(input.image);

      return start.then((image) => {
        let stale = null;
        return save((state) => {
          state.banners = state.banners || [];
          const at = state.banners.findIndex((one) => one.id === input.id);
          const banner = {
            id: input.id || newId('banner'),
            image: image,
            label: String(input.label || '').trim() || 'Баннер',
            href: String(input.href || '').trim()
          };

          if (at === -1) state.banners.push(banner);
          else {
            if (state.banners[at].image !== banner.image) stale = state.banners[at].image;
            state.banners[at] = banner;
          }
          return state;
        }).then((state) => dropFile(stale).then(() => ({ content: state })));
      });
    },

    'banner.delete': (payload) => {
      let gone = null;
      return save((state) => {
        gone = (state.banners || []).find((one) => one.id === payload.id) || null;
        state.banners = (state.banners || []).filter((one) => one.id !== payload.id);
        return state;
      }).then((state) => dropFile(gone && gone.image).then(() => ({ content: state })));
    },

    'banner.order': (payload) => save((state) => {
      state.banners = reorder(state.banners || [], payload.ids);
      return state;
    }).then((state) => ({ content: state })),

    'tasks.save': (payload) => save((state) => {
      state.tasks = (payload.tasks || []).map((group) => ({
        id: group.id || newId('block'),
        title: String(group.title || '').trim() || 'Без названия',
        items: (group.items || []).map((task) => ({
          id: task.id || newId('task'),
          name: String(task.name || '').trim() || 'Задание',
          reward: Number(task.reward) || 0,
          goal: Math.max(1, Number(task.goal) || 1)
        }))
      }));
      return state;
    }).then((state) => ({ content: state })),

    'market.save': (payload) => save((state) => {
      state.market = Object.assign({}, state.market, { opensAt: payload.opensAt || '' });
      return state;
    }).then((state) => ({ content: state })),

    'defaults.save': (payload) => save((state) => {
      const known = (state.gifts || []).map((gift) => gift.id);
      state.defaults = {
        stars: Math.max(0, Number(payload.stars) || 0),
        coupons: Math.max(0, Number(payload.coupons) || 0),
        gifts: (payload.gifts || []).filter((id) => known.indexOf(id) !== -1)
      };
      return state;
    }).then((state) => ({ content: state })),

    'users.list': (payload) => {
      const query = String(payload.query || '').trim();
      const filter = payload.filter || 'all';
      const offset = Number(payload.offset) || 0;
      const limit = Number(payload.limit) || 40;

      let found = everyone();
      if (filter === 'new') found = found.slice().sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
      if (filter === 'gold') found = found.filter((one) => one.gold);
      if (filter === 'verified') found = found.filter((one) => one.verified);
      if (filter === 'premium') found = found.filter((one) => one.tgPremium);
      if (query) found = found.filter((one) => matches(one, query));

      return Promise.resolve({ items: found.slice(offset, offset + limit), total: found.length });
    },

    'user.get': (payload) => Promise.resolve({ user: person(payload.id) }),

    'user.save': (payload) => {
      const id = String(payload.id || '');
      const input = payload.account || {};
      const known = (content.gifts || []).map((gift) => gift.id);
      const all = accounts();

      all[id] = {
        stars: Math.max(0, Number(input.stars) || 0),
        coupons: Math.max(0, Number(input.coupons) || 0),
        gifts: (input.gifts || []).filter((one) => known.indexOf(one) !== -1),
        gold: Boolean(input.gold),
        verified: Boolean(input.verified)
      };
      write(KEY_ACCOUNTS, all);

      return Promise.resolve({ user: person(id) });
    },

    'users.grant': (payload) => {
      const known = (content.gifts || []).map((gift) => gift.id);
      const gift = known.indexOf(payload.gift) !== -1 ? payload.gift : '';
      const stars = Math.max(0, Number(payload.stars) || 0);
      const coupons = Math.max(0, Number(payload.coupons) || 0);

      const all = accounts();
      const ids = Object.keys(users());
      ids.forEach((id) => {
        const money = all[id] || starter();
        if (gift) money.gifts = (money.gifts || []).concat(gift);
        money.stars = (Number(money.stars) || 0) + stars;
        money.coupons = (Number(money.coupons) || 0) + coupons;
        all[id] = money;
      });
      write(KEY_ACCOUNTS, all);

      return Promise.resolve({ count: ids.length });
    }
  };

  function call(action, payload) {
    return load().then(() => {
      const run = actions[action];
      if (!run) return Promise.reject(new Error('unknown-action'));
      return Promise.resolve(run(payload || {})).then((result) => Object.assign({ ok: true }, result));
    });
  }

  // Что отдаём приложению на заходе — в точности как сервер
  function boot(tg) {
    return load()
      .then(() => hydrate(content))
      .then((state) => ({
        content: state,
        me: tg ? touch(tg) : null
      }));
  }

  window.Local = {
    boot: boot,
    call: call,
    stats: () => load().then(stats)
  };
})();
