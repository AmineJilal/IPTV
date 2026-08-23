require('dotenv').config();
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs').promises;
const { createClient } = require('@libsql/client');
const https      = require('https');
const http_mod   = require('http');
const { URL }    = require('url');

// 1. Manejo Global de Errores para evitar caídas fatales del backend
process.on('uncaughtException', (err) => {
    console.error('🔥 Error Crítico no capturado (Node sigue vivo):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promesa rota no manejada:', reason);
});

// Extractor eliminado del servidor principal (Se ejecuta en pc_worker.js)

const app    = express();
const server = http.createServer(app);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function parseStreamUrl(urlStr) {
    const input = (urlStr || '').trim();
    if (!input) return { cleanUrl: '', referer: '', origin: '', userAgent: '' };

    const parts = input.split('|');
    const cleanUrl = (parts.shift() || '').trim();

    let referer = '';
    let origin = '';
    let userAgent = '';

    for (const part of parts) {
        if (!part || !part.includes('=')) continue;
        const eq = part.indexOf('=');
        const rawKey = part.slice(0, eq).trim().toLowerCase();
        const rawVal = part.slice(eq + 1).trim();
        if (!rawVal) continue;

        const value = (() => {
            try { return decodeURIComponent(rawVal); }
            catch { return rawVal; }
        })();

        if (!referer && (rawKey === 'referer' || rawKey === 'referrer')) referer = value;
        if (!origin && rawKey === 'origin') origin = value;
        if (!userAgent && (rawKey === 'user-agent' || rawKey === 'ua')) userAgent = value;
    }

    return { cleanUrl, referer, origin, userAgent };
}

function buildBrowserHeaders(referer, origin = null, userAgent = null) {
    const headers = {
        'User-Agent': userAgent || UA,
        'Accept': '*/*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
    };

    if (referer) headers['Referer'] = referer;
    if (origin) headers['Origin'] = origin;

    return headers;
}

function buildProxyUrlFromRequest(req, rawUrl) {
    const host = req.get('host') || req.headers.host || '127.0.0.1:3000';
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    return `${proto}://${host}/proxy-video?url=${encodeURIComponent(rawUrl)}`;
}

// ── Utilidad Global y Segura para Peticiones con Timeout ──
async function safeFetch(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.cause) {
            const causeMsg = e.cause.message || e.cause.code || e.cause;
            throw new Error(`${e.message} (cause: ${causeMsg})`);
        }
        throw e;
    }
}

