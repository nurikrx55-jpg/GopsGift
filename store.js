/* Откуда приложение берёт содержимое.

   Основной путь — сервер (/api/boot): витрина, баннеры, задания и счёт
   того, кто зашёл, из общей базы. Правка в админке видна всем на следующем
   заходе. Сервер заодно отмечает человека в списке пользователей.

   Если сервер недоступен или база ещё не подключена, приложение не ломается:
   содержимое берётся из data/content.json в репозитории, а счёт — пустой. */
(() => {
  'use strict';

  const API = '/api/boot';
  // Пока сервер не может проверить подпись, админа узнаём по id. Настоящую
  // проверку делает сервер, как только база подключена
  const ADMINS = ['8387706094'];
  const FALLBACK = 'data/content.json';
  // Админка открывается отдельной страницей; подпись Telegram передаём ей
  // через вкладку, а не адресом — в адресе она осела бы в истории
  const SESSION_KEY = 'gg:initData';

  let content = null;
  let me = null;
  let live = false;
  let ready = null;

  function initData() {
    const tg = window.Telegram && window.Telegram.WebApp;
    const data = (tg && tg.initData) || '';

    try {
      if (data) sessionStorage.setItem(SESSION_KEY, data);
    } catch (_) {}

    return data;
  }

  function empty() {
    return { gifts: [], banners: [], tasks: [], market: {}, defaults: {} };
  }

  function fromServer() {
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: initData() })
    }).then((response) => {
      if (!response.ok) throw new Error('boot ' + response.status);
      return response.json();
    }).then((data) => {
      content = data.content || empty();
      me = data.me || null;
      live = true;
    });
  }

  // Базы ещё нет: содержимое и счёт берём из локального двигателя, чтобы
  // приложение работало целиком уже сейчас
  function fromLocal() {
    const tg = window.Telegram && window.Telegram.WebApp;
    const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;

    if (!window.Local) return fromRepo();

    return window.Local.boot(user).then((data) => {
      content = data.content || empty();
      me = data.me || null;
      if (me) me.admin = ADMINS.indexOf(String(me.id)) !== -1;
    }).catch(fromRepo);
  }

  function fromRepo() {
    return fetch(FALLBACK, { cache: 'no-cache' })
      .then((response) => response.json())
      .then((data) => { content = data; })
      .catch(() => { content = empty(); });
  }

  function load() {
    if (!ready) ready = fromServer().catch(fromLocal).then(() => content);
    return ready;
  }

  window.Store = {
    load: load,
    state: () => content,
    me: () => me,
    live: () => live
  };
})();
