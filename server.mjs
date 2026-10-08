/* Боевой сервер на своей машине.

   Раньше приложение жило на Vercel: статику раздавал их CDN, а файлы из
   api/ он запускал сам. Здесь это делает один процесс Node — те же модули,
   тот же Request/Response, никаких правок в api/ не понадобилось.

   Снаружи стоит nginx: он держит домен и TLS, а сюда ходит на localhost.
   Поэтому слушаем только петлю — порт наружу не торчит. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// api/_lib/data.js читает запасное содержимое от текущей папки
process.chdir(ROOT);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp4': 'video/mp4',
  '.tgs': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8'
};

// Картинки, шрифты и анимации из репозитория не меняются между выкладками —
// их можно держать в кэше неделю. Разметку, стили и скрипты браузер каждый
// раз переспрашивает и в ответ обычно получает «не изменилось»
const STABLE = ['gifts/', 'home/', 'fonts/'];

// Наружу уходит только то, что нужно странице. Исходники сервера, зависимости
// и настройки под раздачу не попадают, даже если кто-то угадает имя
const HIDDEN = ['api/', 'node_modules/', 'data/', 'deploy/', '.git/', '.claude/'];
const PRIVATE = ['server.mjs', 'package.json', 'package-lock.json', 'vercel.json', 'README.md'];

// Запасное содержимое приложению всё-таки нужно: по нему витрина
// поднимается, пока база не ответила
const ALLOWED = ['data/content.json'];

const handlers = new Map();

async function loadHandlers() {
  const dir = path.join(ROOT, 'api');
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const name = file.slice(0, -3);
    const mod = await import(path.join(dir, file));
    if (mod.default && typeof mod.default.fetch === 'function') {
      handlers.set(name, mod.default);
    }
  }
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}

function hidden(rel) {
  if (ALLOWED.includes(rel)) return false;
  if (PRIVATE.includes(rel)) return true;
  if (rel.split('/').some((part) => part.startsWith('.'))) return true;
  return HIDDEN.some((dir) => rel === dir.slice(0, -1) || rel.startsWith(dir));
}

function serveFile(req, res, rel) {
  const file = path.join(ROOT, rel);

  let stat;
  try {
    stat = fs.statSync(file);
  } catch (_) {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (!stat.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });

  const stable = STABLE.some((dir) => rel.startsWith(dir));
  const tag = '"' + stat.size.toString(36) + '-' + Math.round(stat.mtimeMs).toString(36) + '"';

  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'ETag': tag,
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': stable ? 'public, max-age=604800' : 'no-cache'
  };

  // Браузер прислал ту же метку — отвечаем «не изменилось» и не гоняем файл
  if (req.headers['if-none-match'] === tag) {
    delete headers['Content-Length'];
    return send(res, 304, '', headers);
  }

  if (req.method === 'HEAD') return send(res, 200, '', headers);

  res.writeHead(200, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers));
  fs.createReadStream(file).pipe(res);
}

async function serveApi(req, res, name, url, raw) {
  const mod = handlers.get(name);
  if (!mod) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });

  // За nginx настоящий адрес страницы — https и наш домен. Функции из api/
  // строят по нему свои ответы, поэтому отдаём им именно его
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || HOST + ':' + PORT;
  const full = new URL(url.pathname + url.search, proto + '://' + host);

  const request = new Request(full, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw
  });

  const response = await mod.fetch(request);
  const headers = Object.fromEntries(response.headers.entries());
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || HOST));
  } catch (_) {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  try {
    if (url.pathname === '/healthz') {
      return send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    }

    const api = /^\/api\/([a-z][a-z0-9-]*)$/.exec(url.pathname);
    if (api) return await serveApi(req, res, api[1], url, Buffer.concat(chunks));

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    // Путь не должен уводить выше папки проекта ни точками, ни ссылками
    const target = path.resolve(ROOT, rel);
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    }

    rel = path.relative(ROOT, target).split(path.sep).join('/');
    if (hidden(rel)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });

    serveFile(req, res, rel);
  } catch (error) {
    console.error(req.method, url.pathname, error);
    if (!res.headersSent) send(res, 500, 'Server error', { 'Content-Type': 'text/plain; charset=utf-8' });
    else res.end();
  }
});

await loadHandlers();

// systemd останавливает службу сигналом: дорабатываем начатые запросы и выходим
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

server.listen(PORT, HOST, () => {
  console.log('GapsGift на http://' + HOST + ':' + PORT);
});
