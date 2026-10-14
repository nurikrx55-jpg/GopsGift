(() => {
  'use strict';

  const BG = '#0d0d10';
  // requestFullscreen появился в Bot API 8.0
  const FULLSCREEN_API = '8.0';
  // За сколько пикселей движения жест считаем перетаскиванием, а не тапом
  const DRAG_THRESHOLD = 6;
  // Сколько экран загрузки держится минимум — чтобы не мигнуть и исчезнуть
  const SPLASH_MIN_MS = 1100;
  // Дольше этого заставку не держим даже без ответа: лучше показать пустое
  // приложение с объяснением, чем логотип без конца
  const SPLASH_MAX_MS = 12000;
  // Сколько висит всплывающее уведомление
  const TOAST_MS = 3000;
  // Сколько баннер стоит, прежде чем смениться сам
  const SLIDE_MS = 5000;

  // Единый каталог подарков. Витрина и профиль ссылаются на одни и те же
  // записи, поэтому плашка редкости не может разойтись: купленный подарок
  // показывает ровно ту же, что была на витрине.

  // Все надписи — из словаря i18n.js. t() берёт строку по ключу, count()
  // ставит слово в нужную форму при числе
  const t = (key, vars) => window.I18N.t(key, vars);
  const countOf = (value, key) => window.I18N.count(value, key);

  // Содержимое — подарки, баннеры, задания, люди — приходит из хранилища
  // (data/content.json плюс правки из админки). Здесь только то, что
  // хранилище наполняет на старте.
  let GIFTS = [];
  // gifts — обычные подарки, upg — улучшенные, nft — выведенные в блокчейн
  let OWNED = { gifts: [], nft: [], upg: [] };
  let TASK_BLOCKS = [];
  let ME = null;

  function giftById(id) {
    return GIFTS.find((one) => one.id === id) || null;
  }

  // Насколько утянуть лист вниз, чтобы он закрылся
  const SHEET_CLOSE_DRAG = 110;
  // Резкий рывок закрывает, даже если утянули недалеко
  const SHEET_FLING = 0.7;
  // Потолок на случай, если наличие не указано
  const QTY_MAX = 99;

  // Кому показывать вход в админку, пока сервер не может узнать человека
  // (база или токен бота ещё не подключены). Это только ссылка: доступ
  // проверяет сама админка на сервере
  const ADMIN_HINT = ['8387706094'];

  const tg = window.Telegram && window.Telegram.WebApp;

  const nav = document.getElementById('menu-pill');
  const indicator = nav && nav.querySelector('.menu_indicator');
  const tabs = Array.from(document.querySelectorAll('#menu-pill .menu_tab'));
  const stage = document.querySelector('.stage');
  const splash = document.getElementById('splash');
  const sliderTrack = document.getElementById('slider-track');
  const sliderDots = document.getElementById('slider-dots');
  const giftsGrid = document.getElementById('gifts');
  const sheet = document.getElementById('sheet');
  const owned = document.getElementById('owned');

  let current = 0;

  const hasTgFullscreen = () =>
    Boolean(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(FULLSCREEN_API));

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;

    if (kind === 'select') tg.HapticFeedback.selectionChanged();
    else if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
    else tg.HapticFeedback.impactOccurred('light');
  }

  /* Уведомления — столбик memgift в правом верхнем углу. Каждое живёт
     само: новое не гасит предыдущее, а встаёт под ним */
  function toast(text, kind) {
    const root = document.getElementById('toast-container');
    if (!root) return;

    const node = document.createElement('div');
    node.className = 'toast is-off ' + (kind === 'error' ? 'error' : 'success');
    node.textContent = text;
    root.appendChild(node);

    // Пересчёт стилей форсируем чтением размера — иначе перехода не будет
    void node.offsetHeight;
    node.classList.remove('is-off');

    setTimeout(() => {
      node.classList.add('is-off');
      setTimeout(() => node.remove(), 400);
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

  function paint(index) {
    tabs.forEach((tab, i) => {
      const active = i === index;
      tab.classList.toggle('active', active);

      if (active) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });
  }

  // Подложка встаёт под активную вкладку — как в memgift: меряем вкладку и
  // капсулу и отдаём разницу переменными
  function placeIndicator() {
    const tab = tabs[current];
    if (!nav || !tab) return;
    const pill = nav.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (!box.width) {
      requestAnimationFrame(placeIndicator);
      return;
    }
    nav.style.setProperty('--menu-indicator-x', (box.left - pill.left) + 'px');
    nav.style.setProperty('--menu-indicator-w', box.width + 'px');
  }

  function selectTab(index) {
    if (index < 0 || index >= tabs.length) return;

    current = index;
    paint(index);

    // Заголовок меняется ровно вместе со страницей — на входе в раздел
    paintSection();

    placeIndicator();
    stage.dataset.section = tabs[index].dataset.section;
    // Маркет живой: при каждом входе — свежие лоты и история
    if (stage.dataset.section === 'market') loadMarket();
    // Шапка едет вместе со страницей, поэтому новый раздел открываем сверху
    stage.scrollTop = 0;
  }

  // Название открытого раздела в шапке. Отдельно от selectTab: его же
  // приходится переписывать при смене языка
  function paintSection() {
    const title = document.getElementById('hdr-section');
    const named = tabs[current] && tabs[current].dataset.title;
    if (title && named) title.textContent = t(named);
  }


  /* У memgift панель уезжает вниз, когда поверх открыт целый экран или окно.
     У нас такие экраны — заставка, страница подарка, окна и поздравление:
     пока открыто что-то из них, панели на экране нет */
  const MENU_COVERS = '.sheet.is-open, .mgm-dock.is-open, .wmod-dock.is-open';

  function syncMenu() {
    const menu = document.querySelector('.menu');
    if (!menu) return;
    const won = document.getElementById('won');
    const covered = Boolean(document.querySelector(MENU_COVERS)) ||
      Boolean(won && !won.hidden);
    menu.classList.toggle('is-hidden', covered);
  }

  function watchMenu() {
    const watch = new MutationObserver(syncMenu);
    document.querySelectorAll('.sheet, .mgm-dock, .wmod-dock, #won, #splash').forEach((node) => {
      watch.observe(node, { attributes: true, attributeFilter: ['class', 'hidden'] });
    });
    syncMenu();
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

    // Круглая кнопка рядом с капсулой: GetGems ещё не подключён
    const gems = document.getElementById('menu-gems');
    if (gems) {
      gems.addEventListener('click', () => {
        haptic('light');
        toast(t('soon.gems'));
      });
    }

    const initial = tabs.findIndex((tab) => tab.classList.contains('active'));
    selectTab(initial === -1 ? 0 : initial);
    window.addEventListener('resize', placeIndicator);
    placeIndicator();
    watchMenu();
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

  // Баннеры приходят с сервера: картинка либо лежит в репозитории, либо
  // загружена через админку — в обоих случаях это просто адрес
  function openLink(href) {
    if (!href) return;
    // Внутри Telegram ссылка открывается поверх приложения, а не вместо него
    if (tg && /^https:\/\/t\.me\//i.test(href) && tg.openTelegramLink) tg.openTelegramLink(href);
    else if (tg && tg.openLink) tg.openLink(href);
    else window.open(href, '_blank', 'noopener');
  }

  function buildBanners() {
    if (!sliderTrack) return [];

    const banners = (Store.state().banners || []).filter((one) => one && one.image);
    sliderTrack.textContent = '';

    return banners.map((banner) => {
      const slide = document.createElement('a');
      slide.className = 'slider__slide';
      slide.href = banner.href || '#';
      slide.setAttribute('aria-label', banner.label || t('slider.one'));
      slide.style.backgroundImage = 'url("' + banner.image + '")';
      slide.draggable = false;

      slide.addEventListener('click', (event) => {
        event.preventDefault();
        if (!banner.href) return;
        haptic('light');
        openLink(banner.href);
      });

      sliderTrack.appendChild(slide);
      return slide;
    });
  }

  function initSlider(slides) {
    if (!sliderTrack || !sliderDots) return;
    if (!slides || slides.length < 2) return;

    const dots = slides.map((slide, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'slider__dot';
      dot.setAttribute('role', 'tab');
      dot.setAttribute('aria-label', slide.getAttribute('aria-label') || `Баннер ${index + 1}`);

      // Заливка внутри точки — заодно и шкала таймера
      const fill = document.createElement('span');
      fill.className = 'slider__fill';
      dot.appendChild(fill);

      dot.addEventListener('click', () => {
        goTo(index);
      });

      sliderDots.appendChild(dot);
      return dot;
    });

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let shown = -1;
    let timer = null;

    function goTo(index) {
      const slide = slides[index % slides.length];
      sliderTrack.scrollTo({
        left: slide.offsetLeft - sliderTrack.offsetLeft,
        behavior: 'smooth'
      });
    }

    // Заливку перезапускаем вручную: без сброса ширины переход не повторится
    function run(index) {
      clearTimeout(timer);

      // Залитой остаётся ровно одна точка — текущая. Ширину мы прописываем
      // прямо в элементе, а она сильнее правила из стилей, поэтому снять
      // заливку с прежней точки нужно тоже вручную: иначе после
      // переключения белыми остаются обе.
      dots.forEach((dot, i) => {
        if (i === index) return;
        const spent = dot.firstElementChild;
        spent.style.transition = 'none';
        spent.style.width = '0%';
      });

      const fill = dots[index].firstElementChild;
      fill.style.transition = 'none';
      fill.style.width = '0%';
      // Пересчёт стилей форсируем чтением размера — иначе перехода не будет
      void fill.offsetWidth;

      if (still) {
        fill.style.width = '100%';
        return;
      }

      fill.style.transition = 'width ' + SLIDE_MS + 'ms linear';
      fill.style.width = '100%';

      timer = setTimeout(() => {
        // Пока карусель не на экране, прокрутка пропала бы впустую: у
        // скрытой дорожки scrollTo ничего не делает. Просто ждём дальше.
        if (document.hidden || !sliderTrack.offsetParent) {
          run(index);
          return;
        }
        goTo(index + 1);
      }, SLIDE_MS);
    }

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

      // Отсчёт начинаем заново только при настоящей смене баннера, иначе
      // заливка сбрасывалась бы на каждом кадре прокрутки
      if (active !== shown) {
        shown = active;
        run(active);
      }
    }

    sliderTrack.addEventListener('scroll', () => {
      // Точки обновляем на кадре отрисовки, а не на каждом событии прокрутки
      window.requestAnimationFrame(sync);
    }, { passive: true });

    window.addEventListener('resize', sync);
    sync();
  }

  // 2000 -> «2 000». Пробел неразрывный, иначе число рвётся на две строки
  // Тысячи разделяем так, как принято в выбранном языке: по-русски —
  // неразрывным пробелом, по-английски — запятой
  function formatPrice(value) {
    const mark = window.I18N.lang() === 'ru' ? '\u00A0' : ',';
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, mark);
  }

  function buildGift(gift, onPick, withPrice) {
    const card = document.createElement('article');
    card.className = 'gift tint-face';
    paintRarity(card, gift);

    // Подложка карточки — того же цвета, что и сам подарок. Готовый берём
    // сразу, иначе карточка перекрашивалась бы на глазах
    applyTint(card, tintOf(gift));
    if (!tints.has(gift.art)) {
      warmTint(gift, (tint) => {
        if (tint) applyTint(card, tint);
      });
    }

    const art = document.createElement('div');
    art.className = 'gift__art';
    if (gift.name) art.setAttribute('aria-label', gift.name);
    card.appendChild(art);
    showShot(art, gift);

    // Распроданный — лента memgift «sold out» тёмно-красная, поверх своей
    const sold = gift.left === 0;
    if (gift.badge || sold) {
      const badge = document.createElement('span');
      badge.className = 'gift__badge';
      badge.dataset.kind = sold ? 'soldout' : gift.kind || 'default';
      // Цвет ленты может задать админка — тогда лента одноцветная; не
      // задала — заливка по редкости, градиентом из спрайта
      if (gift.tone && !sold) badge.style.setProperty('--ribbon-fill', gift.tone);
      // Контур ленты лежит в спрайте, здесь только ссылка на него
      badge.innerHTML =
        '<svg class="gift__ribbon" viewBox="-2 -2 124 36" aria-hidden="true">' +
        '<use href="#ribbon-shape"></use></svg>';

      const label = document.createElement('span');
      label.className = 'gift__label';
      label.textContent = sold ? 'sold out' : gift.badge;
      badge.appendChild(label);
      card.appendChild(badge);
    }

    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    // Какой лист открывать, решает вызывающий: с витрины — покупка,
    // из профиля — карточка уже купленного подарка
    const show = () => {
      haptic('light');
      if (onPick) onPick(gift);
    };

    card.addEventListener('click', show);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      show();
    });

    // У купленного подарка цены нет — она имеет смысл только на витрине
    if (withPrice) {
      const price = document.createElement('span');
      price.className = 'gift__price';

      const star = document.createElement('img');
      star.className = 'gift__star';
      // Жёлтая звезда — под стать жёлтому числу рядом; белая осталась там,
      // где число белое: в шапке, в листе и на кнопке покупки
      star.src = 'gifts/star.png';
      star.alt = t('hdr.stars');
      star.draggable = false;

      const amount = document.createElement('span');
      amount.className = 'gift__amount';
      amount.textContent = formatPrice(gift.price);

      price.append(star, amount);
      card.appendChild(price);
    }

    return card;
  }

  // --- Улучшенные подарки ---

  /* Улучшенный подарок, как у memgift: свой фон (круг из двух цветов),
     узор символа поверх и модель вместо самого подарка. В профиле он лежит
     тем же подарком витрины, к которому приложено, что выпало (gift.nft) */

  function backdropOf(name) {
    return attrs && attrs.backdrops.find((one) => one.name === name) || null;
  }

  function symbolOf(name) {
    return attrs && attrs.symbols.find((one) => one.name === name) || null;
  }

  function nftView(nft) {
    const base = giftById(nft.gift);
    return Object.assign({}, base || { id: nft.gift, name: nft.model.name, price: 0 }, {
      nft: nft,
      symbol: nft.symbol,
      backdrop: nft.backdrop
    });
  }

  // Что рисовать: у улучшенного — модель, у обычного — сам подарок
  function artOf(gift) {
    if (!gift || !gift.nft) return gift;
    return { id: gift.id, name: gift.name, art: gift.nft.model.art, artType: gift.nft.model.artType };
  }

  // Осветление цвета к белому — `boostColor` memgift
  function boostColor(hex, part) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex || '#666';
    const v = parseInt(m[1], 16);
    const up = (c) => Math.min(255, Math.round(c + (255 - c) * part));
    const r = up((v >> 16) & 255);
    const g = up((v >> 8) & 255);
    const b = up(v & 255);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  function backdropColors(gift) {
    const one = backdropOf(gift.nft && gift.nft.backdrop);
    return { center: one ? one.center : '#666', around: one ? one.around : '#1a1a1a' };
  }

  /* Лента «on sale» — `saleRibbonStyle` memgift: цвет фона подарка,
     насыщеннее на треть; от светлее к темнее по диагонали */
  let saleSeq = 0;

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const v = m ? parseInt(m[1], 16) : 0x4a4a52;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('');
  }

  function saturateColor(hex, part) {
    const rgb = hexToRgb(hex);
    const grey = (rgb[0] + rgb[1] + rgb[2]) / 3;
    return rgbToHex(rgb.map((c) => c + (c - grey) * part));
  }

  function darkenColor(hex, part) {
    return rgbToHex(hexToRgb(hex).map((c) => c * (1 - part)));
  }

  function paintSale(badge, center, bare) {
    const base = saturateColor(center || '#4A4A52', 0.34);
    const id = 'sale-' + (++saleSeq);
    badge.style.setProperty('--ribbon-fill', 'url(#' + id + ')');
    badge.innerHTML = '<svg class="gift__ribbon" viewBox="-2 -2 124 36" aria-hidden="true">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop stop-color="' + boostColor(base, 0.14) + '"></stop>' +
      '<stop offset="1" stop-color="' + darkenColor(base, 0.26) + '"></stop>' +
      '</linearGradient></defs><use href="#ribbon-shape"></use></svg>';
    if (bare) return;
    const label = document.createElement('span');
    label.className = 'gift__label';
    label.textContent = 'on sale';
    badge.appendChild(label);
  }

  // Карточка улучшенного в профиле — `.item._gift.is-upgraded` memgift
  function nftCard(gift, onPick) {
    const card = document.createElement('article');
    card.className = 'gift gift--upg';
    const colors = backdropColors(gift);
    card.style.background = 'radial-gradient(circle at 50% 40%, ' + boostColor(colors.center, 0.28) +
      ' 0%, ' + colors.center + ' 45%, ' + colors.around + ' 100%)';

    const symbol = symbolOf(gift.nft.symbol);
    if (symbol) {
      const box = document.createElement('div');
      box.className = 'gift__symbols';
      const img = document.createElement('img');
      img.src = symbol.image;
      img.alt = '';
      img.draggable = false;
      box.appendChild(img);
      card.appendChild(box);
    }

    const num = document.createElement('span');
    num.className = 'gift__num';
    num.textContent = '#' + gift.nft.num;
    card.appendChild(num);

    // Выставлен на маркете — лента «on sale», как у memgift
    if (gift.nft.lot) {
      const sale = document.createElement('span');
      sale.className = 'gift__badge gift__badge--sale';
      paintSale(sale, colors.center);
      card.appendChild(sale);
    }

    const art = document.createElement('div');
    art.className = 'gift__art';
    art.setAttribute('aria-label', gift.name);
    card.appendChild(art);
    showShot(art, artOf(gift));

    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    const show = () => {
      haptic('light');
      if (onPick) onPick(gift);
    };
    card.addEventListener('click', show);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      show();
    });
    return card;
  }

  /* Шапка окна: у улучшенного — фон `.is-upg`, узор его символа и номер,
     у обычного — тон подарка и общий узор, как было */
  function paintHead(head, gift, symbolImg, mark) {
    const upg = Boolean(gift && gift.nft);
    head.classList.toggle('is-upg', upg);

    if (upg) {
      const colors = backdropColors(gift);
      head.style.setProperty('--center-color', colors.center);
      head.style.setProperty('--around-color', colors.around);
      const symbol = symbolOf(gift.nft.symbol);
      if (symbolImg) symbolImg.src = symbol ? symbol.image : 'gifts/pattern.png';
    } else {
      head.style.removeProperty('--center-color');
      head.style.removeProperty('--around-color');
      if (symbolImg) symbolImg.src = 'gifts/pattern.png';
    }

    if (mark) {
      mark.hidden = !upg;
      if (upg) mark.querySelector('p').textContent = '#' + gift.nft.num;
    }
  }

  // Шанс как у memgift: «1.2%», запятая — по языку
  function pct(value) {
    const n = Number(value) || 0;
    if (!n) return '';
    return String(n).replace('.', window.I18N.lang() === 'ru' ? ',' : '.') + '%';
  }

  // Подарок рисует либо анимация lottie, либо картинка .svg
  function isStill(gift) {
    return Boolean(gift) && gift.artType === 'svg';
  }

  // Картинку показываем обычным <img>: скрипт внутри svg так не запускается,
  // и загрузку браузер тянет сам, когда карточка доедет до экрана
  function showStill(container, path) {
    container.textContent = '';
    const img = document.createElement('img');
    img.src = path;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    container.appendChild(img);
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

  function prefersStill() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* Неподвижный подарок: рисуем последний кадр и на том стоим. Так ведут
     себя все подарки вне листов — на витрине их бывает много разом, и
     десяток анимаций сразу превращает прокрутку в кашу. Двигаются они
     только в раскрытой карточке.

     Анимация всегда приходит адресом: файл из репозитория или загрузка из
     админки. */
  function playOnce(container, path) {
    if (!window.lottie || !path) return null;

    const player = window.lottie.loadAnimation({
      container: container,
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      path: path,
      // Ретина: рисуем в большем разрешении, выше 2x смысла нет
      rendererSettings: { dpr: Math.min(window.devicePixelRatio || 1, 2) }
    });

    // У некоторых композиций нулевой кадр пустой, поэтому берём последний
    player.addEventListener('DOMLoaded', () => {
      player.goToAndStop(player.totalFrames - 1, true);
    });

    return player;
  }

  // Анимацию нельзя заводить, пока её контейнер не показался на экране: у
  // скрытого блока нулевой размер, и lottie нарисует canvas шириной 0, который
  // сам потом не пересчитает. Наблюдатель срабатывает только когда у элемента
  // появился размер, и это разом решает обе задачи — и размер, и экономию.
  const artPlayers = new Map();
  const artWatchers = new Map();

  function playWhenSeen(container, path, loop) {
    whenLottieReady(() => {
      const observer = new IntersectionObserver((entries, obs) => {
        entries.forEach((entry) => {
          const player = artPlayers.get(entry.target);

          if (!entry.isIntersecting) {
            // Зацикленная анимация за кадром рисовала бы по шестьдесят кадров
            // в секунду в пустоту и тормозила бы весь остальной экран
            if (player && loop) player.pause();
            return;
          }

          if (!player) {
            const started = loop ? loopArt(entry.target, path) : playOnce(entry.target, path);
            if (started) artPlayers.set(entry.target, started);
            // Одиночный прогон отыграл — наблюдать больше не за чем
            if (!loop) obs.unobserve(entry.target);
            return;
          }

          if (loop && !prefersStill()) player.play();
        });
      }, { rootMargin: '120px' });

      observer.observe(container);
      artWatchers.set(container, observer);
    });
  }

  // Разметку выбрасываем — плееры и наблюдателей внутри неё снимаем сами,
  // иначе они останутся висеть на узлах, которых уже нет в документе
  function releaseArt(root) {
    artPlayers.forEach((player, node) => {
      if (!root.contains(node)) return;
      player.destroy();
      artPlayers.delete(node);
    });

    artWatchers.forEach((observer, node) => {
      if (!root.contains(node)) return;
      observer.disconnect();
      artWatchers.delete(node);
    });
  }

  // --- Цвет подложки из самого подарка ---

  // Подложка в карточке купленного подарка монохромная, и тон ей задаёт сам
  // подарок: читаем кадр анимации и берём господствующий оттенок. Новый
  // подарок раскрашивает карточку сам, руками ничего прописывать не нужно.
  const HUE_BINS = 36;
  // Сколько проб берём с кадра — больше не точнее, только медленнее
  const HUE_SAMPLES = 12000;
  // Бледнее этого пиксель считаем серым и в расчёт не берём
  const HUE_MIN_CHROMA = 0.12;
  // Границы насыщенности подложки: ядовитый фон спорил бы с подарком
  const TINT_MIN_S = 0.2;
  const TINT_MAX_S = 0.46;

  function artTint(canvas) {
    const w = canvas && canvas.width;
    const h = canvas && canvas.height;
    if (!w || !h) return null;

    let pixels;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      pixels = ctx.getImageData(0, 0, w, h).data;
    } catch (_) {
      // Холст из чужого источника читать нельзя — остаётся запасной цвет
      return null;
    }

    // Голос пикселя тем весомее, чем он насыщеннее: серая обводка и блики
    // почти не влияют на итог
    const weight = new Float64Array(HUE_BINS);
    const chroma = new Float64Array(HUE_BINS);
    const step = Math.max(1, Math.round(Math.sqrt((w * h) / HUE_SAMPLES)));

    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4;
        if (pixels[i + 3] < 150) continue;

        const r = pixels[i] / 255;
        const g = pixels[i + 1] / 255;
        const b = pixels[i + 2] / 255;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const span = max - min;
        const light = (max + min) / 2;

        // Серое, чёрное и белое оттенка не несут
        if (span < HUE_MIN_CHROMA || light < 0.12 || light > 0.93) continue;

        const sat = span / (1 - Math.abs(2 * light - 1));

        let hue;
        if (max === r) hue = ((g - b) / span + 6) % 6;
        else if (max === g) hue = (b - r) / span + 2;
        else hue = (r - g) / span + 4;
        hue *= 60;

        const bin = Math.min(HUE_BINS - 1, Math.floor(hue / (360 / HUE_BINS)));
        weight[bin] += sat;
        chroma[bin] += sat * sat;
      }
    }

    // Пик ищем по тройке соседних корзин: иначе оттенок прыгал бы между
    // двумя половинами одного и того же цвета
    let best = -1;
    let bestSum = 0;
    for (let i = 0; i < HUE_BINS; i += 1) {
      const left = weight[(i + HUE_BINS - 1) % HUE_BINS];
      const right = weight[(i + 1) % HUE_BINS];
      const sum = left + weight[i] + right;
      if (sum > bestSum) {
        bestSum = sum;
        best = i;
      }
    }

    if (best < 0 || bestSum <= 0) return null;

    // Внутри тройки берём взвешенную середину — так тон попадает точнее,
    // чем в центр корзины
    const width = 360 / HUE_BINS;
    let offset = 0;
    let mass = 0;
    let sat = 0;
    for (let d = -1; d <= 1; d += 1) {
      const bin = (best + d + HUE_BINS) % HUE_BINS;
      offset += weight[bin] * d;
      mass += weight[bin];
      sat += chroma[bin];
    }

    const hue = ((best + 0.5 + (mass ? offset / mass : 0)) * width + 360) % 360;
    const share = mass ? sat / mass : TINT_MIN_S;

    return {
      hue: Math.round(hue),
      sat: Math.round(Math.min(Math.max(share, TINT_MIN_S), TINT_MAX_S) * 100)
    };
  }

  // Первый кадр у многих композиций пустой, поэтому пробуем несколько раз
  // Цвет считаем заранее и запоминаем по пути анимации: открытый лист должен
  // быть нужного цвета сразу, а не перекрашиваться на глазах через пару
  // секунд, пока догружается и доигрывается анимация в самой карточке.
  const tints = new Map();

  /* Фон, выбранный в админке, перебивает цвет, снятый с самого подарка.
     Из выбранного цвета берём тон и насыщенность — подложка строится от
     них же, поэтому осталась той же монохромной плитой. */
  function hexTint(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return null;

    const r = parseInt(m[1], 16) / 255;
    const g = parseInt(m[2], 16) / 255;
    const b = parseInt(m[3], 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const light = (max + min) / 2;

    let hue = 0;
    if (d) {
      if (max === r) hue = ((g - b) / d) % 6;
      else if (max === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
    }

    const sat = d ? d / (1 - Math.abs(2 * light - 1)) : 0;
    return { hue: Math.round((hue * 60 + 360) % 360), sat: Math.round(sat * 100) };
  }

  function tintOf(gift) {
    if (gift && gift.bg) return hexTint(gift.bg);
    return (gift && tints.get(gift.art)) || null;
  }

  function applyTint(card, tint) {
    if (!card) return;

    if (!tint) {
      // Снимаем цвет прошлого подарка, иначе он остался бы на чужой карточке
      card.style.removeProperty('--tint-h');
      card.style.removeProperty('--tint-s');
      return;
    }

    card.style.setProperty('--tint-h', String(tint.hue));
    card.style.setProperty('--tint-s', tint.sat + '%');
  }

  /* Снимок подарка.

     На карточке подарок стоит картинкой, а не проигрывателем. Двести
     карточек — это двести разборов анимации и двести холстов, от которых
     приложение встаёт колом: именно так оно и вело себя у человека с
     двумя сотнями подарков. Поэтому каждый подарок рисуется в стороне от
     экрана ровно один раз, и дальше все его карточки показывают один и
     тот же снимок. Оттуда же берётся и цвет для подложки — второй прогон
     ради него не нужен.

     Двигается подарок только в раскрытой карточке: там он один. */

  const SHOT = 256;
  const shots = new Map();

  function shotFromImage(path) {
    return new Promise((done) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(img.naturalWidth || SHOT, SHOT);
        canvas.height = Math.min(img.naturalHeight || SHOT, SHOT);
        canvas.getContext('2d', { willReadFrequently: true })
          .drawImage(img, 0, 0, canvas.width, canvas.height);

        // Картинку показываем по её же адресу: пересобирать нечего
        done({ still: path, tint: artTint(canvas) });
      };

      img.onerror = () => done({ still: path, tint: null });
      img.src = path;
    });
  }

  function shotFromLottie(path) {
    return new Promise((done) => {
      whenLottieReady(() => {
        if (!window.lottie) {
          done({ still: '', tint: null });
          return;
        }

        const box = document.createElement('div');
        box.className = 'tint-probe';
        box.style.width = SHOT + 'px';
        box.style.height = SHOT + 'px';
        document.body.appendChild(box);

        const probe = window.lottie.loadAnimation({
          container: box,
          renderer: 'canvas',
          loop: false,
          autoplay: false,
          path: path,
          rendererSettings: { dpr: 1 }
        });

        let over = false;
        const finish = (shot) => {
          if (over) return;
          over = true;
          probe.destroy();
          box.remove();
          done(shot);
        };

        probe.addEventListener('DOMLoaded', () => {
          // Последний кадр: у многих композиций первый пустой
          probe.goToAndStop(probe.totalFrames - 1, true);

          const canvas = box.querySelector('canvas');
          let still = '';
          try {
            still = canvas ? canvas.toDataURL('image/png') : '';
          } catch (_) {}

          finish({ still: still, tint: canvas ? artTint(canvas) : null });
        });

        probe.addEventListener('data_failed', () => finish({ still: '', tint: null }));
      });
    });
  }

  function shotOf(gift) {
    const path = gift && gift.art;
    if (!path) return Promise.resolve({ still: '', tint: null });
    if (shots.has(path)) return shots.get(path);

    const job = (isStill(gift) ? shotFromImage(path) : shotFromLottie(path))
      .then((shot) => {
        // Цвет запоминаем отдельно: его спрашивают сразу, не дожидаясь
        if (shot.tint) tints.set(path, shot.tint);
        return shot;
      });

    shots.set(path, job);
    return job;
  }

  // Снимок на место подарка. Пока он считается, место под него пустое
  function showShot(container, gift) {
    container.textContent = '';

    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    container.appendChild(img);

    shotOf(gift).then((shot) => {
      if (shot.still) img.src = shot.still;
    });
  }

  function warmTint(gift, done) {
    shotOf(gift).then((shot) => {
      // Выбранный в админке фон главнее снятого цвета
      if (done) done(gift && gift.bg ? hexTint(gift.bg) : shot.tint);
    });
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

  /* Купоны идут в скидку: один купон — одна звезда. Совсем до нуля цену
     они не сводят — счёт меньше звезды Telegram не примет, поэтому одну
     всегда оставляем. Сколько списать, решает сервер: здесь только показ. */
  function couponCut() {
    if (!sheetGift) return 0;

    const have = ME ? (ME.coupons || 0) : 0;
    return Math.max(0, Math.min(have, sheetGift.price * qty - 1));
  }

  function useCoupons() {
    const box = document.getElementById('cpn-use');
    return Boolean(box && box.checked);
  }

  // Админ берёт подарок даром: ни цены, ни купонов ему на кнопке не нужно
  function freeHand() {
    return Boolean(ME && ME.admin);
  }

  function paintCoupons() {
    const row = document.getElementById('cpn');
    if (!row || !sheetGift) return;

    const cut = freeHand() ? 0 : couponCut();
    row.hidden = cut <= 0;
    if (cut <= 0) return;

    document.getElementById('cpn-have').textContent =
      t('gift.couponsHave', { n: formatPrice(ME ? ME.coupons || 0 : 0) });
    document.getElementById('cpn-cut').textContent = '−' + formatPrice(cut);
  }

  function setQty(value) {
    if (!sheetGift) return;

    const limit = qtyLimit();
    qty = Math.min(Math.max(value, 1), limit);

    document.getElementById('qty-value').textContent = String(qty);
    document.getElementById('qty-less').disabled = qty <= 1;
    document.getElementById('qty-more').disabled = qty >= limit;

    paintCoupons();

    const free = freeHand();
    const button = document.getElementById('sheet-buy');
    button.classList.toggle('is-free', free);
    document.getElementById('sheet-buy-text').textContent = t(free ? 'gift.free' : 'gift.buy');

    const full = sheetGift.price * qty;
    const cut = !free && useCoupons() ? couponCut() : 0;
    document.getElementById('sheet-buy-price').textContent = formatPrice(full - cut);

    paintTonPay(full, free);
  }

  /* Оплата с баланса TON — переключатель рядом с купонами. Виден, когда
     курс задан и на балансе хватает на выбранное количество. Включён —
     купоны прячутся (к TON они не применяются), на кнопке цена в TON */
  function paintTonPay(full, free) {
    const row = document.getElementById('tonpay');
    if (!row) return;

    const cost = tonCost(full);
    const have = Number(ME && ME.tonNano) || 0;
    row.hidden = free || !cost || have < cost;

    const box = document.getElementById('tonpay-use');
    if (row.hidden) box.checked = false;

    document.getElementById('tonpay-have').textContent = t('gift.tonHave', { n: formatTon(have) });
    document.getElementById('tonpay-cost').textContent = formatTon(cost) + ' TON';

    const on = box.checked;
    if (on) document.getElementById('cpn').hidden = true;
    document.getElementById('sheet-buy-star').hidden = on;
    document.getElementById('sheet-buy-ton').hidden = !on;
    if (on) document.getElementById('sheet-buy-price').textContent = formatTon(cost);
  }

  function useTon() {
    const row = document.getElementById('tonpay');
    return Boolean(row && !row.hidden && document.getElementById('tonpay-use').checked);
  }

  // Редкость из админки. Пусто («Авто») — карточки красятся тоном самого
  // подарка, и на витрине, и на странице одинаково
  function rarityOf(gift) {
    return (gift && gift.rarity) || '';
  }

  function paintRarity(card, gift) {
    const rarity = rarityOf(gift);
    if (rarity) card.dataset.rarity = rarity;
    else delete card.dataset.rarity;
  }

  function fillSheet(gift) {
    // Тот же цвет, что у карточки на витрине: редкость или тон подарка
    const card = sheet.querySelector('.gp-card');
    paintRarity(card, gift);
    applyTint(card, tintOf(gift));
    if (!tints.has(gift.art)) {
      warmTint(gift, (tint) => {
        if (tint && sheetGift === gift) applyTint(card, tint);
      });
    }
    document.getElementById('sheet-art').classList.toggle('is-still', isStill(gift));

    document.getElementById('sheet-title').textContent = gift.name;
    document.getElementById('sheet-coupons').textContent = formatPrice(ME ? ME.coupons || 0 : 0);

    // Плашка «осталось / всего» — только когда тираж известен
    const known = typeof gift.left === 'number' && typeof gift.total === 'number';
    document.getElementById('sheet-supply').hidden = !known;
    if (known) {
      document.getElementById('sheet-done').textContent = formatPrice(gift.left);
      document.getElementById('sheet-total').textContent = '/' + formatPrice(gift.total);
    }

    // Распродан — одна кнопка «Перейти в маркет» вместо покупки
    sheet.classList.toggle('is-sold', gift.left === 0);
    document.getElementById('sheet-store').hidden = gift.left !== 0;

    loadTop(gift);
  }

  // --- Топ покупателей ---

  function initials(name) {
    const parts = String(name || '').replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '?';
  }

  function topRow(person) {
    const row = document.createElement('div');
    row.className = 'gp-top__row';

    let ava;
    if (person.photo) {
      ava = document.createElement('img');
      ava.src = person.photo;
      ava.alt = '';
      ava.draggable = false;
      ava.referrerPolicy = 'no-referrer';
      // Фото из Telegram может не открыться — тогда буквы, как без фото
      ava.addEventListener('error', () => {
        const letters = document.createElement('span');
        letters.className = 'gp-top__ava';
        letters.textContent = initials(person.name);
        ava.replaceWith(letters);
      });
    } else {
      ava = document.createElement('span');
      ava.textContent = initials(person.name);
    }
    ava.className = 'gp-top__ava';

    const name = document.createElement('span');
    name.className = 'gp-top__name';
    name.textContent = person.name || '—';

    const count = document.createElement('span');
    count.className = 'gp-top__count';
    count.innerHTML = '<svg viewBox="0 0 14 16" aria-hidden="true"><use href="#task-gift"></use></svg>';
    const n = document.createElement('span');
    n.textContent = formatPrice(person.count);
    count.appendChild(n);

    row.append(ava, name, count);

    // Как у memgift: по строке топа открывается профиль этого человека
    if (person.id) {
      row.classList.add('is-link');
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.addEventListener('click', () => {
        haptic('light');
        openView(person);
      });
    }
    return row;
  }

  /* Топ покупателей приходит отдельным запросом, а сервер до базы ходит
     долго. Поэтому топы всех подарков просим сразу после загрузки и держим
     под рукой: страница подарка показывает его мгновенно, а свежий
     подтягивается в фоне — купить мог кто угодно, пока страница была закрыта */
  const tops = new Map();
  const topAsks = new Map();

  function askTop(giftId) {
    if (!Store.live()) return Promise.resolve(null);
    if (topAsks.has(giftId)) return topAsks.get(giftId);

    const ask = fetch('/api/top?gift=' + encodeURIComponent(giftId))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data) tops.set(giftId, data);
        return data;
      })
      .catch(() => null)
      .then((data) => {
        topAsks.delete(giftId);
        return data;
      });

    topAsks.set(giftId, ask);
    return ask;
  }

  function paintTop(data) {
    const box = document.getElementById('sheet-top');
    if (!data || !data.top || !data.top.length) {
      box.hidden = true;
      return;
    }

    document.getElementById('sheet-top-n').textContent = '(' + formatPrice(data.total) + ')';
    const list = document.getElementById('sheet-top-list');
    list.textContent = '';
    data.top.forEach((person) => list.appendChild(topRow(person)));
    box.hidden = false;
  }

  function loadTop(gift) {
    // Что уже знаем — сразу, без ожидания
    paintTop(tops.get(gift.id) || null);

    askTop(gift.id).then((data) => {
      if (data && sheetGift === gift) paintTop(data);
    });
  }

  // Заранее — по всем подаркам витрины, пока человек смотрит на неё
  function warmTops() {
    GIFTS.forEach((gift) => askTop(gift.id));
  }


  // Раскрытая карточка: анимация играет по кругу, картинка просто лежит
  function openArt(container, gift) {
    if (!container) return null;
    container.textContent = '';
    if (isStill(gift)) {
      showStill(container, gift.art);
      return null;
    }
    return loopArt(container, gift.art);
  }

  function closeArt(container, player) {
    if (player) player.destroy();
    if (container) container.textContent = '';
  }

  // Зацикленная анимация — такая нужна только в раскрытой карточке
  function loopArt(container, path) {
    if (!window.lottie || !path) return null;

    return window.lottie.loadAnimation({
      container: container,
      renderer: 'canvas',
      loop: true,
      autoplay: !prefersStill(),
      path: path,
      rendererSettings: { dpr: Math.min(window.devicePixelRatio || 1, 2) }
    });
  }

  // Один механизм на все нижние листы: выезд, закрытие, перетаскивание и
  // блокировка прокрутки сцены. Чем лист наполнен — забота вызывающего,
  // он передаёт это крючками fill/opened/closed.
  const sheets = [];
  // Порядок открытия: «назад» закрывает то окно, что открыли последним, а
  // не то, что раньше завели. Иначе страница человека из топа закрывалась
  // бы под открытым поверх неё окном подарка
  let openSeq = 0;

  function createSheet(root, hooks) {
    if (!root) return null;

    const panel = root.querySelector('.sheet__panel');
    const scroll = root.querySelector('.sheet__scroll');
    const on = hooks || {};
    const page = root.classList.contains('sheet--page');

    function isOpen() {
      return root.dataset.open === 'true';
    }

    function open(payload) {
      if (isOpen()) return;
      api.at = ++openSeq;
      if (on.fill) on.fill(payload);

      root.hidden = false;
      root.dataset.open = 'true';
      // Страница каждый раз открывается сверху, как новый экран
      if (page) scroll.scrollTop = 0;

      // В Telegram лист закрывает системная стрелка «назад»
      if (tg && tg.BackButton) tg.BackButton.show();
      // Сцена под листом не должна прокручиваться вместе с ним
      if (stage) stage.style.overflow = 'hidden';

      // Между снятием hidden и классом браузер обязан пересчитать стили, иначе
      // перехода не будет. Читаем размер — это форсирует пересчёт синхронно;
      // через requestAnimationFrame было бы ненадёжно: в фоновой вкладке кадры
      // не идут, и лист открылся бы рывком.
      void panel.offsetHeight;
      root.classList.add('is-open');

      // Содержимое уместилось — прокручивать нечего, забираем жест себе целиком
      // Страницу не трогаем: её содержимое часто догружается уже после
      // открытия, и запертая прокрутка так бы и осталась запертой
      scroll.classList.toggle('is-static', !page && scroll.scrollHeight <= scroll.clientHeight + 1);

      if (on.opened) on.opened(payload);
    }

    function close() {
      if (!isOpen()) return;

      root.dataset.open = 'false';
      root.classList.remove('is-open', 'is-dragging');
      panel.style.transform = '';
      if (tg && tg.BackButton) tg.BackButton.hide();

      const done = () => {
        root.hidden = true;
        if (stage) stage.style.overflow = '';
        if (on.closed) on.closed();
      };

      // Страница уходит сразу, как экран при переходе назад у memgift
      if (page) {
        done();
        return;
      }

      // Ждём конец выезда, но не полагаемся на событие целиком
      let fired = false;
      const onEnd = (event) => {
        if (event.target !== panel || event.propertyName !== 'transform') return;
        fired = true;
        panel.removeEventListener('transitionend', onEnd);
        done();
      };
      panel.addEventListener('transitionend', onEnd);
      setTimeout(() => {
        if (fired) return;
        panel.removeEventListener('transitionend', onEnd);
        done();
      }, 500);
    }

    // Утягивание листа вниз пальцем
    let pointerId = null;
    let startY = 0;
    let lastY = 0;
    let lastAt = 0;
    let speed = 0;
    let shift = 0;
    let dragging = false;

    panel.addEventListener('pointerdown', (event) => {
      if (pointerId !== null || !isOpen()) return;

      // Шапка и подложка с подарком — ручки: у них touch-action: none, браузер
      // в жест не вмешивается. Остальное отдано прокрутке, и тянуть оттуда
      // можно, только когда прокручивать нечего или мы в самом верху.
      // Страница на весь экран не утягивается: её закрывает стрелка «назад»
      if (page) return;

      const handle = event.target.closest('.sheet__head, .sheet__stage, .pick__top');
      if (!handle && scroll.scrollTop > 0) return;

      pointerId = event.pointerId;
      startY = event.clientY;
      lastY = event.clientY;
      lastAt = event.timeStamp;
      speed = 0;
      shift = 0;
      dragging = false;
    });

    panel.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;

      const dy = event.clientY - startY;
      // Вверх лист не тянется
      if (dy <= 0 && !dragging) return;

      if (!dragging) {
        if (dy < DRAG_THRESHOLD) return;
        dragging = true;
        root.classList.add('is-dragging');
        try {
          panel.setPointerCapture(pointerId);
        } catch (_) {}
      }

      shift = Math.max(dy, 0);
      panel.style.transform = 'translateY(' + shift + 'px)';

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
        if (panel.hasPointerCapture(pointerId)) {
          panel.releasePointerCapture(pointerId);
        }
      } catch (_) {}
      pointerId = null;

      if (!dragging) return;
      dragging = false;
      root.classList.remove('is-dragging');

      // Порог не больше четверти листа — у низкого листа 110px недостижимы
      const limit = Math.min(SHEET_CLOSE_DRAG, panel.offsetHeight * 0.25);
      if (shift > limit || speed > SHEET_FLING) {
        haptic('light');
        close();
      } else {
        // Не дотянули — лист возвращается на место
        panel.style.transform = '';
      }
    }

    panel.addEventListener('pointerup', release);
    panel.addEventListener('pointercancel', release);

    root.querySelectorAll('[data-sheet-close]').forEach((node) => {
      node.addEventListener('click', () => {
        haptic('light');
        close();
      });
    });

    const api = { open: open, close: close, isOpen: isOpen };
    sheets.push(api);
    return api;
  }

  // «Назад» и Esc закрывают верхнее окно: окно отправки встаёт поверх
  // окна подарка и уходит первым
  function closeOpenSheet() {
    let top = null;
    for (let i = 0; i < sheets.length; i += 1) {
      if (sheets[i].isOpen() && (!top || (sheets[i].at || 0) >= (top.at || 0))) top = sheets[i];
    }
    if (top) top.close();
  }

  // Системная «назад» видна, пока открыто хоть одно окно
  function syncBack() {
    if (!tg || !tg.BackButton) return;
    if (sheets.some((one) => one.isOpen())) tg.BackButton.show();
    else tg.BackButton.hide();
  }

  /* Лист memgift (`.mgm-dock`): выезжает снизу, закрывается крестиком,
     «Закрыть», подложкой, «назад» и пальцем — если тянуть вниз из самого
     верха листа. Крючки те же, что у нижних листов: fill/opened/closed */
  function createDock(root, overlay, hooks) {
    if (!root || !overlay) return null;

    const sheet = root.querySelector('.mgm-sheet');
    const on = hooks || {};
    let timer = null;

    function isOpen() {
      return root.classList.contains('is-open');
    }

    function open(payload) {
      if (isOpen()) return;
      api.at = ++openSeq;
      clearTimeout(timer);
      if (on.fill) on.fill(payload);

      sheet.scrollTop = 0;
      root.style.transform = '';
      overlay.classList.add('is-open');
      root.classList.add('is-open');
      if (stage) stage.style.overflow = 'hidden';
      syncBack();

      if (on.opened) on.opened(payload);
    }

    function close() {
      if (!isOpen()) return;

      overlay.classList.remove('is-open');
      root.classList.remove('is-open', 'is-dragging');
      root.style.transform = '';
      syncBack();
      if (stage && !sheets.some((one) => one.isOpen())) stage.style.overflow = '';

      // Содержимое снимаем, когда лист уже уехал
      timer = setTimeout(() => {
        if (on.closed) on.closed();
      }, 340);
    }

    overlay.addEventListener('click', close);
    root.querySelectorAll('[data-dock-close]').forEach((node) => {
      node.addEventListener('click', () => {
        haptic('light');
        close();
      });
    });

    // Утягивание вниз: только из самого верха листа, иначе это прокрутка
    let startY = null;
    let shift = 0;

    sheet.addEventListener('touchstart', (event) => {
      if (sheet.scrollTop > 0 || event.touches.length !== 1) return;
      startY = event.touches[0].clientY;
      shift = 0;
    }, { passive: true });

    sheet.addEventListener('touchmove', (event) => {
      if (startY === null) return;
      const delta = event.touches[0].clientY - startY;
      // Повели вверх — это прокрутка листа, а не утягивание
      if (delta < 0 && !shift) {
        startY = null;
        return;
      }
      shift = Math.max(0, delta);
      // Тянем вниз — едет весь лист целиком. Без этого iOS ещё и
      // оттягивал содержимое внутри листа «резинкой», и над карточкой
      // открывался пустой фон
      event.preventDefault();
      root.classList.add('is-dragging');
      root.style.transform = 'translate(-50%, ' + shift + 'px)';
    }, { passive: false });

    sheet.addEventListener('touchend', () => {
      if (startY === null) return;
      startY = null;
      root.classList.remove('is-dragging');
      root.style.transform = '';
      if (shift > 110) close();
    });

    const api = { open: open, close: close, isOpen: isOpen };
    sheets.push(api);
    return api;
  }

  let ownGift = null;

  // Подарок лежит у того, кто смотрит, поэтому владелец — он сам.
  // Собачку убираем: в поле стоит ник, а не упоминание.
  function ownerName(gift) {
    // Подарок из чужого профиля — владелец тот, чей это профиль
    if (gift && gift.ownerName) return gift.ownerName;
    const user = tgUser();
    // Как у memgift: имя из Telegram, ник — если имени нет
    if (user) return [user.first_name, user.last_name].filter(Boolean).join(' ') || userTitle(user).replace(/^@/, '');
    return (gift && gift.owner) || '—';
  }

  function fillOwned(gift) {
    ownGift = gift;
    // Чужой подарок только смотрят: кнопки улучшения и отправки убираем
    owned.classList.toggle('is-foreign', Boolean(gift.ownerName));

    const card = document.getElementById('owned-head');
    paintHead(card, gift, document.getElementById('owned-symbol'), document.getElementById('owned-mark'));
    paintUpgrade(gift);

    // Улучшенный: вместо владельца — модель, символ и фон с шансами
    const upg = Boolean(gift.nft);
    document.getElementById('owned-owner-row').hidden = upg;
    owned.querySelectorAll('[data-upg]').forEach((row) => { row.hidden = !upg; });
    if (upg) {
      const symbol = symbolOf(gift.nft.symbol);
      const backdrop = backdropOf(gift.nft.backdrop);
      const put = (id, text) => {
        const node = document.getElementById(id);
        node.textContent = text;
        node.hidden = !text;
      };
      put('owned-model', gift.nft.model.name);
      put('owned-model-pct', pct(gift.nft.model.rate));
      put('owned-sym', gift.nft.symbol || '—');
      put('owned-sym-pct', pct(symbol && symbol.rate));
      put('owned-bd', gift.nft.backdrop || '—');
      put('owned-bd-pct', pct(backdrop && backdrop.rate));
    }

    /* Ценность — своя у каждого улучшенного, ставит админка по его id.
       На чёрном фоне Eclipse строка есть всегда (пока не задана — прочерк),
       у остальных — только когда ценность задана */
    const worth = upg ? gift.nft.value || 0 : 0;
    // Строка «Ценность» — только если админ её добавил
    const showWorth = upg && worth > 0;
    document.getElementById('owned-value-row').hidden = !showWorth;
    if (showWorth) {
      const value = document.getElementById('owned-value');
      value.textContent = '';
      // Ценность — в рублях
      if (worth) {
        value.textContent = formatPrice(worth) + ' ₽';
      } else {
        value.textContent = '—';
      }
    }

    // «Вывести» и «Продать» — только у улучшенного
    document.getElementById('owned-withdraw').hidden = !upg;
    paintOwnedMarket(gift);

    paintRarity(card, gift);
    // Готовый цвет — сразу; иначе подложка остаётся запасной, пока не
    // досчитается, и перекрашивается уже под закрытым листом
    applyTint(card, tintOf(gift));
    if (!tints.has(gift.art)) {
      warmTint(gift, (tint) => {
        if (tint && ownGift === gift) applyTint(card, tint);
      });
    }

    document.getElementById('owned-title').textContent = gift.name;
    document.getElementById('owned-owner').textContent = ownerName(gift);

    const known = typeof gift.left === 'number' && typeof gift.total === 'number';
    document.getElementById('owned-left').textContent = known
      ? t('gift.of', { done: formatPrice(gift.total - gift.left), total: formatPrice(gift.total) })
      : '—';
  }

  // --- Улучшение ---

  /* Как у memgift: «Улучшить» на карточке купленного подарка. Цена в
     звёздах — у каждого подарка своя, счёт выставляет бот прямо поверх
     приложения. Что выпало, решает сервер; окно тут же перерисовывается
     улучшенным, и снизу летит конфетти */

  let upgrading = false;

  function canUpgradeGift(gift) {
    return Boolean(gift) && !gift.nft && Array.isArray(gift.models) && gift.models.length > 0;
  }

  // У улучшенного кнопки нет вовсе; у подарка без моделей она приглушена
  function paintUpgrade(gift) {
    const button = document.getElementById('owned-upgrade');
    if (!button) return;
    button.hidden = Boolean(gift && gift.nft);
    button.classList.toggle('disabled', !canUpgradeGift(gift) && !upgrading);
    button.classList.toggle('loading', upgrading);
    document.getElementById('owned-upgrade-text').textContent = upgrading ? '...' : t('gift.upgrade');
  }

  // Конфетти memgift (`fireFromBottom`): сотня бирюзовых кружков снизу
  let confettiReady = null;

  function loadConfetti() {
    if (!confettiReady) {
      confettiReady = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.js';
        script.onload = () => resolve(prefersStill() ? null : window.confetti);
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    return confettiReady;
  }

  function fireFromBottom() {
    loadConfetti().then((confetti) => {
      if (!confetti || prefersStill()) return;
      confetti({
        particleCount: 100,
        angle: 90,
        spread: 90,
        startVelocity: 45,
        gravity: 0.6,
        decay: 0.9,
        scalar: 1,
        origin: { x: 0.5, y: 1 },
        colors: ['#00FFFF', '#7FFFD4', '#00CED1', '#40E0D0', '#5F9EA0'],
        shapes: ['circle'],
        zIndex: 2000
      });
    }).catch(() => {});
  }

  /* Анимация улучшения — как у Gates Market (видео ШЕПа, 2026-10-13).
     Через всю карточку едет лента моделей подарка: слева направо, сначала
     очень быстро, потом плавно тормозит и ставит выпавшую модель ровно по
     центру. Фон карточки в это время перетекает из цвета в цвет и встаёт на
     выпавший. Строки «Модель / Символ / Фон» под карточкой крутятся как
     барабаны и встают по очереди. После остановки боковые модели
     размываются и уходят, из центральной вылетает конфетти, а под ней по
     буквам печатается имя и серым — номер.

     Пока сервер не ответил, что выпало, лента едет полным ходом; ответ
     пришёл — торможение рассчитывается так, чтобы скорость не дёрнулась */
  const REEL_ITEM = 0.28;      // ширина модели в ленте, доля ширины карточки
  const REEL_PITCH = 0.33;     // шаг между моделями
  const REEL_SPEED = 20;       // моделей в секунду на полном ходу
  const REEL_MS = 3000;        // торможение от полного хода до остановки, мс
  const ROW_SPEED = 14;        // строк в секунду у барабанов
  const ROW_LAND = [0.83, 0.88, 0.93]; // когда встают модель, символ, фон — доли торможения
  const BG_EVERY = 260;        // фон меняется раз в столько мс
  const BG_LAND = 0.55;        // и встаёт на выпавший на этой доле торможения
  const TYPE_MS = 45;          // печать имени — мс на букву
  const REEL_HOLD = 1300;      // сколько итог стоит, прежде чем карточка станет обычной
  let roll = null;

  function easeOut(t) {
    return 1 - Math.pow(1 - t, 4);
  }

  function rollWait(ms) {
    return new Promise((done) => setTimeout(done, ms));
  }

  // Случайный из списка, но не такой же, как сосед
  function rollPick(list, avoid) {
    if (list.length < 2) return list[0];
    let next = avoid;
    while (next === avoid) next = list[Math.floor(Math.random() * list.length)];
    return next;
  }

  function rollPaintBackdrop(one, symbol) {
    const head = document.getElementById('owned-head');
    head.classList.add('is-upg');
    head.style.setProperty('--center-color', one.center);
    head.style.setProperty('--around-color', one.around);
    if (symbol) document.getElementById('owned-symbol').src = symbol.image;
  }

  // Лента или барабан: что стоит на месте index (любое целое), выбирается
  // один раз и запоминается
  function rollItem(track, index) {
    if (!track.items.has(index)) {
      track.items.set(index, rollPick(track.list, track.items.get(index - 1)));
    }
    return track.items.get(index);
  }

  // Торможение до места index: путь такой, чтобы начальная скорость
  // совпала с текущей (у easeOut она в 4 раза больше средней)
  function rollPlan(track, speed, ms, now, target) {
    const ahead = Math.max(3, Math.ceil(speed * ms / 4000));
    const index = Math.ceil(track.pos) + ahead;
    track.items.set(index, target);
    track.plan = { from: track.pos, to: index, at: now, ms: ms };
    return index;
  }

  function rollMove(track, speed, now, dt) {
    if (!track.plan) {
      track.pos += speed * dt;
      return false;
    }
    const t = Math.min(1, (now - track.plan.at) / track.plan.ms);
    track.pos = track.plan.from + (track.plan.to - track.plan.from) * easeOut(t);
    return t >= 1;
  }

  // --- Лента моделей ---

  function reelNode(model) {
    const node = document.createElement('div');
    node.className = 'reel__item';
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    node.appendChild(img);
    shotOf(model).then((shot) => {
      if (shot.still) img.src = shot.still;
    });
    return node;
  }

  function drawReel(r) {
    const width = r.strip.clientWidth || 1;
    const pitch = width * REEL_PITCH;
    const pos = r.reel.pos;
    // Место 0 стоит по центру, когда пройдено 0; места с большими номерами —
    // левее. Лента едет вправо: pos растёт, и слева въезжают новые
    const first = Math.floor(pos - (width / 2 + pitch) / pitch);
    const last = Math.ceil(pos + (width / 2 + pitch) / pitch);
    const keep = new Set();

    for (let i = first; i <= last; i += 1) {
      keep.add(i);
      let node = r.nodes.get(i);
      if (!node) {
        node = reelNode(rollItem(r.reel, i));
        r.strip.appendChild(node);
        r.nodes.set(i, node);
      }
      const x = width / 2 + (pos - i) * pitch;
      node.style.transform = 'translate3d(' + (x - width * REEL_ITEM / 2) + 'px, -50%, 0)';
    }

    r.nodes.forEach((node, i) => {
      if (keep.has(i)) return;
      node.remove();
      r.nodes.delete(i);
    });
  }

  // --- Барабаны строк ---

  function slotLine(one) {
    const line = document.createElement('span');
    line.className = 'slot__line';
    const name = document.createElement('span');
    name.className = 'mgm-info__val';
    name.textContent = one.name;
    line.appendChild(name);
    if (one.rate) {
      const badge = document.createElement('span');
      badge.className = 'mgm-info__pct';
      badge.textContent = pct(one.rate);
      line.appendChild(badge);
    }
    return line;
  }

  function slotMake(valueId, list) {
    const right = document.getElementById(valueId).parentNode;
    right.classList.add('is-slot');
    const box = document.createElement('div');
    box.className = 'slot';
    right.appendChild(box);
    return { box: box, list: list, items: new Map(), nodes: new Map(), pos: Math.random() * list.length, plan: null };
  }

  // Барабан едет вверх: строка с большим номером — ниже
  function drawSlot(slot) {
    const step = slot.box.clientHeight || 50;
    const keep = new Set();
    for (let i = Math.floor(slot.pos) - 1; i <= Math.ceil(slot.pos) + 1; i += 1) {
      keep.add(i);
      let node = slot.nodes.get(i);
      if (!node) {
        node = slotLine(rollItem(slot, i));
        slot.box.appendChild(node);
        slot.nodes.set(i, node);
      }
      node.style.transform = 'translate3d(0, ' + ((i - slot.pos) * step) + 'px, 0)';
    }
    slot.nodes.forEach((node, i) => {
      if (keep.has(i)) return;
      node.remove();
      slot.nodes.delete(i);
    });
  }

  // --- Ход ---

  function rollFrame(now) {
    const r = roll;
    if (!r) return;
    const dt = Math.min(0.05, (now - r.last) / 1000);
    r.last = now;

    const stopped = rollMove(r.reel, REEL_SPEED, now, dt);
    drawReel(r);
    r.slots.forEach((slot) => {
      rollMove(slot, ROW_SPEED, now, dt);
      drawSlot(slot);
    });

    // Щелчок, когда мимо центра проходит модель — но не чаще, чем рука
    // успевает почувствовать
    const tick = Math.round(r.reel.pos);
    if (tick !== r.tick && now - r.tickAt > 55) {
      r.tick = tick;
      r.tickAt = now;
      haptic('select');
    }

    if (stopped && r.landed) {
      r.landed();
      return;
    }
    r.raf = requestAnimationFrame(rollFrame);
  }

  // Начало: лента и барабаны едут полным ходом, фон перетекает
  function rollStart(gift) {
    const models = (gift.models || []).filter((one) => one.art);
    if (!attrs || !attrs.backdrops.length || !models.length || prefersStill()) return;

    const head = document.getElementById('owned-head');
    const stage = document.createElement('div');
    stage.className = 'reel';
    const strip = document.createElement('div');
    strip.className = 'reel__strip';
    const caption = document.createElement('p');
    caption.className = 'reel__caption';
    stage.append(strip, caption);
    head.appendChild(stage);

    owned.classList.add('is-rolling');
    document.getElementById('owned-mark').hidden = true;
    closeArt(document.getElementById('owned-art'), ownPlayer);
    ownPlayer = null;

    // Вместо владельца — строки модели, символа и фона, они и крутятся
    document.getElementById('owned-owner-row').hidden = true;
    owned.querySelectorAll('[data-upg]').forEach((row) => { row.hidden = false; });

    const now = performance.now();
    roll = {
      gift: gift,
      stage: stage,
      strip: strip,
      caption: caption,
      reel: { list: models, items: new Map(), pos: 0, plan: null },
      nodes: new Map(),
      slots: [
        slotMake('owned-model', models),
        slotMake('owned-sym', attrs.symbols.length ? attrs.symbols : [{ name: '—' }]),
        slotMake('owned-bd', attrs.backdrops)
      ],
      last: now,
      tick: 0,
      tickAt: 0,
      raf: 0,
      bgTimer: 0,
      landed: null
    };

    // Фон и узор символа перетекают из одного в другой
    let backdrop = null;
    const shift = () => {
      backdrop = rollPick(attrs.backdrops, backdrop);
      rollPaintBackdrop(backdrop, rollPick(attrs.symbols));
    };
    shift();
    roll.bgTimer = setInterval(shift, BG_EVERY);

    roll.raf = requestAnimationFrame(rollFrame);
  }

  // Конфетти из центральной модели — небольшое, во все стороны вверх
  function burstFrom(node) {
    if (!node) return;
    loadConfetti().then((confetti) => {
      if (!confetti) return;
      const rect = node.getBoundingClientRect();
      confetti({
        particleCount: 46,
        spread: 80,
        startVelocity: 22,
        gravity: 0.7,
        decay: 0.92,
        scalar: 0.55,
        ticks: 140,
        origin: {
          x: (rect.left + rect.width / 2) / window.innerWidth,
          y: (rect.top + rect.height * 0.25) / window.innerHeight
        },
        colors: ['#ff5f5f', '#ffd23f', '#6be36b', '#4fc3ff', '#b06bff', '#ff8ad8'],
        zIndex: 2000
      });
    }).catch(() => {});
  }

  // Имя по буквам, потом серым номер — как в образце
  async function typeCaption(r, name, num, token) {
    const title = document.createElement('span');
    const tail = document.createElement('span');
    tail.className = 'reel__num';
    r.caption.append(title, tail);
    for (const letter of Array.from(name)) {
      if (roll !== token) return;
      title.textContent += letter;
      await rollWait(TYPE_MS);
    }
    for (const letter of Array.from(' #' + num)) {
      if (roll !== token) return;
      tail.textContent += letter;
      await rollWait(TYPE_MS);
    }
  }

  // Ответ пришёл: тормозим ленту и барабаны до выпавшего, потом итог
  async function rollLand(nft) {
    const r = roll;
    if (!r) return;
    const now = performance.now();
    const models = r.reel.list;
    const target = models.find((one) => one.name === nft.model.name) || nft.model;

    const ms = REEL_MS;
    const center = rollPlan(r.reel, REEL_SPEED, ms, now, target);

    const symbol = symbolOf(nft.symbol);
    const backdrop = backdropOf(nft.backdrop);
    const finals = [
      Object.assign({}, target, { name: nft.model.name, rate: nft.model.rate }),
      symbol || { name: nft.symbol || '—' },
      backdrop || { name: nft.backdrop || '—' }
    ];
    r.slots.forEach((slot, i) => rollPlan(slot, ROW_SPEED, ms * ROW_LAND[i], now, finals[i]));

    // Фон встаёт раньше ленты
    setTimeout(() => {
      if (roll !== r) return;
      clearInterval(r.bgTimer);
      if (backdrop) rollPaintBackdrop(backdrop, symbol);
    }, ms * BG_LAND);

    await new Promise((done) => { r.landed = done; });
    if (roll !== r) return;

    // Итог: боковые размываются и уходят, центральная — в конфетти
    const centerNode = r.nodes.get(center);
    if (centerNode) centerNode.classList.add('is-center');
    r.stage.classList.add('is-done');
    haptic('success');
    burstFrom(centerNode);
    await rollWait(180);
    await typeCaption(r, (r.gift && r.gift.name) || nft.model.name, nft.num, r);
    await rollWait(REEL_HOLD);
  }

  function rollStop() {
    if (!roll) return;
    cancelAnimationFrame(roll.raf);
    clearInterval(roll.bgTimer);
    roll.stage.remove();
    roll.slots.forEach((slot) => {
      slot.box.parentNode.classList.remove('is-slot');
      slot.box.remove();
    });
    roll = null;
    owned.classList.remove('is-rolling');
  }

  function upgradeOwned() {
    const gift = ownGift;
    if (upgrading || !gift || gift.nft) return;
    haptic('light');

    if (!canUpgradeGift(gift)) {
      toast(t('upg.no'));
      return;
    }
    if (!Store.live()) {
      toast(t('pay.noDb'));
      return;
    }

    upgrading = true;
    paintUpgrade(gift);

    payPost({ action: 'upgrade', giftId: gift.id })
      .then((data) => {
        // Бесплатно — уже улучшено, счёт не нужен: карточка сразу крутится
        if (data.status === 'paid') {
          rollStart(gift);
          return data;
        }
        if (!tg || !tg.openInvoice) throw new Error(t('pay.oldApp'));

        return new Promise((done) => {
          tg.openInvoice(data.link, (status) => done({ status: status, order: data.order }));
        }).then((result) => {
          if (result.status === 'cancelled') return null;
          if (result.status === 'failed') throw new Error(t('pay.failed'));
          // Оплачено — крутим, пока сервер не скажет, что выпало
          rollStart(gift);
          return waitPaid(result.order, PAY_TRIES);
        });
      })
      .then((paid) => {
        if (!paid) return null;
        if (paid.status !== 'paid' || !paid.me || !paid.nft) {
          toast(t('pay.slow'));
          return null;
        }
        // Карточка докручивается до выпавшего, и только потом — итог
        return rollLand(paid.nft).then(() => paid);
      })
      .then((paid) => {
        const rolled = Boolean(roll);
        rollStop();
        if (!paid) {
          // Не вышло — карточка возвращается к обычному подарку
          if (rolled && ownSheet && ownGift === gift) {
            fillOwned(gift);
            closeArt(document.getElementById('owned-art'), ownPlayer);
            ownPlayer = openArt(document.getElementById('owned-art'), gift);
          }
          return;
        }

        Store.apply(paid.content || null, paid.me);
        fillFromStore();
        initHeader();
        paintProfile();

        // Окно остаётся открытым и становится улучшенным — как у memgift
        const fresh = OWNED.upg.find((one) => one.nft.id === paid.nft.id);
        if (fresh && ownSheet && ownGift === gift) {
          upgrading = false;
          fillOwned(fresh);
          closeArt(document.getElementById('owned-art'), ownPlayer);
          ownPlayer = openArt(document.getElementById('owned-art'), artOf(fresh));
          playTickerIcons();
        }

        // После ленты конфетти уже было — из центральной модели
        if (!rolled) {
          haptic('success');
          fireFromBottom();
        }
      })
      .catch((error) => {
        const rolled = Boolean(roll);
        rollStop();
        if (rolled && ownSheet && ownGift === gift) {
          fillOwned(gift);
          closeArt(document.getElementById('owned-art'), ownPlayer);
          ownPlayer = openArt(document.getElementById('owned-art'), gift);
        }
        toast(error && error.message ? error.message : t('pay.sorry'));
      })
      .then(() => {
        upgrading = false;
        if (ownGift) paintUpgrade(ownGift);
      });
  }

  // --- Поделиться ---

  /* Как `useShare` у memgift: окно пересылки Telegram со ссылкой на бота.
     Ссылка открывает приложение сразу на этом подарке (startapp=gift_<id>) */
  const BOT_LINK = 'https://t.me/GapsGiftBot';

  function giftLink(gift) {
    return BOT_LINK + '?startapp=gift_' + encodeURIComponent(gift.id);
  }

  function shareGift(gift) {
    haptic('light');
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(giftLink(gift)) +
      '&text=' + encodeURIComponent(t('gift.shareText', { name: gift.name }));
    if (tg && tg.openTelegramLink && tg.initData) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  /* Свой подарок из профиля делится иначе: ссылка открывает профиль того,
     кто поделился, и сразу окно этого подарка (startapp=p_<id>_<подарок>).
     Улучшенный узнаётся по своему номеру, обычный — по подарку витрины */
  function ownedLink(gift) {
    // Подарок на продаже — ссылка ведёт прямо в его покупку на маркете
    const lotId = gift.lot ? gift.lot.id : gift.nft && gift.nft.lot;
    if (lotId) return BOT_LINK + '?startapp=lot_' + encodeURIComponent(lotId);
    const user = tgUser();
    const owner = gift.ownerName ? VIEWED.id : user && user.id;
    if (!owner) return giftLink(gift);
    return BOT_LINK + '?startapp=p_' + owner + '_' + encodeURIComponent(gift.nft ? gift.nft.id : gift.id);
  }

  function shareOwned(gift) {
    haptic('light');
    const name = gift.nft ? gift.name + ' #' + gift.nft.num : gift.name;
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(ownedLink(gift)) +
      '&text=' + encodeURIComponent(t(gift.ownerName ? 'gift.shareText' : 'gift.shareMine', { name: name }));
    if (tg && tg.openTelegramLink && tg.initData) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  // Подарок из своего профиля: обычный — по id витрины, улучшенный — по номеру
  function findOwned(list, key) {
    return list.find((one) => one.nft && one.nft.id === key) ||
      list.find((one) => !one.nft && one.id === key) || null;
  }

  // Пришли по такой ссылке — сразу открываем страницу подарка
  function openStartGift() {
    let start = String((tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '');
    if (!start && tg && tg.initData) {
      try { start = new URLSearchParams(tg.initData).get('start_param') || ''; } catch (_) {}
    }
    // Подарок на продаже: маркет и сразу окно покупки
    const sale = /^lot_([a-z0-9-]+)$/.exec(start);
    if (sale) {
      openLot((lot) => lot.id === sale[1]);
      return;
    }

    // Чужой (или свой) подарок из профиля: профиль человека и окно подарка
    const shared = /^p_(\d{1,20})_([a-z0-9-]+)$/.exec(start);
    if (shared) {
      const me = tgUser();
      // Ссылку дали раньше, а подарок с тех пор выставили — ведём в покупку
      if (!(me && String(me.id) === shared[1]) && Store.live()) {
        loadMarket().then(() => {
          const lot = LOTS.find((one) => one.nft.id === shared[2] && String(one.seller.id) === shared[1]);
          if (lot) openLot((one) => one.id === lot.id);
          else openView({ id: shared[1], focus: shared[2] });
        });
        return;
      }
      if (me && String(me.id) === shared[1]) {
        const at = tabs.findIndex((tab) => tab.dataset.section === 'profile');
        if (at !== -1) selectTab(at);
        const mine = findOwned(OWNED.gifts.concat(OWNED.upg), shared[2]);
        if (mine && ownSheet) ownSheet.open(mine);
      } else {
        openView({ id: shared[1], focus: shared[2] });
      }
      return;
    }

    const match = /^gift_([a-z0-9-]+)$/.exec(start);
    const gift = match && giftById(match[1]);
    if (gift && buySheet) buySheet.open(gift);
  }

  /* Иконки «Вывести» и «Крафт» — анимации .tgs: проигрываются разок,
     когда открывается окно улучшенного подарка, и замирают */
  const tickerIcons = new Map();

  function playTickerIcons() {
    if (!window.lottie) return;
    owned.querySelectorAll('[data-icon]').forEach((box) => {
      // Скрытая кнопка — значок не заводим: анимация в скрытом месте
      // получает нулевой размер и потом так и остаётся пустой
      if (!box.offsetParent) return;
      let player = tickerIcons.get(box);
      if (player) player.resize();
      if (!player) {
        player = window.lottie.loadAnimation({
          container: box,
          renderer: 'canvas',
          loop: false,
          rendererSettings: { dpr: Math.min(window.devicePixelRatio || 1, 2) },
          autoplay: false,
          path: box.dataset.icon
        });
        tickerIcons.set(box, player);
      }
      if (prefersStill()) player.goToAndStop(player.totalFrames - 1 || 0, true);
      else player.goToAndPlay(0, true);
    });
  }

  /* Маркет в окне подарка. Свой улучшенный: «Продать», а если уже
     выставлен — «Снять» и плашка «Выставлен на маркете». Лот из маркета —
     окно memgift: баланс над окном, цена под названием, «Купить ◆ 2» */
  function paintOwnedMarket(gift) {
    const upg = Boolean(gift && gift.nft);
    const lot = gift && gift.lot;
    const listed = Boolean(upg && !lot && gift.nft.lot);

    // Тикер как у memgift: «Продать» со значком маркета, у выставленного —
    // «Снять» с перечёркнутым. «Вывести» у выставленного нет
    const sell = document.getElementById('owned-sell');
    sell.hidden = !upg || Boolean(lot);
    document.getElementById('owned-sell-text').textContent = t(listed ? 'market.unlist' : 'market.sell');
    const ico = document.getElementById('owned-sell-ico');
    ico.setAttribute('viewBox', listed ? '0 0 29 29' : '0 -1 24 24');
    ico.querySelector('use').setAttribute('href', listed ? '#market-off' : '#market');
    if (upg && !lot) document.getElementById('owned-withdraw').hidden = listed;
    // У выставленного вместо «Вывести» — «Цена»: поменять, не снимая
    document.getElementById('owned-reprice').hidden = !listed;

    // Выставленный не отправить — кнопка приглушена
    document.getElementById('owned-send').classList.toggle('disabled', listed);

    document.getElementById('owned-onmarket').hidden = !listed;

    // Цена под названием — и у лота в маркете, и у своего выставленного
    const price = lot ? lot.nano : listed ? gift.nft.lotNano : 0;
    document.getElementById('owned-price').hidden = !price;
    if (price) document.getElementById('owned-price-text').textContent = formatTon(price);

    // «Купить» — у всех, кроме продавца: у него вместо неё «Закрыть»
    const buyable = Boolean(lot) && !isMine(lot);
    document.getElementById('owned-chrome').hidden = !lot;
    document.getElementById('owned-lotfoot').hidden = !buyable;
    document.getElementById('owned-close').parentNode.hidden = buyable;
    if (!buyable) return;

    paintGram();
    document.getElementById('owned-buy').disabled = false;
    document.getElementById('owned-buy-price').textContent = formatTon(lot.nano);
  }

  function initOwnedTools() {
    if (!owned) return;

    document.getElementById('owned-sell').addEventListener('click', () => {
      if (!ownGift || !ownGift.nft) return;
      haptic('light');
      if (ownGift.nft.lot) unlistOwned(ownGift);
      else openSell(ownGift);
    });

    document.getElementById('owned-reprice').addEventListener('click', () => {
      if (!ownGift || !ownGift.nft || !ownGift.nft.lot) return;
      haptic('light');
      openSell(ownGift, true);
    });

    document.getElementById('owned-onmarket').addEventListener('click', () => {
      haptic('light');
      ownSheet.close();
      goMarket();
    });

    document.getElementById('owned-buy').addEventListener('click', () => {
      if (ownGift) buyLot(ownGift);
    });


    const soon = (key) => () => {
      haptic('light');
      toast(t(key));
    };

    document.getElementById('owned-send').addEventListener('click', () => {
      if (!ownGift) return;
      haptic('light');
      if (ownGift.nft && ownGift.nft.lot) {
        toast(t('market.noSend'));
        return;
      }
      sendSheet.open(ownGift);
    });

    document.getElementById('owned-upgrade').addEventListener('click', upgradeOwned);
    document.getElementById('owned-share').addEventListener('click', () => {
      if (ownGift) shareOwned(ownGift);
    });

    document.getElementById('owned-copy').addEventListener('click', () => {
      if (!ownGift) return;
      copyText(ownedLink(ownGift), 'profile.linkCopied');
    });
  }

  // В буфер обмена — с запасным путём для старых клиентов
  function copyText(value, doneKey) {
    const done = () => {
      haptic('success');
      toast(t(doneKey));
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, () => {
        if (legacyCopy(value)) done();
      });
      return;
    }

    if (legacyCopy(value)) done();
  }

  // --- TON-кошелёк ---

  /* Как у memgift: свой кошелёк человек подключает через TON Connect,
     адрес запоминает сервер. Пополнение и вывод на странице кошелька
     выглядят как у образца, но денег пока не двигают — на отправку окно
     честно говорит, что это скоро заработает */
  const WALLET_API = '/api/wallet';

  let tc = null;
  let walletAddr = '';
  let walletSheet = null;
  let unlinkSheet = null;
  let wmodKind = 'deposit';
  let wmodAmount = '';

  // «UQAb…9fXz» — начало и конец адреса, как у образца
  function shortAddr(address) {
    return address && address.length > 12 ? address.slice(0, 4) + '…' + address.slice(-4) : address || '';
  }

  function walletPost(payload) {
    return fetch(WALLET_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData: (tg && tg.initData) || '' }, payload))
    }).then((response) => response.json()
      .catch(() => ({}))
      .then((data) => {
        if (!response.ok) throw new Error(data.message || '');
        return data;
      }));
  }

  const NANO = 1e9;

  // Баланс TON на счёте — сервер хранит его в нанотонах
  function tonBalance() {
    return (Number(ME && ME.tonNano) || 0) / NANO;
  }

  function tonRate() {
    const state = Store.state() || {};
    return (state.ton && state.ton.rate) || 0;
  }

  function tonAddress() {
    const state = Store.state() || {};
    return (state.ton && state.ton.address) || '';
  }

  // Цена в нанотонах — та же формула, что на сервере: звёзды по курсу, вверх
  function tonCost(stars) {
    const rate = tonRate();
    return rate > 0 ? Math.ceil(stars * NANO / rate) : 0;
  }

  // 1.234567 → «1,23», 0.004 → «0,004»: копейки не теряем, лишних нулей не пишем
  function formatTon(nano) {
    const value = (Number(nano) || 0) / NANO;
    const digits = value > 0 && value < 0.01 ? 4 : 2;
    const fixed = (Math.floor(value * Math.pow(10, digits)) / Math.pow(10, digits)).toFixed(digits)
      .replace(/\.?0+$/, '');
    const parts = fixed.split('.');
    parts[0] = formatPrice(parts[0]);
    return parts.join(window.I18N.lang() === 'ru' ? ',' : '.');
  }

  /* Комментарий к переводу — ячейка TON, сериализованная в BOC: 32 нулевых
     бита и текст. Собираем её сами: одна ячейка без ссылок, с CRC32C.
     Сверено побайтно с @ton/core */
  function crc32c(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x82F63B78 : crc >>> 1;
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function commentBoc(text) {
    const body = [0, 0, 0, 0].concat(Array.from(new TextEncoder().encode(text)));
    const cell = [0, body.length * 2].concat(body);
    const all = [0xb5, 0xee, 0x9c, 0x72, 0x41, 0x01, 1, 1, 0, cell.length, 0].concat(cell);
    const crc = crc32c(all);
    all.push(crc & 255, (crc >>> 8) & 255, (crc >>> 16) & 255, (crc >>> 24) & 255);
    return btoa(String.fromCharCode.apply(null, all));
  }

  function paintWallet() {
    const on = Boolean(walletAddr);
    paintGram();

    const button = document.getElementById('prf-wallet');
    if (button) {
      button.classList.toggle('is-on', on);
      document.getElementById('prf-wallet-text').textContent = on ? shortAddr(walletAddr) : t('profile.connect');
    }

    const hereOn = document.getElementById('wl-on');
    if (hereOn) {
      hereOn.hidden = !on;
      document.getElementById('wl-off').hidden = on;
      document.getElementById('wl-addr').textContent = shortAddr(walletAddr);
      document.getElementById('wl-balance').textContent = formatTon(Number(ME && ME.tonNano) || 0);
    }

    const modal = document.getElementById('wmod-wallet');
    if (modal) {
      modal.hidden = !on;
      document.getElementById('wmod-connect').hidden = on;
      document.getElementById('wmod-addr').textContent = shortAddr(walletAddr);
      paintWmod();
    }
  }

  /* Кошелёк, как у memgift, открывается только с подключённым кошельком:
     без него вместо страницы — окно подключения, а когда кошелёк
     подключится, страница откроется сама. Ждём этого пару минут: если
     человек закрыл окно и подключился позже по другому поводу, страница
     не должна выскочить сама */
  const WALLET_WAIT = 2 * 60 * 1000;
  let walletWanted = 0;

  function openWalletPage() {
    haptic('light');
    if (walletAddr) {
      walletWanted = 0;
      walletSheet.open();
      return;
    }
    walletWanted = Date.now();
    toast(t('wallet.needConnect'));
    connectWallet();
  }

  // Новый адрес из кошелька — запоминаем на сервере
  function rememberWallet(address) {
    if (address === walletAddr) return;
    walletAddr = address;
    paintWallet();
    if (walletWanted && Date.now() - walletWanted < WALLET_WAIT) {
      walletWanted = 0;
      walletSheet.open();
    }
    if (!Store.live()) return;

    walletPost({ action: 'bind', address: address })
      .then(() => {
        if (ME) ME.wallet = address;
        haptic('success');
        toast(t('wallet.linked'));
      })
      .catch(() => toast(t('wallet.linkFail')));
  }

  function tonReady(run) {
    if (window.TON_CONNECT_UI) {
      run();
      return;
    }
    window.addEventListener('load', () => {
      if (window.TON_CONNECT_UI) run();
    }, { once: true });
  }

  function initTon() {
    tonReady(() => {
      try {
        tc = new window.TON_CONNECT_UI.TonConnectUI({
          manifestUrl: location.origin + '/tonconnect-manifest.json',
          language: window.I18N.lang() === 'ru' ? 'ru' : 'en',
          uiPreferences: { theme: 'DARK' }
        });
      } catch (_) {
        tc = null;
        return;
      }

      tc.onStatusChange((wallet) => {
        if (!wallet || !wallet.account) return;
        try {
          const testnet = wallet.account.chain === '-3';
          rememberWallet(window.TON_CONNECT_UI.toUserFriendlyAddress(wallet.account.address, testnet));
        } catch (_) {}
      });
    });
  }

  function connectWallet() {
    haptic('light');
    if (!tc) {
      toast(t('wallet.loading'));
      return;
    }
    // Язык окна выбора — тот, что выбран в приложении сейчас
    tc.uiOptions = { language: window.I18N.lang() === 'ru' ? 'ru' : 'en' };
    tc.openModal();
  }

  function unlinkWallet() {
    haptic('light');
    if (tc && tc.connected) tc.disconnect().catch(() => {});
    walletAddr = '';
    if (ME) ME.wallet = '';
    paintWallet();
    unlinkSheet.close();
    // Без кошелька страницы кошелька нет — закрываем и её
    if (walletSheet && walletSheet.isOpen && walletSheet.isOpen()) walletSheet.close();
    toast(t('wallet.unlinked'));
    if (Store.live()) walletPost({ action: 'unbind' }).catch(() => {});
  }

  // --- Окна «Внести» и «Вывести» ---

  function wmodNumber() {
    return Number(wmodAmount) || 0;
  }

  let wmodBusy = false;

  function paintWmod() {
    const amount = wmodNumber();
    document.getElementById('wmod-amount').textContent = wmodAmount || '0';

    // Баланс мог обновиться, пока окно открыто: пришло пополнение
    document.getElementById('wmod-balance').textContent =
      t('wallet.balance') + ' · ' + formatTon(Number(ME && ME.tonNano) || 0) + ' TON';

    const deposit = wmodKind === 'deposit';
    const label = t(deposit ? 'wallet.deposit' : 'wallet.withdraw');
    document.getElementById('wmod-submit-text').textContent = amount > 0 ? label + ' ' + wmodAmount + ' TON' : label;

    // Как у образца: внести — от 0,1 TON, вывести — от 0,1 TON, не больше
    // баланса и только на подключённый кошелёк
    document.getElementById('wmod-submit').disabled = wmodBusy || (deposit
      ? amount < 0.1
      : !(amount >= 0.1 && amount <= tonBalance() && walletAddr));
  }

  function wmodTap(key) {
    haptic('select');
    if (key === 'back') {
      wmodAmount = wmodAmount.slice(0, -1);
    } else if (key === '.') {
      if (wmodAmount.indexOf('.') === -1) wmodAmount = (wmodAmount || '0') + '.';
    } else {
      const next = wmodAmount === '0' ? key : wmodAmount + key;
      const parts = next.split('.');
      if (parts[0].length <= 9 && (!parts[1] || parts[1].length <= 2)) wmodAmount = next;
    }
    paintWmod();
  }

  function wmodIsOpen() {
    return document.getElementById('wmod').classList.contains('is-open');
  }

  let wmodEntry = null;

  function wmodOpen(kind) {
    if (wmodEntry) wmodEntry.at = ++openSeq;
    haptic('light');
    wmodKind = kind;
    wmodAmount = '';
    const deposit = kind === 'deposit';
    document.getElementById('wmod-title').textContent = t(deposit ? 'wallet.depositTitle' : 'wallet.withdrawTitle');
    document.getElementById('wmod-balance').hidden = deposit;
    document.getElementById('wmod-info').hidden = deposit;
    paintWallet();

    document.getElementById('wmod-overlay').classList.add('is-open');
    document.getElementById('wmod').classList.add('is-open');
    syncBack();
  }

  function wmodClose() {
    if (!wmodIsOpen()) return;
    document.getElementById('wmod-overlay').classList.remove('is-open');
    document.getElementById('wmod').classList.remove('is-open');
    syncBack();
  }

  /* Пополнение: перевод с подключённого кошелька на наш адрес с
     комментарием «GG<id>». Деньги идут в блокчейне без нас, а зачисление
     сервер видит сам — приложение просто переспрашивает, пока не дойдёт */
  const DEPOSIT_TRIES = 24;
  const DEPOSIT_WAIT = 5000;
  let depositTimer = null;

  function walletState(fresh) {
    if (!Store.live()) return Promise.resolve(null);
    return walletPost({ action: fresh ? 'check' : 'state' })
      .then((data) => {
        if (ME) ME.tonNano = data.tonNano || 0;
        tonLog = data.log || [];
        renderTonLog(tonLog);
        paintWallet();
        return data;
      })
      .catch(() => null);
  }

  function watchDeposit(before, left) {
    clearTimeout(depositTimer);
    depositTimer = setTimeout(() => {
      walletState(true).then((data) => {
        if (data && (data.tonNano || 0) > before) {
          haptic('success');
          toast(t('wallet.credited', { n: formatTon((data.tonNano || 0) - before) }));
          if (sheetGift) setQty(qty);
          return;
        }
        if (left > 1) watchDeposit(before, left - 1);
      });
    }, DEPOSIT_WAIT);
  }

  function sendDeposit() {
    const amount = wmodNumber();
    const me = tgUser();
    if (!tc || !tc.connected) {
      connectWallet();
      return;
    }
    if (!me || amount < 0.1 || !tonAddress()) return;

    const before = Number(ME && ME.tonNano) || 0;
    tc.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [{
        address: tonAddress(),
        amount: String(Math.round(amount * NANO)),
        payload: commentBoc('GG' + me.id)
      }]
    }).then(() => {
      haptic('success');
      toast(t('wallet.sent'));
      wmodClose();
      watchDeposit(before, DEPOSIT_TRIES);
    }).catch(() => {
      // Человек передумал в кошельке — молча ничего не делаем
    });
  }

  /* Вывод — заявка: сумма сразу уходит с баланса, а TON на подключённый
     кошелёк отправляет админ. В истории заявка видна «в обработке», пока
     её не отправят; отклонённая возвращает сумму на баланс */
  function sendWithdraw() {
    const amount = wmodNumber();
    if (wmodBusy || !walletAddr || amount < 0.1 || amount > tonBalance()) return;
    if (!Store.live()) {
      toast(t('pay.noDb'));
      return;
    }

    wmodBusy = true;
    paintWmod();
    walletPost({ action: 'withdraw', amount: wmodAmount })
      .then((data) => {
        if (ME) ME.tonNano = data.tonNano || 0;
        tonLog = data.log || [];
        renderTonLog(tonLog);
        paintWallet();
        haptic('success');
        toast(t('wallet.withdrawSent'));
        wmodClose();
      })
      .catch((error) => toast(error.message || t('pay.sorry')))
      .then(() => {
        wmodBusy = false;
        paintWmod();
      });
  }

  // История как у memgift: пополнения и покупки с баланса
  function renderTonLog(log) {
    const box = document.getElementById('wl-list');
    const empty = document.querySelector('.wl-empty');
    if (!box || !empty) return;

    const tab = (document.querySelector('.wl-filters__item.active') || {}).dataset;
    const kind = tab ? tab.tab : 'all';
    const shown = log.filter((one) => kind === 'all' ||
      (kind === 'gifts' && (one.type === 'gift' || one.type === 'market_buy' || one.type === 'market_sell')) ||
      (kind === 'deposits' && (one.type === 'deposit' || one.type === 'ref_bonus')) ||
      (kind === 'withdrawals' && one.type === 'withdraw'));

    box.textContent = '';
    box.hidden = !shown.length;
    empty.hidden = Boolean(shown.length);

    shown.forEach((one) => {
      const row = document.createElement('div');
      row.className = 'item';

      const nft = document.createElement('div');
      nft.className = 'nft';
      const market = one.type === 'market_buy' || one.type === 'market_sell';
      const income = one.type === 'deposit' || one.type === 'ref_bonus';
      const gift = one.type === 'gift' || market ? giftById(one.giftId) : null;
      if (gift) {
        showShot(nft, gift);
      } else {
        nft.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="' +
          (income ? 'M10 4v12M4 10l6 6 6-6' : 'M10 16V4M16 10l-6-6-6 6') + '"></path></svg>';
      }

      const mid = document.createElement('div');
      mid.className = 'mid';
      const name = document.createElement('h4');
      name.className = 'name';
      name.textContent = gift
        ? gift.name + (one.num ? ' #' + one.num : '') + (one.qty > 1 ? ' × ' + one.qty : '')
        : one.type === 'ref_bonus' ? t('wallet.refFrom', { name: one.from || '—' })
          : t(one.type === 'deposit' ? 'wallet.statusDeposit' : 'wallet.statusWithdraw');
      const meta = document.createElement('div');
      meta.className = 'meta-row';
      const time = document.createElement('span');
      time.textContent = new Date(one.at).toLocaleString(window.I18N.lang() === 'ru' ? 'ru-RU' : 'en-GB', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = '·';
      const price = document.createElement('span');
      const plus = income || one.type === 'market_sell';
      price.className = 'price ' + (plus ? 'is-plus' : one.status === 'rejected' ? '' : 'is-minus');
      price.textContent = (plus ? '+' : '−') + formatTon(one.nano) + ' TON';
      meta.append(time, dot, price);
      mid.append(name, meta);

      const right = document.createElement('div');
      right.className = 'right';
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = t(one.type === 'market_buy' ? 'wallet.statusMarketBuy'
        : one.type === 'market_sell' ? 'wallet.statusMarketSell'
        : one.type === 'ref_bonus' ? 'wallet.statusRef'
        : one.type === 'gift' ? 'wallet.statusGift'
        : one.type === 'deposit' ? 'wallet.statusDeposit'
          // У вывода — где заявка: ждёт админа, отправлена или отклонена
          : one.status === 'pending' ? 'wallet.wdPending'
            : one.status === 'rejected' ? 'wallet.wdRejected'
              : one.status === 'done' ? 'wallet.wdDone' : 'wallet.statusWithdraw');
      if (one.type === 'withdraw' && one.status) status.classList.add('is-' + one.status);
      right.appendChild(status);

      row.append(nft, mid, right);
      box.appendChild(row);
    });
  }

  let tonLog = [];

  function initWallet() {
    const page = document.getElementById('walletpage');
    if (!page) return;

    walletAddr = (ME && ME.wallet) || '';

    walletSheet = createSheet(page, {
      fill: () => {
        paintWallet();
        renderTonLog(tonLog);
        walletState(true);
      }
    });
    unlinkSheet = createSheet(document.getElementById('unlink'));

    document.getElementById('prf-walletpage').addEventListener('click', openWalletPage);
    ['hdr-gram-btn', 'prf-gram-btn', 'mkt-gram-btn'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.addEventListener('click', openWalletPage);
    });
    // Баланс над окном лота — как у memgift: окно закрывается, открывается кошелёк
    const lotBalance = document.getElementById('owned-balance-btn');
    if (lotBalance) {
      lotBalance.addEventListener('click', () => {
        if (ownSheet) ownSheet.close();
        openWalletPage();
      });
    }

    document.getElementById('prf-wallet').addEventListener('click', () => {
      if (walletAddr) {
        haptic('light');
        unlinkSheet.open();
      } else {
        connectWallet();
      }
    });

    document.getElementById('wl-connect').addEventListener('click', connectWallet);
    document.getElementById('wmod-connect').addEventListener('click', connectWallet);
    document.getElementById('wl-unlink').addEventListener('click', () => {
      haptic('light');
      unlinkSheet.open();
    });
    document.getElementById('unlink-go').addEventListener('click', unlinkWallet);

    // Вкладки истории: все операции, покупки, пополнения, выводы
    const filters = document.getElementById('wl-filters');
    filters.addEventListener('click', (event) => {
      const item = event.target.closest('.wl-filters__item');
      if (!item) return;
      haptic('select');
      filters.querySelectorAll('.wl-filters__item').forEach((one) => one.classList.toggle('active', one === item));
      renderTonLog(tonLog);
    });

    document.getElementById('wl-deposit').addEventListener('click', () => wmodOpen('deposit'));
    document.getElementById('wl-withdraw').addEventListener('click', () => wmodOpen('withdraw'));
    document.getElementById('wmod-overlay').addEventListener('click', wmodClose);
    document.getElementById('wmod-close').addEventListener('click', wmodClose);
    document.getElementById('wmod-pad').addEventListener('click', (event) => {
      const key = event.target.closest('[data-key]');
      if (key) wmodTap(key.dataset.key);
    });
    document.getElementById('wmod-submit').addEventListener('click', () => {
      haptic('light');
      if (wmodKind === 'deposit') {
        sendDeposit();
        return;
      }
      sendWithdraw();
    });

    // В общем списке окон: «назад» и Esc закрывают и его
    wmodEntry = { open: wmodOpen, close: wmodClose, isOpen: wmodIsOpen };
    sheets.push(wmodEntry);

    paintWallet();
    initTon();
  }

  // --- Реферальная программа ---

  /* Страница memgift: своя ссылка `startapp=ref_<id>`, «Копировать» и
     «Поделиться», ниже — кто по ней пришёл. Список приходит частями по
     двадцать и догружается, когда прокрутка доходит до конца */
  const REF_API = '/api/referrals';

  let refSheet = null;
  let refLink = '';
  let refOffset = 0;
  let refMore = false;
  let refBusy = false;

  // Как у образца: длинную ссылку показываем с многоточием посередине
  function shortLink(link) {
    const bare = link.replace(/^https?:\/\//, '');
    return bare.length <= 36 ? bare : bare.slice(0, 18) + '…' + bare.slice(-12);
  }

  function refRow(person) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'rf-row';

    const ava = document.createElement('div');
    ava.className = 'rf-row__ava';
    if (person.photo) {
      const img = document.createElement('img');
      img.src = person.photo;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      ava.appendChild(img);
    } else {
      const letter = document.createElement('span');
      letter.textContent = ((person.name || '?').replace('@', '').trim().charAt(0) || '?').toUpperCase();
      ava.appendChild(letter);
    }

    const mid = document.createElement('div');
    mid.className = 'rf-row__mid';
    const name = document.createElement('span');
    name.className = 'rf-row__name';
    name.textContent = person.name || '—';
    const id = document.createElement('span');
    id.className = 'rf-row__id';
    id.textContent = person.tld;
    mid.append(name, id);

    const go = document.createElement('span');
    go.className = 'rf-row__go';
    go.innerHTML = '<svg viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1.5L6.5 7 1 12.5"></path></svg>';

    row.append(ava, mid);
    // Сколько этот друг уже принёс с пополнений
    if (person.earned > 0) {
      const earned = document.createElement('span');
      earned.className = 'rf-row__earned';
      earned.innerHTML = '+<svg viewBox="0 0 19 16" aria-hidden="true"><use href="#gram"></use></svg>';
      earned.appendChild(document.createTextNode(formatTon(person.earned)));
      row.appendChild(earned);
    }
    row.appendChild(go);
    // Чужих профилей у нас нет — по нажатию берём ID, как образец по нажатию на него
    row.addEventListener('click', () => copyText(String(person.tld), 'ref.idCopied'));
    return row;
  }

  function loadRefs(reset) {
    if (refBusy || (!reset && !refMore)) return;
    if (!Store.live()) return;
    refBusy = true;
    if (reset) refOffset = 0;

    fetch(REF_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: (tg && tg.initData) || '', offset: refOffset })
    }).then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data) return;

        refLink = data.link || '';
        document.getElementById('rf-url').textContent = refLink ? shortLink(refLink) : '—';
        document.getElementById('rf-count').textContent = formatPrice(data.total || 0);
        document.getElementById('rf-earned').textContent = formatTon(data.earned || 0);

        const list = document.getElementById('rf-list');
        if (reset) list.textContent = '';
        (data.items || []).forEach((person) => list.appendChild(refRow(person)));

        const any = list.children.length > 0;
        list.hidden = !any;
        document.getElementById('rf-empty').hidden = any;

        refOffset += (data.items || []).length;
        refMore = Boolean(data.more);
      })
      .catch(() => {})
      .then(() => {
        refBusy = false;
      });
  }

  // 10 → «10», 7.5 → «7,5»
  function formatPercent(value) {
    return String(value).replace('.', window.I18N.lang() === 'ru' ? ',' : '.');
  }

  function refCopy() {
    if (!refLink) {
      toast(t('ref.noLink'));
      return;
    }
    copyText(refLink, 'ref.copied');
  }

  function refShare() {
    haptic('light');
    if (!refLink) {
      toast(t('ref.noLink'));
      return;
    }
    const url = 'https://t.me/share/url?url=' + encodeURIComponent(refLink) +
      '&text=' + encodeURIComponent(t('ref.message'));
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  }

  function initReferral() {
    const root = document.getElementById('ref');
    const entry = document.getElementById('prf-referral');
    if (!root || !entry) return;

    refSheet = createSheet(root, {
      fill: () => {
        document.getElementById('rf-list').hidden = true;
        document.getElementById('rf-empty').hidden = false;
        document.getElementById('rf-count').textContent = '0';
        document.getElementById('rf-earned').textContent = '0';
        // Процент — тот, что поставила админка; выключен — прежний текст
        const percent = Number(feeSettings().referral) || 0;
        document.getElementById('rf-descr').textContent = percent
          ? t('ref.descrBonus', { n: formatPercent(percent) })
          : t('ref.descr');
        document.getElementById('rf-earn-sub').textContent = t('ref.earnedSub', { n: formatPercent(percent) });
        loadRefs(true);
      }
    });

    entry.addEventListener('click', () => {
      haptic('light');
      refSheet.open();
    });

    document.getElementById('rf-link').addEventListener('click', refCopy);
    document.getElementById('rf-copy').addEventListener('click', refCopy);
    document.getElementById('rf-share').addEventListener('click', refShare);
    document.getElementById('rf-invite').addEventListener('click', refShare);

    // Дошли до конца списка — просим следующую часть
    const scroll = root.querySelector('.sheet__scroll');
    scroll.addEventListener('scroll', () => {
      if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 120) loadRefs(false);
    }, { passive: true });
  }

  // --- Отправка подарка ---

  /* Окно memgift: ищем человека по имени, @нику или Telegram ID, выбираем
     строкой и отправляем. Отправка бесплатная — «за ★ 0», как у образца
     вне первых суток. Кто отправляет, сервер узнаёт по подписи Telegram */
  const TRANSFER_API = '/api/transfer';
  const SEARCH_WAIT = 350;

  let sendSheet = null;
  let sendGift = null;
  let sendPlayer = null;
  let sendTo = null;
  let sendTimer = null;
  let sendAsk = 0;
  let sending = false;

  function transferPost(payload) {
    return fetch(TRANSFER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData: (tg && tg.initData) || '' }, payload))
    }).then((response) => response.json()
      .catch(() => ({}))
      .then((data) => {
        if (!response.ok) throw new Error(data.message || '');
        return data;
      }));
  }

  function sendStatus(text, error) {
    const status = document.getElementById('send-status');
    status.hidden = !text;
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(error));
    document.getElementById('send-search').classList.toggle('is-error', Boolean(error));
  }

  function sendAvatar(box, person) {
    box.textContent = '';
    if (person.user_photo) {
      const img = document.createElement('img');
      img.src = person.user_photo;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        img.remove();
        box.textContent = (person.name || '?').charAt(0);
      });
      box.appendChild(img);
    } else {
      const letter = document.createElement('span');
      letter.textContent = (person.name || '?').replace('@', '').charAt(0);
      box.appendChild(letter);
    }
  }

  function sendReset() {
    sendTo = null;
    clearTimeout(sendTimer);
    sendAsk += 1;
    const input = document.getElementById('send-input');
    input.value = '';
    document.getElementById('send-search').classList.remove('is-picked', 'is-error');
    document.getElementById('send-picked').hidden = true;
    document.getElementById('send-loader').hidden = true;
    document.getElementById('send-list').hidden = true;
    document.getElementById('send-list').textContent = '';
    document.getElementById('send-go').disabled = true;
    sendStatus('');
  }

  function sendPick(person) {
    haptic('select');
    sendTo = person;
    document.getElementById('send-search').classList.add('is-picked');
    document.getElementById('send-picked').hidden = false;
    document.getElementById('send-list').hidden = true;
    document.getElementById('send-loader').hidden = true;
    sendStatus('');

    sendAvatar(document.getElementById('send-picked-ava'), person);
    document.getElementById('send-picked-name').textContent = person.name;
    document.getElementById('send-go').disabled = false;
  }

  function sendList(users) {
    const list = document.getElementById('send-list');
    list.textContent = '';
    list.hidden = !users.length;

    users.forEach((person, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pgm-recipient-row';
      row.style.setProperty('--i', String(index));
      row.setAttribute('role', 'option');

      const ava = document.createElement('span');
      ava.className = 'pgm-recipient-row__ava';
      sendAvatar(ava, person);

      const mid = document.createElement('span');
      mid.className = 'pgm-recipient-row__mid';
      const name = document.createElement('span');
      name.className = 'pgm-recipient-row__name';
      name.textContent = person.name;
      const id = document.createElement('span');
      id.className = 'pgm-recipient-row__id';
      id.textContent = person.username ? '@' + person.username : 'ID ' + person.user_id;
      mid.append(name, id);

      const action = document.createElement('span');
      action.className = 'pgm-recipient-row__action';
      action.textContent = t('send.select');

      row.append(ava, mid, action);
      row.addEventListener('click', () => sendPick(person));
      list.appendChild(row);
    });
  }

  function sendSearch(query) {
    const ask = ++sendAsk;
    const me = tgUser();
    const plain = query.replace(/^@/, '');

    if (!plain) {
      document.getElementById('send-loader').hidden = true;
      sendList([]);
      sendStatus('');
      return;
    }

    if (me && (plain === String(me.id) || plain === me.username)) {
      sendList([]);
      sendStatus(t('send.self'), true);
      return;
    }

    document.getElementById('send-loader').hidden = false;
    sendStatus('');

    transferPost({ action: 'search', query: plain })
      .then((data) => {
        if (ask !== sendAsk) return;
        const users = data.users || [];
        sendList(users);
        sendStatus(users.length ? '' : t('send.empty'));
      })
      .catch(() => {
        if (ask !== sendAsk) return;
        sendList([]);
        sendStatus(t('send.error'), true);
      })
      .then(() => {
        if (ask === sendAsk) document.getElementById('send-loader').hidden = true;
      });
  }

  // Цена передачи в звёздах; бесплатно (и админу) — просто «Отправить»
  function sendPrice() {
    return freeHand() ? 0 : Math.round(Number(feeSettings().transfer) || 0);
  }

  function paintSendPrice() {
    const price = sendPrice();
    document.getElementById('send-go-text').textContent = t(price ? 'send.for' : 'send.free');
    document.getElementById('send-cost').hidden = !price;
    document.getElementById('send-cost-text').textContent = formatPrice(price);
  }

  /* Платная передача: сервер выставляет счёт за звёзды, подарок уходит,
     когда Telegram сообщит об оплате. Ответ — как у бесплатной: имя и счёт */
  function sendPaid(data) {
    if (!data.link) return Promise.resolve(data);
    if (!tg || !tg.openInvoice) return Promise.reject(new Error(t('pay.oldApp')));
    return new Promise((done) => {
      tg.openInvoice(data.link, (status) => done(status));
    }).then((status) => {
      if (status === 'cancelled') return null;
      if (status === 'failed') throw new Error(t('pay.failed'));
      return waitPaid(data.order, PAY_TRIES).then((paid) => {
        if (paid.status === 'failed') throw new Error(t('send.refunded'));
        if (paid.status !== 'paid' || !paid.me) throw new Error(t('pay.slow'));
        return paid;
      });
    });
  }

  function sendNow() {
    if (!sendTo || !sendGift || sending) return;
    sending = true;
    haptic('light');

    const button = document.getElementById('send-go');
    button.classList.add('is-loading');
    const to = sendTo;
    const gift = sendGift;

    transferPost({ action: 'send', gift: gift.id, nft: gift.nft ? gift.nft.id : undefined, to: to.user_id })
      .then(sendPaid)
      .then((data) => {
        // Счёт закрыли, не заплатив, — окно остаётся, ничего не ушло
        if (!data) return;
        // Сервер отдаёт счёт без ставок и признака админа — их берём свои
        Store.apply(null, Object.assign({}, Store.me(), data.me));
        fillFromStore();
        initHeader();
        paintProfile();

        haptic('success');
        toast(t('send.done', { name: data.name || to.name }));
        sendSheet.close();
        ownSheet.close();
      })
      .catch((error) => {
        toast(error && error.message ? error.message : t('send.fail'));
      })
      .then(() => {
        sending = false;
        button.classList.remove('is-loading');
      });
  }

  function initSend() {
    sendSheet = createDock(document.getElementById('send'), document.getElementById('send-ov'), {
      fill: (gift) => {
        sendGift = gift;
        const head = document.getElementById('send-head');
        paintHead(head, gift, document.getElementById('send-symbol'), null);
        paintRarity(head, gift);
        applyTint(head, tintOf(gift));
        document.getElementById('send-title').textContent = gift.name;
        sendReset();
        paintSendPrice();
      },
      opened: (gift) => {
        sendPlayer = openArt(document.getElementById('send-art'), artOf(gift));
      },
      closed: () => {
        closeArt(document.getElementById('send-art'), sendPlayer);
        sendPlayer = null;
        sendGift = null;
      }
    });
    if (!sendSheet) return;

    const input = document.getElementById('send-input');
    input.addEventListener('input', () => {
      clearTimeout(sendTimer);
      const query = input.value.trim();
      sendTimer = setTimeout(() => sendSearch(query), SEARCH_WAIT);
    });
    input.addEventListener('keyup', (event) => {
      if (event.key !== 'Enter') return;
      clearTimeout(sendTimer);
      input.blur();
      sendSearch(input.value.trim());
    });

    document.getElementById('send-unpick').addEventListener('click', () => {
      haptic('light');
      sendReset();
      input.focus();
    });

    document.getElementById('send-go').addEventListener('click', sendNow);
  }

  // --- Экран после покупки ---

  /* Полноэкранное поздравление: купленный подарок, подпись и путь в профиль.
     Закрывается кнопкой, системной «назад» и Esc — для этого он стоит в том
     же списке, что и листы. */

  const CONFETTI = 'gifts/confetti.json';

  let wonPlayer = null;
  let wonConfetti = null;

  let wonEntry = null;

  /* got — подарок не купили, а получили от другого: тот же экран, но
     «Подарок получен» и от кого. got.from — имя отправителя */
  function wonOpen(gift, many, got) {
    if (wonEntry) wonEntry.at = ++openSeq;
    const root = document.getElementById('won');
    if (!root || !root.hidden) return;

    // Взяли несколько — и заголовок, и подпись во множественном числе
    document.getElementById('won-title').textContent = got
      ? t(many ? 'won.gotMany' : 'won.gotOne')
      : t(many ? 'won.many' : 'won.one');
    document.getElementById('won-note').textContent = got
      ? (got.from ? t(many ? 'won.fromMany' : 'won.from', { name: got.from }) : t('won.gotNote'))
      : t(many ? 'won.noteMany' : 'won.noteOne');

    root.hidden = false;
    // Пересчёт стилей форсируем чтением размера — иначе перехода не будет
    void root.offsetHeight;
    root.classList.add('is-on');

    if (tg && tg.BackButton) tg.BackButton.show();
    if (stage) stage.style.overflow = 'hidden';

    wonPlayer = openArt(document.getElementById('won-art'), gift);

    // Конфетти рисуем с запасом по краям: квадратная композиция, растянутая
    // по высоте экрана, иначе встала бы узкой полосой посередине
    const box = document.getElementById('won-confetti');
    if (box && window.lottie && !prefersStill()) {
      wonConfetti = window.lottie.loadAnimation({
        container: box,
        renderer: 'canvas',
        loop: false,
        autoplay: true,
        path: CONFETTI,
        rendererSettings: {
          dpr: Math.min(window.devicePixelRatio || 1, 2),
          preserveAspectRatio: 'xMidYMid slice'
        }
      });
    }
  }

  function wonClose() {
    const root = document.getElementById('won');
    // Закрытие уже идёт — второй раз не начинаем
    if (!root || root.hidden || !root.classList.contains('is-on')) return;

    root.classList.remove('is-on');
    if (tg && tg.BackButton) tg.BackButton.hide();

    closeArt(document.getElementById('won-art'), wonPlayer);
    wonPlayer = null;

    if (wonConfetti) wonConfetti.destroy();
    wonConfetti = null;
    const box = document.getElementById('won-confetti');
    if (box) box.textContent = '';

    setTimeout(() => {
      root.hidden = true;
      if (stage) stage.style.overflow = '';
    }, 320);
  }

  function initWon() {
    const root = document.getElementById('won');
    if (!root) return;

    // В общем списке с листами: системная «назад» и Esc закрывают и его
    wonEntry = {
      open: wonOpen,
      close: wonClose,
      isOpen: () => !root.hidden
    };
    sheets.push(wonEntry);

    document.getElementById('won-go').addEventListener('click', () => {
      haptic('light');
      wonClose();

      const at = tabs.findIndex((tab) => tab.dataset.section === 'profile');
      if (at !== -1) selectTab(at);
    });
  }

  /* Подарки от других, которые человек ещё не видел: при заходе — экран
     «Подарок получен» с конфетти. Показываем последний; если их несколько,
     заголовок во множественном числе. После показа сервер их забывает */
  function openInbox() {
    const inbox = (ME && Array.isArray(ME.inbox)) ? ME.inbox : [];
    if (!inbox.length || !Store.live()) return;

    const last = inbox[inbox.length - 1];
    const nft = last.nft ? (ME.nfts || []).find((one) => one.id === last.nft) : null;
    const view = nft ? nftView(nft) : giftById(last.gift);
    // Подарок успели отправить дальше или сняли с витрины — показывать нечего
    if (!view) return;

    const until = inbox.reduce((max, one) => Math.max(max, Number(one.at) || 0), 0);
    ME.inbox = [];

    // Заставка ещё уходит — даём ей исчезнуть, потом поздравляем
    setTimeout(() => {
      haptic('success');
      wonOpen(artOf(view), inbox.length > 1, { from: last.from && last.from.name });
    }, SPLASH_MIN_MS);

    fetch('/api/transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: (tg && tg.initData) || '', action: 'seen', until: until })
    }).catch(() => {});
  }

  // --- Покупка за звёзды ---

  /* Счёт выставляет бот, а не страница: приложение просит у сервера ссылку
     на счёт и открывает её поверх своего экрана. Цену и остаток считает
     сервер — из браузера приходит только, что берут и сколько.

     Об оплате Telegram сообщает боту своим ходом, поэтому после «оплачено»
     мы ещё переспрашиваем сервер, пока подарок не окажется на счёте. */

  const PAY_API = '/api/pay';
  const PAY_TRIES = 8;
  const PAY_WAIT = 700;

  let paying = false;

  function payPost(payload) {
    return fetch(PAY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData: (tg && tg.initData) || '' }, payload))
    }).then((response) => response.json()
      .catch(() => ({}))
      .then((data) => {
        // Понятный отказ сервер называет кодом, словами его зовём сами:
        // язык выбирает тот, кто смотрит на экран
        if (!response.ok) {
          throw new Error(data.code ? t(data.code, data.vars) : (data.message || t('pay.off')));
        }
        return data;
      }));
  }

  function waitPaid(order, left) {
    return payPost({ action: 'check', order: order }).then((data) => {
      if (data.status === 'paid' || left <= 0) return data;
      return new Promise((done) => setTimeout(done, PAY_WAIT))
        .then(() => waitPaid(order, left - 1));
    });
  }

  function buyBusy(on) {
    const button = document.getElementById('sheet-buy');
    if (button) button.disabled = on;
  }

  function buyGift() {
    if (paying || !sheetGift) return;
    haptic('light');

    if (!Store.live()) {
      toast(t('pay.noDb'));
      return;
    }

    // openInvoice появился в Bot API 6.1; без него счёт пришлось бы
    // открывать перепиской с ботом, а это уже не «на этом же экране».
    // Админу счёт не нужен вовсе, поэтому его это не держит
    if (!freeHand() && !useTon() && (!tg || !tg.openInvoice)) {
      toast(t('pay.oldApp'));
      return;
    }

    const gift = sheetGift;
    const want = qty;
    paying = true;
    buyBusy(true);

    // С баланса TON — без счёта Telegram: сервер списывает и выдаёт сразу
    const paid = useTon()
      ? payPost({ action: 'ton', giftId: gift.id, qty: want })
      : null;

    (paid || payPost({ giftId: gift.id, qty: want, coupons: useCoupons() ? couponCut() : 0 }))
      .then((data) => {
        // Оплачено с баланса TON — заказ уже засчитан, счёт уже пришёл
        if (paid) return { status: 'ton', data: data };
        // Админу счёт не выставляется — заказ уже засчитан
        if (data.free) return { status: 'paid', order: data.order };

        return new Promise((done) => {
          tg.openInvoice(data.link, (status) => done({ status: status, order: data.order }));
        });
      })
      .then((result) => {
        if (result.status === 'ton') return result.data;
        if (result.status === 'cancelled') return null;
        if (result.status === 'failed') throw new Error(t('pay.failed'));
        return waitPaid(result.order, PAY_TRIES);
      })
      .then((paid) => {
        // Отменили — ни сообщать, ни перерисовывать нечего
        if (!paid) return;

        if (paid.status !== 'paid' || !paid.me) {
          // Деньги списаны, а до счёта подарок ещё не дошёл — дойдёт сам
          toast(t('pay.slow'));
          return;
        }

        Store.apply(paid.content, paid.me);
        fillFromStore();
        drawGifts();
        initHeader();
        paintProfile();

        // Покупатель в топе этого подарка теперь другой — берём свежий
        tops.delete(gift.id);
        askTop(gift.id);

        haptic('success');
        wonOpen(gift, want > 1);
        // Лист убираем уже под непрозрачным экраном: иначе он уезжал бы вниз
        // прямо сквозь проявляющееся поздравление
        setTimeout(() => buySheet.close(), 360);
      })
      .catch((error) => {
        toast(error && error.message ? error.message : t('pay.sorry'));
      })
      .then(() => {
        paying = false;
        buyBusy(false);
      });
  }

  let buySheet = null;
  let ownSheet = null;
  let ownPlayer = null;

  function initSheet() {
    if (!sheet) return;

    buySheet = createSheet(sheet, {
      fill: (gift) => {
        sheetGift = gift;
        fillSheet(gift);
        setQty(1);
      },
      opened: (gift) => {
        sheetPlayer = openArt(document.getElementById('sheet-art'), gift);
      },
      closed: () => {
        closeArt(document.getElementById('sheet-art'), sheetPlayer);
        sheetPlayer = null;
        sheetGift = null;
      }
    });

    ownSheet = createDock(owned, document.getElementById('owned-ov'), {
      fill: fillOwned,
      opened: (gift) => {
        ownPlayer = openArt(document.getElementById('owned-art'), artOf(gift));
        if (gift && gift.nft) playTickerIcons();
      },
      closed: () => {
        // Закрыли посреди улучшения — крутить больше некому, итог будет в профиле
        rollStop();
        closeArt(document.getElementById('owned-art'), ownPlayer);
        ownPlayer = null;
        ownGift = null;
      }
    });

    // Обработчик вешаем один раз: onClick складывает их, а не заменяет
    if (tg && tg.BackButton) {
      tg.BackButton.onClick(() => {
        haptic('light');
        closeOpenSheet();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeOpenSheet();
    });

    document.getElementById('qty-less').addEventListener('click', () => {
      haptic('select');
      setQty(qty - 1);
    });

    document.getElementById('qty-more').addEventListener('click', () => {
      haptic('select');
      setQty(qty + 1);
    });

    const coupons = document.getElementById('cpn-use');
    if (coupons) {
      coupons.addEventListener('change', () => {
        haptic('select');
        setQty(qty);
      });
    }

    const tonBox = document.getElementById('tonpay-use');
    if (tonBox) {
      tonBox.addEventListener('change', () => {
        haptic('select');
        setQty(qty);
      });
    }

    document.getElementById('sheet-buy').addEventListener('click', buyGift);

    // Маркет у нас — витрина: уходим на главную, как «Перейти в магазин» memgift
    document.getElementById('sheet-store').addEventListener('click', () => {
      haptic('light');
      buySheet.close();
      selectTab(0);
    });

    const share = document.getElementById('sheet-share');
    if (share) {
      share.addEventListener('click', () => {
        if (sheetGift) shareGift(sheetGift);
      });
    }

    initSend();
    initReferral();
    initWallet();
    initOwnedTools();
    initWon();
  }

  // Что показывать и в каком порядке. Обе кнопки открывают один и тот же
  // лист выбора: список, переключатель, «Отмена» и «Применить».
  // Значение храним по имени, а не по месту в списке: так перестановка
  // пунктов не сбивает выбор.
  const SCOPES = [
    { id: 'all', key: 'scope.all', keep: null },
    { id: 'left', key: 'scope.left', keep: (gift) => typeof gift.left !== 'number' || gift.left > 0 },
    { id: 'out', key: 'scope.out', keep: (gift) => gift.left === 0 }
  ];

  // Сколько осталось: неизвестное считаем бесконечностью, иначе подарки без
  // счётчика встали бы первыми в «Скоро закончатся»
  function restOf(gift) {
    return typeof gift.left === 'number' ? gift.left : Infinity;
  }

  const SORTS = [
    // «Новые» — порядок, в котором подарки стоят на витрине в админке
    { id: 'new', key: 'sort.new', order: null },
    { id: 'cheap', key: 'sort.cheap', order: (a, b) => a.price - b.price },
    { id: 'dear', key: 'sort.dear', order: (a, b) => b.price - a.price },
    { id: 'rest', key: 'sort.rest', order: (a, b) => restOf(a) - restOf(b) }
  ];

  let scopeId = 'all';
  let sortId = 'new';

  // «Скрыть проданные» — как у memgift: включено, пока человек сам не снимет
  const HIDE_SOLD = 'gg:hideSold';
  let hideSold = true;
  try { hideSold = localStorage.getItem(HIDE_SOLD) !== '0'; } catch (_) {}

  function pickedScope() {
    return SCOPES.find((one) => one.id === scopeId) || SCOPES[0];
  }

  function pickedSort() {
    return SORTS.find((one) => one.id === sortId) || SORTS[0];
  }

  function drawGifts() {
    if (!giftsGrid) return;

    const keep = pickedScope().keep;
    const order = pickedSort().order;
    let list = keep ? GIFTS.filter(keep) : GIFTS.slice();
    // Отбор «Распроданные» просит именно их — галочка ему не мешает
    if (hideSold && scopeId !== 'out') list = list.filter((gift) => gift.left !== 0);
    if (order) list.sort(order);

    releaseArt(giftsGrid);
    giftsGrid.textContent = '';

    if (!list.length) {
      const none = document.createElement('p');
      none.className = 'gifts__none';
      // Пустая витрина и пустой отбор — разные вещи, и сказать надо разное
      none.textContent = t(GIFTS.length ? 'gifts.none' : 'gifts.empty');
      giftsGrid.appendChild(none);
      return;
    }

    // Цвет досчитываем, пока витрина на экране: открытая карточка возьмёт
    // готовое значение и не будет перекрашиваться на глазах
    list.forEach((gift) => warmTint(gift));
    list.forEach((gift) => giftsGrid.appendChild(buildGift(gift, (one) => buySheet.open(one), true)));
  }

  // --- Лист выбора ---

  // Чем лист заполнен сейчас: откуда он открыт, что в нём выбрано и что
  // сделать по «Применить»
  let pickSheet = null;
  let pickNow = null;

  /* Строка листа выбора. Бывает просто подписью, а бывает с картинкой
     подарка или символа, с кружком цвета фона и с процентом выпадения —
     как в окнах символа и фона у memgift */
  function pickRow(option, card) {
    const multi = Boolean(pickNow.cfg.multi);
    const row = document.createElement('button');
    row.className = 'pick__row' + (option.media ? ' pick__row--media' : '');
    row.type = 'button';
    row.dataset.id = option.id;
    row.setAttribute('role', multi ? 'checkbox' : 'radio');

    if (option.media) {
      const media = document.createElement('span');
      media.className = 'pick__media pick__media--' + option.media.type;
      if (option.media.type === 'gift') {
        showShot(media, option.media.gift);
      } else if (option.media.type === 'img') {
        const img = document.createElement('img');
        img.src = option.media.src;
        img.alt = '';
        img.loading = 'lazy';
        img.draggable = false;
        media.appendChild(img);
      } else if (option.media.type === 'color') {
        media.style.setProperty('--center-color', option.media.center);
        media.style.setProperty('--around-color', option.media.around);
      }
      row.appendChild(media);
    }

    const label = document.createElement('span');
    label.className = 'pick__label';
    label.textContent = option.label;
    if (option.rate) {
      const rate = document.createElement('span');
      rate.className = 'pick__rate';
      rate.textContent = option.rate;
      label.appendChild(rate);
    }

    const mark = document.createElement('span');
    mark.className = 'pick__mark' + (multi ? ' pick__mark--check' : '');
    mark.setAttribute('aria-hidden', 'true');
    if (multi) {
      mark.innerHTML = '<svg viewBox="0 0 25 18"><path d="M22.83 1.75L8.63 15.96 2.17 9.5"></path></svg>';
    }

    row.append(label, mark);

    row.addEventListener('click', () => {
      if (multi) {
        const at = pickNow.chosen.indexOf(option.id);
        if (at === -1) pickNow.chosen.push(option.id);
        else pickNow.chosen.splice(at, 1);
      } else {
        if (pickNow.chosen === option.id) return;
        pickNow.chosen = option.id;
      }
      haptic('select');
      paintPick();
    });

    card.appendChild(row);
  }

  function paintPick() {
    const list = document.getElementById('pick-list');
    const multi = Boolean(pickNow.cfg.multi);

    list.querySelectorAll('.pick__row').forEach((row) => {
      const on = multi ? pickNow.chosen.indexOf(row.dataset.id) !== -1 : row.dataset.id === pickNow.chosen;
      row.classList.toggle('is-on', on);
      row.setAttribute('aria-checked', String(on));
    });
  }

  /* Витринные списки: что показывать и в каком порядке */
  const PICKS = {
    scope: { title: 'pick.scope', items: () => SCOPES, now: () => scopeId },
    sort: { title: 'pick.sort', items: () => SORTS, now: () => sortId }
  };

  function shelfPick(kind) {
    const list = PICKS[kind] || PICKS.scope;
    const scope = kind !== 'sort';
    return {
      title: t(list.title),
      // У отбора значок подарка, у порядка — полоски
      icon: scope ? { href: '#task-gift', box: '0 0 14 16' } : { href: '#sort-lines', box: '0 0 18 11', sort: true },
      items: list.items().map((option) => ({ id: option.id, label: t(option.key) })),
      selected: list.now(),
      onApply: (id) => {
        if (kind === 'sort') sortId = id;
        else scopeId = id;
        paintFilters();
        drawGifts();
      }
    };
  }

  /* Один лист на все выборы: витрина передаёт имя списка, профиль —
     готовое описание: заголовок, значок, строки, один выбор или несколько */
  function fillPick(what) {
    const cfg = typeof what === 'string' ? shelfPick(what) : what;
    pickNow = {
      cfg: cfg,
      chosen: cfg.multi ? (cfg.selected || []).slice() : (cfg.selected || '')
    };

    const icon = document.getElementById('pick-icon');
    icon.setAttribute('viewBox', cfg.icon.box);
    icon.querySelector('use').setAttribute('href', cfg.icon.href);
    icon.classList.toggle('pick__icon--sort', Boolean(cfg.icon.sort));

    document.getElementById('pick-title-text').textContent = cfg.title;

    const box = document.getElementById('pick-list');
    releaseArt(box);
    box.textContent = '';
    box.setAttribute('role', cfg.multi ? 'group' : 'radiogroup');

    if (!cfg.items.length) {
      const none = document.createElement('p');
      none.className = 'pick__none';
      none.textContent = t('profile.empty');
      box.appendChild(none);
      return;
    }

    const card = document.createElement('div');
    card.className = 'pick__card';
    cfg.items.forEach((option) => pickRow(option, card));
    box.appendChild(card);

    paintPick();
  }

  function applyPick() {
    haptic('light');
    if (pickNow && pickNow.cfg.onApply) pickNow.cfg.onApply(pickNow.chosen);
    pickSheet.close();
  }

  function paintFilters() {
    const scopeText = document.getElementById('filter-scope-text');
    const sortText = document.getElementById('filter-sort-text');

    if (scopeText) scopeText.textContent = t(pickedScope().key);
    if (sortText) sortText.textContent = t(pickedSort().key);
  }

  function initGifts() {
    if (!giftsGrid) return;

    pickSheet = createSheet(document.getElementById('pick'), {
    fill: fillPick,
    // Список длиннее листа — открываем его на выбранной строке, иначе
    // пришлось бы искать её прокруткой
    opened: () => {
      const on = document.querySelector('.pick__row.is-on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    }
    });

    const open = (what) => () => {
    haptic('light');
    pickSheet.open(what);
    };

    const scope = document.getElementById('filter-scope');
    const sort = document.getElementById('filter-sort');
    if (scope) scope.addEventListener('click', open('scope'));
    if (sort) sort.addEventListener('click', open('sort'));

    const apply = document.getElementById('pick-apply');
    if (apply) apply.addEventListener('click', applyPick);

    const sold = document.getElementById('hide-sold');
    if (sold) {
      sold.checked = hideSold;
      sold.addEventListener('change', () => {
        hideSold = sold.checked;
        try { localStorage.setItem(HIDE_SOLD, hideSold ? '1' : '0'); } catch (_) {}
        haptic('select');
        drawGifts();
      });
    }

    paintFilters();
    drawGifts();
  }

  // --- Задания ---

  // Строка задания: иконка, название с наградой под ним и счётчик справа
  function buildTask(task) {
    const row = document.createElement('div');
    row.className = 'task';

    const avatar = document.createElement('div');
    avatar.className = 'task__avatar';
    avatar.innerHTML = '<svg viewBox="0 0 14 16" aria-hidden="true"><use href="#task-gift"></use></svg>';

    const info = document.createElement('div');
    info.className = 'task__info';

    const name = document.createElement('h4');
    name.className = 'task__name';
    name.textContent = task.name;

    const reward = document.createElement('span');
    reward.className = 'task__reward';
    reward.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><use href="#coupon"></use></svg>';
    const amount = document.createElement('span');
    amount.textContent = formatPrice(task.reward);
    reward.appendChild(amount);
    reward.setAttribute('aria-label', t('task.reward.aria', { n: task.reward }));

    info.append(name, reward);

    row.append(avatar, info, taskAction(task));
    return row;
  }

  /* Кнопка справа — как `._task-action` memgift: «Начать» у ссылки,
     «Забрать», когда задание выполнено, галочка, когда награда получена.
     Пока счётное задание не набрано — просто счётчик «2/5» */
  const TASK_API = '/api/tasks';
  const CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  let taskBusy = false;

  function taskProgress(task) {
    if (!ME) return 0;
    if (task.type === 'link' || task.type === 'subscribe') return (ME.tasksStarted || []).indexOf(task.id) === -1 ? 0 : 1;
    if (task.type === 'buy') return ME.bought || 0;
    if (task.type === 'invite') return ME.invited || 0;
    return ME.sent || 0;
  }

  function taskButton(kind, label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task__btn task__btn--' + kind;
    if (kind === 'done') button.innerHTML = CHECK;
    else {
      const span = document.createElement('span');
      span.textContent = label;
      button.appendChild(span);
    }
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  function taskAction(task) {
    if ((ME && ME.tasksDone || []).indexOf(task.id) !== -1) {
      const done = taskButton('done');
      done.tabIndex = -1;
      return done;
    }

    const have = taskProgress(task);
    if (have >= task.goal) {
      // Подписку сервер проверит у Telegram: кнопка так и называется
      return taskButton('claim', t(task.type === 'subscribe' || /^https:\/\/t\.me\/[A-Za-z][A-Za-z0-9_]{3,31}\/?$/i.test(task.url || '') ? 'task.check' : 'task.claim'),
        (event) => taskPost('claim', task, event.currentTarget));
    }

    if (task.type === 'link' || task.type === 'subscribe') {
      return taskButton('start', t('task.start'), (event) => {
        haptic('light');
        if (task.url) openLink(task.url);
        taskPost('start', task, event.currentTarget);
      });
    }

    /* Счётное задание ещё не набрано: вместо кнопки — счётчик «2/5». У
       memgift он той же стеклянной кнопкой и уводит туда, где задание и
       выполняют: подарки покупают на витрине, отправляют из профиля */
    return taskButton('count', formatPrice(Math.min(have, task.goal)) + '/' + formatPrice(task.goal), () => {
      haptic('select');
      selectTab(task.type === 'buy' ? 0 : 3);
    });
  }

  function taskPost(action, task, button) {
    if (taskBusy) return;
    if (!Store.live()) {
      toast(t('pay.noDb'));
      return;
    }
    taskBusy = true;
    if (button) button.classList.add('is-loading');

    fetch(TASK_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: (tg && tg.initData) || '', action: action, task: task.id })
    }).then((response) => response.json().catch(() => ({})).then((data) => {
      if (!response.ok) throw new Error(data.message || t('pay.sorry'));
      return data;
    })).then((data) => {
      Store.apply(null, data.me);
      fillFromStore();
      initHeader();
      paintProfile();
      if (action === 'claim') {
        haptic('success');
        fireFromBottom();
        toast(t('task.claimed', { n: task.reward }));
      }
    }).catch((error) => {
      toast(error.message);
    }).then(() => {
      taskBusy = false;
      renderTasks();
    });
  }

  // Перерисовка после каждой перемены счёта: купил, отправил, забрал
  function renderTasks() {
    const root = document.getElementById('tasks');
    if (!root) return;
    root.textContent = '';
    initTasks();
  }

  function initTasks() {
    const root = document.getElementById('tasks');
    if (!root) return;

    TASK_BLOCKS.forEach((group) => {
    const block = document.createElement('section');
    block.className = 'tasks__block';

    const head = document.createElement('div');
    head.className = 'tasks__head';
    const title = document.createElement('h4');
    title.textContent = group.title;
    /* Разовые задания memgift считает прямо в заголовке — «Одноразовые (3)».
       У счётных блоков счёта нет: там важен не список, а прогресс */
    const once = group.items.length && group.items.every((task) => task.type === 'link' || task.type === 'subscribe');
    if (once) {
      const count = document.createElement('b');
      count.textContent = ' (' + group.items.length + ')';
      title.appendChild(count);
    }
    head.appendChild(title);

    const list = document.createElement('div');
    list.className = 'tasks__list';
    group.items.forEach((task) => list.appendChild(buildTask(task)));

    block.append(head, list);
    root.appendChild(block);
    });
  }

  // --- Профиль ---

  function tgUser() {
    return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  }

  // Имя — ровно то, что отдаёт Telegram: никаких подменных ников
  function userTitle(user) {
    if (!user) return t('profile.guest');
    if (user.username) return '@' + user.username;
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || t('profile.noname');
  }


  /* Пусто — как у memgift в обеих вкладках: картинка, «Нет подарков(» и
     «Подарки можно покупать в [Market]». В подарках плашка ведёт на
     витрину, в NFT — отвечает «Очень скоро..»: GetGems не подключён */
  function emptyState(tab) {
    const nft = tab === 'nft';
    const box = document.createElement('div');
    box.className = 'prf__empty';

    // Во вкладке NFT вместо зверька — значок GetGems
    const art = document.createElement('div');
    art.className = 'prf__empty-art' + (nft ? ' prf__empty-art--gems' : '');
    art.innerHTML = nft
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#gems"></use></svg>'
      : '<img src="gifts/profile-empty.svg" alt="" draggable="false">';

    const title = document.createElement('b');
    title.textContent = t(nft ? 'profile.emptyNft' : 'profile.empty');

    const line = document.createElement('p');
    line.append(t(nft ? 'profile.emptyNftNote' : 'profile.emptyNote'));

    const market = document.createElement('button');
    market.type = 'button';
    market.className = 'prf__market';
    market.innerHTML = nft
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#gems"></use></svg>'
      : '<svg viewBox="0 0 9 9" aria-hidden="true"><use href="#store"></use></svg>';
    market.append(nft ? 'GetGems' : 'Market');
    market.addEventListener('click', () => {
      haptic('select');
      if (!nft) {
        selectTab(0);
        return;
      }
      // GetGems ещё не подключён — отвечаем тем же, что и кнопка в навбаре
      toast(t('soon.gems'));
    });

    line.appendChild(market);
    box.append(art, title, line);
    return box;
  }

  /* Отбор в профиле — как у memgift: порядок одним выбором, коллекции
     галочками, вид сеткой или строками. Пока ничего не выбрано, свежие
     идут первыми. «На продаже» и «Улучшенные» честно пусты: у нас нет ни
     маркета, ни улучшений */
  const OWN_SORTS = ['latest', 'oldest', 'on_market', 'price_low', 'price_high', 'upgraded', 'not_upgraded'];


  // Во вкладке «Подарки» лежат и обычные, и улучшенные — как у memgift
  function ownedOf(kind) {
    if (kind === 'gifts') return OWNED.gifts.concat(OWNED.upg);
    return OWNED[kind] || [];
  }

  function sortOwned(c, items) {
    // Счёт хранит подарки по порядку прихода, значит свежие — в конце
    let list = c.sort === 'oldest' ? items.slice() : items.slice().reverse();
    if (c.coll.length) list = list.filter((gift) => c.coll.indexOf(gift.id) !== -1);

    // Модель, символ и фон бывают только у улучшенных подарков
    if (c.models.length) list = list.filter((gift) => gift.nft && c.models.indexOf(gift.nft.model.name) !== -1);
    if (c.symbols.length) list = list.filter((gift) => c.symbols.indexOf(gift.symbol) !== -1);
    if (c.backdrops.length) list = list.filter((gift) => c.backdrops.indexOf(gift.backdrop) !== -1);

    if (c.num) list = list.filter((gift) => gift.nft && String(gift.nft.num).indexOf(c.num) === 0);
    if (c.sort === 'on_market') list = list.filter((gift) => gift.nft && gift.nft.lot);
    if (c.sort === 'upgraded') list = list.filter((gift) => gift.nft);
    if (c.sort === 'not_upgraded') list = list.filter((gift) => !gift.nft);
    if (c.sort === 'price_low') list.sort((a, b) => a.price - b.price);
    if (c.sort === 'price_high') list.sort((a, b) => b.price - a.price);
    return list;
  }

  /* Длинные списки показываем частями. Человек с двумя сотнями подарков
     получал разом две сотни карточек, и приложение на них вставало. */
  const PAGE = 60;

  // Кнопка «Показать ещё» с остатком на ней
  function moreButton(left, onMore) {
    const more = document.createElement('button');
    more.className = 'more glass';
    more.type = 'button';
    more.textContent = t('gifts.more') + ' · ' + formatPrice(left);

    more.addEventListener('click', () => {
    haptic('light');
    onMore();
    });

    return more;
  }

  /* Список подарков с отбором живёт в двух местах: в своём профиле и в
     чужом (страница человека из топа покупателей, как /view/:id у memgift).
     Разметка у них одна, различаются приставкой id, а что выбрано в
     отборе, каждый помнит сам */
  function ownedList(id, source, open, card) {
    return {
      id: id,
      // Чем рисовать карточку: своим профилем или квадратом memgift
      card: card || null,
      tab: 'gifts',
      sort: '',
      coll: [],
      models: [],
      symbols: [],
      backdrops: [],
      view: 'blocks',
      shown: PAGE,
      source: source,
      open: open
    };
  }

  const ownList = ownedList('prf', ownedOf, (gift) => ownSheet.open(gift));

  const CROSS = '<svg viewBox="0 0 11 11" aria-hidden="true"><path d="M1 1L10 10M1 10L10 1"></path></svg>';

  function cheap(c, text, icon, onClear, clear) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'prf-cheap' + (clear ? ' prf-cheap--clear' : '');
    if (icon) node.insertAdjacentHTML('beforeend', icon);
    const label = document.createElement('h4');
    label.textContent = text;
    node.appendChild(label);
    node.insertAdjacentHTML('beforeend', CROSS);
    node.addEventListener('click', () => {
      haptic('select');
      onClear();
      c.shown = PAGE;
      (c.repaint || renderOwned)(c);
    });
    return node;
  }

  // Ряд под счётчиком: «Очистить» и по плашке на отбор, как у образца
  function paintCheaps(c) {
    const box = document.getElementById(c.id + '-cheaps');
    if (!box) return;

    box.textContent = '';
    box.hidden = !c.sort && !c.status && !c.coll.length && !c.models.length && !c.symbols.length && !c.backdrops.length;
    if (box.hidden) return;

    box.appendChild(cheap(c, t('profile.clearAll'), '', () => {
      c.sort = '';
      if (c.statuses) c.status = '';
      c.coll = [];
      c.models = [];
      c.symbols = [];
      c.backdrops = [];
    }, true));

    if (c.coll.length) {
      const one = c.coll.length === 1 && giftById(c.coll[0]);
      box.appendChild(cheap(c, 
        one ? one.name : t('profile.collections', { n: c.coll.length }),
        '<svg viewBox="0 0 28 28" aria-hidden="true" style="fill:#f5f5f7;stroke:none"><use href="#blocks"></use></svg>',
        () => { c.coll = []; }
      ));
    }

    if (c.models.length) {
      box.appendChild(cheap(c, 
        c.models.length === 1 ? 'Model: ' + c.models[0] : c.models.length + ' Models',
        '<svg viewBox="0 0 18 18" aria-hidden="true" style="fill:#f5f5f7;stroke:none"><use href="#gift-oth"></use></svg>',
        () => { c.models = []; }
      ));
    }

    // Подписи как у memgift: «Symbol: Pizza» или «3 Symbols»
    if (c.symbols.length) {
      box.appendChild(cheap(c, 
        c.symbols.length === 1 ? 'Symbol: ' + c.symbols[0] : c.symbols.length + ' Symbols',
        '<svg viewBox="0 0 18 18" aria-hidden="true" style="fill:#f5f5f7;stroke:none"><use href="#symbol-mark"></use></svg>',
        () => { c.symbols = []; }
      ));
    }

    if (c.backdrops.length) {
      box.appendChild(cheap(c, 
        c.backdrops.length === 1 ? 'Backdrop: ' + c.backdrops[0] : c.backdrops.length + ' Backdrops',
        '<svg viewBox="0 0 18 18" aria-hidden="true" style="fill:#f5f5f7;stroke:none"><use href="#backdrop"></use></svg>',
        () => { c.backdrops = []; }
      ));
    }

    // Статус — у «Активности» маркета, значок-карандаш memgift
    if (c.status) {
      box.appendChild(cheap(c,
        t('market.st.' + c.status),
        '<svg viewBox="0 0 23 23" aria-hidden="true" style="fill:#f5f5f7;stroke:none;width:11px;height:11px"><path d="M21 1.13a3.9 3.9 0 0 0-5.46 0L1.79 14.88a3.9 3.9 0 0 0-1.04 1.9L.06 19.86a2.6 2.6 0 0 0 3.08 3.08l3.09-.69a3.9 3.9 0 0 0 1.89-1.04L21.87 7.46a3.9 3.9 0 0 0 0-5.46Z"/></svg>',
        () => { c.status = ''; }
      ));
    }

    if (c.sort) {
      box.appendChild(cheap(c, 
        t('osort.' + c.sort),
        '<svg viewBox="0 0 18 11" aria-hidden="true" style="stroke:#f5f5f7"><use href="#sort-lines"></use></svg>',
        () => { c.sort = ''; }
      ));
    }
  }

  // Строка списка: квадрат с подарком, имя и цена, стрелка справа
  function ownRow(c, gift) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'prf-row';

    const nft = document.createElement('div');
    if (gift.nft) {
      const colors = backdropColors(gift);
      nft.className = 'prf-row__nft';
      nft.style.background = 'radial-gradient(circle at 50% 40%, ' + boostColor(colors.center, 0.28) +
        ' 0%, ' + colors.center + ' 45%, ' + colors.around + ' 100%)';
    } else {
      nft.className = 'prf-row__nft tint-face';
      paintRarity(nft, gift);
      applyTint(nft, tintOf(gift));
    }

    const art = document.createElement('div');
    art.className = 'prf-row__art';
    nft.appendChild(art);
    showShot(art, artOf(gift));

    const content = document.createElement('div');
    content.className = 'prf-row__content';
    const name = document.createElement('h4');
    name.textContent = gift.nft ? gift.name + ' #' + gift.nft.num : gift.name;
    const price = document.createElement('div');
    price.className = 'prf-row__price';
    const amount = document.createElement('p');
    amount.textContent = formatPrice(gift.price || 0);
    const star = document.createElement('img');
    star.src = 'gifts/star.png';
    star.alt = '';
    price.append(amount, star);
    content.append(name, price);

    const go = document.createElement('span');
    go.className = 'prf-row__go';
    go.innerHTML = '<svg viewBox="0 0 8 14" aria-hidden="true"><path d="M1 1.5L6.5 7 1 12.5"></path></svg>';

    row.append(nft, content, go);
    row.addEventListener('click', () => {
      haptic('light');
      c.open(gift);
    });
    return row;
  }

  function renderOwned(c) {
    const list = document.getElementById(c.id + '-list');
    const total = document.getElementById(c.id + '-total');
    const items = sortOwned(c, c.source(c.tab));

    // Кнопки отбора видны всегда; что отбор задан, говорит синяя точка
    const dot = document.getElementById(c.id + '-sort-dot');
    if (dot) dot.hidden = !c.sort;
    const collDot = document.getElementById(c.id + '-coll-dot');
    if (collDot) collDot.hidden = !c.coll.length;
    const modelDot = document.getElementById(c.id + '-model-dot');
    if (modelDot) modelDot.hidden = !c.models.length;
    const symbolDot = document.getElementById(c.id + '-symbol-dot');
    if (symbolDot) symbolDot.hidden = !c.symbols.length;
    const backdropDot = document.getElementById(c.id + '-backdrop-dot');
    if (backdropDot) backdropDot.hidden = !c.backdrops.length;

    // Значок показывает, во что переключит нажатие
    const view = document.querySelector('#' + c.id + '-view use');
    if (view) view.setAttribute('href', c.view === 'blocks' ? '#view-list' : '#blocks');

    paintCheaps(c);

    releaseArt(list);
    list.textContent = '';
    // В NFT слово не склоняется: «0 NFT», а не «0 подарков»
    if (total) {
      total.textContent = formatPrice(items.length) + ' ' +
        (c.tab === 'nft' ? 'NFT' : countOf(items.length, 'gift.count'));
    }

    if (!items.length) {
      list.appendChild(c.empty ? c.empty() : emptyState(c.tab));
      return;
    }

    const page = items.slice(0, c.shown);

    if (c.view === 'lists') {
      const rows = document.createElement('div');
      rows.className = 'prf-rows';
      page.forEach((gift) => rows.appendChild(ownRow(c, gift)));
      list.appendChild(rows);
    } else {
      const grid = document.createElement('div');
      grid.className = 'gifts';
      // Из профиля открывается карточка уже купленного подарка, а не покупка
      if (c.card) grid.className = c.grid || 'vw-grid';
      page.forEach((gift) => grid.appendChild(c.card
        ? c.card(gift, c.open)
        : gift.nft ? nftCard(gift, c.open) : buildGift(gift, c.open)));
      list.appendChild(grid);
    }

    if (items.length > page.length) {
      list.appendChild(moreButton(items.length - page.length, () => {
        c.shown += PAGE;
        renderOwned(c);
      }));
    }
  }

  /* Символы и фоны — те же, что у memgift: список и картинки символов
     сняты с их маркета и лежат у нас. Грузим один раз, при первом окне */
  const ATTRS = 'gifts/attributes.json';
  let attrs = null;

  function withAttrs(run) {
    if (attrs) {
      run(attrs);
      return;
    }
    fetch(ATTRS)
      .then((response) => response.json())
      .then((data) => {
        attrs = { symbols: data.symbols || [], backdrops: data.backdrops || [] };
        run(attrs);
      })
      .catch(() => toast(t('pay.off')));
  }

  function initOwnFilters(c) {
    if (!pickSheet) return;

    const reload = () => {
      c.shown = PAGE;
      (c.repaint || renderOwned)(c);
    };

    // Кнопок отбора у чужого профиля меньше, как у memgift: вешаем на те, что есть
    const on = (name, handler) => {
      const node = document.getElementById(c.id + '-' + name);
      if (node) node.addEventListener('click', handler);
    };

    const open = (cfg) => {
      haptic('light');
      pickSheet.open(cfg);
    };

    on('sort', () => open({
      title: t('osort.title'),
      icon: { href: '#sort-lines', box: '0 0 18 11', sort: true },
      items: (c.sorts || OWN_SORTS).map((id) => ({ id: id, label: t('osort.' + id) })),
      selected: c.sort,
      onApply: (id) => { c.sort = id || ''; reload(); }
    }));

    // Коллекции — те подарки, что лежат у человека, без повторов
    on('coll', () => {
      const seen = new Set();
      let items = [];
      if (c.collItems) items = c.collItems();
      else c.source(c.tab).forEach((gift) => {
        if (seen.has(gift.id)) return;
        seen.add(gift.id);
        items.push({ id: gift.id, label: gift.name, media: { type: 'gift', gift: gift } });
      });

      open({
        title: t('profile.modelTitle'),
        icon: { href: '#task-gift', box: '0 0 14 16' },
        items: items,
        multi: true,
        selected: c.coll,
        onApply: (ids) => {
          c.coll = ids.slice();
          // Модели — внутри коллекций: сменили коллекции — модели заново
          if (c.modelItems) c.models = [];
          reload();
        }
      });
    });

    const rate = (value) => String(value).replace('.', window.I18N.lang() === 'ru' ? ',' : '.') + '%';

    // Модели — что выпало у улучшенных подарков этого человека, без повторов
    on('model', () => {
      const seen = new Set();
      const items = c.modelItems ? c.modelItems(c) : [];
      if (!c.modelItems) c.source(c.tab).forEach((gift) => {
        if (!gift.nft || seen.has(gift.nft.model.name)) return;
        seen.add(gift.nft.model.name);
        items.push({
          id: gift.nft.model.name,
          label: gift.nft.model.name,
          rate: pct(gift.nft.model.rate),
          media: { type: 'gift', gift: artOf(gift) }
        });
      });

      open({
        title: t('profile.model'),
        icon: { href: '#gift-oth', box: '0 0 18 18' },
        items: items,
        multi: true,
        selected: c.models,
        onApply: (ids) => { c.models = ids.slice(); reload(); }
      });
    });

    on('symbol', () => withAttrs((all) => open({
      title: t('profile.symbol'),
      icon: { href: '#symbol-mark', box: '0 0 18 18' },
      items: all.symbols.map((one) => ({
        id: one.name,
        label: one.name,
        rate: rate(one.rate),
        media: { type: 'img', src: one.image }
      })),
      multi: true,
      selected: c.symbols,
      onApply: (ids) => { c.symbols = ids.slice(); reload(); }
    })));

    on('backdrop', () => withAttrs((all) => open({
      title: t('profile.backdrop'),
      icon: { href: '#backdrop', box: '0 0 18 18' },
      items: all.backdrops.map((one) => ({
        id: one.name,
        label: one.name,
        rate: rate(one.rate),
        media: { type: 'color', center: one.center, around: one.around }
      })),
      multi: true,
      selected: c.backdrops,
      onApply: (ids) => { c.backdrops = ids.slice(); reload(); }
    })));

    on('view', () => {
      haptic('select');
      c.view = c.view === 'blocks' ? 'lists' : 'blocks';
      renderOwned(c);
    });
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
    const coupons = document.getElementById('hdr-coupons');
    if (!coupons) return;

    coupons.textContent = formatPrice(ME ? ME.coupons : 0);
    paintGram();

    // В профиле своей шапки нет — балансы стоят в его строке с языком
    const prfCoupons = document.getElementById('prf-coupons');
    if (prfCoupons) prfCoupons.textContent = coupons.textContent;
  }

  // Баланс Gram в шапке — TON на счёте, как на странице кошелька
  function paintGram() {
    const text = formatTon(Number(ME && ME.tonNano) || 0);
    ['hdr-gram', 'prf-gram', 'mkt-gram', 'owned-balance'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    });
  }

  function initProfile() {
    const tabs = document.getElementById('prf-tabs');
    if (!tabs) return;

    const user = tgUser();
    const owned = OWNED.gifts.length + OWNED.nft.length + OWNED.upg.length;

    const name = document.getElementById('prf-name');
    // Как у memgift: в профиле имя из Telegram, ник — только если имени нет
    name.textContent = user
      ? [user.first_name, user.last_name].filter(Boolean).join(' ') || userTitle(user)
      : userTitle(user);

    document.getElementById('prf-count').textContent =
      formatPrice(owned) + ' ' + countOf(owned, 'gift.count');

    const avatar = document.getElementById('prf-avatar');
    if (user && user.photo_url) {
      avatar.style.backgroundImage = 'url("' + user.photo_url + '")';
    } else {
      // Фотографии нет — показываем первую букву на градиенте
      avatar.textContent = userTitle(user).replace('@', '').charAt(0).toUpperCase();
    }

    // Кто админ, решает сервер по проверенной подписи Telegram. Не узнал
    // сервер человека — подсказка по id, иначе до экрана подключения базы
    // было бы не добраться
    const known = Store.me();
    const admin = document.getElementById('prf-admin');
    if (admin) {
      admin.hidden = !(known
        ? known.admin
        : Boolean(user) && ADMIN_HINT.indexOf(String(user.id)) !== -1);
    }

    const id = document.getElementById('prf-id');
    const copy = document.getElementById('prf-copy');

    // Копируется ровно то, что показано, иначе в буфере окажется не то,
    // что человек видел на экране
    const shownId = user ? String(user.id) : null;
    id.textContent = shownId || '—';
    // Копировать нечего — значок не показываем, а прочерк оставляем
    copy.querySelector('svg').style.display = user ? '' : 'none';

    function copyId() {
      if (!shownId) return;

      const value = shownId;

      const done = () => {
        haptic('success');
        toast(t('profile.idCopied'));
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
    copy.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      copyId();
    });

    // Кошелёк, рефералы, топ, крафты и часть отбора у нас пока не
    // работают. Кнопки стоят, как у образца, и честно говорят, что скоро
    const pane = tabs.closest('.pane');
    pane.querySelectorAll('[data-soon]').forEach((button) => {
      button.addEventListener('click', () => {
        haptic('light');
        toast(t('soon.gems'));
      });
    });

    const buttons = Array.from(tabs.querySelectorAll('.prf-tabs__tab'));
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        if (button.classList.contains('is-active')) return;
        // «Крафты» пока только стоят на месте — переключаться некуда
        if (button.hasAttribute('data-soon')) return;

        haptic('select');
        buttons.forEach((other) => other.classList.toggle('is-active', other === button));
        tabs.style.setProperty('--prf-index', String(index));
        ownList.tab = button.dataset.prfTab;
        ownList.shown = PAGE;
        renderOwned(ownList);
      });
    });

    renderOwned(ownList);
  }

  // Счётчик в шапке профиля и список под вкладкой — после покупки их
  // приходится перерисовывать, а не собирать профиль заново
  function paintProfile() {
    // Задания считают отправленные и купленные — их счёт меняется вместе с профилем
    renderTasks();
    const owned = OWNED.gifts.length + OWNED.nft.length + OWNED.upg.length;
    const count = document.getElementById('prf-count');

    if (count) {
      count.textContent = formatPrice(owned) + ' ' + countOf(owned, 'gift.count');
    }

    renderOwned(ownList);
  }

  // --- Маркет ---

  /* Страница memgift `/m` блок в блок: бледный логотип, вкладки крупным
     текстом с балансом Gram справа, ряд отбора с «Статусом» на
     «Активности», поиск по номеру у «Подарков». Модель выбирают внутри
     коллекции. Продают только улучшенные подарки, цена в TON, платят с
     баланса. Своя у нас только карточка лота: фон подарка во всю
     карточку, номер на стекле, имя с моделью и цена кнопкой снизу */
  const MARKET_API = '/api/market';
  const MARKET_SORTS = ['latest', 'oldest', 'price_low', 'price_high'];
  const MARKET_STATUSES = ['sold', 'listed', 'removed'];
  let LOTS = [];
  let MKT_LOG = [];
  let marketTab = 'gifts';
  let marketLoaded = false;
  let marketBusy = false;

  function marketPost(payload) {
    return fetch(MARKET_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ initData: (tg && tg.initData) || '' }, payload))
    }).then((response) => response.json().catch(() => ({})).then((data) => {
      if (!response.ok) {
        const error = new Error(data.message || t('pay.sorry'));
        error.code = data.code || '';
        throw error;
      }
      return data;
    }));
  }

  // Рефералка и цена передачи — их ставит админка
  function feeSettings() {
    const state = Store.state() || {};
    return Object.assign({ referral: 10, transfer: 0 }, state.fees || {});
  }

  function marketSettings() {
    const state = Store.state() || {};
    return Object.assign({ fee: 5, min: 0.1 }, state.market || {});
  }

  // Лот выглядит как улучшенный подарок: тот же отбор и то же окно
  function lotView(lot) {
    const base = giftById(lot.nft.gift) || { id: lot.nft.gift, name: lot.nft.model.name };
    return Object.assign({}, base, {
      nft: lot.nft,
      symbol: lot.nft.symbol,
      backdrop: lot.nft.backdrop,
      // Для порядка «по цене» — цена лота, а не звёзды витрины
      price: lot.nano,
      ownerName: lot.seller.name,
      lot: lot
    });
  }

  function isMine(lot) {
    const me = tgUser();
    return Boolean(me && lot && String(lot.seller.id) === String(me.id));
  }

  function marketCard(gift, onPick) {
    const card = document.createElement('article');
    card.className = 'mkt-card';
    const colors = backdropColors(gift);
    card.style.setProperty('--center-color', colors.center);
    card.style.setProperty('--around-color', colors.around);

    const symbol = symbolOf(gift.nft.symbol);
    if (symbol) {
      const box = document.createElement('div');
      box.className = 'mkt-card__symbols';
      const img = document.createElement('img');
      img.src = symbol.image;
      img.alt = '';
      img.draggable = false;
      box.appendChild(img);
      card.appendChild(box);
    }

    const num = document.createElement('span');
    num.className = 'mkt-card__num';
    num.textContent = '#' + gift.nft.num;
    card.appendChild(num);

    const art = document.createElement('div');
    art.className = 'mkt-card__art';
    showShot(art, artOf(gift));
    card.appendChild(art);

    const foot = document.createElement('div');
    foot.className = 'mkt-card__foot';
    const name = document.createElement('b');
    name.className = 'mkt-card__name';
    name.textContent = gift.name;
    const model = document.createElement('span');
    model.className = 'mkt-card__model';
    model.textContent = gift.nft.model.name;
    const price = document.createElement('span');
    price.className = 'mkt-card__price' + (isMine(gift.lot) ? ' is-mine' : '');
    price.innerHTML = '<svg viewBox="0 0 19 16" aria-hidden="true"><use href="#gram"></use></svg>';
    price.append(formatTon(gift.lot.nano));
    foot.append(name, model, price);
    card.appendChild(foot);

    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', gift.name + ' #' + gift.nft.num);
    const show = () => {
      haptic('light');
      if (onPick) onPick(gift);
    };
    card.addEventListener('click', show);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      show();
    });
    return card;
  }

  function marketEmpty() {
    const box = document.createElement('div');
    box.className = 'prf__empty';
    const art = document.createElement('div');
    art.className = 'prf__empty-art';
    art.innerHTML = '<img src="gifts/profile-empty.svg" alt="" draggable="false">';
    const title = document.createElement('b');
    title.textContent = t(LOTS.length ? 'market.none' : 'market.empty');
    const line = document.createElement('p');
    line.textContent = t(LOTS.length ? 'market.noneNote' : 'market.emptyNote');
    box.append(art, title, line);
    return box;
  }

  // Коллекции — все подарки, которые улучшаются, как `marketGiftCatalog` memgift
  function marketCollections() {
    return GIFTS.filter((gift) => Array.isArray(gift.models) && gift.models.length)
      .map((gift) => ({ id: gift.id, label: gift.name, media: { type: 'gift', gift: gift } }));
  }

  // Модели — у выбранных коллекций, с шансом выпасть
  function marketModels(c) {
    const items = [];
    const seen = new Set();
    c.coll.forEach((id) => {
      const gift = giftById(id);
      (gift && gift.models || []).forEach((model) => {
        if (seen.has(model.name)) return;
        seen.add(model.name);
        items.push({ id: model.name, label: model.name, rate: pct(model.rate), media: { type: 'gift', gift: model } });
      });
    });
    return items;
  }

  const mktList = Object.assign(ownedList('mkt', () => LOTS.map(lotView), (gift) => ownSheet.open(gift), marketCard), {
    sorts: MARKET_SORTS,
    grid: 'mkt-grid',
    empty: marketEmpty,
    collItems: marketCollections,
    modelItems: marketModels,
    statuses: MARKET_STATUSES,
    status: '',
    num: '',
    repaint: () => paintMarket()
  });

  // «5 минут назад» — `unixToRelative` memgift
  function relativeTime(at) {
    const ru = window.I18N.lang() === 'ru';
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    const unit = (n, one, few, many, en) => (ru
      ? n + ' ' + (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many) + ' назад'
      : n + ' ' + en + (n === 1 ? '' : 's') + ' ago');
    if (s < 45) return ru ? 'несколько секунд назад' : 'a few seconds ago';
    if (s < 3600) return unit(Math.max(1, Math.round(s / 60)), 'минуту', 'минуты', 'минут', 'minute');
    if (s < 86400) return unit(Math.round(s / 3600), 'час', 'часа', 'часов', 'hour');
    if (s < 2592000) return unit(Math.round(s / 86400), 'день', 'дня', 'дней', 'day');
    return unit(Math.round(s / 2592000), 'месяц', 'месяца', 'месяцев', 'month');
  }

  // «Активность» с тем же отбором, что у лотов, плюс статус
  function activityItems(c) {
    let list = MKT_LOG.slice();
    if (c.sort === 'oldest') list.reverse();
    if (c.status) list = list.filter((one) => one.type === c.status);
    if (c.coll.length) list = list.filter((one) => c.coll.indexOf(one.nft.gift) !== -1);
    if (c.models.length) list = list.filter((one) => c.models.indexOf(one.nft.model.name) !== -1);
    if (c.symbols.length) list = list.filter((one) => c.symbols.indexOf(one.nft.symbol) !== -1);
    if (c.backdrops.length) list = list.filter((one) => c.backdrops.indexOf(one.nft.backdrop) !== -1);
    if (c.sort === 'price_low') list.sort((a, b) => a.nano - b.nano);
    if (c.sort === 'price_high') list.sort((a, b) => b.nano - a.nano);
    return list;
  }

  // Ряды — `Listings` memgift: квадрат с фоном и моделью, имя с номером,
  // цветной статус с ценой и «сколько назад» справа
  function renderActivity() {
    const box = document.getElementById('mkt-activity');
    if (!box) return;
    box.textContent = '';
    const items = activityItems(mktList);

    if (!items.length) {
      box.appendChild(marketEmpty());
      return;
    }

    const card = document.createElement('div');
    card.className = 'listings-card';
    const list = document.createElement('div');
    list.className = 'listings-list';

    items.forEach((one) => {
      const view = lotView({ nft: one.nft, nano: one.nano, seller: one.seller || { id: '', name: '' } });
      const row = document.createElement('div');
      row.className = 'listings-row is-' + one.type;

      const thumb = document.createElement('div');
      thumb.className = 'listings-row__thumb';
      const bg = document.createElement('div');
      bg.className = 'listings-row__bg';
      const colors = backdropColors(view);
      bg.style.setProperty('--center-color', colors.center);
      bg.style.setProperty('--around-color', colors.around);
      thumb.appendChild(bg);
      const symbol = symbolOf(one.nft.symbol);
      if (symbol) {
        const sym = document.createElement('div');
        sym.className = 'listings-row__symbol';
        sym.innerHTML = '<img alt="">';
        sym.firstChild.src = symbol.image;
        thumb.appendChild(sym);
      }
      const model = document.createElement('div');
      model.className = 'listings-row__model';
      showShot(model, artOf(view));
      thumb.appendChild(model);

      const mid = document.createElement('div');
      mid.className = 'listings-row__mid';
      const title = document.createElement('div');
      title.className = 'listings-row__title';
      const name = document.createElement('span');
      name.className = 'listings-row__name';
      name.textContent = view.name;
      const seq = document.createElement('span');
      seq.className = 'listings-row__seq';
      seq.textContent = '#' + one.nft.num;
      title.append(name, seq);

      const meta = document.createElement('div');
      meta.className = 'listings-row__meta';
      const chip = document.createElement('span');
      chip.className = 'listings-row__chip is-' + one.type;
      chip.textContent = t('market.st.' + one.type);
      meta.appendChild(chip);
      if (one.type !== 'removed') {
        const price = document.createElement('span');
        price.className = 'listings-row__price is-' + one.type;
        price.append(formatTon(one.nano) + ' ');
        const ton = document.createElement('img');
        ton.src = 'gifts/ton.svg';
        ton.alt = '';
        price.appendChild(ton);
        meta.appendChild(price);
      }
      mid.append(title, meta);

      const side = document.createElement('div');
      side.className = 'listings-row__side';
      const date = document.createElement('span');
      date.className = 'listings-row__date';
      date.textContent = relativeTime(one.at);
      side.appendChild(date);

      row.append(thumb, mid, side);
      list.appendChild(row);
    });

    card.appendChild(list);
    box.appendChild(card);
  }

  function paintMarket() {
    const gifts = marketTab === 'gifts';
    // Без коллекции и модели не выбрать — как `clearModels` memgift
    if (!mktList.coll.length) mktList.models = [];
    document.querySelectorAll('.mkt-tabs__item').forEach((item) => {
      item.classList.toggle('active', item.dataset.mktTab === marketTab);
    });
    document.getElementById('mkt-status').hidden = gifts;
    document.getElementById('mkt-search').hidden = !gifts;
    document.getElementById('mkt-list').hidden = !gifts;
    document.getElementById('mkt-activity').hidden = gifts;
    // Модель — только внутри выбранной коллекции
    document.getElementById('mkt-model').classList.toggle('disabled', !mktList.coll.length);
    document.getElementById('mkt-status-dot').hidden = !mktList.status;
    renderOwned(mktList);
    if (!gifts) renderActivity();
  }

  // Маркет по ссылке: раздел маркета и окно лота. Лота нет — так и говорим
  function openLot(match) {
    goMarket();
    if (!Store.live()) return;
    loadMarket().then(() => {
      const lot = LOTS.find(match);
      if (lot && ownSheet) ownSheet.open(lotView(lot));
      else if (marketLoaded) toast(t('market.gone'));
    });
  }

  // Пока маркет открыт, лоты и история обновляются сами
  const MARKET_REFRESH = 15000;

  function marketOpen() {
    return stage.dataset.section === 'market' && !document.hidden;
  }

  function watchMarket() {
    setInterval(() => {
      if (marketOpen()) loadMarket();
    }, MARKET_REFRESH);
    document.addEventListener('visibilitychange', () => {
      if (marketOpen()) loadMarket();
    });
  }

  let marketLoading = null;
  let marketStamp = '';

  function loadMarket() {
    if (!Store.live()) return Promise.resolve();
    // Уже грузится — ждём ту же загрузку, а не отвечаем пустым сразу
    if (marketBusy && marketLoading) return marketLoading;
    marketBusy = true;
    if (!marketLoaded) {
      const list = document.getElementById('mkt-list');
      list.innerHTML = '<div class="mkt-loading"><span class="mkt-spinner" aria-hidden="true"></span></div>';
    }
    marketLoading = Promise.all([marketPost({ action: 'list' }), marketPost({ action: 'activity' })])
      .then(([lots, act]) => {
        LOTS = lots.lots || [];
        MKT_LOG = act.log || [];
        // Ничего не поменялось — карточки не перерисовываем, чтобы не мигали
        const stamp = LOTS.map((one) => one.id + ':' + one.nano).join(',') + '|' +
          MKT_LOG.length + ':' + (MKT_LOG[0] ? MKT_LOG[0].at : 0);
        if (marketLoaded && stamp === marketStamp) return;
        marketStamp = stamp;
        marketLoaded = true;
        paintMarket();
      })
      .catch(() => {
        // Тихое обновление открытого маркета не пугает ошибкой — список уже есть
        if (marketLoaded) return;
        document.getElementById('mkt-list').textContent = '';
        toast(t('market.loadFail'));
      })
      .then(() => { marketBusy = false; });
    return marketLoading;
  }

  // После покупки или продажи: счёт, профиль, шапка
  function applyMe(me) {
    Store.apply(null, me);
    fillFromStore();
    initHeader();
    paintProfile();
  }

  function goMarket() {
    const at = tabs.findIndex((tab) => tab.dataset.section === 'market');
    if (at !== -1) selectTab(at);
  }

  // --- Продажа: окно memgift `SellModal` ---

  let sellSheet = null;
  let sellGift = null;
  let sellPlayer = null;
  let selling = false;
  // То же окно меняет цену выставленного: тогда в нём уже стоит прежняя
  let sellReprice = false;

  // «0,5 ◆» — сумма со значком Gram
  function gramText(node, nano) {
    node.innerHTML = '<svg viewBox="0 0 19 16" aria-hidden="true"><use href="#gram"></use></svg>';
    node.appendChild(document.createTextNode(formatTon(nano)));
  }

  function sellAmount() {
    const value = Number(String(document.getElementById('sell-price').value).replace(',', '.'));
    return Number.isFinite(value) ? value : 0;
  }

  function paintSell() {
    const market = marketSettings();
    const amount = sellAmount();
    const nano = Math.round(amount * NANO);
    const fee = Math.round(nano * market.fee / 100);
    gramText(document.getElementById('sell-min'), Math.round(market.min * NANO));
    gramText(document.getElementById('sell-total'), Math.max(0, nano - fee));
    document.getElementById('sell-go-price').textContent = formatTon(nano);

    const low = amount > 0 && amount < market.min;
    const error = document.getElementById('sell-error');
    error.hidden = !low;
    if (low) error.textContent = t('market.minError', { n: formatTon(Math.round(market.min * NANO)) });
    document.getElementById('sell-box').classList.toggle('is-error', low);
    document.getElementById('sell-go').disabled = selling || !(amount >= market.min);
  }

  function openSell(gift, reprice) {
    if (!gift || !gift.nft || !sellSheet) return;
    sellReprice = Boolean(reprice && gift.nft.lot);
    if (!Store.live()) {
      toast(t('pay.noDb'));
      return;
    }
    // Как у memgift: окно подарка закрывается, открывается окно продажи
    ownSheet.close();
    sellSheet.open(gift);
  }

  function sendSell() {
    const gift = sellGift;
    const amount = sellAmount();
    if (!gift || selling || amount < marketSettings().min) return;

    selling = true;
    const button = document.getElementById('sell-go');
    button.classList.add('is-loading');
    paintSell();
    const request = sellReprice
      ? { action: 'reprice', lot: gift.nft.lot, price: String(amount) }
      : { action: 'sell', nft: gift.nft.id, price: String(amount) };
    marketPost(request)
      .then((data) => {
        applyMe(data.me);
        haptic('success');
        toast(t(request.action === 'reprice' ? 'market.repriced' : 'market.listed'));
        sellSheet.close();
        refreshOwned(gift.nft.id);
        marketLoaded = false;
      })
      .catch((error) => toast(error.message))
      .then(() => {
        selling = false;
        button.classList.remove('is-loading');
        paintSell();
      });
  }

  function initSell() {
    sellSheet = createDock(document.getElementById('sell'), document.getElementById('sell-ov'), {
      fill: (gift) => {
        sellGift = gift;
        const head = document.getElementById('sell-head');
        paintHead(head, gift, document.getElementById('sell-symbol'), document.getElementById('sell-mark'));
        document.getElementById('sell-title').textContent = gift.name;
        // Смена цены — с прежней ценой в поле и своей подписью на кнопке
        document.getElementById('sell-price').value = sellReprice
          ? String(Math.round((gift.nft.lotNano || 0) / 1e7) / 100)
          : '';
        document.getElementById('sell-go-text').textContent = t(sellReprice ? 'market.newPrice' : 'market.sellFor');
        document.getElementById('sell-go-wait').textContent = t(sellReprice ? 'market.saving' : 'market.listing');
        paintSell();
      },
      opened: (gift) => {
        sellPlayer = openArt(document.getElementById('sell-art'), artOf(gift));
      },
      closed: () => {
        closeArt(document.getElementById('sell-art'), sellPlayer);
        sellPlayer = null;
        sellGift = null;
      }
    });
    if (!sellSheet) return;

    const input = document.getElementById('sell-price');
    input.addEventListener('input', () => {
      // Только число: точка или запятая и не больше двух знаков после
      let value = input.value.replace(',', '.').replace(/[^\d.]/g, '');
      const parts = value.split('.');
      if (parts.length > 2) value = parts[0] + '.' + parts.slice(1).join('');
      const [whole, frac] = value.split('.');
      input.value = whole.slice(0, 9) + (frac !== undefined ? '.' + frac.slice(0, 2) : '');
      paintSell();
    });
    document.getElementById('sell-go').addEventListener('click', sendSell);
  }

  function unlistOwned(gift) {
    if (!gift || !gift.nft || !gift.nft.lot) return;
    const button = document.getElementById('owned-sell');
    button.classList.add('loading');
    marketPost({ action: 'unlist', lot: gift.nft.lot })
      .then((data) => {
        applyMe(data.me);
        haptic('success');
        toast(t('market.unlisted'));
        refreshOwned(gift.nft.id);
        marketLoaded = false;
      })
      .catch((error) => toast(error.message))
      .then(() => button.classList.remove('loading'));
  }

  // Окно своего подарка перерисовываем по свежему счёту
  function refreshOwned(nftId) {
    const fresh = OWNED.upg.find((one) => one.nft.id === nftId);
    if (fresh && ownSheet && ownGift && ownGift.nft && ownGift.nft.id === nftId) {
      fillOwned(fresh);
      // Сняли с продажи — вернулась «Вывести», её значок заводим сейчас
      playTickerIcons();
    }
  }

  // --- Покупка лота ---

  let buying = false;

  function buyLot(gift) {
    const lot = gift && gift.lot;
    if (!lot || buying || isMine(lot)) return;
    // Не хватает на балансе — подсказываем пополнить, а не молчим
    if ((Number(ME && ME.tonNano) || 0) < lot.nano) {
      haptic('light');
      toast(t('market.low'));
      return;
    }
    const button = document.getElementById('owned-buy');
    buying = true;
    button.classList.add('is-loading');

    marketPost({ action: 'buy', lot: lot.id })
      .then((data) => {
        applyMe(data.me);
        LOTS = LOTS.filter((one) => one.id !== lot.id);
        haptic('success');
        // Как у memgift: уведомление и окно закрывается
        toast(t('market.bought'));
        ownSheet.close();
        paintMarket();
        loadMarket();
      })
      .catch((error) => {
        toast(error.message);
        // Лот ушёл к другому — убираем его и из списка
        if (error.code !== 'market.low') {
          ownSheet.close();
          loadMarket();
        }
      })
      .then(() => {
        buying = false;
        button.classList.remove('is-loading');
      });
  }

  function initMarket() {
    const tabsBox = document.getElementById('mkt-tabs');
    if (!tabsBox) return;

    tabsBox.querySelectorAll('.mkt-tabs__item').forEach((item) => {
      item.addEventListener('click', () => {
        if (item.dataset.mktTab === marketTab) return;
        haptic('select');
        marketTab = item.dataset.mktTab;
        paintMarket();
      });
    });

    // Поиск по номеру: цифры — и сразу отбор
    const num = document.getElementById('mkt-num');
    num.addEventListener('input', () => {
      num.value = num.value.replace(/\D/g, '').slice(0, 9);
      mktList.num = num.value;
      mktList.shown = PAGE;
      renderOwned(mktList);
    });

    // Статус — только на «Активности»: продан, выставлен, снят
    document.getElementById('mkt-status').addEventListener('click', () => {
      haptic('light');
      pickSheet.open({
        title: t('market.status'),
        icon: { href: '#sort-lines', box: '0 0 18 11', sort: true },
        items: MARKET_STATUSES.map((id) => ({ id: id, label: t('market.st.' + id) })),
        selected: mktList.status,
        onApply: (id) => {
          mktList.status = id || '';
          paintMarket();
        }
      });
    });

    initOwnFilters(mktList);
    initSell();
    paintMarket();
    watchMarket();
  }

  // --- Чужой профиль ---

  /* Страница /view/:id memgift: аватар, имя, «N подарков · id», ниже те
     же вкладки, отбор и сетка, что в своём профиле. Подарки открываются в
     том же окне, но только посмотреть */

  const VIEW_API = '/api/profile';
  let viewSheet = null;
  let VIEWED = { name: '', gifts: [], upg: [] };
  let viewAsk = 0;

  // Выставленный на маркет подарок в чужом профиле открывается лотом —
  // с ценой и «Купить», как в маркете
  const viewList = ownedList('vw', (kind) => (kind === 'gifts' ? VIEWED.gifts.concat(VIEWED.upg) : []),
    (gift) => ownSheet.open(gift.nft && gift.nft.lot
      ? lotView({ id: gift.nft.lot, nano: gift.nft.lotNano, nft: gift.nft, seller: { id: VIEWED.id, name: VIEWED.name } })
      : gift), viewCard);

  function personName(person) {
    return [person.firstName, person.lastName].filter(Boolean).join(' ') ||
      (person.username ? '@' + person.username : person.name || '—');
  }

  function paintViewHead(name, photo, id, count) {
    const avatar = document.getElementById('vw-avatar');
    avatar.textContent = '';
    avatar.style.backgroundImage = '';
    if (photo) avatar.style.backgroundImage = 'url("' + photo + '")';
    else avatar.textContent = String(name || '?').replace('@', '').charAt(0).toUpperCase();

    document.getElementById('vw-name').textContent = name || '—';
    document.getElementById('vw-id').textContent = id || '—';
    document.getElementById('vw-count').textContent = count === null
      ? '…'
      : formatPrice(count) + ' ' + countOf(count, 'gift.count');
  }

  /* Карточка чужого профиля — `.item._gift` memgift: квадрат 1:1,
     скругление 20, фон редкости (или #252528), узор, подарок на 70% и
     лента 88×36 в углу. У улучшенного — его фон, узор символа, номер */
  const RARITY_BG = {
    rare: 'linear-gradient(180deg, #282867 0%, #131328 100%)',
    veryrare: 'linear-gradient(180deg, #1D6132 0%, #0B2211 100%)',
    epic: 'linear-gradient(180deg, #632475 0%, #19101D 100%)',
    legend: 'linear-gradient(180deg, #6F480E 0%, #1D1710 100%)',
    author: 'linear-gradient(180deg, #762121 0%, #221111 100%)'
  };

  function viewCard(gift, onPick) {
    const upg = Boolean(gift.nft);
    const card = document.createElement('div');
    card.className = 'vw-gift' + (upg ? ' is-upgraded' : '');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    if (upg) {
      const colors = backdropColors(gift);
      card.style.background = 'radial-gradient(circle at 50% 40%, ' + boostColor(colors.center, 0.28) +
        ' 0%, ' + colors.center + ' 45%, ' + colors.around + ' 100%)';
    } else {
      card.style.background = RARITY_BG[gift.rarity] || '#252528';
    }

    const symbols = document.createElement('div');
    symbols.className = 'vw-gift__symbols';
    const pattern = document.createElement('img');
    const symbol = upg && symbolOf(gift.nft.symbol);
    pattern.src = symbol ? symbol.image : 'gifts/pattern.png';
    pattern.alt = '';
    pattern.draggable = false;
    symbols.appendChild(pattern);
    card.appendChild(symbols);

    if (upg) {
      const num = document.createElement('div');
      num.className = 'vw-gift__badge';
      const span = document.createElement('span');
      span.textContent = '#' + gift.nft.num;
      num.appendChild(span);
      card.appendChild(num);
    }

    const art = document.createElement('div');
    art.className = 'vw-gift__nft';
    card.appendChild(art);
    showShot(art, artOf(gift));

    // Выставлен на маркете — лента «on sale» той же формы
    if (upg && gift.nft.lot) {
      const rib = document.createElement('div');
      rib.className = 'vw-gift__rarity';
      const image = document.createElement('span');
      image.className = 'gift__badge vw-gift__ribbon';
      paintSale(image, backdropColors(gift).center, true);
      const text = document.createElement('div');
      text.className = 'vw-gift__text';
      const label = document.createElement('span');
      label.textContent = 'on sale';
      text.appendChild(label);
      rib.append(image, text);
      card.appendChild(rib);
    }

    const sold = !upg && gift.left === 0;
    if (!upg && (gift.badge || sold)) {
      const rib = document.createElement('div');
      rib.className = 'vw-gift__rarity';
      const image = document.createElement('span');
      image.className = 'gift__badge vw-gift__ribbon';
      image.dataset.kind = sold ? 'soldout' : gift.kind || 'default';
      if (gift.tone && !sold) image.style.setProperty('--ribbon-fill', gift.tone);
      image.innerHTML = '<svg class="gift__ribbon" viewBox="-2 -2 124 36" aria-hidden="true"><use href="#ribbon-shape"></use></svg>';
      const text = document.createElement('div');
      text.className = 'vw-gift__text';
      const label = document.createElement('span');
      label.textContent = sold ? 'sold out' : gift.badge;
      text.appendChild(label);
      rib.append(image, text);
      card.appendChild(rib);
    }

    const show = () => {
      haptic('light');
      if (onPick) onPick(gift);
    };
    card.addEventListener('click', show);
    card.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      show();
    });
    return card;
  }

  function openView(person) {
    if (!viewSheet || !person || !person.id) return;
    viewSheet.open(person);
  }

  function fillView(person) {
    const ask = ++viewAsk;
    VIEWED = { id: String(person.id), name: person.name || '', gifts: [], upg: [] };

    // Что известно из топа, показываем сразу; остальное догрузится
    paintViewHead(person.name, person.photo, VIEWED.id, null);
    viewList.tab = 'gifts';
    viewList.shown = PAGE;
    const tabs = document.getElementById('vw-tabs');
    tabs.style.setProperty('--prf-index', '0');
    tabs.querySelectorAll('.prf-tabs__tab').forEach((one, index) => one.classList.toggle('is-active', index === 0));
    renderOwned(viewList);

    fetch(VIEW_API + '?id=' + encodeURIComponent(VIEWED.id))
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (ask !== viewAsk || !data || !data.user) return;
        const user = data.user;
        const name = personName(user);
        const mark = (gift) => Object.assign({}, gift, { ownerName: name });

        VIEWED = {
          id: user.id,
          name: name,
          gifts: (user.gifts || []).map(giftById).filter(Boolean).map(mark),
          upg: (user.nfts || []).slice().sort((a, b) => a.at - b.at).map(nftView).map(mark)
        };

        paintViewHead(name, user.photo, user.id, VIEWED.gifts.length + VIEWED.upg.length);
        renderOwned(viewList);

        // Пришли по ссылке «Поделиться» — сразу открываем тот самый подарок
        const focus = person.focus && findOwned(VIEWED.gifts.concat(VIEWED.upg), person.focus);
        if (focus && ownSheet) ownSheet.open(focus);
      })
      .catch(() => {});
  }

  function initView() {
    const root = document.getElementById('view');
    if (!root) return;

    viewSheet = createSheet(root, {
      fill: fillView,
      closed: () => {
        releaseArt(document.getElementById('vw-list'));
        document.getElementById('vw-list').textContent = '';
        viewAsk += 1;
        // Под страницей могла остаться страница подарка — её «назад» нужен
        syncBack();
      }
    });

    const tabs = document.getElementById('vw-tabs');
    const buttons = Array.from(tabs.querySelectorAll('.prf-tabs__tab'));
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => {
        if (button.classList.contains('is-active') || button.hasAttribute('data-soon')) return;
        haptic('select');
        buttons.forEach((other) => other.classList.toggle('is-active', other === button));
        tabs.style.setProperty('--prf-index', String(index));
        viewList.tab = button.dataset.prfTab;
        viewList.shown = PAGE;
        renderOwned(viewList);
      });
    });

    const copy = document.getElementById('vw-copy');
    const copyId = () => {
      if (VIEWED.id) copyText(String(VIEWED.id), 'profile.idCopied');
    };
    copy.addEventListener('click', copyId);
    copy.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      copyId();
    });

    initOwnFilters(viewList);
  }

  // --- Выбор языка ---

  /* Кружок с флагом в углу профиля и список под ним. Список собирается из
     словаря: появится там язык — появится и строка здесь.

     Смена языка не перезагружает приложение. Надписи в разметке переписывает
     сам словарь по меткам data-i18n, а то, что рисует код, перерисовываем
     отсюда. Задания не трогаем: их названия приходят из админки и переводу
     не подлежат. */

  const TICK = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="m5 12.6 4.6 4.6L19 7.6" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function initLang() {
    const root = document.getElementById('lang');
    if (!root) return;

    const button = document.getElementById('lang-btn');
    const menu = document.getElementById('lang-menu');
    const flag = document.getElementById('lang-flag');
    let shown = false;
    let hiding = null;

    function paintFlag() {
      flag.textContent = window.I18N.one().flag;
    }

    function build() {
      menu.textContent = '';

      window.I18N.langs().forEach((item) => {
        const row = document.createElement('button');
        row.className = 'lang__row';
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(item.code === window.I18N.lang()));

        const mark = document.createElement('span');
        mark.className = 'lang__flag';
        mark.textContent = item.flag;

        const name = document.createElement('span');
        name.className = 'lang__name';
        // Язык назван на себе самом: английский — English, и так везде
        name.textContent = item.name;

        const tick = document.createElement('span');
        tick.className = 'lang__tick';
        tick.innerHTML = TICK;

        row.append(mark, name, tick);
        row.addEventListener('click', () => choose(item.code));
        menu.appendChild(row);
      });
    }

    function open() {
      if (shown) return;
      shown = true;
      clearTimeout(hiding);

      build();
      menu.hidden = false;
      // Пересчёт стилей форсируем чтением размера — иначе перехода не будет
      void menu.offsetHeight;
      menu.classList.add('is-on');
      button.setAttribute('aria-expanded', 'true');
    }

    function close() {
      if (!shown) return;
      shown = false;

      menu.classList.remove('is-on');
      button.setAttribute('aria-expanded', 'false');
      hiding = setTimeout(() => {
        menu.hidden = true;
      }, 240);
    }

    function choose(code) {
      haptic('select');
      close();
      // Язык тот же — перерисовывать нечего, список просто закроется
      window.I18N.set(code);
    }

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      haptic('light');
      if (shown) close();
      else open();
    });

    // Мимо списка — закрываем. Нажатие по самому списку сюда не доходит
    menu.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    paintFlag();

    window.I18N.onChange(() => {
      paintFlag();

      // Подпись под подарком живёт в самих записях — пересобираем каталог
      fillFromStore();
      paintSection();
      paintFilters();
      drawGifts();
      initHeader();
      paintProfile();
    });
  }

  // Снять заставку. Вызывается, когда содержимое пришло, — а не когда
  // догрузились картинки страницы: иначе при медленной базе человек видит
  // пустое приложение и решает, что оно сломалось
  let hideSplash = () => {};

  function initSplash() {
    if (!splash) return;

    const started = performance.now();
    let done = false;

    hideSplash = () => {
      if (done) return;
      done = true;
      const wait = Math.max(0, SPLASH_MIN_MS - (performance.now() - started));
      setTimeout(() => splash.classList.add('is-done'), wait);
    };

    setTimeout(hideSplash, SPLASH_MAX_MS);
  }

  // Содержимое не пришло вовсе. Молча оставлять пустой экран нельзя —
  // человеку нечего нажать и непонятно, что случилось
  function showLoadFailure() {
    if (!giftsGrid) return;

    giftsGrid.textContent = '';

    const box = document.createElement('p');
    box.className = 'gifts__none';
    box.textContent = t('gifts.failed');

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'filter';
    again.style.marginTop = '14px';
    again.textContent = t('gifts.retry');
    again.addEventListener('click', () => location.reload());

    box.appendChild(document.createElement('br'));
    box.appendChild(again);
    giftsGrid.appendChild(box);
  }

  // Пока содержимое не пришло, рисовать нечего: на экране заставка
  function fillFromStore() {
    const state = Store.state();
    const user = tgUser();

    // Счёт приходит с сервера. Нет его — гость с пустым балансом, чтобы
    // витрина и профиль не выглядели сломанными
    ME = Store.me() || { stars: 0, coupons: 0, gifts: [], admin: false };

    GIFTS = (state.gifts || []).map((gift) => Object.assign({ owner: '—' }, gift));

    // В профиле лежат те же записи, что на витрине: иначе плашка редкости
    // у купленного подарка разошлась бы с витринной
    OWNED = {
      gifts: (ME.gifts || []).map(giftById).filter(Boolean),
      nft: [],
      upg: (ME.nfts || []).slice().sort((a, b) => a.at - b.at).map(nftView)
    };

    TASK_BLOCKS = (state.tasks || []).map((group) => ({
      title: group.title,
      items: (group.items || []).map((task) => Object.assign({ done: 0 }, task))
    }));
  }

  /* Защита: GapsGift открывается только в приложении Telegram — на
     компьютере (Telegram Desktop, macOS, Unigram) и на телефоне (iOS,
     Android). Браузер и веб-версия Telegram (web.telegram.org, platform
     weba/webk/web) видят экран с QR-кодом: его сканируют и открывают
     приложение. Без подписанных initData не пускаем вовсе: такие заходы —
     это обычный браузер */
  const APP_PLATFORMS = ['tdesktop', 'macos', 'unigram', 'ios', 'android', 'android_x'];
  const APP_LINK = 'https://t.me/GapsGiftBot/app';

  function outsideApp() {
    if (!tg || !tg.initData) return true;
    return APP_PLATFORMS.indexOf(String(tg.platform || '')) === -1;
  }

  function showOutside() {
    const gate = document.createElement('div');
    gate.className = 'outside';

    const title = document.createElement('h1');
    title.className = 'outside__title';
    title.textContent = t('gate.title');

    const text = document.createElement('p');
    text.className = 'outside__text';
    text.textContent = t('gate.text');

    // QR ведёт туда же, куда кнопка: на Mini App в боте
    const qr = document.createElement('img');
    qr.className = 'outside__qr';
    qr.src = 'gifts/qr-open.png';
    qr.alt = APP_LINK;
    qr.draggable = false;

    const open = document.createElement('a');
    open.className = 'outside__btn';
    open.href = APP_LINK;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = t('gate.open');
    open.addEventListener('click', (event) => {
      // Внутри Telegram ссылку открывает сам Telegram, а не браузер
      if (tg && tg.initData && tg.openTelegramLink) {
        event.preventDefault();
        tg.openTelegramLink(APP_LINK);
      }
    });

    gate.append(title, text, qr, open);
    document.body.appendChild(gate);
    document.documentElement.classList.add('is-outside');
  }

  if (outsideApp()) {
    initSplash();
    showOutside();
    hideSplash();
    return;
  }

  initTelegram();
  initNav();
  initSplash();

  // Фоны и символы нужны до первой отрисовки: из них собраны улучшенные
  // подарки в профиле. Не загрузились — профиль всё равно откроется
  function loadAttrs() {
    return new Promise((resolve) => {
      if (attrs) {
        resolve(attrs);
        return;
      }
      fetch(ATTRS)
        .then((response) => response.json())
        .then((data) => {
          attrs = { symbols: data.symbols || [], backdrops: data.backdrops || [] };
        })
        .catch(() => {})
        .then(() => resolve(attrs));
    });
  }

  Store.load()
    .then(loadAttrs)
    .then(() => {
      fillFromStore();

      initGifts();
      warmTops();
      initTasks();
      initSheet();
      initHeader();
      initProfile();
      initOwnFilters(ownList);
      initView();
      initMarket();
      initLang();

      initSlider(buildBanners());
      openStartGift();
      openInbox();
    })
    .catch((error) => {
      console.warn('Содержимое не загрузилось:', error);
      showLoadFailure();
    })
    // Заставка уходит в обоих случаях: и когда витрина готова, и когда
    // стало ясно, что её не будет
    .then(hideSplash, hideSplash);
})();
