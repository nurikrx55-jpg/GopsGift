(() => {
  'use strict';

  const BG = '#0d0d10';
  // requestFullscreen появился в Bot API 8.0
  const FULLSCREEN_API = '8.0';

  const tg = window.Telegram && window.Telegram.WebApp;

  const nav = document.querySelector('.nav');
  const items = Array.from(document.querySelectorAll('.nav__item'));
  const stage = document.querySelector('.stage');

  const hasTgFullscreen = () =>
    Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(FULLSCREEN_API));

  function enterFullscreen() {
    if (!hasTgFullscreen() || tg.isFullscreen) return;

    tg.onEvent('fullscreenFailed', (event) => {
      const error = event && event.error;
      if (error !== 'ALREADY_FULLSCREEN') {
        console.warn('Fullscreen не включился:', error);
      }
    });

    tg.requestFullscreen();
  }

  function selectSection(index) {
    if (index < 0 || index >= items.length) return;

    items.forEach((item, i) => {
      const active = i === index;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });

    // Подложка едет за активной иконкой
    nav.style.setProperty('--nav-active', String(index));
    stage.dataset.section = items[index].dataset.section;
  }

  function initNav() {
    nav.style.setProperty('--nav-items', String(items.length));

    items.forEach((item, index) => {
      item.addEventListener('click', () => {
        if (item.classList.contains('is-active')) return;

        if (tg && tg.HapticFeedback) {
          tg.HapticFeedback.selectionChanged();
        }

        selectSection(index);
      });
    });

    const initial = items.findIndex((item) => item.classList.contains('is-active'));
    selectSection(initial === -1 ? 0 : initial);
  }

  function initTelegram() {
    if (!tg) return;

    tg.ready();
    tg.expand();

    // Методы ниже из разных версий Bot API — на старых клиентах молча пропускаем
    try {
      tg.setHeaderColor(BG);
      tg.setBackgroundColor(BG);
    } catch (_) {}

    if (tg.disableVerticalSwipes) {
      tg.disableVerticalSwipes();
    }

    enterFullscreen();
  }

  initTelegram();
  initNav();
})();