// ── Resolutores Nativos para TDT España (Atresmedia & Mediaset) ──
async function resolveNativeAtresmedia(slug) {
    const headers = {
        'Origin': 'https://www.atresplayer.com',
        'Referer': 'https://www.atresplayer.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    };
    const href = encodeURIComponent(`/directos/${slug}/`);
    const r1 = await safeFetch(`https://api.atresplayer.com/client/v1/url?href=${href}&usp=true&device=desktop&NODRM=true`, { headers }, 8000);
    if (!r1 || !r1.ok) throw new Error(`[Atres Step 1] HTTP ${r1 ? r1.status : 'timeout'}`);
    const d1 = await r1.json();
    if (!d1.href) throw new Error(`[Atres Step 1] Missing d1.href in ${JSON.stringify(d1)}`);
    
    const r2 = await safeFetch(d1.href, { headers }, 8000);
    if (!r2 || !r2.ok) throw new Error(`[Atres Step 2] HTTP ${r2 ? r2.status : 'timeout'}`);
    const d2 = await r2.json();
    if (!d2.urlVideo) throw new Error(`[Atres Step 2] Missing d2.urlVideo`);

    const r3 = await safeFetch(d2.urlVideo, { headers }, 8000);
    if (!r3 || !r3.ok) throw new Error(`[Atres Step 3] HTTP ${r3 ? r3.status : 'timeout'}`);
    const d3 = await r3.json();
    const sources = d3.sourcesLive || d3.sources || [];
    let m3u8 = null;
    for (const s of sources) {
        if (s.src && (s.src.includes('.m3u8') || s.type?.includes('mpegurl') || s.type?.includes('hls'))) {
            m3u8 = s.src;
            if (s.src.includes('playlist.m3u8') || s.src.includes('master.m3u8')) break;
        }
    }
    if (!m3u8 && sources[0]?.src) m3u8 = sources[0].src;
    if (!m3u8) throw new Error(`[Atres Step 3] No m3u8 source found`);
    return { stream_url: m3u8, headers };
}

async function resolveNativeMediaset(code) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
        'Origin': 'https://www.mediasetinfinity.es',
        'Referer': 'https://www.mediasetinfinity.es/',
        'Accept': '*/*',
        'Content-Type': 'application/json; charset=utf-8'
    };
    const r1 = await safeFetch('https://services-ott-prod-fe.mediaset.net/esp/idm/v3.0/anonymous/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ appName: 'web//mediasetplay-web/1.2.1-d1b2024', client_id: '12345678-1234-1234-1234-123456789012' })
    }, 8000);
    if (!r1 || !r1.ok) throw new Error(`[Media Step 1 Login] HTTP ${r1 ? r1.status : 'timeout'}`);
    const d1 = await r1.json();
    const sid = d1.response?.sid;
    const beToken = d1.response?.beToken;
    if (!sid || !beToken) throw new Error(`[Media Step 1] Missing sid/beToken`);

    const r2 = await safeFetch(`https://services-ott-prod-fe.mediaset.net/esp/playback/v3.0/check?sid=${sid}`, {
        method: 'POST',
        headers: { ...headers, 'Authorization': `Bearer ${beToken}` },
        body: JSON.stringify({ channelCode: code, streamType: 'LIVE', delivery: 'Streaming', createDevice: true, overrideAppName: 'web//mediasetplay-web/1.2.1-d1b2024' })
    }, 8000);
    if (!r2 || !r2.ok) throw new Error(`[Media Step 2 Check] HTTP ${r2 ? r2.status : 'timeout'}`);
    const d2 = await r2.json();
    const daiKey = d2.response?.dai?.assetKey;
    if (!daiKey) throw new Error(`[Media Step 2] Missing dai.assetKey in ${JSON.stringify(d2).substring(0, 150)}`);

    const r3 = await safeFetch(`https://pubads.g.doubleclick.net/ssai/event/${daiKey}/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': headers['User-Agent'] }
    }, 8000);
    if (!r3 || !r3.ok) throw new Error(`[Media Step 3 SSAI] HTTP ${r3 ? r3.status : 'timeout'}`);
    const d3 = await r3.json();
    const raw = d3.stream_manifest || '';
    if (!raw) throw new Error(`[Media Step 3] Missing stream_manifest`);

    let masterUrl = raw;
    try {
        const u = new URL(raw);
        const hdnea = u.searchParams.get('hdnea');
        const lastSlash = u.pathname.lastIndexOf('/');
        const basePath = lastSlash !== -1 ? u.pathname.substring(0, lastSlash) : u.pathname;
        masterUrl = `${u.origin}${basePath}/master.m3u8${hdnea ? '?hdnea=' + hdnea : ''}`;
    } catch(e) {}

    return { stream_url: masterUrl, headers: { 'Origin': 'https://www.mediasetinfinity.es', 'Referer': 'https://www.mediasetinfinity.es/', 'User-Agent': headers['User-Agent'] } };
}

// ── Comprobar si un HLS responde (Corregido Memory Leak en Catch) ──
async function testUrl(urlStr, timeoutMs = 6000, retries = 2) {
    const { cleanUrl, referer, origin, userAgent } = parseStreamUrl(urlStr);
    let lastError = 'desconocido';
    const reqHeaders = buildBrowserHeaders(referer, origin || null, userAgent || null);

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            let res = await safeFetch(cleanUrl, { method: 'HEAD', headers: reqHeaders, redirect: 'follow' }, timeoutMs);
            if (!res.ok || res.status === 405 || res.status === 501) {
                res = await safeFetch(cleanUrl, { method: 'GET', headers: reqHeaders, redirect: 'follow' }, timeoutMs);
            }

            if (res.ok) {
                if (res.body) {
                    const reader = res.body.getReader();
                    await reader.read();
                    reader.cancel();
                }
                return { status: 'OK' };
            }
            lastError = `HTTP ${res.status}`;
        } catch (e) {
            lastError = e.message;
            if (attempt < retries) await new Promise(r => setTimeout(r, 400));
        }
    }
    return { status: 'ERROR', reason: lastError };
}

// ── Validación en background: no marca offline hasta 3 fallos consecutivos ──
let validacionEnCurso = false;
const failCounts = new Map(); // id → fallos seguidos
const lastProbeAt = new Map(); // id → último momento de prueba
const VALIDATION_BATCH = 3;
const VALIDATION_PAUSE_MS = 250;
const VALIDATION_TTL_MS = 300000; // 5 min de TTL para no bombardear orígenes

async function validarTodosLosStreams() {
    if (validacionEnCurso) return;
    validacionEnCurso = true;

    try {
        const streams = await obtenerStreamsDb();
        let dirty = false;

        console.log(`[Validación] Comprobando ${streams.length} canales (lotes de ${VALIDATION_BATCH})...`);

        for (let i = 0; i < streams.length; i += VALIDATION_BATCH) {
            const batch = streams.slice(i, i + VALIDATION_BATCH);

            await Promise.all(batch.map(async (s) => {
                if (s.tipo === 'iframe') {
                    if (s.estado !== 'online') { s.estado = 'online'; dirty = true; }
                    failCounts.delete(s.id);
                    lastProbeAt.set(s.id, Date.now());
                    return;
                }

                if (!s.estado) { s.estado = 'online'; dirty = true; }

                const now = Date.now();
                const lastProbe = lastProbeAt.get(s.id) || 0;
                if (now - lastProbe < VALIDATION_TTL_MS && s.estado === 'online') {
                    return;
                }

                const res = await testUrl(s.url, 6000, 1, s.id);
                lastProbeAt.set(s.id, now);

                if (res.status === 'OK') {
                    failCounts.delete(s.id);
                    if (s.estado !== 'online') { s.estado = 'online'; dirty = true; }
                } else {
                    const fails = (failCounts.get(s.id) || 0) + 1;
                    failCounts.set(s.id, fails);

                    if (fails >= 3 && s.estado !== 'offline') {
                        s.estado = 'offline';
                        dirty = true;
                        console.log(`[Validación] 🔴 "${s.nombre}" offline tras ${fails} fallos`);
                    }
                }
            }));

            if (dirty) {
                // ya no se guarda en batch a file
                emitStreamsUpdate(streams);
                dirty = false;
            }

            await new Promise(r => setTimeout(r, VALIDATION_PAUSE_MS));
        }

        console.log('[Validación] Comprobación terminada.');
    } catch (err) {
        console.error('[Validación] Error:', err);
    }

    validacionEnCurso = false;
    // Desactivado para evitar lentitud y bombardeo a los orígenes
    // setTimeout(validarTodosLosStreams, 600000);
}
const io     = new Server(server, { cors: { origin: '*' } });


// ─────────────────────────────────────────────
// CONFIGURACIÓN TURSO DB (LibSQL)
// ─────────────────────────────────────────────
const dbUrl = process.env.TURSO_DATABASE_URL || 'libsql://iptv-db-aminejilal.aws-eu-west-1.turso.io';
const dbToken = process.env.TURSO_AUTH_TOKEN || '';

const db = dbToken 
    ? createClient({ url: dbUrl, authToken: dbToken })
    : createClient({ url: 'file:local.db' });

async function initDb() {
    try {
        await db.execute(`
            CREATE TABLE IF NOT EXISTS channel_cache (
                id TEXT PRIMARY KEY,
                nombre TEXT,
                categoria TEXT,
                logo TEXT,
                stream_url TEXT,
                tipo TEXT,
                headers TEXT,
                estado TEXT,
                favorito INTEGER DEFAULT 0,
                updated_at INTEGER
            )
        `);
    } catch (e) {
        console.error("🔥 Error crítico inicializando Turso DB. Revisa tus credenciales (TURSO_DATABASE_URL y TURSO_AUTH_TOKEN).", e.message);
    }
}
initDb();

async function obtenerStreamsDb() {
    try {
        const res = await db.execute("SELECT * FROM channel_cache");
        return res.rows.map(r => ({
            ...r,
            favorito: r.favorito === 1
        }));
    } catch (e) {
        console.error("Error al obtener streams de Turso:", e.message);
        return [];
    }
}

function emitStreamsUpdate(streams) {
    io.emit('actualizar_streams', streams);
}
async function marcarStreamOffline(url) {
    if (!url) return;
    try {
        const target = parseStreamUrl(url).cleanUrl;
        const streams = await obtenerStreamsDb();
        const stream = streams.find(s => parseStreamUrl(s.url).cleanUrl === target);
        if (!stream) return;

        const fails = (failCounts.get(stream.id) || 0) + 1;
        failCounts.set(stream.id, fails);
        if (fails < 2) return; // requiere 2 fallos de proxy antes de marcar offline

        if (stream.estado !== 'offline') {
            stream.estado = 'offline';
            // ya no se guarda en batch a file
            emitStreamsUpdate(streams);
            console.log(`[Proxy] 🔴 "${stream.nombre}" marcado offline.`);
        }
    } catch (_) { /* ignorar */ }
}// ─────────────────────────────────────────────
// ENDPOINT: SYNC METADATA LISTS
// ─────────────────────────────────────────────
async function syncAllLists() {
    let total = 0;
    try {
        const insertQuery = `
            INSERT INTO channel_cache (id, nombre, categoria, logo, tipo, stream_url, updated_at) 
            VALUES (?, ?, ?, ?, 'hls', NULL, 0)
            ON CONFLICT(id) DO UPDATE SET 
                nombre = excluded.nombre,
                logo = excluded.logo,
                categoria = excluded.categoria
        `;

        await db.execute("DELETE FROM channel_cache WHERE tipo = 'youtube' OR stream_url LIKE '%youtube%' OR stream_url LIKE '%youtu.be%'");

        // 1. TDT España
        try {
            const r = await safeFetch('https://www.tdtspain.com/canales/canalesv4.json', {}, 10000);
            if (r.ok) {
                const data = await r.json();
                for (const c of data.canales || []) {
                    if (c.url && (c.url.includes('youtube') || c.url.includes('youtu.be'))) continue; 
                    const id = 'tdt_' + c.id;
                    await db.execute(insertQuery, [id, c.name || c.nombre, 'España', c.logo]);
                    total++;
                }
            }
        } catch(e){ console.error('[Sync] Error en TDT España:', e.message); }

        // 2. Iberoamericana
        try {
            const r = await safeFetch('http://127.0.0.1:8090/api/channels', {}, 10000);
            if (r.ok) {
                const data = await r.json();
                // FIX: Soporte para APIs que devuelven un Array directo
                const canalesIbero = Array.isArray(data) ? data : (data.channels || []);
                for (const c of canalesIbero) {
                    if (c.stream_type === 'youtube') continue;
                    const id = 'ibero_' + c.id;
                    await db.execute(insertQuery, [id, c.name, 'Deportes', c.logo]);
                    total++;
                }
            }
        } catch(e){ console.error('[Sync] Error en Iberoamericana:', e.message); }

        // 3. Arabic
        try {
            const r = await safeFetch('http://127.0.0.1:9080/api/channels?limit=500', {}, 10000);
            if (r.ok) {
                const data = await r.json();
                for (const c of data.channels || []) {
                    if (c.stream_type === 'youtube') continue;
                    const id = 'arabic_' + c.id;
                    const cat = 'Mundo Árabe - ' + (c.country_name || 'General');
                    await db.execute(insertQuery, [id, c.name, cat, c.logo]);
                    total++;
                }
            }
        } catch(e){ console.error('[Sync] Error en Arabic:', e.message); }

        // 4. Yacine TV API (Todos los 317 canales dinámicos en la categoría BeIN Sports)
        try {
            const rCat = await safeFetch('http://127.0.0.1:8000/categories', {}, 15000);
            if (rCat.ok) {
                const cats = await rCat.json();
                for (const cat of cats.data || []) {
                    const rCh = await safeFetch(`http://127.0.0.1:8000/categories/${cat.id}/channels`, {}, 15000);
                    if (rCh.ok) {
                        const chData = await rCh.json();
                        for (const c of chData.data || []) {
                            const id = 'bein_' + c.id;
                            await db.execute(insertQuery, [id, c.name, 'BeIN Sports', c.logo || '']);
                            total++;
                        }
                    }
                }
            }
        } catch(e){ console.error('[Sync] Error en Yacine API:', e.message); }

        io.emit('actualizar_streams', await obtenerStreamsDb());
    } catch(e) {
        console.error('Error sincronizando listas:', e);
    }
    return total;
}

