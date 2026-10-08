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
  // Сколько баннер стоит, прежде чем смениться сам
  const SLIDE_MS = 5000;

  // Единый каталог подарков. Витрина и профиль ссылаются на одни и те же
  // записи, поэтому плашка редкости не может разойтись: купленный подарок
  // показывает ровно ту же, что была на витрине.
  const NFT_NOTE = 'Подарок скоро можно будет улучшить, продать и выпустить как NFT';

  // Содержимое — подарки, баннеры, задания, люди — приходит из хранилища
  // (data/content.json плюс правки из админки). Здесь только то, что
  // хранилище наполняет на старте.
  let GIFTS = [];
  let OWNED = { gifts: [], nft: [] };
  let TASK_BLOCKS = [];
  let ME = null;

  function giftById(id) {
    return GIFTS.find((one) => one.id === id) || null;
  }

  // Насколько утянуть лист вниз, чтобы он закрылся
  const SHEET_CLOSE_DRAG = 110;
  // Резкий рывок закрывает, даже если утянули недалеко
  const SHEET_FLING = 0.7;
  // Остаток меньше этой доли — показываем, что подарок на исходе
  const SCARCE_SHARE = 0.1;
  // Потолок на случай, если наличие не указано
  const QTY_MAX = 99;

  // Кому показывать вход в админку, пока сервер не может узнать человека
  // (база или токен бота ещё не подключены). Это только ссылка: доступ
  // проверяет сама админка на сервере
  const ADMIN_HINT = ['8387706094'];

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

  // Подсветка иконок без переноса подложки — нужна во время перетаскивания.
  // Название раздела здесь не меняем: пока палец ведёт капсулу, на экране
  // ещё прежняя страница, и заголовок обгонял бы её
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

    // Заголовок меняется ровно вместе со страницей — на входе в раздел
    const title = document.getElementById('hdr-section');
    const named = tabs[index].dataset.title;
    if (title && named) title.textContent = named;

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
      slide.setAttribute('aria-label', banner.label || 'Баннер');
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
  function formatPrice(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  }

  function buildGift(gift, onPick, withPrice) {
    const card = document.createElement('article');
    card.className = 'gift';

    const art = document.createElement('div');
    art.className = 'gift__art';
    if (gift.name) art.setAttribute('aria-label', gift.name);
    card.appendChild(art);
    if (isStill(gift)) showStill(art, gift.art);
    else playWhenSeen(art, gift.art);

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
      star.src = 'gifts/star.png';
      star.alt = 'звёзд';
      star.draggable = false;

      const amount = document.createElement('span');
      amount.className = 'gift__amount';
      amount.textContent = formatPrice(gift.price);

      price.append(star, amount);
      card.appendChild(price);
    }

    return card;
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

  // Один прогон и остановка на последнем кадре — так ведут себя все анимации
  // в приложении, кроме той, что в раскрытой карточке. Анимация всегда
  // приходит адресом: файл из репозитория или загрузка из админки.
  function playOnce(container, path) {
    if (!window.lottie || !path) return null;

    const still = prefersStill();
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

  function applyTint(card, tint) {
    if (!card) return;

    if (!tint) {
      // Снимаем цвет прошлого подарка, иначе он остался бы на чужой карточке
      card.style.removeProperty('--own-h');
      card.style.removeProperty('--own-s');
      return;
    }

    card.style.setProperty('--own-h', String(tint.hue));
    card.style.setProperty('--own-s', tint.sat + '%');
  }

  // Картинку просто рисуем в холст в стороне от экрана и считаем по нему
  // господствующий оттенок
  function stillTint(path, done) {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(img.naturalWidth || 256, 256);
      canvas.height = Math.min(img.naturalHeight || 256, 256);
      canvas.getContext('2d', { willReadFrequently: true })
        .drawImage(img, 0, 0, canvas.width, canvas.height);

      const tint = artTint(canvas);
      if (tint) tints.set(path, tint);
      if (done) done(tint);
    };

    img.onerror = () => { if (done) done(null); };
    img.src = path;
  }

  // У анимации пробный прогон идёт в стороне от экрана, и кадр берём из
  // середины: первый у многих композиций пустой, и цвет по нему не вытащить
  function warmTint(gift, done) {
    const path = gift && gift.art;
    if (!path) {
      if (done) done(null);
      return;
    }

    if (tints.has(path)) {
      if (done) done(tints.get(path));
      return;
    }

    if (isStill(gift)) {
      stillTint(path, done);
      return;
    }

    whenLottieReady(() => {
      if (tints.has(path)) {
        if (done) done(tints.get(path));
        return;
      }

      const box = document.createElement('div');
      box.className = 'tint-probe';
      document.body.appendChild(box);

      const probe = window.lottie.loadAnimation({
        container: box,
        renderer: 'canvas',
        loop: false,
        autoplay: false,
        path: path,
        // Цвет от разрешения не зависит, а мелкий кадр считается мгновенно
        rendererSettings: { dpr: 1 }
      });

      probe.addEventListener('DOMLoaded', () => {
        probe.goToAndStop(Math.floor(probe.totalFrames / 2), true);

        const tint = artTint(box.querySelector('canvas'));
        if (tint) tints.set(path, tint);

        probe.destroy();
        box.remove();

        if (done) done(tint);
      });
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

  function createSheet(root, hooks) {
    if (!root) return null;

    const panel = root.querySelector('.sheet__panel');
    const scroll = root.querySelector('.sheet__scroll');
    const on = hooks || {};

    function isOpen() {
      return root.dataset.open === 'true';
    }

    function open(payload) {
      if (isOpen()) return;
      if (on.fill) on.fill(payload);

      root.hidden = false;
      root.dataset.open = 'true';

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
      scroll.classList.toggle('is-static', scroll.scrollHeight <= scroll.clientHeight + 1);

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
      const handle = event.target.closest('.sheet__head, .sheet__stage, .own-card');
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

  function closeOpenSheet() {
    sheets.forEach((one) => {
      if (one.isOpen()) one.close();
    });
  }

  let ownGift = null;

  // Подарок лежит у того, кто смотрит, поэтому владелец — он сам.
  // Собачку убираем: в поле стоит ник, а не упоминание.
  function ownerName(gift) {
    const user = tgUser();
    if (user) return userTitle(user).replace(/^@/, '');
    return (gift && gift.owner) || '—';
  }

  function fillOwned(gift) {
    ownGift = gift;

    const card = owned.querySelector('.own-card');
    // Готовый цвет — сразу; иначе подложка остаётся запасной, пока не
    // досчитается, и перекрашивается уже под закрытым листом
    applyTint(card, tints.get(gift.art) || null);
    if (!tints.has(gift.art)) {
      warmTint(gift, (tint) => {
        if (tint && ownGift === gift) applyTint(card, tint);
      });
    }

    document.getElementById('owned-title').textContent = gift.name;
    document.getElementById('owned-owner').textContent = ownerName(gift);

    const known = typeof gift.left === 'number' && typeof gift.total === 'number';
    document.getElementById('owned-left').textContent = known
      ? formatPrice(gift.total - gift.left) + ' of ' + formatPrice(gift.total)
      : '—';
  }

  function initOwnedTools() {
    if (!owned) return;

    const soon = (what) => () => {
      haptic('light');
      toast(what + ' скоро заработает');
    };

    document.getElementById('owned-send').addEventListener('click', soon('Отправка'));
    document.getElementById('owned-share').addEventListener('click', soon('Поделиться'));

    document.getElementById('owned-copy').addEventListener('click', () => {
      if (!ownGift) return;

      const link = location.origin + '/?gift=' + encodeURIComponent(ownGift.id);
      const done = () => {
        haptic('success');
        toast('Ссылка скопирована');
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(done, () => {
          if (legacyCopy(link)) done();
        });
        return;
      }

      if (legacyCopy(link)) done();
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
        if (sheet.dataset.fill) {
          document.getElementById('sheet-gauge-fill').style.width = sheet.dataset.fill;
        }
        sheetPlayer = openArt(document.getElementById('sheet-art'), gift);
      },
      closed: () => {
        closeArt(document.getElementById('sheet-art'), sheetPlayer);
        sheetPlayer = null;
        sheetGift = null;
      }
    });

    ownSheet = createSheet(owned, {
      fill: fillOwned,
      opened: (gift) => {
        ownPlayer = openArt(document.getElementById('owned-art'), gift);
      },
      closed: () => {
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

    document.getElementById('sheet-buy').addEventListener('click', () => {
      haptic('light');
      // Оплата появится вместе с серверной частью
      if (tg && tg.showAlert && sheetGift) {
        tg.showAlert('Покупка «' + sheetGift.name + '» ' + qty + ' шт. скоро заработает');
      }
    });

    const share = document.getElementById('sheet-share');
    if (share) {
      share.addEventListener('click', () => {
        haptic('light');
        toast('Поделиться скоро заработает');
      });
    }

    initOwnedTools();
  }

  function initGifts() {
    if (!giftsGrid) return;

    GIFTS.forEach((gift) => giftsGrid.appendChild(buildGift(gift, (one) => buySheet.open(one), true)));
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
    reward.setAttribute('aria-label', 'Награда: ' + task.reward + ' купонов');

    info.append(name, reward);

    // Счётчик, а не кнопка: пока задание не выполнено, нажимать нечего
    const count = document.createElement('span');
    count.className = 'task__count';
    count.textContent = formatPrice(task.done) + '/' + formatPrice(task.goal);
    count.dataset.done = String(task.done >= task.goal);

    row.append(avatar, info, count);
    return row;
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
    if (!user) return 'Гость';
    if (user.username) return '@' + user.username;
    return [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Без имени';
  }


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
    market.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#gems"></use></svg>';
    market.append('GetGems');
    market.addEventListener('click', () => {
      haptic('select');
      selectTab(0);
    });

    line.appendChild(market);
    box.append(art, title, line);

    playWhenSeen(art, 'gifts/empty.json');

    return box;
  }

  function renderOwned(kind) {
    const list = document.getElementById('prf-list');
    const total = document.getElementById('prf-total');
    const items = OWNED[kind] || [];

    releaseArt(list);
    list.textContent = '';
    total.textContent = formatPrice(items.length) + ' ' + plural(items.length, 'подарок', 'подарка', 'подарков');

    if (!items.length) {
      list.appendChild(emptyState());
      return;
    }

    // Пока список на экране, досчитываем цвета: открытая карточка возьмёт
    // готовое значение и не будет перекрашиваться на глазах
    items.forEach((gift) => warmTint(gift));

    const grid = document.createElement('div');
    grid.className = 'gifts';
    // Из профиля открывается карточка уже купленного подарка, а не покупка
    items.forEach((gift) => grid.appendChild(buildGift(gift, (one) => ownSheet.open(one))));
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

    stars.textContent = formatPrice(ME ? ME.stars : 0);
    coupons.textContent = formatPrice(ME ? ME.coupons : 0);
  }

  function initProfile() {
    const tabs = document.getElementById('prf-tabs');
    if (!tabs) return;

    const user = tgUser();
    const owned = OWNED.gifts.length + OWNED.nft.length;

    const name = document.getElementById('prf-name');
    name.textContent = userTitle(user);

    document.getElementById('prf-count').textContent =
      formatPrice(owned) + ' ' + plural(owned, 'подарок', 'подарка', 'подарков');

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
    copy.hidden = !user;

    function copyId() {
      if (!shownId) return;

      const value = shownId;

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

  // Пока содержимое не пришло, рисовать нечего: на экране заставка
  function fillFromStore() {
    const state = Store.state();
    const user = tgUser();

    // Счёт приходит с сервера. Нет его — гость с пустым балансом, чтобы
    // витрина и профиль не выглядели сломанными
    ME = Store.me() || { stars: 0, coupons: 0, gifts: [], admin: false };

    GIFTS = (state.gifts || []).map((gift) => Object.assign({ note: NFT_NOTE, owner: '—' }, gift));

    // В профиле лежат те же записи, что на витрине: иначе плашка редкости
    // у купленного подарка разошлась бы с витринной
    OWNED = {
      gifts: (ME.gifts || []).map(giftById).filter(Boolean),
      nft: []
    };

    TASK_BLOCKS = (state.tasks || []).map((group) => ({
      title: group.title,
      items: (group.items || []).map((task) => Object.assign({ done: 0 }, task))
    }));
  }

  initTelegram();
  initNav();
  initSplash();

  Store.load()
    .then(() => {
      fillFromStore();

      initGifts();
      initTasks();
      initSheet();
      initHeader();
      initProfile();

      initSlider(buildBanners());
    })
    .catch((error) => console.warn('Содержимое не загрузилось:', error));
})();
