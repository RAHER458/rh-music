/**
 * Cloudflare Pages · прокси к Worker rh-music-api.
 *
 * Благодаря этому API и сайт живут на одном домене: сессионная cookie
 * становится first-party и корректно работает в Safari на iPhone
 * (сторонние cookie iOS блокирует).
 *
 * Здесь же выставляются заголовки безопасности для статики: Direct Upload
 * не всегда применяет web/_headers, поэтому HSTS/CSP гарантируются на уровне
 * Pages Function.
 */

const API_ORIGIN = 'https://rh-music-api.rh-launcher.workers.dev';

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://accounts.google.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://cdn-image.zvuk.com https://*.zvuk.com https://*.sndcdn.com https://*.googleusercontent.com",
    "media-src 'self' blob: https://*.soundcloud.cloud",
    "connect-src 'self' https://accounts.google.com https://*.soundcloud.cloud",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "frame-src https://accounts.google.com",
    'upgrade-insecure-requests',
  ].join('; '),
};

function withSecurity(headers, stripCors = false) {
  // временная диагностика схемы (удаляется сразу после проверки)

  const out = new Headers(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!out.has(name)) out.set(name, value);
  }
  // диагностика
  // (см. ниже: headers пробрасываются как есть)
  if (stripCors) {
    // Статика не должна отдавать CORS-wildcard: API живёт на том же домене.
    out.delete('Access-Control-Allow-Origin');
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return new Response(null, { status: 301, headers: { Location: url.toString(), ...SECURITY_HEADERS } });
    }
    // Служебные файлы Pages Function не отдаём как статику.
    if (url.pathname === '/_worker.js' || url.pathname.startsWith('/functions/')) {
      return new Response('Not found', { status: 404, headers: withSecurity({}, true) });
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const target = new URL(url.pathname + url.search, API_ORIGIN);
      const headers = new Headers(request.headers);
      headers.set('Host', new URL(API_ORIGIN).host);

      const init = { method: request.method, headers, redirect: 'manual' };
      if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

      const upstream = await fetch(target.toString(), init);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: withSecurity(upstream.headers, false),
      });
    }

    const asset = await env.ASSETS.fetch(request);
    return new Response(asset.body, {
      status: asset.status,
      headers: withSecurity(asset.headers, true),
    });
  },
};
