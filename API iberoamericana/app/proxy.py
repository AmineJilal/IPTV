from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import StreamingResponse, Response
import httpx
import re
from urllib.parse import urljoin, quote, unquote
from app.config import settings
from app.extractor import extractor

router = APIRouter(tags=["Stream Proxy"])

async def get_proxy_headers(target_url: str) -> dict:
    # Determine base referer from target url domain
    if "tudeporteshoy" in target_url or "streamtp" in target_url:
        site_cfg = await extractor.fetch_site_config()
        referer = f"https://{site_cfg['activeDomain']}/"
    else:
        referer = settings.BASE_URL
    return {
        "User-Agent": settings.USER_AGENT,
        "Referer": referer,
        "Accept": "*/*"
    }

@router.get("/api/live/{channel_id}/playlist.m3u8", summary="Proxy dynamic M3U8 master playlist for channel")
async def proxy_live_channel_m3u8(channel_id: str):
    res = await extractor.resolve_stream(channel_id)
    if res.get("status") != "online" or "m3u8_url" not in res:
        raise HTTPException(status_code=404, detail=res.get("error", "Stream not available"))

    m3u8_url = res["m3u8_url"]
    return await proxy_playlist_url(m3u8_url)

@router.get("/api/proxy/sub", summary="Proxy variant/sub-playlist M3U8")
async def proxy_sub_m3u8(url: str):
    target_url = unquote(url)
    return await proxy_playlist_url(target_url)

async def proxy_playlist_url(m3u8_url: str):
    headers = await get_proxy_headers(m3u8_url)
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(m3u8_url, headers=headers)
            if resp.status_code != 200:
                raise HTTPException(status_code=resp.status_code, detail="Upstream playlist error")

            content = resp.text
            modified_lines = []

            for line in content.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                
                if stripped.startswith("#"):
                    # Check for URI inside tags like #EXT-X-KEY:METHOD=AES-128,URI="...
                    if 'URI="' in stripped:
                        def rewrite_uri(match):
                            orig_uri = match.group(1)
                            full_uri = urljoin(m3u8_url, orig_uri)
                            proxy_uri = f"/api/proxy/ts?url={quote(full_uri)}"
                            return f'URI="{proxy_uri}"'
                        stripped = re.sub(r'URI="([^"]+)"', rewrite_uri, stripped)
                    modified_lines.append(stripped)
                else:
                    # Target URL
                    full_line_url = urljoin(m3u8_url, stripped)
                    if ".m3u8" in stripped or ".m3u8" in full_line_url:
                        proxy_line = f"/api/proxy/sub?url={quote(full_line_url)}"
                    else:
                        proxy_line = f"/api/proxy/ts?url={quote(full_line_url)}"
                    modified_lines.append(proxy_line)

            modified_m3u8 = "\n".join(modified_lines)
            return Response(
                content=modified_m3u8,
                media_type="application/x-mpegURL",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, OPTIONS",
                    "Cache-Control": "no-cache"
                }
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to proxy playlist: {str(e)}")

@router.get("/api/proxy/ts", summary="Proxy video segment chunk (.ts)")
async def proxy_ts_segment(url: str):
    target_url = unquote(url)
    headers = await get_proxy_headers(target_url)

    async def stream_generator():
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            async with client.stream("GET", target_url, headers=headers) as resp:
                if resp.status_code == 200:
                    async for chunk in resp.aiter_bytes():
                        yield chunk

    return StreamingResponse(
        stream_generator(),
        media_type="video/MP2T",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Cache-Control": "public, max-age=3600"
        }
    )
