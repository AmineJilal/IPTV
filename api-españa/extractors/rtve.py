from typing import Dict, Any
from extractors.base import BaseExtractor

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"

class RtveExtractor(BaseExtractor):
    """Extractor para canales de RTVE (La 1, La 2, 24h, Teledeporte, Clan)."""
    
    MAP = {
        'la1': 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8',
        'la1.tv': 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8',
        '1': 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8',
        'la2': 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main.m3u8',
        'la2.tv': 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main.m3u8',
        '2': 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main.m3u8',
        '24h': 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main.m3u8',
        '24h.tv': 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main.m3u8',
        '24horas.tv': 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main.m3u8',
        'tdp': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
        'tdp.tv': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
        'teledeporte': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
        'teledeporte.tv': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
        'clan': 'https://rtvelivestream.rtve.es/rtvesec/clan/clan_main.m3u8',
        'clan.tv': 'https://rtvelivestream.rtve.es/rtvesec/clan/clan_main.m3u8'
    }

    async def extract_stream(self, channel_id: str, raw_url: str = "") -> Dict[str, Any]:
        cid = channel_id.lower()
        m3u8_url = self.MAP.get(cid)
        if not m3u8_url:
            m3u8_url = f"https://ztnr.rtve.es/ztnr/{cid}.m3u8"

        headers = {
            "Origin": "https://www.rtve.es",
            "Referer": "https://www.rtve.es/",
            "User-Agent": USER_AGENT,
            "Accept": "*/*"
        }

        return {
            "channel_id": channel_id,
            "provider": "rtve",
            "m3u8_url": m3u8_url,
            "headers_required": headers
        }
