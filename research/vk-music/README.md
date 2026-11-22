# VK Music Provider — technical research

Date: 2026-11-22. Research branch only. Production RH-MUSIC was not modified.

## Bottom line

**Status: NOT CONFIRMED for a legitimate server-side provider.**

VK Music audio methods are not available to ordinary OAuth applications. The
current working clients obtain a **VK web-player token from an existing browser
session**. That token is short-lived, session-bound, and is not issued through
the documented OAuth flow for third-party apps.

A server provider would require one of:

- importing a user's VK browser session/token (forbidden by the task and unsafe);
- storing VK account credentials and emulating an Android client
  (`vk-audio-token` style), which is reverse-engineered, fragile and against
  the intended access model;
- using a VK web session on a server, which VK may treat as session abuse.

No VK account/session was available in this environment, so no audio playback
test was performed. This is not presented as a successful test.

## Repositories reviewed

| Repository | License | Language | Last push | State | Relevance |
|---|---|---|---|---|---|
| [milcorix/vkmusik](https://github.com/milcorix/vkmusik) | MIT | C#/.NET | 2026-07-27 | active | current desktop VK Music client; browser-session token, HLS |
| [oklookat/govkm](https://github.com/oklookat/govkm) | MIT | Go | 2023-08-23 | stale | VK Music API client for entities |
| [GreenRiverRUS/thatmusic-api](https://github.com/GreenRiverRUS/thatmusic-api) | MIT | Python | 2021-12-26 | stale | old `audio.search` proxy |
| [python273/vk_api](https://github.com/python273/vk_api) | Apache-2.0 | Python | 2026-07-17 | active | general VK API, audio module legacy |
| [vodka2/vk-audio-token](https://github.com/vodka2/vk-audio-token) | **no LICENSE file** | PHP | 2023-01-06 | stale | token extraction via Kate/Boom clients; not reusable |

## What vkmusik proves

Its README documents the current VK restriction directly:

- `audio.get`, `audio.search`, `audio.getById` are whitelisted to VK's web
  player;
- a normal OAuth token gets `Unknown method passed` / error 3;
- QR/VK ID login does not issue a music-capable token;
- the working path is **reading the existing VK browser session** and requesting
  a web token, refreshed roughly every 15 minutes;
- audio links are HLS playlists with MP3 inside (320 kbps);
- HLS uses AES-128 encryption;
- file URLs live about a day and are session-bound; the URL is re-requested
  through `audio.getById` before playback;
- ffmpeg decodes the HLS stream.

This is incompatible with a clean server-side Provider: the task explicitly
forbids extracting browser sessions, and the VK web token is not an official
server API credential.

## What the other projects add

- **govkm** — entity methods (track/album/artist/playlist/search), but requires
  a token from `vkmauth`; last updated 2023.
- **thatmusic-api** — old `audio.search` + proxy, VK API 5.72, 2021; likely
  broken by current VK restrictions.
- **vk_api** — general VK library; its audio module relies on the old
  `audio.*` methods, which are no longer available to ordinary apps.
- **vk-audio-token** — obtains music-capable tokens by emulating Kate Mobile /
  Boom / official clients, using login/password, 2FA, GMS check-in, and
  droidguard. No license file; high security/ToS risk; not acceptable.

## Authorization findings

| Method | Result |
|---|---|
| Public VK API without token | `audio.*` requires user authorization |
| Ordinary OAuth token | music methods not exposed |
| VK ID / QR | no music-capable token for third-party clients |
| Browser web session | works in vkmusik; token ~15 min |
| Login/password + Android emulation | `vk-audio-token`; fragile/ToS risk |
| Service token | no user music library/audio |

A server provider cannot receive the VK web token without handling the user's
VK session. Storing such a token server-side is possible technically but
violates the security boundary and is not an official API.

## Search / metadata

With a suitable token, the entity API can provide:

- track search and metadata;
- artists, albums, playlists;
- covers;
- durations;
- user library/recommendations (subject to VK availability).

Without a music-capable token, search may return metadata but audio methods do
not work. This was not tested with a VK account.

## Audio / streaming

From vkmusik's implementation:

- source: HLS (`.m3u8`) with MP3 segments;
- bitrate: up to 320 kbps;
- AES-128 encrypted HLS;
- URLs expire (~24 h) and are session-bound;
- ffmpeg handles HLS and decryption;
- no simple HTTP Range on a single MP3; HLS is segment-based.

Implications:

- `<audio src="...">` cannot use the HLS URL directly in Chrome;
- Safari can play HLS natively, but AES key/session handling still applies;
- Chrome needs hls.js or a server-side HLS→MP3/fMP4 proxy;
- Cloudflare Worker cannot run ffmpeg;
- a native server would be required;
- AutoMix needs decoded PCM/continuous audio; HLS segments can be proxied but
  beatmatching/preloading becomes more complex.

## Comparison with Zvuk

| Capability | Zvuk | VK Music |
|---|---|---|
| Search | yes | token-dependent |
| Metadata | yes | yes with token |
| Artists/albums/playlists | yes | yes with token |
| Home/recommendations | yes | partial/token-dependent |
| Covers | yes | yes |
| Full audio | yes | HLS, token/session-bound |
| HTTP Range | yes (current provider) | not on HLS; segment-based |
| iPhone Safari | yes | possible via native HLS, unverified |
| Auth | RH-MUSIC provider | VK web session / reverse-engineered client |
| Stability | production | fragile, session-bound |
| Legitimacy | provider API | unofficial, restricted |

## Proposed architecture (only if access is approved)

```text
VK web session/token (server-side, user-approved)
        ↓
VK Music Provider (FastAPI)
        ↓
audio.getById → HLS URL + AES key
        ↓
HLS proxy / remux (ffmpeg) → fMP4/MP3
        ↓
RH-MUSIC API → frontend
```

Required endpoints:

```text
GET /api/v1/search?q=&page=
GET /api/v1/track/{id}
GET /api/v1/artist/{id}
GET /api/v1/artist/{id}/tracks?page=
GET /api/v1/album/{id}
GET /api/v1/playlist/{id}
GET /api/v1/home
GET /api/v1/stream/{id}          # HLS or remuxed stream
```

But this cannot be built without resolving the token/session issue.

## Caching

- search/metadata: 2–10 min;
- covers: long-lived;
- HLS URL: never long-term; re-resolve before playback;
- audio segments: bounded, short TTL;
- no full audio in D1/R2.

## Testing status

Not performed:

- no VK account/session;
- no music-capable VK token;
- no browser VK session on this device;
- no HLS playback test;
- no Range test (HLS is not a single-file Range resource).

## Recommendation

**Do not integrate VK Music now.**

Reasons:

1. No legitimate server-side music token.
2. The working method depends on a browser session or reverse-engineered
   Android client.
3. HLS/AES/session handling is fragile and not Cloudflare-compatible.
4. Legal/ToS and account-ban risk.
5. No real playback test was possible.

If VK is still required, the minimum prerequisite is a documented, permitted
server-side authorization path from VK. Without it, a Provider would be an
unstable workaround, not production infrastructure.

## Git / production

- branch: `research/vk-music`
- production RH-MUSIC untouched
- Zvuk, Neural AI, Smart Mix, D1, Workers, Pages untouched
