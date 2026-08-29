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

async def fetch_xameleon_channels() -> List[Dict[str, str]]:
    """
    Obtiene el catálogo completo de canales desde dlstreams.st omitiendo el bloqueo de SNI por IP directa.
    """
    url = f"https://{DLSTREAMS_IP}/24-7-channels.php"
    headers = {
        **DEFAULT_HEADERS,
        "Host": DLSTREAMS_HOST,
        "Referer": "https://daddylivehd.sx/"
    }
    
    async with httpx.AsyncClient(verify=False, timeout=10.0) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"Error accediendo al catálogo: HTTP {resp.status_code}")
            
        # Extraer enlaces /watch.php?id=XX
        matches = re.findall(r"<a[^>]+href=[\x22\x27]/watch\.php\?id=(\d+)[\x22\x27][^>]*>(.*?)</a>", resp.text, re.DOTALL)
        
        channels = []
        seen = set()
        for ch_id, title_raw in matches:
            if ch_id in seen:
                continue
            seen.add(ch_id)
            
            clean_title = re.sub(r"<[^>]+>", "", title_raw).strip()
            # Limpiar saltos de línea e IDs repetidos en texto
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
    """
    url = f"https://{DLSTREAMS_IP}/premiumtv/daddy4.php?id={channel_raw_id}"
    headers = {
        **DEFAULT_HEADERS,
        "Host": ROMPONALIS_HOST,
        "Referer": f"https://{DLSTREAMS_HOST}/"
    }
    
    async with httpx.AsyncClient(verify=False, timeout=10.0) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"Error en daddy4.php: HTTP {resp.status_code}")
            
        match = re.search(r"window\.atob\([\x22\x27]([^\x22\x27]+)[\x22\x27]\)", resp.text)
        if not match:
            raise ValueError("No se encontró la cadena base64 del stream en el reproductor")
            
        decoded_url = base64.b64decode(match.group(1)).decode("utf-8")
        return decoded_url

async def fetch_xameleon_m3u8_manifest(m3u8_url: str, base_proxy_url: Optional[str] = None) -> str:
    """
    Descarga el contenido del manifiesto M3U8 aplicando bypass de SNI e IP directa,
    y reescribe las URLs relativas/submanifiestos para ser proxyeados a través de la API.
    """
    base_dir = m3u8_url.rsplit("/", 1)[0] + "/"
    
    # Reemplazar el dominio por la IP directa si viene con el dominio xameleon.phantemlis.top
    target_url = m3u8_url.replace(f"https://{XAMELEON_HOST}", f"https://{XAMELEON_IP}")
    
    headers = {
        **DEFAULT_HEADERS,
        "Host": XAMELEON_HOST,
        "Referer": f"https://{ROMPONALIS_HOST}/"
    }
    
    async with httpx.AsyncClient(verify=False, timeout=10.0, follow_redirects=True) as client:
        resp = await client.get(target_url, headers=headers)
        if resp.status_code != 200:
            raise ValueError(f"Error descargando M3U8: HTTP {resp.status_code}")
            
        lines = []
        for line in resp.text.splitlines():
            line_str = line.strip()
            if line_str and not line_str.startswith("#"):
                if not line_str.startswith("http://") and not line_str.startswith("https://"):
                    full_url = base_dir + line_str
                else:
                    full_url = line_str
                # Forzar IP directa en lugar de dominio para evitar bloqueo de SNI en el reproductor
                full_url = full_url.replace(f"https://{XAMELEON_HOST}", f"https://{XAMELEON_IP}")
                
                if base_proxy_url and ".m3u8" in full_url:
                    lines.append(f"{base_proxy_url}?url={full_url}")
                else:
                    lines.append(full_url)
            else:
                lines.append(line_str)
                
        return "\n".join(lines)



