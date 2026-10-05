/* Общие мелочи ответов */

export function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      // Ответы про людей и счета не должен кэшировать никто по пути
      'Cache-Control': 'no-store'
    }, headers || {})
  });
}

export async function body(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}
