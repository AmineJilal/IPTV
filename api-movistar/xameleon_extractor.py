import re
import base64
import httpx
from typing import List, Dict, Optional

# Hosts e IPs directas para bypass de SNI del ISP
DLSTREAMS_IP = "213.21.239.30"
XAMELEON_IP = "31.58.210.230"

DLSTREAMS_HOST = "dlstreams.st"
ROMPONALIS_HOST = "hamis.romponalis.st"
XAMELEON_HOST = "xameleon.phantemlis.top"

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
}

async def get_httpx_client(timeout: float = 10.0, use_proxy_if_available: bool = True):
    """Crea un AsyncHTTPClient intentando direct/IP y haciendo fallback a SOCKS5/Tor si hay geobloqueo/bloqueo de ISP"""
    try:
        if use_proxy_if_available:
            return httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", verify=False, timeout=timeout, follow_redirects=True)
    except Exception:
        pass
    return httpx.AsyncClient(verify=False, timeout=timeout, follow_redirects=True)

async def fetch_xameleon_channels() -> List[Dict[str, str]]:
    """
    Obtiene el catálogo completo de canales desde dlstreams.st omitiendo el bloqueo por Tor/Proxy.
    """
    url = f"https://{DLSTREAMS_HOST}/24-7-channels.php"
    headers = {
        **DEFAULT_HEADERS,
        "Referer": f"https://{DLSTREAMS_HOST}/"
    }
    
    resp = None
    try:
        async with httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", verify=False, timeout=10.0, follow_redirects=True) as client:
            res = await client.get(url, headers=headers)
            if res.status_code == 200:
                resp = res
    except Exception:
        pass
        
    if not resp:
        # Fallback a IP directa
        direct_url = f"https://{DLSTREAMS_IP}/24-7-channels.php"
        headers_direct = {**headers, "Host": DLSTREAMS_HOST}
        async with httpx.AsyncClient(verify=False, timeout=10.0) as client:
            resp = await client.get(direct_url, headers=headers_direct)
            
    if not resp or resp.status_code != 200:
        raise ValueError(f"Error accediendo al catálogo: HTTP {resp.status_code if resp else 'No response'}")
        
    matches = re.findall(r"<a[^>]+href=[\x22\x27]/watch\.php\?id=(\d+)[\x22\x27][^>]*>(.*?)</a>", resp.text, re.DOTALL)
    
    channels = []
    seen = set()
    for ch_id, title_raw in matches:
        if ch_id in seen:
            continue
        seen.add(ch_id)
        
        clean_title = re.sub(r"<[^>]+>", "", title_raw).strip()
        clean_title = re.sub(r"\s+", " ", clean_title)
        clean_title = re.sub(r"ID:\s*\d+", "", clean_title).strip()
        
        channels.append({
            "id": f"xameleon_{ch_id}",
            "raw_id": ch_id,
            "name": clean_title or f"Canal Xameleon {ch_id}",
            "stream_key": f"XAMELEON_{ch_id}",
            "category": "Xameleon TV",
            "server": DLSTREAMS_HOST,
            "embed_url": f"https://{DLSTREAMS_HOST}/watch.php?id={ch_id}"
        })
        
    return channels

async def resolve_xameleon_stream(channel_raw_id: str) -> str:
    """
    Desofusca el iframe del reproductor daddy4.php y extrae la URL M3U8 fresca.
    Intenta mediante Tor/SOCKS5 primero para bypass del bloqueo de Vodafone/ISP y geobloqueos.
    """
    url = f"https://{ROMPONALIS_HOST}/premiumtv/daddy4.php?id={channel_raw_id}"
    headers = {
        **DEFAULT_HEADERS,
        "Referer": f"https://{DLSTREAMS_HOST}/"
    }
    
    resp = None
    # 1. Probar vía Tor SOCKS5 primero (bypassea bloqueos ISP Vodafone/Movistar y 403)
    try:
        async with httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", verify=False, timeout=8.0) as client:
            res = await client.get(url, headers=headers)
            if res.status_code == 200 and "window.atob" in res.text:
                resp = res
    except Exception:
        pass

    # 2. Fallback a petición HTTPS directa si Tor no estaba listo o falló
    if not resp:
        direct_url = f"https://{DLSTREAMS_IP}/premiumtv/daddy4.php?id={channel_raw_id}"
        headers_direct = {**headers, "Host": ROMPONALIS_HOST}
        async with httpx.AsyncClient(verify=False, timeout=8.0) as client:
            resp = await client.get(direct_url, headers=headers_direct)

    if not resp or resp.status_code != 200:
        raise ValueError(f"Error en daddy4.php: HTTP {resp.status_code if resp else 'No response'}")
        
    match = re.search(r"window\.atob\([\x22\x27]([^\x22\x27]+)[\x22\x27]\)", resp.text)
    if not match:
        raise ValueError("No se encontró la cadena base64 del stream en el reproductor")
        
    decoded_url = base64.b64decode(match.group(1)).decode("utf-8")
    return decoded_url

async def fetch_xameleon_m3u8_manifest(m3u8_url: str, base_proxy_url: Optional[str] = None) -> str:
    """
    Descarga el contenido del manifiesto M3U8 aplicando bypass por Tor/Proxy o IP directa,
    y reescribe las URLs relativas/submanifiestos para ser proxyeados a través de la API.
    """
    base_dir = m3u8_url.rsplit("/", 1)[0] + "/"
    headers = {
        **DEFAULT_HEADERS,
        "Referer": f"https://{ROMPONALIS_HOST}/"
    }
    
    resp = None
    # 1. Intentar por SOCKS5 Tor primero para omitir bloqueos ISP
    try:
        async with httpx.AsyncClient(proxy="socks5://127.0.0.1:9050", verify=False, timeout=10.0, follow_redirects=True) as client:
            res = await client.get(m3u8_url, headers=headers)
            if res.status_code == 200:
                resp = res
    except Exception:
        pass
        
    # 2. Fallback a IP directa si no se usó SOCKS5
    if not resp:
        target_url = m3u8_url.replace(f"https://{XAMELEON_HOST}", f"https://{XAMELEON_IP}")
        headers_direct = {**headers, "Host": XAMELEON_HOST}
        async with httpx.AsyncClient(verify=False, timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(target_url, headers=headers_direct)
            
    if not resp or resp.status_code != 200:
        raise ValueError(f"Error descargando M3U8: HTTP {resp.status_code if resp else 'No response'}")
        
    lines = []
    for line in resp.text.splitlines():
        line_str = line.strip()
        if line_str and not line_str.startswith("#"):
            if not line_str.startswith("http://") and not line_str.startswith("https://"):
                full_url = base_dir + line_str
            else:
                full_url = line_str
                
            if base_proxy_url and ".m3u8" in full_url:
                lines.append(f"{base_proxy_url}?url={full_url}")
            else:
                lines.append(full_url)
        else:
            lines.append(line_str)
            
    return "\n".join(lines)



