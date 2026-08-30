require('dotenv').config();
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { }
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const { createClient } = require('@libsql/client');
const https = require('https');
const http_mod = require('http');
const { URL } = require('url');

// 1. Manejo Global de Errores para evitar caídas fatales del backend
process.on('uncaughtException', (err) => {
    console.error('🔥 Error Crítico no capturado (Node sigue vivo):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Promesa rota no manejada:', reason);
});

// Extractor eliminado del servidor principal (Se ejecuta en pc_worker.js)

const app = express();
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
    const sources = d3.sourcesLive || d3.sources || d3.sourcesStartOver || [];
    let m3u8 = null;

    for (const s of sources) {
        if (!s.src || (s.type && s.type.toLowerCase().includes('dash')) || s.src.toLowerCase().includes('.mpd')) continue;

        if (s.type?.toLowerCase().includes('mpegurl') || s.type?.toLowerCase().includes('hls') || s.src.toLowerCase().includes('.m3u8')) {
            if (s.src.includes('atres-live.atresmedia.com')) {
                m3u8 = s.src;
                break;
            } else if (!m3u8) {
                m3u8 = s.src; // fallback
            }
        }
    }

    if (!m3u8 && sources.length > 0) {
        for (const s of sources) {
            if (s.src && !(s.type && s.type.toLowerCase().includes('dash')) && !s.src.toLowerCase().includes('.mpd')) {
                m3u8 = s.src;
                break;
            }
        }
    }

    if (!m3u8) throw new Error(`[Atres Step 3] No HLS m3u8 source found`);
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
        body: JSON.stringify({ appName: 'web//mediasetplay-web/1.2.1-d1b2024', client_id: crypto.randomUUID() })
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

    // Devolver el stream_manifest /dai.m3u8 directo
    let masterUrl = raw;

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

                const res = await testUrl(s.url, 6000, 1);
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
const io = new Server(server, { cors: { origin: '*' } });


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
                provider TEXT,
                stream_url TEXT,
                tipo TEXT,
                headers TEXT,
                estado TEXT,
                favorito INTEGER DEFAULT 0,
                updated_at INTEGER
            )
        `);
        try {
            await db.execute("ALTER TABLE channel_cache ADD COLUMN provider TEXT");
        } catch (_) {}
        // Tabla de claves de acceso para autenticación JWT
        await db.execute(`
            CREATE TABLE IF NOT EXISTS auth_keys (
                key TEXT PRIMARY KEY,
                label TEXT,
                device_id TEXT,
                jwt_token TEXT,
                created_at INTEGER,
                last_login INTEGER,
                active INTEGER DEFAULT 1
            )
        `);
    } catch (e) {
        console.error("🔥 Error crítico inicializando Turso DB. Revisa tus credenciales (TURSO_DATABASE_URL y TURSO_AUTH_TOKEN).", e.message);
    }
}
initDb();

// ─────────────────────────────────────────────
// AUTENTICACIÓN JWT — Sesión de Dispositivo Único
// ─────────────────────────────────────────────
const crypto = require('crypto');

// Clave secreta para firmar JWT (generada una vez, o usa variable de entorno)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY_HOURS = 720; // 30 días

function createJwt(payload) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({
        ...payload,
        iat: now,
        exp: now + JWT_EXPIRY_HOURS * 3600
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [header, body, signature] = parts;
        const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
        if (signature !== expected) return null;
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) return null;
        return payload;
    } catch (_) { return null; }
}

// Generar clave de acceso aleatoria formato KTV-xxxx-xxxx-xxxx
function generateAccessKey() {
    const seg = () => crypto.randomBytes(2).toString('hex');
    return `KTV-${seg()}-${seg()}-${seg()}`;
}

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kovalsky_admin_2026';

// Mapa de sockets autenticados por clave (para force_logout)
const authenticatedSockets = new Map(); // key -> socket.id

// POST /api/auth/generate-key — Solo admin
app.post('/api/auth/generate-key', async (req, res) => {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== ADMIN_SECRET) return res.status(403).json({ error: 'Acceso denegado.' });

    const label = req.body?.label || 'usuario';
    const key = generateAccessKey();

    try {
        await db.execute(
            "INSERT INTO auth_keys (key, label, created_at, active) VALUES (?, ?, ?, 1)",
            [key, label, Date.now()]
        );
        console.log(`🔑 [Auth] Nueva clave generada: ${key} para "${label}"`);
        return res.json({ key, label });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// POST /api/auth/login — Login con clave + deviceId
app.post('/api/auth/login', async (req, res) => {
    const { key, deviceId } = req.body || {};
    if (!key || !deviceId) return res.status(400).json({ error: 'key y deviceId requeridos.' });

    const cleanKey = key.trim();
    const isAdminKey = cleanKey.toLowerCase() === 'admin';

    try {
        let result;
        if (isAdminKey) {
            result = await db.execute("SELECT * FROM auth_keys WHERE LOWER(key) = 'admin'");
            if (!result.rows || result.rows.length === 0) {
                await db.execute(
                    "INSERT INTO auth_keys (key, label, created_at, active) VALUES ('admin', 'Administrador', ?, 1)",
                    [Date.now()]
                );
                result = await db.execute("SELECT * FROM auth_keys WHERE LOWER(key) = 'admin'");
            }
        } else {
            result = await db.execute("SELECT * FROM auth_keys WHERE key = ?", [cleanKey]);
        }

        const row = result.rows[0];
        if (!row) return res.status(401).json({ error: 'Clave de acceso inválida.' });
        if (!row.active) return res.status(403).json({ error: 'Clave desactivada.' });

        const oldDeviceId = row.device_id;
        const token = createJwt({ key: row.key, label: row.label, deviceId });

        // Actualizar device_id y token en la BD
        await db.execute(
            "UPDATE auth_keys SET device_id = ?, jwt_token = ?, last_login = ? WHERE key = ?",
            [deviceId, token, Date.now(), row.key]
        );

        // Si había otro dispositivo conectado, enviar force_logout
        if (oldDeviceId && oldDeviceId !== deviceId) {
            const oldSocketId = authenticatedSockets.get(row.key);
            if (oldSocketId) {
                const oldSocket = io.sockets.sockets.get(oldSocketId);
                if (oldSocket) {
                    oldSocket.emit('force_logout', { reason: 'Sesión transferida a otro dispositivo.' });
                    console.log(`🔒 [Auth] force_logout enviado al dispositivo anterior de "${row.label}"`);
                }
            }
        }

        console.log(`🔑 [Auth] Login OK: "${row.label}" en dispositivo ${deviceId.substring(0, 20)}`);
        return res.json({ token, label: row.label, deviceId });
    } catch (e) {
        console.error(`🔥 [Auth] Error en login:`, e.message);
        return res.status(500).json({ error: 'Error interno.' });
    }
});

// POST /api/auth/logout
app.post('/api/auth/logout', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'No autorizado.' });
    const token = auth.replace('Bearer ', '');
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: 'Token inválido.' });

    try {
        await db.execute(
            "UPDATE auth_keys SET device_id = NULL, jwt_token = NULL WHERE key = ?",
            [payload.key]
        );
        authenticatedSockets.delete(payload.key);
        console.log(`🔑 [Auth] Logout: "${payload.label}"`);
        return res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// GET /api/auth/validate — Verifica que el token sigue activo para este dispositivo
app.get('/api/auth/validate', async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'No autorizado.' });
    const token = auth.replace('Bearer ', '');
    const payload = verifyJwt(token);
    if (!payload) return res.status(401).json({ error: 'Token expirado o inválido.' });

    try {
        const result = await db.execute("SELECT device_id, active FROM auth_keys WHERE key = ?", [payload.key]);
        const row = result.rows[0];
        if (!row || !row.active) return res.status(403).json({ error: 'Clave desactivada.' });
        // Verificar que el device_id coincide (sesión no fue robada)
        if (row.device_id && row.device_id !== payload.deviceId) {
            return res.status(401).json({ error: 'Sesión transferida a otro dispositivo.' });
        }
        return res.json({ valid: true, label: payload.label });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

async function obtenerStreamsDb() {
    try {
        const res = await db.execute(`
            SELECT * FROM channel_cache 
            ORDER BY 
                CASE 
                    WHEN provider = 'yacine' THEN 0 
                    WHEN categoria = 'BeIN Sports' THEN 1 
                    WHEN provider = 'movistar' THEN 2 
                    WHEN provider = 'tdt' THEN 3 
                    ELSE 4 
                END, 
                id ASC
        `);
        return res.rows.map(r => ({
            ...r,
            favorito: r.favorito === 1 || r.favorito === true || r.favorito === '1'
        })).filter(r => {
            const nameLower = (r.nombre || '').toLowerCase();
            return !nameLower.includes('18+') && !nameLower.includes('+18') && !nameLower.includes('adult') && !nameLower.includes('xxx') && !nameLower.includes('erotic');
        });
    } catch (e) {
        console.error("Error al obtener streams de Turso:", e.message);
        return [];
    }
}

app.patch('/api/streams/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nombre, categoria, favorito } = req.body;

        let query = "UPDATE channel_cache SET ";
        const args = [];
        if (nombre !== undefined) { query += "nombre = ?, "; args.push(nombre); }
        if (categoria !== undefined) { query += "categoria = ?, "; args.push(categoria); }
        if (favorito !== undefined) { query += "favorito = ?, "; args.push(favorito ? 1 : 0); }
        if (args.length === 0) return res.json({ success: true });
        
        query = query.slice(0, -2) + " WHERE id = ?";
        args.push(id);

        await db.execute(query, args);
        io.emit('actualizar_streams', await obtenerStreamsDb());
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
            INSERT INTO channel_cache (id, nombre, categoria, logo, provider, tipo, stream_url, updated_at) 
            VALUES (?, ?, ?, ?, ?, 'hls', NULL, 0)
            ON CONFLICT(id) DO UPDATE SET 
                nombre = excluded.nombre,
                logo = excluded.logo,
                categoria = excluded.categoria,
                provider = excluded.provider
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
                    await db.execute(insertQuery, [id, c.name || c.nombre, 'España', c.logo, 'tdt']);
                    total++;
                }
            }
        } catch (e) { console.error('[Sync] Error en TDT España:', e.message); }

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
                    await db.execute(insertQuery, [id, c.name, 'Deportes', c.logo, 'ibero']);
                    total++;
                }
            }
        } catch (e) { console.error('[Sync] Error en Iberoamericana:', e.message); }

        // 3. Arabic
        try {
            const r = await safeFetch('http://127.0.0.1:9080/api/channels?limit=500', {}, 10000);
            if (r.ok) {
                const data = await r.json();
                for (const c of data.channels || []) {
                    if (c.stream_type === 'youtube') continue;
                    const id = 'arabic_' + c.id;
                    const cat = 'Mundo Árabe - ' + (c.country_name || 'General');
                    await db.execute(insertQuery, [id, c.name, cat, c.logo, 'arabic']);
                    total++;
                }
            }
        } catch (e) { console.error('[Sync] Error en Arabic:', e.message); }

        // 4. Yacine TV API (Todos los canales organizados en sus categorías reales de Yacine TV con provider='yacine')
        let yacineSuccess = false;
        try {
            const rCat = await safeFetch('http://127.0.0.1:8000/categories', {}, 15000);
            if (rCat.ok) {
                const cats = await rCat.json();
                for (const cat of cats.data || []) {
                    const rawCatName = (cat.name || 'Yacine TV').trim();
                    let categoryName = rawCatName;
                    if (rawCatName.toLowerCase().includes('bein sports')) {
                        categoryName = 'BeIN Sports';
                    }
                    
                    const rCh = await safeFetch(`http://127.0.0.1:8000/categories/${cat.id}/channels`, {}, 15000);
                    if (rCh.ok) {
                        const chData = await rCh.json();
                        for (const c of chData.data || []) {
                            const id = 'yacine_' + c.id;
                            await db.execute(insertQuery, [id, c.name, categoryName, c.logo || '', 'yacine']);
                            total++;
                            yacineSuccess = true;
                        }
                    }
                }
            }
        } catch (e) { console.error('[Sync] Error en Yacine API:', e.message); }

        // Fallback: Semilla fija garantizada de los 40 canales de Yacine TV BeIN Sports
        if (!yacineSuccess) {
            const yacineSeed = [
                { id: 'yacine_1424', name: 'beIN SPORTS 1', logo: '' },
                { id: 'yacine_1425', name: 'beIN SPORTS 2', logo: '' },
                { id: 'yacine_1426', name: 'beIN SPORTS 3', logo: '' },
                { id: 'yacine_1427', name: 'beIN SPORTS 4', logo: '' },
                { id: 'yacine_1428', name: 'beIN SPORTS 5', logo: '' },
                { id: 'yacine_1429', name: 'beIN SPORTS 6', logo: '' },
                { id: 'yacine_1430', name: 'beIN SPORTS 7', logo: '' },
                { id: 'yacine_1431', name: 'beIN SPORTS 8', logo: '' },
                { id: 'yacine_1432', name: 'beIN SPORTS 9', logo: '' },
                { id: 'yacine_1421', name: 'beIN XTRA 1', logo: '' },
                { id: 'yacine_1422', name: 'beIN XTRA 2', logo: '' },
                { id: 'yacine_1423', name: 'beIN XTRA 3', logo: '' },
                { id: 'yacine_1433', name: 'beIN France 1', logo: '' },
                { id: 'yacine_1434', name: 'beIN France 2', logo: '' },
                { id: 'yacine_1435', name: 'beIN France 3', logo: '' },
                { id: 'yacine_1436', name: 'beIN News', logo: '' },
                { id: 'yacine_1437', name: 'beIN SPORTS', logo: '' },
                { id: 'yacine_1481', name: 'beIN English 1', logo: '' },
                { id: 'yacine_1482', name: 'beIN English 2', logo: '' },
                { id: 'yacine_1483', name: 'beIN English 3', logo: '' },
                { id: 'yacine_4', name: 'beIN SPORTS 1 720p', logo: '' },
                { id: 'yacine_5', name: 'beIN SPORTS 2 720p', logo: '' },
                { id: 'yacine_6', name: 'beIN SPORTS 3 720p', logo: '' },
                { id: 'yacine_7', name: 'beIN SPORTS 4 720p', logo: '' },
                { id: 'yacine_8', name: 'beIN SPORTS 5 720p', logo: '' },
                { id: 'yacine_9', name: 'beIN SPORTS 6 720p', logo: '' },
                { id: 'yacine_10', name: 'beIN SPORTS 7 720p', logo: '' },
                { id: 'yacine_11', name: 'beIN SPORTS 8 720p', logo: '' },
                { id: 'yacine_12', name: 'beIN SPORTS 9 720p', logo: '' },
                { id: 'yacine_1', name: 'beIN XTRA 1 720p', logo: '' },
                { id: 'yacine_2', name: 'beIN XTRA 2 720p', logo: '' },
                { id: 'yacine_3', name: 'beIN XTRA 3 720p', logo: '' },
                { id: 'yacine_13', name: 'beIN France 1 720p', logo: '' },
                { id: 'yacine_14', name: 'beIN France 2 720p', logo: '' },
                { id: 'yacine_15', name: 'beIN France 3 720p', logo: '' },
                { id: 'yacine_16', name: 'beIN News 720p', logo: '' },
                { id: 'yacine_17', name: 'beIN SPORTS 720p', logo: '' },
                { id: 'yacine_18', name: 'beIN English 1 720p', logo: '' },
                { id: 'yacine_19', name: 'beIN English 2 720p', logo: '' },
                { id: 'yacine_20', name: 'beIN English 3 720p', logo: '' }
            ];
            for (const ch of yacineSeed) {
                await db.execute(insertQuery, [ch.id, ch.name, 'BeIN Sports', ch.logo, 'yacine']);
                total++;
            }
        }

        // 5. Movistar+ & Xameleon API (Puerto 8070)
        try {
            const r = await safeFetch('http://127.0.0.1:8070/api/v1/channels', {}, 15000);
            if (r.ok) {
                const canalesMovistar = await r.json();
                for (const c of canalesMovistar || []) {
                    const nameLower = (c.name || '').toLowerCase();
                    if (nameLower.includes('18+') || nameLower.includes('+18') || nameLower.includes('adult') || nameLower.includes('xxx') || nameLower.includes('erotic')) continue;
                    const id = c.id.startsWith('xameleon_') ? c.id : ('movistar_' + c.id);
                    const provider = c.id.startsWith('xameleon_') ? 'xameleon' : 'movistar';
                    const cat = (provider === 'xameleon') ? 'Xameleon TV' : 'Movistar & Deportes';
                    await db.execute(insertQuery, [id, c.name, cat, c.logo || '', provider]);
                    total++;
                }
            }
        } catch (e) { console.error('[Sync] Error en Movistar API:', e.message); }

        // Limpieza estricta de categorías por proveedor en DB
        try {
            await db.execute("UPDATE channel_cache SET categoria = 'Movistar & Deportes' WHERE provider = 'movistar'");
            await db.execute("UPDATE channel_cache SET categoria = 'Xameleon TV' WHERE provider = 'xameleon'");
            await db.execute("DELETE FROM channel_cache WHERE categoria = 'BeIN Sports' AND provider != 'yacine'");
            await db.execute("DELETE FROM channel_cache WHERE LOWER(nombre) LIKE '%18+%' OR LOWER(nombre) LIKE '%+18%' OR LOWER(nombre) LIKE '%adult%' OR LOWER(nombre) LIKE '%xxx%' OR LOWER(nombre) LIKE '%erotic%'");
        } catch (e) {}

        io.emit('actualizar_streams', await obtenerStreamsDb());
    } catch (e) {
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
    } catch (e) {
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
        const { nombre, categoria, favorito } = req.body;

        let query = "UPDATE channel_cache SET ";
        const args = [];
        if (nombre) { query += "nombre = ?, "; args.push(nombre); }
        if (categoria) { query += "categoria = ?, "; args.push(categoria); }
        if (favorito !== undefined) { query += "favorito = ?, "; args.push(favorito ? 1 : 0); }

        if (args.length === 0) return res.json({ success: true, message: 'Sin cambios.' });

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
        try { await fs.mkdir(dir, { recursive: true }); } catch (e) { }
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
            stream = { id: id, stream_url: null, headers: null, updated_at: 0, tipo: 'hls' };
        }

        const ahora = Date.now();
        const isTokenizedStream = (id.toLowerCase().includes('telecinco') || id.toLowerCase().includes('cuatro') || id.toLowerCase().includes('fdf') || id.toLowerCase().includes('energy') || id.toLowerCase().includes('divinity') || id.toLowerCase().includes('bemad') || id.toLowerCase().includes('boing') || (stream.stream_url && stream.stream_url.includes('hdnea=')));
        const ttl = isTokenizedStream ? 240000 : 3600000; // 4 minutos de TTL para Mediaset (token hdnea dura 5 min)
        let finalStreamUrl = stream.stream_url;
        let headersList = stream.headers;
        let finalTipo = stream.tipo || 'hls';
        let fetchError = null;

        if (!finalStreamUrl || finalStreamUrl === 'null' || finalStreamUrl === 'undefined' || (typeof finalStreamUrl === 'string' && !finalStreamUrl.startsWith('http'))) {
            finalStreamUrl = null;
        }

        // Si la caché guarda una URL web de atresplayer en lugar del M3U8, la descartamos
        if (finalStreamUrl && finalStreamUrl.includes('atresplayer.com/directos/')) {
            console.log(`⚠️ [Cache] Descartando URL HTML de Atresmedia en caché: ${finalStreamUrl}`);
            finalStreamUrl = null;
        }

        if (!finalStreamUrl || ahora - (stream.updated_at || 0) > ttl || req.query.refresh) {
            console.log(`🔄 [Cache-Aside] Resolviendo m3u8...`);
            let nuevaUrl = null;
            let nuevosHeaders = null;

            const bases = ['http://127.0.0.1', 'http://localhost'];
            let r = null;

            try {


                let providerName = stream.provider;
                if (!providerName) {
                    if (id.startsWith('tdt_')) providerName = 'tdt';
                    else if (id.startsWith('ibero_')) providerName = 'ibero';
                    else if (id.startsWith('bein_') || id.startsWith('yacine_')) providerName = 'yacine';
                    else if (id.startsWith('arabic_')) providerName = 'arabic';
                    else if (id.startsWith('movistar_')) providerName = 'movistar';
                    else if (id.startsWith('xameleon_')) providerName = 'xameleon';
                }

                if (providerName === 'tdt' || id.startsWith('tdt_')) {
                    const rawPureId = id.replace(/^tdt_/, '');
                    let responseBodyText = '';
                    for (const base of bases) {
                        const targetUrl = `${base}:8080/api/stream/${rawPureId}`;
                        console.log(`[DEBUG] Solicitando API Externa: ${targetUrl} (channelId original: ${id})`);
                        try {
                            r = await safeFetch(targetUrl, {}, 25000);
                            if (r) {
                                responseBodyText = await r.text();
                                console.log(`[DEBUG] HTTP Status de API Externa: ${r.status}`);
                                console.log(`[DEBUG] Response Body crudo: ${responseBodyText}`);
                                break;
                            }
                        } catch (e) {
                            fetchError = e;
                            console.error(`🔥 [España API Error] ${base}:8080 para ${rawPureId} -> ${e.message}`);
                        }
                    }
                    if (r) {
                        let d = null;
                        try { d = JSON.parse(responseBodyText); } catch (_) {}

                        if (!r.ok || (d && d.error)) {
                            console.error(`❌ [Node] API Externa devolvió error (HTTP ${r.status}):`, d || responseBodyText);
                            const errStatus = (d && d.status && d.status >= 400 && d.status < 600) ? d.status : (r.status >= 400 ? r.status : 502);
                            return res.status(errStatus).json({
                                success: false,
                                channelId: id,
                                provider: (d && d.provider) || 'atresmedia',
                                stage: (d && d.stage) || 'sources',
                                error: (d && (d.message || d.error)) || `API Externa devolvió status HTTP ${r.status}`
                            });
                        }

                        if (d) {
                            console.log(`[DEBUG] JSON Parseado OK. keys: ${Object.keys(d)}`);
                            console.log(`[DEBUG] Extractor/Type: ${d.type || d.provider || 'desconocido'}`);
                            let extractedUrl = d.m3u8_url || d.stream_url || d.hls_url || d.mpd_url || d.url || null;
                            if (extractedUrl && typeof extractedUrl === 'string' && extractedUrl.includes('atresplayer.com/directos/')) {
                                console.error(`❌ [Node] Se descartó URL HTML de Atresplayer: ${extractedUrl}`);
                                extractedUrl = null;
                            }
                            nuevaUrl = extractedUrl;
                            nuevosHeaders = d.headers_required || d.headers || null;
                            console.log(`[DEBUG] URL extraída: ${nuevaUrl}`);
                            if (nuevosHeaders && typeof nuevosHeaders === 'object') nuevosHeaders = JSON.stringify(nuevosHeaders);
                        }
                    }
                } else if (providerName === 'ibero' || id.startsWith('ibero_')) {
                    const pureId = id.replace(/^ibero_/, '');
                    for (const base of bases) {
                        try { r = await safeFetch(`${base}:8090/api/channels/${pureId}`, {}, 30000); if (r && r.ok) break; } catch (e) { fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.m3u8_url || d.stream_url || d.url || null;
                        let iberoHeaders = d.headers || {};
                        if (d.referer_required) iberoHeaders['Referer'] = d.referer_required;
                        if (Object.keys(iberoHeaders).length > 0) nuevosHeaders = JSON.stringify(iberoHeaders);
                    }
                } else if (providerName === 'yacine' || id.startsWith('bein_') || id.startsWith('yacine_')) {
                    const pureId = id.replace(/^yacine_/, '').replace(/^bein_/, '');
                    for (const base of bases) {
                        try { r = await safeFetch(`${base}:8000/channel/${pureId}`, {}, 30000); if (r && r.ok) break; } catch (e) { fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        if (d.data && d.data[0] && d.data[0].url) {
                            nuevaUrl = d.data[0].url;
                            if (d.data[0].headers) nuevosHeaders = JSON.stringify(d.data[0].headers);
                        }
                    }
                } else if (providerName === 'arabic' || id.startsWith('arabic_')) {
                    const pureId = id.replace(/^arabic_/, '');
                    for (const base of bases) {
                        try { r = await safeFetch(`${base}:9080/api/channels/${pureId}/stream?redirect=false`, {}, 30000); if (r && r.ok) break; } catch (e) { fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        const rawUrl = d.stream_url || d.url || null;
                        // Solo aceptar URLs HLS reales, no embed_url ni URLs de YouTube
                        if (rawUrl && rawUrl.startsWith('http') && !rawUrl.includes('youtube') && !rawUrl.includes('youtu.be')) {
                            nuevaUrl = rawUrl;
                        }
                        if (d.headers) nuevosHeaders = JSON.stringify(d.headers);
                    }
                } else if (providerName === 'movistar' || providerName === 'xameleon' || id.startsWith('movistar_') || id.startsWith('xameleon_')) {
                    const chId = id.replace(/^movistar_/, '');
                    for (const base of bases) {
                        try {
                            r = await safeFetch(`${base}:8070/api/v1/channel/${encodeURIComponent(chId)}/m3u8`, {}, 25000);
                            if (r && r.ok) break;
                        } catch (e) { fetchError = e; }
                    }
                    if (r && r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.proxy_stream_url || d.stream_url || null;
                    }
                }

                if (nuevaUrl && nuevaUrl !== 'null') {
                    finalStreamUrl = nuevaUrl;
                    headersList = nuevosHeaders || '';
                    await db.execute(
                        "INSERT INTO channel_cache (id, stream_url, headers, updated_at, tipo) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET stream_url=excluded.stream_url, headers=excluded.headers, updated_at=excluded.updated_at, tipo=excluded.tipo",
                        [id, finalStreamUrl, headersList, ahora, finalTipo]
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
                ref = hdrs['Referer'] || hdrs['referer'] || '';
                ori = hdrs['Origin'] || hdrs['origin'] || '';
                ua = hdrs['User-Agent'] || hdrs['user-agent'] || ua;
            } catch (e) {}
        }

        // hlsUrl: para canales Mediaset (/hls-m3u8) o Movistar/Xameleon (proxy-stream).
        // El navegador (hls.js) usa hlsUrl sin pasar por /proxy-video.
        const isMediaset = finalStreamUrl && (
            finalStreamUrl.includes('mediasetinfinity') ||
            finalStreamUrl.includes('dai.m3u8')
        );
        const isMovistarXameleon = id.startsWith('movistar_') || id.startsWith('xameleon_') || (finalStreamUrl && finalStreamUrl.includes('/proxy-stream'));

        let hlsUrl = isMediaset
            ? `${req.protocol}://${req.get('host')}/hls-m3u8?url=${encodeURIComponent(finalStreamUrl)}`
            : (isMovistarXameleon ? finalStreamUrl : null);

        // ── Reescribir 127.0.0.1:8070 con el Host/IP real del cliente para acceso en Móvil / Smart TV / Render ──
        const clientHost = req.get('host') || '127.0.0.1:3000';
        const clientProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const publicPrefix = `${clientProto}://${clientHost}`;

        if (finalStreamUrl && (finalStreamUrl.includes('127.0.0.1:8070') || finalStreamUrl.includes('localhost:8070'))) {
            finalStreamUrl = finalStreamUrl.replace(/http:\/\/(127\.0\.0\.1|localhost):8070/, publicPrefix);
        }

        if (hlsUrl && (hlsUrl.includes('127.0.0.1:8070') || hlsUrl.includes('localhost:8070'))) {
            hlsUrl = hlsUrl.replace(/http:\/\/(127\.0\.0\.1|localhost):8070/, publicPrefix);
        }

        return res.json({ 
            success: true, 
            streamUrl: finalStreamUrl, 
            hlsUrl: hlsUrl,
            tipo: finalTipo, 
            headers: {
                'Referer': ref,
                'Origin': ori,
                'User-Agent': ua
            },
            referer: ref, 
            origin: ori, 
            userAgent: ua 
        });
    } catch (err) {
        console.error('🔥 [API PLAY ERROR]', err);
        return res.status(500).json({ error: 'Error interno de BD.', details: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────
// PROXY EFICIENTE DE MANIFESTS HLS — Solo texto (~2KB por request)
// Filosofía: el servidor solo mueve MANIFESTS (M3U8), nunca segmentos de vídeo.
//   - /hls-m3u8?url=<encoded>&sid=<session> → proxea y reescribe el manifest
//   - /hls-seg?url=<encoded>&sid=<session>  → 302 redirect directo al CDN
//                                              (0 bytes de vídeo por el servidor)
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// PROXY TRANSPARENTE HACIA MICROSERVICIO PYTHON MOVISTAR / XAMELEON (puerto 8070)
// Permite que móviles, TV Box y Smart TVs accedan a través del puerto 3000 o Render sin depender de loopback 127.0.0.1:8070.
// ─────────────────────────────────────────────────────────────────────────
app.use(['/api/v1/xameleon', '/api/v1/channel'], async (req, res) => {
    try {
        const fullPath = req.baseUrl + req.url;
        const targetUrl = `http://127.0.0.1:8070${fullPath}`;
        
        const clientHost = req.get('host') || '127.0.0.1:3000';
        const clientProto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        
        const reqHeaders = { 
            ...req.headers,
            'x-forwarded-host': clientHost,
            'x-forwarded-proto': clientProto,
            'host': clientHost
        };

        const response = await fetch(targetUrl, {
            method: req.method,
            headers: reqHeaders,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        });

        const contentType = response.headers.get('content-type') || '';
        const isManifestOrText = contentType.includes('mpegurl') || 
                                 contentType.includes('text') || 
                                 contentType.includes('json') || 
                                 req.url.includes('proxy-stream') || 
                                 req.url.includes('proxy-sub');

        if (isManifestOrText) {
            let text = await response.text();
            const publicPrefix = `${clientProto}://${clientHost}`;
            text = text.replace(/http:\/\/(127\.0\.0\.1|localhost):8070/g, publicPrefix);
            
            res.status(response.status);
            response.headers.forEach((val, key) => {
                if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                    res.setHeader(key, val);
                }
            });
            return res.send(text);
        }

        res.status(response.status);
        response.headers.forEach((val, key) => {
            if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
                res.setHeader(key, val);
            }
        });

        if (response.body) {
            const reader = response.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
        }
        res.end();
    } catch (err) {
        console.error('🔥 [Proxy Movistar/Xameleon Error]', err.message);
        res.status(502).json({ error: 'Error conectando con microservicio Movistar/Xameleon (8070).' });
    }
});

// Cookiejar por sesión: { sid → { host → { name → value } } }
// TTL máximo 5 min (duración del token hdntl de Akamai)
const hlsSessions = new Map();
const HLS_SESSION_TTL = 5 * 60 * 1000;

function hlsGetCookieHeader(sid) {
    const session = hlsSessions.get(sid);
    if (!session || !session.cookies) return '';
    return [...session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function hlsSetCookiesFromResponse(sid, setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let session = hlsSessions.get(sid);
    if (!session) { session = { cookies: new Map(), ts: Date.now() }; hlsSessions.set(sid, session); }
    for (const c of list) {
        const nv = c.split(';')[0].trim();
        const eqIdx = nv.indexOf('=');
        if (eqIdx > 0) session.cookies.set(nv.slice(0, eqIdx), nv.slice(eqIdx + 1));
    }
    session.ts = Date.now();
}

// Limpieza periódica de sesiones expiradas (cada 5 min)
setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of hlsSessions) if (now - s.ts > HLS_SESSION_TTL) hlsSessions.delete(sid);
}, HLS_SESSION_TTL);

function getHlsUpstreamHeaders(targetUrl, sid) {
    let host = '';
    try { host = new URL(targetUrl).hostname; } catch (_) {}
    const isMediaset = host.includes('mediaset');
    const isAtres = host.includes('atresmedia') || host.includes('atresplayer');
    const isMbc = host.includes('edgenextcdn') || host.includes('shahid') || targetUrl.includes('mbc');

    let referer = 'https://www.mediasetinfinity.es/';
    let origin = 'https://www.mediasetinfinity.es';

    if (isAtres) {
        referer = 'https://www.atresplayer.com/';
        origin = 'https://www.atresplayer.com';
    } else if (isMbc) {
        referer = 'https://shahid.mbc.net/';
        origin = 'https://shahid.mbc.net';
    }

    const headers = {
        'User-Agent': UA,
        'Accept': '*/*',
        'Referer': referer,
        'Origin': origin,
    };
    if (isMediaset) {
        const cookies = hlsGetCookieHeader(sid);
        if (cookies) headers['Cookie'] = cookies;
    }
    return headers;
}

function rewriteHlsManifest(text, targetUrl, sid) {
    const encoded = sid ? `&sid=${encodeURIComponent(sid)}` : '';
    return text.split(/\r?\n/).map(line => {
        const t = line.trim();
        if (!t) return line;

        if (t.startsWith('#')) {
            // Reescribir URI="..." dentro de etiquetas (#EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP)
            if (t.includes('URI="')) {
                return line.replace(/URI="([^"]+)"/g, (_, p1) => {
                    try {
                        const abs = new URL(p1, targetUrl).href;
                        const isManifest = /\.m3u8(\?|$)/i.test(abs) || abs.includes('manifest');
                        const ep = `/hls-${isManifest ? 'm3u8' : 'seg'}?url=${encodeURIComponent(abs)}${encoded}`;
                        return `URI="${ep}"`;
                    } catch (_) { return `URI="${p1}"`; }
                });
            }
            return line;
        }

        // Línea de URL (variante o segmento)
        try {
            const abs = new URL(t, targetUrl).href;
            const isManifest = /\.m3u8(\?|$)/i.test(abs) || abs.includes('manifest');
            return `/hls-${isManifest ? 'm3u8' : 'seg'}?url=${encodeURIComponent(abs)}${encoded}`;
        } catch (_) { return line; }
    }).join('\n');
}

// ── /hls-m3u8 — Solo proxea manifiestos (texto, ~2–15 KB) ────────────────
app.get('/hls-m3u8', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).send('URL requerida.');
    let targetUrl;
    try { targetUrl = decodeURIComponent(rawUrl); } catch (_) { return res.status(400).send('URL inválida.'); }
    if (!targetUrl.startsWith('http')) return res.status(400).send('URL inválida.');

    // Generar o reutilizar session id (lo manda el cliente como ?sid=)
    const sid = req.query.sid || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let host = '';
    try { host = new URL(targetUrl).hostname; } catch (_) {}

    const upstreamHeaders = getHlsUpstreamHeaders(targetUrl, sid);

    try {
        const response = await safeFetch(targetUrl, { method: 'GET', headers: upstreamHeaders, redirect: 'follow' }, 12000);

        // Capturar cookies de sesión (especialmente hdntl de Akamai)
        const sc = response.headers.get('set-cookie') || response.headers.raw?.()?.['set-cookie'];
        if (sc) hlsSetCookiesFromResponse(sid, sc);

        if (!response.ok) {
            console.error(`❌ [HLS-M3U8] HTTP ${response.status} ${targetUrl.substring(0, 80)}`);
            res.header('Access-Control-Allow-Origin', '*');
            return res.status(response.status).send(`Upstream HTTP ${response.status}`);
        }

        const text = await response.text();
        const rewritten = rewriteHlsManifest(text, targetUrl, sid);

        console.log(`📋 [HLS-M3U8] ${response.status} sid=${sid.slice(-6)} ${targetUrl.substring(0, 70)}`);

        res.header('Access-Control-Allow-Origin', '*');
        res.header('Content-Type', 'application/vnd.apple.mpegurl');
        res.header('X-HLS-Session', sid); // Devolver sid al cliente para usarlo en variantes/seg
        return res.status(200).send(rewritten);
    } catch (e) {
        console.error(`🔥 [HLS-M3U8] Error: ${e.message}`);
        res.header('Access-Control-Allow-Origin', '*');
        return res.status(502).send('Error de red: ' + e.message);
    }
});

