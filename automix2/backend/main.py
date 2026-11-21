from __future__ import annotations
import asyncio
import hashlib
import time
import uuid
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from analysis import analyze_bytes
from models import TrackAnalysis
from planner import plan_transition

app = FastAPI(title="RH AutoMix Beta 2.0", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["https://rh-music.pages.dev", "http://localhost:4190"], allow_methods=["*"], allow_headers=["*"])

MAX_BYTES = 12 * 1024 * 1024
jobs: dict[str, dict] = {}
cache: dict[str, dict] = {}
started = time.time()


class PlanRequest(BaseModel):
    outgoing: dict
    incoming: dict
    position: float = 0.0


@app.get("/health")
def health():
    return {"ok": True, "service": "automix2", "version": "2.0.0"}


@app.get("/api/v1/status")
def status():
    return {"ok": True, "uptime_sec": round(time.time() - started, 1), "jobs": len(jobs), "cache": len(cache)}


@app.get("/api/v1/diagnostics")
def diagnostics():
    return {"jobs": {k: {"status": v["status"], "error": v.get("error")} for k, v in jobs.items()}, "cache_entries": len(cache)}


@app.post("/api/v1/analyze", status_code=202)
async def analyze(audio: UploadFile = File(...), track_id: str = Form(...)):
    data = await audio.read()
    if not data:
        raise HTTPException(400, "empty audio")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "preview too large")
    digest = hashlib.sha256(data).hexdigest()[:24]
    if digest in cache:
        return {"job_id": digest, "status": "complete", "analysis": cache[digest]}
    job_id = uuid.uuid4().hex
    jobs[job_id] = {"status": "queued", "track_id": track_id, "created": time.time()}
    async def run():
        try:
            jobs[job_id]["status"] = "running"
            result = await asyncio.to_thread(analyze_bytes, data, track_id)
            cache[digest] = result.to_dict()
            jobs[job_id] = {"status": "complete", "track_id": track_id, "analysis": cache[digest]}
        except Exception as e:
            jobs[job_id] = {"status": "error", "track_id": track_id, "error": str(e)}
    asyncio.create_task(run())
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/v1/analyze/{job_id}")
def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        if job_id in cache:
            return {"job_id": job_id, "status": "complete", "analysis": cache[job_id]}
        raise HTTPException(404, "job not found")
    return {"job_id": job_id, **job}


@app.post("/api/v1/transition/plan")
def plan(req: PlanRequest):
    try:
        a = TrackAnalysis(**req.outgoing)
        b = TrackAnalysis(**req.incoming)
        return plan_transition(a, b, position=float(req.position or 0.0)).to_dict()
    except Exception as e:
        raise HTTPException(400, f"invalid analysis: {e}")


@app.post("/api/v1/transition/feedback")
def feedback(payload: dict):
    return {"ok": True, "received": bool(payload)}
