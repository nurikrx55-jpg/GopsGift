/* Общее хранилище приложения и админки.

   Содержимое живёт в двух слоях. Нижний — data/content.json в репозитории:
   то, что видят все. Верхний — правки админа в этом браузере. Пока бэкенда
   нет, правки дальше устройства не уходят, поэтому в админке есть выгрузка:
   она отдаёт готовый content.json со всеми вложениями, и после публикации
   его видят все.

   Крупные вложения (анимации подарков, картинки баннеров) лежат отдельно в
   IndexedDB: в localStorage на них просто не хватило бы места. */
(() => {
  'use strict';

  const SOURCE = 'data/content.json';
  const DRAFT_KEY = 'gopsgift:draft';
  const DB_NAME = 'gopsgift';
  const DB_VERSION = 1;
  const ASSETS = 'assets';
  // Ссылка на вложение вместо пути к файлу
  const ASSET_PREFIX = 'asset:';

  let base = null;     // то, что лежит в репозитории
  let state = null;    // то, что показываем
  let ready = null;

  // --- IndexedDB: минимум, который нужен для «положить / взять / убрать» ---

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  function withAssets(mode, run) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(ASSETS, mode);
      const request = run(tx.objectStore(ASSETS));

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve(request ? request.result : undefined);
    }));
  }

  function assetKey(ref) {
    return String(ref).slice(ASSET_PREFIX.length);
  }

  // --- Слои содержимого ---

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeDraft(value) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(value));
      return true;
    } catch (_) {
      // Место кончилось — правка не потеряется только до перезагрузки
      return false;
    }
  }

  function load() {
    if (ready) return ready;

    ready = fetch(SOURCE, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error('content.json: ' + response.status);
        return response.json();
      })
      .catch(() => ({ gifts: [], banners: [], tasks: [], market: {}, defaults: {}, users: {}, admins: [] }))
      .then((loaded) => {
        // Выгруженный из админки файл несёт вложения с собой: переносим их
        // в базу, иначе на чужом устройстве ссылки указывали бы в пустоту
        const packed = loaded.assets || null;
        delete loaded.assets;

        base = loaded;
        const draft = readDraft();
        state = draft ? draft : clone(loaded);

        if (!packed) return state;

        return Promise.all(Object.keys(packed).map((key) =>
          withAssets('readwrite', (store) => store.put(packed[key], key))
        )).catch(() => {}).then(() => state);
      });

    return ready;
  }

  // --- Что отдаём приложению ---

  function gifts() {
    return (state && state.gifts) || [];
  }

  function gift(id) {
    return gifts().find((one) => one.id === id) || null;
  }

  function person(id) {
    const key = String(id);
    const users = (state && state.users) || {};
    const defaults = (state && state.defaults) || {};
    const saved = users[key] || {};

    return {
      id: key,
      name: saved.name || '',
      alias: saved.alias || '',
      verified: Boolean(saved.verified),
      gold: Boolean(saved.gold),
      stars: typeof saved.stars === 'number' ? saved.stars : (defaults.stars || 0),
      coupons: typeof saved.coupons === 'number' ? saved.coupons : (defaults.coupons || 0),
      // Подарки по умолчанию выданы каждому, у кого нет своего списка
      gifts: Array.isArray(saved.gifts) ? saved.gifts : (defaults.gifts || []).slice(),
      known: Object.prototype.hasOwnProperty.call(users, key)
    };
  }

  function isAdmin(id) {
    const list = (state && state.admins) || [];
    return list.map(String).indexOf(String(id)) !== -1;
  }

  // Анимация или картинка приходит либо файлом из репозитория, либо
  // вложением из базы. Вызывающему удобнее получить уже готовое.
  function resolveArt(ref) {
    if (!ref) return Promise.resolve(null);
    if (String(ref).indexOf(ASSET_PREFIX) !== 0) return Promise.resolve({ path: ref });

    return withAssets('readonly', (store) => store.get(assetKey(ref)))
      .then((value) => {
        if (!value) return null;
        if (value.kind === 'lottie') return { animationData: value.data };
        return { url: value.data };
      })
      .catch(() => null);
  }

  function resolveImage(ref) {
    if (!ref) return Promise.resolve('');
    if (String(ref).indexOf(ASSET_PREFIX) !== 0) return Promise.resolve(ref);

    return withAssets('readonly', (store) => store.get(assetKey(ref)))
      .then((value) => (value ? value.data : ''))
      .catch(() => '');
  }

  // --- Что может менять админка ---

  function update(change) {
    const next = typeof change === 'function' ? change(clone(state)) : change;
    if (!next) return false;

    state = next;
    return writeDraft(state);
  }

  function putAsset(key, kind, data) {
    // В базу уходит только то, что переживает сериализацию: случайная
    // функция внутри объекта уронила бы всю запись
    const clean = kind === 'lottie' ? JSON.parse(JSON.stringify(data)) : data;

    return withAssets('readwrite', (store) => store.put({ kind: kind, data: clean }, key))
      .then(() => ASSET_PREFIX + key);
  }

  function dropAsset(ref) {
    if (!ref || String(ref).indexOf(ASSET_PREFIX) !== 0) return Promise.resolve();
    return withAssets('readwrite', (store) => store.delete(assetKey(ref))).catch(() => {});
  }

  function listAssets() {
    return withAssets('readonly', (store) => store.getAllKeys()).catch(() => []);
  }

  // Выгрузка для публикации: вложения едут вместе с содержимым, иначе на
  // сервере останутся ссылки в никуда
  function exportAll() {
    return listAssets().then((keys) => {
      const wanted = keys.filter((key) => JSON.stringify(state).indexOf(ASSET_PREFIX + key) !== -1);

      return Promise.all(wanted.map((key) =>
        withAssets('readonly', (store) => store.get(key)).then((value) => [key, value])
      )).then((pairs) => {
        const bundle = clone(state);
        bundle.assets = {};
        pairs.forEach(([key, value]) => {
          if (value) bundle.assets[key] = value;
        });
        return bundle;
      });
    });
  }

  function importAll(bundle) {
    const assets = bundle.assets || {};
    const body = clone(bundle);
    delete body.assets;

    const puts = Object.keys(assets).map((key) =>
      withAssets('readwrite', (store) => store.put(assets[key], key))
    );

    return Promise.all(puts).then(() => {
      update(body);
      return body;
    });
  }

  function reset() {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (_) {}

    state = clone(base || {});
    return state;
  }

  function dirty() {
    return JSON.stringify(state) !== JSON.stringify(base);
  }

  window.Store = {
    ASSET_PREFIX: ASSET_PREFIX,
    load: load,
    state: () => state,
    base: () => base,
    gifts: gifts,
    gift: gift,
    person: person,
    isAdmin: isAdmin,
    resolveArt: resolveArt,
    resolveImage: resolveImage,
    update: update,
    putAsset: putAsset,
    dropAsset: dropAsset,
    exportAll: exportAll,
    importAll: importAll,
    reset: reset,
    dirty: dirty
  };
})();
