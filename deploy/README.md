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

## Если что-то не так

```bash
systemctl status gapsgift        # жива ли служба
journalctl -u gapsgift -n 100    # что она пишет
curl -s localhost:3000/healthz   # отвечает ли приложение в обход nginx
nginx -t                         # не сломана ли настройка домена
```

Раздел «Настройки» в админке показывает то же самое с той стороны: видит ли
приложение базу и настроен ли токен бота.