// ── /hls-seg — Proxy de segmentos SOLO para el navegador web ───────────────
// Los navegadores no pueden falsificar Referer ni enviar la cookie hdntl 
// en un redirect 302 hacia un dominio de terceros. Por tanto, para el 
// reproductor web (Dashboard) debemos proxiar el segmento. 
// NOTA: Flutter (usuarios reales) no usa este endpoint; Flutter descarga
// directamente desde el CDN gracias a libmpv, salvando el ancho de banda.
app.get('/hls-seg', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).send('URL requerida.');
    let targetUrl;
    try { targetUrl = decodeURIComponent(rawUrl); } catch (_) { return res.status(400).send('URL inválida.'); }
    if (!targetUrl.startsWith('http')) return res.status(400).send('URL inválida.');

    const sid = req.query.sid;
    const upstreamHeaders = getHlsUpstreamHeaders(targetUrl, sid);

    try {
        const response = await fetch(targetUrl, {
            method: 'GET',
            headers: upstreamHeaders,
            redirect: 'follow'
        });

        if (!response.ok) {
            console.error(`❌ [HLS-SEG] HTTP ${response.status} ${targetUrl.substring(0, 80)}`);
            res.header('Access-Control-Allow-Origin', '*');
            return res.status(response.status).send(`Upstream HTTP ${response.status}`);
        }

        res.header('Access-Control-Allow-Origin', '*');
        res.header('Content-Type', response.headers.get('content-type') || 'video/MP2T');
        
        // Convertimos a arrayBuffer y mandamos el binario para evitar saturar RAM con strings
        const buffer = await response.arrayBuffer();
        return res.send(Buffer.from(buffer));
    } catch (e) {
        console.error(`🔥 [HLS-SEG] Error proxiando segmento: ${e.message}`);
        res.header('Access-Control-Allow-Origin', '*');
        return res.status(502).send('Error de red al obtener segmento');
    }
});

