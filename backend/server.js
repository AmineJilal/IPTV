const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs').promises;
const { createClient } = require('@libsql/client');
const https      = require('https');
const http_mod   = require('http');
const { URL }    = require('url');
const crypto     = require('crypto');

// TODO: Rellenar con claves de producción en el servidor real.
const ADMIN_KEY = Buffer.alloc(16);
const ADMIN_IV  = Buffer.alloc(16);

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

// ── Comprobar si un HLS responde (con reintentos, sin marcar offline a la primera) ──
async function testUrl(urlStr, timeoutMs = 6000, retries = 2) {
    const { cleanUrl, referer, origin, userAgent } = parseStreamUrl(urlStr);
    let lastError = 'desconocido';

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

            // HEAD primero (ligero); si falla, GET parcial
            let res = await fetch(cleanUrl, {
                method: 'HEAD',
                headers: buildBrowserHeaders(referer, origin || null, userAgent || null),
                signal: controller.signal,
                redirect: 'follow',
            });

            if (!res.ok || res.status === 405 || res.status === 501) {
                res = await fetch(cleanUrl, {
                    method: 'GET',
                    headers: buildBrowserHeaders(referer, origin || null, userAgent || null),
                    signal: controller.signal,
                    redirect: 'follow',
                });
            }

            clearTimeout(timeoutId);

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
const io     = new Server(server, { cors: { origin: '*' } });


// ─────────────────────────────────────────────
// CONFIGURACIÓN TURSO DB (LibSQL)
// ─────────────────────────────────────────────
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'libsql://iptv-db-aminejilal.aws-eu-west-1.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

async function initDb() {
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
}
initDb();

async function obtenerStreamsDb() {
    const res = await db.execute("SELECT * FROM channel_cache");
    return res.rows.map(r => ({
        ...r,
        favorito: r.favorito === 1
    }));
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
}

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
app.get('/api/play/:channelId', async (req, res) => {
    let idOrName = req.params.channelId;
    if (idOrName.endsWith('.m3u8')) idOrName = idOrName.slice(0, -5);

    try {
        const streams = await obtenerStreamsDb();
        const stream = streams.find(s => s.id === idOrName || s.nombre.toLowerCase().replace(/ /g, '_') === idOrName.toLowerCase());

        if (!stream) return res.status(404).json({ error: 'Canal no encontrado.' });
        if (stream.tipo === 'iframe') return res.status(400).json({ error: 'Canal iframe, no HLS.' });

        const { cleanUrl, referer, origin: originFromUrl, userAgent } = parseStreamUrl(stream.url);
        if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
            return res.status(422).json({ error: `URL inválida para "${stream.nombre}". Refresca los canales.` });
        }

        let origin = originFromUrl || null;
        if (!origin && referer) {
            try { origin = new URL(referer).origin; } catch { origin = null; }
        }

        const finalProxyUrl = buildProxyUrlFromRequest(req, stream.url);
        let finalStreamUrl = cleanUrl;
        
        if (cleanUrl.includes('127.0.0.1') || cleanUrl.includes('localhost') || cleanUrl.includes('192.168.')) {
            finalStreamUrl = finalProxyUrl;
        }

        return res.json({
            success: true,
            streamUrl: finalStreamUrl,
            proxyUrl: finalProxyUrl,
            referer: referer || null,
            origin: origin || null,
            userAgent: userAgent || UA,
        });
    } catch (err) {
        console.error('[/api/play] Error:', err.message);
        return res.status(500).json({ error: 'Error interno.' });
    }
});
