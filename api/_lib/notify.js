/* Сообщения бота людям: получен подарок, вывод отправлен или отклонён.

   Пишем на языке человека из Telegram: русский — тем, у кого русский,
   остальным английский. Разметка — HTML Telegram: жирный, цитата-блок,
   моноширинный адрес. Под сообщением — кнопка в приложение.

   Сообщение — приятное дополнение, а не часть операции: подарок уже
   передан, заявка уже закрыта. Поэтому ошибка отправки (человек не
   запускал бота или заблокировал его) только пишется в журнал. */

import { call, hasBot } from './bot.js';

const APP_URL = process.env.APP_URL || 'https://gapsgift.online/';

const TEXT = {
  ru: {
    giftTitle: '🎁 <b>Вам подарок!</b>',
    giftFrom: '👤 От: {from}',
    giftNote: 'Подарок уже в вашем профиле — откройте GapsGift, чтобы посмотреть.',
    giftOpen: '🎁 Открыть подарок',
    wdDoneTitle: '✅ <b>Вывод отправлен</b>',
    wdDoneNote: 'TON уже в пути — обычно они приходят на кошелёк за минуту.',
    wdRejectTitle: '❌ <b>Вывод отклонён</b>',
    wdRejectNote: 'Сумма вернулась на ваш баланс в GapsGift.',
    wdAmount: '💎 Сумма: <b>{n} TON</b>',
    wdWallet: '👛 Кошелёк: <code>{w}</code>',
    soldTitle: '💰 <b>Ваш подарок продан!</b>',
    soldPrice: '💎 Цена: <b>{n} TON</b>',
    soldPayout: '👛 Вам зачислено: <b>{n} TON</b>',
    soldBuyer: '👤 Покупатель: {who}',
    soldNote: 'Деньги уже на вашем балансе в GapsGift.',
    open: 'Открыть GapsGift'
  },
  en: {
    giftTitle: '🎁 <b>You got a gift!</b>',
    giftFrom: '👤 From: {from}',
    giftNote: 'The gift is already in your profile — open GapsGift to see it.',
    giftOpen: '🎁 Open the gift',
    wdDoneTitle: '✅ <b>Withdrawal sent</b>',
    wdDoneNote: 'Your TON is on its way — it usually reaches the wallet within a minute.',
    wdRejectTitle: '❌ <b>Withdrawal rejected</b>',
    wdRejectNote: 'The amount is back on your GapsGift balance.',
    wdAmount: '💎 Amount: <b>{n} TON</b>',
    wdWallet: '👛 Wallet: <code>{w}</code>',
    soldTitle: '💰 <b>Your gift was sold!</b>',
    soldPrice: '💎 Price: <b>{n} TON</b>',
    soldPayout: '👛 You got: <b>{n} TON</b>',
    soldBuyer: '👤 Buyer: {who}',
    soldNote: 'The money is already on your GapsGift balance.',
    open: 'Open GapsGift'
  }
};

function words(lang) {
  return /^(ru|uk|be|kk)/i.test(String(lang || '')) ? TEXT.ru : TEXT.en;
}

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
}

// 1500000000 → «1,5» по-русски и «1.5» по-английски
function ton(nano, lang) {
  const value = String(Math.round((Number(nano) || 0) / 1e5) / 1e4);
  return words(lang) === TEXT.ru ? value.replace('.', ',') : value;
}

async function send(chatId, text, button) {
  if (!hasBot()) return false;
  try {
    await call('sendMessage', {
      chat_id: Number(chatId),
      text: text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: button, web_app: { url: APP_URL } }]] }
    });
    return true;
  } catch (error) {
    console.warn('notify: сообщение ' + chatId + ' не ушло —', error.message);
    return false;
  }
}

/* Подарок получен. gift — запись с витрины (имя), nft — улучшенный, если
   передали его: тогда к имени добавляются модель и номер */
export function giftReceived(to, from, gift, nft) {
  const w = words(to.lang);
  const name = esc((gift && gift.name) || (nft && nft.model && nft.model.name) || '');
  const title = nft
    ? '<b>' + name + '</b> · ' + esc(nft.model && nft.model.name) + ' <b>#' + esc(nft.num) + '</b>'
    : '<b>' + name + '</b>';
  const sender = from.username
    ? '<b>' + esc(from.name || '@' + from.username) + '</b> (@' + esc(from.username) + ')'
    : '<b>' + esc(from.name || 'ID ' + from.id) + '</b>';

  const text = [
    w.giftTitle,
    '',
    '<blockquote>🎀 ' + title + '\n' + fill(w.giftFrom, { from: sender }) + '</blockquote>',
    '',
    w.giftNote
  ].join('\n');

  return send(to.id, text, w.giftOpen);
}

// Админ закрыл заявку на вывод: отправил TON или отказал
export function withdrawClosed(wd, lang) {
  const w = words(lang);
  const done = wd.status === 'done';
  const lines = [fill(w.wdAmount, { n: ton(wd.nano, lang) })];
  if (done) lines.push(fill(w.wdWallet, { w: esc(wd.wallet) }));

  const text = [
    done ? w.wdDoneTitle : w.wdRejectTitle,
    '',
    '<blockquote>' + lines.join('\n') + '</blockquote>',
    '',
    done ? w.wdDoneNote : w.wdRejectNote
  ].join('\n');

  return send(wd.userId, text, w.open);
}

// Подарок купили на маркете: продавцу — что, за сколько и сколько дошло
export function giftSold(sale, gift) {
  const w = words(sale.seller.lang);
  const nft = sale.lot.nft;
  const name = esc((gift && gift.name) || (nft.model && nft.model.name) || '');
  const who = sale.buyer.username
    ? '<b>' + esc(sale.buyer.name) + '</b> (@' + esc(sale.buyer.username) + ')'
    : '<b>' + esc(sale.buyer.name) + '</b>';

  const text = [
    w.soldTitle,
    '',
    '<blockquote>🎀 <b>' + name + '</b> · ' + esc(nft.model && nft.model.name) + ' <b>#' + esc(nft.num) + '</b>\n' +
      fill(w.soldPrice, { n: ton(sale.lot.nano, sale.seller.lang) }) + '\n' +
      fill(w.soldPayout, { n: ton(sale.payout, sale.seller.lang) }) + '\n' +
      fill(w.soldBuyer, { who: who }) + '</blockquote>',
    '',
    w.soldNote
  ].join('\n');

  return send(sale.seller.id, text, w.open);
}
