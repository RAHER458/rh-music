/**
 * Preview-only Worker: вкладка «Популярное» Zvuk для RH—MUSIC.
 * Не production. Использует анонимный GraphQL каталога и cookie-handshake грида.
 */
const GRID_NAME = 'popular_music_web';
const GQL = 'https://zvuk.com/api/v1/graphql';
const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Content-Type': 'application/json',
  'Origin': 'https://zvuk.com',
  'Referer': 'https://zvuk.com/popular',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

const TRACK_FIELDS = `id title duration explicit artists { id title } release { id title date type image { src } artists { id title } }`;
const PLAYLIST_QUERY = `query catalogPlaylist($id: [ID!]!, $limit: Int) { playlists(ids: $id) { id title description duration isPublic tracks(limit: $limit) { ${TRACK_FIELDS} } } }`;
const RELEASE_QUERY = `query getRelease($ids: [ID!]!) { getReleases(ids: $ids) { id title date type image { src } artists { id title image { src } } } }`;
const ARTIST_QUERY = `query getArtist($ids: [ID!]!) { getArtists(ids: $ids) { id title image { src } } }`;

function img(node, size = 300) {
  if (!node || !node.image || !node.image.src) return null;
  return String(node.image.src).replace('{size}', String(size));
}
function track(t) {
  if (!t) return null;
  return {
    id: String(t.id), title: t.title || '', duration: Number(t.duration) || 0, explicit: !!t.explicit,
    artist: (t.artists || []).map((a) => a.title).filter(Boolean).join(', ') || 'Неизвестный исполнитель',
    artistId: (t.artists || [])[0] ? String(t.artists[0].id) : null,
    album: (t.release && t.release.title) || '', albumId: t.release ? String(t.release.id) : null,
    cover: t.release ? img(t.release, 300) : null,
  };
}
function playlist(p) {
  const first = (p.tracks || [])[0];
  return { id: String(p.id), title: p.title || 'Подборка', description: p.description || '', duration: Number(p.duration) || 0, cover: first ? img(first.release, 400) : null };
}
function release(r) {
  return { id: String(r.id), title: r.title || 'Релиз', artist: (r.artists || []).map((a) => a.title).filter(Boolean).join(', ') || '', artistId: (r.artists || [])[0] ? String(r.artists[0].id) : null, date: r.date || '', cover: img(r, 400) };
}
function artist(a) {
  return { id: String(a.id), title: a.title || 'Исполнитель', cover: img(a, 400) };
}

let gridCookies = '';

async function gql(query, operationName, variables) {
  const headers = gridCookies ? { ...HEADERS, Cookie: gridCookies } : HEADERS;
  const res = await fetch(GQL, { method: 'POST', headers, body: JSON.stringify({ query, operationName, variables }) });
  const text = await res.text();
  if (!res.ok) throw new Error('GraphQL HTTP ' + res.status);
  const body = JSON.parse(text);
  if (body.errors && body.errors.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return body.data || {};
}

async function fetchGrid() {
  const url = 'https://zvuk.com/api/tiny/grid?name=' + encodeURIComponent(GRID_NAME);
  const first = await fetch(url, { headers: HEADERS, redirect: 'manual' });
  let res = first;
  if (first.status >= 300 && first.status < 400) {
    const cookies = (first.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_-]+=)/).map((c) => c.trim().split(';')[0]).filter(Boolean).join('; ');
    if (!cookies) throw new Error('Zvuk grid: нет cookie');
    gridCookies = cookies;
    res = await fetch(url, { headers: { ...HEADERS, Cookie: cookies }, redirect: 'follow' });
  }
  if (!res.ok) throw new Error('Zvuk grid HTTP ' + res.status);
  const body = await res.json();
  return (body.result && body.result.page && body.result.page.sections || []).filter((s) => s && s.enabled !== false);
}

function unique(items) {
  const seen = new Set(); const out = [];
  for (const item of items) { const id = String(item && item.id); if (!id || id === 'undefined' || seen.has(id)) continue; seen.add(id); out.push(id); }
  return out;
}
const slug = (v) => String(v || 's').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 's';

