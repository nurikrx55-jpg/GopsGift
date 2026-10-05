/* Кто прислал запрос. Mini App отдаёт initData, подписанные Telegram:
   подделать id в них нельзя, если подпись проверяет сервер.

   Проверять можно двумя путями. С токеном бота (BOT_TOKEN) — классическая
   HMAC-подпись, она есть у всех клиентов. Без токена, по одному id бота
   (BOT_ID), — Ed25519-подпись открытым ключом Telegram; её отдают клиенты
   начиная с Bot API 8.0. Токен в коде не лежит никогда, только в окружении. */

import crypto from 'node:crypto';

// Открытый ключ Telegram из документации по проверке данных Mini App
const TELEGRAM_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
// Заголовок SPKI для голого 32-байтного ключа Ed25519
const SPKI_ED25519 = '302a300506032b6570032100';

// Хозяин админки. Переопределяется переменной ADMIN_IDS через запятую
const OWNER_ID = '8387706094';

let telegramKey = null;

function botId() {
  return String(process.env.BOT_ID || '').trim();
}

export function authMode() {
  if (process.env.BOT_TOKEN) return 'token';
  if (botId()) return 'signature';
  return null;
}

function fields(params, skip) {
  return Array.from(params.entries())
    .filter(([key]) => skip.indexOf(key) === -1)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => key + '=' + value)
    .join('\n');
}

function byToken(params, token) {
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;

  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(fields(params, ['hash'])).digest();
  const given = Buffer.from(hash, 'hex');

  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function bySignature(params, id) {
  const signature = params.get('signature');
  if (!signature) return false;

  if (!telegramKey) {
    telegramKey = crypto.createPublicKey({
      key: Buffer.from(SPKI_ED25519 + TELEGRAM_KEY, 'hex'),
      format: 'der',
      type: 'spki'
    });
  }

  const check = id + ':WebAppData\n' + fields(params, ['hash', 'signature']);

  try {
    return crypto.verify(null, Buffer.from(check), telegramKey, Buffer.from(signature, 'base64url'));
  } catch (_) {
    return false;
  }
}

// Возвращает пользователя Telegram, если подпись сошлась и данные не
// старше maxAge секунд; иначе null
export function verify(initData, maxAge) {
  if (!initData || typeof initData !== 'string' || initData.length > 8192) return null;

  const params = new URLSearchParams(initData);
  const authDate = Number(params.get('auth_date'));
  if (!authDate) return null;
  if (maxAge && Date.now() / 1000 - authDate > maxAge) return null;

  const token = process.env.BOT_TOKEN;
  const ok = token ? byToken(params, token) : (botId() ? bySignature(params, botId()) : false);
  if (!ok) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch (_) {
    return null;
  }
}

export function adminIds() {
  return String(process.env.ADMIN_IDS || OWNER_ID)
    .split(',')
    .map((one) => one.trim())
    .filter(Boolean);
}

export function isAdmin(id) {
  return adminIds().indexOf(String(id)) !== -1;
}
