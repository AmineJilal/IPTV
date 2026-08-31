import re
import base64
import time
import httpx
import urllib.parse
from typing import List, Dict, Optional

DLSTREAMS_IP = "213.21.239.30"
XAMELEON_IP = "31.58.210.230"

DLSTREAMS_HOST = "dlstreams.st"
ROMPONALIS_HOST = "hamis.romponalis.st"
XAMELEON_HOST = "xameleon.phantemlis.top"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}

FALLBACK_SPANISH_CHANNELS = [
    {"raw_id": "538", "name": "DAZN LaLiga"},
    {"raw_id": "537", "name": "DAZN F1 ES"},
    {"raw_id": "445", "name": "DAZN 1 Spain"},
    {"raw_id": "446", "name": "DAZN 2 Spain"},
    {"raw_id": "447", "name": "DAZN 3 Spain"},
    {"raw_id": "448", "name": "DAZN 4 Spain"},
    {"raw_id": "435", "name": "Movistar Liga de Campeones"},
    {"raw_id": "84",  "name": "Movistar LaLiga"},
    {"raw_id": "436", "name": "Movistar Deportes Spain"},
    {"raw_id": "438", "name": "Movistar Deportes 2 Spain"},
    {"raw_id": "526", "name": "Movistar Deportes 3 Spain"},
    {"raw_id": "527", "name": "Movistar Deportes 4 Spain"},
    {"raw_id": "528", "name": "Movistar Golf Spain"},
    {"raw_id": "523", "name": "Real Madrid TV Spain"},
    {"raw_id": "539", "name": "LaLiga SmartBank TV"},
    {"raw_id": "533", "name": "TVE La 1 Spain"},
    {"raw_id": "531", "name": "Antena 3 Spain"},
    {"raw_id": "535", "name": "Cuatro Spain"},
    {"raw_id": "532", "name": "Telecinco Spain"},
    {"raw_id": "534", "name": "La Sexta Spain"}
]

async def fetch_xameleon_channels() -> List[Dict[str, str]]:
    channels = []
    try:
        direct_url = f"https://{DLSTREAMS_IP}/24-7-channels.php"
        headers_direct = {**DEFAULT_HEADERS, "Host": DLSTREAMS_HOST, "Referer": f"https://{DLSTREAMS_HOST}/"}
        
        async with httpx.AsyncClient(verify=False, timeout=3.0) as client:
            resp = await client.get(direct_url, headers=headers_direct)
            
        if resp.status_code == 200:
            matches = re.findall(r"<a[^>]+href=[\x22\x27]/watch\.php\?id=(\d+)[\x22\x27][^>]*>(.*?)</a>", resp.text, re.DOTALL)
            seen = set()
            for ch_id, title_raw in matches:
                if ch_id in seen: continue
                seen.add(ch_id)
                clean_title = re.sub(r"<[^>]+>", "", title_raw).strip()
                clean_title = re.sub(r"\s+", " ", clean_title)
                clean_title = re.sub(r"ID:\s*\d+", "", clean_title).strip()
                
                clean_lower = clean_title.lower()
                if "18+" in clean_lower or "+18" in clean_lower or "adult" in clean_lower or "xxx" in clean_lower or "erotic" in clean_lower:
                    continue
                    
                channels.append({
                    "id": f"xameleon_{ch_id}",
                    "raw_id": ch_id,
                    "name": clean_title or f"Canal {ch_id}",
                    "stream_key": f"XAMELEON_{ch_id}",
                    "category": "Xameleon TV",
                    "server": DLSTREAMS_HOST,
                    "embed_url": f"https://{DLSTREAMS_HOST}/watch.php?id={ch_id}"
                })
    except Exception as e:
        print(f"⚠️ Error cargando catálogo remoto ({e}). Usando catálogo fallback.")

    if not channels:
        for item in FALLBACK_SPANISH_CHANNELS:
            ch_id = item["raw_id"]
            name = item["name"]
            channels.append({
                "id": f"xameleon_{ch_id}",
                "raw_id": ch_id,
                "name": name,
                "stream_key": f"XAMELEON_{ch_id}",
                "category": "Movistar / DAZN",
                "server": DLSTREAMS_HOST,
                "embed_url": f"https://{DLSTREAMS_HOST}/watch.php?id={ch_id}"
            })

    return channels

STREAM_RESOLVE_CACHE = {}

