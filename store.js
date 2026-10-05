/* Откуда приложение берёт содержимое.

   Основной путь — сервер (/api/boot): витрина, баннеры, задания и счёт
   того, кто зашёл, из общей базы. Правка в админке видна всем на следующем
   заходе. Сервер заодно отмечает человека в списке пользователей.

   Если сервер недоступен или база ещё не подключена, приложение не ломается:
   содержимое берётся из data/content.json в репозитории, а счёт — пустой. */
(() => {
  'use strict';

  const API = '/api/boot';
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

  function fromRepo() {
    return fetch(FALLBACK, { cache: 'no-cache' })
      .then((response) => response.json())
      .then((data) => { content = data; })
      .catch(() => { content = empty(); });
  }

  function load() {
    if (!ready) ready = fromServer().catch(fromRepo).then(() => content);
    return ready;
  }

  window.Store = {
    load: load,
    state: () => content,
    me: () => me,
    live: () => live
  };
})();
