# Spotify full-track research for RH-MUSIC

Date: 2026-11-22. Research branch only. No production changes.

## Bottom line

**Status: NOT CONFIRMED / effectively NOT WORKING for new accounts.**

There is no open-source Spotify API in this review that can play full tracks
for current accounts without Spotify's DRM audio keys.

- Official Spotify Web API: metadata and 30-second previews only.
- Unofficial metadata APIs: no audio.
- librespot: the only real full-audio client, but Spotify's current key
  delivery rejects new accounts with `audio key error 0 1`. Upstream states
  there is no known workaround.
- Spotube: does not use Spotify audio; it obtains audio from plugins/other
  services.
- Javatify: deprecated; its mobile-stream support was never publicly released.

A practical playback test was not possible because no Spotify account or
Spotify application credentials were available in this environment. This is
not presented as a successful test.

## Repositories reviewed

| Repository | License | Activity | Role | Full Spotify audio? |
|---|---|---|---|---|
| knownasrazi/spotify-api | MIT | pushed 2026-08-18 | anonymous metadata/GraphQL | **No** |
| NTifyApp/NTify-SpotAPI | no LICENSE file | pushed 2026-08-08 | internal spclient/Pathfinder metadata/control | **No** |
| mirrorfm/spotify-private-api | MIT | pushed 2026-03-22 | private playlist rootlist API | **No** |
| Ahmeth4n/javatify | Apache-2.0 | deprecated | Android client automation/account sessions | **No public stream** |
| librespot-org/librespot | MIT | pushed 2026-11-07, 7.4k stars | Spotify Connect client, real audio | **Only old Premium accounts; new accounts blocked by DRM** |
| KRTirtho/spotube | AGPL-3.0 | pushed 2026-11-21, 50k stars | metadata + third-party audio plugins | **No — not Spotify audio** |

## 1. knownasrazi/spotify-api

- Node.js, zero dependencies.
- Replicates the web-player TOTP token flow to obtain anonymous tokens.
- Uses internal Pathfinder GraphQL and public Web API.
- Returns track/album/playlist/artist metadata, ISRC, artwork, previews.
- No audio stream endpoint.
- Useful for catalog/search metadata only.

## 2. NTify-SpotAPI

- Java library for Spotify's internal spclient and Pathfinder.
- Playlists, library, home feed, playback resumption, search, extended metadata.
- Requires a real access token and client token; tests are live against a real
  account.
- Does not perform audio decryption/playback.
- No license file was found in the repository; not safe to copy.

## 3. mirrorfm/spotify-private-api

- Go client for `playlist/v2/user/{userId}/rootlist` and rootlist changes.
- Requires a web-player access token and user ID.
- Playlist ordering only. No audio.

## 4. Javatify

- Deprecated Android Spotify API / account automation.
- README explicitly says mobile streaming was implemented but **not publicly
  released**.
- Account farming/proxy/session storage features are not acceptable for
  RH-MUSIC.
- No usable full-audio implementation.

## 5. librespot

The only project that genuinely plays Spotify audio.

Architecture:

- Spotify Connect protocol;
- OAuth/credentials authentication;
- audio key request/decryption;
- encrypted CDN chunks;
- decoders and audio backends (Rodio, ALSA, Pipe, etc.).

Requirements:

- Spotify **Premium**;
- a librespot-compatible account;
- native process (Rust) with network access;
- audio backend or pipe output.

Critical current limitation from upstream README:

> Spotify has changed its audio DRM/key delivery mechanism. Accounts created
> after an apparent cutoff date can no longer obtain the audio decryption keys
> required by librespot. This affects all librespot versions, and playback will
> fail with `audio key error 0 1`. No workaround is currently known.

GitHub issue #1649 is open, with 182 comments and no accepted workaround.
This is a Spotify backend restriction, not a configuration problem.

## 6. Spotube

- Cross-platform client, AGPL-3.0.
- Uses Spotify for metadata/playlists and third-party plugins for audio.
- It does **not** decrypt or stream Spotify audio.
- Not a solution for a Spotify audio provider.

## Why browser playback is not possible

Spotify full audio is not a plain HTTP MP3 URL. librespot implements a
proprietary Spotify Connect session and audio-key exchange. A browser page
cannot perform that protocol, and Spotify's DRM keys are deliberately not
available to web clients.

Therefore:

- cannot put a Spotify stream URL into `<audio>`;
- cannot proxy a full track from a Cloudflare Worker;
- cannot run librespot inside Cloudflare Workers/Pages (native Rust process,
  persistent sockets, DRM keys);
- cannot expose the user's Spotify credentials/token to the browser;
- iPhone Safari cannot play full Spotify audio through RH-MUSIC with this
  method.

## Cloudflare / RH-MUSIC implications

- **Cloudflare Worker:** unsuitable; no native librespot, no DRM key flow,
  request CPU/time and persistent session limits.
- **Pages/D1:** no place for audio; D1 must not store audio.
- **R2:** prohibited by the task and unnecessary.
- **Server:** a persistent RU/Spotify-supported host would be required for
  librespot plus an encoder/proxy.
- **Neural AI Mix:** would only work if a full decoded stream is available;
  the current failure prevents this.
- **Queue/player:** metadata can be integrated, but audio playback cannot be
  guaranteed.

## Practical test status

Not performed:

- no Spotify account or Premium session available;
- no Spotify Developer application/client credentials;
- librespot cannot authenticate without account credentials;
- Spotify is not officially available in the current region.

A theoretical librespot test would require the user to provide account access
or run librespot on their own machine. That was not available.

## Recommendation

Do **not** integrate Spotify full playback into RH-MUSIC at this time:

1. New accounts are blocked by Spotify DRM.
2. Cloudflare cannot host librespot.
3. Browser playback requires a proprietary Spotify session.
4. The legal/ToS risk is significant.
5. A 30-second preview integration would not satisfy the requirement.

If Spotify is still required, the only viable experiment is:

- an old Spotify Premium account that still receives audio keys;
- a native server with librespot + ffmpeg/HLS;
- a server-side session and Range/HLS proxy;
- a separate research prototype, not production.

That experiment has not been performed.

## What would be needed from the user

- A Spotify account with Premium.
- Confirmation whether the account is old enough to receive audio keys.
- A supported-region network/server for librespot.
- Explicit acceptance of Spotify ToS/legal risk.
- A server capable of running a persistent native process.

Without these, full Spotify playback is not achievable in RH-MUSIC.

## Git / production

- research branch: `research/spotify`
- production RH-MUSIC untouched
- Zvuk provider, player, AutoMix and database untouched

## Variant A test — Spotify metadata + external audio

A prototype was built and tested:

- Spotify metadata search via anonymous Spotify API: **200 OK**;
- YouTube search/audio via yt-dlp from local residential egress:
  - `Get Lucky` resolved;
  - full audio 248.661 s, Opus 48 kHz stereo, 133 kbps;
- Railway deployment of the same resolver:
  - YouTube returned **“Sign in to confirm you’re not a bot”**;
  - stream endpoint failed with HTTP 500;
- therefore a server-side free audio resolver is not production-viable without
  YouTube cookies/proxy, which is fragile, account-bound and against the
  intended security model.

The Spotify metadata path works, but external audio cannot be reliably
resolved from Cloudflare/Railway. The research service was deleted after the
test. Production RH-MUSIC was not changed.

Status for Variant A: **PARTIALLY CONFIRMED locally, NOT VIABLE server-side.**