async def resolve_xameleon_stream(channel_raw_id: str, force_refresh: bool = False, ttl_seconds: float = 60.0) -> str:
    now = time.time()
    if force_refresh:
        STREAM_RESOLVE_CACHE.pop(channel_raw_id, None)
    elif channel_raw_id in STREAM_RESOLVE_CACHE:
        cached_time, cached_url = STREAM_RESOLVE_CACHE[channel_raw_id]
        if now - cached_time < ttl_seconds:
            return cached_url

    # El proveedor cuenta con 5 servidores espejo (daddy.php, daddy2.php, daddy3.php, daddy4.php, daddy5.php)
    endpoints = ["daddy2.php", "daddy3.php", "daddy.php", "daddy4.php", "daddy5.php"]
    headers_direct = {
        **DEFAULT_HEADERS,
        "Referer": f"https://{DLSTREAMS_HOST}/",
        "Host": ROMPONALIS_HOST
    }

    headers_xam = {
        **DEFAULT_HEADERS,
        "Referer": "https://hamis.romponalis.st/",
        "Host": XAMELEON_HOST
    }

    last_decoded = None

    import asyncio

    async def check_endpoint(ep: str) -> Optional[str]:
        # 1. Probar por Tor SOCKS5 (Bypass de bloqueo ISP Vodafone/Movistar y dominio CDN)
        try:
            async with httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", verify=False, timeout=5.0) as client:
                direct_url = f"https://{DLSTREAMS_IP}/premiumtv/{ep}?id={channel_raw_id}"
                resp = await client.get(direct_url, headers=headers_direct)
                if resp.status_code == 200:
                    match = re.search(r"window\.atob\([\x22\x27]([^\x22\x27]+)[\x22\x27]\)", resp.text)
                    if match:
                        decoded_url = base64.b64decode(match.group(1)).decode("utf-8")
                        m3u8_resp = await client.get(decoded_url, headers=headers_xam)
                        if m3u8_resp.status_code == 200 and "#EXTM3U" in m3u8_resp.text:
                            return decoded_url
        except Exception:
            pass

        # 2. Fallback a IP directa si Tor no está activo
        try:
            async with httpx.AsyncClient(verify=False, timeout=3.5) as client:
                direct_url = f"https://{DLSTREAMS_IP}/premiumtv/{ep}?id={channel_raw_id}"
                resp = await client.get(direct_url, headers=headers_direct)
                if resp.status_code == 200:
                    match = re.search(r"window\.atob\([\x22\x27]([^\x22\x27]+)[\x22\x27]\)", resp.text)
                    if match:
                        decoded_url = base64.b64decode(match.group(1)).decode("utf-8")
                        alt_url = decoded_url.replace(f"https://{XAMELEON_HOST}", f"https://{XAMELEON_IP}")
                        m3u8_resp = await client.get(alt_url, headers={**headers_xam, "Host": XAMELEON_HOST})
                        if m3u8_resp.status_code == 200 and "#EXTM3U" in m3u8_resp.text:
                            return decoded_url
        except Exception:
            pass
        return None

    tasks = [asyncio.create_task(check_endpoint(ep)) for ep in endpoints]
    for completed in asyncio.as_completed(tasks):
        res = await completed
        if res:
            for t in tasks:
                if not t.done():
                    t.cancel()
            STREAM_RESOLVE_CACHE[channel_raw_id] = (now, res)
            return res

    raise ValueError("El canal no está emitiendo activamente en ningún servidor espejo en este momento")

MANIFEST_CACHE = {}

async def fetch_xameleon_m3u8_manifest(m3u8_url: str, base_proxy_url: Optional[str] = None, base_seg_proxy_url: Optional[str] = None) -> str:
    now = time.time()
    raw_text = None

    if m3u8_url in MANIFEST_CACHE:
        cached_time, cached_content = MANIFEST_CACHE[m3u8_url]
        if now - cached_time < 3.0:
            raw_text = cached_content

    if not raw_text:
        headers_xam = {
            **DEFAULT_HEADERS,
            "Referer": "https://hamis.romponalis.st/"
        }
        
        resp = None
        # 1. Intentar descargar manifiesto vía Tor con dominio oficial (Bypass 500 de IP directa)
        try:
            async with httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", verify=False, timeout=8.0) as client:
                res = await client.get(m3u8_url, headers=headers_xam)
                if res.status_code == 200 and "#EXTM3U" in res.text:
                    resp = res
                else:
                    print(f"[xameleon_manifest] Tor status: {res.status_code}, body: {res.text[:100]}")
        except Exception as err:
            print(f"[xameleon_manifest] Tor exception: {err}")

        # 2. Fallback a IP directa si Tor no responde
        if not resp:
            headers_direct = {**headers_xam, "Host": XAMELEON_HOST}
            target_url = m3u8_url.replace(f"https://{XAMELEON_HOST}", f"https://{XAMELEON_IP}")
            try:
                async with httpx.AsyncClient(verify=False, timeout=8.0, follow_redirects=True) as client:
                    res_direct = await client.get(target_url, headers=headers_direct)
                    if res_direct.status_code == 200 and "#EXTM3U" in res_direct.text:
                        resp = res_direct
                    else:
                        print(f"[xameleon_manifest] Direct status: {res_direct.status_code}, body: {res_direct.text[:100]}")
            except Exception as err:
                print(f"[xameleon_manifest] Direct exception: {err}")
            
        if not resp:
            raise ValueError(f"Error descargando M3U8 desde el proveedor ({m3u8_url})")

        raw_text = resp.text
        MANIFEST_CACHE[m3u8_url] = (now, raw_text)

    base_dir = m3u8_url.rsplit("/", 1)[0] + "/"
    lines = []
    for line in raw_text.splitlines():
        line_str = line.strip()
        if line_str and not line_str.startswith("#"):
            if not line_str.startswith("http://") and not line_str.startswith("https://"):
                full_url = base_dir + line_str
            else:
                full_url = line_str
                
            quoted_url = urllib.parse.quote(full_url, safe="")
            if base_proxy_url and ".m3u8" in full_url:
                lines.append(f"{base_proxy_url}?url={quoted_url}")
            elif base_seg_proxy_url:
                lines.append(f"{base_seg_proxy_url}?url={quoted_url}")
            else:
                lines.append(full_url)
        else:
            if 'URI="' in line_str and base_seg_proxy_url:
                def replace_uri(match):
                    uri = match.group(1)
                    abs_uri = uri if uri.startswith("http") else base_dir + uri
                    quoted_abs = urllib.parse.quote(abs_uri, safe="")
                    return f'URI="{base_seg_proxy_url}?url={quoted_abs}"'
                line_str = re.sub(r'URI="([^"]+)"', replace_uri, line_str)
            lines.append(line_str)
            
    return "\n".join(lines)
