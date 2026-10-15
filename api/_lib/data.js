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
   gg:ban:<id>        — бан: такого не пускает заход в приложение
   gg:upglow:<gift>   — прежняя нумерация от остатка тиража, больше не пишется
   gg:upgnum:v2       — отметка, что улучшенные перенумерованы по порядку
   gg:wd:<id>         — заявка на вывод TON: кто, сколько и на какой кошелёк
   gg:wds             — все заявки на вывод по времени
   gg:wds:open        — заявки, которые админ ещё не отправил и не отклонил
   gg:inbox:<id>      — подарки, полученные от других и ещё не показанные
   gg:lot:<id>        — лот маркета: какой улучшенный подарок, чей и за сколько
   gg:lots            — лоты на продаже по времени выставления
   gg:mktlog          — история маркета: выставлен, продан, снят
   gg:refearn:<id>    — сколько человек получил с пополнений каждого приглашённого
   gg:refearned       — сколько каждый получил по рефералке всего

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
  ban: (id) => 'gg:ban:' + id,
  upgnum: 'gg:upgnum:v2',
  wd: (id) => 'gg:wd:' + id,
  wds: 'gg:wds',
  wdsOpen: 'gg:wds:open',
  inbox: (id) => 'gg:inbox:' + id,
  lot: (id) => 'gg:lot:' + id,
  lots: 'gg:lots',
  mktlog: 'gg:mktlog',
  refEarn: (id) => 'gg:refearn:' + id,
  refEarned: 'gg:refearned',
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

/* Маркет: комиссия в процентах с продажи и минимальная цена лота в TON.
   Задаёт админка */
export function cleanMarket(input) {
  const src = input || {};
  const fee = Math.round(Math.min(Math.max(Number(src.fee), 0), 50) * 10) / 10;
  const min = Math.round(Math.min(Math.max(Number(src.min), 0.01), 1e6) * 100) / 100;
  return {
    fee: Number.isFinite(fee) ? fee : 5,
    min: Number.isFinite(min) ? min : 0.1
  };
}

/* Рефералка и передача. referral — процент с каждого пополнения
   приглашённого, который получает пригласивший (сверху, из наших: друг
   получает пополнение целиком). transfer — цена отправки подарка другому
   человеку в звёздах Telegram, 0 — бесплатно. Задаёт админка */
export function cleanFees(input) {
  const src = input || {};
  const referral = Math.round(Math.min(Math.max(Number(src.referral), 0), 50) * 10) / 10;
  const transfer = Math.round(Math.min(Math.max(Number(src.transfer), 0), 100000));
  return {
    referral: Number.isFinite(referral) ? referral : 10,
    transfer: Number.isFinite(transfer) ? transfer : 0
  };
}

const TASK_TYPES = ['link', 'subscribe', 'send', 'buy', 'invite'];

// Канал для задания «подписаться»: @name, t.me/name или просто name.
// Храним одно имя — по нему бот спрашивает Telegram, подписан ли человек
export function channelName(value) {
  const raw = str(value, 120).replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '').replace(/^@/, '');
  const name = raw.split(/[/?#]/)[0];
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name) ? name : '';
}

