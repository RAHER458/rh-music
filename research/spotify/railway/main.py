import json
import os
import re
import urllib.parse
import urllib.request
from typing import Iterator

import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

app = FastAPI(title="RH Spotify metadata + external audio research")
SPOTIFY_SEARCH = "https://spotify-api-lime-xi.vercel.app/api/search"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"


def spotify_search(q: str):
    url = SPOTIFY_SEARCH + "?" + urllib.parse.urlencode({"query": q})
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)


def normalize(track: dict) -> dict:
    return {
        "id": "spotify:" + str(track.get("identifier")),
        "provider": "spotify",
        "providerId": str(track.get("identifier")),
        "providerLabel": "Spotify · внешнее аудио",
        "title": track.get("title") or "Без названия",
        "artist": track.get("author") or "Неизвестный исполнитель",
        "artistId": None,
        "album": track.get("albumName") or "",
        "duration": round(int(track.get("duration") or 0) / 1000),
        "cover": track.get("artworkUrl") or "",
        "available": True,
        "preview": False,
        "source": "spotify-external",
    }


def score(info: dict, title: str, artist: str, duration: int) -> float:
    text = ((info.get("title") or "") + " " + (info.get("uploader") or "")).lower()
    wanted = (title + " " + artist).lower()
    words = [w for w in re.split(r"\W+", wanted) if len(w) > 2]
    hit = sum(1 for w in set(words) if w in text)
    delta = abs(float(info.get("duration") or 0) - duration)
    return hit * 10 - min(delta, 120) / 20


def resolve(title: str, artist: str, duration: int):
    query = f"ytsearch6:{artist} {title} audio"
    opts = {"quiet": True, "no_warnings": True, "noplaylist": True, "skip_download": True,
            "format": "bestaudio[ext=m4a]/bestaudio", "socket_timeout": 15}
    with yt_dlp.YoutubeDL(opts) as ydl:
        data = ydl.extract_info(query, download=False)
    entries = [e for e in (data.get("entries") or []) if e]
    if not entries:
        raise HTTPException(404, "no external audio")
    best = max(entries, key=lambda e: score(e, title, artist, duration))
    url = best.get("url")
    if not url:
        raise HTTPException(404, "no stream url")
    return best, url


@app.get("/health")
def health():
    return {"ok": True, "service": "spotify-research"}


@app.get("/api/v1/search")
def search(q: str = ""):
    q = q.strip()[:120]
    if not q:
        return {"tracks": {"items": [], "total": 0, "next": None}}
    data = spotify_search(q)
    items = [normalize(t) for t in data.get("tracks") or []][:20]
    return {"tracks": {"items": items, "total": len(items), "next": None}}


@app.api_route("/api/v1/stream", methods=["GET", "HEAD"])
def stream(request: Request, title: str, artist: str, duration: int = 0):
    info, url = resolve(title[:160], artist[:160], max(0, duration))
    headers = {}
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    upstream = urllib.request.urlopen(urllib.request.Request(url, headers={**headers, "User-Agent": UA}), timeout=25)
    out = {}
    for name in ("content-type", "content-length", "content-range", "accept-ranges", "etag"):
        if upstream.headers.get(name):
            out[name] = upstream.headers[name]
    out["Cache-Control"] = "no-store"
    out["Access-Control-Allow-Origin"] = "https://rh-music.pages.dev"
    out["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges, Content-Type"
    if request.method == "HEAD":
        upstream.close()
        return Response(status_code=upstream.status, headers=out)
    def chunks() -> Iterator[bytes]:
        try:
            while True:
                chunk = upstream.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            upstream.close()
    return StreamingResponse(chunks(), status_code=upstream.status, headers=out)
