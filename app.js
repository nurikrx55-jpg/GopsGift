(() => {
  'use strict';

  const BG = '#0d0d10';
  // requestFullscreen появился в Bot API 8.0
  const FULLSCREEN_API = '8.0';
  const NAV_PADDING = 4;
  // За сколько пикселей движения жест считаем перетаскиванием, а не тапом
  const DRAG_THRESHOLD = 6;
  // Сколько экран загрузки держится минимум — чтобы не мигнуть и исчезнуть
  const SPLASH_MIN_MS = 1100;

  // Витрина подарков. art — распакованный .tgs: Lottie-JSON рядом в gifts/
  const GIFTS = [
    {
      id: 'beetle',
      name: 'Beetle',
      art: 'gifts/beetle.json',
      price: 2000,
      badge: 'limited',
      kind: 'default',
      note: 'Подарок скоро можно будет улучшить, продать и выпустить как NFT',
      left: 2,
      total: 200,
      status: 'Non-Unique'
    }
  ];

  // Насколько утянуть лист вниз, чтобы он закрылся
  const SHEET_CLOSE_DRAG = 110;
  // Резкий рывок закрывает, даже если утянули недалеко
  const SHEET_FLING = 0.7;
  // Остаток меньше этой доли — показываем, что подарок на исходе
  const SCARCE_SHARE = 0.1;

  const tg = window.Telegram && window.Telegram.WebApp;

  const nav = document.querySelector('._footer_1mfct_7');
  const indicator = document.querySelector('._indicator_1mfct_25');
  const tabs = Array.from(document.querySelectorAll('._tab_1mfct_40'));
  const stage = document.querySelector('.stage');
  const splash = document.getElementById('splash');
  const sliderTrack = document.getElementById('slider-track');
  const sliderDots = document.getElementById('slider-dots');
  const giftsGrid = document.getElementById('gifts');
  const sheet = document.getElementById('sheet');
  const sheetPanel = sheet && sheet.querySelector('.sheet__panel');
  const sheetScroll = sheet && sheet.querySelector('.sheet__scroll');

  let current = 0;

  const hasTgFullscreen = () =>
    Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(FULLSCREEN_API));

  function haptic(kind) {
    if (tg && tg.HapticFeedback) {
      tg.HapticFeedback[kind === 'select' ? 'selectionChanged' : 'impactOccurred'](
        kind === 'select' ? undefined : 'light'
      );
    }
  }

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

  // Подсветка иконок без переноса подложки — нужна во время перетаскивания
  function paint(index) {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.classList.toggle('active', active);

      if (active) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }

      const icons = tab.querySelectorAll('._icon_1mfct_146');
      icons[0].dataset.hidden = String(active);
      icons[1].dataset.hidden = String(!active);
    });
  }

  function selectTab(index) {
    if (index < 0 || index >= tabs.length) return;

    current = index;
    paint(index);
    nav.style.setProperty('--active-index', String(index));
    stage.dataset.section = tabs[index].dataset.section;
  }

  function slotWidth() {
    return (nav.getBoundingClientRect().width - NAV_PADDING * 2) / tabs.length;
  }

  function initDrag() {
    let pointerId = null;
    let startX = 0;
    let grab = 0;
    let slot = 0;
    let origin = 0;
    let offset = 0;
    let dragging = false;

    function nearest() {
      return Math.min(Math.max(Math.round(offset / slot), 0), tabs.length - 1);
    }

    nav.addEventListener('pointerdown', (event) => {
      if (pointerId !== null) return;

      pointerId = event.pointerId;
      slot = slotWidth();
      origin = nav.getBoundingClientRect().left + NAV_PADDING;
      startX = event.clientX;
      offset = current * slot;
      dragging = false;

      // Если палец лёг мимо капсулы — берём её за середину
      grab = event.clientX - origin - offset;
      if (grab < 0 || grab > slot) grab = slot / 2;

      // Захват не критичен: без него жест просто оборвётся за пределами панели
      try {
        nav.setPointerCapture(pointerId);
      } catch (_) {}
    });

    nav.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;

      if (!dragging) {
        if (Math.abs(event.clientX - startX) < DRAG_THRESHOLD) return;
        dragging = true;
        indicator.style.transition = 'none';
      }

      const max = (tabs.length - 1) * slot;
      offset = Math.min(Math.max(event.clientX - origin - grab, 0), max);
      indicator.style.transform = `translateX(${offset}px)`;

      // Иконки подсвечиваются ещё на лету, до отпускания
      const near = nearest();
      if (near !== current) {
        current = near;
        paint(near);
        haptic('select');
      }
    });

    function finish(event) {
      if (event.pointerId !== pointerId) return;

      try {
        if (nav.hasPointerCapture(pointerId)) {
          nav.releasePointerCapture(pointerId);
        }
      } catch (_) {}
      pointerId = null;

      if (!dragging) return;
      dragging = false;

      // Снимаем ручные стили — дальше позицию задаёт --active-index
      indicator.style.transition = '';
      indicator.style.transform = '';
      selectTab(nearest());
    }

    nav.addEventListener('pointerup', finish);
    nav.addEventListener('pointercancel', finish);

    // Клик после перетаскивания гасим, чтобы вкладка не перебила выбор
    nav.addEventListener('click', (event) => {
      if (dragging) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
  }

  function initNav() {
    nav.style.setProperty('--tabs', String(tabs.length));

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        if (index === current) return;

        haptic('select');
        selectTab(index);
      });
    });

    const initial = tabs.findIndex((tab) => tab.classList.contains('active'));
    selectTab(initial === -1 ? 0 : initial);
    initDrag();
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

  function initSlider() {
    if (!sliderTrack || !sliderDots) return;

    const slides = Array.from(sliderTrack.children);
    if (slides.length < 2) return;

    const dots = slides.map((slide, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'slider__dot';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', slide.getAttribute('aria-label') || `Баннер ${index + 1}`);

      dot.addEventListener('click', () => {
        sliderTrack.scrollTo({ left: slide.offsetLeft - sliderTrack.offsetLeft, behavior: 'smooth' });
      });

      sliderDots.appendChild(dot);
      return dot;
    });

    function sync() {
      // Ближайший к левому краю слайд и считается текущим
      const x = sliderTrack.scrollLeft;
      let active = 0;
      let best = Infinity;

      slides.forEach((slide, index) => {
        const distance = Math.abs(slide.offsetLeft - sliderTrack.offsetLeft - x);
        if (distance < best) {
          best = distance;
          active = index;
        }
      });

      dots.forEach((dot, index) => {
        const on = index === active;
        dot.classList.toggle('is-active', on);
        dot.setAttribute('aria-selected', String(on));
      });
    }

    sliderTrack.addEventListener('scroll', () => {
      // Точки обновляем на кадре отрисовки, а не на каждом событии прокрутки
      window.requestAnimationFrame(sync);
    }, { passive: true });

    window.addEventListener('resize', sync);
    sync();
  }

  // 2000 -> «2 000». Пробел неразрывный, иначе число рвётся на две строки
  function formatPrice(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  }

  function buildGift(gift) {
    const card = document.createElement('article');
    card.className = 'gift';

    const art = document.createElement('div');
    art.className = 'gift__art';
    art.dataset.art = gift.art;
    if (gift.name) art.setAttribute('aria-label', gift.name);
    card.appendChild(art);

    if (gift.badge) {
      const badge = document.createElement('span');
      badge.className = 'gift__badge';
      badge.dataset.kind = gift.kind || 'default';
      // Контур ленты лежит в спрайте, здесь только ссылка на него
      badge.innerHTML =
        '<svg class="gift__ribbon" viewBox="0 0 98 26" aria-hidden="true">' +
        '<use href="#ribbon-shape"></use></svg>';

      const label = document.createElement('span');
      label.className = 'gift__label';
      label.textContent = gift.badge;
      badge.appendChild(label);
      card.appendChild(badge);
    }

    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.addEventListener('click', () => {
      haptic('light');
      openSheet(gift);
    });
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openSheet(gift);
    });

    const price = document.createElement('span');
    price.className = 'gift__price';

    const star = document.createElement('img');
    star.className = 'gift__star';
    star.src = 'gifts/star.png';
    star.alt = 'звёзд';
    star.draggable = false;

    const amount = document.createElement('span');
    amount.className = 'gift__amount';
    amount.textContent = formatPrice(gift.price);

    price.append(star, amount);
    card.appendChild(price);

    return card;
  }

  // lottie подключён с defer — когда app.js выполняется, его ещё нет в window
  function whenLottieReady(run) {
    if (window.lottie) {
      run();
      return;
    }

    const check = () => {
      if (window.lottie) run();
      else console.warn('lottie не загрузился — карточки останутся без анимации');
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', check, { once: true });
    } else {
      check();
    }
  }

  // Анимации заводим только у видимых карточек и тормозим ушедшие за край:
  // на витрине их будут десятки, крутить все разом — зря греть телефон
  function initGiftArt() {
    const holders = Array.from(giftsGrid.querySelectorAll('.gift__art'));
    if (!holders.length) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Ретина: рисуем в большем разрешении, выше 2x смысла нет
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const players = new Map();

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const player = players.get(entry.target);

        if (!player) {
          if (!entry.isIntersecting) return;

          players.set(entry.target, window.lottie.loadAnimation({
            container: entry.target,
            renderer: 'canvas',
            loop: !still,
            autoplay: !still,
            path: entry.target.dataset.art,
            rendererSettings: { dpr: dpr }
          }));
          return;
        }

        if (still) return;
        if (entry.isIntersecting) player.play();
        else player.pause();
      });
    }, { rootMargin: '120px' });

    holders.forEach((holder) => observer.observe(holder));
  }

  // --- Карточка подарка крупным планом ---

  let sheetPlayer = null;   // отдельный экземпляр анимации, живёт только пока лист открыт
  let sheetGift = null;

  function fillSheet(gift) {
    document.getElementById('sheet-title').textContent = gift.name;
    document.getElementById('sheet-note').textContent = gift.note || '';
    document.getElementById('sheet-status').textContent = gift.status || '—';
    document.getElementById('sheet-price').textContent = formatPrice(gift.price);
    document.getElementById('sheet-buy-price').textContent = formatPrice(gift.price);

    const badge = document.getElementById('sheet-badge');
    badge.hidden = !gift.badge;
    if (gift.badge) {
      badge.dataset.kind = gift.kind || 'default';
      document.getElementById('sheet-badge-label').textContent = gift.badge;
    }

    const known = typeof gift.left === 'number' && typeof gift.total === 'number';
    const left = document.getElementById('sheet-left');
    const gauge = document.getElementById('sheet-gauge');

    left.textContent = known ? formatPrice(gift.left) + ' из ' + formatPrice(gift.total) : '—';
    gauge.hidden = !known;

    if (known) {
      const rest = gift.total ? gift.left / gift.total : 0;
      // Шкала показывает разобранное, а не остаток: при 2 из 200 полоска в
      // полтора процента читалась бы как сбой, а не как «почти всё ушло»
      const taken = Math.min(Math.max(1 - rest, 0), 1);

      gauge.dataset.scarce = String(rest <= SCARCE_SHARE);
      gauge.setAttribute('aria-label',
        'Разобрано ' + (gift.total - gift.left) + ' из ' + gift.total);

      // Ширину ставим после открытия — иначе шкала появится уже заполненной
      document.getElementById('sheet-gauge-fill').style.width = '0%';
      sheet.dataset.fill = (taken * 100).toFixed(1) + '%';
    }
  }

  function openSheet(gift) {
    if (!sheet || sheet.dataset.open === 'true') return;

    sheetGift = gift;
    fillSheet(gift);

    sheet.hidden = false;
    sheet.dataset.open = 'true';
    // Сцена под листом не должна прокручиваться вместе с ним
    if (stage) stage.style.overflow = 'hidden';

    // Между снятием hidden и классом браузер обязан пересчитать стили, иначе
    // перехода не будет. Читаем размер — это форсирует пересчёт синхронно;
    // через requestAnimationFrame было бы ненадёжно: в фоновой вкладке кадры
    // не идут, и лист открылся бы рывком.
    void sheetPanel.offsetHeight;

    sheet.classList.add('is-open');
    if (sheet.dataset.fill) {
      document.getElementById('sheet-gauge-fill').style.width = sheet.dataset.fill;
    }

    if (window.lottie) {
      sheetPlayer = window.lottie.loadAnimation({
        container: document.getElementById('sheet-art'),
        renderer: 'canvas',
        loop: true,
        autoplay: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        path: gift.art,
        rendererSettings: { dpr: Math.min(window.devicePixelRatio || 1, 2) }
      });
    }
  }

  function closeSheet() {
    if (!sheet || sheet.dataset.open !== 'true') return;

    sheet.dataset.open = 'false';
    sheet.classList.remove('is-open', 'is-dragging');
    sheetPanel.style.transform = '';

    const done = () => {
      sheet.hidden = true;
      if (stage) stage.style.overflow = '';
      if (sheetPlayer) {
        sheetPlayer.destroy();
        sheetPlayer = null;
      }
      sheetGift = null;
    };

    // Ждём конец выезда, но не полагаемся на событие целиком
    let fired = false;
    const onEnd = (event) => {
      if (event.target !== sheetPanel || event.propertyName !== 'transform') return;
      fired = true;
      sheetPanel.removeEventListener('transitionend', onEnd);
      done();
    };
    sheetPanel.addEventListener('transitionend', onEnd);
    setTimeout(() => {
      if (fired) return;
      sheetPanel.removeEventListener('transitionend', onEnd);
      done();
    }, 500);
  }

  // Утягивание листа вниз пальцем
  function initSheetDrag() {
    let pointerId = null;
    let startY = 0;
    let startAt = 0;
    let shift = 0;
    let dragging = false;

    sheetPanel.addEventListener('pointerdown', (event) => {
      if (pointerId !== null || sheet.dataset.open !== 'true') return;
      // Если содержимое прокручено, жест принадлежит ему, а не листу
      if (sheetScroll.scrollTop > 0) return;

      pointerId = event.pointerId;
      startY = event.clientY;
      startAt = event.timeStamp;
      shift = 0;
      dragging = false;
    });

    sheetPanel.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;

      const dy = event.clientY - startY;
      // Вверх лист не тянется
      if (dy <= 0 && !dragging) return;

      if (!dragging) {
        if (dy < DRAG_THRESHOLD) return;
        dragging = true;
        sheet.classList.add('is-dragging');
        try {
          sheetPanel.setPointerCapture(pointerId);
        } catch (_) {}
      }

      shift = Math.max(dy, 0);
      sheetPanel.style.transform = 'translateY(' + shift + 'px)';
    });

    function release(event) {
      if (event.pointerId !== pointerId) return;

      try {
        if (sheetPanel.hasPointerCapture(pointerId)) {
          sheetPanel.releasePointerCapture(pointerId);
        }
      } catch (_) {}
      pointerId = null;

      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('is-dragging');

      const speed = shift / Math.max(event.timeStamp - startAt, 1);
      if (shift > SHEET_CLOSE_DRAG || speed > SHEET_FLING) {
        haptic('light');
        closeSheet();
      } else {
        // Не дотянули — лист возвращается на место
        sheetPanel.style.transform = '';
      }
    }

    sheetPanel.addEventListener('pointerup', release);
    sheetPanel.addEventListener('pointercancel', release);
  }

  function initSheet() {
    if (!sheet) return;

    sheet.querySelectorAll('[data-sheet-close]').forEach((node) => {
      node.addEventListener('click', () => {
        haptic('light');
        closeSheet();
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSheet();
    });

    document.getElementById('sheet-buy').addEventListener('click', () => {
      haptic('light');
      // Оплата появится вместе с серверной частью
      if (tg && tg.showAlert && sheetGift) {
        tg.showAlert('Покупка «' + sheetGift.name + '» скоро заработает');
      }
    });

    initSheetDrag();
  }

  function initGifts() {
    if (!giftsGrid) return;

    GIFTS.forEach((gift) => giftsGrid.appendChild(buildGift(gift)));
    whenLottieReady(initGiftArt);
  }

  function initSplash() {
    if (!splash) return;

    const started = performance.now();

    const hide = () => {
      const wait = Math.max(0, SPLASH_MIN_MS - (performance.now() - started));
      setTimeout(() => splash.classList.add('is-done'), wait);
    };

    if (document.readyState === 'complete') {
      hide();
    } else {
      window.addEventListener('load', hide, { once: true });
      // Если какой-то ресурс завис, всё равно показываем приложение
      setTimeout(hide, 4000);
    }
  }

  initTelegram();
  initNav();
  initSlider();
  initGifts();
  initSheet();
  initSplash();
})();
