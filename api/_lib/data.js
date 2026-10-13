/* Данные приложения в Redis.

   gg:content         — витрина, баннеры и задания
   gg:user:<id>       — профиль из Telegram: имя, фото, когда заходил
   gg:acct:<id>       — счёт: звёзды, купоны, подарки
   gg:users:seen      — все, кто открывал приложение, по последнему заходу
   gg:users:joined    — те же люди по дате первого захода
   gg:file:<id>       — загруженные из админки анимации и картинки
   gg:order:<id>      — заказ: кто, что и за сколько покупает
   gg:charge:<id>     — отметка, что этот платёж уже засчитан
   gg:stake:<id>      — ставки убранного стейкинга: читаются, только чтобы вернуть подарки
   gg:buyers:<gift>   — кто сколько штук этого подарка купил, для «Топа покупателей»
   gg:buyers:filled   — отметка, что прошлые покупки уже сосчитаны по счетам
   gg:refs:<id>       — кого человек привёл своей ссылкой, по времени прихода
   gg:tonlog:<id>     — история кошелька: пополнения TON и покупки с баланса
   gg:tontx:<hash>    — отметка, что этот перевод TON уже зачислен
   gg:upgseq          — сколько раз улучшали каждый подарок: отсюда номер #N
   gg:rig:<id>        — фон, который админ подкрутил на следующее улучшение
   gg:upglow:<gift>   — последний выданный номер #N у подарка с тиражом

   Профиль пишет только сам заход в приложение, счёт — только админка.
   Ключи разные нарочно: иначе заход, прочитавший счёт за миг до правки
   админа, записал бы его обратно старым. */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { command, pipeline } from './db.js';
import presets from './presets.js';

const K = {
  content: 'gg:content',
  user: (id) => 'gg:user:' + id,
  acct: (id) => 'gg:acct:' + id,
  seen: 'gg:users:seen',
  joined: 'gg:users:joined',
  file: (id) => 'gg:file:' + id,
  order: (id) => 'gg:order:' + id,
  charge: (id) => 'gg:charge:' + id,
  stake: (id) => 'gg:stake:' + id,
  buyers: (gift) => 'gg:buyers:' + gift,
  refs: (id) => 'gg:refs:' + id,
  tonlog: (id) => 'gg:tonlog:' + id,
  tontx: (hash) => 'gg:tontx:' + hash,
  upgseq: 'gg:upgseq',
  rig: (id) => 'gg:rig:' + id,
  upglow: (gift) => 'gg:upglow:' + gift,
  buyersFilled: 'gg:buyers:filled'
};

const DAY = 24 * 60 * 60 * 1000;
// Содержимое читают на каждом заходе. Тёплый экземпляр функции держит его
// пару секунд — правка админа доходит до всех почти сразу, а база не
// пересчитывает одно и то же на каждый запрос
const CONTENT_TTL = 3000;
const MGET_CHUNK = 500;

let contentCache = null;

export class InputError extends Error {}

// --- Мелочи проверки входа ---

