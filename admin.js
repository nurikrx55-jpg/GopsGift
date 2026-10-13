/* Админка GapsGift.

   Всё, что здесь меняется, уходит на сервер и сразу видно всем: каждый
   заход в приложение берёт витрину, баннеры и счёт из общей базы. Кто
   админ, решает сервер — по подписи Telegram, которую подделать нельзя. */
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  const API = '/api/admin';
  const LAST_TAB = 'gg:admin-tab';

  const SECTIONS = ['gifts', 'banners', 'tasks', 'users', 'settings'];

  // Цвета лент — те же градиенты, что на витрине
  const RIBBONS = [
    { id: 'blood', name: 'Красная', from: '#ff5a52', to: '#b01b16' },
    { id: 'legend', name: 'Жёлтая', from: '#f9c81f', to: '#c8820a' },
    { id: 'premium', name: 'Оранж', from: '#f6b329', to: '#f18902' },
    { id: 'epic', name: 'Фиолет', from: '#a97bf0', to: '#5a3bb0' },
    { id: 'rare', name: 'Зелёная', from: '#3fae6a', to: '#1b5c37' },
    { id: 'time', name: 'Сирень', from: '#b292f5', to: '#6e62e0' },
    { id: 'sold', name: 'Бордо', from: '#5f3a3e', to: '#471f20' },
    { id: 'default', name: 'Графит', from: '#364b5c', to: '#172d42' }
  ];

  // Редкость — цвет карточки на витрине и на странице подарка, градиенты
  // memgift (`._gift.rare` и т.д.). «Авто» — тон самого подарка
  const RARITIES = [
    { id: '', name: 'Авто', from: '#1e1e1e', to: '#191919' },
    { id: 'rare', name: 'Rare', from: '#282867', to: '#131328' },
    { id: 'veryrare', name: 'Very rare', from: '#1d6132', to: '#0b2211' },
    { id: 'epic', name: 'Epic', from: '#632475', to: '#19101d' },
    { id: 'legend', name: 'Legend', from: '#6f480e', to: '#1d1710' },
    { id: 'author', name: 'Author', from: '#762121', to: '#221111' }
  ];

  // Куда класть переменные, если база или токен ещё не настроены
  const ENV_FILE = '<code>/etc/gapsgift.env</code> на сервере';

  const BANNER_WIDTH = 1392;
  const BANNER_HEIGHT = 518;
  const CROP_MAX_ZOOM = 3;
  const USERS_PAGE = 40;

  const view = document.getElementById('view');
  const sheet = document.getElementById('sheet');
  const sheetPanel = sheet.querySelector('.ad-sheet__panel');
  const sheetBody = document.getElementById('sheet-body');
  const sheetFoot = document.getElementById('sheet-foot');
  const picker = document.getElementById('picker');

  let content = null;
  let stats = null;
  let me = null;
  let current = 'gifts';
  let sheetClose = null;

  // --- Мелочи ---

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  }

  function button(label, options) {
    const opts = options || {};
    const node = el('button', 'ad-btn' + (opts.kind ? ' ad-btn--' + opts.kind : '') + (opts.extra ? ' ' + opts.extra : ''));
    node.type = opts.type || 'button';
    if (opts.icon) node.appendChild(icon(opts.icon));
    if (label) node.appendChild(el('span', null, label));
    if (opts.title) node.setAttribute('aria-label', opts.title);
    if (opts.onClick) node.addEventListener('click', opts.onClick);
    return node;
  }

  function iconButton(name, title, onClick, extra) {
    const node = el('button', 'ad-icon' + (extra ? ' ' + extra : ''));
    node.type = 'button';
    node.setAttribute('aria-label', title);
    node.title = title;
    node.appendChild(icon(name));
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  // 2000 -> «2 000». Пробел неразрывный, чтобы число не рвалось
  function num(value) {
    return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function plural(n, one, few, many) {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 >= 11 && mod100 <= 14) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  }

  function ago(ts) {
    if (!ts) return '—';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return 'только что';
    if (s < 3600) return Math.floor(s / 60) + ' мин назад';
    if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
    if (s < 172800) return 'вчера';
    return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }

  function day(ts) {
    return ts ? new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === 'ok') tg.HapticFeedback.notificationOccurred('success');
      else if (kind === 'bad') tg.HapticFeedback.notificationOccurred('error');
      else if (kind === 'pick') tg.HapticFeedback.selectionChanged();
      else tg.HapticFeedback.impactOccurred('light');
    } catch (_) {}
  }

  let toastTimer = null;

  function toast(text, tone) {
    const node = document.getElementById('toast');
    document.getElementById('toast-text').textContent = text;
    node.dataset.tone = tone || 'ok';
    node.querySelector('use').setAttribute('href', tone === 'bad' ? '#i-close' : '#i-check');
    node.hidden = false;

    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, tone === 'bad' ? 3600 : 2400);
    haptic(tone === 'bad' ? 'bad' : 'ok');
  }

  // Родное окно Telegram выглядит своим, а не браузерным
  function ask(text) {
    return new Promise((resolve) => {
      if (tg && tg.initData && typeof tg.showConfirm === 'function') {
        try {
          tg.showConfirm(text, (ok) => resolve(Boolean(ok)));
          return;
        } catch (_) {}
      }
      resolve(window.confirm(text));
    });
  }

  function busy(node, on) {
    if (!node) return;
    node.classList.toggle('is-busy', on);
    node.disabled = on;
  }

  // --- Сервер ---

  function initData() {
    let data = (tg && tg.initData) || '';
    if (!data) {
      try { data = sessionStorage.getItem('gg:initData') || ''; } catch (_) {}
    }
    return data;
  }

  class ApiError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  const ERRORS = {
    unauthorized: 'Сессия устарела — откройте админку заново из приложения',
    forbidden: 'У этого аккаунта нет доступа',
    'no-db': 'База не подключена',
    'no-auth': 'Не настроена подпись Telegram'
  };

  // Пока база не подключена, действия выполняет локальный двигатель: набор
  // и формат те же, поэтому экранам всё равно, куда они обращаются
  let offline = false;
  // Кошелёк для пополнений TON — его называет сервер
  let tonAddress = '';

  async function api(action, payload) {
    if (offline && window.Local) {
      const data = await window.Local.call(action, payload);
      if (data.content) content = data.content;
      return data;
    }

    let response;
    try {
      response = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: initData(), action: action, payload: payload || {} })
      });
    } catch (_) {
      throw new ApiError('network', 'Нет связи с сервером');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new ApiError(data.error || 'http', data.message || ERRORS[data.error] || 'Не получилось, попробуйте ещё раз');
    }

    if (data.content) content = data.content;
    if (data.tonAddress) tonAddress = data.tonAddress;
    return data;
  }

  // Сохранение с кнопкой: крутилка, уведомление, ошибка — одним вызовом
  async function run(node, action, payload, done) {
    busy(node, true);
    try {
      const data = await api(action, payload);
      if (done) done(data);
      return data;
    } catch (error) {
      toast(error.message, 'bad');
      if (error.code === 'unauthorized') showGate('expired');
      return null;
    } finally {
      busy(node, false);
    }
  }

  // --- Анимации ---

  const players = new Map();

  function whenLottie(go) {
    if (window.lottie) return go();
    const wait = () => (window.lottie ? go() : setTimeout(wait, 60));
    wait();
  }

  // Карточку оживляем, только когда она на экране: у скрытой нулевой размер
  function animate(box, source, loop) {
    whenLottie(() => {
      const start = () => {
        if (!box.isConnected || players.has(box)) return;
        const config = {
          container: box,
          renderer: 'canvas',
          loop: Boolean(loop),
          autoplay: true,
          rendererSettings: { dpr: Math.min(window.devicePixelRatio || 1, 2) }
        };
        if (source && typeof source === 'object') config.animationData = JSON.parse(JSON.stringify(source));
        else config.path = source;
        players.set(box, window.lottie.loadAnimation(config));
      };

      const watch = new IntersectionObserver((entries, obs) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        obs.disconnect();
        start();
      }, { rootMargin: '100px' });
      watch.observe(box);
    });
  }

  // Подарок рисует либо анимация lottie, либо картинка .svg
  function isStill(gift) {
    return Boolean(gift) && gift.artType === 'svg';
  }

  // Картинку показываем обычным <img> — ровно как витрина
  function showStill(box, path) {
    release(box);
    box.textContent = '';
    const img = el('img');
    img.src = path;
    img.alt = '';
    img.loading = 'lazy';
    img.draggable = false;
    box.appendChild(img);
  }

  function showArt(box, gift, loop) {
    if (isStill(gift)) showStill(box, gift.art);
    else if (gift.art) animate(box, gift.art, loop);
  }

  function release(root) {
    players.forEach((player, box) => {
      if (root && !root.contains(box)) return;
      player.destroy();
      players.delete(box);
    });
  }

  // --- Файлы ---

  function pickFile(accept) {
    return new Promise((resolve) => {
      picker.value = '';
      picker.accept = accept;
      picker.onchange = () => resolve(picker.files[0] || null);
      picker.click();
    });
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  let pakoReady = null;

  function loadPako() {
    if (!pakoReady) {
      pakoReady = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
        script.onload = () => resolve(window.pako);
        script.onerror = () => reject(new Error('pako'));
        document.head.appendChild(script);
      });
    }
    return pakoReady;
  }

  // .tgs — это json, пожатый gzip. Распаковываем только ради превью:
  // на сервер уходит исходный файл, он в десять раз меньше
  async function readTgs(file) {
    const buffer = await file.arrayBuffer();
    const head = new Uint8Array(buffer, 0, 2);
    let text;

    if (head[0] === 0x1f && head[1] === 0x8b) {
      if (typeof window.DecompressionStream === 'function') {
        const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
        text = await new Response(stream).text();
      } else {
        text = (await loadPako()).inflate(new Uint8Array(buffer), { to: 'string' });
      }
    } else {
      text = new TextDecoder().decode(buffer);
    }

    const data = JSON.parse(text);
    if (!data || !Array.isArray(data.layers)) throw new Error('not lottie');
    return { data: data, base64: toBase64(buffer) };
  }

  // .svg уходит на сервер как есть; для превью хватает ссылки на сам файл
  async function readSvg(file) {
    const buffer = await file.arrayBuffer();
    if (!/<svg[\s>]/i.test(new TextDecoder().decode(buffer))) throw new Error('not svg');
    return { base64: toBase64(buffer), url: URL.createObjectURL(file) };
  }

  // Картинку только открываем — остальное решает рамка кадрирования
  function readPicture(file) {
    const url = URL.createObjectURL(file);

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ img: img, url: url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('image'));
      };
      img.src = url;
    });
  }

  function dropTarget(node, onFile) {
    node.addEventListener('dragover', (event) => {
      event.preventDefault();
      node.dataset.over = 'true';
    });
    node.addEventListener('dragleave', () => { node.dataset.over = 'false'; });
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      node.dataset.over = 'false';
      const file = event.dataTransfer && event.dataTransfer.files[0];
      if (file) onFile(file);
    });
  }

  // --- Поля ---

  // Подписью-label оборачиваем только одно поле ввода: внутри label с
  // кнопками нажатие на подпись нажимало бы первую из них
  function field(label, control, wide) {
    const single = control.matches('input, textarea, select, .ad-affix');
    const wrap = el(single ? 'label' : 'div', 'ad-field' + (wide ? ' ad-field--wide' : ''));
    wrap.append(el('span', null, label), control);
    return wrap;
  }

  // Группа полей с подписью — так длинный лист читается по частям
  function group(title) {
    const box = el('section', 'ad-group');
    box.appendChild(el('h4', null, title));
    for (let i = 1; i < arguments.length; i += 1) box.appendChild(arguments[i]);
    return box;
  }

  function input(value, options) {
    const opts = options || {};
    const node = el('input', 'ad-input');
    node.type = opts.type || 'text';
    if (opts.type === 'number') {
      node.inputMode = 'numeric';
      node.min = '0';
    }
    if (opts.placeholder) node.placeholder = opts.placeholder;
    if (opts.max) node.maxLength = opts.max;
    node.value = value === undefined || value === null ? '' : String(value);
    return node;
  }

  function affix(control, iconName) {
    const wrap = el('span', 'ad-affix');
    if (iconName === 'star-img') {
      const img = el('img');
      img.src = 'gifts/star-white.png';
      img.alt = '';
      wrap.appendChild(img);
    } else {
      wrap.appendChild(icon(iconName));
    }
    wrap.appendChild(control);
    return wrap;
  }

  // − значение + с быстрыми надбавками под ним
  function stepper(value, steps) {
    const wrap = el('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '8px';

    const box = el('div', 'ad-stepper');
    const minus = el('button', null, '−');
    minus.type = 'button';
    const plus = el('button', null, '+');
    plus.type = 'button';
    const field = el('input');
    field.type = 'text';
    field.inputMode = 'numeric';
    field.value = num(value);

    const read = () => Math.max(0, parseInt(String(field.value).replace(/\D/g, ''), 10) || 0);
    const set = (next) => {
      field.value = num(Math.max(0, next));
      haptic('pick');
    };

    minus.addEventListener('click', () => set(read() - (steps[0] || 1)));
    plus.addEventListener('click', () => set(read() + (steps[0] || 1)));
    field.addEventListener('blur', () => { field.value = num(read()); });

    box.append(minus, field, plus);
    wrap.appendChild(box);

    if (steps.length > 1) {
      const quick = el('div', 'ad-quick');
      steps.slice(1).forEach((step) => {
        const chip = el('button', 'ad-chip', '+' + num(step));
        chip.type = 'button';
        chip.addEventListener('click', () => set(read() + step));
        quick.appendChild(chip);
      });
      const zero = el('button', 'ad-chip', 'Обнулить');
      zero.type = 'button';
      zero.addEventListener('click', () => set(0));
      quick.appendChild(zero);
      wrap.appendChild(quick);
    }

    wrap.read = read;
    return wrap;
  }

  function empty(iconName, title, text, action) {
    const box = el('div', 'ad-empty');
    const badge = el('span', 'ad-empty__icon');
    badge.appendChild(icon(iconName));
    box.append(badge, el('b', null, title));
    if (text) box.appendChild(el('p', null, text));
    if (action) box.appendChild(action);
    return box;
  }

  // --- Карточка подарка как на витрине ---

  // Тон и насыщенность из #rrggbb — так же, как их считает приложение
  function tintOf(hex) {
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

  function giftCard(gift, loop) {
    const card = el('article', 'gift tint-face');

    const art = el('div', 'gift__art');
    card.appendChild(art);
    showArt(art, gift, loop);

    const badge = el('span', 'gift__badge');
    badge.innerHTML = '<svg class="gift__ribbon" viewBox="-2 -2 124 36" aria-hidden="true"><use href="#ribbon-shape"></use></svg>';
    const label = el('span', 'gift__label');
    badge.appendChild(label);
    card.appendChild(badge);

    const price = el('span', 'gift__price');
    const star = el('img', 'gift__star');
    star.src = 'gifts/star.png';
    star.alt = '';
    const amount = el('span', 'gift__amount');
    price.append(star, amount);
    card.appendChild(price);

    card.paint = (next) => {
      label.textContent = next.badge || '';
      badge.hidden = !next.badge;
      badge.dataset.kind = next.kind || 'default';
      // Свой цвет перебивает цвет редкости
      if (next.tone) badge.style.setProperty('--ribbon-fill', next.tone);
      else badge.style.removeProperty('--ribbon-fill');
      amount.textContent = num(next.price);

      // Выбранная редкость красит карточку так же, как в приложении
      if (next.rarity) card.dataset.rarity = next.rarity;
      else delete card.dataset.rarity;

      // Фон: выбранный — тоном из него, не выбранный — нейтральный. В
      // приложении без выбора цвет снимается с самого подарка, а в админке
      // этого не посчитать, поэтому здесь он серый
      const hue = tintOf(next.bg);
      if (hue) {
        card.style.setProperty('--tint-h', String(hue.hue));
        card.style.setProperty('--tint-s', hue.sat + '%');
      } else {
        card.style.removeProperty('--tint-h');
        card.style.removeProperty('--tint-s');
      }
    };
    card.paint(gift);
    card.art = art;
    return card;
  }

  // --- Лист ---

  function openSheet(title, build, options) {
    const opts = options || {};
    release(sheetBody);
    sheetBody.textContent = '';
    sheetFoot.textContent = '';
    document.getElementById('sheet-title').textContent = title;
    sheetPanel.dataset.size = opts.wide ? 'wide' : '';

    build(sheetBody, sheetFoot);

    sheet.hidden = false;
    sheetClose = opts.onClose || null;
    document.body.style.overflow = 'hidden';
    sheetBody.scrollTop = 0;
  }

  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    release(sheetBody);
    sheetBody.textContent = '';
    sheetFoot.textContent = '';
    document.body.style.overflow = '';
    if (sheetClose) sheetClose();
    sheetClose = null;
  }

  sheet.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) closeSheet();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSheet();
  });

  // --- Навигация ---

  function setTop(title, sub, actions) {
    document.getElementById('top-title').textContent = title;
    document.getElementById('top-sub').textContent = sub || '';
    const acts = document.getElementById('top-acts');
    acts.textContent = '';
    (actions || []).forEach((node) => acts.appendChild(node));
  }

  function counts() {
    const set = (key, value) => {
      const node = document.querySelector('[data-count="' + key + '"]');
      if (node) node.textContent = value ? num(value) : '';
    };
    set('gifts', (content.gifts || []).length);
    set('banners', (content.banners || []).length);
    set('users', stats ? stats.users : 0);
  }

  function go(section) {
    if (SECTIONS.indexOf(section) < 0) section = 'gifts';
    current = section;

    try { sessionStorage.setItem(LAST_TAB, section); } catch (_) {}

    document.querySelectorAll('[data-go]').forEach((node) => {
      const on = node.dataset.go === section;
      node.classList.toggle('is-on', on);
      if (on) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    });

    release(view);
    view.textContent = '';

    RENDER[section]();
    counts();
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-go]');
    if (!link) return;
    event.preventDefault();
    haptic('pick');
    go(link.dataset.go);
  });

  async function refreshStats(node) {
    await run(node, 'stats', {}, (data) => {
      stats = data.stats;
      go(current);
      toast('Обновлено');
    });
  }

  function loading() {
    return el('p', 'ad-loading', 'Загружаем…');
  }

  function addTile(text, onClick) {
    const tile = el('button', 'ad-add');
    tile.type = 'button';
    const plus = el('span', 'ad-add__plus');
    plus.appendChild(icon('plus'));
    tile.append(plus, el('span', null, text));
    tile.addEventListener('click', onClick);
    return tile;
  }

  // --- Подарки ---

  let ordering = false;

  function renderGifts() {
    const gifts = content.gifts || [];

    const orderBtn = button(ordering ? 'Готово' : 'Порядок', {
      kind: ordering ? null : 'ghost',
      icon: ordering ? 'check' : 'swap',
      extra: 'ad-btn--top',
      onClick: () => {
        ordering = !ordering;
        haptic('pick');
        go('gifts');
      }
    });
    const add = button('Добавить', { icon: 'plus', extra: 'ad-btn--top', onClick: () => giftSheet(null) });

    setTop('Подарки', ordering ? 'Стрелками двигайте подарки на витрине' : num(gifts.length) + ' ' + plural(gifts.length, 'подарок', 'подарка', 'подарков') + ' на витрине', gifts.length > 1 ? (ordering ? [orderBtn] : [orderBtn, add]) : [add]);

    if (!gifts.length) {
      view.appendChild(empty('gift', 'Витрина пустая', 'Добавьте первый подарок — хватит файла .tgs или .svg и цены', button('Добавить подарок', { icon: 'plus', onClick: () => giftSheet(null) })));
      return;
    }

    const grid = el('div', 'ad-gifts');

    gifts.forEach((gift, index) => {
      const cell = el('div', 'ad-gift');
      const card = giftCard(gift);
      cell.appendChild(card);

      const meta = el('div', 'ad-gift__meta');
      meta.append(el('b', null, gift.name), el('span', null, 'осталось ' + num(gift.left) + ' из ' + num(gift.total)));
      cell.appendChild(meta);

      if (ordering) {
        const move = el('div', 'ad-gift__move');
        const left = iconButton('left', 'Раньше', () => moveGift(index, -1));
        const right = iconButton('right', 'Позже', () => moveGift(index, 1));
        left.disabled = index === 0;
        right.disabled = index === gifts.length - 1;
        move.append(left, right);
        cell.appendChild(move);
      } else {
        card.addEventListener('click', () => giftSheet(gift));
      }

      grid.appendChild(cell);
    });

    if (!ordering) grid.appendChild(addTile('Новый подарок', () => giftSheet(null)));
    view.appendChild(grid);
  }

  async function moveGift(index, shift) {
    const ids = (content.gifts || []).map((gift) => gift.id);
    const to = index + shift;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(index, 1)[0]);

    // Сразу показываем новый порядок, сервер догонит
    const byId = new Map(content.gifts.map((gift) => [gift.id, gift]));
    content.gifts = ids.map((id) => byId.get(id));
    haptic('pick');
    go('gifts');

    await run(null, 'gift.order', { ids: ids });
  }

  function giftSheet(gift) {
    const draft = Object.assign({ name: '', price: 299, badge: '', kind: 'blood', total: 1000, left: 1000, status: 'Non-Unique', artType: 'lottie', upgradePrice: 0 }, gift || {});
    // Модели улучшения правим в копии: «закрыть без сохранения» не должно их трогать
    draft.models = ((gift && gift.models) || []).map((one) => Object.assign({}, one));
    let upload = null;
    let previewUrl = '';

    openSheet(gift ? gift.name : 'Новый подарок', (body, foot) => {
      // Превью: карточка ровно как на витрине и поле для файла рядом
      const preview = el('div', 'ad-preview');
      const card = giftCard(draft, true);
      preview.appendChild(card);

      const drop = el('div', 'ad-drop');
      drop.append(icon('upload'), el('b', null, gift ? 'Заменить картинку' : 'Картинка подарка'), el('span', null, '.tgs или .svg — нажмите или перетащите'));
      preview.appendChild(drop);
      body.appendChild(preview);

      // Анимация и картинка живут рядом: по файлу и решаем, что пришло
      const take = async (file) => {
        const svg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';

        try {
          if (svg) {
            const read = await readSvg(file);
            if (previewUrl) URL.revokeObjectURL(previewUrl);
            previewUrl = read.url;
            upload = { base64: read.base64, kind: 'svg' };
            draft.artType = 'svg';
            showStill(card.art, read.url);
          } else {
            const parsed = await readTgs(file);
            upload = { base64: parsed.base64, kind: 'lottie' };
            draft.artType = 'lottie';
            release(card);
            card.art.textContent = '';
            animate(card.art, parsed.data, true);
          }

          drop.querySelector('b').textContent = file.name;
          drop.querySelector('span').textContent = 'готово — сохраните подарок';
          haptic('ok');
        } catch (_) {
          toast(svg ? 'Это не картинка .svg' : 'Это не .tgs и не анимация', 'bad');
        }
      };
      drop.addEventListener('click', () => pickFile('.tgs,.json,.svg,application/json,image/svg+xml').then((file) => file && take(file)));
      dropTarget(drop, take);

      const name = input(draft.name, { placeholder: 'Например, Grooby', max: 40 });
      const price = input(draft.price, { type: 'number' });
      const badge = input(draft.badge, { placeholder: 'Пусто — без ленты', max: 24 });
      const status = input(draft.status, { placeholder: 'Non-Unique', max: 24 });
      const total = input(draft.total, { type: 'number' });
      const left = input(draft.left, { type: 'number' });

      const main = el('div', 'ad-form');
      main.append(field('Название', name, true), field('Цена', affix(price, 'star-img')), field('Статус', status));
      body.appendChild(group('Основное', main));

      const stock = el('div', 'ad-form');
      stock.append(field('Выпущено всего', total), field('Осталось', left));
      body.appendChild(group('Тираж', stock));

      /* Лента. Образец задаёт цвет и отмечен всегда; свой цвет только
         перекрашивает ленту поверх него */
      const ribbonOf = (id) => RIBBONS.find((one) => one.id === (id || 'default')) || RIBBONS[0];
      const dots = el('div', 'ad-dots');

      const own = el('label', 'ad-dot ad-dot--own');
      own.title = 'Свой цвет';
      const tone = el('input');
      tone.type = 'color';
      tone.value = draft.tone || ribbonOf(draft.kind).from;
      own.appendChild(tone);

      const paintDots = () => {
        dots.querySelectorAll('[data-kind]').forEach((dot) => dot.setAttribute('aria-pressed', String(dot.dataset.kind === draft.kind)));
        own.setAttribute('aria-pressed', String(Boolean(draft.tone)));
        own.dataset.filled = String(Boolean(draft.tone));
        if (draft.tone) own.style.setProperty('--own', draft.tone);
      };

      RIBBONS.forEach((ribbon) => {
        const dot = el('button', 'ad-dot');
        dot.type = 'button';
        dot.dataset.kind = ribbon.id;
        dot.title = ribbon.name;
        dot.setAttribute('aria-label', ribbon.name);
        dot.style.background = 'linear-gradient(135deg, ' + ribbon.from + ', ' + ribbon.to + ')';
        dot.addEventListener('click', () => {
          draft.kind = ribbon.id;
          draft.tone = '';
          tone.value = ribbon.from;
          paintDots();
          card.paint(draft);
          haptic('pick');
        });
        dots.appendChild(dot);
      });
      dots.appendChild(own);

      tone.addEventListener('input', () => {
        draft.tone = tone.value;
        paintDots();
        card.paint(draft);
      });
      paintDots();

      body.appendChild(group('Лента',
        field('Текст', badge),
        field('Цвет', dots),
        el('p', 'ad-note', 'Радужный кружок — свой цвет.')
      ));

      // Карточка: редкость и фон
      const rarities = el('div', 'ad-quick');
      RARITIES.forEach((rarity) => {
        const chip = el('button', 'ad-chip');
        chip.type = 'button';
        const dot = el('i');
        dot.style.background = 'linear-gradient(180deg, ' + rarity.from + ', ' + rarity.to + ')';
        chip.append(dot, el('span', null, rarity.name));
        chip.setAttribute('aria-pressed', String((draft.rarity || '') === rarity.id));
        chip.addEventListener('click', () => {
          draft.rarity = rarity.id;
          rarities.querySelectorAll('.ad-chip').forEach((one) => one.setAttribute('aria-pressed', String(one === chip)));
          card.paint(draft);
          haptic('pick');
        });
        rarities.appendChild(chip);
      });

      /* Фон. «Авто» — приложение снимает цвет с самого подарка; свой —
         карточка и страница подарка красятся от него */
      const backs = el('div', 'ad-quick');
      const autoBack = el('button', 'ad-chip', 'Авто');
      autoBack.type = 'button';
      const ownBack = el('label', 'ad-dot ad-dot--own');
      ownBack.title = 'Свой фон';
      const back = el('input');
      back.type = 'color';
      back.value = draft.bg || '#6b5fb0';
      ownBack.appendChild(back);

      const paintBack = () => {
        autoBack.setAttribute('aria-pressed', String(!draft.bg));
        ownBack.setAttribute('aria-pressed', String(Boolean(draft.bg)));
        ownBack.dataset.filled = String(Boolean(draft.bg));
        if (draft.bg) ownBack.style.setProperty('--own', draft.bg);
      };
      autoBack.addEventListener('click', () => {
        draft.bg = '';
        paintBack();
        card.paint(draft);
        haptic('pick');
      });
      back.addEventListener('input', () => {
        draft.bg = back.value;
        paintBack();
        card.paint(draft);
      });
      paintBack();
      backs.append(autoBack, ownBack);

      body.appendChild(group('Карточка', field('Редкость', rarities), field('Фон', backs)));

      /* Улучшение, как у memgift: модели — варианты подарка (.svg или
         .tgs), из них при улучшении выпадает одна, с учётом шанса. Фон и
         символ выпадают из общих наборов memgift. Пока моделей нет, кнопка
         «Улучшить» у людей приглушена */
      const upPrice = input(draft.upgradePrice || 0, { type: 'number' });
      const models = el('div', 'ad-models');

      const drawModels = () => {
        release(models);
        models.textContent = '';
        draft.models.forEach((model, index) => {
          const row = el('div', 'ad-model');
          const thumb = el('span', 'ad-thumb');
          showArt(thumb, model, true);

          const nameIn = input(model.name, { placeholder: 'Название', max: 32 });
          nameIn.addEventListener('input', () => { model.name = nameIn.value; });

          const rateIn = input(model.rate || '', { placeholder: '%' });
          rateIn.inputMode = 'decimal';
          rateIn.classList.add('ad-model__rate');
          rateIn.addEventListener('input', () => {
            model.rate = Number(String(rateIn.value).replace(',', '.')) || 0;
          });

          row.append(thumb, nameIn, rateIn, iconButton('trash', 'Убрать модель', () => {
            draft.models.splice(index, 1);
            haptic('pick');
            drawModels();
          }, 'ad-icon--danger'));
          models.appendChild(row);
        });
      };
      drawModels();

      const addModel = el('button', 'ad-dashed');
      addModel.type = 'button';
      addModel.append(icon('plus'), el('span', null, 'Добавить модель — нажмите или перетащите .tgs / .svg'));
      // Файл можно выбрать или перетащить прямо на кнопку
      const takeModel = async (file) => {
        if (!file) return;
        const svg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';

        let read;
        try {
          read = svg ? await readSvg(file) : await readTgs(file);
        } catch (_) {
          toast(svg ? 'Это не картинка .svg' : 'Это не .tgs и не анимация', 'bad');
          return;
        }
        if (read.url) URL.revokeObjectURL(read.url);

        // Файл уходит на сервер сразу; в подарок он попадёт при сохранении
        const data = await run(addModel, 'model.upload', { file: read.base64, kind: svg ? 'svg' : 'lottie' });
        if (!data) return;
        draft.models.push({
          name: file.name.replace(/\.[^.]+$/, '').slice(0, 32),
          art: data.art,
          artType: data.artType,
          rate: 0
        });
        haptic('ok');
        drawModels();
      };
      addModel.addEventListener('click', () => pickFile('.tgs,.json,.svg,application/json,image/svg+xml').then(takeModel));
      dropTarget(addModel, takeModel);

      const upForm = el('div', 'ad-form');
      upForm.append(field('Цена улучшения', affix(upPrice, 'star-img'), true));
      body.appendChild(group('Улучшение',
        upForm,
        models,
        addModel,
        el('p', 'ad-note', 'Модель выпадает с учётом шанса в процентах; пусто — шанс у всех равный. Фон и символ выпадают случайно из наборов memgift. Цена 0 — улучшение бесплатное.')
      ));

      const sync = () => {
        draft.name = name.value;
        draft.price = Number(price.value) || 0;
        draft.badge = badge.value.trim();
        card.paint(draft);
      };
      [name, price, badge].forEach((node) => node.addEventListener('input', sync));

      if (gift) {
        foot.appendChild(button('Удалить', {
          kind: 'danger',
          icon: 'trash',
          onClick: async (event) => {
            if (!(await ask('Удалить «' + gift.name + '» с витрины? У тех, кому он выдан, он тоже пропадёт.'))) return;
            await run(event.currentTarget, 'gift.delete', { id: gift.id }, () => {
              closeSheet();
              toast('Подарок удалён');
              go('gifts');
            });
          }
        }));
      }

      foot.appendChild(button(gift ? 'Сохранить' : 'Добавить', {
        icon: 'check',
        onClick: async (event) => {
          sync();
          if (!name.value.trim()) {
            toast('Дайте подарку название', 'bad');
            name.focus();
            return;
          }
          if (!gift && !upload) {
            toast('Добавьте файл .tgs или .svg', 'bad');
            return;
          }

          const payload = {
            gift: {
              id: gift ? gift.id : undefined,
              art: gift ? gift.art : undefined,
              artType: draft.artType,
              name: name.value.trim(),
              price: Number(price.value) || 0,
              badge: badge.value.trim(),
              kind: draft.kind,
              rarity: draft.rarity || '',
              tone: draft.tone || '',
              bg: draft.bg || '',
              total: Number(total.value) || 0,
              left: Number(left.value) || 0,
              status: status.value.trim(),
              upgradePrice: Number(upPrice.value) || 0,
              models: draft.models
                .filter((one) => one.art)
                .map((one) => ({ id: one.id, name: String(one.name || '').trim() || 'Model', art: one.art, artType: one.artType, rate: one.rate || 0 }))
            },
            file: upload ? upload.base64 : undefined,
            kind: upload ? upload.kind : undefined
          };

          await run(event.currentTarget, 'gift.save', payload, () => {
            closeSheet();
            toast(gift ? 'Сохранено — уже на витрине' : 'Подарок на витрине');
            go('gifts');
          });
        }
      }));
    }, {
      wide: true,
      onClose: () => {
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
      }
    });
  }

  // --- Баннеры ---

  function renderBanners() {
    const banners = content.banners || [];
    setTop('Баннеры', banners.length ? 'Листаются на главной по кругу' : '', [
      button('Добавить', { icon: 'plus', extra: 'ad-btn--top', onClick: () => bannerSheet(null) })
    ]);

    if (!banners.length) {
      view.appendChild(empty('image', 'Баннеров нет', 'Карусель на главной спрячется, пока не добавите хотя бы один', button('Добавить баннер', { icon: 'plus', onClick: () => bannerSheet(null) })));
      return;
    }

    const list = el('div', 'ad-banners');

    banners.forEach((banner, index) => {
      const item = el('article', 'ad-banner-item');

      // Картинка — ровно как в карусели, без надписей поверх: на баннере
      // обычно уже нарисован свой текст
      const card = el('button', 'ad-banner');
      card.type = 'button';
      card.style.backgroundImage = 'url("' + banner.image + '")';
      card.setAttribute('aria-label', 'Изменить баннер «' + banner.label + '»');
      card.addEventListener('click', () => bannerSheet(banner));
      item.appendChild(card);

      const caption = el('div', 'ad-banner__caption');
      const text = el('div', 'ad-banner__text');
      text.append(el('b', null, banner.label), el('span', null, banner.href || 'без ссылки'));
      caption.appendChild(text);

      const acts = el('div', 'ad-banner__acts');
      const up = iconButton('up', 'Раньше', () => moveBanner(index, -1));
      const down = iconButton('down', 'Позже', () => moveBanner(index, 1));
      up.disabled = index === 0;
      down.disabled = index === banners.length - 1;
      acts.append(up, down, iconButton('edit', 'Изменить', () => bannerSheet(banner)));
      caption.appendChild(acts);
      item.appendChild(caption);

      list.appendChild(item);
    });

    view.appendChild(list);
  }

  async function moveBanner(index, shift) {
    const ids = (content.banners || []).map((banner) => banner.id);
    const to = index + shift;
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(index, 1)[0]);

    const byId = new Map(content.banners.map((banner) => [banner.id, banner]));
    content.banners = ids.map((id) => byId.get(id));
    haptic('pick');
    go('banners');

    await run(null, 'banner.order', { ids: ids });
  }

  // Кадрирование баннера.
  //
  // На главной слайд всегда 1392 × 518, а картинку приносят любую. Рамка
  // показывает ровно тот кусок, который попадёт в карусель: картинку внутри
  // двигают пальцем, приближают ползунком, и этот же кусок уходит на сервер.
  function bannerCrop() {
    let img = null;
    let objectUrl = '';
    let zoomValue = 1;
    // Середина кадра в долях картинки — от размера рамки не зависит и
    // переживает поворот телефона
    let cx = 0.5;
    let cy = 0.5;

    const wrap = el('div', 'ad-crop');

    const stage = el('div', 'ad-crop__stage');
    const pic = el('img', 'ad-crop__img');
    pic.alt = '';
    pic.draggable = false;
    pic.hidden = true;

    const pickBtn = el('button', 'ad-crop__pick');
    pickBtn.type = 'button';

    stage.append(pic, pickBtn);
    wrap.appendChild(stage);

    const tools = el('div', 'ad-crop__tools');
    const zoom = el('input', 'ad-crop__zoom');
    zoom.type = 'range';
    zoom.min = '1';
    zoom.max = String(CROP_MAX_ZOOM);
    zoom.step = '0.01';
    zoom.value = '1';
    zoom.setAttribute('aria-label', 'Приближение');
    tools.append(zoom, button('По центру', { kind: 'ghost', icon: 'refresh', onClick: center }));
    tools.hidden = true;
    wrap.appendChild(tools);

    // Подсказка нужна только над своей картинкой: сохранённый баннер уже
    // обрезан, двигать в нём нечего
    const note = el('p', 'ad-note', 'Видно ровно то, что попадёт в карусель: картинку можно двигать и приближать.');
    note.hidden = true;
    wrap.appendChild(note);

    function paintPick(filled) {
      pickBtn.textContent = '';
      pickBtn.append(icon('upload'), el('span', null, filled ? 'Заменить' : 'Выберите картинку · 1392 × 518'));
    }

    // Размеры картинки в рамке: «накрыть целиком» плюс приближение
    function size() {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      if (!img || !w || !h) return null;

      const base = Math.max(w / img.naturalWidth, h / img.naturalHeight);
      const k = base * zoomValue;
      return { w: w, h: h, rw: img.naturalWidth * k, rh: img.naturalHeight * k };
    }

    function layout() {
      const box = size();
      if (!box) return;

      // Край картинки не отходит от рамки: середина кадра не подходит к краю
      // ближе, чем на половину рамки
      const edgeX = box.w / 2 / box.rw;
      const edgeY = box.h / 2 / box.rh;
      cx = Math.min(Math.max(cx, edgeX), 1 - edgeX);
      cy = Math.min(Math.max(cy, edgeY), 1 - edgeY);

      pic.style.width = box.rw + 'px';
      pic.style.height = box.rh + 'px';
      pic.style.left = (box.w / 2 - cx * box.rw) + 'px';
      pic.style.top = (box.h / 2 - cy * box.rh) + 'px';
    }

    function center() {
      zoomValue = 1;
      zoom.value = '1';
      cx = 0.5;
      cy = 0.5;
      layout();
      haptic('pick');
    }

    function setZoom(next) {
      zoomValue = Math.min(CROP_MAX_ZOOM, Math.max(1, next));
      zoom.value = String(zoomValue);
      layout();
    }

    async function take(file) {
      if (!/^image\//.test(file.type)) {
        toast('Нужна картинка', 'bad');
        return;
      }

      let read;
      try {
        read = await readPicture(file);
      } catch (_) {
        toast('Картинка не читается', 'bad');
        return;
      }

      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = read.url;
      img = read.img;

      pic.src = read.url;
      pic.hidden = false;
      stage.style.backgroundImage = '';
      stage.dataset.filled = 'true';
      // Отметка «кадр свой» — по ней стили отдают рамке жест и курсор
      stage.dataset.dragging = 'false';
      tools.hidden = false;
      note.hidden = false;
      paintPick(true);
      center();
      haptic('ok');
    }

    // Сохранённый баннер уже обрезан — его просто показываем
    function show(url) {
      stage.style.backgroundImage = url ? 'url("' + url + '")' : '';
      stage.dataset.filled = String(Boolean(url));
      paintPick(Boolean(url));
    }

    pickBtn.addEventListener('click', () => pickFile('image/*').then((file) => file && take(file)));
    dropTarget(stage, take);
    zoom.addEventListener('input', () => setZoom(Number(zoom.value) || 1));

    stage.addEventListener('wheel', (event) => {
      if (!img) return;
      event.preventDefault();
      setZoom(zoomValue - event.deltaY * 0.0015);
    }, { passive: false });

    let pointerId = null;
    let lastX = 0;
    let lastY = 0;

    stage.addEventListener('pointerdown', (event) => {
      if (!img || pointerId !== null || event.target.closest('.ad-crop__pick')) return;

      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      stage.dataset.dragging = 'true';

      try {
        stage.setPointerCapture(pointerId);
      } catch (_) {}
    });

    stage.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;

      const box = size();
      if (!box) return;

      cx -= (event.clientX - lastX) / box.rw;
      cy -= (event.clientY - lastY) / box.rh;
      lastX = event.clientX;
      lastY = event.clientY;
      layout();
    });

    const drop = (event) => {
      if (event.pointerId !== pointerId) return;

      try {
        if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
      } catch (_) {}

      pointerId = null;
      stage.dataset.dragging = 'false';
    };

    stage.addEventListener('pointerup', drop);
    stage.addEventListener('pointercancel', drop);

    // Рамка тянется по ширине листа: при повороте телефона пересчитываем
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null;
    if (watch) watch.observe(stage);

    // Из рамки вырезаем тот самый кусок — уже в размере слайда
    async function read() {
      const box = size();
      if (!box) return null;

      const partX = Math.min(1, box.w / box.rw);
      const partY = Math.min(1, box.h / box.rh);
      const sw = partX * img.naturalWidth;
      const sh = partY * img.naturalHeight;
      const sx = Math.min(Math.max((cx - partX / 2) * img.naturalWidth, 0), img.naturalWidth - sw);
      const sy = Math.min(Math.max((cy - partY / 2) * img.naturalHeight, 0), img.naturalHeight - sh);

      // Мелкую картинку не растягиваем: больше исходника резкости не будет
      const width = Math.max(1, Math.min(BANNER_WIDTH, Math.round(sw)));
      const height = Math.max(1, Math.round((width * BANNER_HEIGHT) / BANNER_WIDTH));

      const canvas = el('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, width, height);

      const toBlob = (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
      let blob = await toBlob('image/webp', 0.86);
      if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.88);

      return { base64: toBase64(await blob.arrayBuffer()), type: blob.type };
    }

    paintPick(false);

    return {
      node: wrap,
      show: show,
      read: read,
      release: () => {
        if (watch) watch.disconnect();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = '';
        img = null;
      }
    };
  }

  function bannerSheet(banner) {
    const crop = bannerCrop();

    openSheet(banner ? 'Баннер' : 'Новый баннер', (body, foot) => {
      crop.show(banner ? banner.image : '');
      body.appendChild(crop.node);

      const label = input(banner ? banner.label : '', { placeholder: 'Например, Summer Collection', max: 60 });
      const href = input(banner ? banner.href : '', { placeholder: 'https://t.me/…', max: 300 });
      href.inputMode = 'url';

      const form = el('div', 'ad-form');
      form.append(field('Подпись', label, true), field('Ссылка по нажатию', affix(href, 'link'), true));
      body.appendChild(form);
      body.appendChild(el('p', 'ad-note', 'Ссылка необязательна. Ссылки на t.me открываются внутри Telegram, остальные — во встроенном браузере.'));

      if (banner) {
        foot.appendChild(button('Удалить', {
          kind: 'danger',
          icon: 'trash',
          onClick: async (event) => {
            if (!(await ask('Удалить этот баннер?'))) return;
            await run(event.currentTarget, 'banner.delete', { id: banner.id }, () => {
              closeSheet();
              toast('Баннер удалён');
              go('banners');
            });
          }
        }));
      }

      foot.appendChild(button(banner ? 'Сохранить' : 'Добавить', {
        icon: 'check',
        onClick: async (event) => {
          busy(event.currentTarget, true);
          let upload = null;
          try {
            upload = await crop.read();
          } catch (_) {
            busy(event.currentTarget, false);
            toast('Картинка не обрезалась', 'bad');
            return;
          }
          busy(event.currentTarget, false);

          if (!banner && !upload) {
            toast('Выберите картинку', 'bad');
            return;
          }

          const link = href.value.trim();
          if (link && !/^https:\/\//i.test(link) && !/^tg:\/\//i.test(link)) {
            toast('Ссылка должна начинаться с https://', 'bad');
            href.focus();
            return;
          }

          await run(event.currentTarget, 'banner.save', {
            banner: {
              id: banner ? banner.id : undefined,
              image: banner ? banner.image : undefined,
              label: label.value.trim(),
              href: link
            },
            file: upload ? upload.base64 : undefined,
            type: upload ? upload.type : undefined
          }, () => {
            closeSheet();
            toast(banner ? 'Баннер обновлён' : 'Баннер в карусели');
            go('banners');
          });
        }
      }));
    }, { onClose: crop.release });
  }

  // --- Люди ---

  const people = { query: '', items: [], total: 0, token: 0 };

  function avatar(person, big) {
    const ava = el('span', 'ad-ava' + (big ? ' ad-ava--big' : ''));
    const title = person.firstName || person.username || person.id;
    ava.textContent = String(title).charAt(0).toUpperCase();

    if (person.photo) {
      const img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = person.photo;
      img.onerror = () => img.remove();
      ava.appendChild(img);
    }
    return ava;
  }

  function nameOf(person) {
    const full = [person.firstName, person.lastName].filter(Boolean).join(' ');
    return full || (person.username ? '@' + person.username : 'id ' + person.id);
  }

  function nameLine(person, className) {
    const line = el('span', className);
    line.appendChild(el('span', null, nameOf(person)));
    if (person.tgPremium) line.appendChild(el('span', 'ad-badge', 'Premium'));
    return line;
  }

  function personRow(person) {
    const row = el('button', 'ad-person');
    row.type = 'button';

    const body = el('span', 'ad-person__body');
    body.append(
      nameLine(person, 'ad-person__name'),
      el('span', 'ad-person__sub', (person.username ? '@' + person.username + ' · ' : '') + person.id)
    );

    const side = el('span', 'ad-person__side');
    const stars = el('b');
    stars.append(icon('star'), document.createTextNode(num(person.stars)));
    side.append(stars, el('span', null, ago(person.lastSeen)));

    row.append(avatar(person), body, side);
    row.addEventListener('click', () => userSheet(person.id, (fresh) => {
      // Строку в списке обновляем на месте, без перезагрузки всего списка
      const next = personRow(fresh);
      row.replaceWith(next);
    }));
    return row;
  }

  function renderUsers() {
    setTop('Люди', '', [
      iconButton('refresh', 'Обновить', (event) => refreshStats(event.currentTarget), 'ad-icon--round')
    ]);

    const tiles = el('div', 'ad-stats');
    [
      [stats.users, 'всего'],
      [stats.fresh, 'новых за сутки'],
      [stats.active, 'были за сутки'],
      [stats.week, 'были за неделю']
    ].forEach((pair) => {
      const box = el('div', 'ad-stat');
      box.append(el('b', null, num(pair[0])), el('span', null, pair[1]));
      tiles.appendChild(box);
    });
    view.appendChild(tiles);

    const search = input(people.query, { placeholder: 'Имя, @username или id' });
    search.type = 'search';
    search.enterKeyHint = 'search';
    view.appendChild(affix(search, 'search'));

    const counter = el('p', 'ad-note');
    counter.id = 'people-count';
    view.appendChild(counter);

    const list = el('div', 'ad-list');
    list.id = 'people-list';
    view.appendChild(list);

    const more = button('Показать ещё', { kind: 'ghost', extra: 'ad-more' });
    more.id = 'people-more';
    more.hidden = true;
    more.addEventListener('click', () => loadPeople(false));
    view.appendChild(more);

    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        people.query = search.value.trim();
        loadPeople(true);
      }, 280);
    });

    loadPeople(true);
  }

  async function loadPeople(reset) {
    const list = document.getElementById('people-list');
    const more = document.getElementById('people-more');
    const counter = document.getElementById('people-count');
    if (!list) return;

    const token = ++people.token;

    if (reset) {
      people.items = [];
      list.textContent = '';
      list.appendChild(loading());
      more.hidden = true;
    } else {
      busy(more, true);
    }

    try {
      const data = await api('users.list', {
        query: people.query,
        offset: people.items.length,
        limit: USERS_PAGE
      });

      // Пока шёл ответ, запрос уже поменяли — этот устарел
      if (token !== people.token || !list.isConnected) return;

      if (reset) list.textContent = '';
      data.items.forEach((person) => list.appendChild(personRow(person)));
      people.items = people.items.concat(data.items);
      people.total = data.total;

      counter.textContent = people.query ? 'Найдено: ' + num(data.total) : '';

      if (!people.items.length) {
        list.appendChild(people.query
          ? empty('search', 'Никого не нашли', 'Попробуйте часть имени, @username или id')
          : empty('users', 'Пока никого', 'Люди появятся здесь, как только откроют приложение'));
      }

      more.hidden = people.items.length >= data.total;
    } catch (error) {
      if (token !== people.token) return;
      list.textContent = '';
      list.appendChild(empty('users', 'Не загрузилось', error.message));
    } finally {
      busy(more, false);
    }
  }

  async function userSheet(id, onSaved) {
    let person;
    try {
      person = (await api('user.get', { id: id })).user;
    } catch (error) {
      toast(error.message, 'bad');
      return;
    }

    const catalog = content.gifts || [];
    const byId = new Map(catalog.map((gift) => [gift.id, gift]));
    // Снятые с витрины подарки в счёте не показываем: при сохранении сервер
    // их всё равно отбросит, а сырой id в списке только путает
    const gifts = (person.gifts || []).filter((id) => byId.has(id));

    openSheet('Пользователь', (body, foot) => {
      // Шапка: кто это
      const who = el('div', 'ad-who');
      who.appendChild(avatar(person, true));
      who.appendChild(nameLine(person, 'ad-who__name'));

      const sub = el('div', 'ad-who__sub');
      if (person.username) {
        const open = el('button');
        open.type = 'button';
        open.append(document.createTextNode('@' + person.username), icon('link'));
        open.addEventListener('click', () => {
          const link = 'https://t.me/' + person.username;
          if (tg && tg.openTelegramLink && tg.initData) tg.openTelegramLink(link);
          else window.open(link, '_blank', 'noopener');
        });
        sub.appendChild(open);
      }
      const copy = el('button');
      copy.type = 'button';
      copy.append(document.createTextNode('id ' + person.id), icon('copy'));
      copy.addEventListener('click', () => {
        const done = () => toast('id скопирован');
        if (navigator.clipboard) navigator.clipboard.writeText(person.id).then(done, done);
      });
      sub.appendChild(copy);
      who.appendChild(sub);

      const facts = el('div', 'ad-facts');
      const fact = (label, value) => {
        const chip = el('span', 'ad-fact');
        chip.append(document.createTextNode(label + ' '), el('b', null, value));
        facts.appendChild(chip);
      };
      fact('с нами с', day(person.firstSeen));
      fact('заходил', ago(person.lastSeen));
      fact('заходов', num(person.visits || 0));
      who.appendChild(facts);
      body.appendChild(who);

      // Баланс
      const money = el('section', 'ad-card');
      money.appendChild(el('h3', null, 'Баланс'));
      const stars = stepper(person.stars, [1, 100, 500, 1000]);
      const coupons = stepper(person.coupons, [1, 5, 10, 50]);
      const grid = el('div', 'ad-form');
      grid.append(field('Звёзды', stars, true), field('Купоны', coupons, true));
      money.appendChild(grid);
      body.appendChild(money);

      // Подарки
      const owned = el('section', 'ad-card');
      const ownedHead = el('div', 'ad-card__head');
      const ownedTitle = el('h3');
      ownedHead.appendChild(ownedTitle);
      owned.appendChild(ownedHead);
      const ownedList = el('div', 'ad-owned');
      owned.appendChild(ownedList);

      const picker = el('div', 'ad-pick');
      picker.hidden = true;

      const giveBtn = el('button', 'ad-dashed');
      giveBtn.type = 'button';
      giveBtn.append(icon('gift'), el('span', null, 'Выдать подарок'));
      giveBtn.addEventListener('click', () => {
        picker.hidden = !picker.hidden;
        giveBtn.querySelector('span').textContent = picker.hidden ? 'Выдать подарок' : 'Скрыть каталог';
      });

      const drawOwned = () => {
        release(ownedList);
        ownedList.textContent = '';
        const counted = new Map();
        gifts.forEach((giftId) => counted.set(giftId, (counted.get(giftId) || 0) + 1));
        ownedTitle.textContent = 'Подарки · ' + num(gifts.length);

        if (!counted.size) {
          ownedList.appendChild(el('p', 'ad-note', 'Подарков нет'));
          return;
        }

        counted.forEach((count, giftId) => {
          const gift = byId.get(giftId);
          const row = el('div', 'ad-own');
          const thumb = el('span', 'ad-thumb');
          if (gift) showArt(thumb, gift);

          const name = el('span', 'ad-own__name');
          name.append(el('b', null, gift ? gift.name : giftId), el('span', null, gift ? num(gift.price) + ' ★' : 'снят с витрины'));

          const mini = el('div', 'ad-mini');
          mini.append(
            iconButton('trash', 'Забрать один', () => {
              gifts.splice(gifts.lastIndexOf(giftId), 1);
              haptic('pick');
              drawOwned();
            }),
            el('b', null, '×' + count),
            iconButton('plus', 'Ещё один', () => {
              gifts.push(giftId);
              haptic('pick');
              drawOwned();
            })
          );
          row.append(thumb, name, mini);
          ownedList.appendChild(row);
        });
      };

      catalog.forEach((gift) => {
        const item = el('button', 'ad-pick__item');
        item.type = 'button';
        const thumb = el('span', 'ad-thumb');
        showArt(thumb, gift);
        item.append(thumb, el('span', null, gift.name));
        item.addEventListener('click', () => {
          gifts.push(gift.id);
          haptic('ok');
          drawOwned();
        });
        picker.appendChild(item);
      });

      drawOwned();
      owned.append(giveBtn, picker);
      body.appendChild(owned);

      /* Подкрутка: следующее улучшение этого человека выпадет на чёрном
         фоне Eclipse. Срабатывает один раз и снимается сама; человек о ней
         не узнает — в его приложение она не уходит */
      let rig = person.rigBackdrop || '';
      const upgCard = el('section', 'ad-card');
      upgCard.appendChild(el('h3', null, 'Улучшение'));
      const rigBtn = el('button', 'ad-switch');
      rigBtn.type = 'button';
      const rigDot = el('i', 'ad-switch__dot');
      const rigText = el('span', 'ad-switch__text');
      rigText.append(el('b', null, 'Чёрный фон на следующем улучшении'), el('small', null, 'Eclipse · сработает один раз'));
      const rigToggle = el('span', 'ad-toggle');
      rigBtn.append(rigDot, rigText, rigToggle);
      const paintRig = () => rigBtn.setAttribute('aria-pressed', String(rig === 'Eclipse'));
      rigBtn.addEventListener('click', () => {
        rig = rig === 'Eclipse' ? '' : 'Eclipse';
        haptic('pick');
        paintRig();
      });
      paintRig();
      upgCard.appendChild(rigBtn);
      body.appendChild(upgCard);

      foot.appendChild(button('Сохранить', {
        icon: 'check',
        onClick: async (event) => {
          await run(event.currentTarget, 'user.save', {
            id: person.id,
            account: {
              stars: stars.read(),
              coupons: coupons.read(),
              gifts: gifts,
              rigBackdrop: rig
            }
          }, (data) => {
            closeSheet();
            toast('Сохранено');
            if (onSaved) onSaved(data.user);
          });
        }
      }));
    });
  }

  // --- Задания ---

  function renderTasks() {
    const groups = content.tasks || [];
    setTop('Задания', 'Видны на вкладке «Задания» в приложении', [
      button('Блок', { icon: 'plus', extra: 'ad-btn--top', onClick: addGroup })
    ]);

    if (!groups.length) {
      view.appendChild(empty('tasks', 'Заданий нет', 'Начните с блока — например, «Специальные»', button('Добавить блок', { icon: 'plus', onClick: addGroup })));
      return;
    }

    groups.forEach((group, groupIndex) => {
      const card = el('section', 'ad-card');

      const head = el('div', 'ad-card__head');
      const title = el('input', 'ad-title-input');
      title.value = group.title;
      title.maxLength = 40;
      title.setAttribute('aria-label', 'Название блока');
      title.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') title.blur();
      });
      title.addEventListener('change', () => {
        const tasks = copyTasks();
        tasks[groupIndex].title = title.value.trim() || 'Без названия';
        saveTasks(tasks, 'Название сохранено');
      });

      head.append(title, iconButton('trash', 'Удалить блок', async () => {
        if (!(await ask('Удалить блок «' + group.title + '» вместе с заданиями?'))) return;
        const tasks = copyTasks();
        tasks.splice(groupIndex, 1);
        saveTasks(tasks, 'Блок удалён', true);
      }, 'ad-icon--danger'));
      card.appendChild(head);

      const rows = el('div', 'ad-tasks');
      (group.items || []).forEach((task, taskIndex) => {
        const row = el('button', 'ad-task');
        row.type = 'button';

        const mark = el('span', 'ad-task__icon');
        mark.innerHTML = '<svg viewBox="0 0 14 16" aria-hidden="true"><use href="#task-gift"></use></svg>';

        const bodyNode = el('span', 'ad-task__body');
        const reward = el('span', 'ad-reward');
        reward.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><use href="#coupon"></use></svg>';
        reward.appendChild(document.createTextNode(num(task.reward) + ' ' + plural(task.reward, 'купон', 'купона', 'купонов')));
        bodyNode.append(el('b', null, task.name), reward);

        row.append(mark, bodyNode, el('span', 'ad-task__goal', task.type === 'link' ? 'ссылка' : '×' + num(task.goal)));
        row.addEventListener('click', () => taskSheet(groupIndex, taskIndex));
        rows.appendChild(row);
      });
      card.appendChild(rows);

      const add = el('button', 'ad-dashed');
      add.type = 'button';
      add.append(icon('plus'), el('span', null, 'Добавить задание'));
      add.addEventListener('click', () => taskSheet(groupIndex, -1));
      card.appendChild(add);

      view.appendChild(card);
    });
  }

  function copyTasks() {
    return JSON.parse(JSON.stringify(content.tasks || []));
  }

  async function saveTasks(tasks, message, redraw) {
    const data = await run(null, 'tasks.save', { tasks: tasks });
    if (data) {
      toast(message);
      if (redraw !== false) go('tasks');
    }
    return data;
  }

  function addGroup() {
    const tasks = copyTasks();
    tasks.push({ title: 'Новый блок', items: [] });
    saveTasks(tasks, 'Блок добавлен');
  }

  const TASK_TYPES = [
    ['link', 'Перейти по ссылке'],
    ['send', 'Отправить подарки'],
    ['buy', 'Купить подарки'],
    ['invite', 'Пригласить друзей']
  ];

  function taskSheet(groupIndex, taskIndex) {
    const group = (content.tasks || [])[groupIndex];
    const task = taskIndex >= 0 ? group.items[taskIndex] : null;

    openSheet(task ? 'Задание' : 'Новое задание', (body, foot) => {
      let type = (task && task.type) || 'link';
      const name = input(task ? task.name : '', { placeholder: 'Например, Подпишись на канал', max: 60 });
      const reward = stepper(task ? task.reward : 1, [1, 5, 10, 50]);
      const goal = stepper(task ? task.goal : 1, [1, 5, 10]);
      const url = input(task ? task.url : '', { placeholder: 'https://t.me/…', max: 300 });
      url.inputMode = 'url';

      // Тип задания: от него зависит, что считается выполнением
      const types = el('div', 'ad-quick');
      const urlField = field('Ссылка', affix(url, 'link'), true);
      const goalField = field('Сколько раз', goal, true);
      const paintType = () => {
        types.querySelectorAll('.ad-chip').forEach((chip) => chip.setAttribute('aria-pressed', String(chip.dataset.type === type)));
        urlField.hidden = type !== 'link';
        goalField.hidden = type === 'link';
      };
      TASK_TYPES.forEach(([id, label]) => {
        const chip = el('button', 'ad-chip', label);
        chip.type = 'button';
        chip.dataset.type = id;
        chip.addEventListener('click', () => {
          type = id;
          haptic('pick');
          paintType();
        });
        types.appendChild(chip);
      });

      const form = el('div', 'ad-form');
      form.append(field('Что нужно сделать', name, true), field('Тип', types, true), urlField, goalField, field('Награда в купонах', reward, true));
      body.appendChild(form);
      body.appendChild(el('p', 'ad-note', 'Ссылка: у человека кнопка «Начать» открывает её, потом «Забрать» — и купоны на счёт. Остальные типы засчитываются сами, когда набралось нужное число.'));
      paintType();

      if (task) {
        foot.appendChild(button('Удалить', {
          kind: 'danger',
          icon: 'trash',
          onClick: async (event) => {
            if (!(await ask('Удалить задание «' + task.name + '»?'))) return;
            const tasks = copyTasks();
            tasks[groupIndex].items.splice(taskIndex, 1);
            busy(event.currentTarget, true);
            const ok = await saveTasks(tasks, 'Задание удалено');
            if (ok) closeSheet();
          }
        }));
      }

      foot.appendChild(button(task ? 'Сохранить' : 'Добавить', {
        icon: 'check',
        onClick: async (event) => {
          if (!name.value.trim()) {
            toast('Напишите, что нужно сделать', 'bad');
            name.focus();
            return;
          }

          const link = url.value.trim();
          if (type === 'link' && !/^https:\/\//i.test(link) && !/^tg:\/\//i.test(link)) {
            toast('Ссылка должна начинаться с https://', 'bad');
            url.focus();
            return;
          }

          const tasks = copyTasks();
          const next = {
            id: task ? task.id : undefined,
            name: name.value.trim(),
            type: type,
            url: type === 'link' ? link : '',
            reward: reward.read(),
            goal: type === 'link' ? 1 : Math.max(1, goal.read())
          };
          if (task) tasks[groupIndex].items[taskIndex] = next;
          else tasks[groupIndex].items.push(next);

          busy(event.currentTarget, true);
          const ok = await saveTasks(tasks, task ? 'Задание сохранено' : 'Задание добавлено');
          busy(event.currentTarget, false);
          if (ok) closeSheet();
        }
      }));
    });
  }

  // --- Настройки ---

  function renderSettings() {
    setTop('Настройки', '');

    // Без общей базы правки остаются на этом устройстве — говорим прямо
    if (offline) {
      const note = el('section', 'ad-local');
      note.append(
        el('b', null, 'Общая база не подключена'),
        el('p', null, 'Правки и список людей живут только на этом устройстве.')
      );
      const steps = el('div', 'ad-steps');
      [
        ['db', 'База данных', 'Строка подключения — <code>DATABASE_URL</code> в ' + ENV_FILE + '.'],
        ['key', 'Подпись Telegram', '<code>BOT_TOKEN</code> в ' + ENV_FILE + ' — токен бота из @BotFather.'],
        ['refresh', 'Перезапуск', '<code>systemctl restart gapsgift</code> — после него админка сама перейдёт на базу.']
      ].forEach((item) => {
        const box = el('div', 'ad-step');
        const mark = el('span', 'ad-step__mark');
        mark.appendChild(icon(item[0]));
        const text = el('div');
        text.appendChild(el('b', null, item[1]));
        const p = el('p');
        p.innerHTML = item[2];
        text.appendChild(p);
        box.append(mark, text);
        steps.appendChild(box);
      });
      view.append(note, steps);
    }

    const cols = el('div', 'ad-cols');

    // Оплата TON: курс, по которому подарок продаётся за пополненный баланс
    const ton = el('section', 'ad-card');
    ton.appendChild(el('h3', null, 'Оплата TON'));
    ton.appendChild(el('p', 'ad-note', 'Сколько звёзд стоит 1 TON — по этому курсу подарок покупают с баланса. Ноль — оплата TON выключена.'));

    const tonForm = el('div', 'ad-form');
    const rate = input((content.ton && content.ton.rate) || 0, { type: 'number' });
    tonForm.appendChild(field('1 TON =', affix(rate, 'star-img'), true));
    ton.appendChild(tonForm);

    // Кошелёк для пополнений: целиком и копируется одним нажатием
    if (tonAddress) {
      const wallet = el('button', 'ad-wallet');
      wallet.type = 'button';
      wallet.append(el('span', null, 'Кошелёк для пополнений'), el('code', null, tonAddress));
      wallet.addEventListener('click', () => {
        const done = () => toast('Адрес скопирован');
        if (navigator.clipboard) navigator.clipboard.writeText(tonAddress).then(done, done);
      });
      ton.appendChild(wallet);
    }

    ton.appendChild(button('Сохранить', {
      icon: 'check',
      onClick: (event) => {
        const next = { rate: Math.max(0, parseInt(String(rate.value).replace(/\D/g, ''), 10) || 0) };
        run(event.currentTarget, 'ton.save', { ton: next }, () => toast('Курс сохранён'));
      }
    }));

    cols.appendChild(ton);

    view.appendChild(cols);

    const back = el('a', 'ad-btn ad-btn--ghost');
    back.href = 'index.html';
    back.append(icon('back'), el('span', null, 'Вернуться в приложение'));
    view.appendChild(back);
  }

  const RENDER = {
    gifts: renderGifts,
    banners: renderBanners,
    users: renderUsers,
    tasks: renderTasks,
    settings: renderSettings
  };

  // --- Вход ---

  function gateCard(iconName, title, text, extra) {
    const card = document.getElementById('gate-card');
    card.textContent = '';
    const mark = el('span', 'ad-gate__icon');
    mark.appendChild(icon(iconName));
    card.append(mark, el('h2', null, title));
    if (text) card.appendChild(el('p', 'ad-gate__text', text));
    if (extra) card.appendChild(extra);
    document.getElementById('gate').hidden = false;
    document.getElementById('ad').hidden = true;
  }

  function showGate(kind) {
    const back = el('a', 'ad-btn ad-btn--ghost');
    back.href = 'index.html';
    back.append(icon('back'), el('span', null, 'В приложение'));

    if (kind === 'expired') {
      gateCard('clock', 'Сессия устарела', 'Откройте админку заново из профиля в приложении.', back);
      return;
    }

    if (kind === 'outside') {
      gateCard('shield', 'Откройте из Telegram', 'Админка работает только внутри приложения: так сервер узнаёт, что это вы.', back);
      return;
    }

    if (kind === 'network') {
      const again = button('Повторить', { icon: 'refresh', onClick: () => start() });
      gateCard('pulse', 'Нет связи с сервером', 'Проверьте интернет и попробуйте ещё раз.', again);
      return;
    }

    gateCard('shield', 'Нет доступа', 'Эта страница только для администратора.', back);
  }

  async function start() {
    document.getElementById('gate-card').innerHTML = '<span class="ad-spinner" aria-hidden="true"></span><p class="ad-gate__text">Проверяем доступ…</p>';

    if (tg) {
      try {
        tg.ready();
        tg.expand();
        tg.setHeaderColor('#0b0b0e');
        tg.setBackgroundColor('#0b0b0e');
      } catch (_) {}

      // Системная «назад»: закрывает лист, а без листа — возвращает в приложение
      if (tg.BackButton) {
        try {
          tg.BackButton.show();
          tg.BackButton.onClick(() => {
            if (!sheet.hidden) closeSheet();
            else location.href = 'index.html';
          });
        } catch (_) {}
      }
    }

    let status;
    try {
      status = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'status' })
      }).then((response) => response.json());
    } catch (_) {
      showGate('network');
      return;
    }

    // Без базы админка работает локально: так проект можно проверить
    // целиком, а подключение остаётся следующим шагом
    offline = !status.db || !status.auth;

    if (!offline && !initData()) {
      showGate('outside');
      return;
    }

    try {
      const data = await api('session');
      stats = data.stats;
      me = data.me || (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    } catch (error) {
      if (error.code === 'unauthorized') showGate('expired');
      else if (error.code === 'network') showGate('network');
      else showGate('forbidden');
      return;
    }

    document.getElementById('gate').hidden = true;
    document.getElementById('ad').hidden = false;

    let last = 'gifts';
    try { last = sessionStorage.getItem(LAST_TAB) || 'gifts'; } catch (_) {}
    go(last);
  }

  start();
})();
