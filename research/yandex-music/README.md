# Yandex Music — practical API research

Date: 2026-11-21. Research branch only. No production changes were made.

## Result in one line

Anonymous access returns **only `smart_preview`**, not the full track. A full
track requires an OAuth token for an account whose subscription grants access.
No such token was available in this environment, so a full-track playback test
was **not performed** and must not be claimed.

## Repositories inspected

| Repository | License | What was inspected |
|---|---|---|
| MarshalX/yandex-music-api | LGPL-3.0 | `_client/tracks.py`, `_client/device_auth.py`, `download_info.py` |
| evgenygurin/yandexmusic-mcp | MIT | `client.py` auth header, rate limiting, search/client structure |
| dpronyaev/yamulite-android | no license file found | `StreamUrlResolver.kt`, `DownloadInfoDtos.kt`, `ResolvingDataSourceFactory.kt`, `Quality.kt` |
| fgsfds1/yt-dlp-yandex-music-plugin | MIT | `research/api-notes.md`, `yt_dlp_plugins/extractor/yandex_music_v2.py` |
| yamusic/yamusic | GPL-3.0 | `Cargo.toml`, README, use of `yandex-music` crate and buffered streaming |
| kitsunoff/yandex-music-lidarr | no license file found | `YandexMusicApi.cs`, `YandexMusic.cs`, download protocol |

## Authentication

- Device Flow is implemented in MarshalX `yandex_music/_client/device_auth.py`:
  `POST https://oauth.yandex.ru/device/code`, then `POST /token`.
- Authenticated API calls use `Authorization: OAuth <token>` (MCP client).
- Tokens must stay server-side. No token/cookie is present in this branch.
- Full playback is an account-entitlement decision; anonymous requests are
  explicitly downgraded to preview.

## Endpoints confirmed

### Catalog search (anonymous)

```http
GET https://api.music.yandex.net/search?text=test&type=all&page=0&nocorrect=false
X-Yandex-Music-Client: YandexMusicAndroid/24022
```

```text
HTTP 200, application/json, 159 708 bytes
20 tracks returned
```

Examples of metadata:

| trackId | title | duration_ms |
|---|---|---:|
| 18743864 | Test & Recognise | 304070 |
| 26413511 | Test Drive | 156300 |
| 152841656 | Test | 157610 |

### Download-info (anonymous)

```http
GET https://api.music.yandex.net/tracks/{id}/download-info
```

```text
HTTP 200, application/json
result[0].preview = true
codec = mp3
bitrateInKbps = 128
```

The returned `downloadInfoUrl` XML endpoint answered **HTTP 401 Unauthorized**
when fetched anonymously (`Link expired` / unauthorized JSON), so even the
preview URL from `download-info` was not usable without auth.

### Signed file-info (anonymous)

Current web/plugin mechanism:

```http
GET https://api.music.yandex.net/get-file-info
  ?ts=<unix-seconds>
  &trackId=<id>
  &quality=<lossless|nq|lq|preview>
  &codecs=mp3
  &transports=raw
  &sign=<base64 HMAC-SHA256, base64 padding removed>
```

The signature input is:

```text
ts + trackId + quality + codecs-without-commas + transport
```

The HMAC key is an app-level key published in the open-source frontend
research; it is not a user token. Do not place it in frontend code.

Anonymous result for all tested tracks:

```json
{
  "quality": "smart_preview",
  "codec": "mp3",
  "bitrate": 192,
  "transport": "raw",
  "url": ".../music-v2/raw/.../preview192"
}
```

Requesting `lossless`, `nq`, `lq` or `preview` anonymously all returned
`smart_preview`; none returned a full-track URL.

## Measured preview audio

The preview URL was downloaded and measured with ffprobe.

| trackId | original duration | returned quality | codec | bitrate | sample rate | channels | bytes | measured duration |
|---|---:|---|---|---:|---:|---:|---:|---:|
| 18743864 | 304.1 s | smart_preview | mp3 | 192 kbps | 44100 | 2 | 472129 | 19.6 s |
| 26413511 | 156.3 s | smart_preview | mp3 | 192 kbps | 44100 | 2 | 462196 | 19.2 s |
| 152841656 | 157.6 s | smart_preview | mp3 | 192 kbps | 44100 | 2 | 390626 | 16.2 s |

This proves the returned media is a short preview, not the original track.

## HTTP Range

The preview CDN supports byte ranges:

```text
GET with Range: bytes=0-1023
HTTP/1.1 206 Partial Content
Content-Length: 1024
Content-Range: bytes 0-1023/462196
Content-Type: application/octet-stream
```

A second range `bytes=100000-101023` also returned `206` and 1024 bytes.
This confirms the mechanism is streamable, but only for the preview asset.

## Why the full track was not proven

- No Yandex OAuth token with an active subscription was available.
- All anonymous signed requests were downgraded to `smart_preview`.
- `download-info` flagged every tested track as `preview: true`.
- The XML signing endpoint rejected anonymous access with 401.

Therefore a statement such as "RH-MUSIC can play full Yandex tracks" would be
false for this environment.

## Integration assessment

A real provider would need, server-side only:

1. OAuth Device Flow / token storage.
2. `GET /get-file-info` with HMAC signing.
3. `transport=raw` URL handling, with expiry/re-resolution.
4. Range-capable proxy/stream endpoint (or direct CDN URL if CORS/range allow).
5. Queue/metadata mapping into the existing Zvuk provider interface.

The browser must never receive the OAuth token. Full playback remains gated by
the account's subscription/rights.

## Cloudflare Worker

A Worker prototype was **not created**: the prerequisite (confirmed full-track
URL) was not met. Building a proxy around a 16–20 second preview would not
satisfy the task.

## Checkpoints

- production baseline remains untouched;
- `neural-2026-11-21-4` → `50a2b3d`;
- this research is isolated in branch `research/yandex-music`.
