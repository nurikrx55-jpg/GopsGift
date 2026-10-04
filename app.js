(() => {
  'use strict';

  const BG = '#0d0d0f';
  // requestFullscreen/exitFullscreen появились в Bot API 8.0
  const FULLSCREEN_API = '8.0';

  const tg = window.Telegram && window.Telegram.WebApp;
  const btn = document.getElementById('fullscreen-toggle');

  const hasTgFullscreen = () =>
    Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(FULLSCREEN_API));

  const hasNativeFullscreen = () =>
    Boolean(document.documentElement.requestFullscreen);

  const isFullscreen = () =>
    hasTgFullscreen() ? Boolean(tg.isFullscreen) : Boolean(document.fullscreenElement);

  function syncButton() {
    const on = isFullscreen();
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Выйти из полноэкранного режима' : 'Включить полноэкранный режим');
  }

  function toggleFullscreen() {
    if (tg && tg.HapticFeedback) {
      tg.HapticFeedback.impactOccurred('light');
    }

    if (hasTgFullscreen()) {
      if (tg.isFullscreen) {
        tg.exitFullscreen();
      } else {
        tg.requestFullscreen();
      }
      return;
    }

    // Вне Telegram (или на старом клиенте) — обычный Fullscreen API браузера
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
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

    if (hasTgFullscreen()) {
      tg.onEvent('fullscreenChanged', syncButton);
      tg.onEvent('fullscreenFailed', (event) => {
        console.warn('Fullscreen не включился:', event && event.error);
        syncButton();
      });
    }
  }

  function init() {
    initTelegram();

    if (hasTgFullscreen() || hasNativeFullscreen()) {
      btn.hidden = false;
      btn.addEventListener('click', toggleFullscreen);
      document.addEventListener('fullscreenchange', syncButton);
      syncButton();
    }
  }

  init();
})();
