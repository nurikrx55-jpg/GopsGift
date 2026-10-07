/* Анимации и картинки, загруженные из админки. Адрес у каждой загрузки
   свой и больше не меняется, поэтому кэш держим вечным: повторно файл
   отдаёт CDN, а не база. */

import zlib from 'node:zlib';
import { configured } from './_lib/db.js';
import { readFile } from './_lib/data.js';

export default {
  async fetch(request) {
    const id = new URL(request.url).searchParams.get('id') || '';
    if (!/^[a-z0-9-]{6,64}$/.test(id) || !configured()) {
      return new Response('Not found', { status: 404 });
    }

    let file;
    try {
      file = await readFile(id);
    } catch (error) {
      console.error('file:', error);
      return new Response('Unavailable', { status: 502 });
    }

    if (!file) return new Response('Not found', { status: 404 });

    const bytes = Buffer.from(file.data, 'base64');
    const lottie = file.type === 'lottie';
    const svg = file.type === 'image/svg+xml';

    const headers = {
      'Content-Type': lottie ? 'application/json; charset=utf-8' : file.type,
      'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
      'X-Content-Type-Options': 'nosniff'
    };

    // Открытый напрямую svg — это страница на нашем домене. Запрещаем ей всё,
    // кроме собственной разметки: внутри картинки код не нужен
    if (svg) {
      headers['Content-Security-Policy'] =
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
    }

    // Анимацию храним сжатой, а отдаём json: сжимать по пути Vercel умеет
    // сам, а lottie ждёт именно json
    return new Response(lottie ? zlib.gunzipSync(bytes) : bytes, { headers: headers });
  }
};
