import os
import urllib.request
from fastapi import FastAPI

app = FastAPI()

@app.get('/health')
def health():
    return {'ok': True, 'service': 'yandex-research'}

@app.get('/probe')
def probe():
    token = os.environ.get('YANDEX_MUSIC_TOKEN')
    if not token:
        return {'ok': False, 'error': 'no token'}
    req = urllib.request.Request(
        'https://api.music.yandex.net/account/status',
        headers={'Authorization': 'OAuth ' + token, 'X-Yandex-Music-Client': 'YandexMusicWebNext/1.0.0', 'User-Agent': 'Mozilla/5.0'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return {'ok': True, 'status': res.status}
    except Exception as exc:
        return {'ok': False, 'error': str(exc)}
