import urllib.parse
import httpx
from typing import Dict, Any

from extractors.base import BaseExtractor

class AtresmediaExtractor(BaseExtractor):
    """Extractor for Atresmedia channels (Antena 3, laSexta, Neox, Nova, Mega, Atreseries)."""
    
    # Official mapping to get the proper slug
    # If the slug doesn't match the URL exactly, we can map it here.
    SLUGS = {
        'antena3.tv': 'antena3',
        'lasexta.tv': 'lasexta',
        'neox.tv': 'neox',
        'nova.tv': 'nova',
        'mega.tv': 'mega',
        'atreseries.tv': 'atreseries'
    }
    
    async def extract_stream(self, channel_id: str, raw_url: str) -> Dict[str, Any]:
        slug = self.SLUGS.get(channel_id.lower(), channel_id.lower().replace('.tv', ''))
        
        headers = {
            "Origin": "https://www.atresplayer.com",
            "Referer": "https://www.atresplayer.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        
        # 1. Fetch initial API page URL
        href_encoded = urllib.parse.quote(f"/directos/{slug}/", safe="")
        api_url = f"https://api.atresplayer.com/client/v1/url?href={href_encoded}&usp=true&device=desktop&NODRM=true"
        
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            res1 = await client.get(api_url, headers=headers)
            if res1.status_code != 200:
                raise Exception(f"Failed to fetch initial Atresmedia URL: HTTP {res1.status_code}")
                
            data1 = res1.json()
            page_url = data1.get("href")
            if not page_url:
                raise Exception("Missing 'href' in initial Atresmedia response")
                
            # 2. Fetch the page info to get the video URL
            res2 = await client.get(page_url, headers=headers)
            if res2.status_code != 200:
                raise Exception(f"Failed to fetch Atresmedia page info: HTTP {res2.status_code}")
                
            data2 = res2.json()
            video_url = data2.get("urlVideo")
            if not video_url:
                raise Exception("Missing 'urlVideo' in Atresmedia page response")
                
            # 3. Fetch the final sources
            res3 = await client.get(video_url, headers=headers)
            if res3.status_code != 200:
                raise Exception(f"Failed to fetch Atresmedia video sources: HTTP {res3.status_code}")
                
            data3 = res3.json()
            # En Atresmedia los directos están en 'sourcesLive' o 'sources'
            sources = data3.get("sourcesLive", []) or data3.get("sources", []) or data3.get("sourcesStartOver", [])
            m3u8_url = None
            
            for source in sources:
                src = source.get("src", "")
                stype = source.get("type", "").lower()
                # Priorizar HLS m3u8 sobre MPD y SSAI
                if (".m3u8" in src or "mpegurl" in stype or "hls" in stype) and src:
                    m3u8_url = src
                    if "master.m3u8" in src or "playlist.m3u8" in src:
                        break
                    
            if not m3u8_url and sources:
                for source in sources:
                    if source.get("src"):
                        m3u8_url = source.get("src")
                        break
                
            if not m3u8_url:
                raise Exception("No valid HLS sources found in Atresmedia response")
                
            return {
                "channel_id": channel_id,
                "provider": "atresmedia",
                "m3u8_url": m3u8_url,
                "headers_required": headers
            }