// ── /api/play/:channelId — Devuelve hlsUrl para usar con /hls-m3u8 ───────
// (El endpoint ya existe más arriba; esta función solo añade hlsUrl al JSON)

// ─────────────────────────────────────────────
// REDIRECT LIMPIO — Para canales no-Mediaset (sin proxy de vídeo)
// ─────────────────────────────────────────────
app.all('/proxy-video', (req, res) => {
    const rawTargetUrl = req.query.url;
    if (!rawTargetUrl) return res.status(400).send('URL requerida.');
    const { cleanUrl } = parseStreamUrl(rawTargetUrl);
    if (!cleanUrl || !cleanUrl.startsWith('http')) return res.status(400).send('URL inválida.');
    res.header('Access-Control-Allow-Origin', '*');
    return res.redirect(302, cleanUrl);
});

app.get(['/play/:channelId', '/play/:channelId.m3u8'], async (req, res) => {
    const channelId = req.params.channelId.endsWith('.m3u8') ? req.params.channelId.slice(0, -5) : req.params.channelId;
    try {
        const streams = await obtenerStreamsDb();
        const stream = streams.find(s => s.id === channelId || s.nombre.toLowerCase().replace(/ /g, '_') === channelId.toLowerCase());
        if (!stream || !stream.stream_url) return res.status(404).send('Canal no disponible.');

        const { cleanUrl } = parseStreamUrl(stream.stream_url);
        return res.redirect(302, cleanUrl);
    } catch (e) {
        return res.status(500).send('Error al resolver stream: ' + e.message);
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
        } catch (e) { }
    });

    // ── Borrar Todos los Canales ───────────────────────────────────────
    socket.on('borrar_todos', async () => {
        try {
            await db.execute("DELETE FROM channel_cache");
            io.emit('actualizar_streams', []);
        } catch (e) { }
    });

    // ── Marcar / Desmarcar Favorito ──────────────────────────────────
    socket.on('toggle_favorito', async (id) => {
        try {
            const str = await db.execute("SELECT favorito FROM channel_cache WHERE id = ?", [id]);
            if (str.rows[0]) {
                const raw = str.rows[0].favorito;
                const isFav = raw === 1 || raw === true || raw === '1';
                const nuevo = isFav ? 0 : 1;
                await db.execute("UPDATE channel_cache SET favorito = ? WHERE id = ?", [nuevo, id]);
                io.emit('actualizar_streams', await obtenerStreamsDb());
            }
        } catch (e) { }
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
        try { await fs.mkdir(dir, { recursive: true }); } catch (e) { }
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
