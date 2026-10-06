/* Хранилище. Снаружи это простые команды — «положить», «взять», «добавить в
   список по времени». Внутри — обычный Postgres (Neon) на двух таблицах:

     kv   — что угодно по ключу: содержимое витрины, профиль, счёт
     zset — список участников с меткой времени: кто когда заходил

   Команды названы как у Redis нарочно: раньше здесь был именно он, и логика
   выше написана в этих понятиях. Так переезд на Postgres не задел ничего
   остального, а при желании вернуть Redis достаточно подменить исполнителя. */

let runner = null;
let schema = null;

export class DbError extends Error {}

// Строку подключения Vercel добавляет сам, когда база привязана к проекту.
// Имена разные у разных интеграций, поэтому перебираем известные
const URL_NAMES = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'DATABASE_URL_UNPOOLED'];

function connectionString() {
  for (const name of URL_NAMES) {
    if (process.env[name]) return process.env[name];
  }

  // Интеграция может добавить свой префикс — ищем по окончанию имени
  const key = Object.keys(process.env).find((one) =>
    URL_NAMES.some((name) => one.endsWith('_' + name)) && process.env[one]
  );

  return key ? process.env[key] : '';
}

export function configured() {
  return Boolean(runner || connectionString());
}

// Подменить исполнителя запросов: так локальный стенд гоняет тот же SQL
// на Postgres в памяти, без настоящей базы
export function useRunner(fn) {
  runner = fn;
  schema = null;
}

async function connect() {
  if (runner) return runner;

  const url = connectionString();
  if (!url) throw new DbError('not-configured');

  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(url);

  runner = (text, params) => sql.query(text, params || []);
  return runner;
}

// Таблицы заводим при первом обращении: отдельного шага установки нет, и
// пустая база поднимается сама
function ready(query) {
  if (!schema) {
    schema = query(
      'CREATE TABLE IF NOT EXISTS kv (' +
      '  k text PRIMARY KEY,' +
      '  v text NOT NULL' +
      ');'
    ).then(() => query(
      'CREATE TABLE IF NOT EXISTS zset (' +
      '  k text NOT NULL,' +
      '  m text NOT NULL,' +
      '  s double precision NOT NULL,' +
      '  PRIMARY KEY (k, m)' +
      ');'
    )).then(() => query(
      'CREATE INDEX IF NOT EXISTS zset_order ON zset (k, s DESC, m DESC);'
    )).catch((error) => {
      // Иначе неудачная попытка запомнится навсегда
      schema = null;
      throw error;
    });
  }

  return schema;
}

function rows(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : (result.rows || []);
}

function score(value) {
  if (value === '+inf') return Number.MAX_VALUE;
  if (value === '-inf') return -Number.MAX_VALUE;
  return Number(value);
}

// Отрезок списка задаётся как в Redis: с какого по какой, где −1 означает
// последний. Отрицательный конец разворачиваем в «до конца»
function slice(start, stop) {
  const from = Math.max(0, Number(start) || 0);
  const to = Number(stop);
  const limited = to >= 0;
  return { from: from, limit: limited ? Math.max(0, to - from + 1) : null };
}

async function one(query, command) {
  const [name, ...args] = command;

  switch (String(name).toUpperCase()) {
    case 'GET': {
      const found = rows(await query('SELECT v FROM kv WHERE k = $1', [args[0]]));
      return found.length ? found[0].v : null;
    }

    case 'SET': {
      const only = args.slice(2).map(String).some((flag) => flag.toUpperCase() === 'NX');
      const text = only
        // Только если такого ключа ещё нет: двум одновременным первым
        // запускам нельзя дать затереть друг друга
        ? 'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO NOTHING RETURNING k'
        : 'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v RETURNING k';
      const done = rows(await query(text, [args[0], String(args[1])]));
      return done.length ? 'OK' : null;
    }

    case 'DEL': {
      const done = rows(await query('DELETE FROM kv WHERE k = ANY($1) RETURNING k', [args]));
      return done.length;
    }

    case 'MGET': {
      const found = rows(await query('SELECT k, v FROM kv WHERE k = ANY($1)', [args]));
      const byKey = new Map(found.map((row) => [row.k, row.v]));
      // Порядок должен повторять порядок ключей, а не выдачу базы
      return args.map((key) => (byKey.has(key) ? byKey.get(key) : null));
    }

    case 'ZADD': {
      const key = args[0];
      let rest = args.slice(1);
      let only = false;
      if (String(rest[0]).toUpperCase() === 'NX') {
        only = true;
        rest = rest.slice(1);
      }

      const members = [];
      const scores = [];
      for (let i = 0; i < rest.length; i += 2) {
        scores.push(Number(rest[i]));
        members.push(String(rest[i + 1]));
      }

      // Отвечаем числом именно новых участников, как и положено команде:
      // xmax = 0 у строки, которая вставилась, а не обновилась
      const text = only
        // Первый заход не должен сдвигаться при каждом следующем
        ? 'INSERT INTO zset (k, m, s) SELECT $1, m, s FROM unnest($2::text[], $3::float8[]) AS t(m, s) ON CONFLICT (k, m) DO NOTHING RETURNING true AS added'
        : 'INSERT INTO zset (k, m, s) SELECT $1, m, s FROM unnest($2::text[], $3::float8[]) AS t(m, s) ON CONFLICT (k, m) DO UPDATE SET s = EXCLUDED.s RETURNING (xmax = 0) AS added';

      return rows(await query(text, [key, members, scores]))
        .filter((row) => row.added === true || row.added === 't').length;
    }

    case 'ZCARD': {
      const found = rows(await query('SELECT count(*)::int AS n FROM zset WHERE k = $1', [args[0]]));
      return found.length ? Number(found[0].n) : 0;
    }

    case 'ZCOUNT': {
      const found = rows(await query(
        'SELECT count(*)::int AS n FROM zset WHERE k = $1 AND s >= $2 AND s <= $3',
        [args[0], score(args[1]), score(args[2])]
      ));
      return found.length ? Number(found[0].n) : 0;
    }

    case 'ZRANGE':
    case 'ZREVRANGE': {
      const back = String(name).toUpperCase() === 'ZREVRANGE';
      const cut = slice(args[1], args[2]);
      const order = back ? 's DESC, m DESC' : 's ASC, m ASC';

      const found = rows(await query(
        'SELECT m FROM zset WHERE k = $1 ORDER BY ' + order + ' OFFSET $2' +
        (cut.limit === null ? '' : ' LIMIT $3'),
        cut.limit === null ? [args[0], cut.from] : [args[0], cut.from, cut.limit]
      ));

      return found.map((row) => row.m);
    }

    default:
      throw new DbError('unknown-command ' + name);
  }
}

export async function pipeline(commands) {
  if (!commands.length) return [];

  const query = await connect();
  await ready(query);

  const out = [];
  for (const command of commands) {
    out.push(await one(query, command));
  }
  return out;
}

export async function command(...args) {
  const [result] = await pipeline([args]);
  return result;
}
