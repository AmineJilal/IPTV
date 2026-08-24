import urllib.parse
import httpx
from typing import Dict, Any

from extractors.base import BaseExtractor
from extractors.utils import normalize_channel_id

class AtresmediaExtractor(BaseExtractor):
    """Extractor for Atresmedia channels (Antena 3, laSexta, Neox, Nova, Mega, Atreseries)."""
    
    SLUGS = {
        'antena3': 'antena3',
        'lasexta': 'lasexta',
        'neox': 'neox',
        'nova': 'nova',
        'mega': 'mega',
        'atreseries': 'atreseries'
    }
    
    async def extract_stream(self, channel_id: str, raw_url: str = "") -> Dict[str, Any]:
        norm_id = normalize_channel_id(channel_id)
        slug = self.SLUGS.get(norm_id, norm_id)
        
        print(f"🔍 [AtresmediaExtractor] channel_id recibido: '{channel_id}' | norm_id: '{norm_id}' | slug calculado: '{slug}'")
        
        headers = {
            "Origin": "https://www.atresplayer.com",
            "Referer": "https://www.atresplayer.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
        }
        
        # 1. Fetch initial API page URL
        href_encoded = urllib.parse.quote(f"/directos/{slug}/", safe="")
        api_url1 = f"https://api.atresplayer.com/client/v1/url?href={href_encoded}&usp=true&device=desktop&NODRM=true"
        print(f"📡 [AtresmediaExtractor] Petición 1: GET {api_url1}")
        
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            res1 = await client.get(api_url1, headers=headers)
            print(f"📥 [AtresmediaExtractor] Status 1: {res1.status_code}")
            if res1.status_code != 200:
                raise Exception(f"Failed to fetch initial Atresmedia URL: HTTP {res1.status_code}")
                
            data1 = res1.json()
            keys1 = list(data1.keys()) if isinstance(data1, dict) else type(data1)
            print(f"🔑 [AtresmediaExtractor] Keys JSON 1: {keys1}")
            page_url = data1.get("href") if isinstance(data1, dict) else None
            print(f"🔗 [AtresmediaExtractor] page_url obtenido: {page_url}")
            if not page_url:
                raise Exception(f"Missing 'href' in initial Atresmedia response: {data1}")
                
            # 2. Fetch the page info to get the video URL
            print(f"📡 [AtresmediaExtractor] Petición 2: GET {page_url}")
            res2 = await client.get(page_url, headers=headers)
            print(f"📥 [AtresmediaExtractor] Status 2: {res2.status_code}")
            if res2.status_code != 200:
                raise Exception(f"Failed to fetch Atresmedia page info: HTTP {res2.status_code}")
                
            data2 = res2.json()
            keys2 = list(data2.keys()) if isinstance(data2, dict) else type(data2)
            print(f"🔑 [AtresmediaExtractor] Keys JSON 2: {keys2}")
            video_url = data2.get("urlVideo") if isinstance(data2, dict) else None
            print(f"🔗 [AtresmediaExtractor] video_url obtenido: {video_url}")
            if not video_url:
                raise Exception(f"Missing 'urlVideo' in Atresmedia page response: {data2}")
                
            # 3. Fetch the final sources
            print(f"📡 [AtresmediaExtractor] Petición 3: GET {video_url}")
            res3 = await client.get(video_url, headers=headers)
            print(f"📥 [AtresmediaExtractor] Status 3: {res3.status_code}")
            if res3.status_code != 200:
                raise Exception(f"Failed to fetch Atresmedia video sources: HTTP {res3.status_code}")
                
            data3 = res3.json()
            keys3 = list(data3.keys()) if isinstance(data3, dict) else type(data3)
            print(f"🔑 [AtresmediaExtractor] Keys JSON 3: {keys3}")
            
            sources_live = data3.get("sourcesLive") if isinstance(data3, dict) else None
            print(f"🎬 [AtresmediaExtractor] sourcesLive encontrados: {len(sources_live) if sources_live is not None else 'None'}")
            
            sources = (sources_live if sources_live is not None else None) or (data3.get("sources") if isinstance(data3, dict) else None) or (data3.get("sourcesStartOver") if isinstance(data3, dict) else None) or []
            print(f"🎬 [AtresmediaExtractor] Total sources a inspeccionar: {len(sources)}")
            for idx, s in enumerate(sources):
                if isinstance(s, dict):
                    print(f"   - Source [{idx}]: src='{s.get('src')}', type='{s.get('type')}'")
                    
            m3u8_url = None
            
            # Buscamos primero en atres-live y application/vnd.apple.mpegurl
            for source in sources:
                if not isinstance(source, dict):
                    continue
                src = source.get("src", "")
                stype = str(source.get("type") or "").lower()
                if not src or "dash" in stype or ".mpd" in src.lower():
                    continue
                
                if "application/vnd.apple.mpegurl" in stype or "mpegurl" in stype or ".m3u8" in src.lower() or "hls" in stype:
                    if "atres-live.atresmedia.com" in src:
                        m3u8_url = src
                        break
                    elif not m3u8_url:
                        m3u8_url = src
                        
            if not m3u8_url and sources:
                for source in sources:
                    if not isinstance(source, dict):
                        continue
                    src = source.get("src", "")
                    stype2 = str(source.get("type") or "").lower()
                    if src and not "dash" in stype2 and not ".mpd" in src.lower():
                        m3u8_url = src
                        break
                
            print(f"🎯 [AtresmediaExtractor] m3u8_url final seleccionado: '{m3u8_url}'")
            if not m3u8_url:
                raise Exception(f"No valid HLS sources found in Atresmedia response: {data3}")
                
            return {
                "channel_id": norm_id,
                "provider": "atresmedia",
                "m3u8_url": m3u8_url,
                "headers_required": headers
            }