export function cleanTasks(input) {
  if (!Array.isArray(input)) throw new InputError('Задания пришли не списком');

  return input.slice(0, 20).map((group) => ({
    id: slug(group.id) || newId('block'),
    title: str(group.title, 40) || 'Без названия',
    items: (Array.isArray(group.items) ? group.items : []).slice(0, 50).map((task) => {
      const type = TASK_TYPES.indexOf(task.type) === -1 ? 'send' : task.type;
      const url = str(task.url, 300);
      const channel = type === 'subscribe' ? channelName(task.channel || task.url) : '';
      if (type === 'subscribe' && !channel) throw new InputError('Канал задания: @имя или ссылка t.me/имя');
      return {
        id: slug(task.id) || newId('task'),
        name: str(task.name, 60) || 'Задание',
        // Что нужно сделать: перейти по ссылке, подписаться на канал,
        // отправить, купить подарки или привести друзей. Цель у ссылки и
        // подписки всегда одна
        type: type,
        url: type === 'subscribe'
          ? 'https://t.me/' + channel
          : type === 'link' && (/^https:\/\/[^\s"'<>]+$/i.test(url) || /^tg:\/\/[^\s"'<>]+$/i.test(url)) ? url : '',
        channel: channel,
        reward: int(task.reward, 0, 1000000),
        goal: type === 'link' || type === 'subscribe' ? 1 : int(task.goal, 1, 1000000)
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
  if (!value.market) value.market = cleanMarket({});
  if (!value.fees) value.fees = cleanFees({});

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
    market: cleanMarket(content.market),
    fees: cleanFees(content.fees),
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
    value: int(one.value, 0, 1e9),
    // Выставлен на маркет: номер лота и цена в нанотонах. Пока лот висит,
    // подарок не отправить — сперва снять с продажи
    lot: str(one.lot, 32),
    lotNano: int(one.lotNano, 0, 1e15)
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
  const bans = await mgetJson(ids.map(K.ban));

  return ids.map((id, index) => {
    const profile = profiles[index] ? JSON.parse(profiles[index]) : { id: id };
    return Object.assign({ id: id }, profile, normalAccount(accounts[index]), { banned: Boolean(bans[index]) });
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

/* Бан живёт своим ключом, не в профиле и не в счёте: профиль перезаписывает
   каждый заход в приложение, и отметку админа он бы затёр. */

export async function isBanned(id) {
  return Boolean(await command('GET', K.ban(String(id))));
}

export async function setBan(id, on, by) {
  const key = String(id);
  if (on) await command('SET', K.ban(key), JSON.stringify({ at: Date.now(), by: String(by || '') }));
  else await command('DEL', K.ban(key));
  return Boolean(on);
}

export async function getUser(id) {
  const [person] = await people([String(id)]);
  return person || null;
}

export async function saveAccount(id, input, content) {
  const key = String(id);
  const known = (content.gifts || []).map((gift) => gift.id);

  // Счёт меняют и покупки с выводами — правку админа ставим с ними в очередь
  return queued(key, async () => {
    const before = normalAccount(await command('GET', K.acct(key)));
    const keep = Array.isArray(input.nfts) ? input.nfts.map(String) : null;
    // Баланс Gram (TON) админка задаёт числом в нанотонах. Не прислала — прежний
    const tonNano = input.tonNano === undefined ? before.tonNano : int(input.tonNano, 0, 1e15);

    const acct = {
      // Звёзд как баланса больше нет — Gram вместо них
      stars: 0,
      coupons: int(input.coupons, 0, 1e9),
      gifts: cleanGiftList(input.gifts, known),
      // Улучшенные админка только забирает: присылает, какие оставить.
      // Новых она не создаёт — те появляются только улучшением
      nfts: (keep ? before.nfts.filter((one) => keep.indexOf(one.id) !== -1) : before.nfts).map((one) => {
        // Ценность админка ставит каждому улучшенному по его id
        const values = input.nftValues && typeof input.nftValues === 'object' ? input.nftValues : {};
        return Object.prototype.hasOwnProperty.call(values, one.id)
          ? Object.assign({}, one, { value: int(values[one.id], 0, 1e9) })
          : one;
      }),
      tonNano: tonNano,
      sent: before.sent,
      bought: before.bought,
      tasksDone: before.tasksDone,
      tasksStarted: before.tasksStarted
    };

    // Забранный подарок мог стоять на маркете — его лот снимаем вместе с ним
    const gone = before.nfts.filter((one) => one.lot && !acct.nfts.some((left) => left.id === one.id));
    const commands = [['SET', K.acct(key), JSON.stringify(acct)]];
    gone.forEach((one) => commands.push(['DEL', K.lot(one.lot)], ['ZREM', K.lots, one.lot]));

    // Подкрутка фона живёт отдельно от счёта: счёт уходит в браузер самого
    // человека, а про подкрутку ему знать незачем
    const rig = readAttrs().backdrops.some((one) => one.name === input.rigBackdrop) ? input.rigBackdrop : '';
    commands.push(rig ? ['SET', K.rig(key), rig] : ['DEL', K.rig(key)]);

    await pipeline(commands);

    // Снятый вместе с подарком лот виден в «Активности», как и обычное снятие
    if (gone.length) {
      const rawProfile = await command('GET', K.user(key));
      const seller = { id: key, name: nameOfProfile(rawProfile ? JSON.parse(rawProfile) : {}, key) };
      for (const one of gone) {
        await addMarketLog({ type: 'removed', lot: one.lot, nano: one.lotNano || 0, nft: lotNft(one), seller: seller, admin: true });
      }
    }

    // Начисление от админа видно человеку в истории кошелька
    if (tonNano > before.tonNano) await addTonLog(key, { type: 'deposit', nano: tonNano - before.tonNano, admin: true });
    return acct;
  });
}

export async function stats(content) {
  const now = Date.now();
  const [total, active, fresh, week, withdrawals] = await pipeline([
    ['ZCARD', K.seen],
    ['ZCOUNT', K.seen, now - DAY, '+inf'],
    ['ZCOUNT', K.joined, now - DAY, '+inf'],
    ['ZCOUNT', K.seen, now - 7 * DAY, '+inf'],
    ['ZCARD', K.wdsOpen]
  ]);

  return {
    users: total || 0,
    active: active || 0,
    fresh: fresh || 0,
    week: week || 0,
    // Заявки на вывод, которые ждут админа
    withdrawals: withdrawals || 0,
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
    // 'gift' — покупка подарка, 'upgrade' — улучшение уже купленного,
    // 'transfer' — оплата передачи подарка другому человеку
    kind: input.kind === 'upgrade' || input.kind === 'transfer' ? input.kind : 'gift',
    status: 'new',
    createdAt: Date.now()
  };
  if (order.kind === 'transfer') {
    order.toId = str(input.toId, 20);
    order.nftId = str(input.nftId, 32);
  }

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
  if (order.kind === 'transfer') return settleTransfer(order, charge);

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

/* Номер #N — по порядку улучшения этого подарка: сколько бы его ни
   купили, первый улучшивший получает #1, следующий #2 и так далее.
   Счётчик прибавляется в самой базе одной командой, поэтому два улучшения
   в одну секунду не получат одинаковый номер */
async function nextNumber(gift) {
  await renumberUpgrades();
  return int(await command('ZINCRBY', K.upgseq, 1, gift.id), 1, 1e9);
}

/* До 2026-10-13 номер у подарка с тиражом считался от остатка (#999,
   #998…). Один раз на всю базу переставляем уже выданные номера по
   порядку улучшения — #1, #2… — и ставим счётчики на последний выданный.
   Сервер — один процесс, поэтому дважды перестановка не пойдёт. Каждый
   счёт перечитываем прямо перед записью: правка, случившаяся во время
   обхода, не потеряется */
let renumbering = null;

// Все, кто спросил во время перестановки, ждут её конца, а не идут мимо
export function renumberUpgrades() {
  if (!renumbering) {
    renumbering = renumberOnce().catch((error) => {
      renumbering = null;
      throw error;
    });
  }
  return renumbering;
}

async function renumberOnce() {
  if (await command('GET', K.upgnum)) return;

  const ids = (await command('ZRANGE', K.seen, 0, -1)) || [];
  const accounts = await mgetJson(ids.map(K.acct));
  const all = [];
  ids.forEach((id, index) => {
    normalAccount(accounts[index]).nfts.forEach((nft) => all.push({ owner: id, id: nft.id, gift: nft.gift, at: nft.at }));
  });

  // По подаркам, в каждом — по времени улучшения
  const byGift = new Map();
  all.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).forEach((one) => {
    const list = byGift.get(one.gift) || [];
    list.push(one);
    byGift.set(one.gift, list);
  });

  const nums = new Map();
  const counters = [];
  byGift.forEach((list, gift) => {
    list.forEach((one, index) => nums.set(one.id, index + 1));
    counters.push(['ZADD', K.upgseq, list.length, gift]);
  });

  // Подарки, у которых улучшенных сейчас нет, начинают снова с #1
  const seq = (await command('ZRANGE', K.upgseq, 0, -1)) || [];
  seq.filter((gift) => !byGift.has(gift)).forEach((gift) => counters.push(['ZADD', K.upgseq, 0, gift]));
  if (counters.length) await pipeline(counters);

  const owners = Array.from(new Set(all.map((one) => one.owner)));
  for (const id of owners) {
    const acct = normalAccount(await command('GET', K.acct(id)));
    let changed = false;
    acct.nfts.forEach((nft) => {
      const num = nums.get(nft.id);
      if (num && nft.num !== num) {
        nft.num = num;
        changed = true;
      }
    });
    if (changed) await command('SET', K.acct(id), JSON.stringify(acct));
  }

  // Отметка — в самом конце: оборвись обход на середине, следующий запуск
  // пройдёт его заново, а повтор ничего не испортит — номера те же
  await command('SET', K.upgnum, String(Date.now()));
  console.log('upgrades: перенумеровано ' + nums.size + ' улучшенных у ' + owners.length + ' человек');
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

  const fees = cleanFees((await readContent()).fees);
  let credited = 0;
  for (const tx of data.result) {
    const message = tx.in_msg || {};
    const value = Math.round(Number(message.value) || 0);
    const hash = tx.transaction_id && tx.transaction_id.hash;
    const mark = /(?:^|\s)GG(\d{1,20})(?:\s|$)/.exec(String(message.message || '').trim());
    if (!value || !message.source || !hash || !mark) continue;

    const userId = mark[1];
    const rawProfile = await command('GET', K.user(userId));
    if (!rawProfile) continue;

    const first = await command('SET', K.tontx(hash), userId, 'NX');
    if (!first) continue;

    // Счёт меняем в очереди этого человека — как покупки и вывод
    await queued(userId, async () => {
      const acct = normalAccount(await command('GET', K.acct(userId)));
      acct.tonNano += value;
      await command('SET', K.acct(userId), JSON.stringify(acct));
      await addTonLog(userId, { type: 'deposit', nano: value, hash: hash });
    });
    credited += 1;

    const profile = JSON.parse(rawProfile);
    if (profile.ref) await payReferral(profile.ref, userId, profile, value, fees.referral);
  }

  return credited;
}

// Пригласившему — процент с пополнения друга. Платим сверху: друг
// получил своё целиком
async function payReferral(inviterId, friendId, friend, value, percent) {
  const bonus = Math.floor(value * percent / 100);
  if (bonus <= 0) return;
  const inviter = String(inviterId);
  if (!(await command('GET', K.user(inviter)))) return;

  await queued(inviter, async () => {
    const acct = normalAccount(await command('GET', K.acct(inviter)));
    acct.tonNano += bonus;
    await pipeline([
      ['SET', K.acct(inviter), JSON.stringify(acct)],
      ['ZINCRBY', K.refEarn(inviter), bonus, String(friendId)],
      ['ZINCRBY', K.refEarned, bonus, inviter]
    ]);
    await addTonLog(inviter, { type: 'ref_bonus', nano: bonus, from: nameOfProfile(friend, String(friendId)) });
  });
}

// --- Вывод TON ---

/* Вывод — ручной: человек оставляет заявку, сумма сразу уходит с баланса
   (чтобы её нельзя было потратить второй раз, пока админ отправляет), а
   админ переводит TON со своего кошелька на подключённый кошелёк человека
   и отмечает заявку отправленной. Отклонённая заявка возвращает сумму.

   Счёт одного человека меняют здесь строго по очереди: две заявки, поданные
   разом, иначе прочли бы один и тот же баланс и списали бы его один раз.
   Сервер — один процесс, поэтому очереди в памяти достаточно */
export const WD_MIN_NANO = 0.1 * NANO;
const locks = new Map();

function queued(id, run) {
  const before = locks.get(id) || Promise.resolve();
  const next = before.catch(() => {}).then(run);
  const tail = next.catch(() => {});
  locks.set(id, tail);
  tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return next;
}

// Отметка в истории кошелька идёт за заявкой: «в обработке» → «выведено»
async function markTonLog(userId, wdId, status) {
  const raw = await command('GET', K.tonlog(String(userId)));
  const log = raw ? JSON.parse(raw) : [];
  const entry = log.find((one) => one.wd === wdId);
  if (!entry) return;
  entry.status = status;
  await command('SET', K.tonlog(String(userId)), JSON.stringify(log));
}

export async function requestWithdraw(userId, amount) {
  const id = String(userId);
  const nano = Math.round(Number(amount) * NANO);
  if (!Number.isFinite(nano) || nano < WD_MIN_NANO) throw new InputError('Минимальная сумма вывода — 0,1 TON');

  return queued(id, async () => {
    const [rawProfile, rawAcct] = await pipeline([
      ['GET', K.user(id)],
      ['GET', K.acct(id)]
    ]);
    const profile = rawProfile ? JSON.parse(rawProfile) : {};
    if (!profile.wallet) throw new InputError('Сначала подключите кошелёк');

    const acct = normalAccount(rawAcct);
    if (acct.tonNano < nano) throw new InputError('Не хватает TON на балансе');
    acct.tonNano -= nano;

    const now = Date.now();
    const wd = { id: newId('wd'), userId: id, nano: nano, wallet: profile.wallet, status: 'pending', createdAt: now };

    await pipeline([
      ['SET', K.acct(id), JSON.stringify(acct)],
      ['SET', K.wd(wd.id), JSON.stringify(wd)],
      ['ZADD', K.wds, now, wd.id],
      ['ZADD', K.wdsOpen, now, wd.id]
    ]);
    await addTonLog(id, { type: 'withdraw', nano: nano, wd: wd.id, status: 'pending' });
    return wd;
  });
}

// Для админки: заявки с именем и ником того, кто выводит
export async function listWithdrawals(options) {
  const open = (options && options.filter) !== 'all';
  const key = open ? K.wdsOpen : K.wds;
  const offset = int(options && options.offset, 0, 1e7);
  const limit = int((options && options.limit) || 50, 1, 100);

  // Открытые — старые первыми, их отправляют по очереди; вся история — свежие первыми
  const [ids, total] = await pipeline([
    [open ? 'ZRANGE' : 'ZREVRANGE', key, offset, offset + limit - 1],
    ['ZCARD', key]
  ]);
  if (!(ids || []).length) return { items: [], total: Number(total) || 0 };

  const rows = (await mgetJson(ids.map(K.wd))).map((raw) => (raw ? JSON.parse(raw) : null)).filter(Boolean);
  const profiles = await mgetJson(rows.map((one) => K.user(one.userId)));
  const items = rows.map((one, index) => {
    const person = profiles[index] ? JSON.parse(profiles[index]) : {};
    return Object.assign({}, one, {
      firstName: person.firstName || '',
      lastName: person.lastName || '',
      username: person.username || '',
      photo: person.photo || ''
    });
  });
  return { items: items, total: Number(total) || 0 };
}

export async function openWithdrawals() {
  return Number(await command('ZCARD', K.wdsOpen)) || 0;
}

/* Админ отправил TON — «done»; передумал — «reject», и сумма
   возвращается на баланс. Закрыть можно только ещё открытую заявку */
export async function resolveWithdraw(wdId, action, adminId) {
  const id = str(wdId, 32);
  const raw = await command('GET', K.wd(id));
  if (!raw) throw new InputError('Заявки нет');
  const owner = JSON.parse(raw).userId;

  return queued(String(owner), async () => {
    const wd = JSON.parse(await command('GET', K.wd(id)));
    if (wd.status !== 'pending') throw new InputError('Заявка уже закрыта');

    const done = action === 'done';
    wd.status = done ? 'done' : 'rejected';
    wd.closedAt = Date.now();
    wd.closedBy = String(adminId || '');

    const commands = [
      ['SET', K.wd(id), JSON.stringify(wd)],
      ['ZREM', K.wdsOpen, id]
    ];
    if (!done) {
      const acct = normalAccount(await command('GET', K.acct(wd.userId)));
      acct.tonNano += wd.nano;
      commands.push(['SET', K.acct(wd.userId), JSON.stringify(acct)]);
    }
    await pipeline(commands);
    await markTonLog(wd.userId, id, wd.status);
    return wd;
  });
}

// Язык человека из Telegram — на нём бот ему и пишет
export async function userLang(userId) {
  const raw = await command('GET', K.user(String(userId)));
  return raw ? (JSON.parse(raw).lang || '') : '';
}

// --- Маркет ---

/* Как у memgift: продают только улучшенные подарки, цена в TON, платит
   покупатель с баланса TON. Продавец получает цену за вычетом комиссии.
   Пока подарок на продаже, он остаётся в профиле продавца с пометкой лота —
   отправить его нельзя, пока не снят.

   Покупка трогает два счёта сразу. Оба берём в очередь в порядке id —
   так две встречные покупки не будут ждать друг друга вечно, а две покупки
   одного лота пройдут по очереди, и вторая увидит, что лота уже нет */
const MKT_LOG = 1000;
// Людям во вкладке «Активность» хватает свежих; админка видит всю историю
const MKT_LOG_PUBLIC = 200;

function nameOfProfile(person, id) {
  return [person.firstName, person.lastName].filter(Boolean).join(' ') ||
    (person.username ? '@' + person.username : 'ID ' + id);
}

function bothQueued(a, b, run) {
  const [first, second] = [String(a), String(b)].sort();
  return queued(first, () => queued(second, run));
}

// История — один ключ на всех: прочитать, дописать, записать. Две сделки
// разных людей разом иначе прочли бы один и тот же список, и одна запись
// пропала бы. Поэтому дописываем строго по очереди
function addMarketLog(entry) {
  return queued('~mktlog', async () => {
    const raw = await command('GET', K.mktlog);
    const log = raw ? JSON.parse(raw) : [];
    log.unshift(Object.assign({ at: Date.now() }, entry));
    await command('SET', K.mktlog, JSON.stringify(log.slice(0, MKT_LOG)));
  });
}

// Снимок подарка для лота и истории: что показывать, не заглядывая в счёт
function lotNft(nft) {
  return { id: nft.id, gift: nft.gift, model: nft.model, backdrop: nft.backdrop, symbol: nft.symbol, num: nft.num };
}

// Цена лота в нанотонах — с теми же проверками при выставлении и смене цены
function lotPrice(priceTon, content) {
  const settings = cleanMarket(content.market);
  const nano = Math.round(Number(priceTon) * NANO);
  if (!Number.isFinite(nano) || nano <= 0) throw new InputError('Укажите цену');
  if (nano < Math.round(settings.min * NANO)) throw new InputError('Минимальная цена — ' + String(settings.min).replace('.', ',') + ' GRAM');
  if (nano > 1e6 * NANO) throw new InputError('Слишком высокая цена');
  return nano;
}

export async function createLot(userId, nftId, priceTon, content) {
  const id = String(userId);
  const nano = lotPrice(priceTon, content);

  return queued(id, async () => {
    const [rawAcct, rawProfile] = await pipeline([['GET', K.acct(id)], ['GET', K.user(id)]]);
    const acct = normalAccount(rawAcct);
    const nft = acct.nfts.find((one) => one.id === str(nftId, 32));
    if (!nft) throw new InputError('Этого подарка у вас нет');
    if (nft.lot) throw new InputError('Подарок уже выставлен на маркете');

    const now = Date.now();
    const profile = rawProfile ? JSON.parse(rawProfile) : {};
    const lot = { id: newId('lot'), nftId: nft.id, sellerId: id, nano: nano, createdAt: now, nft: lotNft(nft) };
    nft.lot = lot.id;
    nft.lotNano = nano;

    await pipeline([
      ['SET', K.acct(id), JSON.stringify(acct)],
      ['SET', K.lot(lot.id), JSON.stringify(lot)],
      ['ZADD', K.lots, now, lot.id]
    ]);
    await addMarketLog({ type: 'listed', lot: lot.id, nano: nano, nft: lot.nft, seller: { id: id, name: nameOfProfile(profile, id) } });
    return lot;
  });
}

// Снимает сам продавец или админка (byAdmin) — тогда чей лот, неважно
export async function removeLot(userId, lotId, byAdmin) {
  const raw = await command('GET', K.lot(str(lotId, 32)));
  if (!raw) throw new InputError('Лота уже нет');
  const lot = JSON.parse(raw);
  if (!byAdmin && lot.sellerId !== String(userId)) throw new InputError('Это не ваш лот');
  const id = lot.sellerId;

  return queued(id, async () => {
    if (!(await command('GET', K.lot(lot.id)))) throw new InputError('Лота уже нет');
    const [rawAcct, rawProfile] = await pipeline([['GET', K.acct(id)], ['GET', K.user(id)]]);
    const acct = normalAccount(rawAcct);
    const nft = acct.nfts.find((one) => one.id === lot.nftId);
    if (nft) {
      nft.lot = '';
      nft.lotNano = 0;
    }
    await pipeline([
      ['SET', K.acct(id), JSON.stringify(acct)],
      ['DEL', K.lot(lot.id)],
      ['ZREM', K.lots, lot.id]
    ]);
    const profile = rawProfile ? JSON.parse(rawProfile) : {};
    await addMarketLog({ type: 'removed', lot: lot.id, nano: lot.nano, nft: lot.nft, seller: { id: id, name: nameOfProfile(profile, id) }, admin: Boolean(byAdmin) || undefined });
    return lot;
  });
}

// Новая цена без снятия с продажи. В истории — как новое выставление
export async function repriceLot(userId, lotId, priceTon, content) {
  const id = String(userId);
  const nano = lotPrice(priceTon, content);
  const raw = await command('GET', K.lot(str(lotId, 32)));
  if (!raw) throw new InputError('Лота уже нет');
  if (JSON.parse(raw).sellerId !== id) throw new InputError('Это не ваш лот');

  return queued(id, async () => {
    const rawLot = await command('GET', K.lot(str(lotId, 32)));
    if (!rawLot) throw new InputError('Лота уже нет');
    const lot = JSON.parse(rawLot);
    if (lot.nano === nano) return lot;

    const [rawAcct, rawProfile] = await pipeline([['GET', K.acct(id)], ['GET', K.user(id)]]);
    const acct = normalAccount(rawAcct);
    const nft = acct.nfts.find((one) => one.id === lot.nftId && one.lot === lot.id);
    if (!nft) throw new InputError('Лота уже нет');

    lot.nano = nano;
    nft.lotNano = nano;
    await pipeline([
      ['SET', K.acct(id), JSON.stringify(acct)],
      ['SET', K.lot(lot.id), JSON.stringify(lot)]
    ]);
    const profile = rawProfile ? JSON.parse(rawProfile) : {};
    await addMarketLog({ type: 'listed', lot: lot.id, nano: nano, nft: lot.nft, seller: { id: id, name: nameOfProfile(profile, id) } });
    return lot;
  });
}

/* Покупка. Возвращает, что купили и сколько получил продавец — для
   уведомления от бота */
export async function buyLot(buyerId, lotId, content) {
  const buyer = String(buyerId);
  const raw = await command('GET', K.lot(str(lotId, 32)));
  if (!raw) throw new InputError('Подарок уже купили или сняли с продажи');
  const seller = JSON.parse(raw).sellerId;
  if (seller === buyer) throw new InputError('Это ваш лот');
  const fee = cleanMarket(content.market).fee;

  return bothQueued(buyer, seller, async () => {
    const rawLot = await command('GET', K.lot(str(lotId, 32)));
    if (!rawLot) throw new InputError('Подарок уже купили или сняли с продажи');
    const lot = JSON.parse(rawLot);

    const [rawBuyer, rawSeller, rawBuyerProfile, rawSellerProfile] = await pipeline([
      ['GET', K.acct(buyer)],
      ['GET', K.acct(seller)],
      ['GET', K.user(buyer)],
      ['GET', K.user(seller)]
    ]);
    const to = normalAccount(rawBuyer);
    const from = normalAccount(rawSeller);

    // Подарок могли забрать из админки — тогда и лот не нужен
    const at = from.nfts.findIndex((one) => one.id === lot.nftId && one.lot === lot.id);
    if (at === -1) {
      await pipeline([['DEL', K.lot(lot.id)], ['ZREM', K.lots, lot.id]]);
      throw new InputError('Подарок уже купили или сняли с продажи');
    }
    if (to.tonNano < lot.nano) {
      const error = new InputError('Недостаточно TON на балансе');
      error.code = 'market.low';
      throw error;
    }

    const payout = lot.nano - Math.round(lot.nano * fee / 100);
    const nft = from.nfts.splice(at, 1)[0];
    nft.lot = '';
    nft.lotNano = 0;
    to.nfts.push(nft);
    to.tonNano -= lot.nano;
    from.tonNano += payout;

    await pipeline([
      ['SET', K.acct(buyer), JSON.stringify(to)],
      ['SET', K.acct(seller), JSON.stringify(from)],
      ['DEL', K.lot(lot.id)],
      ['ZREM', K.lots, lot.id]
    ]);

    const buyerProfile = rawBuyerProfile ? JSON.parse(rawBuyerProfile) : {};
    const sellerProfile = rawSellerProfile ? JSON.parse(rawSellerProfile) : {};
    await addTonLog(buyer, { type: 'market_buy', nano: lot.nano, giftId: lot.nft.gift, num: lot.nft.num });
    await addTonLog(seller, { type: 'market_sell', nano: payout, giftId: lot.nft.gift, num: lot.nft.num });
    await addMarketLog({
      type: 'sold',
      lot: lot.id,
      nano: lot.nano,
      nft: lot.nft,
      seller: { id: seller, name: nameOfProfile(sellerProfile, seller) },
      buyer: { id: buyer, name: nameOfProfile(buyerProfile, buyer) }
    });

    return { lot: lot, payout: payout, seller: { id: seller, lang: sellerProfile.lang || '' }, buyer: { id: buyer, name: nameOfProfile(buyerProfile, buyer), username: buyerProfile.username || '' } };
  });
}

// Все лоты на продаже с именем и фото продавца — отбор делает приложение
export async function listLots() {
  // Все лоты: отбор и постраничный показ делает приложение
  const ids = (await command('ZREVRANGE', K.lots, 0, -1)) || [];
  if (!ids.length) return [];
  const lots = (await mgetJson(ids.map(K.lot))).map((raw) => (raw ? JSON.parse(raw) : null)).filter(Boolean);
  const profiles = await mgetJson(lots.map((one) => K.user(one.sellerId)));
  return lots.map((lot, index) => {
    const person = profiles[index] ? JSON.parse(profiles[index]) : {};
    return {
      id: lot.id,
      nano: lot.nano,
      createdAt: lot.createdAt,
      nft: lot.nft,
      seller: { id: lot.sellerId, name: nameOfProfile(person, lot.sellerId), username: person.username || '', photo: person.photo || '' }
    };
  });
}

export async function marketLog(all) {
  const raw = await command('GET', K.mktlog);
  const log = raw ? JSON.parse(raw) : [];
  return all ? log : log.slice(0, MKT_LOG_PUBLIC);
}

// Сколько лотов сейчас на продаже — для админки
export async function lotCount() {
  return Number(await command('ZCARD', K.lots)) || 0;
}

// Админка стирает «Активность» маркета. Лоты на продаже и счета не трогаем
export async function clearMarketLog() {
  await command('DEL', K.mktlog);
}

// --- Рефералы ---

// Кого человек привёл: свежие первыми, наружу только имя и фото
export async function listReferrals(userId, offset, limit) {
  const from = int(offset, 0, 1e7);
  const size = int(limit, 1, 50);
  const [ids, total, earnedAll] = await pipeline([
    ['ZREVRANGE', K.refs(String(userId)), from, from + size - 1],
    ['ZCARD', K.refs(String(userId))],
    ['ZRANGE', K.refEarn(String(userId)), 0, -1, 'WITHSCORES']
  ]);

  // Сколько принёс каждый: «id, сумма, id, сумма…»
  const earnedBy = new Map();
  for (let i = 0; i < (earnedAll || []).length; i += 2) earnedBy.set(earnedAll[i], Number(earnedAll[i + 1]) || 0);
  let earned = 0;
  earnedBy.forEach((nano) => { earned += nano; });

  const profiles = (ids || []).length ? await mgetJson(ids.map(K.user)) : [];
  const items = (ids || []).map((id, index) => {
    const person = profiles[index] ? JSON.parse(profiles[index]) : {};
    return {
      tld: id,
      name: [person.firstName, person.lastName].filter(Boolean).join(' ') ||
        (person.username ? '@' + person.username : ''),
      photo: person.photo || '',
      earned: earnedBy.get(id) || 0
    };
  });

  return { total: Number(total) || 0, items: items, earned: earned };
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
/* Оба счёта меняем в очереди, как при покупке на маркете: иначе передача,
   совпавшая с покупкой, записала бы счёт старым. Платная передача (за
   звёзды) приходит сюда уже оплаченной — из settleTransfer */
export async function transferGift(fromId, toId, giftId, nftId) {
  const from = String(fromId);
  const to = String(toId);
  if (!to || to === from) throw new InputError('Вы не можете отправить самому себе.');
  return bothQueued(from, to, () => moveGift(from, to, slug(giftId), str(nftId, 32)));
}

/* Можно ли отправить — до счёта за звёзды и ещё раз перед списанием.
   Отвечает, какой подарок витрины уходит: у улучшенного он свой */
export async function checkTransfer(fromId, toId, giftId, nftId) {
  const from = String(fromId);
  const to = String(toId);
  if (!to || to === from) throw new InputError('Вы не можете отправить самому себе.');
  const [rawFrom, rawUser] = await pipeline([['GET', K.acct(from)], ['GET', K.user(to)]]);
  if (!rawUser) throw new InputError('Пользователь не найден');
  const sender = normalAccount(rawFrom);
  const nft = str(nftId, 32);
  if (nft) {
    const one = sender.nfts.find((item) => item.id === nft);
    if (!one) throw new InputError('Подарок вам больше не принадлежит');
    if (one.lot) throw new InputError('Подарок выставлен на маркете — сначала снимите его с продажи');
    return one.gift;
  }
  if (sender.gifts.indexOf(slug(giftId)) === -1) throw new InputError('Подарок вам больше не принадлежит');
  return slug(giftId);
}

// Звёзды за передачу пришли — подарок уходит. Не ушёл (его успели
// отправить или выставить, пока человек платил) — заказ «failed», и бот
// вернёт звёзды
async function settleTransfer(order, charge) {
  let result = null;
  let reason = '';
  try {
    result = await transferGift(order.userId, order.toId, order.giftId, order.nftId);
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    reason = error.message;
  }

  const done = Object.assign({}, order, {
    status: result ? 'paid' : 'failed',
    charge: charge,
    paidAt: Date.now(),
    toName: result ? result.name : '',
    reason: reason || undefined
  });
  await command('SET', K.order(order.id), JSON.stringify(done));
  return Object.assign({}, done, { transfer: result });
}

async function moveGift(from, to, gift, nft) {
  const [rawFrom, rawTo, rawUser, rawSender, rawInbox] = await pipeline([
    ['GET', K.acct(from)],
    ['GET', K.acct(to)],
    ['GET', K.user(to)],
    ['GET', K.user(from)],
    ['GET', K.inbox(to)]
  ]);
  if (!rawUser) throw new InputError('Пользователь не найден');

  const sender = normalAccount(rawFrom);
  const recipient = normalAccount(rawTo);

  sender.sent += 1;

  // Улучшенный уходит целиком, со своей моделью, фоном и номером
  let moved = null;
  if (nft) {
    const at = sender.nfts.findIndex((one) => one.id === nft);
    if (at === -1) throw new InputError('Подарок вам больше не принадлежит');
    if (sender.nfts[at].lot) throw new InputError('Подарок выставлен на маркете — сначала снимите его с продажи');
    moved = sender.nfts.splice(at, 1)[0];
    recipient.nfts.push(moved);
  } else {
    const at = sender.gifts.indexOf(gift);
    if (at === -1) throw new InputError('Подарок вам больше не принадлежит');
    sender.gifts.splice(at, 1);
    recipient.gifts.push(gift);
  }

  /* Получатель увидит подарок при следующем заходе — страницей «Подарок
     получен» с конфетти. До тех пор подарок ждёт во входящих */
  const who = rawSender ? JSON.parse(rawSender) : {};
  const fromView = {
    id: from,
    name: [who.firstName, who.lastName].filter(Boolean).join(' ') || (who.username ? '@' + who.username : ''),
    username: who.username || ''
  };
  const inbox = rawInbox ? JSON.parse(rawInbox) : [];
  inbox.push({ gift: moved ? moved.gift : gift, nft: moved ? moved.id : '', from: fromView, at: Date.now() });

  await pipeline([
    ['SET', K.acct(from), JSON.stringify(sender)],
    ['SET', K.acct(to), JSON.stringify(recipient)],
    ['SET', K.inbox(to), JSON.stringify(inbox.slice(-INBOX_MAX))]
  ]);

  const person = JSON.parse(rawUser);
  return {
    name: [person.firstName, person.lastName].filter(Boolean).join(' ') || person.username || to,
    gifts: sender.gifts,
    // Для уведомления от бота: кому, от кого и что
    to: { id: to, lang: person.lang || '' },
    from: fromView,
    gift: moved ? moved.gift : gift,
    nft: moved
  };
}

const INBOX_MAX = 20;

// Что получено и ещё не показано — приложение покажет это при заходе
export async function readInbox(userId) {
  const raw = await command('GET', K.inbox(String(userId)));
  return raw ? JSON.parse(raw) : [];
}

// Показали — убираем. Только то, что было показано: подарок, пришедший
// в ту же секунду, дождётся следующего захода
export async function clearInbox(userId, until) {
  const id = String(userId);
  const left = (await readInbox(id)).filter((one) => one.at > int(until, 0, 1e15));
  await command(left.length ? 'SET' : 'DEL', ...(left.length ? [K.inbox(id), JSON.stringify(left)] : [K.inbox(id)]));
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

export function findTask(content, taskId) {
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
  // Подписку сервер ещё раз проверяет у Telegram перед наградой — см. api/tasks.js
  if (task.type === 'link' || task.type === 'subscribe') return acct.tasksStarted.indexOf(task.id) === -1 ? 0 : 1;
  if (task.type === 'buy') return acct.bought;
  if (task.type === 'invite') return invited;
  return acct.sent;
}

export async function startTask(userId, taskId, content) {
  const id = String(userId);
  const task = findTask(content, taskId);
  if (!task || (task.type !== 'link' && task.type !== 'subscribe')) throw new InputError('Такого задания нет');

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
