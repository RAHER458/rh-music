/**
 * Cloudflare Pages · прокси к Worker rh-music-api.
 *
 * Благодаря этому API и сайт живут на одном домене: сессионная cookie
 * становится first-party и корректно работает в Safari на iPhone
 * (сторонние cookie iOS блокирует).
 */

const API_ORIGIN = 'https://rh-music-api.rh-launcher.workers.dev';
// Preview-ветка Zvuk Popular: только не-production deployment.
const POPULAR_ORIGIN = 'https://rh-zvuk-popular-preview.rh-launcher.workers.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Служебные файлы Pages Function не отдаём как статику.
    if (url.pathname === '/_worker.js' || url.pathname.startsWith('/functions/')) {
      return new Response('Not found', { status: 404 });
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const origin = (url.pathname === '/api/home' || url.pathname === '/api/popular') ? POPULAR_ORIGIN : API_ORIGIN;
      const target = new URL(url.pathname + url.search, origin);
      const headers = new Headers(request.headers);
      headers.set('Host', new URL(origin).host);

      const init = { method: request.method, headers, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

      const upstream = await fetch(target.toString(), init);
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    }

    return env.ASSETS.fetch(request);
  },
};