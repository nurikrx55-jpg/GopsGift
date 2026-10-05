/* Админка: подарки, баннеры, люди, задания и час открытия маркета.

   Правка идёт в хранилище и сразу видна в приложении на этом устройстве.
   Чтобы её увидели остальные, админка отдаёт готовый content.json со всеми
   вложениями — его публикуют вместе с сайтом. */
(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp;
  // Текст плашки свой у каждого подарка, а цвет берётся из набора лент
  const KINDS = [
    { id: 'blood', name: 'Красная' },
    { id: 'legend', name: 'Жёлтая' },
    { id: 'premium', name: 'Премиум' },
    { id: 'epic', name: 'Фиолетовая' },
    { id: 'rare', name: 'Зелёная' },
    { id: 'time', name: 'Сиреневая' },
    { id: 'sold', name: 'Бордовая' },
    { id: 'default', name: 'Серая' }
  ];

  const gate = document.getElementById('gate');
  const gateText = document.getElementById('gate-text');
  const root = document.getElementById('adm');
  const sheet = document.getElementById('sheet');
  const sheetForm = document.getElementById('sheet-form');
  const sheetBody = document.getElementById('sheet-body');
  const sheetTitle = document.getElementById('sheet-title');
  const picker = document.getElementById('picker');

  let onSubmit = null;
  let toastTimer = null;

  // --- Мелочи ---

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(path, title, kind) {
    const button = el('button', 'adm-icon' + (kind ? ' adm-icon--' + kind : ''));
    button.type = 'button';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';
    return button;
  }

  const ICONS = {
    edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    up: '<path d="m7 14 5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    down: '<path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  };

  function toast(text) {
    const node = document.getElementById('toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
  }

  function number(value, fallback) {
    const parsed = parseInt(String(value).replace(/\s/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function slug(name) {
    const base = String(name).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return (base || 'item') + '-' + Math.random().toString(36).slice(2, 6);
  }

  function markDirty() {
    const label = document.getElementById('adm-state');
    const dirty = Store.dirty();
    label.textContent = dirty ? 'есть неопубликованные правки' : 'всё опубликовано';
    label.dataset.dirty = String(dirty);
  }

  function save(change) {
    const ok = Store.update(change);
    if (!ok) toast('Не хватило места — правка не сохранилась');
    markDirty();
    return ok;
  }

  // --- Поля формы ---

  function field(label, input) {
    const wrap = el('label', 'adm-field');
    wrap.append(el('span', null, label), input);
    return wrap;
  }

  function text(value, placeholder) {
    const input = el('input');
    input.type = 'text';
    input.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) input.placeholder = placeholder;
    return input;
  }

  function digits(value) {
    const input = el('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.value = value === undefined || value === null ? '' : String(value);
    return input;
  }

  function select(options, value) {
    const node = el('select');
    options.forEach((option) => {
      const item = el('option', null, option.name);
      item.value = option.id;
      if (option.id === value) item.selected = true;
      node.appendChild(item);
    });
    return node;
  }

  function check(label, value) {
    const wrap = el('label', 'adm-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = Boolean(value);
    wrap.append(input, el('span', null, label));
    wrap.input = input;
    return wrap;
  }

  // --- Разбор формы ---

  function openSheet(title, build, submit) {
    sheetTitle.textContent = title;
    sheetBody.textContent = '';
    build(sheetBody);
    onSubmit = submit;
    sheet.hidden = false;
  }

  function closeSheet() {
    sheet.hidden = true;
    onSubmit = null;
    sheetBody.textContent = '';
  }

  sheet.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) closeSheet();
  });

  sheetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (onSubmit && onSubmit() !== false) closeSheet();
  });

  // --- Файлы ---

  // .tgs — это пожатый gzip-ом json. Родной распаковщик есть не везде,
  // поэтому на старых webview подключаем pako.
  function unpack(buffer) {
    const head = new Uint8Array(buffer, 0, 2);
    const gzipped = head[0] === 0x1f && head[1] === 0x8b;

    if (!gzipped) {
      return Promise.resolve(JSON.parse(new TextDecoder().decode(buffer)));
    }

    if (typeof window.DecompressionStream === 'function') {
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text().then(JSON.parse);
    }

    return loadPako().then((pako) =>
      JSON.parse(pako.inflate(new Uint8Array(buffer), { to: 'string' }))
    );
  }

  let pakoReady = null;

  function loadPako() {
    if (pakoReady) return pakoReady;

    pakoReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js';
      script.onload = () => resolve(window.pako);
      script.onerror = () => reject(new Error('pako не загрузился'));
      document.head.appendChild(script);
    });

    return pakoReady;
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      picker.value = '';
      picker.accept = accept;
      picker.onchange = () => resolve(picker.files[0] || null);
      picker.click();
    });
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // Поле, в которое кладут файл — и перетаскиванием, и выбором
  function dropZone(hint, accept, handle) {
    const zone = el('div', 'adm-drop');
    const art = el('div', 'adm-drop__art');
    const label = el('b', null, hint);
    const note = el('span', null, 'нажмите или перетащите файл');
    zone.append(art, label, note);

    const take = (file) => {
      if (!file) return;
      label.textContent = file.name;
      handle(file, art);
    };

    zone.addEventListener('click', () => pickFile(accept).then(take));
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.dataset.over = 'true';
    });
    zone.addEventListener('dragleave', () => { zone.dataset.over = 'false'; });
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.dataset.over = 'false';
      take(event.dataTransfer.files[0]);
    });

    zone.art = art;
    zone.label = label;
    return zone;
  }

  // lottie дописывает в переданный объект свои служебные поля, в том числе
  // функции. Показываем копию, иначе исходник станет непригоден для базы.
  function preview(box, animationData) {
    box.textContent = '';
    if (!window.lottie || !animationData) return;

    window.lottie.loadAnimation({
      container: box,
      renderer: 'canvas',
      loop: true,
      autoplay: true,
      animationData: JSON.parse(JSON.stringify(animationData)),
      rendererSettings: { dpr: 1 }
    });
  }

  // --- Подарки ---

  function giftForm(gift, done) {
    let art = gift ? gift.art : null;
    let packed = null;

    openSheet(gift ? 'Подарок' : 'Новый подарок', (body) => {
      const zone = dropZone(gift ? 'Заменить анимацию' : 'Анимация .tgs или .json', '.tgs,.json,application/json', (file, box) => {
        file.arrayBuffer()
          .then(unpack)
          .then((data) => {
            packed = data;
            preview(box, data);
            toast('Анимация прочитана');
          })
          .catch(() => toast('Файл не похож на .tgs или .json'));
      });

      body.appendChild(zone);

      if (gift) {
        Store.resolveArt(gift.art).then((source) => {
          if (!source) return;
          if (source.animationData) preview(zone.art, source.animationData);
          else if (window.lottie) {
            window.lottie.loadAnimation({
              container: zone.art, renderer: 'canvas', loop: true,
              autoplay: true, path: source.path, rendererSettings: { dpr: 1 }
            });
          }
        });
      }

      const name = text(gift ? gift.name : '', 'Название');
      const price = digits(gift ? gift.price : 299);
      const badge = text(gift ? gift.badge : '', 'Текст плашки');
      const kind = select(KINDS, gift ? gift.kind : 'blood');
      const total = digits(gift ? gift.total : 1000);
      const left = digits(gift ? gift.left : 1000);
      const status = text(gift ? gift.status : 'Non-Unique', 'Статус');

      const grid = el('div', 'adm-grid');
      grid.append(
        field('Название', name),
        field('Цена в звёздах', price),
        field('Плашка', badge),
        field('Цвет плашки', kind),
        field('Всего выпущено', total),
        field('Осталось', left),
        field('Статус', status)
      );
      body.appendChild(grid);

      body.fields = { name, price, badge, kind, total, left, status };
    }, () => {
      const f = sheetBody.fields;

      if (!f.name.value.trim()) {
        toast('Без названия подарок не сохранить');
        return false;
      }

      if (!packed && !art) {
        toast('Нужна анимация');
        return false;
      }

      const id = gift ? gift.id : slug(f.name.value);

      const finish = (ref) => {
        const next = {
          id: id,
          name: f.name.value.trim(),
          art: ref,
          price: number(f.price.value, 0),
          badge: f.badge.value.trim(),
          kind: f.kind.value,
          left: number(f.left.value, 0),
          total: number(f.total.value, 0),
          status: f.status.value.trim() || 'Non-Unique'
        };

        save((state) => {
          state.gifts = state.gifts || [];
          const at = state.gifts.findIndex((one) => one.id === id);
          if (at === -1) state.gifts.push(next);
          else state.gifts[at] = next;
          return state;
        });

        done();
        toast('Подарок сохранён');
      };

      if (packed) {
        // Старое вложение больше не нужно — место в базе не бесконечное
        const stale = art && art.indexOf(Store.ASSET_PREFIX) === 0 ? art : null;
        Store.putAsset('gift-' + id, 'lottie', packed).then((ref) => {
          if (stale && stale !== ref) Store.dropAsset(stale);
          finish(ref);
        });
      } else {
        finish(art);
      }

      return true;
    });
  }

  function renderGifts() {
    const list = document.getElementById('gift-list');
    const gifts = Store.state().gifts || [];
    list.textContent = '';

    if (!gifts.length) {
      list.appendChild(el('div', 'adm-empty', 'Подарков пока нет'));
      return;
    }

    gifts.forEach((gift, index) => {
      const row = el('div', 'adm-item');
      const art = el('div', 'adm-item__art');

      Store.resolveArt(gift.art).then((source) => {
        if (!source || !window.lottie) return;
        window.lottie.loadAnimation(Object.assign({
          container: art, renderer: 'canvas', loop: true, autoplay: true,
          rendererSettings: { dpr: 1 }
        }, source.animationData ? { animationData: source.animationData } : { path: source.path }));
      });

      const body = el('div', 'adm-item__body');
      body.append(
        el('div', 'adm-item__name', gift.name),
        el('div', 'adm-item__meta',
          gift.price + ' ★ · ' + (gift.badge || 'без плашки') + ' · ' +
          gift.left + ' из ' + gift.total)
      );

      const acts = el('div', 'adm-item__acts');

      const up = icon(ICONS.up, 'Выше');
      up.disabled = index === 0;
      up.addEventListener('click', () => move('gifts', index, -1, renderGifts));

      const down = icon(ICONS.down, 'Ниже');
      down.disabled = index === gifts.length - 1;
      down.addEventListener('click', () => move('gifts', index, 1, renderGifts));

      const edit = icon(ICONS.edit, 'Изменить');
      edit.addEventListener('click', () => giftForm(gift, renderGifts));

      const drop = icon(ICONS.trash, 'Удалить', 'danger');
      drop.addEventListener('click', () => {
        if (!confirm('Удалить «' + gift.name + '»?')) return;

        Store.dropAsset(gift.art);
        save((state) => {
          state.gifts = (state.gifts || []).filter((one) => one.id !== gift.id);
          // Выданные копии тоже убираем, иначе в профиле останется пустота
          Object.keys(state.users || {}).forEach((key) => {
            const person = state.users[key];
            if (Array.isArray(person.gifts)) {
              person.gifts = person.gifts.filter((one) => one !== gift.id);
            }
          });
          if (Array.isArray(state.defaults && state.defaults.gifts)) {
            state.defaults.gifts = state.defaults.gifts.filter((one) => one !== gift.id);
          }
          return state;
        });

        renderGifts();
        toast('Подарок удалён');
      });

      acts.append(up, down, edit, drop);
      row.append(art, body, acts);
      list.appendChild(row);
    });
  }

  function move(key, index, shift, redraw) {
    save((state) => {
      const list = state[key] || [];
      const to = index + shift;
      if (to < 0 || to >= list.length) return state;
      const [item] = list.splice(index, 1);
      list.splice(to, 0, item);
      return state;
    });
    redraw();
  }

  // --- Баннеры ---

  function bannerForm(banner, done) {
    let image = banner ? banner.image : null;
    let incoming = null;

    openSheet(banner ? 'Баннер' : 'Новый баннер', (body) => {
      const zone = dropZone(banner ? 'Заменить картинку' : 'Картинка баннера', 'image/*', (file, box) => {
        readImage(file).then((url) => {
          incoming = url;
          box.textContent = '';
          const img = el('img');
          img.src = url;
          box.appendChild(img);
        });
      });
      body.appendChild(zone);

      if (banner) {
        Store.resolveImage(banner.image).then((url) => {
          if (!url) return;
          zone.art.textContent = '';
          const img = el('img');
          img.src = url;
          zone.art.appendChild(img);
        });
      }

      const label = text(banner ? banner.label : '', 'Подпись');
      const href = text(banner ? banner.href : '', 'Ссылка, если нужна');

      const grid = el('div', 'adm-grid');
      grid.append(field('Подпись', label), field('Ссылка', href));
      body.appendChild(grid);

      body.fields = { label, href };
    }, () => {
      const f = sheetBody.fields;

      if (!incoming && !image) {
        toast('Нужна картинка');
        return false;
      }

      const id = banner ? banner.id : slug(f.label.value || 'banner');

      const finish = (ref) => {
        const next = {
          id: id,
          image: ref,
          label: f.label.value.trim() || 'Баннер',
          href: f.href.value.trim()
        };

        save((state) => {
          state.banners = state.banners || [];
          const at = state.banners.findIndex((one) => one.id === id);
          if (at === -1) state.banners.push(next);
          else state.banners[at] = next;
          return state;
        });

        done();
        toast('Баннер сохранён');
      };

      if (incoming) {
        const stale = image && image.indexOf(Store.ASSET_PREFIX) === 0 ? image : null;
        Store.putAsset('banner-' + id, 'image', incoming).then((ref) => {
          if (stale && stale !== ref) Store.dropAsset(stale);
          finish(ref);
        });
      } else {
        finish(image);
      }

      return true;
    });
  }

  function renderBanners() {
    const list = document.getElementById('banner-list');
    const banners = Store.state().banners || [];
    list.textContent = '';

    if (!banners.length) {
      list.appendChild(el('div', 'adm-empty', 'Баннеров пока нет'));
      return;
    }

    banners.forEach((banner, index) => {
      const row = el('div', 'adm-item');
      const art = el('div', 'adm-item__art');

      Store.resolveImage(banner.image).then((url) => {
        if (!url) return;
        const img = el('img');
        img.src = url;
        art.appendChild(img);
      });

      const body = el('div', 'adm-item__body');
      body.append(
        el('div', 'adm-item__name', banner.label || 'Баннер'),
        el('div', 'adm-item__meta', banner.href || 'без ссылки')
      );

      const acts = el('div', 'adm-item__acts');

      const up = icon(ICONS.up, 'Выше');
      up.disabled = index === 0;
      up.addEventListener('click', () => move('banners', index, -1, renderBanners));

      const down = icon(ICONS.down, 'Ниже');
      down.disabled = index === banners.length - 1;
      down.addEventListener('click', () => move('banners', index, 1, renderBanners));

      const edit = icon(ICONS.edit, 'Изменить');
      edit.addEventListener('click', () => bannerForm(banner, renderBanners));

      const drop = icon(ICONS.trash, 'Удалить', 'danger');
      drop.addEventListener('click', () => {
        if (!confirm('Удалить баннер?')) return;
        Store.dropAsset(banner.image);
        save((state) => {
          state.banners = (state.banners || []).filter((one) => one.id !== banner.id);
          return state;
        });
        renderBanners();
        toast('Баннер удалён');
      });

      acts.append(up, down, edit, drop);
      row.append(art, body, acts);
      list.appendChild(row);
    });
  }

  // --- Люди ---

  function giftPills(chosen, onToggle) {
    const box = el('div', 'adm-pills');
    const gifts = Store.state().gifts || [];

    if (!gifts.length) {
      box.appendChild(el('span', 'adm-note', 'Сначала добавьте подарки'));
      return box;
    }

    gifts.forEach((gift) => {
      const pill = el('button', 'adm-pill');
      pill.type = 'button';
      const count = chosen.filter((one) => one === gift.id).length;

      pill.setAttribute('aria-pressed', String(count > 0));
      pill.append(el('span', null, gift.name));
      if (count > 1) pill.appendChild(el('span', 'adm-count', '×' + count));

      pill.addEventListener('click', () => onToggle(gift.id));
      box.appendChild(pill);
    });

    return box;
  }

  function personForm(id, done) {
    const state = Store.state();
    const saved = (state.users || {})[id] || {};
    let chosen = Array.isArray(saved.gifts)
      ? saved.gifts.slice()
      : ((state.defaults && state.defaults.gifts) || []).slice();

    openSheet('Пользователь ' + id, (body) => {
      const name = text(saved.name || '', 'Ник вместо телеграмного');
      const alias = text(saved.alias || '', 'Подменный id');
      const stars = digits(saved.stars !== undefined ? saved.stars : 0);
      const coupons = digits(saved.coupons !== undefined ? saved.coupons : 0);
      const gold = check('Золотой ник', saved.gold);
      const verified = check('Галочка после ника', saved.verified);

      const grid = el('div', 'adm-grid');
      grid.append(
        field('Ник', name),
        field('Подменный id', alias),
        field('Звёзды', stars),
        field('Купоны', coupons)
      );
      body.append(grid, gold, verified);

      body.append(el('p', 'adm-note', 'Подарки: нажатие выдаёт ещё одну копию, долгое нажатие — убирает все.'));

      const pills = el('div');
      const redraw = () => {
        pills.textContent = '';
        pills.appendChild(giftPills(chosen, (giftId) => {
          chosen.push(giftId);
          redraw();
        }));

        Array.from(pills.querySelectorAll('.adm-pill')).forEach((pill, index) => {
          const gift = (Store.state().gifts || [])[index];
          if (!gift) return;
          pill.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            chosen = chosen.filter((one) => one !== gift.id);
            redraw();
          });
        });
      };
      redraw();
      body.appendChild(pills);

      const clear = el('button', 'adm-btn adm-btn--ghost adm-btn--small', 'Забрать все подарки');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        chosen = [];
        redraw();
      });
      body.appendChild(clear);

      body.fields = { name, alias, stars, coupons, gold: gold.input, verified: verified.input };
    }, () => {
      const f = sheetBody.fields;

      save((next) => {
        next.users = next.users || {};
        next.users[id] = {
          name: f.name.value.trim(),
          alias: f.alias.value.trim(),
          gold: f.gold.checked,
          verified: f.verified.checked,
          stars: number(f.stars.value, 0),
          coupons: number(f.coupons.value, 0),
          gifts: chosen
        };
        return next;
      });

      done();
      toast('Сохранено');
      return true;
    });
  }

  function renderPeople() {
    const state = Store.state();
    const list = document.getElementById('person-list');
    const users = state.users || {};
    list.textContent = '';

    const form = document.getElementById('defaults-form');
    form.textContent = '';

    const defaults = state.defaults || {};
    const stars = digits(defaults.stars || 0);
    const coupons = digits(defaults.coupons || 0);

    const commit = () => {
      save((next) => {
        next.defaults = next.defaults || {};
        next.defaults.stars = number(stars.value, 0);
        next.defaults.coupons = number(coupons.value, 0);
        return next;
      });
    };

    stars.addEventListener('change', commit);
    coupons.addEventListener('change', commit);

    form.append(field('Звёзды', stars), field('Купоны', coupons));

    const pills = el('div');
    const redrawPills = () => {
      pills.textContent = '';
      const chosen = (Store.state().defaults || {}).gifts || [];
      pills.appendChild(giftPills(chosen, (giftId) => {
        save((next) => {
          next.defaults = next.defaults || {};
          const has = (next.defaults.gifts || []).indexOf(giftId) !== -1;
          next.defaults.gifts = has
            ? next.defaults.gifts.filter((one) => one !== giftId)
            : (next.defaults.gifts || []).concat(giftId);
          return next;
        });
        redrawPills();
      }));
    };
    redrawPills();

    const wrap = el('div', 'adm-field');
    wrap.append(el('span', null, 'Подарки каждому'), pills);
    form.appendChild(wrap);

    const ids = Object.keys(users);
    if (!ids.length) {
      list.appendChild(el('div', 'adm-empty', 'Отдельных записей пока нет'));
      return;
    }

    ids.forEach((id) => {
      const person = users[id];
      const row = el('div', 'adm-item');

      const art = el('div', 'adm-item__art');
      art.style.display = 'grid';
      art.style.placeItems = 'center';
      art.style.fontSize = '20px';
      art.textContent = (person.name || id).replace('@', '').charAt(0).toUpperCase();

      const marks = [];
      if (person.gold) marks.push('золотой ник');
      if (person.verified) marks.push('галочка');
      marks.push(person.stars + ' ★');
      marks.push((person.gifts || []).length + ' под.');

      const body = el('div', 'adm-item__body');
      body.append(
        el('div', 'adm-item__name', (person.name || 'Без ника') + ' · ' + id),
        el('div', 'adm-item__meta', marks.join(' · '))
      );

      const acts = el('div', 'adm-item__acts');

      const edit = icon(ICONS.edit, 'Изменить');
      edit.addEventListener('click', () => personForm(id, renderPeople));

      const drop = icon(ICONS.trash, 'Удалить запись', 'danger');
      drop.addEventListener('click', () => {
        if (!confirm('Удалить запись ' + id + '? Человек станет обычным.')) return;
        save((next) => {
          delete next.users[id];
          return next;
        });
        renderPeople();
      });

      acts.append(edit, drop);
      row.append(art, body, acts);
      list.appendChild(row);
    });
  }

  // --- Задания ---

  function taskForm(groupIndex, task, done) {
    openSheet(task ? 'Задание' : 'Новое задание', (body) => {
      const name = text(task ? task.name : '', 'Что нужно сделать');
      const reward = digits(task ? task.reward : 1);
      const goal = digits(task ? task.goal : 1);

      const grid = el('div', 'adm-grid');
      grid.append(field('Название', name), field('Награда в купонах', reward), field('Сколько нужно', goal));
      body.appendChild(grid);
      body.fields = { name, reward, goal };
    }, () => {
      const f = sheetBody.fields;
      if (!f.name.value.trim()) {
        toast('Нужно название');
        return false;
      }

      const next = {
        id: task ? task.id : slug(f.name.value),
        name: f.name.value.trim(),
        reward: number(f.reward.value, 0),
        goal: number(f.goal.value, 1)
      };

      save((state) => {
        const group = state.tasks[groupIndex];
        group.items = group.items || [];
        const at = task ? group.items.findIndex((one) => one.id === task.id) : -1;
        if (at === -1) group.items.push(next);
        else group.items[at] = next;
        return state;
      });

      done();
      return true;
    });
  }

  function renderTasks() {
    const list = document.getElementById('task-list');
    const groups = Store.state().tasks || [];
    list.textContent = '';

    if (!groups.length) {
      list.appendChild(el('div', 'adm-empty', 'Блоков пока нет'));
      return;
    }

    groups.forEach((group, groupIndex) => {
      const card = el('div', 'adm-card glass');

      const head = el('div', 'adm-head');
      const title = text(group.title, 'Название блока');
      title.addEventListener('change', () => {
        save((state) => {
          state.tasks[groupIndex].title = title.value.trim() || 'Без названия';
          return state;
        });
      });

      const headField = el('div', 'adm-field');
      headField.style.flex = '1 1 auto';
      headField.append(el('span', null, 'Блок'), title);

      const tools = el('div', 'adm-item__acts');

      const add = el('button', 'adm-btn adm-btn--small', 'Задание');
      add.type = 'button';
      add.addEventListener('click', () => taskForm(groupIndex, null, renderTasks));

      const dropGroup = icon(ICONS.trash, 'Удалить блок', 'danger');
      dropGroup.addEventListener('click', () => {
        if (!confirm('Удалить блок «' + group.title + '»?')) return;
        save((state) => {
          state.tasks.splice(groupIndex, 1);
          return state;
        });
        renderTasks();
      });

      tools.append(add, dropGroup);
      head.append(headField, tools);
      card.appendChild(head);

      (group.items || []).forEach((task) => {
        const row = el('div', 'adm-item');
        const body = el('div', 'adm-item__body');
        body.append(
          el('div', 'adm-item__name', task.name),
          el('div', 'adm-item__meta', 'награда ' + task.reward + ' · цель ' + task.goal)
        );

        const acts = el('div', 'adm-item__acts');

        const edit = icon(ICONS.edit, 'Изменить');
        edit.addEventListener('click', () => taskForm(groupIndex, task, renderTasks));

        const drop = icon(ICONS.trash, 'Удалить', 'danger');
        drop.addEventListener('click', () => {
          save((state) => {
            const items = state.tasks[groupIndex].items;
            state.tasks[groupIndex].items = items.filter((one) => one.id !== task.id);
            return state;
          });
          renderTasks();
        });

        acts.append(edit, drop);
        row.append(body, acts);
        card.appendChild(row);
      });

      if (!(group.items || []).length) {
        card.appendChild(el('div', 'adm-empty', 'В блоке пока пусто'));
      }

      list.appendChild(card);
    });
  }

  // --- Маркет ---

  function renderMarket() {
    const form = document.getElementById('market-form');
    form.textContent = '';

    const current = (Store.state().market || {}).opensAt || '';
    const parsed = Date.parse(current);
    const input = el('input');
    input.type = 'datetime-local';
    input.style.colorScheme = 'dark';

    if (Number.isFinite(parsed)) {
      const date = new Date(parsed - new Date().getTimezoneOffset() * 60000);
      input.value = date.toISOString().slice(0, 16);
    }

    input.addEventListener('change', () => {
      save((state) => {
        state.market = state.market || {};
        // Сохраняем вместе со смещением, иначе час уедет на чужом устройстве
        state.market.opensAt = input.value ? new Date(input.value).toISOString() : '';
        return state;
      });
      toast('Дата открытия сохранена');
    });

    form.appendChild(field('Дата и время', input));
  }

  // --- Выгрузка и загрузка ---

  function exportContent() {
    Store.exportAll().then((bundle) => {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'content.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Файл собран — положите его в data/content.json');
    });
  }

  function importContent() {
    pickFile('application/json,.json').then((file) => {
      if (!file) return;
      return file.text()
        .then(JSON.parse)
        .then((bundle) => Store.importAll(bundle))
        .then(() => {
          renderAll();
          markDirty();
          toast('Загружено');
        })
        .catch(() => toast('Файл не читается'));
    });
  }

  // --- Сборка ---

  function renderAll() {
    renderGifts();
    renderBanners();
    renderPeople();
    renderTasks();
    renderMarket();
  }

  function bind() {
    document.getElementById('adm-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-tab]');
      if (!tab) return;

      Array.from(document.querySelectorAll('.adm__tab')).forEach((one) => {
        one.classList.toggle('is-active', one === tab);
      });
      Array.from(document.querySelectorAll('.adm__pane')).forEach((pane) => {
        pane.classList.toggle('is-on', pane.dataset.pane === tab.dataset.tab);
      });
    });

    document.getElementById('gift-new').addEventListener('click', () => giftForm(null, renderGifts));
    document.getElementById('banner-new').addEventListener('click', () => bannerForm(null, renderBanners));
    document.getElementById('group-new').addEventListener('click', () => {
      save((state) => {
        state.tasks = state.tasks || [];
        state.tasks.push({ id: slug('block'), title: 'Новый блок', items: [] });
        return state;
      });
      renderTasks();
    });

    document.getElementById('person-new').addEventListener('click', () => {
      const id = prompt('Телеграмный id пользователя');
      if (!id || !/^\d+$/.test(id.trim())) {
        if (id !== null) toast('id — это только цифры');
        return;
      }
      personForm(id.trim(), renderPeople);
    });

    document.getElementById('act-export').addEventListener('click', exportContent);
    document.getElementById('act-export-2').addEventListener('click', exportContent);
    document.getElementById('act-import').addEventListener('click', importContent);

    document.getElementById('act-reset').addEventListener('click', () => {
      if (!confirm('Вернуть всё к опубликованному? Правки в этом браузере пропадут.')) return;
      Store.reset();
      renderAll();
      markDirty();
      toast('Правки сброшены');
    });
  }

  // --- Доступ ---

  function start() {
    if (tg) {
      tg.ready();
      tg.expand();
    }

    Store.load().then(() => {
      const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
      // Без Telegram проверять некого: такой заход разрешаем только с
      // локальной машины, где админку и отлаживают
      const local = ['localhost', '127.0.0.1'].indexOf(location.hostname) !== -1;
      const allowed = user ? Store.isAdmin(user.id) : local;

      if (!allowed) {
        gate.dataset.denied = 'true';
        gateText.textContent = 'Эта страница только для администраторов.';
        return;
      }

      gate.hidden = true;
      root.hidden = false;
      bind();
      renderAll();
      markDirty();
    });
  }

  start();
})();
