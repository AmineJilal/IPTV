import requests
from bs4 import BeautifulSoup
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urljoin, parse_qs, urlparse

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

BASE_URL = "https://venolie.com/navo/"
DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
}

CACHE_TTL = 1800  # 30 minutes cache for fast responses
_cache = {
    'countries': {'timestamp': 0, 'data': []},
    'channels_by_country': {},
    'channel_details': {},
    'all_channels_flat': {'timestamp': 0, 'data': []}
}

def get_session():
    s = requests.Session()
    s.headers.update(DEFAULT_HEADERS)
    return s

def clean_country_name(raw_text, slug):
    clean = re.sub(r'^\d+\s*Channels', '', raw_text, flags=re.IGNORECASE)
    clean = re.sub(r'Live\s*TV\s*Channels', '', clean, flags=re.IGNORECASE)
    clean = re.sub(r'TV\s*Channels', '', clean, flags=re.IGNORECASE).strip()
    
    if not clean or clean.lower() == slug.lower():
        name_map = {
            'saoudia-arabia': 'Saudi Arabia',
            'morocco': 'Morocco',
            'qatar': 'Qatar',
            'palestine': 'Palestine',
            'egypt': 'Egypt',
            'kuwait': 'Kuwait',
            'algeria': 'Algeria',
            'tunisia': 'Tunisia',
            'syria': 'Syria',
            'lebanon': 'Lebanon',
            'libya': 'Libya',
            'uae': 'United Arab Emirates',
            'france': 'France',
            'germany': 'Germany',
            'persian': 'Iran / Persia'
        }
        return name_map.get(slug.lower(), slug.replace('-', ' ').title())
    return clean

def fetch_countries(force_refresh=False):
    now = time.time()
    if not force_refresh and (now - _cache['countries']['timestamp'] < CACHE_TTL) and _cache['countries']['data']:
        return _cache['countries']['data']

    session = get_session()
    try:
        res = session.get(BASE_URL, timeout=10)
        if res.status_code != 200:
            return _cache['countries']['data'] or []

        soup = BeautifulSoup(res.text, 'html.parser')
        countries = []
        country_links = soup.find_all('a', href=re.compile(r'country/.*\.php'))
        
        for a in country_links:
            href = a['href']
            text = a.get_text(strip=True)
            slug = href.split('country/')[-1].replace('.php', '').strip()
            
            count_match = re.search(r'(\d+)\s*Channels', text, re.IGNORECASE)
            count = int(count_match.group(1)) if count_match else 0
            
            clean_name = clean_country_name(text, slug)
                
            countries.append({
                'name': clean_name,
                'slug': slug,
                'url': urljoin(BASE_URL, href),
                'channel_count': count
            })

        _cache['countries'] = {'timestamp': now, 'data': countries}
        return countries
    except Exception as e:
        print(f"Error fetching countries: {e}")
        return _cache['countries']['data'] or []

def fetch_country_channels(country_slug, force_refresh=False):
    now = time.time()
    cached = _cache['channels_by_country'].get(country_slug)
    if not force_refresh and cached and (now - cached['timestamp'] < CACHE_TTL):
        return cached['data']

    url = f"https://venolie.com/navo/view/country/{country_slug}.php"
    session = get_session()
    try:
        res = session.get(url, timeout=10)
        if res.status_code != 200:
            return cached['data'] if cached else []

        soup = BeautifulSoup(res.text, 'html.parser')
        channels = []
        seen = set()

        items = soup.find_all('a', href=re.compile(r'/p/.*\.php'))
        for a in items:
            href = urljoin(url, a['href'])
            ch_id = href.split('/p/')[-1].replace('.php', '').strip()
            if not ch_id or ch_id in seen:
                continue
            seen.add(ch_id)

            raw_text = a.get_text(" | ", strip=True)
            parts = [p.strip() for p in raw_text.split('|') if p.strip()]
            
            title = ch_id.replace('-', ' ').replace('_', ' ').title()
            category = "General"
            is_hd = False

            if len(parts) >= 2:
                cleaned_parts = [p for p in parts if p.lower() not in ['read', 'watch', 'live', 'tv']]
                if cleaned_parts:
                    title = cleaned_parts[0]
                if len(cleaned_parts) > 1:
                    category = cleaned_parts[1]
                if 'hd' in raw_text.lower():
                    is_hd = True

            # Intentar extraer logo del img dentro del enlace
            logo_url = None
            img = a.find('img')
            if img:
                logo_src = img.get('src') or img.get('data-src')
                if logo_src:
                    logo_url = urljoin(url, logo_src)

            channels.append({
                'id': ch_id,
                'name': title,
                'country_slug': country_slug,
                'category': category,
                'is_hd': is_hd,
                'page_url': href,
                'logo': logo_url
            })

        _cache['channels_by_country'][country_slug] = {'timestamp': now, 'data': channels}
        return channels
    except Exception as e:
        print(f"Error fetching country channels for {country_slug}: {e}")
        return cached['data'] if cached else []

