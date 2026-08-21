import re
import json
import base64
import time
import httpx
from bs4 import BeautifulSoup
from typing import List, Dict, Any, Optional
from app.config import settings

class ExtractorService:
    def __init__(self):
        self._config_cache: Optional[Dict[str, str]] = None
        self._config_cache_time: float = 0
        
        self._channels_cache: Optional[List[Dict[str, Any]]] = None
        self._channels_cache_time: float = 0
        
        self._agenda_cache: Optional[List[Dict[str, Any]]] = None
        self._agenda_cache_time: float = 0

        self._resolved_cache: Dict[str, Dict[str, Any]] = {}

    async def get_headers(self, referer: Optional[str] = None) -> Dict[str, str]:
        return {
            "User-Agent": settings.USER_AGENT,
            "Referer": referer or settings.BASE_URL,
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        }

    async def fetch_site_config(self) -> Dict[str, str]:
        now = time.time()
        if self._config_cache and (now - self._config_cache_time < settings.CACHE_TTL_SECONDS):
            return self._config_cache

        domain = settings.DEFAULT_IFRAME_DOMAIN
        base_path = settings.DEFAULT_BASE_PATH

        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                # 1. Try extracting real active domain from eventos.js
                try:
                    resp_ev = await client.get(f"{settings.BASE_URL}{settings.EVENTOS_PATH}", headers=await self.get_headers())
                    if resp_ev.status_code == 200:
                        ev_match = re.search(r'https://(streamtp[a-zA-Z0-9\-_.]+\.[a-z0-9]+)/', resp_ev.text)
                        if ev_match:
                            domain = ev_match.group(1)
                except Exception:
                    pass

                # 2. Try config.js as fallback if valid
                try:
                    resp = await client.get(
                        f"{settings.BASE_URL}{settings.CONFIG_PATH}",
                        headers=await self.get_headers()
                    )
                    if resp.status_code == 200:
                        text = resp.text
                        domain_match = re.search(r'activeDomain\s*:\s*["\']([^"\']+)["\']', text)
                        path_match = re.search(r'basePath\s*:\s*["\']([^"\']+)["\']', text)
                        if domain_match:
                            d = domain_match.group(1)
                            if "streamtp99a" not in d:
                                domain = d
                        if path_match:
                            base_path = path_match.group(1)
                except Exception:
                    pass
        except Exception as e:
            print(f"[Warning] Failed to fetch config.js, using default: {e}")

        res = {"activeDomain": domain, "basePath": base_path}
        self._config_cache = res
        self._config_cache_time = now
        return res

    async def get_channels(self) -> List[Dict[str, Any]]:
        now = time.time()
        if self._channels_cache and (now - self._channels_cache_time < settings.CACHE_TTL_SECONDS):
            return self._channels_cache

        site_cfg = await self.fetch_site_config()
        active_domain = site_cfg["activeDomain"]
        base_path = site_cfg["basePath"]

        channels = []
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                resp = await client.get(settings.BASE_URL, headers=await self.get_headers())
                if resp.status_code == 200:
                    soup = BeautifulSoup(resp.text, 'html.parser')
                    card_articles = soup.find_all('article', class_='card')
                    
                    for card in card_articles:
                        a_tag = card.find('a', href=re.compile(r'canal\.html\?canal='))
                        if not a_tag:
                            continue
                        
                        href = a_tag.get('href', '')
                        canal_id = href.split('canal=')[-1].strip()
                        
                        img_tag = a_tag.find('img')
                        img_src = img_tag.get('src', '') if img_tag else ''
                        logo_url = f"{settings.BASE_URL}/{img_src.lstrip('/')}" if img_src and not img_src.startswith('http') else img_src
                        
                        name = img_tag.get('alt', '').replace('Logo', '').replace('Información de', '').strip() if img_tag else canal_id
                        if not name or len(name) < 2:
                            name = canal_id.replace('_', ' ').upper()

                        iframe_url = f"https://{active_domain}{base_path}{canal_id}"

                        channels.append({
                            "id": canal_id,
                            "name": name,
                            "logo": logo_url,
                            "page_url": f"{settings.BASE_URL}/{href}",
                            "iframe_url": iframe_url,
                            "stream_proxy": f"/api/live/{canal_id}/playlist.m3u8"
                        })
        except Exception as e:
            print(f"[Error] Failed to fetch channels list: {e}")

        # Fallback static channel list if scraping failed or returned few channels
        if len(channels) < 5:
            fallback_ids = [
                ("dsports", "D Sports"), ("dsports2", "D Sports 2"), ("dsportsplus", "D Sports +"),
                ("espn", "ESPN 1"), ("espn2", "ESPN 2"), ("espn3", "ESPN 3"), ("espnpremium", "ESPN Premium"),
                ("fox1ar", "Fox Sports 1"), ("foxar2", "Fox Sports 2"), ("foxar3", "Fox Sports 3"),
                ("liga1max", "Liga 1 MAX"), ("tntsports", "TNT Sports"), ("tyc", "TyC Sports"),
                ("winsports", "Win Sports"), ("winplus", "Win Sports +"), ("tudnmx", "TUDN MX"),
                ("espndeportes", "ESPN Deportes"), ("fox_deportes_usa", "Fox Deportes USA")
            ]
            channels = []
            for cid, cname in fallback_ids:
                channels.append({
                    "id": cid,
                    "name": cname,
                    "logo": f"{settings.BASE_URL}/img/{cid}.webp",
                    "page_url": f"{settings.BASE_URL}/canal.html?canal={cid}",
                    "iframe_url": f"https://{active_domain}{base_path}{cid}",
                    "stream_proxy": f"/api/live/{cid}/playlist.m3u8"
                })

        self._channels_cache = channels
        self._channels_cache_time = now
        return channels

    async def get_agenda(self) -> List[Dict[str, Any]]:
        now = time.time()
        if self._agenda_cache and (now - self._agenda_cache_time < settings.CACHE_TTL_SECONDS):
            return self._agenda_cache

        agenda = []
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                resp = await client.get(f"{settings.BASE_URL}{settings.EVENTOS_PATH}", headers=await self.get_headers())
                if resp.status_code == 200:
                    text = resp.text
                    match = re.search(r'const\s+EVENTOS_DATA\s*=\s*(\[.*?\]);', text, re.DOTALL)
                    if match:
                        raw_events = json.loads(match.group(1))
                        for ev in raw_events:
                            parsed_channels = []
                            for ch in ev.get('canales', []):
                                raw_url = ch.get('url', '')
                                decoded_iframe = ''
                                stream_proxy = None
                                
                                if '?r=' in raw_url:
                                    b64_part = raw_url.split('?r=')[-1]
                                    try:
                                        # Fix base64 padding
                                        missing_padding = len(b64_part) % 4
                                        if missing_padding:
                                            b64_part += '=' * (4 - missing_padding)
                                        decoded_iframe = base64.b64decode(b64_part).decode('utf-8')
                                    except Exception:
                                        decoded_iframe = raw_url
                                else:
                                    decoded_iframe = raw_url
                                
                                if decoded_iframe:
                                    # Extract stream param if available
                                    m_stream = re.search(r'stream=([a-zA-Z0-9_\-]+)', decoded_iframe)
                                    if m_stream:
                                        stream_proxy = f"/api/live/{m_stream.group(1)}/playlist.m3u8"
                                    else:
                                        from urllib.parse import quote
                                        stream_proxy = f"/api/resolve?iframe={quote(decoded_iframe)}"

                                parsed_channels.append({
                                    "name": ch.get('nombre', 'Canal'),
                                    "quality": ch.get('calidad', 'HD'),
                                    "raw_url": raw_url,
                                    "iframe_url": decoded_iframe,
                                    "stream_proxy": stream_proxy
                                })
                            
                            agenda.append({
                                "id": ev.get('id'),
                                "category": ev.get('clase', 'LIVE'),
                                "title": ev.get('titulo', 'Evento deportivo'),
                                "time": ev.get('hora', ''),
                                "time_end": ev.get('hora_fin', ''),
                                "channels": parsed_channels
                            })
        except Exception as e:
            print(f"[Error] Failed to fetch agenda eventos.js: {e}")

        self._agenda_cache = agenda
        self._agenda_cache_time = now
        return agenda

    async def resolve_stream(self, target: str, force_refresh: bool = False) -> Dict[str, Any]:
        """
        Accepts either channel_id (e.g. 'dsports') or full iframe_url
        """
        now = time.time()
        cache_key = target.strip().lower()
        if not force_refresh and cache_key in self._resolved_cache:
            cache_entry = self._resolved_cache[cache_key]
            if now - cache_entry["time"] < 1800:  # 30 minutes cache
                return cache_entry["data"]

        iframe_url = ""
        channel_id = ""

        ALIAS_MAP = {
            "foxsports": "fox1ar",
            "foxsports1": "fox1ar",
            "foxsports2": "foxar2",
            "foxsports3": "foxar3",
            "lig1max": "liga1max",
        }

        if target.startswith("http://") or target.startswith("https://"):
            iframe_url = target
            m = re.search(r'stream=([a-zA-Z0-9_\-]+)', target)
            channel_id = m.group(1) if m else "live"
        else:
            channel_id = ALIAS_MAP.get(target.lower(), target)
            site_cfg = await self.fetch_site_config()
            iframe_url = f"https://{site_cfg['activeDomain']}{site_cfg['basePath']}{channel_id}"

        headers = await self.get_headers(referer=settings.BASE_URL)
        
        try:
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                resp = await client.get(iframe_url, headers=headers)
                if resp.status_code == 200:
                    html = resp.text
                    match = re.search(r'var\s+playbackURL\s*=\s*["\']([^"\']+)["\']', html)
                    if match:
                        raw_m3u8 = match.group(1).replace('\\/', '/')
                        result = {
                            "status": "online",
                            "channel_id": channel_id,
                            "iframe_url": iframe_url,
                            "m3u8_url": raw_m3u8,
                            "referer_required": iframe_url.rsplit('/', 1)[0] + '/'
                        }
                        self._resolved_cache[cache_key] = {"time": now, "data": result}
                        return result
                    else:
                        return {
                            "status": "offline",
                            "channel_id": channel_id,
                            "iframe_url": iframe_url,
                            "error": "No playbackURL variable found in iframe page"
                        }
                else:
                    return {
                        "status": "error",
                        "channel_id": channel_id,
                        "iframe_url": iframe_url,
                        "error": f"HTTP {resp.status_code} fetching iframe"
                    }
        except Exception as e:
            return {
                "status": "error",
                "channel_id": channel_id,
                "iframe_url": iframe_url,
                "error": str(e)
            }

extractor = ExtractorService()
