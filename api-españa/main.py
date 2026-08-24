import os
import json
import urllib.parse
import httpx
import time
import asyncio
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from extractors.factory import StreamFactory
from extractors.utils import normalize_channel_id

app = FastAPI(
    title="API TDT España",
    description="API REST en FastAPI para obtener canales de TV de España y resolver sus URLs de emisión en directo (HLS/DASH/MP4).",
    version="1.0.0"
)

# Permitir CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TDT_CHANNELS_URL = "https://www.tdtspain.com/canales/canalesv4.json"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

# Cache en memoria con TTL de 10 minutos
data_cache = {
    "raw_json": None,
    "timestamp": 0
}

async def fetch_tdt_data():
    """Descarga los datos actualizados de TDT Spain con reintentos y caché de 10 min."""
    now = time.time()
    if data_cache["raw_json"] is not None and (now - data_cache["timestamp"] < 600):
        return data_cache["raw_json"]

    max_retries = 3
    for attempt in range(max_retries):
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(TDT_CHANNELS_URL, headers={"User-Agent": USER_AGENT})
                if resp.status_code == 200:
                    data_cache["raw_json"] = resp.json()
                    data_cache["timestamp"] = now
                    return data_cache["raw_json"]
        except (httpx.TimeoutException, httpx.RequestError) as e:
            if attempt < max_retries - 1:
                await asyncio.sleep(1)
                continue
            
    # Fallback a caché antiguo si existe
    if data_cache["raw_json"] is not None:
        return data_cache["raw_json"]
        
    raise HTTPException(
        status_code=504, 
        detail={"error": "Gateway Timeout", "message": "No se pudo obtener la lista de TDT Spain."}
    )

@app.api_route("/", methods=["GET", "HEAD"])
def read_root():
    return "Hola Mundo"

@app.get("/canales")
async def get_canales(grupo: str = Query(None, description="Filtrar por grupo (ej: Nacionales, Autonómicos)")):
    """Devuelve la lista general de canales disponibles."""
    data = await fetch_tdt_data()
    canales = data.get("canales", [])
    
    result = []
    for c in canales:
        if grupo and c.get("group", "").lower() != grupo.lower():
            continue
        result.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "group": c.get("group"),
            "logo": c.get("logo"),
            "logocolor": c.get("logocolor"),
            "streamtype": c.get("streamtype"),
            "raw_url_id": c.get("url")
        })
    return {"total": len(result), "canales": result}

@app.get("/canales/{id_canal}")
async def get_canal_detail(id_canal: str):
    """Devuelve los detalles de un canal específico."""
    data = await fetch_tdt_data()
    canales = data.get("canales", [])
    norm_id = normalize_channel_id(id_canal)
    for c in canales:
        cid = c.get("id", "").lower()
        if cid == id_canal.lower() or cid.replace(".tv", "") == norm_id:
            return c
    raise HTTPException(status_code=404, detail="Canal no encontrado")

