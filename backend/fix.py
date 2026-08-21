with open('server.js', 'r') as f:
    lines = f.readlines()

out = []
for line in lines:
    out.append(line)
    if "socket.on('toggle_favorito'" in line:
        break

tail = """        const streams = await leerStreams();
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
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`\\n🟢 Servidor IPTV corriendo en http://localhost:${PORT}`);
        console.log(`📡 Acceso en red local: http://192.168.0.17:${PORT}\\n`);
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
        if (!cleanUrl || !/^https?:\\/\\//i.test(cleanUrl)) {
            return res.status(422).json({ error: `URL inválida para "${stream.nombre}". Refresca los canales.` });
        }

        let origin = originFromUrl || null;
        if (!origin && referer) {
            try { origin = new URL(referer).origin; } catch { origin = null; }
        }

        return res.json({
            success: true,
            streamUrl: cleanUrl,
            proxyUrl: buildProxyUrlFromRequest(req, stream.url),
            referer: referer || null,
            origin: origin || null,
            userAgent: userAgent || UA,
        });
    } catch (err) {
        console.error('[/api/play] Error:', err.message);
        return res.status(500).json({ error: 'Error interno.' });
    }
});
"""

out.append(tail)

with open('server.js', 'w') as f:
    f.writelines(out)
