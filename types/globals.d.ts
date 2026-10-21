/* Глобальные объекты, которых нет в типах браузера.

   Свои — `Store` (store.js), `I18N` (i18n.js) и `Local` (local.js): они
   кладутся в window одним файлом и читаются другими, поэтому tsc без
   подсказки их не находит. Чужие — библиотеки с CDN: lottie, pako,
   TON Connect, конфетти и сам Telegram.

   Файл во время работы приложения не существует: его читает только
   проверка типов (`npm run check`). Подписи пока широкие — это ярлык, а не
   описание; уточнять их имеет смысл по одному, когда до модуля доходят
   руки. */

interface Window {
  Telegram?: any;
  Store?: any;
  I18N?: any;
  Local?: any;
  lottie?: any;
  pako?: any;
  confetti?: any;
  TON_CONNECT_UI?: any;
}

declare const Store: any;
declare const I18N: any;
