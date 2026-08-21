const io = require('socket.io-client');
const { extractYtDlp, sniffNetwork, autoPlayAndSniff, macroPlayAndSniff } = require('./extractor');

// Conectarse al servidor principal (Móvil Termux)
const SERVER_URL = 'http://192.168.0.17:3000';
console.log(`🔌 Conectando al servidor IPTV en ${SERVER_URL}...`);

const socket = io(SERVER_URL, {
    transports: ['websocket'],
    reconnection: true,
});

socket.on('connect', () => {
    console.log('✅ Conectado al servidor principal como Worker.');
    socket.emit('registro_worker', 'Soy el PC esclavo');
});

socket.on('disconnect', () => {
    console.log('❌ Desconectado del servidor.');
});

// Función para enviar logs al servidor
const buildLogFn = (jobId, prefijo) => (msg) => {
    console.log(`  [${prefijo}] ${msg}`);
    socket.emit('worker_log', { jobId, msg: `[${prefijo}] ${msg}` });
};

// ==========================================
// CONTROL DE CONCURRENCIA (Cola Limitada)
// ==========================================
const MAX_CONCURRENT = 2;
let activeTasks = 0;
const taskQueue = [];

function enqueueTask(taskFn) {
    taskQueue.push(taskFn);
    processQueue();
}

async function processQueue() {
    if (activeTasks >= MAX_CONCURRENT || taskQueue.length === 0) return;
    activeTasks++;
    const task = taskQueue.shift();
    try {
        await task();
    } finally {
        activeTasks--;
        processQueue();
    }
}

// ==========================================
// ESCUCHANDO TAREAS DEL SERVIDOR
// ==========================================

socket.on('tarea_extraer_sniffer', ({ jobId, url }) => {
    enqueueTask(async () => {
        const onLog = buildLogFn(jobId, 'Sniffer PC');
        try {
            const data = await sniffNetwork(url, onLog);
            const streamUrl = typeof data === 'string' ? data : data.streamUrl;
            const macro = typeof data === 'string' ? null : data.macro;
            socket.emit('resultado_extraccion_worker', { jobId, success: true, streamUrl, macro });
        } catch (e) {
            socket.emit('resultado_extraccion_worker', { jobId, success: false, error: e.message });
        }
    });
});

socket.on('tarea_extraer_bot', ({ jobId, url }) => {
    enqueueTask(async () => {
        const onLog = buildLogFn(jobId, 'Bot PC');
        try {
            const data = await autoPlayAndSniff(url, onLog);
            const streamUrl = typeof data === 'string' ? data : data.streamUrl;
            const macro = typeof data === 'string' ? null : data.macro;
            socket.emit('resultado_extraccion_worker', { jobId, success: true, streamUrl, macro });
        } catch (e) {
            socket.emit('resultado_extraccion_worker', { jobId, success: false, error: e.message });
        }
    });
});

socket.on('tarea_refrescar_macro', ({ jobId, url, macroSteps }) => {
    enqueueTask(async () => {
        const onLog = buildLogFn(jobId, 'Macro PC');
        let attempts = 0;
        let success = false;
        
        while (attempts < 3 && !success) {
            attempts++;
            try {
                let data;
                if (macroSteps && macroSteps.length > 0) {
                    data = await macroPlayAndSniff(url, macroSteps, onLog);
                } else {
                    data = await autoPlayAndSniff(url, onLog); // Fallback to AutoBot, not interactive sniff
                }
                const streamUrl = typeof data === 'string' ? data : data.streamUrl;
                const macro = typeof data === 'string' ? macroSteps : (data.macro || macroSteps);
                socket.emit('resultado_extraccion_worker', { jobId, success: true, streamUrl, macro });
                success = true;
            } catch (e) {
                onLog(`Fallo intento ${attempts}/3: ${e.message}`);
                if (attempts >= 3) {
                    socket.emit('resultado_extraccion_worker', { jobId, success: false, error: e.message });
                }
            }
        }
    });
});

socket.on('tarea_extraer_ytdlp', async ({ jobId, url }) => {
    const onLog = buildLogFn(jobId, 'yt-dlp PC');
    try {
        const streamUrl = await extractYtDlp(url, onLog);
        socket.emit('resultado_extraccion_worker', { jobId, success: true, streamUrl });
    } catch (e) {
        socket.emit('resultado_extraccion_worker', { jobId, success: false, error: e.message });
    }
});
