#!/usr/bin/env bash
# Выкладка на свой сервер. Запускается с рабочей машины:
#
#     deploy/push.sh            # то, что в последнем коммите
#     deploy/push.sh <ветка>    # что-то другое
#
# Уезжает ровно содержимое коммита — ни правок из рабочей папки, ни
# node_modules, ни настроек. Зависимости сервер ставит себе сам по
# package-lock.json, поэтому на обеих сторонах они одинаковые.
set -euo pipefail

HOST="${GAPSGIFT_HOST:-root@2.27.22.4}"
DIR=/opt/gapsgift
REF="${1:-HEAD}"

cd "$(dirname "$0")/.."

echo "Выкладываю $(git rev-parse --short "$REF") на $HOST"

# Прошлый выпуск держим рядом: откатиться — это переименовать папку обратно
git archive --format=tar "$REF" | ssh "$HOST" "
  set -e
  rm -rf $DIR.new
  mkdir -p $DIR.new
  tar -x -C $DIR.new
  cd $DIR.new
  npm ci --omit=dev --no-audit --no-fund
  rm -rf $DIR.old
  [ -d $DIR ] && mv $DIR $DIR.old || true
  mv $DIR.new $DIR
  chown -R gapsgift:gapsgift $DIR
  systemctl restart gapsgift
"

# Служба поднимается за долю секунды, но дать ей эту долю надо
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' https://gapsgift.online/healthz || true)

if [ "$code" = "200" ]; then
  echo "Готово: https://gapsgift.online"
else
  echo "Сервер отвечает $code — смотрите journalctl -u gapsgift -n 50" >&2
  exit 1
fi
