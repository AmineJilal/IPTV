const fs = require('fs');

let code = fs.readFileSync('backend/server.js.backup', 'utf-8');

// 1. Añadir dependencias de DB
code = code.replace(
    "const fs = require('fs').promises;",
    "const fs = require('fs').promises;\nconst { createClient } = require('@libsql/client');\n"
);

// 2. Reemplazar la persistencia local por Turso
const dbLogic = `
// ─────────────────────────────────────────────
// CONFIGURACIÓN TURSO DB (LibSQL)
// ─────────────────────────────────────────────
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || 'libsql://iptv-db-aminejilal.aws-eu-west-1.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN || ''
});

async function initDb() {
    await db.execute(\`
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
    \`);
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
`;
code = code.replace(/const STREAMS_FILE = [^]+?(?=async function marcarStreamOffline)/, dbLogic);

// 3. Reemplazar API de streams patch y post
code = code.replace(/app\.patch\('\/api\/streams\/:id'[^]+?\}\);/g, `
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
});`);

code = code.replace(/app\.post\('\/api\/update-stream'[^]+?\}\);/g, `
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
});`);

// 4. API Play (Cache-Aside)
const apiPlay = `
app.get('/api/play/:channelId', async (req, res) => {
    let id = req.params.channelId;
    if (id.endsWith('.m3u8')) id = id.slice(0, -5);

    try {
        const result = await db.execute("SELECT * FROM channel_cache WHERE id = ?", [id]);
        let stream = result.rows[0];

        if (!stream) return res.status(404).json({ error: 'Canal no encontrado en BD.' });
        if (stream.tipo === 'iframe') return res.status(400).json({ error: 'Canal iframe, no HLS.' });

        // Cache-Aside: 1 Hora TTL
        const ahora = Date.now();
        const ttl = 3600000;
        let finalStreamUrl = stream.stream_url;
        let headersList = stream.headers;

        if (!finalStreamUrl || ahora - (stream.updated_at || 0) > ttl) {
            console.log(\`[Cache-Aside] Resolviendo on-demand para: \${stream.nombre} (\${id})\`);
            let nuevaUrl = null;
            let nuevosHeaders = null;

            try {
                if (id.startsWith('tdt_')) {
                    const r = await fetch(\`http://127.0.0.1:8080/api/stream/\${id.replace('tdt_','')}\`, { signal: AbortSignal.timeout(5000) });
                    if (r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.stream_url;
                    }
                } else if (id.startsWith('ibero_')) {
                    const r = await fetch(\`http://127.0.0.1:8090/api/channels/\${id}\`, { signal: AbortSignal.timeout(5000) });
                    if (r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.stream_url;
                        if (d.headers) nuevosHeaders = JSON.stringify(d.headers);
                    }
                } else if (id.startsWith('bein_')) {
                    const r = await fetch(\`http://127.0.0.1:8000/channel/\${id.replace('bein_','')}\`, { signal: AbortSignal.timeout(5000) });
                    if (r.ok) {
                        const d = await r.json();
                        if (d.data && d.data[0] && d.data[0].url) {
                            nuevaUrl = d.data[0].url;
                            if (d.data[0].headers) nuevosHeaders = JSON.stringify(d.data[0].headers);
                        }
                    }
                } else if (id.startsWith('arabic_')) {
                    const r = await fetch(\`http://127.0.0.1:9080/api/channels/\${id.replace('arabic_','')}/stream\`, { signal: AbortSignal.timeout(5000) });
                    if (r.ok) {
                        const d = await r.json();
                        nuevaUrl = d.stream_url;
                        if (d.headers) nuevosHeaders = JSON.stringify(d.headers);
                    }
                }

                if (nuevaUrl) {
                    finalStreamUrl = nuevaUrl;
                    headersList = nuevosHeaders || '';
                    await db.execute(
                        "UPDATE channel_cache SET stream_url = ?, headers = ?, updated_at = ? WHERE id = ?",
                        [finalStreamUrl, headersList, ahora, id]
                    );
                }
            } catch (fetchErr) {
                console.warn(\`[Cache-Aside] Falló resolución para \${id}, usando fallback si existe\`);
            }
        }

        if (!finalStreamUrl) {
            return res.status(422).json({ error: 'No se pudo resolver el stream HLS.' });
        }

        // Extraer Referer/Origin de headersList
        let ref = '', ori = '', ua = UA;
        if (headersList) {
            try {
                const hdrs = JSON.parse(headersList);
                ref = hdrs['Referer'] || '';
                ori = hdrs['Origin'] || '';
                ua = hdrs['User-Agent'] || UA;
            } catch(e) {
                // si no es json, buscar en string (formato url|Referer=...)
                if (typeof headersList === 'string' && headersList.includes('=')) {
                     const parts = headersList.split('|');
                     parts.forEach(p => {
                         if (p.startsWith('Referer=')) ref = decodeURIComponent(p.split('=')[1]);
                         if (p.startsWith('User-Agent=')) ua = decodeURIComponent(p.split('=')[1]);
                     });
                }
            }
        }

        const proxyUrl = buildProxyUrlFromRequest(req, finalStreamUrl);
        return res.json({
            success: true,
            streamUrl: finalStreamUrl,
            proxyUrl,
            referer: ref,
            origin: ori,
            userAgent: ua,
        });
    } catch (err) {
        console.error('[/api/play]', err.message);
        return res.status(500).json({ error: 'Error interno.' });
    }
});
`;
code = code.replace(/app\.get\('\/api\/play\/:channelId'[^]+?(?=\/\/ ─────────────────────────────────────────────\n\/\/ \/proxy-video)/, apiPlay);

// 5. Borrar Auto-Updaters y meter /api/sync-lists
code = code.replace(/\/\/ ─────────────────────────────────────────────\n\/\/ CEREBRO: AUTO-UPDATER DE CANALES BEIN[^]+?(?=io\.on\('connection')/g, `
// ─────────────────────────────────────────────
// ENDPOINT: SYNC METADATA LISTS (No resuelve streams)
// ─────────────────────────────────────────────
app.get('/api/sync-lists', async (req, res) => {
    try {
        let total = 0;
        const insertQuery = \`
            INSERT INTO channel_cache (id, nombre, categoria, logo, tipo, stream_url, updated_at) 
            VALUES (?, ?, ?, ?, 'hls', NULL, 0)
            ON CONFLICT(id) DO UPDATE SET 
                nombre = excluded.nombre,
                logo = excluded.logo,
                categoria = excluded.categoria
        \`;

        // 1. TDT España
        try {
            const r = await fetch('https://www.tdtspain.com/canales/canalesv4.json');
            if (r.ok) {
                const data = await r.json();
                for (const c of data.canales || []) {
                    if (c.url && (c.url.includes('youtube') || c.url.includes('youtu.be'))) continue; // Ignorar YT
                    const id = 'tdt_' + c.id;
                    await db.execute(insertQuery, [id, c.name || c.nombre, 'España', c.logo]);
                    total++;
                }
            }
        } catch(e){}

        // 2. Iberoamericana
        try {
            const r = await fetch('http://127.0.0.1:8090/api/channels');
            if (r.ok) {
                const data = await r.json();
                for (const c of data.channels || []) {
                    if (c.stream_type === 'youtube') continue;
                    const id = 'ibero_' + c.id;
                    await db.execute(insertQuery, [id, c.name, 'Deportes', c.logo]);
                    total++;
                }
            }
        } catch(e){}

        // 3. Arabic
        try {
            const r = await fetch('http://127.0.0.1:9080/api/channels?limit=500');
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
        } catch(e){}

        // 4. BeIN (Constante)
        for (const c of BEIN_CHANNELS.concat(BEIN_CHANNELS_720)) {
            const id = 'bein_' + c.id;
            await db.execute(insertQuery, [id, c.name, 'BeIN Sports', c.logo]);
            total++;
        }

        io.emit('actualizar_streams', await obtenerStreamsDb());
        res.json({ success: true, count: total });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint que lee directo de DB (llamado por el frontend al inicio)
app.get('/api/streams', async (req, res) => {
    try {
        let streams = await obtenerStreamsDb();
        if (streams.length === 0) {
            await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/sync-lists').catch(()=>{});
            streams = await obtenerStreamsDb();
        }
        res.json(streams);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

`);

// 6. Socket.io
code = code.replace(/await leerStreams\(\)/g, "await obtenerStreamsDb()");
code = code.replace(/await guardarStreams\(streams[^\)]*\);/g, "// ya no se guarda en batch a file");

code = code.replace(/socket\.on\('toggle_favorito', async \(id\) => \{[^]+?\}\);/g, `
    socket.on('toggle_favorito', async (id) => {
        const str = await db.execute("SELECT favorito FROM channel_cache WHERE id = ?", [id]);
        if (str.rows[0]) {
            const nuevo = str.rows[0].favorito === 1 ? 0 : 1;
            await db.execute("UPDATE channel_cache SET favorito = ? WHERE id = ?", [nuevo, id]);
            io.emit('actualizar_streams', await obtenerStreamsDb());
        }
    });`);

code = code.replace(/socket\.on\('borrar_todos', async \(\) => \{[^]+?\}\);/g, `
    socket.on('borrar_todos', async () => {
        await db.execute("DELETE FROM channel_cache");
        io.emit('actualizar_streams', []);
    });`);

code = code.replace(/socket\.on\('nuevo_stream', async \(\{ nombre, url \}\) => \{[^]+?\}\);/g, `
    socket.on('nuevo_stream', async ({ nombre, url }) => {
        if (!nombre || !url) return;
        const id = Date.now().toString();
        await db.execute(
            "INSERT INTO channel_cache (id, nombre, url, tipo, estado, categoria, updated_at) VALUES (?, ?, ?, 'hls', 'online', 'General', ?)",
            [id, nombre, url, Date.now()]
        );
        io.emit('actualizar_streams', await obtenerStreamsDb());
    });`);

// 7. Playlist.m3u Directo de DB
code = code.replace(/app\.get\('\/playlist\.m3u'[^]+?\}\);/g, `
app.get(['/playlist.m3u', '/api/playlist.m3u'], async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM channel_cache");
        let m3u = "#EXTM3U url-tvg=\\"https://raw.githubusercontent.com/davidmuma/EPG_dobleM/master/guiatv.xml\\"\\n";
        
        const host = req.headers.host || '127.0.0.1:' + (process.env.PORT || 3000);
        const baseUrl = \`\${req.protocol}://\${host}/api/play\`;

        for (const ch of result.rows) {
            const tvgId = (ch.id.startsWith('tdt_')) ? ch.id.replace('tdt_','') : ch.id;
            m3u += \`#EXTINF:-1 tvg-id="\${tvgId}" tvg-name="\${ch.nombre}" tvg-logo="\${ch.logo || ''}" group-title="\${ch.categoria}",\${ch.nombre}\\n\`;
            m3u += \`\${baseUrl}/\${ch.id}.m3u8\\n\`;
        }
        res.setHeader('Content-Type', 'audio/mpegurl');
        res.send(m3u);
    } catch (e) {
        res.status(500).send("Error generando lista");
    }
});`);

fs.writeFileSync('backend/server.js', code);
