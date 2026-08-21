/* ─────────────────────────────────────────────────────────
   IPTV LOCAL — app.js v3 (Clean Edition)
───────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {

    // ══════════════════════════════════════════════════
    // DOM REFS
    // ══════════════════════════════════════════════════
    const streamsList      = document.getElementById('streams-list');
    const videoPlayer      = document.getElementById('video-player');
    const iframePlayer     = document.getElementById('iframe-player');
    const overlay          = document.getElementById('player-overlay');
    const overlayTitle     = document.getElementById('overlay-title');
    const overlaySub       = document.getElementById('overlay-subtitle');
    const nowPlayingDot    = document.getElementById('now-playing-dot');
    const nowPlayingText   = document.getElementById('now-playing-title');
    const modeBadge        = document.getElementById('player-mode-badge');
    const statusBadge      = document.getElementById('connection-status');
    const channelsCount    = document.getElementById('channels-count');
    const toastContainer   = document.getElementById('toast-container');

    // Modal
    const modalOverlay     = document.getElementById('modal-overlay');
    const btnOpenModal     = document.getElementById('btn-open-modal');
    const btnCloseModal    = document.getElementById('btn-close-modal');

    // Modal Edit
    const modalEditOverlay = document.getElementById('modal-edit-overlay');
    const btnCloseEditModal= document.getElementById('btn-close-edit-modal');
    const editForm         = document.getElementById('edit-stream-form');
    const editId           = document.getElementById('edit-id');
    const editNombre       = document.getElementById('edit-nombre');
    const editCategoria    = document.getElementById('edit-categoria');

    // Formularios
    const addForm          = document.getElementById('add-stream-form');
    const inputNombre      = document.getElementById('input-nombre');
    const inputUrl         = document.getElementById('input-url');

    const snifferForm      = document.getElementById('sniffer-form');
    const snifferNombre    = document.getElementById('sniffer-nombre');
    const snifferUrl       = document.getElementById('sniffer-url');
    const btnSniffer       = document.getElementById('btn-sniffer');

    const btnClearAll      = document.getElementById('btn-clear-all');

    // Terminal de logs
    const extractorStatus  = document.getElementById('extractor-status');
    const extractorLog     = document.getElementById('extractor-log');
    const extractorSpinner = document.getElementById('extractor-spinner');
    const extractorStatusTx = document.getElementById('extractor-status-text');

    // ══════════════════════════════════════════════════
    // ESTADO
    // ══════════════════════════════════════════════════
    let hls       = null;
    let plyrPlayer = null;
    let activeId  = null;

    // ══════════════════════════════════════════════════
    // MODAL
    // ══════════════════════════════════════════════════
    function openModal() {
        modalOverlay.classList.remove('hidden');
        resetTerminal();
    }

    btnOpenModal.addEventListener('click', () => {
        openModal();
        document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
        document.querySelector('.modal-tab[data-tab="manual"]').classList.add('active');
        document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.add('hidden'));
        document.getElementById('modal-tab-manual').classList.remove('hidden');
    });

    btnCloseModal.addEventListener('click', closeModal);

    modalOverlay.addEventListener('click', e => {
        if (e.target === modalOverlay) closeModal();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeModal();
    });

    function closeModal() {
        modalOverlay.classList.add('hidden');
        modalEditOverlay.classList.add('hidden');
        extractorStatus.classList.add('hidden');
    }

    btnCloseEditModal.addEventListener('click', closeModal);

    modalEditOverlay.addEventListener('click', e => {
        if (e.target === modalEditOverlay) closeModal();
    });

    // ── Edit Form Submit ──
    editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = editId.value;
        const nombre = editNombre.value.trim();
        const categoria = editCategoria.value;

        if (!nombre) { editNombre.classList.add('invalid'); return; }

        try {
            const res = await fetch(`/api/streams/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre, categoria })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Canal actualizado a "${nombre}"`, 'success', '✏️');
                closeModal();
            } else {
                showToast(data.error || 'Error al actualizar', 'error', '❌');
            }
        } catch (err) {
            showToast('Error de red al actualizar', 'error', '❌');
        }
    });

    // ── Modal Tabs ─────────────────────────────────────
    document.querySelectorAll('.modal-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const id = tab.dataset.tab;
            document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.add('hidden'));
            document.getElementById(`modal-tab-${id}`).classList.remove('hidden');
            resetTerminal();
        });
    });

    // ══════════════════════════════════════════════════
    // SOCKET.IO
    // ══════════════════════════════════════════════════
    const socket = io();

    socket.on('connect',    () => setStatus(true));
    socket.on('disconnect', () => {
        setStatus(false);
        showToast('Conexión perdida con el servidor.', 'error', '🔌');
    });

    socket.on('error_operacion',    msg => showToast(msg, 'error', '⚠️'));

    const sincronizando = new Set();
    socket.on('sincronizando_canal', (id) => {
        sincronizando.add(id);
        renderStreams();
        showToast('Sincronizando señal en segundo plano...', 'info', '🔄');
    });
    socket.on('fin_sincronizando_canal', (id) => {
        sincronizando.delete(id);
        renderStreams();
    });

    // ── Eventos del extractor ──────────────────────────
    socket.on('extraccion_iniciada', ({ nombre }) => {
        resetTerminal();
        extractorStatus.classList.remove('hidden');
        extractorStatusTx.textContent = `Buscando stream para "${nombre}"…`;
    });

    socket.on('extraccion_log', msg => appendLog(msg));

    socket.on('extraccion_completada', ({ nombre, iframeUrl, tipo }) => {
        appendLog(`✅ Capturado: ${iframeUrl}`, 'success');
        extractorSpinner.className = 'spinner done';
        extractorStatusTx.textContent = '¡Stream capturado!';
        showToast(`"${nombre}" añadido correctamente.`, 'success', '🎯', 5000);
        resetForms();
    });

    socket.on('error_extraccion', msg => {
        appendLog(`❌ ${msg}`, 'error');
        extractorSpinner.className = 'spinner error';
        extractorStatusTx.textContent = 'Error en la extracción';
        showToast(msg, 'error', '❌', 6000);
        resetButtons();
    });

    // ── Macro Refresco ──
    let currentMacroChannelId = null;
    const btnStartMacro = document.getElementById('btn-start-macro');
    if (btnStartMacro) {
        btnStartMacro.addEventListener('click', () => {
            if (!currentMacroChannelId) return;
            btnStartMacro.disabled = true;
            btnStartMacro.innerHTML = `<span class="spinner"></span> Procesando...`;
            socket.emit('refrescar_macro_sniffer', { canalId: currentMacroChannelId });
        });
    }

    // ══════════════════════════════════════════════════
    // FORMULARIO MANUAL
    // ══════════════════════════════════════════════════
    addForm.addEventListener('submit', e => {
        e.preventDefault();
        const nombre   = inputNombre.value.trim();
        const url      = inputUrl.value.trim();

        let valid = true;
        if (!nombre)                          { inputNombre.classList.add('invalid'); valid = false; }
        if (!url || !url.startsWith('http'))  { inputUrl.classList.add('invalid');    valid = false; }
        if (!valid) { showToast('Rellena todos los campos.', 'warning', '📝'); return; }

        socket.emit('nuevo_stream', { nombre, url });
        addForm.reset();
        closeModal();
        showToast(`"${nombre}" añadido.`, 'success', '✅');
    });

    // ══════════════════════════════════════════════════
    // FORMULARIO CAZARREDES (SNIFFER)
    // ══════════════════════════════════════════════════
    snifferForm.addEventListener('submit', e => {
        e.preventDefault();
        const nombre = snifferNombre.value.trim();
        const url    = snifferUrl.value.trim();

        if (!nombre) { snifferNombre.classList.add('invalid'); return; }
        if (!url || !url.startsWith('http')) { snifferUrl.classList.add('invalid'); return; }

        socket.emit('extraer_sniffer', { nombre, url });
        btnSniffer.disabled = true;
        btnSniffer.textContent = '🕵️ Cazando…';
        extractorStatus.classList.remove('hidden');
        resetTerminal();
        extractorStatusTx.textContent = `Iniciando Cazarredes para "${nombre}"…`;
    });

    // Botón Limpiar Todos
    if (btnClearAll) {
        btnClearAll.addEventListener('click', () => {
            if (confirm('¿Estás seguro de que quieres borrar todos los canales? Esta acción no se puede deshacer.')) {
                socket.emit('borrar_todos');
            }
        });
    }

    // Quitar clase invalid al escribir
    [inputNombre, inputUrl, snifferNombre, snifferUrl].forEach(el => {
        if (el) el.addEventListener('input', () => el.classList.remove('invalid'));
    });

    let currentStreams = [];
    let activeFilter = 'all'; // 'all' o 'favs'

    socket.on('actualizar_streams', (streams) => {
        streams.forEach(s => {
            // Si el servidor nos dice que está online o hubo actualización, lo sacamos del set de sincronizando por seguridad.
            if (s.estado === 'online') sincronizando.delete(s.id);
        });
        currentStreams = streams;
        renderStreams();
    });

    const filterAllBtn  = document.getElementById('filter-all');
    const filterFavsBtn = document.getElementById('filter-favs');
    const filterBeinBtn = document.getElementById('filter-bein');
    const filterBein720Btn = document.getElementById('filter-bein720');
    const filterSpainBtn = document.getElementById('filter-spain');
    const filterIberoBtn = document.getElementById('filter-ibero');
    const btnRefreshBein= document.getElementById('btn-refresh-bein');
    const btnRefreshSpain= document.getElementById('btn-refresh-spain');
    const btnRefreshIbero= document.getElementById('btn-refresh-ibero');

    function updateFilterUI() {
        if(filterAllBtn) filterAllBtn.classList.remove('active');
        if(filterFavsBtn) filterFavsBtn.classList.remove('active');
        if(filterBeinBtn) filterBeinBtn.classList.remove('active');
        if(filterBein720Btn) filterBein720Btn.classList.remove('active');
        if(filterSpainBtn) filterSpainBtn.classList.remove('active');
        if(filterIberoBtn) filterIberoBtn.classList.remove('active');
        
        if(btnRefreshBein) btnRefreshBein.style.display = (activeFilter === 'bein' || activeFilter === 'bein720') ? 'inline-flex' : 'none';
        if(btnRefreshSpain) btnRefreshSpain.style.display = (activeFilter === 'spain') ? 'inline-flex' : 'none';
        if(btnRefreshIbero) btnRefreshIbero.style.display = (activeFilter === 'ibero') ? 'inline-flex' : 'none';
    }

    if (filterAllBtn && filterFavsBtn && filterBeinBtn && filterBein720Btn) {
        filterAllBtn.addEventListener('click', () => {
            activeFilter = 'all';
            updateFilterUI();
            filterAllBtn.classList.add('active');
            renderStreams();
        });
        filterFavsBtn.addEventListener('click', () => {
            activeFilter = 'favs';
            updateFilterUI();
            filterFavsBtn.classList.add('active');
            renderStreams();
        });
        filterBeinBtn.addEventListener('click', () => {
            activeFilter = 'bein';
            updateFilterUI();
            filterBeinBtn.classList.add('active');
            renderStreams();
        });
        filterBein720Btn.addEventListener('click', () => {
            activeFilter = 'bein720';
            updateFilterUI();
            filterBein720Btn.classList.add('active');
            renderStreams();
        });
        if (filterSpainBtn) {
            filterSpainBtn.addEventListener('click', () => {
                activeFilter = 'spain';
                updateFilterUI();
                filterSpainBtn.classList.add('active');
                renderStreams();
            });
        }
        if (filterIberoBtn) {
            filterIberoBtn.addEventListener('click', () => {
                activeFilter = 'ibero';
                updateFilterUI();
                filterIberoBtn.classList.add('active');
                renderStreams();
            });
        }
    }

    if (btnRefreshBein) {
        btnRefreshBein.addEventListener('click', async () => {
            btnRefreshBein.disabled = true;
            btnRefreshBein.innerHTML = '<i class="ph-bold ph-spinner ph-spin"></i> Sincronizando...';
            showToast('Sincronizando metadatos (Cache-Aside)...', 'info');
            try {
                const res = await fetch('/api/sync-lists');
                const data = await res.json();
                if (data.success) {
                    showToast(`Sincronizados ${data.count} canales`, 'success');
                } else {
                    showToast(data.error || 'Error actualizando', 'error');
                }
            } catch (err) {
                showToast('Error de red actualizando', 'error');
            }
            btnRefreshBein.disabled = false;
            btnRefreshBein.innerHTML = '<i class="ph-bold ph-arrows-clockwise"></i> Refrescar';
        });
    }

    if (btnRefreshSpain) {
        btnRefreshSpain.addEventListener('click', async () => {
            btnRefreshSpain.disabled = true;
            btnRefreshSpain.innerHTML = '<i class="ph-bold ph-spinner ph-spin"></i> Sincronizando...';
            showToast('Sincronizando metadatos (Cache-Aside)...', 'info');
            try {
                const res = await fetch('/api/sync-lists');
                const data = await res.json();
                if (data.success) {
                    showToast(`Sincronizados ${data.count} canales`, 'success');
                } else {
                    showToast(data.error || 'Error cargando canales', 'error');
                }
            } catch (err) {
                showToast('Error de red cargando TDT España', 'error');
            }
            btnRefreshSpain.disabled = false;
            btnRefreshSpain.innerHTML = '<i class="ph-bold ph-arrows-clockwise"></i> Cargar España';
        });
    }

    if (btnRefreshIbero) {
        btnRefreshIbero.addEventListener('click', async () => {
            btnRefreshIbero.disabled = true;
            btnRefreshIbero.innerHTML = '<i class="ph-bold ph-spinner ph-spin"></i> Sincronizando...';
            showToast('Sincronizando metadatos (Cache-Aside)...', 'info');
            try {
                const res = await fetch('/api/sync-lists');
                const data = await res.json();
                if (data.success) {
                    showToast(`Sincronizados ${data.count} canales`, 'success');
                } else {
                    showToast(data.error || 'Error cargando canales', 'error');
                }
            } catch (err) {
                showToast('Error de red cargando API Iberoamericana', 'error');
            }
            btnRefreshIbero.disabled = false;
            btnRefreshIbero.innerHTML = '<i class="ph-bold ph-arrows-clockwise"></i> Cargar Deporte';
        });
    }

    // ══════════════════════════════════════════════════
    // RENDER — Lista de canales
    // ══════════════════════════════════════════════════
    function renderStreams() {
        let streams = currentStreams;
        if (activeFilter === 'favs') {
            streams = currentStreams.filter(s => s.favorito);
        } else if (activeFilter === 'bein') {
            streams = currentStreams.filter(s => s.nombre.toLowerCase().includes('bein') && !s.nombre.toLowerCase().includes('720p'));
        } else if (activeFilter === 'bein720') {
            streams = currentStreams.filter(s => s.nombre.toLowerCase().includes('bein') && s.nombre.toLowerCase().includes('720p'));
        } else if (activeFilter === 'spain') {
            streams = currentStreams.filter(s => s.id && s.id.startsWith('tdt_'));
        } else if (activeFilter === 'ibero') {
            streams = currentStreams.filter(s => s.id && s.id.startsWith('ibero_'));
        }

        channelsCount.textContent = streams.length;
        streamsList.innerHTML = '';

        if (streams.length === 0) {
            const msjVacio = activeFilter === 'favs'
                ? 'No tienes ningún canal en favoritos.<br>Haz clic en la estrella de un canal para añadirlo.'
                : 'No hay canales todavía.<br>Pulsa <strong>Añadir Canal</strong> para empezar.';
            streamsList.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">${activeFilter === 'favs' ? '<i class="ph-fill ph-star" style="color:var(--text-3)"></i>' : '<i class="ph-fill ph-monitor-play" style="color:var(--text-3)"></i>'}</span>
                    <p>${msjVacio}</p>
                </div>`;
            return;
        }

        streams.forEach(stream => {
            const tipo     = stream.tipo || 'hls';
            const isIframe = tipo === 'iframe';
            const isFav    = !!stream.favorito;

            const li = document.createElement('li');
            li.className  = 'stream-item' 
                + (isIframe ? ' iframe-type' : '') 
                + (isFav ? ' is-favorite' : '') 
                + (stream.id === activeId ? ' active' : '');
            li.dataset.id = stream.id;
            li.setAttribute('role', 'option');
            li.setAttribute('tabindex', '0');
            li.setAttribute('aria-selected', stream.id === activeId ? 'true' : 'false');

            let dotClass = `status-dot status-${stream.estado || 'unknown'}`;
            let dotTitle = `Estado: ${stream.estado || 'desconocido'}`;
            let syncBadge = '';

            if (sincronizando.has(stream.id)) {
                dotClass = 'status-dot sync-dot';
                dotTitle = 'Sincronizando señal...';
                syncBadge = `<span class="stream-type-badge" style="background: linear-gradient(90deg, var(--purple), #c026d3); color: white; border: none; box-shadow: 0 0 10px var(--purple-glow); animation: pulse 1.5s infinite;"><i class="ph-bold ph-arrows-clockwise" style="animation: spin 1s linear infinite;"></i> Sincronizando...</span>`;
            }

            li.innerHTML = `
                <div class="stream-icon-wrapper">
                    <span class="stream-icon">${isFav ? '<i class="ph-fill ph-star" style="color:var(--yellow)"></i>' : '<i class="ph-fill ph-television" style="color:var(--accent)"></i>'}</span>
                    <div class="playing-indicator">
                        <span class="bar"></span><span class="bar"></span><span class="bar"></span>
                    </div>
                </div>
                <div class="stream-info">
                    <h4 class="stream-name" title="${escapeHTML(stream.nombre)}">
                        <span class="${dotClass}" title="${dotTitle}"></span>
                        ${escapeHTML(stream.nombre)}
                    </h4>
                    <div class="stream-meta">
                        ${syncBadge}
                        <span class="stream-type-badge ${isIframe ? 'badge-iframe' : 'badge-hls'}">${isIframe ? 'IFRAME' : 'HLS'}</span>
                        ${stream.origen ? `<span class="stream-origin">${escapeHTML(stream.origen)}</span>` : ''}
                    </div>
                </div>
                <div class="stream-actions">
                    ${stream.webOrigen ? `<button class="btn-refresh-macro" title="Refrescar URL (Macro/Sniffer)"><i class="ph-bold ph-arrows-clockwise"></i></button>` : ''}
                    <button class="btn-edit" title="Editar Canal"><i class="ph-bold ph-pencil-simple"></i></button>
                    <button class="btn-fav ${isFav ? 'active' : ''}" title="${isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}"><i class="${isFav ? 'ph-fill' : 'ph-bold'} ph-star"></i></button>
                    <button class="btn-delete" aria-label="Eliminar ${escapeHTML(stream.nombre)}">
                        <i class="ph-bold ph-trash"></i>
                    </button>
                </div>`;

            li.addEventListener('click', e => {
                if (e.target.closest('.btn-delete') || e.target.closest('.btn-fav') || e.target.closest('.btn-refresh-macro') || e.target.closest('.btn-edit')) return;
                playStream(stream);
            });

            li.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    playStream(stream);
                }
            });

            li.querySelector('.btn-fav').addEventListener('click', e => {
                e.stopPropagation();
                socket.emit('toggle_favorito', stream.id);
            });

            li.querySelector('.btn-delete').addEventListener('click', e => {
                e.stopPropagation();
                if (!confirm(`¿Eliminar el canal "${stream.nombre}"?`)) return;
                if (stream.id === activeId) {
                    detenerReproductor();
                    showOverlay('📭', 'Sin señal', 'El canal fue eliminado.');
                }
                socket.emit('eliminar_stream', stream.id);
                showToast(`"${stream.nombre}" eliminado.`, 'error', '🗑️');
            });

            const btnEdit = li.querySelector('.btn-edit');
            if (btnEdit) {
                btnEdit.addEventListener('click', e => {
                    e.stopPropagation();
                    editId.value = stream.id;
                    editNombre.value = stream.nombre;
                    editCategoria.value = stream.categoria || 'General';
                    modalEditOverlay.classList.remove('hidden');
                });
            }

            const btnRefresh = li.querySelector('.btn-refresh-macro');
            if (btnRefresh) {
                btnRefresh.addEventListener('click', e => {
                    e.stopPropagation();
                    
                    // Configurar y abrir el mini-panel de la macro
                    currentMacroChannelId = stream.id;
                    const urlInput = document.getElementById('macro-url-display');
                    if (urlInput) urlInput.value = stream.webOrigen || 'URL desconocida';
                    
                    openModal();
                    
                    // Ocultamos todos los tabs normales
                    document.querySelectorAll('.modal-tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.modal-tab-content').forEach(c => c.classList.add('hidden'));
                    
                    // Mostramos solo el contenido de la macro y reseteamos el terminal por si acaso
                    document.getElementById('modal-tab-macro').classList.remove('hidden');
                    document.getElementById('extractor-status').classList.add('hidden');
                    
                    showToast(`Preparado para actualizar "${stream.nombre}".`, 'info', '🔄');
                });
            }

            streamsList.appendChild(li);
        });
    }

    // ══════════════════════════════════════════════════
    // REPRODUCTOR
    // ══════════════════════════════════════════════════
    function playStream(stream) {
        activeId = stream.id;
        nowPlayingText.textContent = stream.nombre;

        document.querySelectorAll('.stream-item').forEach(el =>
            el.classList.toggle('active', el.dataset.id === stream.id)
        );

        hideOverlay();

        if ((stream.tipo || 'hls') === 'iframe') {
            playIframe(stream);
        } else {
            playHLS(stream);
        }
    }

    function playIframe(stream) {
        if (hls) { 
            hls.destroy(); 
            hls = null; 
        }
        videoPlayer.classList.remove('active-player');
        if (plyrPlayer && plyrPlayer.elements.container) plyrPlayer.elements.container.classList.remove('active-player');
        videoPlayer.src = '';

        const proxyUrl = `/proxy-video?url=${encodeURIComponent(stream.url)}`;
        iframePlayer.src = proxyUrl;
        iframePlayer.classList.add('active-player');

        nowPlayingDot.className = 'dot iframe-live';
        modeBadge.classList.remove('hidden');
        showToast(`Cargando "${stream.nombre}" vía proxy…`, 'iframe', '🖼️', 3000);
    }

    async function resolvePlayUrl(stream) {
        try {
            const res = await fetch(`/api/play/${encodeURIComponent(stream.id)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data || !data.success) throw new Error(data?.error || 'Respuesta inválida');
            if (data.proxyUrl && typeof data.proxyUrl === 'string') return data.proxyUrl;
            if (data.streamUrl && typeof data.streamUrl === 'string') return data.streamUrl;
            throw new Error('No hay URL de reproducción');
        } catch (_) {
            // Fallback legacy
            return `/play/${encodeURIComponent(stream.id)}.m3u8`;
        }
    }

    async function playHLS(stream) {
        iframePlayer.classList.remove('active-player');
        iframePlayer.src = '';
        modeBadge.classList.add('hidden');

        if (hls) {
            hls.destroy();
            hls = null;
        }

        videoPlayer.classList.add('active-player');
        if (plyrPlayer && plyrPlayer.elements.container) plyrPlayer.elements.container.classList.add('active-player');
        nowPlayingDot.className = 'dot live';

        let finalUrl = await resolvePlayUrl(stream);
        let hlsRecoveryScheduled = false;
        let networkRecoveryCount = 0;

        if (!plyrPlayer) {
            plyrPlayer = new Plyr(videoPlayer, {
                controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'fullscreen'],
                autoplay: true,
                keyboard: { focused: true, global: true },
                i18n: {
                    restart: 'Reiniciar', rewind: 'Rebobinar', play: 'Reproducir', pause: 'Pausar', 
                    fastForward: 'Avanzar', mute: 'Silenciar', unmute: 'Activar sonido', 
                    volume: 'Volumen', enterFullscreen: 'Pantalla completa', exitFullscreen: 'Salir de pantalla completa',
                    settings: 'Ajustes', speed: 'Velocidad', normal: 'Normal', buffering: 'Cargando señal...'
                }
            });
        }

        if (Hls.isSupported()) {
            hls = new Hls({
                maxLoadingDelay: 4,
                minAutoBitrate: 0,
                lowLatencyMode: true,
                fragLoadingMaxRetry: 2,
                manifestLoadingMaxRetry: 2,
                levelLoadingMaxRetry: 2,
                fragLoadingRetryDelay: 1000,
                manifestLoadingRetryDelay: 1500,
                levelLoadingRetryDelay: 1000,
                fragLoadingMaxRetryTimeout: 15000,
                manifestLoadingMaxRetryTimeout: 15000,
            });

            hls.loadSource(finalUrl);
            hls.attachMedia(videoPlayer);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                const playPromise = videoPlayer.play();
                if (playPromise !== undefined) playPromise.catch(() => {});
            });

            hls.on(Hls.Events.ERROR, (_e, data) => {
                if (!data || !data.fatal) return;

                if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                    if (hlsRecoveryScheduled) return;
                    hlsRecoveryScheduled = true;
                    console.warn('[HLS] Error de medios, intentando recuperar una sola vez...');
                    hls.recoverMediaError();
                    setTimeout(() => { hlsRecoveryScheduled = false; }, 1500);
                    return;
                }

                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                    if (hlsRecoveryScheduled) return;
                    if (networkRecoveryCount >= 3) {
                        errorReproductor(stream.nombre);
                        return;
                    }

                    networkRecoveryCount += 1;
                    hlsRecoveryScheduled = true;
                    console.warn('[HLS] Error de red: se evita el bucle infinito de recuperación.');
                    showToast(`Recuperando señal de "${stream.nombre}"...`, 'warning', '🔄', 2500);
                    setTimeout(async () => {
                        hlsRecoveryScheduled = false;
                        if (!hls) return;
                        if (networkRecoveryCount >= 2) {
                            // Fuerza nueva resolución del endpoint por si el backend ya renovó URL.
                            finalUrl = await resolvePlayUrl(stream);
                            hls.loadSource(finalUrl);
                            return;
                        }
                        hls.startLoad();
                    }, 2500);
                    return;
                }

                errorReproductor(stream.nombre);
            });
        } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
            videoPlayer.src = finalUrl;
            videoPlayer.play().catch(() => errorReproductor(stream.nombre));
        } else {
            showToast('HLS no soportado. Usa Chrome o Firefox.', 'warning', '⚠️');
        }
    }

    function detenerReproductor() {
        if (hls) { hls.destroy(); hls = null; }
        if (plyrPlayer) { plyrPlayer.stop(); }
        videoPlayer.src = '';
        videoPlayer.classList.remove('active-player');
        if (plyrPlayer && plyrPlayer.elements.container) plyrPlayer.elements.container.classList.remove('active-player');
        iframePlayer.src = '';
        iframePlayer.classList.remove('active-player');
        modeBadge.classList.add('hidden');
        activeId = null;
        nowPlayingText.textContent = 'Sin señal';
        nowPlayingDot.className = 'dot';
    }

    function errorReproductor(nombre) {
        showOverlay('📡', 'Señal no disponible', `No se pudo conectar con "${nombre}".`);
        nowPlayingText.textContent = 'Sin señal';
        nowPlayingDot.className = 'dot';
        showToast(`Error al reproducir "${nombre}"`, 'error', '❌');
    }

    // ══════════════════════════════════════════════════
    // HELPERS UI
    // ══════════════════════════════════════════════════
    function showOverlay(icon, title, subtitle) {
        document.querySelector('.overlay-icon').textContent = icon;
        overlayTitle.textContent = title;
        overlaySub.textContent   = subtitle;
        overlay.classList.add('visible');
    }
    function hideOverlay() { overlay.classList.remove('visible'); }

    function setStatus(connected) {
        const label = statusBadge.querySelector('.status-label');
        statusBadge.className = 'status-badge ' + (connected ? 'connected' : 'disconnected');
        label.textContent = connected ? 'Conectado' : 'Desconectado';
    }

    function showToast(message, type = 'info', icon = 'ℹ️', duration = 3500) {
        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;
        toastContainer.appendChild(t);
        setTimeout(() => {
            t.classList.add('fade-out');
            t.addEventListener('animationend', () => t.remove(), { once: true });
        }, duration);
    }

    function appendLog(msg, type = '') {
        const span = document.createElement('span');
        span.className = 'log-line' + (type ? ` ${type}` : '');
        span.textContent = msg;
        extractorLog.appendChild(span);
        extractorLog.scrollTop = extractorLog.scrollHeight;
    }

    function resetTerminal() {
        extractorLog.innerHTML = '';
        extractorSpinner.className = 'spinner';
        extractorStatusTx.textContent = 'Iniciando…';
    }

    function resetButtons() {
        if (btnSniffer) {
            btnSniffer.disabled = false;
            btnSniffer.textContent = '🥷 Sniffer';
        }
    }

    function resetForms() {
        addForm.reset();
        snifferForm.reset();
        resetButtons();
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]||c));
    }

});
