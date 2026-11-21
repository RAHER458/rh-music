import base64
import hashlib
import hmac
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

app = FastAPI(title="RH Yandex Music research provider")
API = "https://api.music.yandex.net"
HMAC_KEY = "7tvSmFbyf5hJnIHhCimDDD"
HEADERS = {
    "X-Yandex-Music-Client": "YandexMusicWebNext/1.0.0",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://music.yandex.ru",
    "Referer": "https://music.yandex.ru/",
    "Accept": "application/json",
    "Accept-Language": "ru,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
}
_cache: dict[str, tuple[float, object]] = {}


def cached(key: str, ttl: float, factory):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = factory()
    _cache[key] = (time.time(), value)
    if len(_cache) > 80:
        _cache.pop(next(iter(_cache)))
    return value


def token() -> str:
    value = os.environ.get("YANDEX_MUSIC_TOKEN")
    if not value:
        raise HTTPException(503, "YANDEX_MUSIC_TOKEN is not configured")
    return value


def ym(path: str):
    request = urllib.request.Request(API + path, headers={**HEADERS, "Authorization": "OAuth " + token()})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise HTTPException(502, f"Yandex API HTTP {error.code}") from error
    except Exception as error:
        raise HTTPException(502, str(error)) from error


def cover(track: dict) -> str:
    raw = track.get("coverUri") or (track.get("albums") or [{}])[0].get("coverUri") or ""
    if not raw:
        return ""
    return (raw if raw.startswith("http") else "https://" + raw).replace("%%", "600x600")


def normalize(track: dict) -> dict:
    album = (track.get("albums") or [{}])[0]
    artists = [item.get("name") for item in track.get("artists") or [] if item.get("name")]
    return {
        "id": "yandex:" + str(track.get("id")),
        "provider": "yandex",
        "providerId": str(track.get("id")),
        "providerLabel": "Яндекс Музыка",
        "title": track.get("title") or "Без названия",
        "artist": ", ".join(artists) or "Неизвестный исполнитель",
        "artistId": None,
        "album": album.get("title") or "",
        "duration": max(0, round(int(track.get("durationMs") or 0) / 1000)),
        "cover": cover(track),
        "available": track.get("available") is not False,
        "preview": False,
        "source": "yandex",
    }


def album_tracks(album_id: int):
    data = ym(f"/albums/{album_id}/with-tracks").get("result") or {}
    out = []
    for volume in data.get("volumes") or []:
        for track in volume or []:
            if track and track.get("id"):
                out.append(normalize({**track, "albums": [data]}))
            if len(out) >= 4:
                return out
    return out


def file_info(track_id: str):
    ts = int(time.time())
    quality, codecs, transport = "lossless", "flac,mp3", "raw"
    body = f"{ts}{track_id}{quality}{codecs.replace(',', '')}{transport}"
    digest = hmac.new(HMAC_KEY.encode(), body.encode(), hashlib.sha256).digest()
    sign = base64.b64encode(digest).decode().rstrip("=")
    query = urllib.parse.urlencode({
        "ts": ts, "trackId": track_id, "quality": quality,
        "codecs": codecs, "transports": transport, "sign": sign,
    })
    return (ym("/get-file-info?" + query).get("result") or {}).get("downloadInfo") or {}


@app.get("/health")
def health():
    return {"ok": True, "service": "yandex-research"}


@app.get("/api/v1/search")
def search(q: str = ""):
    q = q.strip()[:120]
    if not q:
        return {"tracks": {"items": [], "total": 0, "next": None}}
    result = cached("search:" + q.lower(), 120, lambda: ym("/search?" + urllib.parse.urlencode({
        "text": q, "type": "all", "page": 0, "nocorrect": "false",
    })))
    items = [normalize(t) for t in ((result.get("result") or {}).get("tracks") or {}).get("results") or []]
    items = [t for t in items if t["title"]][:20]
    return {"tracks": {"items": items, "total": len(items), "next": None}}


@app.get("/api/v1/home")
def home():
    def build():
        sections = []
        try:
            wave = ym("/rotor/station/user:onyourwave/tracks?settings2=true")
            items = [normalize(x["track"]) for x in (wave.get("result") or {}).get("sequence") or []
                     if x.get("type") == "track" and x.get("track")]
            if items:
                sections.append({"key": "wave", "title": "Моя волна", "subtitle": "Персональная лента Яндекс Музыки", "items": items[:20]})
        except Exception:
            pass
        try:
            landing = ym("/landing3?blocks=new-releases")
            albums = [e for b in (landing.get("result") or {}).get("blocks") or [] for e in b.get("entities") or []][:3]
            tracks = []
            for album in albums:
                try:
                    tracks.extend(album_tracks(int(album["data"]["id"])))
                except Exception:
                    pass
            if tracks:
                sections.append({"key": "new", "title": "Новые релизы", "subtitle": "Яндекс Музыка", "items": tracks[:12]})
        except Exception:
            pass
        return sections
    return {"sections": cached("home", 300, build)}


@app.api_route("/api/v1/stream/{track_id}", methods=["GET", "HEAD"])
def stream(track_id: str, request: Request):
    if not track_id.isdigit():
        raise HTTPException(400, "bad track id")
    info = file_info(track_id)
    url = info.get("url")
    if not url:
        raise HTTPException(404, "no audio")
    if "preview" in str(info.get("quality", "")).lower() or "/preview" in url:
        raise HTTPException(409, "preview_only")
    headers = {}
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    try:
        upstream = urllib.request.urlopen(urllib.request.Request(url, headers={**HEADERS, **headers}), timeout=20)
    except Exception as error:
        raise HTTPException(502, str(error)) from error
    status = upstream.status
    out = {}
    for name in ("content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"):
        if upstream.headers.get(name):
            out[name] = upstream.headers[name]
    out["Cache-Control"] = "no-store"
    out["Access-Control-Allow-Origin"] = "https://rh-music.pages.dev"
    out["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges, Content-Type"
    if request.method == "HEAD":
        upstream.close()
        return Response(status_code=status, headers=out)
    def chunks() -> Iterator[bytes]:
        try:
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()
    return StreamingResponse(chunks(), status_code=status, headers=out, media_type=out.get("content-type"))
