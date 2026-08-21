const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs').promises;
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
        const streams = await leerStreams();
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
                await guardarStreams(streams, { silent: true });
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

const STREAMS_FILE = path.join(__dirname, 'streams.json');

// ─────────────────────────────────────────────
// Persistencia con caché en RAM + escritura atómica
// ─────────────────────────────────────────────
let streamsCache = null;
let saveTimer = null;
// ─────────────────────────────────────────────
// Normalización Dinámica de Categorías (Single Source of Truth)
// ─────────────────────────────────────────────
function normalizeChannels(channels) {
    if (!Array.isArray(channels)) return channels;
    for (const c of channels) {
        const id = (c.id || '').toLowerCase();
        const nombre = (c.nombre || '').toLowerCase();
        
        if (id.startsWith('tdt_') || nombre.includes('la 1') || nombre.includes('antena 3')) {
            c.categoria = 'España';
        } else if (id.startsWith('ibero_')) {
            c.categoria = 'Deportes';
        } else if (nombre.includes('bein')) {
            c.categoria = 'BeIN Sports';
        } else if (id.startsWith('arabic_')) {
            c.categoria = c.categoria || 'Mundo Árabe';
        } else {
            c.categoria = c.categoria || 'Otros';
        }
    }
    return channels;
}

async function leerStreams(forceDisk = false) {
    if (streamsCache && !forceDisk) return streamsCache;
    try {
        streamsCache = JSON.parse(await fs.readFile(STREAMS_FILE, 'utf-8'));
    } catch {
        streamsCache = [];
    }
    return streamsCache;
}

async function guardarStreams(streams, opts = {}) {
    streams = normalizeChannels(streams);
    streamsCache = streams;
    if (saveTimer) clearTimeout(saveTimer);
    return new Promise((resolve) => {
        saveTimer = setTimeout(async () => {
            try {
                const tmp = STREAMS_FILE + '.tmp';
                await fs.writeFile(tmp, JSON.stringify(streams, null, 2), 'utf-8');
                await fs.rename(tmp, STREAMS_FILE);
            } catch (e) {
                console.error('[Persistencia] Error guardando streams:', e.message);
            }
            saveTimer = null;
            resolve();
        }, opts.immediate ? 0 : 250);
    });
}

function emitStreamsUpdate(streams) {
    io.emit('actualizar_streams', normalizeChannels(streams));
}

