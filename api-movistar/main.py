import os
import base64
import time
import hashlib
import httpx
import re
import subprocess
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse, Response, StreamingResponse
from pydantic import BaseModel

from xameleon_extractor import (
    fetch_xameleon_channels,
    resolve_xameleon_stream,
    fetch_xameleon_m3u8_manifest
)

from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(
    title="IPTV Channel & Stream API",
    description="API para gestionar y resolver listas de canales IPTV con desofuscación dinámica y soporte de proxy HTTP/SOCKS",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pool global de conexiones HTTP para descarga ultrarrápida de segmentos CDN
cdn_pool = httpx.AsyncClient(
    verify=False,
    timeout=httpx.Timeout(15.0, connect=5.0),
    limits=httpx.Limits(max_keepalive_connections=100, max_connections=200),
    follow_redirects=True
)

# Base domain setting (defaults to environment variable BASE_DOMAIN if set)
DEFAULT_BASE_DOMAIN = os.getenv("BASE_DOMAIN", None)

# Catálogo extendido con URLs de embed en vivo
CHANNELS_DB = [
    # Fútbol & Deportes
    {"id": "laligaes", "name": "LaLiga TV ES", "embed_url": "https://streamx-hd.com/live1.php?stream=laligaes", "stream_key": "LALIGAES", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "laliga2", "name": "LaLiga Hypermotion", "embed_url": "https://dlstreams.st/casting/stream-539.php", "stream_key": "LALIGA2", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "daznlaliga", "name": "DAZN LaLiga", "embed_url": "https://dlstreams.st/casting/stream-538.php", "stream_key": "DAZNLALIGA", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "daznlaliga2", "name": "DAZN LaLiga 2", "embed_url": "https://dlstreams.st/casting/stream-84.php", "stream_key": "DAZNLALIGA2", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "liga-campeones", "name": "M+ Liga de Campeones", "embed_url": "https://dlstreams.st/casting/stream-149.php", "stream_key": "LIGACAMPEONES", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "liga-campeones-2", "name": "M+ Liga de Campeones 2", "embed_url": "https://dlstreams.st/casting/stream-276.php", "stream_key": "LIGACAMPEONES2", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "dazn1", "name": "DAZN 1", "embed_url": "https://streamx-hd.com/live1.php?stream=dazn1", "stream_key": "DAZN1", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "dazn2", "name": "DAZN 2", "embed_url": "https://streamx-hd.com/live1.php?stream=dazn2", "stream_key": "DAZN2", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "daznf1", "name": "DAZN F1", "embed_url": "https://streamx-hd.com/live1.php?stream=daznf1", "stream_key": "DAZNF1", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "deportes", "name": "M+ Deportes", "embed_url": "https://streamx-hd.com/live1.php?stream=deportes", "stream_key": "DEPORTES", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "eurosport1", "name": "Eurosport 1", "embed_url": "https://streamx-hd.com/live1.php?stream=eurosport1", "stream_key": "EUROSPORT1", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "eurosport2", "name": "Eurosport 2", "embed_url": "https://streamx-hd.com/live1.php?stream=eurosport2", "stream_key": "EUROSPORT2", "category": "Sports", "server": "ds164.bluetier.top"},
    {"id": "golplay", "name": "Gol Play", "embed_url": "https://streamx-hd.com/live1.php?stream=golplay", "stream_key": "GOLPLAY", "category": "Sports", "server": "ds164.bluetier.top"},
    
    # Entretenimiento & Generalistas
    {"id": "movistarplus", "name": "Movistar Plus+", "embed_url": "https://dlstreams.st/casting/stream-84.php", "stream_key": "MOVISTARPLUS", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "vamos", "name": "M+ #Vamos", "embed_url": "https://dlstreams.st/casting/stream-84.php", "stream_key": "VAMOS", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "la1", "name": "La 1 HD", "embed_url": "https://streamx-hd.com/live1.php?stream=la1", "stream_key": "LA1", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "la2", "name": "La 2 HD", "embed_url": "https://streamx-hd.com/live1.php?stream=la2", "stream_key": "LA2", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "antena3", "name": "Antena 3", "embed_url": "https://streamx-hd.com/live1.php?stream=antena3", "stream_key": "ANTENA3", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "cuatro", "name": "Cuatro", "embed_url": "https://streamx-hd.com/live1.php?stream=cuatro", "stream_key": "CUATRO", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "telecinco", "name": "Telecinco", "embed_url": "https://streamx-hd.com/live1.php?stream=telecinco", "stream_key": "TELECINCO", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "lasexta", "name": "laSexta", "embed_url": "https://streamx-hd.com/live1.php?stream=lasexta", "stream_key": "LASEXTA", "category": "General", "server": "ds164.bluetier.top"},
    {"id": "cine", "name": "M+ Cine", "embed_url": "https://streamx-hd.com/live1.php?stream=cine", "stream_key": "CINE", "category": "Cinema", "server": "ds164.bluetier.top"},
    {"id": "accion", "name": "M+ Acción", "embed_url": "https://streamx-hd.com/live1.php?stream=accion", "stream_key": "ACCION", "category": "Cinema", "server": "ds164.bluetier.top"}
]

class ChannelModel(BaseModel):
    id: str
    name: str
    stream_key: str
    category: str
    server: str
    embed_url: str

async def resolve_embed_m3u8(embed_url: str, referer: str = "https://nowfutbol.xyz/") -> str:
    """
    Desofusca y extrae la URL M3U8 fresca con token activo desde la URL del reproductor iframe.
    Soporta fallback a Tor SOCKS5 si el ISP de España bloquea la conexión directa.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Referer": referer
    }
    
    res = None
    # 1. Intentar con Tor SOCKS5 para evitar bloqueos por SNI de Vodafone/Movistar
    try:
        async with httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", timeout=10.0, follow_redirects=True, verify=False) as client:
            r = await client.get(embed_url, headers=headers)
            if r.status_code == 200:
                res = r
    except Exception:
        pass
        
    # 2. Fallback a cliente HTTPS directo
    if not res:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True, verify=False) as client:
            res = await client.get(embed_url, headers=headers)
            
    if not res or res.status_code != 200:
        raise ValueError(f"Servidor embed devolvió código HTTP {res.status_code if res else 'No response'}")
        
    scripts = re.findall(r'<script[^>]*>(.*?)</script>', res.text, re.DOTALL)
    target_script = None
    for s in scripts:
        if "Clappr" in s or "playbackURL" in s:
            target_script = s
            break
            
    if not target_script:
        raise ValueError("No se encontró el script de reproducción en el embed")
        
    mock_dom = """
    const dummyEl = { setAttribute: () => {}, addEventListener: () => {}, style: {} };
    const window = { addEventListener: () => {} };
    const document = { addEventListener: () => {}, querySelector: () => dummyEl, getElementById: () => dummyEl, createElement: () => dummyEl, head: dummyEl, documentElement: dummyEl, body: dummyEl };
    const localStorage = { getItem: () => null, setItem: () => {} };
    const Clappr = { Player: function(opts) { console.log("RESOLVED_URL:" + opts.source); } };
    """
    
    script_path = f"/tmp/eval_{os.getpid()}_{int(time.time()*1000)}.js"
    with open(script_path, "w") as f:
        f.write(mock_dom + target_script)
        
    try:
        p = subprocess.run(["node", script_path], capture_output=True, text=True, timeout=5)
        resolved_url = None
        for line in p.stdout.splitlines():
            if "RESOLVED_URL:" in line:
                resolved_url = line.split("RESOLVED_URL:")[1].strip()
                break
                
        if not resolved_url:
            raise ValueError("No se pudo extraer la variable playbackURL")
            
        return resolved_url
    finally:
        if os.path.exists(script_path):
            os.remove(script_path)

@app.get("/api/v1/channels", response_model=List[ChannelModel])
async def get_channels(include_xameleon: bool = Query(True, description="Incluir catálogo dinámico de Xameleon")):
    """Retorna la lista completa de canales con sus metadatos (incluyendo Xameleon)"""
    channels = list(CHANNELS_DB)
    if include_xameleon:
        try:
            x_channels = await fetch_xameleon_channels()
            channels.extend(x_channels)
        except Exception as e:
            print(f"Warning: No se pudo obtener el catálogo de Xameleon: {e}")
    return channels

@app.get("/api/v1/xameleon/channels", response_model=List[ChannelModel])
async def get_xameleon_channels_endpoint():
    """Retorna exclusivamente los canales obtenidos del catálogo de Xameleon"""
    try:
        return await fetch_xameleon_channels()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error obteniendo catálogo Xameleon: {str(e)}")

@app.get("/api/v1/xameleon/channel/{raw_id}/m3u8")
async def get_xameleon_stream_url(raw_id: str, request: Request):
    """
    Resuelve la URL M3U8 fresca de Xameleon con token de sesión activo.
    """
    try:
        base_url = DEFAULT_BASE_DOMAIN or str(request.base_url).rstrip("/")
        m3u8_url = await resolve_xameleon_stream(raw_id)
        return {
            "id": f"xameleon_{raw_id}",
            "raw_id": raw_id,
            "stream_url": m3u8_url,
            "proxy_stream_url": f"{base_url}/api/v1/xameleon/channel/{raw_id}/proxy-stream",
            "status": "active"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error resolviendo stream de Xameleon: {str(e)}")

@app.get("/api/v1/xameleon/proxy-seg")
async def proxy_xameleon_segment(url: str):
    """
    Proxy directo y ultrarrápido en streaming para segmentos de vídeo (Cloudflare R2 / CDN)
    inyectando cabeceras CORS (Access-Control-Allow-Origin: *) para reproducción web.
    Utiliza el pool de conexiones cdn_pool reutilizables y StreamingResponse.
    """
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        }
        
        req = cdn_pool.build_request("GET", url, headers=headers)
        resp = await cdn_pool.send(req, stream=True)
        
        if resp.status_code != 200:
            await resp.aclose()
            raise HTTPException(status_code=resp.status_code, detail="Error descargando segmento de vídeo")

        async def stream_bytes():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()

        return StreamingResponse(
            stream_bytes(),
            status_code=200,
            media_type=resp.headers.get("content-type", "video/MP2T"),
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Cache-Control": "public, max-age=86400"
            }
        )
    except Exception as e:
        print(f"⚠️ [proxy-seg error]: {e}")
        raise HTTPException(status_code=502, detail=f"Error en proxy-seg: {str(e)}")

@app.get("/api/v1/xameleon/proxy-sub")
async def proxy_xameleon_sub_manifest(url: str, request: Request):
    """
    Proxy genérico para sub-manifiestos M3U8 inyectando cabeceras Referer y Host.
    """
    try:
        base_url = DEFAULT_BASE_DOMAIN or str(request.base_url).rstrip("/")
        sub_proxy_url = f"{base_url}/api/v1/xameleon/proxy-sub"
        seg_proxy_url = f"{base_url}/api/v1/xameleon/proxy-seg"
        
        manifest_content = await fetch_xameleon_m3u8_manifest(url, base_proxy_url=sub_proxy_url, base_seg_proxy_url=seg_proxy_url)
        return Response(
            content=manifest_content,
            media_type="application/x-mpegURL",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*"
            }
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error en proxy-sub: {str(e)}")

@app.get("/api/v1/xameleon/channel/{raw_id}/proxy-stream")
async def proxy_xameleon_manifest(raw_id: str, request: Request):
    """
    Servicio de proxy que desofusca el canal de Xameleon y sirve el contenido M3U8 directamente.
    """
    try:
        base_url = DEFAULT_BASE_DOMAIN or str(request.base_url).rstrip("/")
        sub_proxy_url = f"{base_url}/api/v1/xameleon/proxy-sub"
        seg_proxy_url = f"{base_url}/api/v1/xameleon/proxy-seg"
        
        m3u8_url = await resolve_xameleon_stream(raw_id)
        manifest_content = await fetch_xameleon_m3u8_manifest(m3u8_url, base_proxy_url=sub_proxy_url, base_seg_proxy_url=seg_proxy_url)
        return Response(
            content=manifest_content,
            media_type="application/x-mpegURL",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*"
            }
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error en proxy-stream Xameleon: {str(e)}")


@app.get("/api/v1/channel/{channel_id}/m3u8")
async def get_channel_stream_url(channel_id: str, request: Request):
    """
    Obtiene la URL M3U8 fresca con token autenticado desofuscando el reproductor en tiempo real.
    Soporta IDs nativos y prefijados como xameleon_91.
    """
    if channel_id.startswith("xameleon_"):
        raw_id = channel_id.replace("xameleon_", "")
        return await get_xameleon_stream_url(raw_id, request)

    channel = next((c for c in CHANNELS_DB if c["id"] == channel_id.lower()), None)
    if not channel:
        raise HTTPException(status_code=404, detail="Canal no encontrado")
        
    base_url = DEFAULT_BASE_DOMAIN or str(request.base_url).rstrip("/")
    try:
        # Detectar si el embed apunta a un stream de Xameleon/Daddy (ej. stream-538.php)
        embed_match = re.search(r"stream-(\d+)\.php", channel["embed_url"])
        if embed_match:
            raw_id = embed_match.group(1)
            m3u8_url = await resolve_xameleon_stream(raw_id)
        else:
            m3u8_url = await resolve_embed_m3u8(channel["embed_url"])
            
        return {
            "id": channel["id"],
            "name": channel["name"],
            "stream_key": channel["stream_key"],
            "embed_url": channel["embed_url"],
            "stream_url": m3u8_url,
            "proxy_stream_url": f"{base_url}/api/v1/channel/{channel['id']}/proxy-stream",
            "status": "active"
        }
    except Exception as e:
        # Fallback de emergencia a extractor de Xameleon si embed_url falla
        embed_id_match = re.search(r"(\d+)", channel["embed_url"])
        if embed_id_match:
            try:
                m3u8_url = await resolve_xameleon_stream(embed_id_match.group(1))
                return {
                    "id": channel["id"],
                    "name": channel["name"],
                    "stream_key": channel["stream_key"],
                    "embed_url": channel["embed_url"],
                    "stream_url": m3u8_url,
                    "proxy_stream_url": f"{base_url}/api/v1/channel/{channel['id']}/proxy-stream",
                    "status": "active"
                }
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Error resolviendo stream dinámico: {str(e)}")

@app.get("/api/v1/channel/{channel_id}/proxy-stream")
async def proxy_channel_manifest(channel_id: str, request: Request):
    """
    Desofusca el stream y devuelve el contenido del manifiesto HLS directamente desde el backend.
    """
    if channel_id.startswith("xameleon_"):
        raw_id = channel_id.replace("xameleon_", "")
        return await proxy_xameleon_manifest(raw_id, request)

    channel = next((c for c in CHANNELS_DB if c["id"] == channel_id.lower()), None)
    if not channel:
        raise HTTPException(status_code=404, detail="Canal no encontrado")
        
    try:
        embed_match = re.search(r"stream-(\d+)\.php", channel["embed_url"])
        if embed_match:
            raw_id = embed_match.group(1)
            return await proxy_xameleon_manifest(raw_id, request)

        m3u8_url = await resolve_embed_m3u8(channel["embed_url"])
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Referer": "https://streamx-hd.com/"
        }
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(m3u8_url, headers=headers)
            return Response(content=resp.content, status_code=resp.status_code, media_type="application/x-mpegURL")
    except Exception as e:
        # Fallback si falla el embed directo
        embed_id_match = re.search(r"(\d+)", channel["embed_url"])
        if embed_id_match:
            try:
                return await proxy_xameleon_manifest(embed_id_match.group(1), request)
            except Exception:
                pass
        raise HTTPException(status_code=502, detail=f"Error proxy-stream: {str(e)}")

@app.get("/playlist.m3u", response_class=PlainTextResponse)
async def get_m3u_playlist(request: Request):
    """
    Genera la lista M3U dinámicamente apuntando a los endpoints de resolución de la API.
    Utiliza la variable de entorno BASE_DOMAIN o el host de la petición entrante.
    """
    base_url = DEFAULT_BASE_DOMAIN or str(request.base_url).rstrip("/")
    lines = ["#EXTM3U"]
    for ch in CHANNELS_DB:
        url = f"{base_url}/api/v1/channel/{ch['id']}/proxy-stream"
        lines.append(f'#EXTINF:-1 tvg-id="{ch["id"]}" tvg-name="{ch["name"]}" group-title="{ch["category"]}",{ch["name"]}')
        lines.append(url)
    
    # Incluir también los canales de Xameleon
    try:
        x_channels = await fetch_xameleon_channels()
        for ch in x_channels:
            url = f"{base_url}/api/v1/channel/{ch['id']}/proxy-stream"
            lines.append(f'#EXTINF:-1 tvg-id="{ch["id"]}" tvg-name="{ch["name"]}" group-title="{ch["category"]}",{ch["name"]}')
            lines.append(url)
    except Exception as e:
        print(f"Warning: No se pudieron añadir los canales Xameleon a la playlist.m3u: {e}")

    return "\n".join(lines)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8070)

