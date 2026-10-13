/* Язык приложения.

   Все надписи живут здесь, а не в разметке и не в коде экранов. Разметка
   помечает свои места атрибутом data-i18n, код спрашивает строку по ключу.
   Добавить язык — значит добавить сюда один блок: ни html, ни app.js
   трогать не придётся.

   Выбор помнится в самом браузере. Первый раз берём его у Telegram: у кого
   клиент на русском — тому русский, остальным английский. */
(() => {
  'use strict';

  const KEY = 'gg:lang';

  // Порядок здесь — порядок в списке выбора
  const LANGS = [
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'ru', name: 'Русский', flag: '🇷🇺' }
  ];

  // Какую форму слова брать при числе. У русского их три, у английского две
  const FORMS = {
    ru: (n) => {
      const hundred = n % 100;
      const ten = n % 10;
      if (hundred >= 11 && hundred <= 14) return 'many';
      if (ten === 1) return 'one';
      if (ten >= 2 && ten <= 4) return 'few';
      return 'many';
    },
    en: (n) => (n === 1 ? 'one' : 'many')
  };

  const WORDS = {
    ru: {
      'nav.home': 'Главная',
      'nav.tasks': 'Задания',
      'nav.staking': 'Стейкинг',
      'nav.profile': 'Профиль',
      'nav.aria': 'Навигация',
      'nav.gems': 'GetGems',

      'hdr.coupons': 'купонов',
      'hdr.stars': 'звёзд',

      'slider.aria': 'Баннеры',
      'slider.one': 'Баннер',

      'scope.all': 'Все подарки',
      'scope.left': 'В наличии',
      'scope.out': 'Распроданы',
      'sort.new': 'Новые',
      'sort.cheap': 'Сначала дешёвые',
      'sort.dear': 'Сначала дорогие',
      'sort.rest': 'Скоро закончатся',
      'filter.hideSold': 'Скрыть проданные подарки',
      'sort.rare': 'Сначала редкие',

      'pick.scope': 'Показывать',
      'pick.sort': 'Порядок',
      'pick.cancel': 'Отмена',
      'pick.apply': 'Применить',

      'gifts.none': 'Под этот отбор ничего нет',
      'gifts.empty': 'Витрина пока пустая',
      'gifts.failed': 'Витрина не загрузилась',
      'gifts.retry': 'Повторить',
      'gifts.more': 'Показать ещё',

      'gift.note': 'Подарок скоро можно будет улучшить, продать и выпустить как NFT',
      'gift.supply': 'Наличие',
      'gift.price': 'Цена',
      'gift.status': 'Статус',
      'gift.owner': 'Владелец',
      'gift.issued': '{done}/{total} выпущено',
      'gift.left': 'осталось {n}',
      'gift.left.aria': 'Осталось {n} из {total}',
      'gift.of': '{done} из {total}',
      'gift.buy': 'Купить',
      'gift.top': 'Топ покупателей',
      'gift.emoji': 'Поставить в статус',
      'gift.free': 'Взять бесплатно',
      'gift.less': 'Убрать один',
      'gift.more': 'Добавить один',
      'gift.share': 'Поделиться',
      'gift.close': 'Закрыть',
      'gift.upgrade': 'Улучшить',
      'gift.toMarket': 'Перейти в маркет',
      'gift.value': 'Ценность',
      'gift.withdraw': 'Вывести',
      'gift.craft': 'Крафт',
      'gift.shareText': 'Посмотри подарок «{name}» в GapsGift!',
      'gift.shareMine': 'Посмотри мой подарок «{name}» в GapsGift!',
      'gift.model': 'Модель',
      'gift.symbol': 'Символ',
      'gift.backdrop': 'Фон',
      'upg.no': 'Этот подарок не поддерживает улучшение',
      'upg.gone': 'Этого подарка у вас больше нет',
      'upg.done': 'Подарок улучшен',
      'gift.send': 'Отправить',
      'gift.copy': 'Скопировать ссылку',
      'gift.count': { one: 'подарок', few: 'подарка', many: 'подарков' },
      'gift.coupons': 'Списать купоны',
      'gift.couponsHave': 'у вас {n}',

      'task.reward.aria': 'Награда: {n} купонов',
      'task.start': 'Начать',
      'task.claim': 'Забрать',
      'task.claimed': '+{n} купонов',

      'profile.gifts': 'Подарки',
      'profile.admin': 'Админка',
      'profile.guest': 'Гость',
      'profile.noname': 'Без имени',
      'profile.copyId': 'Скопировать id',
      'profile.empty': 'Нет подарков(',
      'profile.emptyNft': 'Нет NFT(',
      'profile.emptyNote': 'Подарки можно покупать в',
      'profile.nftNote': 'NFT живут в',
      'profile.market': 'Маркет',
      'profile.idCopied': 'ID скопирован',
      'profile.linkCopied': 'Ссылка скопирована',
      'profile.connect': 'Подключить кошелек',
      'profile.wallet': 'Кошелёк',
      'profile.referral': 'Реферальная программа',
      'profile.top': 'Топ',
      'profile.crafts': 'Крафты',
      'wallet.sent': 'Перевод отправлен — зачислим, как только он дойдёт',
      'wallet.credited': 'Зачислено {n} TON',
      'wallet.statusDeposit': 'Пополнение',
      'wallet.statusWithdraw': 'Вывод',
      'wallet.statusGift': 'Покупка',
      'gift.payTon': 'Оплатить TON',
      'gift.tonHave': 'На балансе {n} TON',
      'pay.tonlow': 'Не хватает TON на балансе',
      'pay.tonoff': 'Оплата TON пока не включена',
      'wallet.unlinkTitle': 'Отвязка кошелька',
      'wallet.unlinkText': 'Нажмите на кнопку, чтобы подтвердить отвязку кошелька.',
      'wallet.unlink': 'Отвязать',
      'wallet.unlinked': 'Кошелёк отвязан',
      'wallet.linked': 'Кошелёк подключён',
      'wallet.linkFail': 'Кошелёк не подключился',
      'wallet.notConnected': 'Кошелек не подключен',
      'wallet.connect': 'Подключить',
      'wallet.deposit': 'Внести',
      'wallet.withdraw': 'Вывести',
      'wallet.depositTitle': 'Внести баланс',
      'wallet.withdrawTitle': 'Вывести баланс',
      'wallet.withdrawInfo': 'Вывод на кошелек с TAG/MEMO не поддерживается!',
      'wallet.balance': 'Баланс',
      'wallet.history': 'История',
      'wallet.tabAll': 'Все',
      'wallet.tabGifts': 'Подарки',
      'wallet.tabDeposits': 'Пополнения',
      'wallet.tabWithdrawals': 'Выводы',
      'wallet.historyEmpty': 'Пока нет операций',
      'wallet.loading': 'Кошелёк ещё загружается, попробуйте через секунду',
      'wallet.soonDeposit': 'Пополнение скоро заработает',
      'wallet.soonWithdraw': 'Вывод скоро заработает',
      'wallet.withdrawSent': 'Заявка на вывод принята',
      'wallet.wdPending': 'В обработке',
      'wallet.wdDone': 'Выведено',
      'wallet.wdRejected': 'Отклонено',
      'wallet.needConnect': 'Сначала подключите кошелёк',
      'task.check': 'Проверить',
      'profile.gemsSoonTitle': 'Скоро на GetGems',
      'profile.gemsSoon': 'Скоро вы сможете продавать свои подарки на GetGems',
      'gate.title': 'Откройте в Telegram',
      'gate.text': 'GapsGift работает только в приложении Telegram — на компьютере или телефоне. В браузере и в веб-версии Telegram он не открывается.',
      'gate.open': 'Открыть в Telegram',
      'ref.title': 'Пригласи друзей',
      'ref.descr': 'Поделись ссылкой — друзья появятся в списке ниже',
      'ref.yourLink': 'Твоя ссылка',
      'ref.copy': 'Копировать',
      'ref.share': 'Поделиться',
      'ref.referrals': 'Рефералы',
      'ref.none': 'Пока никто не перешёл по твоей ссылке',
      'ref.invite': 'Пригласить друзей',
      'ref.copied': 'Ссылка скопирована',
      'ref.idCopied': 'ID скопирован',
      'ref.message': 'Лучшее приложение мем-подарков и NFT ❤️',
      'ref.noLink': 'Ссылка пока недоступна',
      'send.recipient': 'Получатель',
      'send.clear': 'Очистить получателя',
      'send.placeholder': 'Имя, @юзернейм или Telegram ID',
      'send.for': 'Отправить за',
      'send.sending': 'Отправляем…',
      'send.select': 'Выбрать',
      'send.empty': 'Пользователи не найдены',
      'send.error': 'Не удалось найти пользователей. Попробуйте ещё раз.',
      'send.self': 'Вы не можете отправить самому себе.',
      'send.done': 'Подарок отправлен · {name}',
      'send.fail': 'Не удалось отправить подарок',
      'profile.clearAll': 'Очистить',
      'profile.collections': '{n} коллекции',
      'profile.modelTitle': 'Модель подарка',
      'osort.title': 'Сортировка',
      'osort.latest': 'Последние',
      'osort.oldest': 'Старые',
      'osort.on_market': 'На продаже',
      'osort.price_high': 'Цена: Высокая к Низкой',
      'osort.price_low': 'Цена: Низкая к Высокой',
      'osort.upgraded': 'Улучшенные',
      'osort.not_upgraded': 'Не улучшенные',
      'profile.filter': 'Фильтр',
      'profile.collection': 'Коллекция',
      'profile.model': 'Модель',
      'profile.symbol': 'Символ',
      'profile.backdrop': 'Фон',
      'profile.view': 'Вид списка',

      'lang.title': 'Язык',

      'stake.total': 'В стейкинге',
      'stake.day': 'Доход за день',
      'stake.earned': 'Заработано',
      'stake.apy': '{n}% годовых',
      'stake.tier.legend': 'Легендарные',
      'stake.tier.epic': 'Эпические',
      'stake.tier.rare': 'Редкие',
      'stake.tier.plain': 'Обычные',
      'stake.put': 'Поставить',
      'stake.empty': 'Ставить пока нечего',
      'stake.emptyNote': 'Купите подарок на витрине — и он начнёт приносить доход',
      'stake.toShelf': 'На витрину',
      'stake.how': 'Как это работает',
      'stake.how1': 'Ставите подарок. Он остаётся вашим, но уходит под замок на выбранный срок',
      'stake.how2': 'Каждый день на счёт капают звёзды — по ставке его редкости',
      'stake.how3': 'Срок вышел: забираете подарок и всё, что он принёс',
      'stake.term': 'Срок',
      'stake.days': { one: 'день', few: 'дня', many: 'дней' },
      'stake.rate': 'Ставка',
      'stake.income': 'Доход за срок',
      'stake.info': 'О стейкинге',
      'stake.out': 'Вывод',
      'stake.again': 'Реинвестировать',
      'stake.ok': 'Понятно',
      'stake.add': 'Добавить подарок',
      'stake.choose': 'Выберите подарок',
      'stake.min': 'Ставить можно подарки от {n} звёзд',
      'stake.cheap': 'Слишком дешёвый подарок',
      'stake.list': 'Ваши ставки',
      'stake.ribbon': 'Staking',
      'stake.frozen': 'Заморожен до {date}',
      'stake.until': 'До {date}',
      'stake.daysLeft': { one: 'остался {n} день', few: 'осталось {n} дня', many: 'осталось {n} дней' },
      'stake.over': 'Срок вышел',
      'stake.saved': 'Подарок в стейкинге',
      'stake.now': 'Накоплено',
      'stake.warnTitle': 'Подарок уйдёт в стейкинг',
      'stake.warnText': 'Пока срок не вышел, забрать его обратно нельзя. Всё это время его не будет и в профиле.',
      'stake.warnGo': 'Поставить',
      'stake.go': 'Поставить в стейкинг',
      'stake.wait': 'Стейкинг скоро заработает',

      'soon.send': 'Отправка скоро заработает',
      'soon.share': 'Поделиться скоро заработает',
      'soon.emoji': 'Статус скоро заработает',
      'soon.gems': 'Очень скоро..',

      'won.one': 'Подарок куплен',
      'won.many': 'Подарки куплены',
      'won.noteOne': 'Отправьте свой подарок!',
      'won.noteMany': 'Отправьте свои подарки!',
      'won.go': 'Открыть профиль',

      'pay.noDb': 'Оплата заработает, когда подключена база',
      'pay.oldApp': 'Обновите Telegram — оплата из приложения ему пока не по силам',
      'pay.failed': 'Платёж не прошёл',
      'pay.slow': 'Оплачено. Подарок вот-вот появится в профиле',
      'pay.sorry': 'Оплата не вышла',
      'pay.off': 'Оплата сейчас недоступна',

      // Отказы сервера: он присылает их кодом, слова — наши
      'pay.gone': 'Такого подарка больше нет',
      'pay.free': 'Этот подарок не продаётся',
      'pay.left': 'Осталось всего {n}',
      'pay.soldout': 'Подарок распродан',
      'pay.toomuch': 'Столько звёзд за один раз Telegram не примет',
      'pay.noorder': 'Заказ не найден',
      'pay.nohook': 'Оплата на сервере ещё не включена'
    },

    en: {
      'nav.home': 'Home',
      'nav.tasks': 'Tasks',
      'nav.staking': 'Staking',
      'nav.profile': 'Profile',
      'nav.aria': 'Navigation',
      'nav.gems': 'GetGems',

      'hdr.coupons': 'coupons',
      'hdr.stars': 'stars',

      'slider.aria': 'Banners',
      'slider.one': 'Banner',

      'scope.all': 'All gifts',
      'scope.left': 'In stock',
      'scope.out': 'Sold out',
      'sort.new': 'Newest',
      'sort.cheap': 'Cheapest first',
      'sort.dear': 'Priciest first',
      'sort.rest': 'Running out',
      'filter.hideSold': 'Hide sold gifts',
      'sort.rare': 'Rarest first',

      'pick.scope': 'Show',
      'pick.sort': 'Order',
      'pick.cancel': 'Cancel',
      'pick.apply': 'Apply',

      'gifts.none': 'Nothing matches this filter',
      'gifts.empty': 'The shelf is empty for now',
      'gifts.failed': 'The shelf did not load',
      'gifts.retry': 'Try again',
      'gifts.more': 'Show more',

      'gift.note': 'This gift will soon be upgradable, sellable and mintable as an NFT',
      'gift.supply': 'Supply',
      'gift.price': 'Price',
      'gift.status': 'Status',
      'gift.owner': 'Owner',
      'gift.issued': '{done}/{total} issued',
      'gift.left': '{n} left',
      'gift.left.aria': '{n} of {total} left',
      'gift.of': '{done} of {total}',
      'gift.buy': 'Buy',
      'gift.top': 'Top buyers',
      'gift.emoji': 'Set as status',
      'gift.free': 'Take for free',
      'gift.less': 'One less',
      'gift.more': 'One more',
      'gift.share': 'Share',
      'gift.close': 'Close',
      'gift.upgrade': 'Upgrade',
      'gift.toMarket': 'Go to market',
      'gift.value': 'Value',
      'gift.withdraw': 'Withdraw',
      'gift.craft': 'Craft',
      'gift.shareText': 'Check out the "{name}" gift on GapsGift!',
      'gift.shareMine': 'Check out my "{name}" gift on GapsGift!',
      'gift.model': 'Model',
      'gift.symbol': 'Symbol',
      'gift.backdrop': 'Background',
      'upg.no': "This gift doesn't support upgrades",
      'upg.gone': 'You no longer have this gift',
      'upg.done': 'Gift upgraded',
      'gift.send': 'Send',
      'gift.copy': 'Copy link',
      'gift.count': { one: 'gift', many: 'gifts' },
      'gift.coupons': 'Spend coupons',
      'gift.couponsHave': 'you have {n}',

      'task.reward.aria': 'Reward: {n} coupons',
      'task.start': 'Start',
      'task.claim': 'Claim',
      'task.claimed': '+{n} coupons',

      'profile.gifts': 'Gifts',
      'profile.admin': 'Admin',
      'profile.guest': 'Guest',
      'profile.noname': 'No name',
      'profile.copyId': 'Copy id',
      'profile.empty': 'No gifts(',
      'profile.emptyNft': 'No NFTs(',
      'profile.emptyNote': 'Gifts can be bought on the',
      'profile.nftNote': 'NFTs live on',
      'profile.market': 'Market',
      'profile.idCopied': 'ID copied',
      'profile.linkCopied': 'Link copied',
      'profile.connect': 'Connect wallet',
      'profile.wallet': 'Wallet',
      'profile.referral': 'Referral program',
      'profile.top': 'Top',
      'profile.crafts': 'Crafts',
      'wallet.sent': 'Transfer sent — we will credit it as soon as it arrives',
      'wallet.credited': '{n} TON credited',
      'wallet.statusDeposit': 'Deposit',
      'wallet.statusWithdraw': 'Withdrawal',
      'wallet.statusGift': 'Purchase',
      'gift.payTon': 'Pay with TON',
      'gift.tonHave': '{n} TON on balance',
      'pay.tonlow': 'Not enough TON on balance',
      'pay.tonoff': 'TON payments are not enabled yet',
      'wallet.unlinkTitle': 'Disconnect wallet',
      'wallet.unlinkText': 'Tap the button to confirm disconnecting the wallet.',
      'wallet.unlink': 'Disconnect',
      'wallet.unlinked': 'Wallet disconnected',
      'wallet.linked': 'Wallet connected',
      'wallet.linkFail': 'Wallet not connected',
      'wallet.notConnected': 'Wallet not connected',
      'wallet.connect': 'Connect',
      'wallet.deposit': 'Deposit',
      'wallet.withdraw': 'Withdraw',
      'wallet.depositTitle': 'Deposit balance',
      'wallet.withdrawTitle': 'Withdraw balance',
      'wallet.withdrawInfo': 'Withdrawals to wallets with TAG/MEMO are not supported!',
      'wallet.balance': 'Balance',
      'wallet.history': 'History',
      'wallet.tabAll': 'All',
      'wallet.tabGifts': 'Gifts',
      'wallet.tabDeposits': 'Deposits',
      'wallet.tabWithdrawals': 'Withdrawals',
      'wallet.historyEmpty': 'No operations yet',
      'wallet.loading': 'The wallet is still loading, try again in a second',
      'wallet.soonDeposit': 'Deposits are coming soon',
      'wallet.soonWithdraw': 'Withdrawals are coming soon',
      'wallet.withdrawSent': 'Withdrawal request sent',
      'wallet.wdPending': 'Processing',
      'wallet.wdDone': 'Sent',
      'wallet.wdRejected': 'Rejected',
      'wallet.needConnect': 'Connect a wallet first',
      'task.check': 'Check',
      'profile.gemsSoonTitle': 'Coming to GetGems',
      'profile.gemsSoon': 'Soon you will be able to sell your gifts on GetGems',
      'gate.title': 'Open in Telegram',
      'gate.text': 'GapsGift works only in the Telegram app — on desktop or phone. It does not open in a browser or in Telegram Web.',
      'gate.open': 'Open in Telegram',
      'ref.title': 'Invite friends',
      'ref.descr': 'Share your link — friends will appear in the list below',
      'ref.yourLink': 'Your link',
      'ref.copy': 'Copy',
      'ref.share': 'Share',
      'ref.referrals': 'Referrals',
      'ref.none': 'Nobody has followed your link yet',
      'ref.invite': 'Invite friends',
      'ref.copied': 'Link copied',
      'ref.idCopied': 'ID copied',
      'ref.message': 'The best app for meme gifts and NFTs ❤️',
      'ref.noLink': 'The link is not available yet',
      'send.recipient': 'Recipient',
      'send.clear': 'Clear recipient',
      'send.placeholder': 'Name, @username or Telegram ID',
      'send.for': 'Send for',
      'send.sending': 'Sending…',
      'send.select': 'Select',
      'send.empty': 'No users found',
      'send.error': 'Could not find users. Please try again.',
      'send.self': 'You cannot send to yourself.',
      'send.done': 'Gift sent · {name}',
      'send.fail': 'Could not send the gift',
      'profile.clearAll': 'Clear',
      'profile.collections': '{n} collections',
      'profile.modelTitle': 'Gift model',
      'osort.title': 'Sort',
      'osort.latest': 'Latest',
      'osort.oldest': 'Oldest',
      'osort.on_market': 'On Market',
      'osort.price_high': 'Price: High to Low',
      'osort.price_low': 'Price: Low to High',
      'osort.upgraded': 'Upgraded',
      'osort.not_upgraded': 'Not upgraded',
      'profile.filter': 'Filter',
      'profile.collection': 'Collection',
      'profile.model': 'Model',
      'profile.symbol': 'Symbol',
      'profile.backdrop': 'Backdrop',
      'profile.view': 'List view',

      'lang.title': 'Language',

      'stake.total': 'Staked',
      'stake.day': 'Per day',
      'stake.earned': 'Earned',
      'stake.apy': '{n}% a year',
      'stake.tier.legend': 'Legendary',
      'stake.tier.epic': 'Epic',
      'stake.tier.rare': 'Rare',
      'stake.tier.plain': 'Common',
      'stake.put': 'Stake',
      'stake.empty': 'Nothing to stake yet',
      'stake.emptyNote': 'Buy a gift on the shelf and it will start earning',
      'stake.toShelf': 'To the shelf',
      'stake.how': 'How it works',
      'stake.how1': 'You stake a gift. It stays yours, but it is locked for the term you pick',
      'stake.how2': 'Stars land on your account every day, at the rate of its rarity',
      'stake.how3': 'When the term is up, you take back the gift and everything it earned',
      'stake.term': 'Term',
      'stake.days': { one: 'day', many: 'days' },
      'stake.rate': 'Rate',
      'stake.income': 'Income over the term',
      'stake.info': 'About staking',
      'stake.out': 'Withdraw',
      'stake.again': 'Reinvest',
      'stake.ok': 'Got it',
      'stake.add': 'Add a gift',
      'stake.choose': 'Choose a gift',
      'stake.min': 'Gifts from {n} stars and up can be staked',
      'stake.cheap': 'Too cheap to stake',
      'stake.list': 'Your stakes',
      'stake.ribbon': 'Staking',
      'stake.frozen': 'Frozen until {date}',
      'stake.until': 'Until {date}',
      'stake.daysLeft': { one: '{n} day left', many: '{n} days left' },
      'stake.over': 'The term is up',
      'stake.saved': 'The gift is staked',
      'stake.now': 'Earned so far',
      'stake.warnTitle': 'The gift goes into staking',
      'stake.warnText': 'Until the term is up you cannot take it back. It will be out of your profile all that time.',
      'stake.warnGo': 'Stake it',
      'stake.go': 'Stake the gift',
      'stake.wait': 'Staking is coming soon',

      'soon.send': 'Sending is coming soon',
      'soon.share': 'Sharing is coming soon',
      'soon.emoji': 'Status is coming soon',
      'soon.gems': 'Very soon..',

      'won.one': 'Gift bought',
      'won.many': 'Gifts bought',
      'won.noteOne': 'Send your gift!',
      'won.noteMany': 'Send your gifts!',
      'won.go': 'Open profile',

      'pay.noDb': 'Payments will work once the database is connected',
      'pay.oldApp': 'Update Telegram — it cannot pay inside the app yet',
      'pay.failed': 'The payment did not go through',
      'pay.slow': 'Paid. The gift will be in your profile in a moment',
      'pay.sorry': 'The payment did not work out',
      'pay.off': 'Payments are unavailable right now',

      'pay.gone': 'This gift is gone',
      'pay.free': 'This gift is not for sale',
      'pay.left': 'Only {n} left',
      'pay.soldout': 'The gift is sold out',
      'pay.toomuch': 'Telegram will not take that many stars at once',
      'pay.noorder': 'Order not found',
      'pay.nohook': 'Payments are not switched on yet'
    }
  };

  function known(code) {
    return LANGS.some((one) => one.code === code);
  }

  function guess() {
    try {
      const saved = localStorage.getItem(KEY);
      if (known(saved)) return saved;
    } catch (_) {}

    const tg = window.Telegram && window.Telegram.WebApp;
    const user = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    const from = String((user && user.language_code) || navigator.language || '').slice(0, 2);

    return from === 'ru' ? 'ru' : 'en';
  }

  let lang = guess();

  // Пропуск: в словаре нет — отдаём ключ. Лучше увидеть ключ на экране, чем
  // пустоту, и сразу понятно, чего не хватает
  function raw(key) {
    const here = WORDS[lang] || {};
    if (key in here) return here[key];
    const back = WORDS.en;
    return key in back ? back[key] : key;
  }

  function fill(text, vars) {
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, (whole, name) =>
      (name in vars ? String(vars[name]) : whole));
  }

  function t(key, vars) {
    const value = raw(key);
    return fill(typeof value === 'string' ? value : key, vars);
  }

  // Слово при числе: «1 подарок», «2 подарка», «5 gifts»
  function count(n, key) {
    const forms = raw(key);
    if (!forms || typeof forms === 'string') return String(forms || key);

    const rule = FORMS[lang] || FORMS.en;
    const form = rule(Math.abs(Number(n) || 0));
    return forms[form] || forms.many || forms.one || key;
  }

  // Надписи в самой разметке: data-i18n ставит текст, data-i18n-aria —
  // подпись для чтения с экрана, data-i18n-alt — подпись картинки
  function apply(root) {
    const where = root || document;

    where.querySelectorAll('[data-i18n]').forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });

    where.querySelectorAll('[data-i18n-aria]').forEach((node) => {
      node.setAttribute('aria-label', t(node.dataset.i18nAria));
    });

    where.querySelectorAll('[data-i18n-alt]').forEach((node) => {
      node.setAttribute('alt', t(node.dataset.i18nAlt));
    });

    where.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
    });

    document.documentElement.lang = lang;
  }

  const watchers = [];

  function set(code) {
    if (!known(code) || code === lang) return false;

    lang = code;
    try {
      localStorage.setItem(KEY, code);
    } catch (_) {}

    apply();
    watchers.forEach((run) => run(code));
    return true;
  }

  window.I18N = {
    t: t,
    count: count,
    apply: apply,
    set: set,
    langs: () => LANGS.slice(),
    lang: () => lang,
    one: () => LANGS.find((item) => item.code === lang) || LANGS[0],
    // Кого позвать, когда язык сменили: экраны перерисовывают себя сами
    onChange: (run) => watchers.push(run)
  };

  // Скрипт стоит перед разметкой экранов — первый проход делаем, когда она
  // уже есть
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => apply(), { once: true });
  } else {
    apply();
  }
})();
