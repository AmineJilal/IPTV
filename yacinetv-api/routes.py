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
    
    if res and isinstance(res, dict) and res.get("data") and len(res["data"]) > 0 and res["data"][0].get("url"):
        base_url = get_base_url(request)
        direct_url = res["data"][0]["url"]
        quoted_url = urllib.parse.quote(direct_url, safe="")
        res["hls_url"] = f"{base_url}/proxy/m3u8?url={quoted_url}"
    return res

@router.get("/proxy/m3u8")
async def proxy_m3u8(url: str, request: Request):
    target_url = urllib.parse.unquote(url)
    if not target_url.startswith("http"):
        raise HTTPException(status_code=400, detail="URL inválida")
        
    try:
        resp = await client.get(target_url, headers=YACINE_HEADERS)
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"HTTP {resp.status_code}")
            
        base_url = get_base_url(request)
        content = resp.text
        lines = []
        base_dir = target_url.rsplit("/", 1)[0] + "/"

        for line in content.splitlines():
            line_str = line.strip()
            if not line_str:
                continue
            if line_str.startswith("#"):
                if 'URI="' in line_str:
                    def replace_uri(m):
                        uri = m.group(1)
                        abs_uri = uri if uri.startswith("http") else urllib.parse.urljoin(base_dir, uri)
                        q_abs = urllib.parse.quote(abs_uri, safe="")
                        return f'URI="{base_url}/proxy/ts?url={q_abs}"'
                    line_str = re.sub(r'URI="([^"]+)"', replace_uri, line_str)
                lines.append(line_str)
            else:
                abs_url = line_str if line_str.startswith("http") else urllib.parse.urljoin(base_dir, line_str)
                q_abs = urllib.parse.quote(abs_url, safe="")
                if ".m3u8" in line_str or ".m3u8" in abs_url:
                    lines.append(f"{base_url}/proxy/m3u8?url={q_abs}")
                else:
                    lines.append(f"{base_url}/proxy/ts?url={q_abs}")

        return Response(
            content="\n".join(lines),
            media_type="application/x-mpegURL",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*"
            }
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

@router.get("/proxy/ts")
async def proxy_ts(url: str):
    target_url = urllib.parse.unquote(url)
    if not target_url.startswith("http"):
        raise HTTPException(status_code=400, detail="URL inválida")

    try:
        req = client.build_request("GET", target_url, headers=YACINE_HEADERS)
        resp = await client.send(req, stream=True)
        if resp.status_code not in (200, 206):
            await resp.aclose()
            raise HTTPException(status_code=resp.status_code, detail=f"HTTP {resp.status_code}")

        async def stream_bytes():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await resp.aclose()

        return StreamingResponse(
            stream_bytes(),
            media_type="video/MP2T",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Cache-Control": "public, max-age=86400"
            }
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

