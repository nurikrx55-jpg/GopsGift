/* Пропуск на свой код. Разметка, стили и скрипты — это и есть приложение:
   скачав их целиком, чужой человек получает копию витрины. Поэтому отдаём
   их не всем подряд, а по пропуску, который выдаётся в обмен на свежие
   initData из Telegram.

   Пропуск ничего не хранит на сервере: это id, срок и подпись секретом,
   который наружу не уходит. Проверка — сравнение подписи, без базы. */

import crypto from 'node:crypto';

// Пропуск живёт дольше свежести initData: человек может не закрывать
// приложение полдня, и перевыпускать его посреди работы незачем
const LIFE = 12 * 60 * 60;

function secret() {
  // Отдельного ключа для этого заводить не стали: оба уже есть на сервере
  // и наружу не попадают
  return String(process.env.BOT_TOKEN || process.env.WEBHOOK_SECRET || '');
}

function sign(body) {
  return crypto.createHmac('sha256', secret()).update(body).digest('base64url');
}

export function issue(id, admin) {
  if (!secret()) return '';
  const body = String(id) + '.' + (admin ? 'a' : 'u') + '.' + (Math.floor(Date.now() / 1000) + LIFE);
  return body + '.' + sign(body);
}

// Возвращает { id, admin }, если пропуск наш и не просрочен; иначе null
export function check(pass) {
  if (!secret() || !pass || typeof pass !== 'string' || pass.length > 256) return null;

  const cut = pass.lastIndexOf('.');
  if (cut < 1) return null;

  const body = pass.slice(0, cut);
  const given = Buffer.from(pass.slice(cut + 1));
  const expected = Buffer.from(sign(body));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;

  const [id, kind, till] = body.split('.');
  if (!id || !till || Number(till) < Date.now() / 1000) return null;

  return { id: id, admin: kind === 'a' };
}
