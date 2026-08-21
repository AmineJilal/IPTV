from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import os
from typing import Optional

from app.config import settings
from app.extractor import extractor
from app.proxy import router as proxy_router
from app.m3u import router as m3u_router

app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="API REST y Proxy HLS para Fútbol Libre TV - Canales en vivo y agenda deportiva",
    docs_url="/docs",
    redoc_url="/redoc"
)

# Enable CORS for all clients
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include Routers
app.include_router(proxy_router)
app.include_router(m3u_router)

@app.api_route("/", methods=["GET", "HEAD"], summary="Root Endpoint")
async def home_dashboard():
    return {
        "status": "online",
        "service": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "port": 8090
    }

@app.get("/health", summary="Health Check")
async def health_check():
    return {
        "status": "online",
        "service": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "port": 8090
    }

@app.get("/api/channels", summary="List all available channels")
async def list_channels():
    channels = await extractor.get_channels()
    return channels

@app.get("/api/channels/{channel_id}", summary="Get channel details and resolved stream URL")
async def get_channel_details(channel_id: str):
    res = await extractor.resolve_stream(channel_id)
    if res.get("status") != "online":
        raise HTTPException(status_code=404, detail=res.get("error", "Channel stream unavailable"))
    return res

@app.get("/api/agenda", summary="Get live sports agenda and match schedule")
async def get_agenda():
    agenda = await extractor.get_agenda()
    return agenda

@app.get("/api/resolve", summary="Resolve any iframe URL to live M3U8 stream")
async def resolve_iframe(iframe: str = Query(..., description="Full iframe URL or stream link")):
    res = await extractor.resolve_stream(iframe)
    return res

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8090, reload=False)
