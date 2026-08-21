from fastapi import FastAPI, Query, HTTPException, Response, Request
from fastapi.responses import HTMLResponse, RedirectResponse, PlainTextResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, List
import time
import os
import requests

from scraper import (
    fetch_countries,
    fetch_country_channels,
    resolve_channel_details,
    get_all_channels,
    get_all_channels_parallel
)
from generate_canales_txt import generate_txt

app = FastAPI(
    title="Venolie TV IPTV Stream API",
    description="REST API para extracción de transmisiones HLS en vivo (.m3u8), metadatos de canales y listas M3U desde Venolie TV.",
    version="1.1.0"
)

# Enable CORS for cross-origin HLS video players and external integrations
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

START_TIME = time.time()
CANALES_TXT_PATH = os.path.join(os.path.dirname(__file__), "canales.txt")

@app.on_event("startup")
def startup_event():
    print("🚀 Iniciando servidor Venolie API en 0.0.0.0:9090...")
    if not os.path.exists(CANALES_TXT_PATH):
        generate_txt(port=9090, filename=CANALES_TXT_PATH)

@app.get("/api/health", tags=["System"])
def health_check():
    return {
        "status": "online",
        "service": "Venolie IPTV API",
        "host": "0.0.0.0",
        "port": 9090,
        "uptime_seconds": round(time.time() - START_TIME, 2),
        "version": "1.1.0"
    }

@app.get("/canales.txt", response_class=PlainTextResponse, tags=["Documentación & Listas"])
@app.get("/api/canales.txt", response_class=PlainTextResponse, tags=["Documentación & Listas"])
def get_canales_txt(refresh: bool = False):
    """
    Devuelve el archivo comprimido/estructurado canales.txt con todos los países, categorías y URLs de streaming.
    """
    if refresh or not os.path.exists(CANALES_TXT_PATH):
        generate_txt(port=9090, filename=CANALES_TXT_PATH)
    
    with open(CANALES_TXT_PATH, "r", encoding="utf-8") as f:
        content = f.read()
    return content

@app.get("/api/countries", tags=["Countries"])
def list_countries(refresh: bool = False):
    """
    Listado de países disponibles en Venolie TV con la cantidad de canales por país.
    """
    countries = fetch_countries(force_refresh=refresh)
    return {
        "total": len(countries),
        "countries": countries
    }

@app.get("/api/countries/{country_slug}", tags=["Countries"])
def get_country(country_slug: str, refresh: bool = False):
    """
    Detalles y canales de un país específico (ej: morocco, egypt, qatar, france).
    """
    countries = fetch_countries(force_refresh=refresh)
    country_info = next((c for c in countries if c['slug'].lower() == country_slug.lower()), None)
    channels = fetch_country_channels(country_slug, force_refresh=refresh)
    
    return {
        "country": country_info or {"slug": country_slug, "name": country_slug.capitalize()},
        "total_channels": len(channels),
        "channels": channels
    }

@app.get("/api/countries/{country_slug}/channels", tags=["Countries"])
def get_country_channels(country_slug: str, refresh: bool = False):
    """
    Obtiene únicamente la lista de canales de un país.
    """
    channels = fetch_country_channels(country_slug, force_refresh=refresh)
    return {
        "country": country_slug,
        "total": len(channels),
        "channels": channels
    }

@app.get("/api/categories", tags=["Categories"])
def list_categories():
    """
    Listado de categorías disponibles en todos los canales con su respectivo conteo.
    """
    all_channels = get_all_channels_parallel()
    categories_map = {}

    for ch in all_channels:
        cat = ch.get('category', 'General')
        categories_map[cat] = categories_map.get(cat, 0) + 1

    result = [{"category": k, "count": v} for k, v in sorted(categories_map.items(), key=lambda x: x[1], reverse=True)]
    return {
        "total": len(result),
        "categories": result
    }

@app.get("/api/categories/{category_name}", tags=["Categories"])
def get_category_channels(category_name: str, limit: int = 100):
    """
    Obtiene los canales pertenecientes a una categoría específica.
    """
    channels = get_all_channels(limit=limit, category=category_name)
    return {
        "category": category_name,
        "total": len(channels),
        "channels": channels
    }