export async function buildPopular() {
  const grid = await fetchGrid();
  const playlistIds = [], releaseIds = [], artistIds = [];
  for (const s of grid) {
    if (s.type === 'listing') {
      const type = (s.data || [])[0] && s.data[0].type;
      const ids = unique(s.data || []);
      if (type === 'playlist') playlistIds.push(...ids);
      else if (type === 'release') releaseIds.push(...ids);
      else if (type === 'artist') artistIds.push(...ids);
    } else if (s.type === 'content') {
      const first = (s.data || [])[0];
      if (first && first.type === 'playlist') playlistIds.push(String(first.id));
    }
  }
  const ids = (list) => list.map((id) => ({ id }));
  const [playlists, releases, artists] = await Promise.all([
    unique(playlistIds).length ? gql(PLAYLIST_QUERY, 'catalogPlaylist', { id: unique(playlistIds), limit: 1 }).then((d) => new Map((d.playlists || []).map((p) => [String(p.id), playlist(p)]))).catch(() => new Map()) : new Map(),
    unique(releaseIds).length ? gql(RELEASE_QUERY, 'getRelease', { ids: unique(releaseIds) }).then((d) => new Map((d.getReleases || []).map((r) => [String(r.id), release(r)]))).catch(() => new Map()) : new Map(),
    unique(artistIds).length ? gql(ARTIST_QUERY, 'getArtist', { ids: unique(artistIds) }).then((d) => new Map((d.getArtists || []).map((a) => [String(a.id), artist(a)]))).catch(() => new Map()) : new Map(),
  ]);
  const sections = []; let hero = null;
  for (const [index, s] of grid.entries()) {
    if (s.type === 'banner') {
      const m = (s.messages || [])[0] || {};
      const actions = (s.actions || []).map((a) => ({ title: a.title, url: a.action && a.action.url }));
      if (m.title || actions.length) sections.push({ key: 'banner-' + index, type: 'banner', title: m.title || 'Подборки', subtitle: m.detail || '', cover: m.image || null, actions });
      continue;
    }
    if (s.type === 'content') {
      const first = (s.data || [])[0];
      if (!first || first.type !== 'playlist') continue;
      const data = await gql(PLAYLIST_QUERY, 'catalogPlaylist', { id: [String(first.id)], limit: 60 }).catch(() => null);
      const p = data && (data.playlists || [])[0];
      if (!p) continue;
      const items = (p.tracks || []).map(track).filter(Boolean);
      if (!items.length) continue;
      if (!hero) hero = { id: String(p.id), title: p.title, description: p.description || '', cover: items[0].cover };
      sections.push({ key: slug('content-' + first.id), type: 'tracks', title: p.title || 'Подборка', subtitle: p.description || 'Популярное на Zvuk', items });
      continue;
    }
    if (s.type !== 'listing') continue;
    const title = (s.header && s.header.title) || 'Популярное';
    const list = unique(s.data || []);
    const first = (s.data || [])[0] || {};
    let type = null; let items = [];
    if (first.type === 'playlist') { type = 'playlists'; items = list.map((id) => playlists.get(id)).filter(Boolean); }
    else if (first.type === 'release') { type = 'albums'; items = list.map((id) => releases.get(id)).filter(Boolean); }
    else if (first.type === 'artist') { type = 'artists'; items = list.map((id) => artists.get(id)).filter(Boolean); }
    if (items.length) sections.push({ key: slug((s.content && s.content.list) || s.UUID || title + index), type, title, subtitle: '', items });
  }
  return { sections, hero, source: 'zvuk-popular-preview', fetchedAt: new Date().toISOString() };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/debug') {
      try {
        const grid = await fetchGrid();
        const ids = unique(grid.flatMap((s) => s.data || []).filter((x) => x.type === 'playlist').map((x) => x.id));
        let probe = null;
        try { probe = await gql(PLAYLIST_QUERY, 'catalogPlaylist', { id: ids.slice(0, 1), limit: 1 }); } catch (error) { probe = { error: String(error && error.message || error) }; }
        return new Response(JSON.stringify({ cookies: gridCookies, grid: grid.length, ids: ids.slice(0, 3), probe }, null, 1), { headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error && error.message || error) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    if (url.pathname === '/api/home' || url.pathname === '/api/popular' || url.pathname === '/') {
      try {
        const data = await buildPopular();
        return new Response(JSON.stringify({ ok: true, ...data }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
      } catch (error) {
        return new Response(JSON.stringify({ ok: false, error: String(error && error.message || error) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  }
};
