import urllib.parse
from urllib.parse import urlparse
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
        
        print(f"🔍 [AtresmediaExtractor] channel_id recibido: '{channel_id}' | norm_id: '{norm_id}' | slug: '{slug}'")
        
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
            "Origin": "https://www.atresplayer.com",
            "Referer": f"https://www.atresplayer.com/directos/{slug}/",
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-site",
            "sec-ch-ua": '"Chromium";v="137", "Not:A-Brand";v="24"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "X-Forwarded-For": "83.32.0.1",
            "X-Real-IP": "83.32.0.1",
            "Client-IP": "83.32.0.1"
        }
        
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            # ──────────────────────────────────────────────────────────
            # FASE 1: Obtener la URL de la página de directo desde la API cliente
            # ──────────────────────────────────────────────────────────
            href_encoded = urllib.parse.quote(f"/directos/{slug}/", safe="")
            api_url1 = f"https://api.atresplayer.com/client/v1/url?href={href_encoded}&usp=true&device=desktop&NODRM=true"
            
            print(f"📡 [FASE 1] GET {api_url1}")
            try:
                res1 = await client.get(api_url1, headers=headers)
            except Exception as e:
                print(f"🔥 [FASE 1] Excepción de red: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "client_url",
                    "status": 500,
                    "url_host": urlparse(api_url1).hostname or "",
                    "message": f"Excepción de red en Atresmedia Fase 1: {str(e)}"
                }
                
            print(f"📥 [FASE 1] Status: {res1.status_code} | Content-Type: {res1.headers.get('content-type')} | Content-Length: {res1.headers.get('content-length')} | Location: {res1.headers.get('location')}")
            print(f"🍪 [FASE 1] Cookies acumuladas: {list(client.cookies.keys())}")
            
            if res1.status_code != 200:
                print(f"❌ [FASE 1] Atresmedia devolvió HTTP {res1.status_code}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "client_url",
                    "status": res1.status_code,
                    "url_host": urlparse(api_url1).hostname or "",
                    "message": f"Atresmedia rechazó la petición de cliente (HTTP {res1.status_code})"
                }
                
            try:
                data1 = res1.json()
            except Exception as e:
                print(f"🔥 [FASE 1] Error parseando JSON: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "client_url",
                    "status": 500,
                    "url_host": urlparse(api_url1).hostname or "",
                    "message": "Respuesta no es JSON válido en Fase 1"
                }
                
            keys1 = list(data1.keys()) if isinstance(data1, dict) else type(data1)
            print(f"🔑 [FASE 1] Primeras claves JSON: {keys1}")
            
            page_url = data1.get("href") if isinstance(data1, dict) else None
            print(f"🔗 [FASE 1] page_url obtenido: {page_url}")
            if not page_url:
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "client_url",
                    "status": 404,
                    "url_host": urlparse(api_url1).hostname or "",
                    "message": "Falta el campo 'href' en la respuesta de Fase 1"
                }

            # ──────────────────────────────────────────────────────────
            # FASE 2: Obtener la información de la página para extraer video_url
            # ──────────────────────────────────────────────────────────
            print(f"📡 [FASE 2] GET {page_url}")
            try:
                res2 = await client.get(page_url, headers=headers)
            except Exception as e:
                print(f"🔥 [FASE 2] Excepción de red: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "page_info",
                    "status": 500,
                    "url_host": urlparse(page_url).hostname if page_url else "",
                    "message": f"Excepción de red en Atresmedia Fase 2: {str(e)}"
                }
                
            print(f"📥 [FASE 2] Status: {res2.status_code} | Content-Type: {res2.headers.get('content-type')} | Content-Length: {res2.headers.get('content-length')} | Location: {res2.headers.get('location')}")
            print(f"🍪 [FASE 2] Cookies acumuladas: {list(client.cookies.keys())}")
            
            if res2.status_code != 200:
                print(f"❌ [FASE 2] Atresmedia devolvió HTTP {res2.status_code}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "page_info",
                    "status": res2.status_code,
                    "url_host": urlparse(page_url).hostname if page_url else "",
                    "message": f"Atresmedia rechazó la petición de información de página (HTTP {res2.status_code})"
                }
                
            try:
                data2 = res2.json()
            except Exception as e:
                print(f"🔥 [FASE 2] Error parseando JSON: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "page_info",
                    "status": 500,
                    "url_host": urlparse(page_url).hostname if page_url else "",
                    "message": "Respuesta no es JSON válido en Fase 2"
                }
                
            keys2 = list(data2.keys()) if isinstance(data2, dict) else type(data2)
            print(f"🔑 [FASE 2] Primeras claves JSON: {keys2}")
            
            video_url = data2.get("urlVideo") if isinstance(data2, dict) else None
            print(f"🔗 [FASE 2] video_url obtenido: {video_url}")
            if not video_url:
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "page_info",
                    "status": 404,
                    "url_host": urlparse(page_url).hostname if page_url else "",
                    "message": "Falta el campo 'urlVideo' en la respuesta de Fase 2"
                }

            if "?" not in video_url:
                video_url += "?device=desktop&NODRM=true"
            elif "device=" not in video_url:
                video_url += "&device=desktop&NODRM=true"

            # ──────────────────────────────────────────────────────────
            # FASE 3: Inspeccionar video_url y obtener las fuentes del reproductor
            # ──────────────────────────────────────────────────────────
            parsed_vurl = urlparse(video_url)
            print(f"📌 [FASE 3] Inspección previa:")
            print(f"   type(video_url): {type(video_url)}")
            print(f"   video_url: {video_url}")
            print(f"   hostname: {parsed_vurl.hostname}")
            print(f"   path: {parsed_vurl.path}")
            
            print(f"📡 [FASE 3] GET {video_url}")
            try:
                res3 = await client.get(video_url, headers=headers)
            except Exception as e:
                print(f"🔥 [FASE 3] Excepción de red: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "sources",
                    "status": 500,
                    "url_host": parsed_vurl.hostname or "",
                    "message": f"Excepción de red en fuentes Atresmedia Fase 3: {str(e)}"
                }
                
            print(f"📥 [FASE 3] Status: {res3.status_code} | Content-Type: {res3.headers.get('content-type')} | Content-Length: {res3.headers.get('content-length')} | Location: {res3.headers.get('location')}")
            print(f"🍪 [FASE 3] Cookies acumuladas: {list(client.cookies.keys())}")
            
            if res3.status_code != 200:
                print(f"❌ [FASE 3] Atresmedia devolvió HTTP {res3.status_code}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "sources",
                    "status": res3.status_code,
                    "url_host": parsed_vurl.hostname or "",
                    "message": f"Atresmedia rechazó la petición de fuentes (HTTP {res3.status_code})"
                }

            try:
                data3 = res3.json()
            except Exception as e:
                print(f"🔥 [FASE 3] Error parseando JSON: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "sources",
                    "status": 500,
                    "url_host": parsed_vurl.hostname or "",
                    "message": "Respuesta no es JSON válido en Fase 3"
                }
                
            keys3 = list(data3.keys()) if isinstance(data3, dict) else type(data3)
            print(f"🔑 [FASE 3] Primeras claves JSON: {keys3}")
            
            sources_live = data3.get("sourcesLive") if isinstance(data3, dict) else None
            print(f"🎬 [FASE 3] sourcesLive encontrados: {len(sources_live) if sources_live is not None else 'None'}")
            
            sources = (sources_live if sources_live is not None else None) or (data3.get("sources") if isinstance(data3, dict) else None) or (data3.get("sourcesStartOver") if isinstance(data3, dict) else None) or []
            print(f"🎬 [FASE 3] Total fuentes a evaluar: {len(sources)}")
            
            for idx, s in enumerate(sources):
                if isinstance(s, dict):
                    print(f"   - Source [{idx}]: src='{s.get('src')}', type='{s.get('type')}'")
                    
            m3u8_url = None
            
            # Prioridad 1: HLS de atres-live.atresmedia.com
            for source in sources:
                if not isinstance(source, dict):
                    continue
                src = source.get("src", "")
                stype = str(source.get("type") or "").lower()
                if not src or "dash" in stype or ".mpd" in src.lower() or "/directos/" in src:
                    continue
                
                if "application/vnd.apple.mpegurl" in stype or "mpegurl" in stype or ".m3u8" in src.lower() or "hls" in stype:
                    if "atres-live.atresmedia.com" in src:
                        m3u8_url = src
                        break
                    elif not m3u8_url:
                        m3u8_url = src
                        
            # Prioridad 2: Cualquier otra fuente HLS válida sin DASH
            if not m3u8_url and sources:
                for source in sources:
                    if not isinstance(source, dict):
                        continue
                    src = source.get("src", "")
                    stype2 = str(source.get("type") or "").lower()
                    if src and not "dash" in stype2 and not ".mpd" in src.lower() and not "/directos/" in src:
                        m3u8_url = src
                        break
                
            print(f"🎯 [FASE 3] m3u8_url seleccionado: '{m3u8_url}'")
            
            if not m3u8_url or not m3u8_url.startswith("http") or ".m3u8" not in m3u8_url.lower() or "/directos/" in m3u8_url:
                print(f"❌ [FASE 3] No se encontró ninguna URL m3u8 válida en Atresmedia.")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "sources",
                    "status": 404,
                    "url_host": parsed_vurl.hostname or "",
                    "message": "No se encontraron fuentes HLS (.m3u8) válidas en Atresmedia"
                }

            # ──────────────────────────────────────────────────────────
            # FASE 4: Validación del manifiesto m3u8 antes de devolverlo
            # ──────────────────────────────────────────────────────────
            print(f"📡 [FASE 4] Verificando manifiesto: GET {m3u8_url}")
            try:
                res_m3u8 = await client.get(m3u8_url, headers=headers)
                print(f"📥 [FASE 4] Status manifiesto: {res_m3u8.status_code} | Content-Type: {res_m3u8.headers.get('content-type')}")
                if res_m3u8.status_code != 200:
                    print(f"❌ [FASE 4] El manifiesto devolvió HTTP {res_m3u8.status_code}")
                    return {
                        "error": True,
                        "provider": "atresmedia",
                        "stage": "manifest_fetch",
                        "status": res_m3u8.status_code,
                        "url_host": urlparse(m3u8_url).hostname or "",
                        "message": f"El manifiesto m3u8 devolvió HTTP {res_m3u8.status_code}"
                    }
                first_line = res_m3u8.text[:50].strip() if res_m3u8.text else ""
                print(f"📄 [FASE 4] Primeras líneas del manifiesto: {first_line[:30]}")
                if not first_line.startswith("#EXTM3U"):
                    print(f"❌ [FASE 4] El manifiesto no empieza por #EXTM3U")
                    return {
                        "error": True,
                        "provider": "atresmedia",
                        "stage": "manifest_valid",
                        "status": 422,
                        "url_host": urlparse(m3u8_url).hostname or "",
                        "message": "El contenido del manifiesto no empieza por #EXTM3U"
                    }
            except Exception as e:
                print(f"🔥 [FASE 4] Excepción verificando manifiesto: {e}")
                return {
                    "error": True,
                    "provider": "atresmedia",
                    "stage": "manifest_fetch",
                    "status": 500,
                    "url_host": urlparse(m3u8_url).hostname or "",
                    "message": f"Excepción de red verificando manifiesto: {str(e)}"
                }

            print(f"✅ [ÉXITO COMPLETO] Manifiesto validado OK: {m3u8_url}")
            return {
                "channel_id": norm_id,
                "provider": "atresmedia",
                "m3u8_url": m3u8_url,
                "headers_required": headers
            }
