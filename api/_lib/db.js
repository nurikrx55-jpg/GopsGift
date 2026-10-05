/* Upstash Redis через REST: ни драйвера, ни зависимостей — обычный fetch.
   Все команды идут пачкой в /pipeline: одна поездка по сети вместо многих. */

const URL_NAMES = ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL'];
const TOKEN_NAMES = ['UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN'];

export class DbError extends Error {}

// При подключении базы Vercel может приклеить к переменным свой префикс
// (STORAGE_KV_REST_API_URL и т. п.), поэтому ищем и по окончанию имени
function pick(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }

  const key = Object.keys(process.env).find((one) =>
    names.some((name) => one.endsWith('_' + name)) && process.env[one]
  );

  return key ? process.env[key] : '';
}

export function configured() {
  return Boolean(pick(URL_NAMES) && pick(TOKEN_NAMES));
}

export async function pipeline(commands) {
  if (!commands.length) return [];

  const url = pick(URL_NAMES);
  const token = pick(TOKEN_NAMES);
  if (!url || !token) throw new DbError('not-configured');

  const response = await fetch(url.replace(/\/+$/, '') + '/pipeline', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(commands)
  });

  if (!response.ok) throw new DbError('db-http-' + response.status);

  const results = await response.json();
  return results.map((one) => {
    if (one && one.error) throw new DbError(one.error);
    return one ? one.result : null;
  });
}

export async function command(...args) {
  const [result] = await pipeline([args]);
  return result;
}
