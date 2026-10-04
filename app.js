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
  // Сколько висит всплывающее уведомление
  const TOAST_MS = 1900;

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
  // Потолок на случай, если наличие не указано
  const QTY_MAX = 99;

  // Балансы брать пока неоткуда — появится счёт, подставить сюда
  const STARS = 0;
  const COUPONS = 0;
  // Подарки пользователя по разделам переключателя
  const OWNED = { gifts: [], nft: [] };

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
    if (!tg || !tg.HapticFeedback) return;

    if (kind === 'select') tg.HapticFeedback.selectionChanged();
    else if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
    else tg.HapticFeedback.impactOccurred('light');
  }

  // Всплывающее уведомление: показывается у верхнего края и само уходит
  let toastHide = null;
  let toastDrop = null;

  function toast(text) {
    const node = document.getElementById('toast');
    if (!node) return;

    document.getElementById('toast-text').textContent = text;
    clearTimeout(toastHide);
    clearTimeout(toastDrop);

    node.hidden = false;
    // Пересчёт стилей форсируем чтением размера — иначе перехода не будет
    void node.offsetHeight;
    node.classList.add('is-on');

    toastHide = setTimeout(() => {
      node.classList.remove('is-on');
      toastDrop = setTimeout(() => {
        node.hidden = true;
      }, 320);
    }, TOAST_MS);
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

    // Витрина и лист свёрстаны под вертикаль: в ландшафте подарок и модалка
    // ложатся набок. Замок появился в Bot API 8.0 вместе с fullscreen.
    if (hasTgFullscreen() && tg.lockOrientation) {
      try {
        tg.lockOrientation();
      } catch (_) {}
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

  // Один прогон и остановка на последнем кадре — так ведут себя все анимации
  // в приложении, кроме той, что в раскрытой карточке.
  function playOnce(container, path) {
    if (!window.lottie) return null;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const player = window.lottie.loadAnimation({
      container: container,
      renderer: 'canvas',
      loop: false,
      autoplay: !still,
      path: path,
      // Ретина: рисуем в большем разрешении, выше 2x смысла нет
      rendererSettings: { dpr: Math.min(window.devicePixelRatio || 1, 2) }
    });

    // У некоторых композиций нулевой кадр пустой: просто не запускать нельзя,
    // иначе на месте анимации останется пустое место
    if (still) {
      player.addEventListener('DOMLoaded', () => {
        player.goToAndStop(player.totalFrames - 1, true);
      });
    }

    return player;
  }

  // Анимацию нельзя заводить, пока её контейнер не показался на экране: у
  // скрытого блока нулевой размер, и lottie нарисует canvas шириной 0, который
  // сам потом не пересчитает. Наблюдатель срабатывает только когда у элемента
  // появился размер, и это разом решает обе задачи — и размер, и экономию.
  function playWhenSeen(container, path, onReady) {
    whenLottieReady(() => {
      const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;

          obs.unobserve(entry.target);
          const player = playOnce(entry.target, path);
          if (onReady) onReady(player);
        });
      }, { rootMargin: '120px' });

      observer.observe(container);
      if (onReady) onReady(null, observer);
    });
  }

  // Анимацию заводим, только когда карточка показалась на экране: на витрине
  // их будут десятки, грузить все разом незачем.
  function initGiftArt() {
    const holders = Array.from(giftsGrid.querySelectorAll('.gift__art'));
    if (!holders.length) return;

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        // Один прогон — наблюдать дальше не за чем
        observer.unobserve(entry.target);
        playOnce(entry.target, entry.target.dataset.art);
      });
    }, { rootMargin: '120px' });

    holders.forEach((holder) => observer.observe(holder));
  }

  // --- Карточка подарка крупным планом ---

  let sheetPlayer = null;   // отдельный экземпляр анимации, живёт только пока лист открыт
  let sheetGift = null;
  let qty = 1;

  // Набрать больше, чем есть в наличии, нельзя
  function qtyLimit() {
    if (!sheetGift) return 1;
    const left = typeof sheetGift.left === 'number' ? sheetGift.left : QTY_MAX;
    return Math.max(1, Math.min(left, QTY_MAX));
  }

  function setQty(value) {
    if (!sheetGift) return;

    const limit = qtyLimit();
    qty = Math.min(Math.max(value, 1), limit);

    document.getElementById('qty-value').textContent = String(qty);
    document.getElementById('qty-less').disabled = qty <= 1;
    document.getElementById('qty-more').disabled = qty >= limit;
    document.getElementById('sheet-buy-price').textContent = formatPrice(sheetGift.price * qty);
  }

  function fillSheet(gift) {
    document.getElementById('sheet-title').textContent = gift.name;
    document.getElementById('sheet-note').textContent = gift.note || '';
    document.getElementById('sheet-status').textContent = gift.status || '—';
    document.getElementById('sheet-price').textContent = formatPrice(gift.price);

    const known = typeof gift.left === 'number' && typeof gift.total === 'number';
    const left = document.getElementById('sheet-left');
    const rest = document.getElementById('sheet-rest');
    const gauge = document.getElementById('sheet-gauge');

    left.textContent = known
      ? formatPrice(gift.total - gift.left) + '/' + formatPrice(gift.total) + ' выпущено'
      : '—';
    rest.hidden = !known;
    gauge.hidden = !known;

    if (known) {
      // Полоска — это сам остаток: кончается подарок, кончается и она
      const share = gift.total ? Math.min(Math.max(gift.left / gift.total, 0), 1) : 0;
      const scarce = String(share <= SCARCE_SHARE);

      gauge.dataset.scarce = scarce;
      rest.dataset.scarce = scarce;
      rest.textContent = 'осталось ' + formatPrice(gift.left);
      gauge.setAttribute('aria-label',
        'Осталось ' + gift.left + ' из ' + gift.total);

      const fill = document.getElementById('sheet-gauge-fill');
      fill.dataset.empty = String(gift.left <= 0);
      // Ширину ставим после открытия — иначе шкала появится уже заполненной
      fill.style.width = '0%';
      sheet.dataset.fill = (share * 100).toFixed(1) + '%';
    }
  }

  function openSheet(gift) {
    if (!sheet || sheet.dataset.open === 'true') return;

    sheetGift = gift;
    fillSheet(gift);
    setQty(1);

    sheet.hidden = false;
    sheet.dataset.open = 'true';

    // В Telegram лист закрывает системная стрелка «назад»
    if (tg && tg.BackButton) tg.BackButton.show();
    // Сцена под листом не должна прокручиваться вместе с ним
    if (stage) stage.style.overflow = 'hidden';

    // Между снятием hidden и классом браузер обязан пересчитать стили, иначе
    // перехода не будет. Читаем размер — это форсирует пересчёт синхронно;
    // через requestAnimationFrame было бы ненадёжно: в фоновой вкладке кадры
    // не идут, и лист открылся бы рывком.
    void sheetPanel.offsetHeight;

    sheet.classList.add('is-open');

    // Содержимое уместилось — прокручивать нечего, забираем жест себе целиком
    sheetScroll.classList.toggle(
      'is-static',
      sheetScroll.scrollHeight <= sheetScroll.clientHeight + 1
    );

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
    if (tg && tg.BackButton) tg.BackButton.hide();
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
    let lastY = 0;
    let lastAt = 0;
    let speed = 0;
    let shift = 0;
    let dragging = false;

    sheetPanel.addEventListener('pointerdown', (event) => {
      if (pointerId !== null || sheet.dataset.open !== 'true') return;

      // Шапка и подарок — ручки: у них touch-action: none, браузер в жест
      // не вмешивается. Остальная часть листа отдана прокрутке, и тянуть
      // оттуда можно, только когда прокручивать нечего или мы в самом верху.
      const handle = event.target.closest('.sheet__head, .sheet__stage');
      if (!handle && sheetScroll.scrollTop > 0) return;

      pointerId = event.pointerId;
      startY = event.clientY;
      lastY = event.clientY;
      lastAt = event.timeStamp;
      speed = 0;
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

      // Скорость считаем по последнему отрезку, а не за весь жест: иначе
      // медленная протяжка с рывком в конце не засчитывалась бы как рывок
      const dt = event.timeStamp - lastAt;
      if (dt > 0) speed = (event.clientY - lastY) / dt;
      lastY = event.clientY;
      lastAt = event.timeStamp;
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

      // Порог не больше четверти листа — у низкого листа 110px недостижимы
      const limit = Math.min(SHEET_CLOSE_DRAG, sheetPanel.offsetHeight * 0.25);
      if (shift > limit || speed > SHEET_FLING) {
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

    // Обработчик вешаем один раз: onClick складывает их, а не заменяет
    if (tg && tg.BackButton) {
      tg.BackButton.onClick(() => {
        haptic('light');
        closeSheet();
      });
    }

    document.getElementById('qty-less').addEventListener('click', () => {
      haptic('select');
      setQty(qty - 1);
    });

    document.getElementById('qty-more').addEventListener('click', () => {
      haptic('select');
      setQty(qty + 1);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSheet();
    });

    document.getElementById('sheet-buy').addEventListener('click', () => {
      haptic('light');
      // Оплата появится вместе с серверной частью
      if (tg && tg.showAlert && sheetGift) {
        tg.showAlert('Покупка «' + sheetGift.name + '» ' + qty + ' шт. скоро заработает');
      }
    });

    initSheetDrag();
  }

  function initGifts() {
    if (!giftsGrid) return;

    GIFTS.forEach((gift) => giftsGrid.appendChild(buildGift(gift)));
    whenLottieReady(initGiftArt);
  }

  // --- Профиль ---

  function tgUser() {
    return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  }

  function userTitle(user) {
    if (!user) return 'Гость';
    if (user.username) return '@' + user.username;
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Без имени';
  }

  let emptyPlayer = null;
  let emptyWatch = null;

  function emptyState() {
    const box = document.createElement('div');
    box.className = 'prf__empty';

    const art = document.createElement('div');
    art.className = 'prf__empty-art';

    const title = document.createElement('b');
    title.textContent = 'Нет подарков(';

    const line = document.createElement('p');
    line.append('Подарки можно покупать в');

    const market = document.createElement('button');
    market.type = 'button';
    market.className = 'prf__market glass';
    market.innerHTML = '<svg viewBox="0 0 643 617" aria-hidden="true"><use href="#logo"></use></svg>';
    market.append('Market');
    market.addEventListener('click', () => {
      haptic('select');
      selectTab(0);
    });

    line.appendChild(market);
    box.append(art, title, line);

    playWhenSeen(art, 'gifts/empty.json', (player, observer) => {
      if (observer) emptyWatch = observer;
      if (player) emptyPlayer = player;
    });

    return box;
  }

  function renderOwned(kind) {
    const list = document.getElementById('prf-list');
    const total = document.getElementById('prf-total');
    const items = OWNED[kind] || [];

    // Старая анимация «пусто» уходит вместе с разметкой — плеер и наблюдателя
    // снимаем сами, иначе они останутся висеть на выброшенном узле
    if (emptyPlayer) {
      emptyPlayer.destroy();
      emptyPlayer = null;
    }
    if (emptyWatch) {
      emptyWatch.disconnect();
      emptyWatch = null;
    }

    list.textContent = '';
    total.textContent = formatPrice(items.length) + ' ' + plural(items.length, 'подарок', 'подарка', 'подарков');

    if (!items.length) {
      list.appendChild(emptyState());
      return;
    }

    const grid = document.createElement('div');
    grid.className = 'gifts';
    items.forEach((gift) => grid.appendChild(buildGift(gift)));
    list.appendChild(grid);
  }

  // 1 подарок, 2 подарка, 5 подарков
  function plural(n, one, few, many) {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  // Запасной путь: Clipboard API есть не везде и падает вне защищённого контекста
  function legacyCopy(value) {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(field);

    let ok = false;
    try {
      field.select();
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }

    field.remove();
    return ok;
  }

  function initHeader() {
    const stars = document.getElementById('hdr-stars');
    const coupons = document.getElementById('hdr-coupons');
    if (!stars || !coupons) return;

    stars.textContent = formatPrice(STARS);
    coupons.textContent = formatPrice(COUPONS);
  }

  function initProfile() {
    const tabs = document.getElementById('prf-tabs');
    if (!tabs) return;

    const user = tgUser();
    const owned = OWNED.gifts.length + OWNED.nft.length;

    document.getElementById('prf-name').textContent = userTitle(user);
    document.getElementById('prf-count').textContent =
      formatPrice(owned) + ' ' + plural(owned, 'подарок', 'подарка', 'подарков');

    const avatar = document.getElementById('prf-avatar');
    if (user && user.photo_url) {
      avatar.style.backgroundImage = 'url("' + user.photo_url + '")';
    } else {
      // Фотографии нет — показываем первую букву на градиенте
      avatar.textContent = userTitle(user).replace('@', '').charAt(0).toUpperCase();
    }

    const id = document.getElementById('prf-id');
    const copy = document.getElementById('prf-copy');
    id.textContent = user ? String(user.id) : '—';
    copy.hidden = !user;

    function copyId() {
      if (!user) return;

      const value = String(user.id);

      const done = () => {
        haptic('success');
        toast('ID скопирован');
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, () => {
          if (legacyCopy(value)) done();
        });
        return;
      }

      // Старые webview без Clipboard API
      if (legacyCopy(value)) done();
    }

    copy.addEventListener('click', copyId);

    const buttons = Array.from(tabs.querySelectorAll('.prf-tabs__tab'));
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        if (button.classList.contains('is-active')) return;

        haptic('select');
        buttons.forEach((other) => other.classList.toggle('is-active', other === button));
        tabs.style.setProperty('--prf-index', String(index));
        renderOwned(button.dataset.prfTab);
      });
    });

    renderOwned('gifts');
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
  initHeader();
  initProfile();
  initSplash();
})();
