/* Данные приложения в Redis.

   gg:content         — витрина, баннеры и задания
   gg:user:<id>       — профиль из Telegram: имя, фото, когда заходил
   gg:acct:<id>       — счёт: звёзды, купоны, подарки
   gg:users:seen      — все, кто открывал приложение, по последнему заходу
   gg:users:joined    — те же люди по дате первого захода
   gg:file:<id>       — загруженные из админки анимации и картинки

   Профиль пишет только сам заход в приложение, счёт — только админка.
   Ключи разные нарочно: иначе заход, прочитавший счёт за миг до правки
   админа, записал бы его обратно старым. */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { command, pipeline } from './db.js';
import presets from './presets.js';

const K = {
  content: 'gg:content',
  user: (id) => 'gg:user:' + id,
  acct: (id) => 'gg:acct:' + id,
  seen: 'gg:users:seen',
  joined: 'gg:users:joined',
  file: (id) => 'gg:file:' + id
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

// Путь к анимации или картинке: файл из репозитория или загрузка из админки
function assetRef(value) {
  const ref = str(value, 200);
  if (/^\/api\/file\?id=[a-z0-9-]{6,64}$/.test(ref)) return ref;
  if (/^[a-z0-9_\-/]+\.(json|svg|jpg|jpeg|png|webp)$/i.test(ref) && ref.indexOf('..') === -1) return ref;
  return '';
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
    total: int(input.total, 0, 100000000),
    left: int(input.left, 0, 100000000),
    status: str(input.status, 24) || 'Non-Unique'
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

export function cleanTasks(input) {
  if (!Array.isArray(input)) throw new InputError('Задания пришли не списком');

  return input.slice(0, 20).map((group) => ({
    id: slug(group.id) || newId('block'),
    title: str(group.title, 40) || 'Без названия',
    items: (Array.isArray(group.items) ? group.items : []).slice(0, 50).map((task) => ({
      id: slug(task.id) || newId('task'),
      name: str(task.name, 60) || 'Задание',
      reward: int(task.reward, 0, 1000000),
      goal: int(task.goal, 1, 1000000)
    }))
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
    updatedAt: content.updatedAt || 0
  };
}

// --- Люди ---

// Новичок начинает с нуля: ни звёзд, ни купонов, ни подарков
function emptyAccount() {
  return { stars: 0, coupons: 0, gifts: [] };
}

function normalAccount(raw) {
  const acct = raw ? JSON.parse(raw) : {};
  return {
    stars: int(acct.stars, 0, 1e9),
    coupons: int(acct.coupons, 0, 1e9),
    gifts: Array.isArray(acct.gifts) ? acct.gifts : []
  };
}

// Заход в приложение: обновляем профиль и отдаём счёт. Новичку заводим
// пустой счёт
export async function touchUser(tg) {
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
    visits: int(before.visits, 0, 1e9) + 1
  };

  const commands = [
    ['SET', K.user(id), JSON.stringify(profile)],
    ['ZADD', K.seen, now, id],
    ['ZADD', K.joined, 'NX', profile.firstSeen, id]
  ];

  let acct = rawAcct ? normalAccount(rawAcct) : null;
  if (!acct) {
    acct = emptyAccount();
    commands.push(['SET', K.acct(id), JSON.stringify(acct), 'NX']);
  }

  await pipeline(commands);
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

export async function getUser(id) {
  const [person] = await people([String(id)]);
  return person || null;
}

export async function saveAccount(id, input, content) {
  const known = (content.gifts || []).map((gift) => gift.id);
  const acct = {
    stars: int(input.stars, 0, 1e9),
    coupons: int(input.coupons, 0, 1e9),
    gifts: cleanGiftList(input.gifts, known)
  };

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
