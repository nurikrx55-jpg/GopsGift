# GopsGift

Telegram Mini App. Пока это заготовка: тёмная страница, текст «привет» по центру
и кнопка переключения полноэкранного режима.

Статика без сборки — ни Node, ни зависимостей не требуется.

## Структура

| Файл | Назначение |
| --- | --- |
| `index.html` | разметка, подключение `telegram-web-app.js` |
| `style.css` | тёмная тема, центрирование, safe-area отступы |
| `app.js` | инициализация Telegram SDK, fullscreen |

## Локальный просмотр

Любой статический сервер, например встроенный в Python:

```bash
python3 -m http.server 5173
```

Затем открыть http://localhost:5173. Вне Telegram кнопка fullscreen
использует обычный Fullscreen API браузера.

## Деплой

Vercel импортирует репозиторий как статический проект: framework preset
«Other», build command пустой, output directory — корень. Каждый push в `main`
уходит в продакшн.

## Привязка к боту

1. @BotFather → `/mybots` → бот → **Bot Settings** → **Menu Button** → указать URL с Vercel.
2. Либо `/newapp` для отдельного Mini App с прямой ссылкой.

Fullscreen работает в Telegram-клиентах с Bot API 8.0 и выше; на старых
версиях кнопка переключает полноэкранный режим средствами браузера.

## Токен бота

В репозитории его нет и быть не должно. Токен нужен только серверной части —
храни его в переменных окружения (`.env` локально, Environment Variables в
Vercel). Если токен попал в чат, переписку или коммит — отзови его через
@BotFather (**API Token** → **Revoke current token**).
