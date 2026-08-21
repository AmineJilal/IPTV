import os
import json
import urllib.parse
import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

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
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

import time
import asyncio

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

@app.get("/")
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
    for c in canales:
        if c.get("id", "").lower() == id_canal.lower():
            return c
    raise HTTPException(status_code=404, detail="Canal no encontrado")

@app.get("/canales/{id_canal}/stream")
async def resolve_stream(id_canal: str):
    """
    Resuelve y devuelve el enlace final directo (.m3u8, .mpd) o la estructura de reproducción del canal.
    """
    data = await fetch_tdt_data()
    canales = data.get("canales", [])
    streamstype = data.get("streamstype", {})
    
    canal = None
    for c in canales:
        if c.get("id", "").lower() == id_canal.lower():
            canal = c
            break
            
    if not canal:
        raise HTTPException(status_code=404, detail="Canal no encontrado")
        
    stype = canal.get("streamtype")
    raw_url = canal.get("url", "")
    
    # 1. Canales con URL directa (stream0 o HTTP directo m3u8)
    if stype in ["stream0", "stream"] or raw_url.startswith("http") and raw_url.endswith(".m3u8"):
        return {
            "canal": canal.get("name"),
            "type": "direct_m3u8",
            "stream_url": raw_url,
            "headers": {"User-Agent": USER_AGENT}
        }
        
    # 2. Atresmedia (Antena 3, La Sexta, Neox, Nova, Mega, Atreseries) -> stream11
    elif stype == "stream11":
        href_encoded = urllib.parse.quote(raw_url, safe="")
        api_url = f"https://api.atresplayer.com/client/v1/url?href={href_encoded}"
        headers = {
            "Origin": "https://www.atresplayer.com",
            "Referer": "https://www.atresplayer.com/",
            "User-Agent": USER_AGENT
        }
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(api_url, headers=headers)
                if res.status_code == 200:
                    json_res = res.json()
                    # Retornamos los enlaces de video extraídos
                    sources = json_res.get("sources", [])
                    stream_url = None
                    if sources:
                        stream_url = sources[0].get("src")
                    elif "urlVideo" in json_res:
                        stream_url = json_res.get("urlVideo")
                        
                    return {
                        "canal": canal.get("name"),
                        "type": "atresmedia_hls",
                        "stream_url": stream_url,
                        "raw_response": json_res,
                        "headers": headers
                    }
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error resolviendo stream de Atresmedia: {str(e)}")

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
            "headers": headers
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
            "info": "Requiere autenticación anónima con el servidor OTT de Mediaset",
            "web_url": raw_url,
            "headers": headers
        }

    # Caso genérico / fallback
    return {
        "canal": canal.get("name"),
        "type": stype,
        "raw_url": raw_url,
        "note": "Canal con método de stream personalizado"
    }

from extractors.factory import StreamFactory

@app.get("/api/stream/{channel_id}")
async def resolve_unified_stream(channel_id: str):
    """
    Endpoint unificado que delega la extracción del stream (.m3u8 puro)
    al módulo correspondiente (Atresmedia, Mediaset, etc.) usando el Patrón Factory.
    """
    extractor = StreamFactory.get_extractor(channel_id)
    
    if not extractor:
        # Fallback a la resolución original si no hay extractor avanzado
        return await resolve_stream(channel_id)
        
    try:
        # Obtenemos la url cruda para pasársela al extractor si la necesita
        data = await fetch_tdt_data()
        canales = data.get("canales", [])
        raw_url = ""
        for c in canales:
            if c.get("id", "").lower() == channel_id.lower():
                raw_url = c.get("url", "")
                break
                
        result = await extractor.extract_stream(channel_id, raw_url)
        return result
    except Exception as e:
        import traceback
        print(f"Error en extracción unificada para {channel_id}: {e}")
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail={"error": "Extraction Failed", "message": str(e), "channel_id": channel_id}
        )

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