async function marcarStreamOffline(url) {
    if (!url) return;
    try {
        const target = parseStreamUrl(url).cleanUrl;
        const streams = await leerStreams();
        const stream = streams.find(s => parseStreamUrl(s.url).cleanUrl === target);
        if (!stream) return;

        const fails = (failCounts.get(stream.id) || 0) + 1;
        failCounts.set(stream.id, fails);
        if (fails < 2) return; // requiere 2 fallos de proxy antes de marcar offline

        if (stream.estado !== 'offline') {
            stream.estado = 'offline';
            await guardarStreams(streams);
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
        
        const streams = await leerStreams();
        const index = streams.findIndex(s => s.id === id);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Canal no encontrado' });
        }
        
        if (nombre) streams[index].nombre = nombre;
        streams[index].categoria = categoria || "General";
        
        await guardarStreams(streams);
        io.emit('actualizar_streams', streams);
        
        res.json({ success: true, stream: streams[index] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/update-stream', async (req, res) => {
    try {
        const { id, url } = req.body;
        if (!id || !url) return res.status(400).json({ error: 'Faltan datos' });

        const streams = await leerStreams();
        const index = streams.findIndex(s => s.id === id);
        
        if (index === -1) {
            return res.status(404).json({ error: 'Canal no encontrado' });
        }
        
        streams[index].url = url;
        streams[index].estado = 'online';
        
        await guardarStreams(streams);
        io.emit('actualizar_streams', streams);
        
        res.json({ success: true, stream: streams[index] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────
// PROXY INVERSO — /proxy-video?url=TARGET_URL
// ─────────────────────────────────────────────
app.get('/proxy-video', (req, res) => {
    const rawTargetUrl = req.query.url;

    if (!rawTargetUrl) {
        return res.status(400).send('Parámetro ?url= requerido.');
    }

    // Adaptación para Cloud (Koyeb/Render): Forzar IPs locales/antiguas al localhost del contenedor
    let adaptedTarget = rawTargetUrl;
    if (adaptedTarget.includes('192.168.') || adaptedTarget.includes('localhost')) {
        adaptedTarget = adaptedTarget.replace(/https?:\/\/(192\.168\.\d+\.\d+|localhost)/, 'http://127.0.0.1');
    }

    const { cleanUrl, referer, origin: originFromUrl, userAgent } = parseStreamUrl(adaptedTarget);
    if (!cleanUrl || !cleanUrl.startsWith('http')) {
        return res.status(400).send('URL inválida.');
    }

    let parsed;
    try { parsed = new URL(cleanUrl); }
    catch { return res.status(400).send('URL inválida.'); }

    const lib = parsed.protocol === 'https:' ? https : http_mod;
    const requestHeaders = {
        'User-Agent': userAgent || UA,
        'Accept': '*/*',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
    };
    if (referer) requestHeaders.Referer = referer;
    let origin = originFromUrl || '';
    if (!origin && referer) {
        try { origin = new URL(referer).origin; }
        catch { origin = ''; }
    }
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
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers: requestHeaders,
    };

    const proxyReq = lib.request(options, (proxyRes) => {
        if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const newUrl = proxyRes.headers.location.startsWith('http')
                ? proxyRes.headers.location
                : `${parsed.protocol}//${parsed.host}${proxyRes.headers.location}`;
            return res.redirect(`/proxy-video?url=${encodeURIComponent(withMetadata(newUrl))}`);
        }

        const headers = { ...proxyRes.headers };
        delete headers['x-frame-options'];
        delete headers['content-security-policy'];
        delete headers['content-security-policy-report-only'];
        delete headers['x-content-type-options'];
        headers['access-control-allow-origin'] = '*';
        Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

        const isM3U8 = cleanUrl.includes('.m3u8') || (headers['content-type'] && headers['content-type'].includes('mpegurl'));

        if (isM3U8) {
            delete headers['content-length'];
            res.writeHead(proxyRes.statusCode, headers);

            let body = '';
            proxyRes.on('data', chunk => body += chunk.toString('utf-8'));
            proxyRes.on('end', () => {
                const lines = body.split('\n');
                const rewritten = lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const absoluteUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, cleanUrl).href;
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
    proxyReq.end();
});

app.get(['/play/:channelId', '/play/:channelId.m3u8'], async (req, res) => {
    const channelId = req.params.channelId.endsWith('.m3u8') ? req.params.channelId.slice(0, -5) : req.params.channelId;
    try {
        const streams = await leerStreams();
        const stream = streams.find(s => s.id === channelId || s.nombre.toLowerCase().replace(/ /g, '_') === channelId.toLowerCase());
        if (!stream) return res.status(404).send('Canal no encontrado.');
        if (!stream.url) return res.status(404).send('Sin URL HLS para este canal.');
        const target = encodeURIComponent(stream.url);
        return res.redirect(302, `/proxy-video?url=${target}`);
    } catch (e) {
        return res.status(500).send('Error al devolver la reproducción: ' + e.message);
    }
});

// Eliminado proxy interno HLS para liberar Termux (Zero-Latency)

// ─────────────────────────────────────────────
// PROXY INTELIGENTE (Web Video Caster style)
// ─────────────────────────────────────────────
// GESTOR DE AUTO-RECUPERACIÓN CON BLOQUEOS
// ─────────────────────────────────────────────
// CEREBRO: AUTO-UPDATER DE CANALES ÁRABES E INTERNACIONALES (ARABIC API)
// ─────────────────────────────────────────────
let isRefreshingArabic = false;
let arabicTimer = null;

function resetArabicTimer() {
    if (arabicTimer) clearInterval(arabicTimer);
    arabicTimer = setInterval(() => {
        console.log('[Auto-Updater Arabic] Ejecutando refresco cíclico (1h) de canales Árabes...');
        runArabicRefresh();
    }, 3600000); // 1 Hora
}

// Arabic arranca con delay inicial de 5 minutos para dar tiempo a que todas las APIs Python levanten
setTimeout(() => resetArabicTimer(), 300000); 

async function runArabicRefresh() {
    if (isRefreshingArabic) return { success: false, message: 'Refresco en curso.' };
    isRefreshingArabic = true;

    try {
        console.log('[Auto-Updater Arabic] Iniciando sincronización via /api/channels/resolved (batch sin redirects)...');
        
        // IPs candidatas para la API Árabe (en orden de preferencia)
        const arabicApiBases = [
            'http://127.0.0.1:9080',
            'http://localhost:9080',
            'http://192.168.0.17:9080'
        ];

        let activeBase = null;
        let resolvedChannels = null;

        // Intentar conectar con cada IP hasta encontrar la API activa
        for (const base of arabicApiBases) {
            try {
                const res = await fetch(`${base}/api/channels/resolved?limit=500`, {
                    signal: AbortSignal.timeout(300000) // 5 minutos: la API resuelve ~350 canales en paralelo
                });
                if (res.ok) {
                    const json = await res.json();
                    resolvedChannels = json.channels || [];
                    activeBase = base;
                    console.log(`[Auto-Updater Arabic] Conectado a ${activeBase}. ${resolvedChannels.length} canales resueltos en una sola petición.`);
                    break;
                }
            } catch (err) {
                console.warn(`[Auto-Updater Arabic] No se pudo conectar a ${base}: ${err.message}`);
            }
        }

        if (!resolvedChannels || resolvedChannels.length === 0) {
            throw new Error('No se pudo contactar con la API Árabe en ninguna IP disponible.');
        }

        const categoryMap = {
            'Lebanon': 'Líbano', 'Palestine': 'Palestina', 'Syria': 'Siria',
            'Tunisia': 'Túnez', 'France': 'Francia', 'Germany': 'Alemania',
            'Italy': 'Italia', 'Spain': 'España', 'Morocco': 'Marruecos',
            'Algeria': 'Argelia', 'Egypt': 'Egipto', 'Qatar': 'Qatar',
            'Kuwait': 'Kuwait', 'Libya': 'Libia', 'United Arab Emirates': 'Emiratos',
            'Saudi Arabia': 'Arabia Saudí', 'Iran / Persia': 'Irán'
        };

        let newArabicStreams = [];

        // Procesar todos los canales ya resueltos (sin peticiones individuales, sin redirects 307)
        for (const ch of resolvedChannels) {
            if (!ch.id) continue;

            const countryName = ch.country_name || ch.country_slug || 'Desconocido';
            const translatedCountry = categoryMap[countryName] || countryName;
            const cat = `Árabe - ${translatedCountry}`;
            const internalId = `arabic_${ch.id}`;
            const channelName = ch.name || ch.id;

            let finalUrl = null;
            let tipo = 'hls';

            if (ch.stream_url) {
                tipo = 'hls';
                finalUrl = ch.stream_url;
            } else if (ch.embed_url) {
                if (ch.embed_url.includes('.m3u8')) {
                    tipo = 'hls';
                    finalUrl = ch.embed_url;
                } else {
                    tipo = 'iframe';
                    finalUrl = ch.embed_url;
                }
            }

            if (finalUrl) {
                newArabicStreams.push({
                    id: internalId,
                    nombre: channelName,
                    url: finalUrl,
                    estado: 'online',
                    tipo: tipo,
                    categoria: cat,
                    logo: ch.logo || null
                });
            }
        }

        // Almacenamiento Final (atómico, clientes ven la lista nueva de golpe)
        if (newArabicStreams.length > 0) {
            let currentStreams = await leerStreams();
            let finalStreams = currentStreams.filter(s => !(s.id || '').startsWith('arabic_'));
            finalStreams = finalStreams.concat(newArabicStreams);
            
            finalStreams = normalizeChannels(finalStreams);
            
            await guardarStreams(finalStreams);
            io.emit('actualizar_streams', finalStreams);
            resetArabicTimer();
            console.log(`[Auto-Updater Arabic] ¡Sincronización Completa! ${newArabicStreams.length} canales resueltos y guardados.`);
        }
        
        isRefreshingArabic = false;
        return { success: true, actualizados: newArabicStreams.length, message: `Actualizados ${newArabicStreams.length} canales Árabes nativos.` };
    } catch (e) {
        isRefreshingArabic = false;
        console.error('[Auto-Updater Arabic] Error fatal:', e);
        return { success: false, error: e.message };
    }
}

app.get('/api/refresh-arabic', async (req, res) => {
    const r = await runArabicRefresh();
    res.json(r);
});

// ─────────────────────────────────────────────
// SERVIDOR WEB
// ─────────────────────────────────────────────
// API INTELIGENTE (JSON) — GET /api/play/:channelId
// NOTA: El handler completo con soporte para tokens frescos de TDT España
// está registrado más abajo (después de startServer).
// Este bloque ha sido eliminado para evitar duplicados — Express usa el primero.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// PIPELINE AUTO-REPARACIÓN ZERO-LATENCY (JSON)
// GET /api/play-repair/:channelId
// ─────────────────────────────────────────────
app.get('/api/play-repair/:channelId', async (req, res) => {
    let idOrName = req.params.channelId;
    if (idOrName.endsWith('.m3u8')) idOrName = idOrName.slice(0, -5);

    try {
        const streams = await leerStreams();
        const stream = streams.find(s => s.id === idOrName || s.nombre.toLowerCase().replace(/ /g, '_') === idOrName.toLowerCase());

        if (!stream) return res.status(404).json({ error: 'Canal no encontrado.' });
        if (!stream.webOrigen) return res.status(400).json({ error: 'No hay webOrigen para refrescar este canal automáticamente.' });

        console.log(`[Auto-Reparación] Flutter solicitó reparación para "${stream.nombre}". Delegando a PC Worker...`);

        const result = await delegateToPCWorker('tarea_refrescar_macro', {
            url: stream.webOrigen,
            macroSteps: stream.macro || [],
            channelId: stream.id
        }, null);

        const { cleanUrl, referer, origin: originFromUrl, userAgent } = parseStreamUrl(result.streamUrl);
        if (!cleanUrl || !/^https?:\/\//i.test(cleanUrl)) {
            return res.status(422).json({
                error: `El sniffer devolvió una URL inválida para "${stream.nombre}".`,
            });
        }

        let origin = originFromUrl || null;
        if (!origin && referer) {
            try { origin = new URL(referer).origin; }
            catch { origin = null; }
        }
        const metadataUrl = [
            cleanUrl,
            referer ? `Referer=${encodeURIComponent(referer)}` : null,
            origin ? `Origin=${encodeURIComponent(origin)}` : null,
            userAgent ? `User-Agent=${encodeURIComponent(userAgent)}` : null,
        ].filter(Boolean).join('|');
        const proxyUrl = buildProxyUrlFromRequest(req, metadataUrl);

        let finalStreamUrl = cleanUrl;
        if (cleanUrl.includes('127.0.0.1') || cleanUrl.includes('localhost') || cleanUrl.includes('192.168.')) {
            finalStreamUrl = proxyUrl;
        }

        console.log(`[Auto-Reparación] ✅ PC retornó URL. Devolviendo JSON a Flutter.`);
        return res.json({
            success: true,
            streamUrl: finalStreamUrl,
            proxyUrl,
            referer: referer || null,
            origin: origin || null,
            userAgent: userAgent || UA,
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// EXTRACCIÓN Y REPRODUCCIÓN AL VUELO (On-Demand)
// GET /api/extract-and-play?url=https://www.cuatro.com/en-directo/
// ─────────────────────────────────────────────
app.get('/api/extract-and-play', async (req, res) => {
    const targetWebUrl = req.query.url;
    if (!targetWebUrl) {
        return res.status(400).json({ error: 'Debes proporcionar ?url= con la dirección de la página web.' });
    }

    try {
        console.log(`[Extracción al vuelo] Solicitud entrante para: ${targetWebUrl}`);
        
        // Ejecuta el bot inteligente en el Worker del PC
        const result = await delegateToPCWorker('tarea_extraer_bot', { url: targetWebUrl }, null);
        
        const { cleanUrl, referer } = parseStreamUrl(result.streamUrl);
        
        console.log(`[Extracción al vuelo] ¡Éxito! Devolviendo JSON...`);
        return res.json({ 
            success: true, 
            streamUrl: cleanUrl, 
            referer: referer || targetWebUrl 
        });

    } catch (err) {
        console.error('[Extracción al vuelo] Falló:', err);
        return res.status(500).json({ error: 'No se pudo extraer el enlace de la web: ' + err.message });
    }
});

// ─────────────────────────────────────────────
// INTEGRACIÓN CON YACINETV-API (Python)
// ─────────────────────────────────────────────
const BEIN_CHANNELS = [
    {"id": 1424, "name": "beIN SPORTS 1", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS1_DIGITAL_Mono.png"},
    {"id": 1425, "name": "beIN SPORTS 2", "logo": "https://assets.bein.com/mena/sites/4/2021/02/beIN_SPORTS2_DIGITAL_Mono.png"},
    {"id": 1426, "name": "beIN SPORTS 3", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS3_DIGITAL_Mono.png"},
    {"id": 1427, "name": "beIN SPORTS 4", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS4_DIGITAL_Mono.png"},
    {"id": 1428, "name": "beIN SPORTS 5", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS5_DIGITAL_Mono.png"},
    {"id": 1429, "name": "beIN SPORTS 6", "logo": "https://assets.bein.com/mena/sites/4/2021/02/beIN_SPORTS6_DIGITAL_Mono.png"},
    {"id": 1430, "name": "beIN SPORTS 7", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS7_DIGITAL_Mono.png"},
    {"id": 1431, "name": "beIN SPORTS 8", "logo": "https://assets.bein.com/mena/sites/4/2023/09/logos-_beINSPORTS8.png"},
    {"id": 1432, "name": "beIN SPORTS 9", "logo": "https://assets.bein.com/mena/sites/4/2023/09/logos-_beINSPORTS9.png"},
    {"id": 1421, "name": "beIN XTRA 1", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS_XTRA1_Digital_Mono.png"},
    {"id": 1422, "name": "beIN XTRA 2", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS_XTRA2_Digital_Mono.png"},
    {"id": 1423, "name": "beIN XTRA 3", "logo": "https://assets.bein.com/mena/sites/4/2023/09/logos-_beINSPORTSXTRA3.png"},
    {"id": 1433, "name": "beIN France 1", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS1_FRENCH_Digital_Mono.png"},
    {"id": 1434, "name": "beIN France 2", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS2_FRENCH_Digital_Mono.png"},
    {"id": 1435, "name": "beIN France 3", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS3_FRENCH_Digital_Mono.png"},
    {"id": 1436, "name": "beIN News", "logo": "https://assets.bein.com/mena/sites/4/2015/06/NEWS_DIGITAL_Mono.png"},
    {"id": 1437, "name": "beIN SPORTS", "logo": "https://assets.bein.com/mena/sites/4/2015/06/bein_SPORTS_FTA_DIGITAL_Mono.png"},
    {"id": 1481, "name": "beIN English 1", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS1_ENGLISH_Digital_Mono.png"},
    {"id": 1482, "name": "beIN English 2", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS2_ENGLISH_Digital_Mono.png"},
    {"id": 1483, "name": "beIN English 3", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS3_ENGLISH_Digital_Mono.png"}
];

const BEIN_CHANNELS_720 = [
    {"id": 4, "name": "beIN SPORTS 1 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS1_DIGITAL_Mono.png"},
    {"id": 5, "name": "beIN SPORTS 2 720p", "logo": "https://assets.bein.com/mena/sites/4/2021/02/beIN_SPORTS2_DIGITAL_Mono.png"},
    {"id": 6, "name": "beIN SPORTS 3 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS3_DIGITAL_Mono.png"},
    {"id": 7, "name": "beIN SPORTS 4 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS4_DIGITAL_Mono.png"},
    {"id": 8, "name": "beIN SPORTS 5 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS5_DIGITAL_Mono.png"},
    {"id": 9, "name": "beIN SPORTS 6 720p", "logo": "https://assets.bein.com/mena/sites/4/2021/02/beIN_SPORTS6_DIGITAL_Mono.png"},
    {"id": 10, "name": "beIN SPORTS 7 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS7_DIGITAL_Mono.png"},
    {"id": 11, "name": "beIN SPORTS 8 720p", "logo": "https://assets.bein.com/mena/sites/4/2023/09/logos-_beINSPORTS8.png"},
    {"id": 12, "name": "beIN SPORTS 9 720p", "logo": "https://assets.bein.com/mena/sites/4/2023/09/logos-_beINSPORTS9.png"},
    {"id": 1, "name": "beIN XTRA 1 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS_XTRA1_Digital_Mono.png"},
    {"id": 2, "name": "beIN XTRA 2 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS_XTRA2_Digital_Mono.png"},
    {"id": 3, "name": "beIN XTRA 3 720p", "logo": "https://assets.bein.com/mena/sites/4/2023/09/logos-_beINSPORTSXTRA3.png"},
    {"id": 13, "name": "beIN France 1 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS1_FRENCH_Digital_Mono.png"},
    {"id": 14, "name": "beIN France 2 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS2_FRENCH_Digital_Mono.png"},
    {"id": 15, "name": "beIN France 3 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS3_FRENCH_Digital_Mono.png"},
    {"id": 16, "name": "beIN News 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/NEWS_DIGITAL_Mono.png"},
    {"id": 17, "name": "beIN SPORTS 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/bein_SPORTS_FTA_DIGITAL_Mono.png"},
    {"id": 18, "name": "beIN English 1 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS1_ENGLISH_Digital_Mono.png"},
    {"id": 19, "name": "beIN English 2 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS2_ENGLISH_Digital_Mono.png"},
    {"id": 20, "name": "beIN English 3 720p", "logo": "https://assets.bein.com/mena/sites/4/2015/06/beIN_SPORTS3_ENGLISH_Digital_Mono.png"}
];

// ─────────────────────────────────────────────
// CEREBRO: AUTO-UPDATER DE CANALES BEIN
// ─────────────────────────────────────────────
let isRefreshingBein = false;
let beinTimer = null;

function resetBeinTimer() {
    if (beinTimer) clearInterval(beinTimer);
    beinTimer = setInterval(() => {
        console.log('[Auto-Updater] Ejecutando refresco cíclico (1h) de beIN...');
        runBeinRefresh();
    }, 3600000); // 1 Hora
}

// BeIN arranca con 15min de retraso para no coincidir con Arabic
setTimeout(() => resetBeinTimer(), 900000);

async function runBeinRefresh() {
    if (isRefreshingBein) {
        console.log('[Auto-Updater] Refresco cancelado: Ya hay un proceso de extracción en curso.');
        return { success: false, message: 'Refresco en curso. Por favor espera.' };
    }
    
    isRefreshingBein = true;
    try {
        const streams = await leerStreams();
        

        let actualizados = 0;
        const allChannels = [...BEIN_CHANNELS, ...BEIN_CHANNELS_720];

        // Backup de seguridad (copia profunda)
        const oldStreamsStr = JSON.stringify(streams);

        const yacineBases = [
            'http://127.0.0.1:8000',
            'http://localhost:8000',
            'http://192.168.0.17:8000'
        ];

        for (const channel of allChannels) {
            try {
                let response = null;
                for (const base of yacineBases) {
                    try {
                        const res = await fetch(`${base}/channel/${channel.id}`, { signal: AbortSignal.timeout(10000) });
                        if (res.ok) {
                            response = res;
                            break;
                        }
                    } catch(e) {}
                }
                if (!response) continue;
                
                const jsonResp = await response.json();
                
                // SAFETY CHECK: Validar estructura del JSON
                if (jsonResp && jsonResp.data && Array.isArray(jsonResp.data) && jsonResp.data.length > 0) {
                    const data = jsonResp.data[0];
                    if (data.url && data.url.includes('.m3u8')) {
                        let finalUrl = data.url;
                        const headers = [];
                        if (data.headers) {
                            if (data.headers['User-Agent']) headers.push(`User-Agent=${encodeURIComponent(data.headers['User-Agent'])}`);
                            if (data.headers['Referer']) headers.push(`Referer=${encodeURIComponent(data.headers['Referer'])}`);
                        }
                        if (headers.length > 0) {
                            finalUrl += '|' + headers.join('|');
                        }
                        
                        const existingIdx = streams.findIndex(s => s.id === `bein_${channel.id}`);
                        if (existingIdx !== -1) {
                            streams[existingIdx].url = finalUrl;
                            streams[existingIdx].estado = 'online';
                            streams[existingIdx].logo = channel.logo; 
                        } else {
                            streams.push({
                                id: `bein_${channel.id}`,
                                nombre: channel.name,
                                url: finalUrl,
                                tipo: 'hls',
                                origen: 'yacinetv-api',
                                estado: 'online',
                                logo: channel.logo
                            });
                        }
                        actualizados++;
                    }
                }
            } catch (err) {
                console.error(`Error extrayendo ID ${channel.id}:`, err.message);
            }
        }

        if (actualizados > 0) {
            // SAFETY CHECK 2: Validar que el nuevo array de streams no haya sido purgado
            if (streams.length > 0) {
                await guardarStreams(streams);
                io.emit('actualizar_streams', streams);
                resetBeinTimer(); // Resetea el reloj a 1 hora
                console.log(`[Auto-Updater] ¡Refresco Exitoso! ${actualizados} canales beIN actualizados.`);
            } else {
                console.error('[CRITICAL] Objeto resultante corrupto. Abortando guardado.');
                await guardarStreams(JSON.parse(oldStreamsStr)); // Restaurar backup
            }
        } else {
            console.error('[Auto-Updater] Refresco fallido. La API devolvió 0 URLs válidas. Mantenemos el archivo actual.');
        }

        isRefreshingBein = false;
        return { success: true, actualizados, message: `Actualizados ${actualizados} canales.` };
    } catch (e) {
        isRefreshingBein = false;
        console.error('[Auto-Updater] Error fatal:', e);
        return { success: false, error: e.message };
    }
}

app.get('/api/refresh-bein', async (req, res) => {
    const r = await runBeinRefresh();
    res.json(r);
});


// ─────────────────────────────────────────────
// CEREBRO: AUTO-UPDATER DE CANALES TDT ESPAÑA
// ─────────────────────────────────────────────
let isRefreshingSpain = false;
let spainTimer = null;

function resetSpainTimer() {
    if (spainTimer) clearInterval(spainTimer);
    spainTimer = setInterval(() => {
        console.log('[Auto-Updater TDT] Ejecutando refresco cíclico (1h) de España...');
        runSpainRefresh();
    }, 3600000); // 1 Hora
}

// Spain arranca con 30min de retraso para no coincidir con Arabic ni BeIN
setTimeout(() => resetSpainTimer(), 1800000);

async function ensureApiFastAPI() {
    for (let attempt = 0; attempt < 15; attempt++) {
        try {
            const res = await fetch('http://127.0.0.1:8080/', { signal: AbortSignal.timeout(1500) });
            if (res.ok) return true;
        } catch (e) {
            try {
                const res2 = await fetch('http://192.168.0.17:8080/', { signal: AbortSignal.timeout(1500) });
                if (res2.ok) return true;
            } catch (e2) {}
            if (attempt === 0) {
                console.log('[Auto-Launcher] Levantando API TDT España (FastAPI) en puerto 8080...');
                const { exec } = require('child_process');
                const apiPath = path.join(__dirname, '../api-españa/run.sh');
                exec(`bash "${apiPath}"`, { cwd: path.join(__dirname, '../api-españa') });
            }
            await new Promise(r => setTimeout(r, 800));
        }
    }
}

async function runSpainRefresh() {
    if (isRefreshingSpain) {
        console.log('[Auto-Updater TDT] Refresco cancelado: Ya hay un proceso en curso.');
        return { success: false, message: 'Refresco en curso. Por favor espera.' };
    }
    
    isRefreshingSpain = true;
    try {
        await ensureApiFastAPI();
        const streams = await leerStreams();
        let actualizados = 0;
        
        // Obtenemos lista de canales
        let responseList;
        const listEndpoints = [
            'http://127.0.0.1:8080/canales',
            'http://localhost:8080/canales',
            'http://192.168.0.17:8080/canales'
        ];
        for (const ep of listEndpoints) {
            try {
                responseList = await fetch(ep, { signal: AbortSignal.timeout(5000) });
                if (responseList && responseList.ok) break;
            } catch (e) {}
        }
        
        if (!responseList || !responseList.ok) {
            console.log('[Auto-Updater TDT] Fallback a tdtspain.com para obtener lista de canales...');
            responseList = await fetch('https://www.tdtspain.com/canales/canalesv4.json', { signal: AbortSignal.timeout(10000) });
        }
        
        if (!responseList || !responseList.ok) throw new Error('No se pudo conectar con API TDT España');
        
        const jsonList = await responseList.json();
        if (!jsonList.canales) throw new Error('Formato de canales no válido');
        
        const oldStreamsStr = JSON.stringify(streams);
        const batchSize = 5; // Procesar de 5 en 5 para dar suficiente margen de tiempo
        const canales = jsonList.canales;
        const resolvedResults = new Array(canales.length);

        const rtveMap = {
            'la1.tv': 'https://rtvelivestream.rtve.es/rtvesec/la1/la1_main.m3u8',
            'la2.tv': 'https://rtvelivestream.rtve.es/rtvesec/la2/la2_main.m3u8',
            '24h.tv': 'https://rtvelivestream.rtve.es/rtvesec/24h/24h_main.m3u8',
            'teledeporte.tv': 'https://rtvelivestream.rtve.es/rtvesec/tdp/tdp_main.m3u8',
            'clan.tv': 'https://rtvelivestream.rtve.es/rtvesec/clan/clan_main.m3u8'
        };

        for (let i = 0; i < canales.length; i += batchSize) {
            const chunk = canales.slice(i, i + batchSize);
            await Promise.all(chunk.map(async (canalTdt, idxInChunk) => {
                const index = i + idxInChunk;
                const idLower = (canalTdt.id || '').toLowerCase();

                // 1. Caso especial RTVE: Usar HLS directo sin DRM
                if (rtveMap[idLower]) {
                    resolvedResults[index] = {
                        canalTdt,
                        streamData: { type: 'hls' },
                        finalUrl: rtveMap[idLower],
                        tipo: 'hls'
                    };
                    return;
                }

                try {
                    let streamResponse;
                    const streamEndpoints = [
                        `http://127.0.0.1:8080/api/stream/${encodeURIComponent(canalTdt.id)}`,
                        `http://localhost:8080/api/stream/${encodeURIComponent(canalTdt.id)}`,
                        `http://192.168.0.17:8080/api/stream/${encodeURIComponent(canalTdt.id)}`
                    ];
                    for (const ep of streamEndpoints) {
                        try {
                            streamResponse = await fetch(ep, { signal: AbortSignal.timeout(6000) });
                            if (streamResponse && streamResponse.ok) break;
                        } catch (e) {}
                    }

                    if (!streamResponse || !streamResponse.ok) return;
                    
                    const streamData = await streamResponse.json();
                    const rawStreamUrl = streamData.m3u8_url || streamData.stream_url || streamData.mpd_url || streamData.web_url || streamData.raw_url;
                    
                    if (streamData && rawStreamUrl) {
                        let finalUrl = rawStreamUrl;
                        const headers = [];
                        const apiHeaders = streamData.headers_required || streamData.headers || {};
                        
                        if (apiHeaders) {
                            if (apiHeaders['User-Agent'] || apiHeaders['user-agent']) headers.push(`User-Agent=${encodeURIComponent(apiHeaders['User-Agent'] || apiHeaders['user-agent'])}`);
                            if (apiHeaders['Referer'] || apiHeaders['referer']) headers.push(`Referer=${encodeURIComponent(apiHeaders['Referer'] || apiHeaders['referer'])}`);
                            if (apiHeaders['Origin'] || apiHeaders['origin']) headers.push(`Origin=${encodeURIComponent(apiHeaders['Origin'] || apiHeaders['origin'])}`);
                        }
                        if (headers.length > 0) {
                            finalUrl += '|' + headers.join('|');
                        }

                        const isM3u8OrMpd = rawStreamUrl.includes('.m3u8') || rawStreamUrl.includes('.mpd');
                        // Solo marcar como iframe si no es m3u8/mpd y el tipo es explícitamente iframe o web
                        const isIframe = !isM3u8OrMpd && (streamData.type === 'iframe' || streamData.provider === 'iframe' || streamData.type === 'web');
                        
                        // Ignorar silenciosamente si es iframe sin stream directo
                        if (isIframe) return;

                        resolvedResults[index] = { canalTdt, streamData, finalUrl, tipo: 'hls' };
                    }
                } catch (err) {
                    console.error(`Error extrayendo TDT ID ${canalTdt.id}:`, err.message);
                }
            }));
        }

        // Construir la lista de canales TDT ordenados exactamente como vienen en la API
        const existingTdtMap = new Map(streams.filter(s => s.id && s.id.startsWith('tdt_')).map(s => [s.id, s]));
        const nonTdtStreams = streams.filter(s => !s.id || !s.id.startsWith('tdt_'));
        const newTdtStreams = [];

        for (const item of resolvedResults) {
            if (!item) continue;
            const { canalTdt, streamData, finalUrl, tipo } = item;
            const id = `tdt_${canalTdt.id}`;
            const existing = existingTdtMap.get(id);

            newTdtStreams.push({
                id: id,
                nombre: canalTdt.name,
                url: finalUrl,
                tipo: tipo,
                origen: 'tdt-api',
                estado: 'online',
                logo: canalTdt.logo,
                categoria: canalTdt.group,
                favorito: existing ? !!existing.favorito : false
            });
            actualizados++;
        }

        // Mantener otros canales (BeIN, etc.) y añadir los TDT ordenados
        const finalStreams = [...nonTdtStreams, ...newTdtStreams];

        if (actualizados > 0) {
            if (finalStreams.length > 0) {
                await guardarStreams(finalStreams);
                io.emit('actualizar_streams', finalStreams);
                resetSpainTimer();
                console.log(`[Auto-Updater TDT] ¡Refresco Exitoso! ${actualizados} canales TDT actualizados en orden exacto.`);
            } else {
                await guardarStreams(JSON.parse(oldStreamsStr)); 
            }
        }
        
        isRefreshingSpain = false;
        return { success: true, actualizados, message: `Actualizados ${actualizados} canales TDT de España.` };
    } catch (e) {
        isRefreshingSpain = false;
        console.error('[Auto-Updater TDT] Error fatal:', e);
        return { success: false, error: e.message };
    }
}

app.get('/api/refresh-spain', async (req, res) => {
    const r = await runSpainRefresh();
    res.json(r);
});

// ─────────────────────────────────────────────
// CEREBRO: AUTO-UPDATER DE CANALES IBEROAMERICANOS (DEPORTES)
// ─────────────────────────────────────────────
let isRefreshingIbero = false;
let iberoTimer = null;

function resetIberoTimer() {
    if (iberoTimer) clearInterval(iberoTimer);
    iberoTimer = setInterval(() => {
        console.log('[Auto-Updater Ibero] Ejecutando refresco cíclico (1h) de Deportes...');
        runIberoRefresh();
    }, 3600000); // 1 Hora
}

// Ibero/Deportes arranca con 45min de retraso para escalonar carga
setTimeout(() => resetIberoTimer(), 2700000);

async function runIberoRefresh() {
    if (isRefreshingIbero) return { success: false, message: 'Refresco en curso.' };
    isRefreshingIbero = true;
    try {
        console.log('[Auto-Updater Ibero] Iniciando sincronización de Deportes...');
        const streams = await leerStreams();
        
        let response;
        const channelListEndpoints = [
            'http://127.0.0.1:8090/api/channels',
            'http://localhost:8090/api/channels',
            'http://192.168.0.17:8090/api/channels'
        ];
        for (const ep of channelListEndpoints) {
            try {
                response = await fetch(ep, { signal: AbortSignal.timeout(15000) });
                if (response && response.ok) break;
            } catch (e) {}
        }

        if (!response || !response.ok) throw new Error('No se pudo conectar con API Iberoamericana (puerto 8090)');
        
        const canales = await response.json();
        const existingIberoMap = new Map(streams.filter(s => s.id && s.id.startsWith('ibero_')).map(s => [s.id, s]));
        const nonIberoStreams = streams.filter(s => !s.id || !s.id.startsWith('ibero_'));
        
        const resolvedResults = new Array(canales.length);
        const chunkSize = 5;
        
        for (let i = 0; i < canales.length; i += chunkSize) {
            const chunk = canales.slice(i, i + chunkSize);
            await Promise.all(chunk.map(async (c, idxInChunk) => {
                const index = i + idxInChunk;
                let finalUrl = `http://192.168.0.17:8090${c.stream_proxy}`;
                
                const detailEndpoints = [
                    `http://127.0.0.1:8090/api/channels/${encodeURIComponent(c.id)}`,
                    `http://localhost:8090/api/channels/${encodeURIComponent(c.id)}`,
                    `http://192.168.0.17:8090/api/channels/${encodeURIComponent(c.id)}`
                ];
                
                for (const ep of detailEndpoints) {
                    try {
                        const resDet = await fetch(ep, { signal: AbortSignal.timeout(10000) });
                        if (resDet && resDet.ok) {
                            const details = await resDet.json();
                            if (details.status === 'online' && details.m3u8_url) {
                                const ref = details.referer_required || 'https://streamtp-golden1.click/';
                                finalUrl = `${details.m3u8_url}|Referer=${encodeURIComponent(ref)}`;
                                break;
                            }
                        }
                    } catch (err) {}
                }

                resolvedResults[index] = {
                    id: `ibero_${c.id}`,
                    nombre: c.name,
                    url: finalUrl,
                    tipo: 'hls',
                    origen: 'ibero-api',
                    estado: 'online',
                    logo: c.logo,
                    categoria: 'Deporte',
                    favorito: existingIberoMap.has(`ibero_${c.id}`) ? !!existingIberoMap.get(`ibero_${c.id}`).favorito : false
                };
            }));
        }

        const newIberoStreams = resolvedResults.filter(Boolean);
        const finalStreams = [...nonIberoStreams, ...newIberoStreams];
        
        if (newIberoStreams.length > 0) {
            await guardarStreams(finalStreams);
            io.emit('actualizar_streams', finalStreams);
            resetIberoTimer();
            console.log(`[Auto-Updater Ibero] ¡Refresco Exitoso! ${newIberoStreams.length} canales deportivos actualizados con m3u8 directo.`);
        }
        
        isRefreshingIbero = false;
        return { success: true, actualizados: newIberoStreams.length, message: `Actualizados ${newIberoStreams.length} canales deportivos.` };
    } catch (e) {
        isRefreshingIbero = false;
        console.error('[Auto-Updater Ibero] Error fatal:', e);
        return { success: false, error: e.message };
    }
}

app.get('/api/refresh-ibero', async (req, res) => {
    const r = await runIberoRefresh();
    res.json(r);
});

// API REST de solo lectura
app.get('/api/streams', async (req, res) => {
    res.json(await leerStreams());
});

// ── Refresco Asíncrono de Macros vía HTTP ──
app.post('/api/macro/refresh', express.json(), async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.status(400).json({ error: 'Falta ID' });

        const streams = await leerStreams();
        const stream = streams.find(s => s.id === id);
        if (!stream || !stream.webOrigen) {
            return res.status(400).json({ error: 'No es posible refrescar este canal.' });
        }
        if (!pcWorkerSocketId) {
            return res.status(503).json({ error: 'PC Extractor no conectado.' });
        }

        const jobId = Date.now().toString() + Math.random().toString();
        pendingJobs.set(jobId, {
            originalSocket: null,
            channelId: id,
            resolve: () => {},
            reject: () => {},
        });

        io.to(pcWorkerSocketId).emit('tarea_refrescar_macro', {
            jobId,
            url: stream.webOrigen,
            macroSteps: stream.macro || [],
        });

        res.json({ success: true, message: 'Refresco encolado.' });
    } catch (e) {
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ─────────────────────────────────────────────
// Helper: guarda un stream capturado por cualquier extractor
// ─────────────────────────────────────────────
async function _guardarStream(nombre, url, tipo, origen, socket, webOrigen = null, macro = null) {
    const streams = await leerStreams();
    const nuevo = {
        id: Date.now().toString(),
        nombre: nombre.trim(),
        url,
        tipo,
        origen,
        webOrigen: webOrigen || null,
        macro: (macro && macro.length > 0) ? macro : null,
        estado: 'online'
    };
    streams.push(nuevo);
    await guardarStreams(streams);
    console.log(`[✅] ${tipo.toUpperCase()} capturado: ${url.substring(0, 80)}...`);
    socket.emit('extraccion_completada', { nombre: nuevo.nombre, iframeUrl: url, tipo });
    io.emit('actualizar_streams', streams);
}


// ─────────────────────────────────────────────
// WebSockets (Arquitectura Master/Slave para Extracción)
// ─────────────────────────────────────────────
let pcWorkerSocketId = null;
const pendingJobs = new Map();
const JOB_TIMEOUT_MS = 120000;

function delegateToPCWorker(taskName, payload, socket) {
    if (!pcWorkerSocketId) throw new Error("El PC Extractor no está conectado. Corre 'node pc_worker.js' en tu PC.");
    return new Promise((resolve, reject) => {
        const jobId = Date.now().toString() + Math.random().toString();
        const timeout = setTimeout(() => {
            pendingJobs.delete(jobId);
            reject(new Error('Timeout: el PC no respondió a tiempo.'));
        }, JOB_TIMEOUT_MS);

        pendingJobs.set(jobId, {
            originalSocket: socket,
            channelId: payload.channelId || null,
            resolve: (data) => { clearTimeout(timeout); resolve(data); },
            reject: (err) => { clearTimeout(timeout); reject(err); },
        });
        io.to(pcWorkerSocketId).emit(taskName, { jobId, ...payload });
    });
}

async function persistMacroRefresh(channelId, streamUrl, macro) {
    const streams = await leerStreams();
    const idx = streams.findIndex(s => s.id === channelId);
    if (idx === -1) return;
    streams[idx].url = streamUrl;
    streams[idx].estado = 'online';
    if (macro && macro.length > 0) streams[idx].macro = macro;
    failCounts.delete(channelId);
    await guardarStreams(streams, { immediate: true });
    emitStreamsUpdate(streams);
}

io.on('connection', async (socket) => {
    const clientIp = socket.handshake.address;
    console.log(`[+] Cliente conectado: ${socket.id} (IP: ${clientIp})`);

    const esPcAutorizado = () => {
        return clientIp.includes('192.168.0.17') || clientIp.includes('127.0.0.1') || clientIp === '::1';
    };

    socket.on('registro_worker', () => {
        pcWorkerSocketId = socket.id;
        console.log('🖥️  PC Worker registrado:', socket.id);
    });

    socket.on('worker_log', ({ jobId, msg }) => {
        const job = pendingJobs.get(jobId);
        if (job && job.originalSocket) job.originalSocket.emit('extraccion_log', msg);
    });

    socket.on('resultado_extraccion_worker', async ({ jobId, success, streamUrl, macro, error }) => {
        const job = pendingJobs.get(jobId);
        if (!job) return;

        if (success) {
            if (job.channelId) await persistMacroRefresh(job.channelId, streamUrl, macro);
            job.resolve({ streamUrl, macro });
        } else {
            job.reject(new Error(error || 'Extracción fallida'));
        }
        pendingJobs.delete(jobId);
    });

    socket.on('solicitar_streams', async () => {
        socket.emit('actualizar_streams', await leerStreams());
    });

    socket.emit('actualizar_streams', await leerStreams());

    // ── Añadir stream .m3u8 manualmente ─────
    socket.on('nuevo_stream', async ({ nombre, url }) => {
        if (!nombre || !url) return socket.emit('error_operacion', 'Datos inválidos.');
        if (!url.startsWith('http')) return socket.emit('error_operacion', 'URL debe empezar por http:// o https://');
        
        socket.emit('operacion_exitosa', 'Comprobando señal del canal...');
        const res = await testUrl(url);
        const estado = res.status === 'OK' ? 'online' : 'offline';
        
        const streams = await leerStreams();
        const nuevo = {
            id: Date.now().toString(),
            nombre: nombre.trim(),
            url: url.trim(),
            tipo: 'hls',
            estado: estado
        };
        streams.push(nuevo);
        await guardarStreams(streams);
        io.emit('actualizar_streams', streams);
    });

    // ── Borrar Todos los Canales ───────────────────────────────────────
    socket.on('borrar_todos', async () => {
        console.log('🗑️  Borrando todos los canales...');
        await guardarStreams([]);
        io.emit('actualizar_streams', []);
    });

    // ── Marcar / Desmarcar Favorito ──────────────────────────────────
    socket.on('toggle_favorito', async (id) => {
        const streams = await leerStreams();
        const item = streams.find(s => s.id === id);
        if (item) {
            item.favorito = !item.favorito;
            await guardarStreams(streams);
            io.emit('actualizar_streams', streams);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[-] Desconectado: ${socket.id}`);
        if (socket.id === pcWorkerSocketId) {
            pcWorkerSocketId = null;
            console.log('⚠️  PC Worker desconectado. Extracción no disponible hasta reconexión.');
            for (const [jobId, job] of pendingJobs.entries()) {
                job.reject(new Error('PC Worker desconectado.'));
                pendingJobs.delete(jobId);
            }
        }
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

// ─────────────────────────────────────────────
// API PLAY — GET /api/play/:channelId
// Lee la URL guardada en streams.json (pre-resuelta en el refresco).
// NO hace peticiones externas en tiempo real. Igual que Yacine e Ibero.
// ─────────────────────────────────────────────
app.get('/api/play/:channelId', async (req, res) => {
    let idOrName = req.params.channelId;
    if (idOrName.endsWith('.m3u8')) idOrName = idOrName.slice(0, -5);

    try {
        const streams = await leerStreams();
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
