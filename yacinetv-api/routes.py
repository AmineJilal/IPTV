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
    
    # Hemos eliminado el proxy de video (hls_url) aquí.
    # Ahora el cliente final obtendrá direct_url (res["data"][0]["url"]) y 
    # se conectará directamente a la fuente HLS, mejorando drásticamente el rendimiento.
    return res

