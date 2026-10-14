#!/usr/bin/env bash
# Держит копию на рабочей машине свежей: раз в минуту забирает с GitHub то,
# что пришло с телефона (облачная сессия) или с другой машины.
#
# Запускается сам — службой launchd, см. «Синхронизация с телефоном» в
# deploy/README.md. Руками полезно для проверки:
#
#     deploy/mac-sync.sh
#
# Осторожность важнее свежести: тянем только то, что ложится поверх нашей
# истории без слияния, и только когда в папке нет незаконченной работы.
# Во всех остальных случаях ничего не делаем и пишем в журнал — разберёт
# человек.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

LOG="$HOME/Library/Logs/gapsgift-sync.log"
mkdir -p "$(dirname "$LOG")"

say() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG"
  # Журнал не должен расти вечно: держим последние 500 строк
  tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
}

# Ключ лежит у человека, пароля на нём нет. Спрашивать всё равно некого:
# служба работает без экрана, поэтому любой вопрос — это ошибка, а не пауза
export GIT_SSH_COMMAND='ssh -o BatchMode=yes'
export GIT_TERMINAL_PROMPT=0

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
[ "$branch" = "main" ] || { say "пропуск: ветка $branch, а не main"; exit 0; }

git fetch -q origin main 2>>"$LOG" || { say "GitHub недоступен"; exit 0; }

local_head=$(git rev-parse HEAD)
remote_head=$(git rev-parse origin/main)
[ "$local_head" = "$remote_head" ] && exit 0

# Наши коммиты ещё не отправлены — забирать поверх них нельзя
if [ -n "$(git rev-list origin/main..HEAD)" ]; then
  say "пропуск: на машине есть неотправленные коммиты"
  exit 0
fi

# Незаконченная правка в папке важнее свежести: её легко потерять
if [ -n "$(git status --porcelain)" ]; then
  say "пропуск: в папке есть несохранённые правки"
  exit 0
fi

if git merge --ff-only -q origin/main 2>>"$LOG"; then
  say "обновлено до $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
else
  say "не удалось обновиться — разберите вручную"
fi
