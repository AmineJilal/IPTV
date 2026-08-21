"""
Extractor Mediaset España — Optimizado v3
Flujo: Login anónimo → Playback check → DoubleClick SSAI → master.m3u8
El token hdnea se incluye en la URL devuelta para que el proxy de Node.js
lo reescriba en todas las URLs relativas del manifiesto.
"""
import httpx
import asyncio
import uuid
import urllib.parse
import time
import re

from extractors.base import BaseExtractor

CHANNEL_CODES = {
    # Telecinco
    "telecinco.tv": "TLCN",
    "telecinco": "TLCN",
    # Cuatro
    "cuatro.tv": "CT",
    "cuatro": "CT",
    # FDF
    "fdf.tv": "FDF",
    "fdf": "FDF",
    # Energy
    "energy.tv": "EN",
    "energy": "EN",
    # Divinity
    "divinity.tv": "DV",
    "divinity": "DV",
    # Be Mad
    "bemad.tv": "BM",
    "bemad": "BM",
    # Boing
    "boing.tv": "BO",
    "boing": "BO",
}

APP_NAME = "web//mediasetplay-web/1.2.1-d1b2024"
LOGIN_URL = "https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login"
CHECK_URL = "https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check"
SSAI_URL = "https://pubads.g.doubleclick.net/ssai/event/{key}/streams"

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Origin": "https://www.mediasetinfinity.es",
    "Referer": "https://www.mediasetinfinity.es/",
    "Accept": "*/*",
}


class MediasetExtractor(BaseExtractor):
    # Caché de sesión compartida (sid + beToken con TTL)
    _sid: str | None = None
    _be_token: str | None = None
    _token_ts: float = 0.0
    _TOKEN_TTL: float = 25 * 60  # 25 minutos

    async def _get_auth(self, client: httpx.AsyncClient) -> tuple[str, str]:
        now = time.monotonic()
        if self._sid and self._be_token and (now - self._token_ts) < self._TOKEN_TTL:
            return self._sid, self._be_token

        resp = await client.post(
            LOGIN_URL,
            json={"appName": APP_NAME, "client_id": str(uuid.uuid4())},
            headers={**BASE_HEADERS, "Content-Type": "application/json; charset=utf-8"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json().get("response", {})
        MediasetExtractor._sid = data["sid"]
        MediasetExtractor._be_token = data["beToken"]
        MediasetExtractor._token_ts = now
        return MediasetExtractor._sid, MediasetExtractor._be_token

    async def extract_stream(self, channel_id: str, raw_url: str = "") -> dict:
        channel_id_lower = channel_id.lower()
        channel_code = CHANNEL_CODES.get(channel_id_lower)
        if not channel_code:
            raise ValueError(f"Canal Mediaset desconocido: {channel_id}")

        async with httpx.AsyncClient(
            headers=BASE_HEADERS,
            follow_redirects=True,
            timeout=12,
        ) as client:
            # 1. Obtener tokens de sesión (cacheados)
            sid, be_token = await self._get_auth(client)

            # 2. Playback check
            check_resp = await client.post(
                f"{CHECK_URL}?sid={sid}",
                json={
                    "channelCode": channel_code,
                    "streamType": "LIVE",
                    "delivery": "Streaming",
                    "createDevice": True,
                    "overrideAppName": APP_NAME,
                },
                headers={**BASE_HEADERS, "Authorization": f"Bearer {be_token}",
                         "Content-Type": "application/json; charset=utf-8"},
                timeout=10,
            )
            check_resp.raise_for_status()
            check_data = check_resp.json()

            if not check_data.get("isOk"):
                # Token expirado — limpiar caché y reintentar una vez
                MediasetExtractor._sid = None
                MediasetExtractor._be_token = None
                return await self.extract_stream(channel_id, raw_url)

            dai_key = check_data.get("response", {}).get("dai", {}).get("assetKey")
            if not dai_key:
                raise ValueError("No se obtuvo DAI assetKey de Mediaset")

            # 3. Obtener manifest DAI → extraer URL limpia
            ssai_resp = await client.post(
                SSAI_URL.format(key=dai_key),
                headers={**BASE_HEADERS, "Content-Type": "application/json"},
                timeout=10,
            )
            ssai_resp.raise_for_status()
            raw_manifest = ssai_resp.json().get("stream_manifest", "")
            if not raw_manifest:
                raise ValueError("SSAI no devolvió stream_manifest")

            # 4. Construir URL master.m3u8 limpia con hdnea token
            parsed = urllib.parse.urlparse(raw_manifest)
            params = urllib.parse.parse_qs(parsed.query)
            hdnea = params.get("hdnea", [""])[0]

            # Ruta base del isml (quitar el ultimo segmento /dai.m3u8 o /main.isml/...)
            base_path = parsed.path.rsplit("/", 1)[0]
            master_url = (
                f"{parsed.scheme}://{parsed.netloc}{base_path}/master.m3u8"
                + (f"?hdnea={hdnea}" if hdnea else "")
            )

            # 5. Verificar que el master.m3u8 responde y obtener la URL de variante 720p
            #    para que el reproductor no tenga que resolver URLs relativas con token.
            try:
                m_resp = await client.get(
                    master_url,
                    headers={k: v for k, v in BASE_HEADERS.items() if k != "Content-Type"},
                    timeout=8,
                )
                m_resp.raise_for_status()
                variant_url = self._pick_best_variant(m_resp.text, master_url, hdnea)
            except Exception:
                # Si falla el master, devolver de todas formas la URL (el proxy lo manejará)
                variant_url = master_url

            return {
                "channel_id": channel_id,
                "provider": "mediaset",
                "m3u8_url": variant_url,
                "headers_required": {
                    "User-Agent": BASE_HEADERS["User-Agent"],
                    "Referer": BASE_HEADERS["Referer"],
                    "Origin": BASE_HEADERS["Origin"],
                },
            }

    def _pick_best_variant(self, master_content: str, master_url: str, hdnea: str) -> str:
        """
        Elige la variante de mayor bitrate del master y devuelve su URL absoluta
        con el token hdnea incluido. Esto evita que el reproductor tenga que
        resolver URLs relativas sin el token de autenticación.
        """
        base = master_url.split("?")[0].rsplit("/", 1)[0] + "/"

        best_bw = 0
        best_uri = None
        lines = master_content.splitlines()
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            if line.startswith("#EXT-X-STREAM-INF:"):
                m = re.search(r"BANDWIDTH=(\d+)", line)
                bw = int(m.group(1)) if m else 0
                if i + 1 < len(lines):
                    uri = lines[i + 1].strip()
                    if uri and not uri.startswith("#") and bw > best_bw:
                        best_bw = bw
                        best_uri = uri
            i += 1

        if not best_uri:
            return master_url  # fallback al master

        # Construir URL absoluta con token
        if best_uri.startswith("http"):
            abs_url = best_uri
        else:
            abs_url = base + best_uri

        if hdnea and "hdnea" not in abs_url:
            abs_url += ("&" if "?" in abs_url else "?") + f"hdnea={hdnea}"

        return abs_url