let isSyncingLists = false;

app.get('/api/sync-lists', async (req, res) => {
    if (isSyncingLists) return res.json({ success: false, message: 'Sincronización ya en curso.' });
    isSyncingLists = true;
    try {
        const total = await syncAllLists();
        res.json({ success: true, count: total });
    } finally {
        isSyncingLists = false;
    }
});

app.get('/api/streams', async (req, res) => {
    try {
        let streams = await obtenerStreamsDb();
        if (streams.length === 0 && !isSyncingLists) {
            console.log('[API] DB vacía, sincronizando listas...');
            isSyncingLists = true;
            await syncAllLists();
            isSyncingLists = false;
            streams = await obtenerStreamsDb();
        }
        res.json(streams);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────
// Archivos estáticos y API REST
// ─────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));


app.patch('/api/streams/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, categoria } = req.body;
        
        let query = "UPDATE channel_cache SET ";
        const args = [];
        if (nombre) { query += "nombre = ?, "; args.push(nombre); }
        if (categoria) { query += "categoria = ?, "; args.push(categoria); }
        query = query.slice(0, -2) + " WHERE id = ?";
        args.push(id);
        
        await db.execute(query, args);
        io.emit('actualizar_streams', await obtenerStreamsDb());
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/update-stream', async (req, res) => {
    try {
        const { id, url } = req.body;
        if (!id || !url) return res.status(400).json({ error: 'Faltan datos' });

        await db.execute(
            "UPDATE channel_cache SET stream_url = ?, estado = 'online', updated_at = ? WHERE id = ?",
            [url, Date.now(), id]
        );
        
        io.emit('actualizar_streams', await obtenerStreamsDb());
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ─────────────────────────────────────────────
// Arranque
// ── Inicialización de Directorios y Servidor ──

async function initDirectories() {
    const directorios = [path.join(__dirname, 'public')];
    for (const dir of directorios) {
        try { await fs.mkdir(dir, { recursive: true }); } catch (e) {}
    }
}

async function startServer() {
    await initDirectories();
    const PORT = process.env.PORT || 3000;
    
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`⚠️ Puerto ${PORT} ocupado. Reintentando escuchar en 3 segundos...`);
            setTimeout(() => {
                server.close();
                server.listen(PORT, '0.0.0.0');
            }, 3000);
        } else {
            console.error('🔥 Error en el servidor HTTP:', e);
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🟢 Servidor IPTV corriendo en http://localhost:${PORT}`);
        console.log(`📡 Acceso en red local: http://192.168.0.17:${PORT}\n`);
    });
}

startServer();

// ─────────────────────────────────────────────
// API PLAY — GET /api/play/:channelId
// Lee la URL guardada en streams.json (pre-resuelta en el refresco).
// NO hace peticiones externas en tiempo real. Igual que Yacine e Ibero.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// API PLAY — GET /api/play/:channelId
// ─────────────────────────────────────────────
app.get('/api/play/:channelId', async (req, res) => {
    let id = req.params.channelId;
    if (id.endsWith('.m3u8')) id = id.slice(0, -5);

    console.log(`\n▶️ [PLAY] Solicitud para ID: ${id}`);

    try {
        const result = await db.execute("SELECT * FROM channel_cache WHERE id = ?", [id]);
        let stream = result.rows[0];

        if (!stream) {
            return res.status(404).json({ error: 'Canal no encontrado en BD.' });
        }

        const ahora = Date.now();
        const ttl = 3600000; // 1 hora de caché para todos los canales, sin hardcodear
        let finalStreamUrl = stream.stream_url;
        let headersList = stream.headers;
        let finalTipo = stream.tipo || 'hls';
        let fetchError = null;

        if (!finalStreamUrl || finalStreamUrl === 'null' || finalStreamUrl === 'undefined' || (typeof finalStreamUrl === 'string' && !finalStreamUrl.startsWith('http'))) {
            finalStreamUrl = null;
        }

        if (!finalStreamUrl || ahora - (stream.updated_at || 0) > ttl) {
            console.log(`🔄 [Cache-Aside] Resolviendo m3u8...`);
            let nuevaUrl = null;
            let nuevosHeaders = null;
            
            const bases = ['http://127.0.0.1', 'http://localhost'];
            let r = null;

            try {


                if (id.startsWith('tdt_')) {
                    const rawPureId = id.replace('tdt_', '');
                    for (const base of bases) {
                        try { 
                            r = await safeFetch(`${base}:8080/api/stream/${rawPureId}`); 
                            if (r && r.ok) break; 
                            else console.error(`⚠️ [España API] Status ${r ? r.status : 'null'} para ${rawPureId} en ${base}:8080`);
                        } catch(e){ 
                            fetchError = e; 
                            console.error(`🔥 [España API Error] ${base}:8080 para ${rawPureId} -> ${e.message}`);
                        }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.m3u8_url || d.stream_url || d.hls_url || d.mpd_url || d.url || d.raw_url || d.web_url || null;
                        nuevosHeaders = d.headers_required || d.headers || null;
                        if (nuevosHeaders && typeof nuevosHeaders === 'object') nuevosHeaders = JSON.stringify(nuevosHeaders);
                    }
                } else if (id.startsWith('ibero_')) {
                    const pureId = id.replace('ibero_', '');
                    for (const base of bases) {
                        try { r = await safeFetch(`${base}:8090/api/channels/${pureId}`, {}, 30000); if (r && r.ok) break; } catch(e){ fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.m3u8_url || d.stream_url || d.url || null;
                        let iberoHeaders = d.headers || {};
                        if (d.referer_required) iberoHeaders['Referer'] = d.referer_required;
                        if (Object.keys(iberoHeaders).length > 0) nuevosHeaders = JSON.stringify(iberoHeaders);
                    }
                } else if (id.startsWith('bein_')) {
                    const pureId = id.replace('bein_', '');
                    for (const base of bases) {
                        try { r = await safeFetch(`${base}:8000/channel/${pureId}`, {}, 30000); if (r && r.ok) break; } catch(e){ fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        if (d.data && d.data[0] && d.data[0].url) {
                            nuevaUrl = d.data[0].url;
                            if (d.data[0].headers) nuevosHeaders = JSON.stringify(d.data[0].headers);
                        }
                    }
                } else if (id.startsWith('arabic_')) {
                    const pureId = id.replace('arabic_', '');
                    for (const base of bases) {
                        // FIX: Evitar que la API Árabe devuelva un 307 Redirect (rompe el JSON.parse) usando ?redirect=false
                        try { r = await safeFetch(`${base}:9080/api/channels/${pureId}/stream?redirect=false`, {}, 30000); if (r && r.ok) break; } catch(e){ fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.stream_url || d.url || null;
                        if (!nuevaUrl && d.embed_url) {
                            nuevaUrl = d.embed_url;
                            finalTipo = 'iframe';
                        }
                        if (d.headers) nuevosHeaders = JSON.stringify(d.headers);
                    }
                }

                if (nuevaUrl && nuevaUrl !== 'null') {
                    finalStreamUrl = nuevaUrl;
                    headersList = nuevosHeaders || '';
                    await db.execute(
                        "UPDATE channel_cache SET stream_url = ?, headers = ?, updated_at = ?, tipo = ? WHERE id = ?",
                        [finalStreamUrl, headersList, ahora, finalTipo, id]
                    );
                    console.log(`✅ [Cache] Guardado OK.`);
                } else {
                    console.error(`⚠️ [API PLAY] No se obtuvo nueva URL, usando la caché anterior si existe.`);
                    // fallback to database stream URL if API fails, so we don't wipe it out!
                    finalStreamUrl = stream.stream_url; 
                }
            } catch (fetchErr) {
                console.error(`⚠️ [API PLAY] Error de fetch global: ${fetchErr.message}`);
                finalStreamUrl = stream.stream_url;
            }
        }

        if (!finalStreamUrl) {
            return res.status(422).json({ 
                error: 'La API externa no devolvió enlace.', 
                channelId: id,
                fetchError: fetchError ? fetchError.message : 'Unknown'
            });
        }

        let ref = '', ori = '', ua = 'Mozilla/5.0';
        if (headersList) {
            try {
                const hdrs = JSON.parse(headersList);
                ref = hdrs['Referer'] || '';
                ori = hdrs['Origin'] || '';
                ua = hdrs['User-Agent'] || hdrs['user-agent'] || ua;
            } catch(e) {
                if (typeof headersList === 'string' && headersList.includes('=')) {
                     const parts = headersList.split('|');
                     parts.forEach(p => {
                         if (p.startsWith('Referer=')) ref = decodeURIComponent(p.split('=')[1]);
                         if (p.startsWith('User-Agent=')) ua = decodeURIComponent(p.split('=')[1]);
                     });
                }
            }
        }

        let finalStreamUrlWithHeaders = finalStreamUrl;
        if (ref) finalStreamUrlWithHeaders += `|Referer=${ref}`;
        if (ori) finalStreamUrlWithHeaders += `|Origin=${ori}`;
        if (ua && ua !== 'Mozilla/5.0') finalStreamUrlWithHeaders += `|User-Agent=${ua}`;

        const isDirect = finalTipo === 'iframe';
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
        const proxyUrl = isDirect ? null : (`${proto}://` + (req.headers.host || '127.0.0.1:' + (process.env.PORT || 3000)) + '/proxy-video?url=' + encodeURIComponent(finalStreamUrlWithHeaders));

        return res.json({ success: true, streamUrl: finalStreamUrl, proxyUrl: proxyUrl, tipo: finalTipo, referer: ref, origin: ori, userAgent: ua });
    } catch (err) {
        console.error('🔥 [API PLAY ERROR]', err);
        return res.status(500).json({ error: 'Error interno de BD.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PROXY VIDEO — Manejo de Chunks y CORS
// ─────────────────────────────────────────────
app.all('/proxy-video', (req, res) => {
    // FIX: Habilitar preflight OPTIONS para peticiones de byte-range de HLS.js
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
    if (req.method === 'OPTIONS') return res.sendStatus(200);

    const rawTargetUrl = req.query.url;
    if (!rawTargetUrl) return res.status(400).send('URL requerida.');

    let adaptedTarget = rawTargetUrl;
    if (adaptedTarget.includes('192.168.') || adaptedTarget.includes('localhost')) {
        adaptedTarget = adaptedTarget.replace(/https?:\/\/(192\.168\.\d+\.\d+|localhost)/, 'http://127.0.0.1');
    }

    const { cleanUrl, referer, origin: originFromUrl, userAgent } = parseStreamUrl(adaptedTarget);
    if (!cleanUrl || !cleanUrl.startsWith('http')) return res.status(400).send('URL inválida.');

    let parsed;
    try { parsed = new URL(cleanUrl); } catch { return res.status(400).send('URL inválida.'); }

    const lib = parsed.protocol === 'https:' ? https : http_mod;
    const requestHeaders = { 'User-Agent': userAgent || UA, 'Accept': '*/*', 'Accept-Language': 'es-ES,es;q=0.9', 'Connection': 'keep-alive' };
    if (referer) requestHeaders.Referer = referer;
    let origin = originFromUrl || '';
    if (!origin && referer) { try { origin = new URL(referer).origin; } catch { origin = ''; } }
    if (!origin) origin = `${parsed.protocol}//${parsed.host}`;
    if (origin) requestHeaders.Origin = origin;

    const withMetadata = (absoluteUrl) => {
        const metadata = [];
        if (referer) metadata.push(`Referer=${encodeURIComponent(referer)}`);
        if (origin) metadata.push(`Origin=${encodeURIComponent(origin)}`);
        if (userAgent) metadata.push(`User-Agent=${encodeURIComponent(userAgent)}`);
        return metadata.length ? `${absoluteUrl}|${metadata.join('|')}` : absoluteUrl;
    };

    const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: requestHeaders,
        rejectUnauthorized: false // FIX: Ignorar certificados SSL caducados de CDNs
    };

    const proxyReq = lib.request(options, (proxyRes) => {
        if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const newUrl = proxyRes.headers.location.startsWith('http') ? proxyRes.headers.location : `${parsed.protocol}//${parsed.host}${proxyRes.headers.location}`;
            return res.redirect(`/proxy-video?url=${encodeURIComponent(withMetadata(newUrl))}`);
        }

        const headers = { ...proxyRes.headers };
        delete headers['x-frame-options']; delete headers['content-security-policy']; delete headers['x-content-type-options'];
        headers['access-control-allow-origin'] = '*';

        // FIX: Detección estricta para no confundir .ts con .m3u8
        const isM3U8 = parsed.pathname.toLowerCase().endsWith('.m3u8') || (headers['content-type'] && headers['content-type'].includes('mpegurl'));

        if (isM3U8) {
            delete headers['content-length'];
            res.writeHead(proxyRes.statusCode, headers);

            let chunks = [];
            let totalSize = 0;
            const MAX_PLAYLIST_SIZE = 10 * 1024 * 1024; // 10MB limit para evitar OOM

            proxyRes.on('data', chunk => {
                totalSize += chunk.length;
                if (totalSize > MAX_PLAYLIST_SIZE) {
                    proxyReq.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            
            proxyRes.on('end', () => {
                if (totalSize > MAX_PLAYLIST_SIZE) return res.end(); // Abortado por seguridad
                const body = Buffer.concat(chunks).toString('utf-8');
                
                const rewritten = body.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const absoluteUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, cleanUrl).href;
                        // Forzamos que TODO pase por el proxy para inyectar cabeceras y evitar bloqueos CORS
                        return buildProxyUrlFromRequest(req, withMetadata(absoluteUrl));
                    } else if (trimmed.startsWith('#EXT-X-STREAM-INF:') || trimmed.startsWith('#EXT-X-MEDIA:')) {
                        return line.replace(/URI="([^"]+)"/g, (match, p1) => {
                            const absoluteUri = p1.startsWith('http') ? p1 : new URL(p1, cleanUrl).href;
                            return `URI="${buildProxyUrlFromRequest(req, withMetadata(absoluteUri))}"`;
                        });
                    }
                    return line;
                }).join('\n');
                res.end(rewritten);
            });
        } else {
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res, { end: true });
        }
    });

    proxyReq.on('error', (err) => {
        if (!res.headersSent) res.status(502).send('Error del proxy: ' + err.message);
    });
    
    // FIX CRÍTICO: Fuga de Conexiones. Si el cliente cierra el vídeo, matamos la descarga remota.
    req.on('close', () => {
        proxyReq.destroy();
    });

    proxyReq.end();
});

app.get(['/play/:channelId', '/play/:channelId.m3u8'], async (req, res) => {
    const channelId = req.params.channelId.endsWith('.m3u8') ? req.params.channelId.slice(0, -5) : req.params.channelId;
    try {
        const streams = await obtenerStreamsDb();
        const stream = streams.find(s => s.id === channelId || s.nombre.toLowerCase().replace(/ /g, '_') === channelId.toLowerCase());
        if (!stream) return res.status(404).send('Canal no encontrado.');
        if (!stream.stream_url) return res.status(404).send('Sin URL HLS resuelta para este canal. Ábrelo primero en la web.');
        
        let finalUrl = stream.stream_url;
        
        // Acoplar cabeceras si existen en la BD
        if (stream.headers && stream.headers !== 'null') {
            try {
                const hdrs = JSON.parse(stream.headers);
                if (hdrs['Referer']) finalUrl += `|Referer=${hdrs['Referer']}`;
                if (hdrs['Origin']) finalUrl += `|Origin=${hdrs['Origin']}`;
                if (hdrs['User-Agent'] || hdrs['user-agent']) finalUrl += `|User-Agent=${hdrs['User-Agent'] || hdrs['user-agent']}`;
            } catch(e) {}
        }

        const target = encodeURIComponent(finalUrl);
        return res.redirect(302, `/proxy-video?url=${target}`);
    } catch (e) {
        return res.status(500).send('Error al devolver la reproducción: ' + e.message);
    }
});

// Eliminado proxy interno HLS para liberar Termux (Zero-Latency)

io.on('connection', async (socket) => {
    const clientIp = socket.handshake.address;
    console.log(`[+] Cliente conectado: ${socket.id} (IP: ${clientIp})`);

    socket.on('solicitar_streams', async () => {
        socket.emit('actualizar_streams', await obtenerStreamsDb());
    });

    socket.emit('actualizar_streams', await obtenerStreamsDb());

    // ── Añadir stream .m3u8 manualmente ─────
    socket.on('nuevo_stream', async ({ nombre, url }) => {
        if (!nombre || !url) return;
        try {
            const id = Date.now().toString();
            await db.execute(
                "INSERT INTO channel_cache (id, nombre, stream_url, tipo, estado, categoria, updated_at) VALUES (?, ?, ?, 'hls', 'online', 'General', ?)",
                [id, nombre, url, Date.now()]
            );
            io.emit('actualizar_streams', await obtenerStreamsDb());
        } catch(e){}
    });

    // ── Borrar Todos los Canales ───────────────────────────────────────
    socket.on('borrar_todos', async () => {
        try {
            await db.execute("DELETE FROM channel_cache");
            io.emit('actualizar_streams', []);
        } catch(e){}
    });

    // ── Marcar / Desmarcar Favorito ──────────────────────────────────
    socket.on('toggle_favorito', async (id) => {
        try {
            const str = await db.execute("SELECT favorito FROM channel_cache WHERE id = ?", [id]);
            if (str.rows[0]) {
                const nuevo = str.rows[0].favorito === 1 ? 0 : 1;
                await db.execute("UPDATE channel_cache SET favorito = ? WHERE id = ?", [nuevo, id]);
                io.emit('actualizar_streams', await obtenerStreamsDb());
            }
        } catch(e) {}
    });

    socket.on('disconnect', () => {
        console.log(`[-] Desconectado: ${socket.id}`);
    });
});

// ─────────────────────────────────────────────
// Arranque
// ── Inicialización de Directorios y Servidor ──

async function initDirectories() {
    const directorios = [path.join(__dirname, 'public')];
    for (const dir of directorios) {
        try { await fs.mkdir(dir, { recursive: true }); } catch (e) {}
    }
}

async function startServer() {
    await initDirectories();
    const PORT = process.env.PORT || 3000;
    
    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.error(`⚠️ Puerto ${PORT} ocupado. Reintentando escuchar en 3 segundos...`);
            setTimeout(() => {
                server.close();
                server.listen(PORT, '0.0.0.0');
            }, 3000);
        } else {
            console.error('🔥 Error en el servidor HTTP:', e);
        }
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\n🟢 Servidor IPTV corriendo en http://localhost:${PORT}`);
        console.log(`📡 Acceso en red local: http://192.168.0.17:${PORT}\n`);
    });
}

startServer();
