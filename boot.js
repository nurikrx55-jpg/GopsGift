/* Запуск приложения.

   Стили и скрипты сервер отдаёт только по пропуску (`api/asset`), а пропуск
   выдаётся в обмен на свежие initData из Telegram (`api/enter`). Поэтому
   страница сперва представляется, и лишь потом к ней приезжает код. Тому,
   кто качает сайт целиком, забирать нечего: без Telegram он получит пустую
   оболочку.

   Сам этот файл остаётся открытым: он ничего не знает, кроме порядка
   запуска, — и этот порядок всё равно виден в разметке. */
(function () {
  var mode = document.currentScript && document.currentScript.dataset.code;
  var admin = mode === 'admin';

  var STYLES = admin ? ['style.css', 'admin.css'] : ['style.css'];
  // Порядок важен: store.js ждёт local.js, app.js — всех остальных
  var CODE = admin ? ['local.js', 'admin.js'] : ['i18n.js', 'local.js', 'store.js', 'app.js'];

  var LINK = 'https://t.me/GapsGiftBot/app';

  /* Пропуск идёт в адресе самого файла, а не отдельной ручкой: внутри
     style.css относительные ссылки на шрифты и узоры, и они должны
     считаться от корня сайта */
  function asset(name, pass) {
    return '/' + name + '?t=' + encodeURIComponent(pass);
  }

  function ready() {
    document.body.classList.add('ready');
  }

  /* Экран для тех, кто пришёл не из Telegram. Он нарисован прямо здесь и
     своими стилями: настоящие с сервера в этом случае не приезжают. */
  function gate() {
    var ru = String((navigator.language || 'ru')).slice(0, 2) !== 'en';
    var box = document.createElement('div');

    box.setAttribute('style', 'min-height:100vh;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:18px;padding:32px 28px;box-sizing:border-box;' +
      'text-align:center;font-family:-apple-system,SF Pro Text,Roboto,sans-serif;color:#f5f5f7');

    var title = document.createElement('h1');
    title.setAttribute('style', 'margin:0;font-size:24px;font-weight:600');
    title.textContent = ru ? 'Откройте в Telegram' : 'Open in Telegram';

    var text = document.createElement('p');
    text.setAttribute('style', 'margin:0;max-width:320px;font-size:15px;line-height:1.4;color:#a0a0a6');
    text.textContent = ru
      ? 'GapsGift открывается только в приложении Telegram — на компьютере или телефоне. Отсканируйте QR-код или нажмите кнопку ниже.'
      : 'GapsGift opens only in the Telegram app — on a computer or phone. Scan the QR code or tap the button below.';

    var qr = document.createElement('img');
    qr.src = 'gifts/qr-open.png';
    qr.alt = '';
    qr.setAttribute('style', 'width:200px;height:200px;border-radius:18px;background:#fff;padding:10px;box-sizing:border-box');

    var open = document.createElement('a');
    open.href = LINK;
    open.setAttribute('style', 'display:inline-flex;align-items:center;justify-content:center;' +
      'min-width:200px;padding:14px 22px;border-radius:999px;background:#3390ec;color:#fff;' +
      'font-size:16px;font-weight:600;text-decoration:none');
    open.textContent = ru ? 'Открыть Mini App' : 'Open Mini App';

    box.append(title, text, qr, open);
    // Разметку витрины убираем совсем: показывать её тут нечем и незачем
    document.body.textContent = '';
    document.body.appendChild(box);
    ready();
  }

  function load(pass) {
    var left = STYLES.length;

    STYLES.forEach(function (name) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = asset(name, pass);
      // Пока стили не приехали, разметка спрятана — иначе на экране
      // мелькнёт голый html
      link.onload = link.onerror = function () {
        left -= 1;
        if (left <= 0) ready();
      };
      document.head.appendChild(link);
    });

    CODE.forEach(function (name) {
      var script = document.createElement('script');
      // Добавленный из кода скрипт по умолчанию грузится вразнобой
      script.async = false;
      script.src = asset(name, pass);
      document.body.appendChild(script);
    });

    // Если стили почему-то не доехали, страница всё равно не должна
    // остаться пустой
    setTimeout(ready, 4000);
  }

  function start() {
    // Telegram кладёт свой WebApp в окно своим скриптом выше, а разметка
    // нужна целиком: ниже её либо прячут, либо заменяют воротами
    var tg = window.Telegram && window.Telegram.WebApp;

    if (!tg || !tg.initData) {
      gate();
      return;
    }

    fetch('/api/enter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: tg.initData })
    })
      .then(function (response) { return response.json(); })
      .then(function (data) {
        if (data && data.pass) load(data.pass);
        else gate();
      })
      .catch(gate);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