@app.get("/canales/{id_canal}/stream")
async def resolve_stream(id_canal: str):
    """
    Resuelve y devuelve el enlace final directo (.m3u8, .mpd) o la estructura de reproducción del canal.
    """
    norm_id = normalize_channel_id(id_canal)
    extractor = StreamFactory.get_extractor(id_canal)
    if extractor:
        return await extractor.extract_stream(id_canal, "")
        
    data = await fetch_tdt_data()
    canales = data.get("canales", [])
    
    canal = None
    for c in canales:
        cid = c.get("id", "").lower()
        if cid == id_canal.lower() or cid.replace(".tv", "") == norm_id or normalize_channel_id(cid) == norm_id:
            canal = c
            break
            
    if not canal:
        raise HTTPException(status_code=404, detail=f"Canal '{id_canal}' no encontrado")
        
    stype = canal.get("streamtype")
    raw_url = canal.get("url", "")
    
    # 1. Canales con URL directa (stream0 o HTTP directo m3u8)
    if stype in ["stream0", "stream"] or (raw_url.startswith("http") and raw_url.endswith(".m3u8")):
        return {
            "canal": canal.get("name"),
            "type": "direct_m3u8",
            "m3u8_url": raw_url,
            "headers_required": {"User-Agent": USER_AGENT}
        }
        
    # 2. Atresmedia -> delegar al extractor obligatoriamente
    elif stype == "stream11":
        ext = StreamFactory.get_extractor(canal.get("id", ""))
        if ext:
            return await ext.extract_stream(canal.get("id", ""), raw_url)
        raise HTTPException(status_code=500, detail=f"No extractor available for stream11 channel: {id_canal}")

    # 3. RTVE (La 1, La 2, 24h, Teledeporte) -> stream1
    elif stype == "stream1":
        video_id = raw_url
        mpd_url = f"https://ztnr.rtve.es/ztnr/{video_id}.mpd"
        m3u8_url = f"https://ztnr.rtve.es/ztnr/{video_id}.m3u8"
        token_api = f"https://api.rtve.es/api/token/{video_id}"
        
        headers = {
            "Origin": "https://www.rtve.es",
            "Referer": "https://www.rtve.es/",
            "User-Agent": USER_AGENT
        }
        
        return {
            "canal": canal.get("name"),
            "type": "rtve_stream",
            "mpd_url": mpd_url,
            "m3u8_url": m3u8_url,
            "token_api": token_api,
            "headers_required": headers
        }

    # 4. Mediaset (Telecinco, Cuatro, FDF, Divinity, etc.) -> stream10
    elif stype == "stream10":
        headers = {
            "Origin": "https://www.mediasetinfinity.es",
            "Referer": "https://www.mediasetinfinity.es/",
            "User-Agent": USER_AGENT
        }
        return {
            "canal": canal.get("name"),
            "type": "mediaset_stream",
            "stream_url": raw_url,
            "headers_required": headers
        }

    # Caso genérico / fallback
    return {
        "canal": canal.get("name"),
        "type": stype,
        "stream_url": raw_url,
        "headers_required": {
            "User-Agent": USER_AGENT,
            "Referer": "https://www.tdtspain.com/"
        }
    }

@app.get("/api/stream/{channel_id}")
async def resolve_unified_stream(channel_id: str):
    """
    Endpoint unificado que delega la extracción del stream (.m3u8 puro)
    al módulo correspondiente (Atresmedia, Mediaset, etc.) usando el Patrón Factory.
    """
    norm_id = normalize_channel_id(channel_id)
    extractor = StreamFactory.get_extractor(channel_id)
    extractor_name = extractor.__class__.__name__ if extractor else "None"
    print(f"🚀 [/api/stream/{channel_id}] Recibido: '{channel_id}' | norm_id: '{norm_id}' | Extractor: '{extractor_name}'")
    
    if extractor:
        try:
            res = await extractor.extract_stream(channel_id, "")
            print(f"✅ [/api/stream/{channel_id}] Éxito con {extractor_name}: m3u8_url='{res.get('m3u8_url')}'")
            return res
        except Exception as e:
            print(f"❌ [/api/stream/{channel_id}] Error en {extractor_name}: {e}")
            raise HTTPException(status_code=500, detail=f"Extractor error for '{channel_id}': {str(e)}")

    # Fallback a la resolución general si no hay extractor específico
    return await resolve_stream(channel_id)

@app.get("/playlist.m3u8")
async def generate_m3u_playlist():
    """Genera una lista IPTV M3U8 dinámica con todos los canales."""
    data = await fetch_tdt_data()
    canales = data.get("canales", [])
    
    m3u_lines = ["#EXTM3U"]
    for c in canales:
        cid = c.get("id")
        name = c.get("name")
        group = c.get("group", "TDT")
        logo = c.get("logo", "")
        
        # Apuntamos el enlace al endpoint resolutor de nuestra propia API
        stream_link = f"http://localhost:8080/canales/{cid}/stream"
        
        m3u_lines.append(f'#EXTINF:-1 tvg-id="{cid}" tvg-name="{name}" tvg-logo="{logo}" group-title="{group}",{name}')
        m3u_lines.append(stream_link)
        
    from fastapi.responses import Response
    return Response(content="\n".join(m3u_lines), media_type="application/x-mpegURL")

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=False)
