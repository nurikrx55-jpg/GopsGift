(() => {
  'use strict';

  const BG = '#0d0d0f';
  // requestFullscreen появился в Bot API 8.0
  const FULLSCREEN_API = '8.0';

  const tg = window.Telegram && window.Telegram.WebApp;

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

  function init() {
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

  init();
})();
