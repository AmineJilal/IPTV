from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates
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

# Setup Jinja2 templates directory
templates_dir = os.path.join(os.path.dirname(__file__), "templates")
templates = Jinja2Templates(directory=templates_dir)

# Include Routers
app.include_router(proxy_router)
app.include_router(m3u_router)

@app.get("/", response_class=HTMLResponse, summary="Web Dashboard & Interactive Player")
async def home_dashboard(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "port": settings.PORT}
    )

@app.get("/health", summary="Health Check")
async def health_check():
    return {
        "status": "online",
        "service": settings.PROJECT_NAME,
        "version": settings.VERSION,
        "port": settings.PORT,
        "target": settings.BASE_URL
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