def resolve_youtube_stream(youtube_url):
    if not yt_dlp:
        return None
    ydl_opts = {
        # Formato compatible con streams en vivo de YouTube
        'format': 'best[protocol=m3u8_native]/best[protocol=m3u8]/best[ext=mp4]/best',
        'quiet': True,
        'no_warnings': True,
        'socket_timeout': 8,
        'extractor_args': {'youtube': {'skip': ['dash', 'hls']}},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(youtube_url, download=False)
            return info.get('url')
    except Exception as e:
        return None

def resolve_channel_details(channel_id, force_refresh=False):
    now = time.time()
    cached = _cache['channel_details'].get(channel_id)
    if not force_refresh and cached and (now - cached['timestamp'] < CACHE_TTL):
        return cached['data']

    ALIAS_MAP = {
        "mbc2": "bc2",
        "mbc-2": "bc2",
        "mbc1": "bc",
        "mbc-1": "bc",
        "mbc3": "bc3",
        "mbc-3": "bc3",
        "mbc4": "bc4",
        "mbc-4": "bc4",
        "mbc5": "bc5",
        "mbc-5": "bc5",
        "mbcaction": "bcaction",
        "mbcmax": "bcmax",
        "mbcbollywood": "bcbollywood",
        "mbcdrama": "bcdrama"
    }
    target_id = ALIAS_MAP.get(channel_id.lower(), channel_id)
    url = f"https://venolie.com/navo/view/p/{target_id}.php"
    session = get_session()
    try:
        res = session.get(url, timeout=8)
        if res.status_code != 200:
            return None

        soup = BeautifulSoup(res.text, 'html.parser')

        metadata = {}
        for elem in soup.find_all(['li', 'p', 'div', 'span']):
            txt = elem.get_text(strip=True)
            if ':' in txt:
                k, v = txt.split(':', 1)
                key = k.strip().lower()
                val = v.strip()
                if key in ['name', 'country', 'category', 'language', 'frequency', 'satellite', 'sat']:
                    metadata[key] = val

        h1 = soup.find('h1')
        name = metadata.get('name') or (h1.get_text(strip=True) if h1 else channel_id.replace('-', ' ').title())
        country = metadata.get('country') or "Unknown"
        category = metadata.get('category') or "General"
        language = metadata.get('language') or "Arabic"

        iframes = soup.find_all('iframe')
        iframe_srcs = [i.get('src') for i in iframes if i.get('src')]

        m3u8_in_html = list(set(re.findall(r'https?://[^\s\"\'<>\\]+\.m3u8[^\s\"\'<>\\]*', res.text)))

        stream_url = None
        stream_type = "unknown"
        embed_url = iframe_srcs[0] if iframe_srcs else None

        # Check Venolie JWPlayer ?id= parameter
        for src in iframe_srcs:
            if 'player/?id=' in src or 'player/index.php?id=' in src:
                parsed = urlparse(src)
                qs = parse_qs(parsed.query)
                if 'id' in qs and qs['id'][0].endswith('.m3u8'):
                    stream_url = qs['id'][0]
                    stream_type = "hls"
                    break

        if not stream_url and m3u8_in_html:
            stream_url = m3u8_in_html[0]
            stream_type = "hls"

        if not stream_url and embed_url:
            full_embed_url = urljoin(url, embed_url)
            if 'youtube.com/embed' in full_embed_url or 'youtu.be' in full_embed_url:
                stream_type = "youtube"
                resolved_yt = resolve_youtube_stream(full_embed_url)
                if resolved_yt:
                    stream_url = resolved_yt
                    stream_type = "hls"
            elif 'azrogo.com' in full_embed_url or 'jawaltv.com' in full_embed_url:
                try:
                    clean_embed_url = full_embed_url
                    if '/ext/http' in clean_embed_url:
                        clean_embed_url = clean_embed_url.split('/ext/')[-1]
                    iframe_res = session.get(clean_embed_url, timeout=5, headers={'Referer': 'https://venolie.com/'})
                    iframe_m3u8 = re.findall(r'https?://[^\s\"\'<>\\]+\.m3u8[^\s\"\'<>\\]*', iframe_res.text)
                    if iframe_m3u8:
                        stream_url = iframe_m3u8[0]
                        stream_type = "hls"
                    else:
                        # Decodificar transmisiones Base64 (atob) en Azrogo / JawalTV
                        atob_matches = re.findall(r'atob\(["\']([^"\']+)["\']\)', iframe_res.text)
                        for b64 in atob_matches:
                            try:
                                import base64
                                dec = base64.b64decode(b64).decode('utf-8', errors='ignore')
                                if dec.startswith('http'):
                                    stream_url = dec
                                    stream_type = "hls"
                                    break
                            except Exception:
                                pass
                except Exception:
                    pass
            elif 'easybroadcast.io' in full_embed_url:
                try:
                    eb_res = session.get(full_embed_url, timeout=5, headers={'Referer': url})
                    eb_m3u8 = re.findall(r'https?://[^\s\"\'<>\\]+\.m3u8[^\s\"\'<>\\]*', eb_res.text)
                    if eb_m3u8:
                        stream_url = eb_m3u8[0]
                        stream_type = "hls"
                    else:
                        stream_type = "easybroadcast"
                except Exception:
                    stream_type = "easybroadcast"
            elif 'dailymotion.com' in full_embed_url:
                stream_type = "dailymotion"

        required_headers = {
            'User-Agent': DEFAULT_HEADERS['User-Agent'],
            'Referer': url,
            'Origin': 'https://venolie.com'
        }
        
        if embed_url:
            if 'jawaltv.com' in embed_url:
                required_headers['Referer'] = 'http://jawaltv.com/'
                required_headers['Origin'] = 'http://jawaltv.com'
            elif 'azrogo.com' in embed_url:
                required_headers['Referer'] = 'https://azrogo.com/'
                required_headers['Origin'] = 'https://azrogo.com'
            elif 'easybroadcast.io' in embed_url:
                required_headers['Referer'] = 'https://snrt.player.easybroadcast.io/'
                required_headers['Origin'] = 'https://snrt.player.easybroadcast.io'

        result = {
            'id': channel_id,
            'name': name,
            'country': country,
            'category': category,
            'language': language,
            'page_url': url,
            'stream_url': stream_url,
            'stream_type': stream_type,
            'embed_url': urljoin(url, embed_url) if embed_url else None,
            'metadata': metadata,
            'headers': required_headers
        }

        _cache['channel_details'][channel_id] = {'timestamp': now, 'data': result}
        return result
    except Exception as e:
        print(f"Error resolving channel {channel_id}: {e}")
        return None

def get_all_channels_parallel(force_refresh=False):
    now = time.time()
    if not force_refresh and (now - _cache['all_channels_flat']['timestamp'] < CACHE_TTL) and _cache['all_channels_flat']['data']:
        return _cache['all_channels_flat']['data']

    countries = fetch_countries(force_refresh=force_refresh)
    all_channels = []
    
    with ThreadPoolExecutor(max_workers=10) as executor:
        future_to_country = {executor.submit(fetch_country_channels, c['slug'], force_refresh): c for c in countries}
        for future in as_completed(future_to_country):
            c_info = future_to_country[future]
            try:
                channels = future.result()
                for ch in channels:
                    ch['country_name'] = c_info['name']
                    all_channels.append(ch)
            except Exception as e:
                print(f"Error loading channels for country {c_info['slug']}: {e}")

    _cache['all_channels_flat'] = {'timestamp': now, 'data': all_channels}
    return all_channels

def get_all_channels(limit=500, category=None, country=None, search=None):
    all_ch = get_all_channels_parallel()
    filtered = []

    for ch in all_ch:
        if country and ch['country_slug'].lower() != country.lower():
            continue
        if category and ch['category'].lower() != category.lower():
            continue
        if search and search.lower() not in ch['name'].lower() and search.lower() not in ch['id'].lower():
            continue
        filtered.append(ch)
        if len(filtered) >= limit:
            break

    return filtered
