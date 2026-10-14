# Свой сервер

Приложение переехало с Vercel на обычную машину. Схема простая:

```
Telegram → gapsgift.online → nginx (домен, TLS) → node server.mjs :3000 → Neon Postgres
```

`server.mjs` запускает те же файлы из `api/`, что раньше запускал Vercel, —
они написаны на обычных `Request`/`Response` и переезда не заметили. База
осталась прежней: подарки, баннеры и люди никуда не переносились.

## Разовая настройка

Делается один раз на чистой машине (Ubuntu/Debian).

```bash
# 1. Node, nginx, certbot
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-nginx

# 2. Пользователь без оболочки — служба не должна уметь логиниться
adduser --system --group --home /opt/gapsgift --no-create-home gapsgift
mkdir -p /opt/gapsgift

# 3. Переменные: строка подключения Neon и токен бота
install -m 755 deploy/gapsgift-ask /usr/local/bin/gapsgift-ask
#   дальше с рабочей машины: ssh -t root@сервер gapsgift-ask
#   команда спрашивает оба значения и ждёт — копировать их можно уже
#   после запуска, и буфер обмена ничем не перебивается

# 4. Служба
cp deploy/gapsgift.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gapsgift

# 5. Домен и сертификат
cp deploy/nginx.conf /etc/nginx/sites-available/gapsgift
ln -sf /etc/nginx/sites-available/gapsgift /etc/nginx/sites-enabled/gapsgift
rm -f /etc/nginx/sites-enabled/default
certbot certonly --webroot -w /var/www/html -d gapsgift.online
nginx -t && systemctl reload nginx
```

Сертификат Let's Encrypt живёт три месяца и продлевается сам — `certbot`
ставит для этого свой таймер, проверить можно через
`systemctl list-timers certbot`.

## Оплата звёздами

Счёт за подарок выставляет бот, а об оплате Telegram сообщает ему сам —
приходом на `/api/bot`. Адрес этого прихода надо один раз назвать Telegram:

```bash
install -m 755 deploy/gapsgift-hook /usr/local/bin/gapsgift-hook
#   дальше с рабочей машины: ssh -t root@сервер gapsgift-hook
```

Команда заводит `WEBHOOK_SECRET` в `/etc/gapsgift.env`, ставит боту webhook
с этим секретом и перезапускает службу. Токен бота она берёт оттуда же —
вставлять ничего не нужно. Без секрета `/api/bot` отвечает 404, а с чужим —
403: адрес знает только Telegram, и этого мало.

Повторять её нужно, если сменился домен или токен бота.

## Выкладка

С рабочей машины, после `git commit`:

```bash
deploy/push.sh
```

Уезжает содержимое последнего коммита, сервер сам ставит зависимости по
`package-lock.json` и перезапускает службу. Прошлый выпуск остаётся рядом в
`/opt/gapsgift.old` — откат это `mv`:

```bash
ssh root@2.27.22.4 'rm -rf /opt/gapsgift && mv /opt/gapsgift.old /opt/gapsgift && systemctl restart gapsgift'
```

## Синхронизация с телефоном

Проект правят с двух сторон: из сессии на ноутбуке и из облачной сессии с
телефона. Общая копия одна — GitHub. Чтобы ноутбук узнавал о правках с телефона
сам, на нём работает `deploy/mac-sync.sh`: раз в минуту он забирает новое с
GitHub. Если в папке есть несохранённые правки или неотправленные коммиты, он
не трогает ничего — об этом пишет в журнал.

Включается один раз:

```bash
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/online.gapsgift.sync.plist
```

Проверить и выключить:

```bash
tail -5 ~/Library/Logs/gapsgift-sync.log               # что и когда подтянулось
launchctl print gui/$UID/online.gapsgift.sync | head   # жива ли служба
launchctl bootout gui/$UID/online.gapsgift.sync        # выключить
```

Ноутбук забирает правки, только когда включён: при входе в систему и дальше
каждую минуту. Обратная сторона работает руками — закончил правку, отправь её
на GitHub, иначе телефон о ней не узнает.

## Если что-то не так

```bash
systemctl status gapsgift        # жива ли служба
journalctl -u gapsgift -n 100    # что она пишет
curl -s localhost:3000/healthz   # отвечает ли приложение в обход nginx
nginx -t                         # не сломана ли настройка домена
```

Раздел «Настройки» в админке показывает то же самое с той стороны: видит ли
приложение базу и настроен ли токен бота.
