(() => {
  'use strict';

  const BG = '#0d0d10';
  // requestFullscreen появился в Bot API 8.0
  const FULLSCREEN_API = '8.0';

  const tg = window.Telegram && window.Telegram.WebApp;

  const nav = document.querySelector('._footer_1mfct_7');
  const tabs = Array.from(document.querySelectorAll('._tab_1mfct_40'));
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

  function selectTab(index) {
    if (index < 0 || index >= tabs.length) return;

    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.classList.toggle('active', active);

      if (active) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }

      // Внутри вкладки две иконки: [0] контурная, [1] заливка
      const icons = tab.querySelectorAll('._icon_1mfct_146');
      icons[0].dataset.hidden = String(active);
      icons[1].dataset.hidden = String(!active);
    });

    nav.style.setProperty('--active-index', String(index));
    stage.dataset.section = tabs[index].dataset.section;
  }

  function initNav() {
    nav.style.setProperty('--tabs', String(tabs.length));

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        if (tab.classList.contains('active')) return;

        if (tg && tg.HapticFeedback) {
          tg.HapticFeedback.selectionChanged();
        }

        selectTab(index);
      });
    });

    const initial = tabs.findIndex((tab) => tab.classList.contains('active'));
    selectTab(initial === -1 ? 0 : initial);
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
