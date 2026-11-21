# RH-MUSIC Auto Mix Beta 2.0 — backend

FastAPI backend for analysis and transition planning.

## Endpoints

- `GET /health`
- `GET /api/v1/status`
- `POST /api/v1/analyze` — multipart `audio` (mono WAV preview) + `track_id`
- `GET /api/v1/analyze/{job_id}`
- `POST /api/v1/transition/plan` — outgoing/incoming analysis JSON
- `POST /api/v1/transition/feedback`
- `GET /api/v1/diagnostics`

## Local tests

```bash
cd automix2/backend
python3 -m unittest -v test_planner.py
```

## Railway deployment

URL: https://automix2-api-production.up.railway.app

Verified:

```json
GET /health -> {"ok":true,"service":"automix2","version":"2.0.0"}
GET /api/v1/status -> {"ok":true,...}
POST /api/v1/analyze -> job complete for a 20 s synthetic WAV
POST /api/v1/transition/plan -> executable late-window plan, strategy beatmatched
```

## Render

`render.yaml` defines a free Python web service. Deployment through the Render
API failed during this session because Render could not fetch the public
GitHub repository (`passed in repository URL is invalid or unfetchable`).
The blueprint can be deployed from the Render dashboard with the repository
connected.

## Licenses / research

- Kiwai-ytb/AutoMix-Local — no LICENSE file found; inspected for algorithms only.
- congnghetinhtu/O-Tune-Engine-AutoMix — no LICENSE file found; inspected only.
- congnghetinhtu/SongMix — MIT; research reference.
- congnghetinhtu/AutoMixSuite — GPL-3.0; not copied.

No source code from those repositories is copied into this backend. The
implementation uses librosa/scipy and independently written scoring/planning.
