// Isolated research prototype. Not part of RH-MUSIC production.
// Proxies a short-lived signed Yandex CDN URL and preserves byte ranges.
const ALLOWED_HOST = /(^|\.)strm\.yandex\.net$/i;
const ALLOWED_PATH = /^\/music-v2\/raw\//;

function cors(origin) {
  const allowed = origin === 'https://rh-music.pages.dev' || origin === 'http://localhost:4190' || origin === 'http://127.0.0.1:4190';
  return allowed ? origin : 'https://rh-music.pages.dev';
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = cors(request.headers.get('Origin') || '');
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      }});
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing url', { status: 400 });
    let media;
    try { media = new URL(target); } catch { return new Response('Invalid url', { status: 400 }); }
    if (media.protocol !== 'https:' || !ALLOWED_HOST.test(media.hostname) || !ALLOWED_PATH.test(media.pathname)) {
      return new Response('Forbidden media host', { status: 403 });
    }
    const headers = new Headers();
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);
    const upstream = await fetch(media.toString(), { method: request.method, headers, redirect: 'follow' });
    const out = new Headers();
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(name);
      if (value) out.set(name, value);
    }
    out.set('Access-Control-Allow-Origin', origin);
    out.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');
    out.set('Cache-Control', 'no-store');
    out.set('Content-Disposition', 'inline');
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
  },
};