@app.get("/api/channels", tags=["Channels"])
def list_channels(
    country: Optional[str] = Query(None, description="Filtrar por slug de país (ej. morocco)"),
    category: Optional[str] = Query(None, description="Filtrar por categoría (ej. sports)"),
    search: Optional[str] = Query(None, description="Término de búsqueda para nombre o ID"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=500)
):
    """
    Lista completa de canales con soporte para filtrado, búsqueda y paginación.
    """
    channels = get_all_channels(limit=1000, category=category, country=country, search=search)
    
    start = (page - 1) * limit
    end = start + limit
    paginated = channels[start:end]

    return {
        "total": len(channels),
        "page": page,
        "limit": limit,
        "total_pages": (len(channels) + limit - 1) // limit if channels else 1,
        "channels": paginated
    }

@app.get("/api/channels/resolved", tags=["Channels"])
def list_channels_resolved(
    country: Optional[str] = Query(None),
    limit: int = Query(500, ge=1, le=1000)
):
    """
    ⚡ ENDPOINT BATCH PARALELO: Resuelve todos los canales con sus stream_url, stream_type,
    embed_url y logo en paralelo usando ThreadPoolExecutor. Una sola petición, sin redirects 307.
    Diseñado para ser consumido por Node.js en el refresco periódico.
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    all_channels = get_all_channels(limit=limit, country=country)
    print(f"[resolved] Resolviendo {len(all_channels)} canales en paralelo...")

    result = []
    result_lock = __import__('threading').Lock()

    def resolve_one(ch):
        try:
            detail = resolve_channel_details(ch['id'])
        except Exception:
            detail = None

        if detail:
            entry = {
                'id': ch['id'],
                'name': detail.get('name', ch.get('name', ch['id'])),
                'country_slug': ch.get('country_slug', ''),
                'country_name': ch.get('country_name', ''),
                'category': ch.get('category', 'General'),
                'logo': ch.get('logo'),
                'stream_url': detail.get('stream_url'),
                'stream_type': detail.get('stream_type', 'unknown'),
                'embed_url': detail.get('embed_url'),
                'headers': detail.get('headers', {}),
            }
        else:
            entry = {
                'id': ch['id'],
                'name': ch.get('name', ch['id']),
                'country_slug': ch.get('country_slug', ''),
                'country_name': ch.get('country_name', ''),
                'category': ch.get('category', 'General'),
                'logo': ch.get('logo'),
                'stream_url': None,
                'stream_type': 'unknown',
                'embed_url': None,
                'headers': {},
            }
        with result_lock:
            result.append(entry)

    # Máximo 20 workers paralelos para no saturar venolie.com
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = [executor.submit(resolve_one, ch) for ch in all_channels]
        for f in as_completed(futures):
            pass  # Los resultados se añaden dentro de resolve_one via lock

    print(f"[resolved] Completado: {len(result)} canales resueltos.")
    return {
        "total": len(result),
        "channels": result
    }



@app.get("/api/channels/{channel_id}", tags=["Channels"])
def get_channel_detail(channel_id: str, refresh: bool = False):
    """
    Metadatos completos y enlace de transmisión HLS (.m3u8) resuelto.
    """
    channel = resolve_channel_details(channel_id, force_refresh=refresh)
    if not channel:
        raise HTTPException(status_code=404, detail=f"El canal '{channel_id}' no fue encontrado en Venolie TV.")
    return channel

@app.get("/api/channels/{channel_id}/stream", tags=["Streams"])
def get_channel_stream(
    channel_id: str,
    redirect: bool = Query(True, description="Redirigir (HTTP 307) a la URL .m3u8 resuelta"),
    proxy: bool = Query(False, description="Proxear la lista .m3u8 directamente"),
    request: Request = None
):
    """
    Endpoint de streaming para reproductores HLS (VLC, Tivimate, Web Player).
    """
    channel = resolve_channel_details(channel_id)
    if not channel or not channel.get("stream_url"):
        if channel and channel.get("embed_url"):
            if redirect:
                return RedirectResponse(url=channel["embed_url"], status_code=307)
            return {"error": "HLS directo no disponible", "embed_url": channel["embed_url"]}
        raise HTTPException(status_code=404, detail=f"No se pudo resolver el stream para '{channel_id}'.")

    stream_url = channel["stream_url"]

    if redirect:
        return RedirectResponse(url=stream_url, status_code=307)

    if proxy:
        try:
            headers = channel.get("headers", {})
            r = requests.get(stream_url, headers=headers, timeout=5)
            return Response(content=r.content, media_type="application/x-mpegurl")
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Error al proxear la lista HLS: {e}")

    return {
        "id": channel_id,
        "name": channel["name"],
        "stream_url": stream_url,
        "stream_type": channel.get("stream_type", "hls"),
        "headers": channel.get("headers", {})
    }

@app.get("/playlist.m3u", response_class=PlainTextResponse, tags=["Documentación & Listas"])
@app.get("/api/playlist.m3u", response_class=PlainTextResponse, tags=["Documentación & Listas"])
def generate_m3u_playlist(
    request: Request,
    country: Optional[str] = Query(None, description="Filtrar M3U por país"),
    category: Optional[str] = Query(None, description="Filtrar M3U por categoría")
):
    """
    Genera dinámicamente la lista M3U IPTV compatible con Tivimate, VLC, OTT Navigator, etc.
    """
    channels = get_all_channels(limit=1000, category=category, country=country)
    
    # Extract host header from request to support 0.0.0.0 and external IP
    host_header = request.headers.get("host", "0.0.0.0:9090")
    scheme = request.url.scheme or "http"
    base_url = f"{scheme}://{host_header}"

    lines = ["#EXTM3U url-tvg=\"https://venolie.com/navo/\""]

    for ch in channels:
        ch_id = ch['id']
        name = ch['name']
        c_name = ch.get('country_name', ch.get('country_slug', 'General')).capitalize()
        cat = ch.get('category', 'General')
        
        stream_link = f"{base_url}/api/channels/{ch_id}/stream"
        
        extinf = f'#EXTINF:-1 tvg-id="{ch_id}" tvg-name="{name}" group-title="{c_name} - {cat}",{name}'
        lines.append(extinf)
        lines.append(stream_link)

    return "\n".join(lines)

@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def index_page():
    """
    Dashboard Web y Reproductor HLS.js Integrado para Venolie API (Puerto 9090 / 0.0.0.0)
    """
    return """<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Venolie TV - Live HLS IPTV API & Player (0.0.0.0:9090)</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        :root {
            --bg-primary: #090d16;
            --bg-secondary: #111726;
            --bg-card: rgba(20, 27, 44, 0.75);
            --accent: #6366f1;
            --accent-hover: #4f46e5;
            --accent-glow: rgba(99, 102, 241, 0.4);
            --emerald: #10b981;
            --text-main: #f3f4f6;
            --text-muted: #9ca3af;
            --border: rgba(255, 255, 255, 0.08);
            --glass-bg: rgba(17, 23, 38, 0.7);
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background: radial-gradient(circle at 50% 0%, #151c33 0%, var(--bg-primary) 75%);
            color: var(--text-main);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        header {
            background: var(--glass-bg);
            backdrop-filter: blur(16px);
            border-bottom: 1px solid var(--border);
            position: sticky;
            top: 0;
            z-index: 100;
            padding: 1rem 2rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .logo {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            font-size: 1.4rem;
            font-weight: 700;
            color: #fff;
            text-decoration: none;
        }

        .logo-badge {
            background: linear-gradient(135deg, var(--accent), #8b5cf6);
            padding: 0.25rem 0.6rem;
            border-radius: 6px;
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .nav-links {
            display: flex;
            gap: 1rem;
            align-items: center;
        }

        .btn {
            padding: 0.55rem 1.1rem;
            border-radius: 8px;
            font-size: 0.88rem;
            font-weight: 500;
            text-decoration: none;
            cursor: pointer;
            transition: all 0.2s ease;
            border: none;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent), #4f46e5);
            color: white;
            box-shadow: 0 4px 14px var(--accent-glow);
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 6px 20px var(--accent-glow);
        }

        .btn-outline {
            background: rgba(255, 255, 255, 0.05);
            color: var(--text-main);
            border: 1px solid var(--border);
        }

        .btn-outline:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        .main-container {
            max-width: 1400px;
            width: 100%;
            margin: 0 auto;
            padding: 1.5rem;
            display: grid;
            grid-template-columns: 360px 1fr;
            gap: 1.5rem;
            flex: 1;
        }

        @media (max-width: 1024px) {
            .main-container {
                grid-template-columns: 1fr;
            }
        }

        .sidebar {
            background: var(--bg-card);
            backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 1.25rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
            max-height: calc(100vh - 110px);
            position: sticky;
            top: 90px;
        }

        .select-group {
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
        }

        label {
            font-size: 0.8rem;
            color: var(--text-muted);
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        select, input {
            width: 100%;
            padding: 0.7rem 0.9rem;
            background: rgba(9, 13, 22, 0.7);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: white;
            font-family: inherit;
            font-size: 0.9rem;
            outline: none;
            transition: border 0.2s ease;
        }

        select:focus, input:focus {
            border-color: var(--accent);
        }

        .channel-list {
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 0.4rem;
            padding-right: 0.4rem;
            flex: 1;
        }

        .channel-item {
            padding: 0.7rem 0.9rem;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid transparent;
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: all 0.2s ease;
        }

        .channel-item:hover {
            background: rgba(255, 255, 255, 0.07);
            border-color: rgba(255, 255, 255, 0.1);
        }

        .channel-item.active {
            background: linear-gradient(135deg, rgba(99, 102, 241, 0.25), rgba(139, 92, 246, 0.25));
            border-color: var(--accent);
        }

        .channel-name {
            font-weight: 500;
            font-size: 0.9rem;
        }

        .channel-tag {
            font-size: 0.7rem;
            padding: 0.15rem 0.45rem;
            border-radius: 4px;
            background: rgba(255, 255, 255, 0.08);
            color: var(--text-muted);
        }

        .player-section {
            display: flex;
            flex-direction: column;
            gap: 1.25rem;
        }

        .player-wrapper {
            background: #000;
            border-radius: 16px;
            overflow: hidden;
            border: 1px solid var(--border);
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
            aspect-ratio: 16/9;
            position: relative;
        }

        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }

        .player-status {
            position: absolute;
            top: 1rem;
            left: 1rem;
            background: rgba(0, 0, 0, 0.75);
            backdrop-filter: blur(8px);
            padding: 0.35rem 0.75rem;
            border-radius: 20px;
            font-size: 0.8rem;
            display: flex;
            align-items: center;
            gap: 0.4rem;
            border: 1px solid var(--border);
            z-index: 10;
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--emerald);
            box-shadow: 0 0 8px var(--emerald);
        }

        .info-card {
            background: var(--bg-card);
            backdrop-filter: blur(12px);
            border: 1px solid var(--border);
            border-radius: 16px;
            padding: 1.25rem;
            display: flex;
            flex-direction: column;
            gap: 1rem;
        }

        .info-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .info-title {
            font-size: 1.25rem;
            font-weight: 700;
        }

        .code-block {
            background: rgba(9, 13, 22, 0.85);
            padding: 0.85rem;
            border-radius: 8px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.82rem;
            color: #a5b4fc;
            overflow-x: auto;
            border: 1px solid var(--border);
            position: relative;
        }

        .copy-btn {
            position: absolute;
            top: 0.4rem;
            right: 0.4rem;
            padding: 0.2rem 0.5rem;
            font-size: 0.7rem;
            background: rgba(255, 255, 255, 0.1);
            border: none;
            border-radius: 4px;
            color: white;
            cursor: pointer;
        }

        .copy-btn:hover {
            background: rgba(255, 255, 255, 0.2);
        }

        .grid-4 {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 0.75rem;
        }

        .meta-item {
            background: rgba(255, 255, 255, 0.02);
            padding: 0.6rem;
            border-radius: 8px;
            border: 1px solid var(--border);
            display: flex;
            flex-direction: column;
            gap: 0.2rem;
        }

        .meta-label {
            font-size: 0.7rem;
            color: var(--text-muted);
            text-transform: uppercase;
        }

        .meta-value {
            font-weight: 600;
            font-size: 0.9rem;
        }

        footer {
            border-top: 1px solid var(--border);
            padding: 1.25rem;
            text-align: center;
            color: var(--text-muted);
            font-size: 0.82rem;
            margin-top: 2rem;
        }
    </style>
</head>
<body>

    <header>
        <a href="/" class="logo">
            <span>📺</span> Venolie IPTV API
            <span class="logo-badge">0.0.0.0:9090</span>
        </a>
        <div class="nav-links">
            <a href="/canales.txt" target="_blank" class="btn btn-outline">📄 canales.txt</a>
            <a href="/playlist.m3u" target="_blank" class="btn btn-outline">📋 IPTV Playlist (.m3u)</a>
            <a href="/docs" target="_blank" class="btn btn-primary">Swagger Docs</a>
        </div>
    </header>

    <div class="main-container">
        <div class="sidebar">
            <div class="select-group">
                <label for="countrySelect">Seleccionar País</label>
                <select id="countrySelect" onchange="onCountryChange()">
                    <option value="">Cargando países...</option>
                </select>
            </div>

            <div class="select-group">
                <label for="searchInput">Buscar Canal</label>
                <input type="text" id="searchInput" placeholder="Nombre o ID del canal..." oninput="onSearchInput()">
            </div>

            <div class="select-group" style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
                <label>Canales Disponibles (<span id="channelCount">0</span>)</label>
                <div class="channel-list" id="channelList">
                    <div style="padding: 1rem; text-align: center; color: var(--text-muted);">Cargando canales...</div>
                </div>
            </div>
        </div>

        <div class="player-section">
            <div class="player-wrapper">
                <div class="player-status">
                    <div class="status-dot"></div>
                    <span id="playerStatusText">Listo</span>
                </div>
                <video id="videoPlayer" controls autoplay muted></video>
            </div>

            <div class="info-card">
                <div class="info-header">
                    <div>
                        <div class="info-title" id="chTitle">Selecciona un Canal</div>
                        <div style="color: var(--text-muted); font-size: 0.85rem;" id="chSubtitle">Haz clic en cualquier canal para iniciar la reproducción en vivo</div>
                    </div>
                    <a id="directM3uLink" href="#" target="_blank" class="btn btn-outline" style="display: none;">Abrir .m3u8</a>
                </div>

                <div class="grid-4" id="metaGrid" style="display: none;">
                    <div class="meta-item">
                        <span class="meta-label">País</span>
                        <span class="meta-value" id="metaCountry">-</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">Categoría</span>
                        <span class="meta-value" id="metaCategory">-</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">Idioma</span>
                        <span class="meta-value" id="metaLanguage">-</span>
                    </div>
                    <div class="meta-item">
                        <span class="meta-label">Tipo Stream</span>
                        <span class="meta-value" id="metaType">-</span>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                    <label>URL Stream Resuelta (HLS / m3u8)</label>
                    <div class="code-block">
                        <button class="copy-btn" onclick="copyStreamUrl()">Copiar</button>
                        <span id="codeStreamUrl">https://...</span>
                    </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                    <label>Endpoint API para este canal</label>
                    <div class="code-block">
                        <span id="codeApiEndpoint">GET /api/channels/{id}/stream</span>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <footer>
        Venolie TV Open Source IPTV Resolution API • Escuchando en 0.0.0.0:9090
    </footer>

    <script>
        let currentChannels = [];
        let hlsPlayer = null;
        let selectedChannelId = null;

        async function init() {
            try {
                const res = await fetch('/api/countries');
                const data = await res.json();
                const select = document.getElementById('countrySelect');
                select.innerHTML = '';
                
                data.countries.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.slug;
                    opt.textContent = `${c.name} (${c.channel_count} canales)`;
                    select.appendChild(opt);
                });

                if (data.countries.some(c => c.slug === 'morocco')) {
                    select.value = 'morocco';
                }
                
                onCountryChange();
            } catch (err) {
                console.error("Error al inicializar países:", err);
            }
        }

        async function onCountryChange() {
            const country = document.getElementById('countrySelect').value;
            if (!country) return;

            const listDiv = document.getElementById('channelList');
            listDiv.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">Cargando...</div>';

            try {
                const res = await fetch(`/api/countries/${country}/channels`);
                const data = await res.json();
                currentChannels = data.channels || [];
                renderChannels(currentChannels);

                if (currentChannels.length > 0) {
                    playChannel(currentChannels[0].id);
                }
            } catch (err) {
                listDiv.innerHTML = '<div style="padding: 1rem; text-align: center; color: red;">Error al cargar</div>';
            }
        }

        function onSearchInput() {
            const query = document.getElementById('searchInput').value.toLowerCase();
            const filtered = currentChannels.filter(c => 
                c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query)
            );
            renderChannels(filtered);
        }

        function renderChannels(channels) {
            const listDiv = document.getElementById('channelList');
            document.getElementById('channelCount').textContent = channels.length;
            listDiv.innerHTML = '';

            if (channels.length === 0) {
                listDiv.innerHTML = '<div style="padding: 1rem; text-align: center; color: var(--text-muted);">No hay canales</div>';
                return;
            }

            channels.forEach(ch => {
                const item = document.createElement('div');
                item.className = `channel-item ${ch.id === selectedChannelId ? 'active' : ''}`;
                item.onclick = () => playChannel(ch.id);

                item.innerHTML = `
                    <span class="channel-name">${ch.name}</span>
                    <span class="channel-tag">${ch.category}</span>
                `;
                listDiv.appendChild(item);
            });
        }

        async function playChannel(chId) {
            selectedChannelId = chId;
            renderChannels(currentChannels);

            const statusText = document.getElementById('playerStatusText');
            statusText.textContent = "Resolviendo stream...";
            document.getElementById('chTitle').textContent = "Resolviendo...";
            document.getElementById('chSubtitle').textContent = `Obteniendo metadatos para ${chId}...`;

            try {
                const res = await fetch(`/api/channels/${chId}`);
                if (!res.ok) throw new Error("Resolución fallida");
                
                const data = await res.json();
                
                document.getElementById('chTitle').textContent = data.name;
                document.getElementById('chSubtitle').textContent = `ID: ${data.id} • Página: ${data.page_url}`;
                document.getElementById('metaGrid').style.display = 'grid';
                document.getElementById('metaCountry').textContent = data.country;
                document.getElementById('metaCategory').textContent = data.category;
                document.getElementById('metaLanguage').textContent = data.language;
                document.getElementById('metaType').textContent = data.stream_type.toUpperCase();

                const streamUrl = data.stream_url || data.embed_url || "";
                document.getElementById('codeStreamUrl').textContent = streamUrl;
                document.getElementById('codeApiEndpoint').textContent = `${window.location.origin}/api/channels/${chId}/stream`;

                const directBtn = document.getElementById('directM3uLink');
                if (data.stream_url) {
                    directBtn.href = data.stream_url;
                    directBtn.style.display = 'inline-flex';
                } else {
                    directBtn.style.display = 'none';
                }

                if (data.stream_url && data.stream_type === 'hls') {
                    loadHLS(data.stream_url);
                } else if (data.embed_url) {
                    statusText.textContent = "Reproductor Embebido";
                } else {
                    statusText.textContent = "Stream no directo";
                }
            } catch (err) {
                console.error("Error al reproducir:", err);
                statusText.textContent = "Error Stream";
            }
        }

        function loadHLS(url) {
            const video = document.getElementById('videoPlayer');
            const statusText = document.getElementById('playerStatusText');

            if (Hls.isSupported()) {
                if (hlsPlayer) {
                    hlsPlayer.destroy();
                }
                hlsPlayer = new Hls({
                    enableWorker: true,
                    lowLatencyMode: true
                });
                hlsPlayer.loadSource(url);
                hlsPlayer.attachMedia(video);
                hlsPlayer.on(Hls.Events.MANIFEST_PARSED, function () {
                    video.play().catch(e => console.log("Autoplay prevenido:", e));
                    statusText.textContent = "Transmitiendo Live HLS";
                });
                hlsPlayer.on(Hls.Events.ERROR, function (event, data) {
                    if (data.fatal) {
                        statusText.textContent = "Error HLS";
                    }
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = url;
                video.addEventListener('loadedmetadata', function () {
                    video.play();
                    statusText.textContent = "Transmitiendo Live HLS";
                });
            }
        }

        function copyStreamUrl() {
            const url = document.getElementById('codeStreamUrl').textContent;
            navigator.clipboard.writeText(url).then(() => {
                alert("¡URL del stream copiada al portapapeles!");
            });
        }

        window.onload = init;
    </script>
</body>
</html>
"""

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=9090, reload=False)
