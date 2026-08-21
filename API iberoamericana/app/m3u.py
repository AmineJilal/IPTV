from fastapi import APIRouter, Request, Response
from app.extractor import extractor

router = APIRouter(tags=["IPTV M3U Playlist"])

@router.get("/playlist.m3u", summary="Export IPTV M3U Playlist")
@router.get("/api/m3u", summary="Export IPTV M3U Playlist")
async def get_m3u_playlist(request: Request):
    base_server_url = str(request.base_url).rstrip('/')
    channels = await extractor.get_channels()
    agenda = await extractor.get_agenda()

    lines = ["#EXTM3U url-tvg=\"https://futbollibretv.sx/epg.xml\" x-tvg-url=\"https://futbollibretv.sx/epg.xml\""]

    # 1. Add static channels
    for ch in channels:
        cid = ch["id"]
        cname = ch["name"]
        clogo = ch.get("logo", "")
        stream_url = f"{base_server_url}/api/live/{cid}/playlist.m3u8"
        
        lines.append(f'#EXTINF:-1 tvg-id="{cid}" tvg-name="{cname}" tvg-logo="{clogo}" group-title="Canales Deportivos HD",{cname}')
        lines.append(stream_url)

    # 2. Add agenda live events
    for ev in agenda:
        title = ev.get("title", "Evento")
        time_str = ev.get("time", "")
        category = ev.get("category", "LIVE")
        
        for ch in ev.get("channels", []):
            ch_name = ch.get("name", "Canal")
            quality = ch.get("quality", "HD")
            proxy_path = ch.get("stream_proxy", "")
            
            if proxy_path:
                full_stream_url = f"{base_server_url}{proxy_path}" if proxy_path.startswith("/") else proxy_path
                display_name = f"[LIVE {time_str}] {title} - {ch_name} ({quality})"
                lines.append(f'#EXTINF:-1 tvg-name="{display_name}" group-title="Agenda: {category}",{display_name}')
                lines.append(full_stream_url)

    m3u_content = "\n".join(lines)
    return Response(
        content=m3u_content,
        media_type="application/x-mpegurl",
        headers={
            "Content-Disposition": 'attachment; filename="futbol_libre_channels.m3u"',
            "Access-Control-Allow-Origin": "*"
        }
    )