function str(value, max) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function int(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function slug(value) {
  return str(value, 48).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function newId(prefix) {
  return (prefix ? prefix + '-' : '') + crypto.randomBytes(5).toString('hex');
}

const KINDS = ['blood', 'legend', 'premium', 'epic', 'rare', 'time', 'sold', 'default'];
// Редкость — цвет карточки на витрине и странице подарка, как у memgift.
// Пусто — карточки красятся тоном самого подарка
const RARITIES = ['rare', 'veryrare', 'epic', 'legend', 'author'];

// Свой цвет ленты. Пусто — лента возьмёт цвет редкости
function tone(value) {
  const hex = str(value, 9).toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : '';
}

// Путь к анимации или картинке: файл из репозитория или загрузка из админки
function assetRef(value) {
  const ref = str(value, 200);
  if (/^\/api\/file\?id=[a-z0-9-]{6,64}$/.test(ref)) return ref;
  if (/^[a-z0-9_\-/]+\.(json|svg|jpg|jpeg|png|webp)$/i.test(ref) && ref.indexOf('..') === -1) return ref;
  return '';
}

// Модель улучшенного подарка: имя, картинка или анимация и шанс выпасть, %
function cleanModels(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();

  return input.slice(0, 60).map((one) => ({
    id: slug(one && one.id) || newId('m'),
    name: str(one && one.name, 32),
    art: assetRef(one && one.art),
    artType: one && one.artType === 'svg' ? 'svg' : 'lottie',
    rate: Math.round(Math.min(Math.max(Number(one && one.rate) || 0, 0), 100) * 10) / 10
  })).filter((one) => {
    if (!one.name || !one.art || seen.has(one.id)) return false;
    seen.add(one.id);
    return true;
  });
}

export function cleanGift(input) {
  const gift = {
    id: slug(input.id) || newId('gift'),
    name: str(input.name, 40),
    art: assetRef(input.art),
    // Подарок рисует либо анимация lottie, либо картинка .svg — показывают
    // их по-разному, поэтому вид храним рядом с путём
    artType: input.artType === 'svg' ? 'svg' : 'lottie',
    price: int(input.price, 0, 1000000),
    badge: str(input.badge, 24),
    kind: KINDS.indexOf(input.kind) === -1 ? 'default' : input.kind,
    rarity: RARITIES.indexOf(input.rarity) === -1 ? '' : input.rarity,
    tone: tone(input.tone),
    // Фон карточки. Пусто — цвет снимается с самого подарка
    bg: tone(input.bg),
    total: int(input.total, 0, 100000000),
    left: int(input.left, 0, 100000000),
    status: str(input.status, 24) || 'Non-Unique',
    // Улучшение, как у memgift: модели подарка и цена в звёздах. Пока
    // моделей нет, кнопка «Улучшить» в профиле приглушена
    models: cleanModels(input.models),
    upgradePrice: int(input.upgradePrice, 0, 100000)
  };

  if (!gift.name) throw new InputError('Без названия подарок не сохранить');
  if (!gift.art) throw new InputError('Нужен файл подарка — .tgs или .svg');
  if (gift.left > gift.total) gift.left = gift.total;

  return gift;
}

export function cleanBanner(input) {
  const href = str(input.href, 300);

  const banner = {
    id: slug(input.id) || newId('banner'),
    image: assetRef(input.image),
    label: str(input.label, 60) || 'Баннер',
    // Ссылка — только наружу по https или ссылка в Telegram
    href: /^https:\/\/[^\s"'<>]+$/i.test(href) || /^tg:\/\/[^\s"'<>]+$/i.test(href) ? href : ''
  };

  if (!banner.image) throw new InputError('Нужна картинка баннера');
  return banner;
}

// --- Пополнения TON ---

/* Куда приходят пополнения. Адрес публичный, его не прячем; поменять
   можно переменной TON_RECEIVER в окружении сервера */
export const TON_RECEIVER = process.env.TON_RECEIVER || 'UQCqHr55DwZJr0OWcV6fPmQrjGCqrZMxyAqwj80NuMwAzsmN';
const NANO = 1e9;

// Курс задаёт админка: сколько звёзд стоит 1 TON. Ноль — оплата TON выключена
export function cleanTon(input) {
  const src = input || {};
  return { rate: int(src.rate, 0, 1e9) };
}

// Цена в нанотонах: звёзды по курсу, с округлением вверх до нанотона
export function tonPrice(stars, rate) {
  return rate > 0 ? Math.ceil(stars * NANO / rate) : 0;
}

const TASK_TYPES = ['link', 'send', 'buy', 'invite'];

export function cleanTasks(input) {
  if (!Array.isArray(input)) throw new InputError('Задания пришли не списком');

  return input.slice(0, 20).map((group) => ({
    id: slug(group.id) || newId('block'),
    title: str(group.title, 40) || 'Без названия',
    items: (Array.isArray(group.items) ? group.items : []).slice(0, 50).map((task) => {
      const type = TASK_TYPES.indexOf(task.type) === -1 ? 'send' : task.type;
      const url = str(task.url, 300);
      return {
        id: slug(task.id) || newId('task'),
        name: str(task.name, 60) || 'Задание',
        // Что нужно сделать: перейти по ссылке, отправить, купить подарки
        // или привести друзей. Цель у ссылки всегда одна — перейти
        type: type,
        url: type === 'link' && (/^https:\/\/[^\s"'<>]+$/i.test(url) || /^tg:\/\/[^\s"'<>]+$/i.test(url)) ? url : '',
        reward: int(task.reward, 0, 1000000),
        goal: type === 'link' ? 1 : int(task.goal, 1, 1000000)
      };
    })
  }));
}

function cleanGiftList(list, known) {
  return (Array.isArray(list) ? list : [])
    .map((one) => slug(one))
    .filter((one) => one && (!known || known.indexOf(one) !== -1))
    .slice(0, 500);
}

// --- Содержимое ---

function readSeed() {
  const file = path.join(process.cwd(), 'data', 'content.json');
  const seed = JSON.parse(fs.readFileSync(file, 'utf8'));

  return {
    gifts: seed.gifts || [],
    banners: seed.banners || [],
    tasks: seed.tasks || [],
    updatedAt: Date.now()
  };
}

// Первый запуск базы: переносим то, что было в репозитории. NX — чтобы два
// одновременных первых запроса не затёрли друг друга
async function seed() {
  const initial = readSeed();
  const commands = [['SET', K.content, JSON.stringify(initial), 'NX']];

  Object.keys(presets).forEach((id) => {
    commands.push(['SET', K.acct(id), JSON.stringify(presets[id]), 'NX']);
  });

  await pipeline(commands);
  const raw = await command('GET', K.content);
  return raw ? JSON.parse(raw) : initial;
}

export async function readContent(fresh) {
  if (!fresh && contentCache && Date.now() - contentCache.at < CONTENT_TTL) {
    return contentCache.value;
  }

  const raw = await command('GET', K.content);
  const value = raw ? JSON.parse(raw) : await seed();

  // Курс TON появился позже самой витрины: у старых записей его нет
  if (!value.ton) value.ton = { rate: 0 };

  contentCache = { at: Date.now(), value: value };
  return value;
}

export async function writeContent(change) {
  const current = await readContent(true);
  const next = change(JSON.parse(JSON.stringify(current))) || current;
  next.updatedAt = Date.now();

  await command('SET', K.content, JSON.stringify(next));
  contentCache = { at: Date.now(), value: next };
  return next;
}

// Что видит приложение: всё, кроме служебного
export function publicContent(content) {
  return {
    gifts: content.gifts || [],
    banners: content.banners || [],
    tasks: content.tasks || [],
    ton: { address: TON_RECEIVER, rate: (content.ton && content.ton.rate) || 0 },
    updatedAt: content.updatedAt || 0
  };
}

// --- Люди ---

// Новичок начинает с нуля: ни звёзд, ни купонов, ни подарков
function emptyAccount() {
  return { stars: 0, coupons: 0, gifts: [], nfts: [], tonNano: 0, sent: 0, bought: 0, tasksDone: [], tasksStarted: [] };
}

// Улучшенный подарок: из какого подарка, что выпало и его номер
function cleanNft(one) {
  if (!one || typeof one !== 'object') return null;
  const nft = {
    id: str(one.id, 32),
    gift: str(one.gift, 48),
    // Модель записана целиком: админ может убрать её из подарка, а у
    // того, кому она выпала, картинка и шанс должны остаться
    model: {
      name: str(one.model && one.model.name, 32),
      art: assetRef(one.model && one.model.art),
      artType: one.model && one.model.artType === 'svg' ? 'svg' : 'lottie',
      rate: Number(one.model && one.model.rate) || 0
    },
    backdrop: str(one.backdrop, 32),
    symbol: str(one.symbol, 32),
    num: int(one.num, 0, 1e9),
    at: int(one.at, 0, 1e15),
    // Ценность этого конкретного подарка в звёздах — ставит админка
    value: int(one.value, 0, 1e9)
  };
  return nft.id && nft.gift ? nft : null;
}

function normalAccount(raw) {
  const acct = raw ? JSON.parse(raw) : {};
  return {
    stars: int(acct.stars, 0, 1e9),
    coupons: int(acct.coupons, 0, 1e9),
    gifts: Array.isArray(acct.gifts) ? acct.gifts : [],
    nfts: Array.isArray(acct.nfts) ? acct.nfts.map(cleanNft).filter(Boolean) : [],
    // Баланс TON в нанотонах — целым числом, чтобы не терять копейки
    tonNano: int(acct.tonNano, 0, 1e15),
    // Для заданий: сколько подарков отправил и купил, какие задания уже
    // забрал и по каким ссылкам начинал
    sent: int(acct.sent, 0, 1e9),
    bought: int(acct.bought, 0, 1e9),
    tasksDone: Array.isArray(acct.tasksDone) ? acct.tasksDone.map(String).slice(-500) : [],
    tasksStarted: Array.isArray(acct.tasksStarted) ? acct.tasksStarted.map(String).slice(-500) : []
  };
}

// Заход в приложение: обновляем профиль и отдаём счёт. Новичку заводим
// пустой счёт
export async function touchUser(tg, start) {
  const id = String(tg.id);
  const now = Date.now();
  const [rawProfile, rawAcct] = await pipeline([
    ['GET', K.user(id)],
    ['GET', K.acct(id)]
  ]);

  const before = rawProfile ? JSON.parse(rawProfile) : {};
  const profile = {
    id: id,
    username: str(tg.username, 64),
    firstName: str(tg.first_name, 64),
    lastName: str(tg.last_name, 64),
    photo: /^https:\/\//.test(tg.photo_url || '') ? str(tg.photo_url, 300) : '',
    lang: str(tg.language_code, 8),
    tgPremium: Boolean(tg.is_premium),
    firstSeen: before.firstSeen || now,
    lastSeen: now,
    visits: int(before.visits, 0, 1e9) + 1,
    ref: before.ref || '',
    wallet: before.wallet || ''
  };

  /* Пришёл по чужой ссылке (`startapp=ref_<id>`) — запоминаем, кто привёл.
     Только при первом заходе: иначе любой старый знакомый «приводился» бы
     заново каждым, кто кинет ему ссылку */
  const invited = /^ref_(\d{1,20})$/.exec(String(start || ''));
  let inviter = '';
  if (!rawProfile && invited && invited[1] !== id) {
    const known = await command('GET', K.user(invited[1]));
    if (known) inviter = invited[1];
  }
  if (inviter) profile.ref = inviter;

  const commands = [
    ['SET', K.user(id), JSON.stringify(profile)],
    ['ZADD', K.seen, now, id],
    ['ZADD', K.joined, 'NX', profile.firstSeen, id]
  ];
  if (inviter) commands.push(['ZADD', K.refs(inviter), 'NX', now, id]);

  let acct = rawAcct ? normalAccount(rawAcct) : null;
  if (!acct) {
    acct = emptyAccount();
    commands.push(['SET', K.acct(id), JSON.stringify(acct), 'NX']);
  }

  await pipeline(commands);
  if (rawAcct) await returnStakes(id, acct);
  return Object.assign({}, profile, acct);
}

async function mgetJson(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i += MGET_CHUNK) {
    const chunk = keys.slice(i, i + MGET_CHUNK);
    const values = await command('MGET', ...chunk);
    (values || []).forEach((value) => out.push(value));
  }
  return out;
}

async function people(ids) {
  if (!ids.length) return [];

  const profiles = await mgetJson(ids.map(K.user));
  const accounts = await mgetJson(ids.map(K.acct));

  return ids.map((id, index) => {
    const profile = profiles[index] ? JSON.parse(profiles[index]) : { id: id };
    return Object.assign({ id: id }, profile, normalAccount(accounts[index]));
  });
}

function matches(person, query) {
  const q = query.toLowerCase().replace(/^@/, '');
  return [person.id, person.username, person.firstName, person.lastName,
    (person.firstName || '') + ' ' + (person.lastName || '')]
    .some((value) => String(value || '').toLowerCase().indexOf(q) !== -1);
}

export async function listUsers(options) {
  const query = str(options.query, 64);
  const filter = str(options.filter, 16);
  const offset = int(options.offset, 0, 1e7);
  const limit = int(options.limit, 1, 100);
  const order = filter === 'new' ? K.joined : K.seen;

  // Без поиска и фильтра — страница прямо из сортированного списка
  if (!query && (filter === 'all' || filter === 'new' || !filter)) {
    const [ids, total] = await pipeline([
      ['ZREVRANGE', order, offset, offset + limit - 1],
      ['ZCARD', order]
    ]);
    return { items: await people(ids || []), total: total || 0 };
  }

  // Поиск и выборки по признакам — по всем сразу: людей у бота тысячи,
  // а не миллионы, и MGET по пятьсот ключей стоит одну команду
  const ids = (await command('ZREVRANGE', order, 0, -1)) || [];
  const everyone = await people(ids);

  const found = everyone.filter((person) => {
    if (filter === 'premium' && !person.tgPremium) return false;
    return !query || matches(person, query);
  });

  return { items: found.slice(offset, offset + limit), total: found.length };
}

export async function readRig(id) {
  return (await command('GET', K.rig(String(id)))) || '';
}

export async function getUser(id) {
  const [person] = await people([String(id)]);
  return person || null;
}

export async function saveAccount(id, input, content) {
  const known = (content.gifts || []).map((gift) => gift.id);
  // Баланс TON админка не правит — его приносят только пополнения
  const before = normalAccount(await command('GET', K.acct(String(id))));
  const acct = {
    stars: int(input.stars, 0, 1e9),
    coupons: int(input.coupons, 0, 1e9),
    gifts: cleanGiftList(input.gifts, known),
    // Улучшенные админка только забирает: присылает, какие оставить.
    // Новых она не создаёт — те появляются только улучшением
    nfts: (Array.isArray(input.nfts)
      ? before.nfts.filter((one) => input.nfts.map(String).indexOf(one.id) !== -1)
      : before.nfts).map((one) => {
      // Ценность админка ставит каждому улучшенному по его id
      const values = input.nftValues && typeof input.nftValues === 'object' ? input.nftValues : {};
      return Object.prototype.hasOwnProperty.call(values, one.id)
        ? Object.assign({}, one, { value: int(values[one.id], 0, 1e9) })
        : one;
    }),
    tonNano: before.tonNano,
    sent: before.sent,
    bought: before.bought,
    tasksDone: before.tasksDone,
    tasksStarted: before.tasksStarted
  };

  // Подкрутка фона живёт отдельно от счёта: счёт уходит в браузер самого
  // человека, а про подкрутку ему знать незачем
  const rig = readAttrs().backdrops.some((one) => one.name === input.rigBackdrop) ? input.rigBackdrop : '';
  await command(rig ? 'SET' : 'DEL', ...(rig ? [K.rig(String(id)), rig] : [K.rig(String(id))]));

  await command('SET', K.acct(String(id)), JSON.stringify(acct));
  return acct;
}

export async function stats(content) {
  const now = Date.now();
  const [total, active, fresh, week] = await pipeline([
    ['ZCARD', K.seen],
    ['ZCOUNT', K.seen, now - DAY, '+inf'],
    ['ZCOUNT', K.joined, now - DAY, '+inf'],
    ['ZCOUNT', K.seen, now - 7 * DAY, '+inf']
  ]);

  return {
    users: total || 0,
    active: active || 0,
    fresh: fresh || 0,
    week: week || 0,
    gifts: (content.gifts || []).length,
    banners: (content.banners || []).length
  };
}

// --- Покупка подарков ---

/* Заказ живёт между двумя событиями: приложение попросило счёт, а бот
   сообщил об оплате. В нём записано, что и по какой цене человек брал, —
   иначе на оплату пришлось бы верить браузеру, который цену и прислал.

   Записи мелкие и нужны ради одного платежа, но остаются: по ним видно,
   что с чем происходило, если платёж пришёл дважды или не дошёл. */

export async function createOrder(input) {
  const order = {
    id: newId('ord'),
    userId: String(input.userId),
    giftId: String(input.giftId),
    qty: int(input.qty, 1, 100),
    price: int(input.price, 1, 1000000),
    amount: int(input.amount, 1, 100000000),
    // Сколько купонов уходит в скидку: списываем их вместе с оплатой
    coupons: int(input.coupons, 0, 100000000),
    // 'gift' — покупка подарка, 'upgrade' — улучшение уже купленного
    kind: input.kind === 'upgrade' ? 'upgrade' : 'gift',
    status: 'new',
    createdAt: Date.now()
  };

  await command('SET', K.order(order.id), JSON.stringify(order));
  return order;
}

export async function readOrder(id) {
  const raw = await command('GET', K.order(slug(id)));
  return raw ? JSON.parse(raw) : null;
}

// Платёж дошёл: подарок уходит в профиль, остаток на витрине убывает.
// Телеграм повторяет событие, пока сервер не ответит «принял», поэтому
// засчитываем ровно один раз — отметкой по номеру платежа
export async function settleOrder(id, payment, ton) {
  const order = await readOrder(id);
  if (!order) return null;

  // Оплата с баланса TON: хватает ли, проверяем до отметки о платеже
  const tonCost = ton ? int(ton.nano, 0, 1e15) : 0;
  if (tonCost) {
    const before = normalAccount(await command('GET', K.acct(order.userId)));
    if (before.tonNano < tonCost) {
      const error = new InputError('Не хватает TON на балансе');
      error.code = 'pay.tonlow';
      throw error;
    }
  }

  const charge = str(payment && payment.telegram_payment_charge_id, 128) || order.id;
  const first = await command('SET', K.charge(charge), order.id, 'NX');
  if (!first) return await readOrder(order.id);

  if (order.kind === 'upgrade') return settleUpgrade(order, charge);

  const rawAcct = await command('GET', K.acct(order.userId));
  const acct = normalAccount(rawAcct);
  for (let i = 0; i < order.qty; i += 1) acct.gifts.push(order.giftId);
  acct.bought += order.qty;

  // Купоны, ушедшие в скидку, списываются ровно сейчас — вместе с деньгами
  acct.coupons = Math.max(0, acct.coupons - (order.coupons || 0));
  if (tonCost) acct.tonNano = Math.max(0, acct.tonNano - tonCost);

  await writeContent((state) => {
    const gift = (state.gifts || []).find((one) => one.id === order.giftId);
    // Остаток мог уйти в ноль, пока человек платил: в минус не уводим
    if (gift && typeof gift.left === 'number') {
      gift.left = Math.max(0, gift.left - order.qty);
    }
    return state;
  });

  const done = Object.assign({}, order, {
    status: 'paid',
    charge: charge,
    paidAt: Date.now()
  });

  await pipeline([
    ['SET', K.acct(order.userId), JSON.stringify(acct)],
    ['SET', K.order(order.id), JSON.stringify(done)],
    ['ZINCRBY', K.buyers(order.giftId), order.qty, order.userId]
  ]);

  // Топ этого подарка изменился — следующий запрос посчитает заново
  dropTop(order.giftId);

  if (tonCost) {
    await addTonLog(order.userId, { type: 'gift', nano: tonCost, giftId: order.giftId, qty: order.qty });
  }

  return done;
}

// --- Улучшение подарка ---

/* Как у memgift: подарок из профиля превращается в уникальный — со
   случайной моделью, фоном и символом. Модели у каждого подарка свои, их
   кладёт админка. Фоны и символы общие, это наборы memgift из
   gifts/attributes.json. Шанс выпасть у каждого свой, в процентах. */

const ATTRS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'gifts', 'attributes.json');
let attrsCache = null;

export function readAttrs() {
  if (!attrsCache) {
    try {
      const data = JSON.parse(fs.readFileSync(ATTRS_FILE, 'utf8'));
      attrsCache = { symbols: data.symbols || [], backdrops: data.backdrops || [] };
    } catch (_) {
      attrsCache = { symbols: [], backdrops: [] };
    }
  }
  return attrsCache;
}

// Случайный выбор с весами: чем больше шанс, тем чаще выпадает
function weighted(list) {
  if (!list.length) return null;
  const weights = list.map((one) => Math.max(Number(one.rate) || 0, 0.01));
  const sum = weights.reduce((a, b) => a + b, 0);
  let roll = (crypto.randomInt(0, 1e9) / 1e9) * sum;
  for (let i = 0; i < list.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return list[i];
  }
  return list[list.length - 1];
}

export function canUpgrade(gift) {
  return Boolean(gift) && Array.isArray(gift.models) && gift.models.length > 0;
}

/* Сам бросок. Подарок уходит из списка обычных и встаёт в список
   улучшенных; номер — следующий по счёту для этого подарка */
async function rollUpgrade(userId, giftId, content) {
  const id = String(userId);
  const gift = (content.gifts || []).find((one) => one.id === giftId);
  if (!canUpgrade(gift)) throw new InputError('Этот подарок не поддерживает улучшение');

  const acct = normalAccount(await command('GET', K.acct(id)));
  const at = acct.gifts.indexOf(giftId);
  if (at === -1) throw new InputError('Этого подарка у вас нет');

  const attrs = readAttrs();
  const model = weighted(gift.models);
  // Админ подкрутил фон — выпадает он, и подкрутка снимается
  const rig = await command('GET', K.rig(id));
  const rigged = rig && attrs.backdrops.find((one) => one.name === rig);
  const backdrop = rigged || weighted(attrs.backdrops);
  if (rig) await command('DEL', K.rig(id));
  const symbol = weighted(attrs.symbols);
  const num = await nextNumber(gift);

  const nft = {
    id: newId('nft'),
    gift: giftId,
    model: { name: model.name, art: model.art, artType: model.artType, rate: model.rate },
    backdrop: backdrop ? backdrop.name : '',
    symbol: symbol ? symbol.name : '',
    num: int(num, 1, 1e9),
    at: Date.now()
  };

  acct.gifts.splice(at, 1);
  acct.nfts.push(nft);
  await command('SET', K.acct(id), JSON.stringify(acct));
  return nft;
}

/* Номер #N считается от остатка тиража: вышло 1000, купили один —
   осталось 999, и улучшенный получает #999. Каждый следующий номер меньше
   предыдущего, поэтому не повторяется, даже если между улучшениями никто
   ничего не купил. У подарка без тиража номера идут по порядку: #1, #2… */
async function nextNumber(gift) {
  if (typeof gift.left !== 'number' || !gift.total) {
    return int(await command('ZINCRBY', K.upgseq, 1, gift.id), 1, 1e9);
  }

  const raw = await command('GET', K.upglow(gift.id));
  const last = raw ? int(raw, 0, 1e9) : Infinity;
  const num = Math.max(1, Math.min(gift.left, last - 1));
  await command('SET', K.upglow(gift.id), String(num));
  return num;
}

// Бесплатное улучшение (цена ноль или админ) — сразу, без счёта
export async function upgradeNow(userId, giftId, content) {
  return rollUpgrade(userId, slug(giftId), content);
}

// Платное — после оплаты, тем же путём, что и покупка
async function settleUpgrade(order, charge) {
  const content = await readContent(true);
  let nft = null;
  let problem = '';

  try {
    nft = await rollUpgrade(order.userId, order.giftId, content);
  } catch (error) {
    // Деньги уже пришли, а подарка нет — не роняем обработку платежа,
    // а записываем, что случилось: разбираться будет админ
    problem = error.message;
    console.error('upgrade: оплачено, но не улучшено —', order.id, problem);
  }

  const done = Object.assign({}, order, {
    status: 'paid',
    charge: charge,
    paidAt: Date.now(),
    nftId: nft ? nft.id : '',
    problem: problem
  });
  await command('SET', K.order(order.id), JSON.stringify(done));
  return done;
}

// Можно ли ещё улучшать этот подарок этому человеку — последняя проверка
// перед списанием звёзд
export async function stillOwns(userId, giftId) {
  const acct = normalAccount(await command('GET', K.acct(String(userId))));
  return acct.gifts.indexOf(String(giftId)) !== -1;
}

// --- Чужой профиль ---

/* Как у memgift (страница /view/:id): имя, фото, id и что у человека
   лежит — обычные подарки и улучшенные. Звёзды, купоны, TON и кошелёк
   сюда не попадают: это не для чужих глаз */
export async function publicProfile(userId) {
  const id = str(userId, 20);
  if (!/^\d{1,20}$/.test(id)) return null;

  const [rawProfile, rawAcct] = await pipeline([
    ['GET', K.user(id)],
    ['GET', K.acct(id)]
  ]);
  if (!rawProfile) return null;

  const person = JSON.parse(rawProfile);
  const acct = normalAccount(rawAcct);
  return {
    id: id,
    firstName: person.firstName || '',
    lastName: person.lastName || '',
    username: person.username || '',
    photo: person.photo || '',
    gifts: acct.gifts,
    nfts: acct.nfts
  };
}

// --- TON-кошелёк ---

/* Адрес подключённого кошелька — как у memgift: человек подключает свой
   кошелёк через TON Connect, сервер запоминает адрес. Денег тут нет, это
   только привязка. Адрес принимаем в удобочитаемом виде (48 знаков) */
export async function bindWallet(userId, address) {
  const id = String(userId);
  const wallet = str(address, 64);
  if (wallet && !/^[A-Za-z0-9_-]{48}$/.test(wallet)) throw new InputError('Неверный адрес кошелька');

  const raw = await command('GET', K.user(id));
  if (!raw) throw new InputError('Сначала откройте приложение');

  const profile = JSON.parse(raw);
  profile.wallet = wallet;
  await command('SET', K.user(id), JSON.stringify(profile));
  return wallet;
}

// --- История кошелька и пополнения ---

const TON_LOG = 50;

async function addTonLog(userId, entry) {
  const raw = await command('GET', K.tonlog(String(userId)));
  const log = raw ? JSON.parse(raw) : [];
  log.unshift(Object.assign({ at: Date.now() }, entry));
  await command('SET', K.tonlog(String(userId)), JSON.stringify(log.slice(0, TON_LOG)));
}

export async function tonState(userId) {
  const [rawAcct, rawLog] = await pipeline([
    ['GET', K.acct(String(userId))],
    ['GET', K.tonlog(String(userId))]
  ]);
  return { tonNano: normalAccount(rawAcct).tonNano, log: rawLog ? JSON.parse(rawLog) : [] };
}

/* Пополнения смотрим в самом блокчейне через открытый toncenter: входящие
   переводы на наш адрес с комментарием «GG<id>» зачисляются этому человеку.
   Каждый перевод — один раз: отметка по его хешу ставится раньше зачисления.
   Спрашиваем не чаще раза в несколько секунд — без ключа toncenter строг */
const TON_API = 'https://toncenter.com/api/v2/getTransactions';
const TON_WAIT = 4000;
let tonAsked = 0;

export async function checkDeposits() {
  if (Date.now() - tonAsked < TON_WAIT) return 0;
  tonAsked = Date.now();

  let data;
  try {
    const response = await fetch(TON_API + '?address=' + encodeURIComponent(TON_RECEIVER) + '&limit=50', {
      headers: process.env.TONCENTER_KEY ? { 'X-API-Key': process.env.TONCENTER_KEY } : {},
      signal: AbortSignal.timeout(8000)
    });
    data = await response.json();
  } catch (_) {
    return 0;
  }
  if (!data || !data.ok || !Array.isArray(data.result)) return 0;

  let credited = 0;
  for (const tx of data.result) {
    const message = tx.in_msg || {};
    const value = Math.round(Number(message.value) || 0);
    const hash = tx.transaction_id && tx.transaction_id.hash;
    const mark = /(?:^|\s)GG(\d{1,20})(?:\s|$)/.exec(String(message.message || '').trim());
    if (!value || !message.source || !hash || !mark) continue;

    const userId = mark[1];
    if (!(await command('GET', K.user(userId)))) continue;

    const first = await command('SET', K.tontx(hash), userId, 'NX');
    if (!first) continue;

    const acct = normalAccount(await command('GET', K.acct(userId)));
    acct.tonNano += value;
    await command('SET', K.acct(userId), JSON.stringify(acct));
    await addTonLog(userId, { type: 'deposit', nano: value, hash: hash });
    credited += 1;
  }

  return credited;
}

// --- Рефералы ---

// Кого человек привёл: свежие первыми, наружу только имя и фото
export async function listReferrals(userId, offset, limit) {
  const from = int(offset, 0, 1e7);
  const size = int(limit, 1, 50);
  const [ids, total] = await pipeline([
    ['ZREVRANGE', K.refs(String(userId)), from, from + size - 1],
    ['ZCARD', K.refs(String(userId))]
  ]);

  const profiles = (ids || []).length ? await mgetJson(ids.map(K.user)) : [];
  const items = (ids || []).map((id, index) => {
    const person = profiles[index] ? JSON.parse(profiles[index]) : {};
    return {
      tld: id,
      name: [person.firstName, person.lastName].filter(Boolean).join(' ') ||
        (person.username ? '@' + person.username : ''),
      photo: person.photo || ''
    };
  });

  return { total: Number(total) || 0, items: items };
}

// --- Передача подарка ---

/* Как у memgift: получателя ищут по имени, @нику или Telegram ID среди
   тех, кто открывал приложение. Наружу — только имя, ник и фото */
export async function findRecipients(query, selfId) {
  const q = str(query, 64).replace(/^@/, '');
  if (!q) return [];

  const found = await listUsers({ query: q, limit: 20 });
  return found.items
    .filter((person) => String(person.id) !== String(selfId))
    .map((person) => ({
      user_id: String(person.id),
      name: [person.firstName, person.lastName].filter(Boolean).join(' ') ||
        (person.username ? '@' + person.username : 'ID ' + person.id),
      username: person.username || '',
      user_photo: person.photo || ''
    }));
}

/* Один подарок уходит со счёта отправителя на счёт получателя. Счета
   читаем и пишем одной пачкой — между чтением и записью второй передаче
   того же подарка просто не из чего будет взять */
export async function transferGift(fromId, toId, giftId, nftId) {
  const from = String(fromId);
  const to = String(toId);
  const gift = slug(giftId);
  const nft = str(nftId, 32);

  if (!to || to === from) throw new InputError('Вы не можете отправить самому себе.');

  const [rawFrom, rawTo, rawUser] = await pipeline([
    ['GET', K.acct(from)],
    ['GET', K.acct(to)],
    ['GET', K.user(to)]
  ]);
  if (!rawUser) throw new InputError('Пользователь не найден');

  const sender = normalAccount(rawFrom);
  const recipient = normalAccount(rawTo);

  sender.sent += 1;

  // Улучшенный уходит целиком, со своей моделью, фоном и номером
  if (nft) {
    const at = sender.nfts.findIndex((one) => one.id === nft);
    if (at === -1) throw new InputError('Подарок вам больше не принадлежит');
    recipient.nfts.push(sender.nfts.splice(at, 1)[0]);
  } else {
    const at = sender.gifts.indexOf(gift);
    if (at === -1) throw new InputError('Подарок вам больше не принадлежит');
    sender.gifts.splice(at, 1);
    recipient.gifts.push(gift);
  }

  await pipeline([
    ['SET', K.acct(from), JSON.stringify(sender)],
    ['SET', K.acct(to), JSON.stringify(recipient)]
  ]);

  const person = JSON.parse(rawUser);
  return {
    name: [person.firstName, person.lastName].filter(Boolean).join(' ') || person.username || to,
    gifts: sender.gifts
  };
}

// --- Топ покупателей ---

/* Счётчик покупок завёлся позже самих покупок. Прошлые сосчитаем один раз
   по счетам: сколько штук каждого подарка у кого лежит. Отметку ставим
   первой и только если её ещё нет — два одновременных запроса не посчитают
   дважды. ZADD ставит число, а не прибавляет, так что покупка, прошедшая
   в ту же секунду, тоже не задвоится. */
// Сверку делаем один раз на жизнь процесса: дальше отметка в базе уже стоит,
// и спрашивать её на каждый запрос — лишняя дорога до базы
let buyersFilled = false;

async function fillBuyers() {
  if (buyersFilled) return;
  const first = await command('SET', K.buyersFilled, String(Date.now()), 'NX');
  buyersFilled = true;
  if (!first) return;

  const ids = await command('ZRANGE', K.seen, 0, -1);
  const accounts = await mgetJson((ids || []).map(K.acct));
  const commands = [];

  (ids || []).forEach((id, index) => {
    const counts = new Map();
    normalAccount(accounts[index]).gifts.forEach((gift) => {
      counts.set(gift, (counts.get(gift) || 0) + 1);
    });
    counts.forEach((n, gift) => commands.push(['ZADD', K.buyers(gift), n, id]));
  });

  if (commands.length) await pipeline(commands);
}

/* Топ держим в памяти: база далеко, каждое обращение к ней — сотни
   миллисекунд, а топ меняется только с покупкой. Покупка его и сбрасывает,
   остальное живёт минуту */
const TOP_TTL = 60 * 1000;
const topCache = new Map();

function dropTop(giftId) {
  topCache.delete(String(giftId));
}

export async function topBuyers(giftId, limit) {
  const gift = slug(giftId);
  if (!gift) return { total: 0, top: [] };

  const cached = topCache.get(gift);
  if (cached && Date.now() - cached.at < TOP_TTL) return cached.value;

  await fillBuyers();

  const [total, flat] = await pipeline([
    ['ZCARD', K.buyers(gift)],
    ['ZREVRANGE', K.buyers(gift), 0, limit - 1, 'WITHSCORES']
  ]);

  const ids = [];
  const counts = [];
  for (let i = 0; i < (flat || []).length; i += 2) {
    ids.push(flat[i]);
    counts.push(Number(flat[i + 1]) || 0);
  }

  const profiles = ids.length ? await mgetJson(ids.map(K.user)) : [];
  const top = ids.map((id, index) => {
    const person = profiles[index] ? JSON.parse(profiles[index]) : {};
    // Наружу — только то, что и так видно в Telegram: имя, фото и id
    const name = [person.firstName, person.lastName].filter(Boolean).join(' ') ||
      (person.username ? '@' + person.username : '');
    // id — чтобы по строке топа открыть профиль человека, как у memgift
    return { id: id, name: name, photo: person.photo || '', count: counts[index] };
  });

  const value = { total: Number(total) || 0, top: top };
  topCache.set(gift, { at: Date.now(), value: value });
  return value;
}

// --- Задания ---

/* Как у memgift: ссылка — «Начать» открывает её, потом «Забрать»;
   счётные — когда набралось нужное число, «Забрать». Купоны начисляет
   только сервер и только один раз за задание */

function findTask(content, taskId) {
  const id = slug(taskId);
  for (const group of content.tasks || []) {
    const task = (group.items || []).find((one) => one.id === id);
    if (task) return task;
  }
  return null;
}

export async function invitedCount(userId) {
  return Number(await command('ZCARD', K.refs(String(userId)))) || 0;
}

// Сколько сделано по заданию — то же число, что видит приложение
function progressOf(task, acct, invited) {
  if (task.type === 'link') return acct.tasksStarted.indexOf(task.id) === -1 ? 0 : 1;
  if (task.type === 'buy') return acct.bought;
  if (task.type === 'invite') return invited;
  return acct.sent;
}

export async function startTask(userId, taskId, content) {
  const id = String(userId);
  const task = findTask(content, taskId);
  if (!task || task.type !== 'link') throw new InputError('Такого задания нет');

  const acct = normalAccount(await command('GET', K.acct(id)));
  if (acct.tasksStarted.indexOf(task.id) === -1) {
    acct.tasksStarted.push(task.id);
    await command('SET', K.acct(id), JSON.stringify(acct));
  }
  return acct;
}

export async function claimTask(userId, taskId, content) {
  const id = String(userId);
  const task = findTask(content, taskId);
  if (!task) throw new InputError('Такого задания нет');

  const acct = normalAccount(await command('GET', K.acct(id)));
  if (acct.tasksDone.indexOf(task.id) !== -1) throw new InputError('Награда уже получена');

  const invited = task.type === 'invite' ? await invitedCount(id) : 0;
  if (progressOf(task, acct, invited) < task.goal) throw new InputError('Задание ещё не выполнено');

  acct.tasksDone.push(task.id);
  acct.coupons += task.reward;
  await command('SET', K.acct(id), JSON.stringify(acct));
  return acct;
}

// --- Возврат из стейкинга ---

/* Стейкинг убран 2026-10-13. Что люди успели в него отдать, возвращается
   на счёт при следующем заходе, а запись ставок стирается */
async function returnStakes(id, acct) {
  const raw = await command('GET', K.stake(id));
  if (!raw) return false;

  let list = [];
  try {
    list = JSON.parse(raw);
  } catch (_) {}
  (Array.isArray(list) ? list : []).forEach((one) => {
    if (one && one.giftId) acct.gifts.push(String(one.giftId));
  });

  await pipeline([
    ['SET', K.acct(id), JSON.stringify(acct)],
    ['DEL', K.stake(id)]
  ]);
  return true;
}

// --- Файлы ---

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE = 2.5 * 1024 * 1024;
const MAX_LOTTIE = 4 * 1024 * 1024;
const MAX_SVG = 1.5 * 1024 * 1024;

// Анимация приходит .tgs (это gzip поверх json) или голым json. Храним
// всегда сжатой: так она в десять раз меньше и в базе, и в пути
export async function saveLottie(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!bytes.length) throw new InputError('Файл пустой');

  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let json;
  try {
    json = gzipped ? zlib.gunzipSync(bytes, { maxOutputLength: MAX_LOTTIE * 4 }) : bytes;
  } catch (_) {
    throw new InputError('Файл не распаковался — это точно .tgs?');
  }

  let data;
  try {
    data = JSON.parse(json.toString('utf8'));
  } catch (_) {
    throw new InputError('Внутри не анимация');
  }

  if (!data || !Array.isArray(data.layers) || !data.fr || !data.op) {
    throw new InputError('Внутри не анимация Telegram');
  }

  const packed = gzipped ? bytes : zlib.gzipSync(json);
  if (packed.length > MAX_LOTTIE) throw new InputError('Анимация слишком большая');

  const id = newId('a');
  await command('SET', K.file(id), JSON.stringify({ type: 'lottie', data: packed.toString('base64') }));
  return '/api/file?id=' + id;
}

// Картинка подарка. Чужой svg — это документ, в котором может лежать скрипт,
// поэтому опасное вырезаем здесь, а показываем файл через <img>: в нём
// браузер скрипты не запускает в любом случае
export async function saveSvg(base64) {
  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!bytes.length) throw new InputError('Файл пустой');
  if (bytes.length > MAX_SVG) throw new InputError('Картинка больше 1,5 МБ');

  let text = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) throw new InputError('Внутри не картинка .svg');

  text = text
    .replace(/<\s*(script|foreignObject)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|foreignObject)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '');

  const id = newId('s');
  await command('SET', K.file(id), JSON.stringify({ type: 'image/svg+xml', data: Buffer.from(text, 'utf8').toString('base64') }));
  return '/api/file?id=' + id;
}

export async function saveImage(base64, type) {
  if (IMAGE_TYPES.indexOf(type) === -1) throw new InputError('Нужна картинка jpg, png или webp');

  const bytes = Buffer.from(String(base64 || ''), 'base64');
  if (!bytes.length) throw new InputError('Картинка пустая');
  if (bytes.length > MAX_IMAGE) throw new InputError('Картинка больше 2,5 МБ');

  const id = newId('i');
  await command('SET', K.file(id), JSON.stringify({ type: type, data: bytes.toString('base64') }));
  return '/api/file?id=' + id;
}

export async function readFile(id) {
  const raw = await command('GET', K.file(id));
  return raw ? JSON.parse(raw) : null;
}

// Загрузки, на которые больше никто не ссылается, просто занимают место
export async function dropFile(ref) {
  const match = /^\/api\/file\?id=([a-z0-9-]{6,64})$/.exec(String(ref || ''));
  if (match) await command('DEL', K.file(match[1]));
}
