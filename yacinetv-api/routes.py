from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from api import YacineTV
import re
import urllib.parse
import httpx

ytv = YacineTV()
router = APIRouter(tags=["YacineTV"])

YACINE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
    "Referer": "https://x.com/",
    "Accept": "*/*"
}

# Cliente HTTP global con piscina de conexiones de alto rendimiento
client = httpx.AsyncClient(timeout=10.0, follow_redirects=True, verify=False)

def get_base_url(request: Request) -> str:
    scheme = request.url.scheme
    host = request.headers.get("host") or f"{request.url.hostname}:{request.url.port}"
    return f"{scheme}://{host}"

@router.get("/categories")
def categories():
    return ytv.get_categories()

@router.get("/categories/{category_id}/channels")
def channels(category_id: str):
    clean_cat = re.sub(r'^\D+', '', str(category_id))
    return ytv.get_category_channels(clean_cat or category_id)

@router.get("/channel/{channel_id}")
def channel(channel_id: str, request: Request):
    match = re.search(r'(\d+)$', str(channel_id))
    pure_id = match.group(1) if match else str(channel_id)
    res = ytv.get_channel(pure_id)
    
    if res and res.get("data") and len(res["data"]) > 0:
        base_url = get_base_url(request)
        direct_url = res["data"][0].get("url")
        if direct_url:
            res["hls_url"] = f"{base_url}/proxy-yacine?url={urllib.parse.quote(direct_url)}"
    return res

import time

m3u8_cache = {}

@router.get("/proxy-yacine-seg")
async def proxy_yacine_seg(url: str):
    target = urllib.parse.unquote(url)
    try:
        # FIX #5: Usar send(stream=True) + StreamingResponse para NO cargar el segmento
        # completo en RAM. Esto es crítico para el límite de 5GB de Render.
        req_obj = client.build_request("GET", target, headers=YACINE_HEADERS)
        resp = await client.send(req_obj, stream=True)
        if resp.status_code not in (200, 206):
            await resp.aclose()
            raise HTTPException(status_code=resp.status_code, detail=f"HTTP {resp.status_code}")
        
        async def _stream():
            try:
                async for chunk in resp.aiter_bytes(chunk_size=8192):
                    yield chunk
            finally:
                await resp.aclose()
        
        return StreamingResponse(
            _stream(),
            status_code=200,
            media_type="video/MP2T",
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"}
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@router.get("/proxy-yacine")
async def proxy_yacine_manifest(request: Request, url: str):
    target = urllib.parse.unquote(url)
    
    # Micro-caché de 3 segundos para el manifiesto M3U8 (Evita DDoS interno y ahorra ancho de banda)
    current_time = time.time()
    if target in m3u8_cache and current_time - m3u8_cache[target]['time'] < 3.0:
        return Response(content=m3u8_cache[target]['content'], media_type="application/vnd.apple.mpegurl", headers={"Access-Control-Allow-Origin": "*"})

    try:
        resp = await client.get(target, headers=YACINE_HEADERS)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code)
            
        final_url = str(resp.url)
        base_url = get_base_url(request)
        proxy_seg_url = f"{base_url}/proxy-yacine-seg"
        proxy_sub_url = f"{base_url}/proxy-yacine"
        base_dir = final_url.rsplit("/", 1)[0] + "/"
        
        lines = []
        for line in resp.text.splitlines():
            line_str = line.strip()
            if line_str and not line_str.startswith("#"):
                full_url = line_str if line_str.startswith("http") else urllib.parse.urljoin(final_url, line_str)
                q_url = urllib.parse.quote(full_url, safe="")
                if ".m3u8" in full_url:
                    lines.append(f"{proxy_sub_url}?url={q_url}")
                else:
                    lines.append(f"{proxy_seg_url}?url={q_url}")
            else:
                if 'URI="' in line_str:
                    def replace_uri(match):
                        uri = match.group(1)
                        abs_uri = uri if uri.startswith("http") else urllib.parse.urljoin(final_url, uri)
                        quoted_abs = urllib.parse.quote(abs_uri, safe="")
                        return f'URI="{proxy_seg_url}?url={quoted_abs}"'
                    line_str = re.sub(r'URI="([^"]+)"', replace_uri, line_str)
                lines.append(line_str)
                
        final_content = "\n".join(lines)
        
        # Guardar en caché
        m3u8_cache[target] = {
            'time': current_time,
            'content': final_content
        }
        
        # Limpiar caché vieja para evitar fugas de memoria
        keys_to_delete = [k for k, v in m3u8_cache.items() if current_time - v['time'] > 10.0]
        for k in keys_to_delete:
            del m3u8_cache[k]
            
        return Response(content=final_content, media_type="application/vnd.apple.mpegurl", headers={"Access-Control-Allow-Origin": "*"})
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


