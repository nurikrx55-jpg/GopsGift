/* Рассылка в боте: админ пишет текст, прикладывает фото и кнопки, бот
   отправляет это всем, кто открывал приложение.

   Отправляем по одному с паузой. У Telegram предел около тридцати
   сообщений в секунду на весь бот, и превысить его — получить отказ на
   все сообщения разом, включая те, что бот шлёт сам (подарок пришёл,
   вывод закрыт). Поэтому двадцать в секунду, а на жалобу «слишком часто»
   ждём ровно столько, сколько велит Telegram, и повторяем.

   Текст уходит как есть, без разметки: админ пишет обычными словами, и
   случайная угловая скобка не должна рушить отправку.

   Ход рассылки лежит в базе: админка показывает его из любой вкладки и с
   любого устройства, а не только у того, кто нажал «Отправить». Сама
   отправка идёт в этом же процессе — служба одна, перезапуск её обрывает,
   и тогда запись остаётся с пометкой «прервана». */

import { command } from './db.js';
import { call, hasBot } from './bot.js';
import { InputError, allUserIds, newId } from './data.js';

const KEY = 'gg:cast';
const APP_URL = process.env.APP_URL || 'https://gapsgift.online/';

const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;
const MAX_BUTTONS = 8;

// Пауза между сообщениями и как часто записываем ход в базу
const PAUSE = 50;
const SAVE_EVERY = 25;

// Идущая рассылка этого процесса. Пока она здесь, вторую начать нельзя
let live = null;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* Кнопка без ссылки открывает само приложение: так её проще всего
   поставить, а web_app в личной переписке с ботом работает везде */
function keyboard(cast) {
  if (!cast.buttons.length) return undefined;
  return {
    inline_keyboard: cast.buttons.map((one) => [
      one.url ? { text: one.text, url: one.url } : { text: one.text, web_app: { url: APP_URL } }
    ])
  };
}

// Фото Telegram забирает сам по ссылке — адрес у загрузки наш и публичный
function photoUrl(ref) {
  return new URL(String(ref).replace(/^\//, ''), APP_URL).toString();
}

export function cleanCast(input) {
  const src = input || {};
  const text = String(src.text || '').replace(/\r\n/g, '\n').trim();
  const photo = /^\/api\/file\?id=[a-z0-9-]{6,64}$/.test(String(src.photo || '')) ? String(src.photo) : '';

  const buttons = (Array.isArray(src.buttons) ? src.buttons : [])
    .slice(0, MAX_BUTTONS)
    .map((one) => ({
      text: String((one && one.text) || '').trim().slice(0, 64),
      url: String((one && one.url) || '').trim().slice(0, 300)
    }))
    .filter((one) => one.text);

  if (!text && !photo) throw new InputError('Пустую рассылку не отправить');
  if (photo && text.length > MAX_CAPTION) {
    throw new InputError('С фото подпись не длиннее ' + MAX_CAPTION + ' знаков, сейчас ' + text.length);
  }
  if (!photo && text.length > MAX_TEXT) {
    throw new InputError('Текст не длиннее ' + MAX_TEXT + ' знаков, сейчас ' + text.length);
  }

  buttons.forEach((one) => {
    if (!one.url) return;
    if (!/^(https?:\/\/|tg:\/\/)\S+$/i.test(one.url)) {
      throw new InputError('Ссылка кнопки «' + one.text + '» должна начинаться с https:// или tg://');
    }
  });

  return { text: text, photo: photo, buttons: buttons };
}

export async function sendCast(chatId, cast) {
  const markup = keyboard(cast);

  if (cast.photo) {
    return call('sendPhoto', {
      chat_id: Number(chatId),
      photo: photoUrl(cast.photo),
      caption: cast.text || undefined,
      reply_markup: markup
    });
  }

  return call('sendMessage', {
    chat_id: Number(chatId),
    text: cast.text,
    link_preview_options: { is_disabled: true },
    reply_markup: markup
  });
}

function save(job) {
  return command('SET', KEY, JSON.stringify(job));
}

/* Что показывать в админке. Запись говорит «идёт», а в этом процессе
   рассылки нет — значит, служба перезапускалась: честно помечаем запись
   прерванной, чтобы кнопка «Отправить» снова работала */
export async function castState() {
  const raw = await command('GET', KEY);
  if (!raw) return null;

  const job = JSON.parse(raw);
  if (job.status === 'run' && !live) {
    job.status = 'broken';
    job.finishedAt = Date.now();
    await save(job);
  }
  return job;
}

export async function startCast(input, adminId) {
  if (!hasBot()) throw new InputError('Токен бота не настроен — рассылать нечем');
  if (live) throw new InputError('Рассылка уже идёт');

  const cast = cleanCast(input);
  const ids = await allUserIds();
  if (!ids.length) throw new InputError('Отправлять некому: приложение ещё никто не открывал');

  const job = {
    id: newId('cast'),
    at: Date.now(),
    by: String(adminId || ''),
    text: cast.text,
    photo: cast.photo,
    buttons: cast.buttons,
    total: ids.length,
    done: 0,
    sent: 0,
    failed: 0,
    status: 'run',
    finishedAt: 0
  };

  await save(job);
  live = { job: job, stop: false };
  // Ответ админке не ждёт конца рассылки: тысяча человек — это минута
  walk(ids, cast).catch((error) => console.error('cast:', error));
  return job;
}

async function walk(ids, cast) {
  const state = live;

  for (let i = 0; i < ids.length; i += 1) {
    if (!state || state.stop) break;

    try {
      await sendCast(ids[i], cast);
      state.job.sent += 1;
    } catch (error) {
      const limits = error && error.payload && error.payload.parameters;
      const wait = limits ? Number(limits.retry_after) : NaN;
      if (Number.isFinite(wait)) {
        // «Слишком часто»: ждём, сколько сказали, и пробуем это же письмо ещё раз
        await sleep((wait + 1) * 1000);
        try {
          await sendCast(ids[i], cast);
          state.job.sent += 1;
        } catch (_) {
          state.job.failed += 1;
        }
      } else {
        // Обычный отказ — человек не запускал бота или заблокировал его
        state.job.failed += 1;
      }
    }

    state.job.done = i + 1;
    if (state.job.done % SAVE_EVERY === 0) await save(state.job);
    await sleep(PAUSE);
  }

  state.job.status = state.stop ? 'stopped' : 'done';
  state.job.finishedAt = Date.now();
  await save(state.job);
  live = null;
}

export async function stopCast() {
  if (live) {
    live.stop = true;
    return live.job;
  }
  return castState();
}
