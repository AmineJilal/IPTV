/**
 * extractor.js — Edición Limpia v4 (Sin Remote Debugging)
 * ─────────────────────────────────────────────────────────
 * Herramientas de extracción de streams (solo pestañas externas visibles):
 *
 *   1. sniffNetwork()      — Sniffer pasivo abriendo navegador
 *   2. autoPlayAndSniff()  — BOT autónomo con auto-clic abriendo navegador
 *   3. extractYtDlp()      — yt-dlp (universal, sin navegador)
 * ─────────────────────────────────────────────────────────
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const { exec } = require('child_process');
const path = require('path');

let globalBrowser = null;

async function getBrowser(headless = false) {
    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
    globalBrowser = await puppeteer.launch({
        headless: headless,
        defaultViewport: null,
        executablePath: '/usr/bin/google-chrome',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--disable-software-rasterizer',
            '--start-maximized',
            '--no-first-run',
            '--no-default-browser-check'
        ]
    });
    return globalBrowser;
}

const MAX_MS = 10 * 60 * 1000; // 10 minutos

// Lista de patrones de URLs a IGNORAR en la intercepción
const IGNORE_PATTERNS = [
    'prebid', 'googlesyndication', 'doubleclick', 'analytics',
    'advertisement', 'ads.', '/ad/', 'tracking', 'metric',
    'segment.io', 'amplitude', 'hotjar', 'datadog',
    'cloudfront.net/ads', 'vmap', 'preroll', 'midroll',
    '3f1e4b04e92.js', // Anti-trampas detectado
    'about:blank'     // Evitar redirecciones a blanco
];

// Selectores de botones de play ordenados por prioridad
const PLAY_SELECTORS = [
    'video',
    '[aria-label*="play" i]', '[aria-label*="reproducir" i]',
    '[class*="play" i][class*="button" i]', '[class*="play" i][class*="btn" i]',
    '[class*="btn-play" i]', '[class*="playButton" i]', '[class*="play-icon" i]',
    '[class*="player-play" i]', '[class*="vjs-play" i]',
    '.vjs-big-play-button', '.jw-icon-display', '.plyr__control--overlaid',
    '.bitmovin-ui-playbacktoggle', '.ytp-play-button',
    'iframe[src*="player"]', 'iframe[src*="video"]', 'iframe[src*="directo"]'
];

/**
 * ─────────────────────────────────────────────────────────────
 * MODO 1: Sniffer de Red Pasivo (El Cazarredes)
 * ─────────────────────────────────────────────────────────────
 */
async function sniffNetwork(pageUrl, onLog = () => {}) {
    let browser = null;
    let resolved = false;
    let maxTimer = null;

    return new Promise(async (resolve, reject) => {
        let page = null;
        const cleanup = async () => {
            if (page && !page.isClosed()) { await page.close().catch(() => {}); }
        };
        const ok  = url => { if (!resolved) { resolved = true; clearTimeout(maxTimer); cleanup().then(() => resolve(url)); } };
        const err = e   => { if (!resolved) { resolved = true; clearTimeout(maxTimer); cleanup().then(() => reject(e)); } };

        try {
            onLog('🌐 Solicitando pestaña (Cazarredes)...');
            browser = await getBrowser(false);

            const pages = await browser.pages();
            page = pages.length > 0 ? pages[0] : await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            
            // ── INYECCIÓN: Grabador de Macros ──
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });

                window.__macroSteps = [];
                let lastTime = Date.now();
                
                function getCssSelector(el) {
                    if (!(el instanceof Element)) return;
                    let path = [];
                    while (el.nodeType === Node.ELEMENT_NODE) {
                        let selector = el.nodeName.toLowerCase();
                        if (el.id) {
                            selector += '#' + el.id;
                            path.unshift(selector);
                            break;
                        } else {
                            let sib = el, nth = 1;
                            while (sib = sib.previousElementSibling) {
                                if (sib.nodeName.toLowerCase() == selector) nth++;
                            }
                            if (nth != 1) selector += ":nth-of-type("+nth+")";
                        }
                        path.unshift(selector);
                        el = el.parentNode;
                    }
                    return path.join(" > ");
                }

                document.addEventListener('click', (e) => {
                    const now = Date.now();
                    const wait = now - lastTime;
                    lastTime = now;
                    const sel = getCssSelector(e.target);
                    if (sel) {
                        window.__macroSteps.push({ accion: 'click', selector: sel, esperar: wait });
                        console.log('Grabado:', sel);
                    }
                }, true);
            });

            await page.setRequestInterception(true);
            page.on('request', async req => {
                const url = req.url();
                if (resolved) return req.continue().catch(() => {});
                
                const isAd = IGNORE_PATTERNS.some(p => url.includes(p));
                if (isAd) {
                    if (url.includes('3f1e4b04e92.js') || url.includes('about:blank')) {
                        onLog(`🛑 Interceptado y bloqueado: ${url.substring(0, 80)}...`);
                    }
                    return req.abort().catch(() => {});
                }

                const isM3U8 = url.includes('.m3u8') || url.includes('manifest.m3u8');
                if (isM3U8) {
                    onLog(`🎯 ¡Enlace HLS (.m3u8) interceptado!`);
                    
                    let refererCapturado = req.headers()['referer'] || null;
                    const finalUrl = refererCapturado ? `${url}|Referer=${refererCapturado}` : url;
                    
                    req.continue().catch(() => {});
                    
                    setTimeout(async () => {
                        let macro = [];
                        try {
                            if (page && !page.isClosed()) {
                                await page.evaluate(() => window.stop()).catch(() => {}); // Early Abort
                                macro = await page.evaluate(() => window.__macroSteps || []);
                            }
                        } catch (e) {}
                        
                        if (macro.length > 0) {
                            onLog(`📼 Se han grabado ${macro.length} pasos de macro para el futuro.`);
                        }
                        ok({ streamUrl: finalUrl, macro });
                    }, 10);
                    return;
                }
                req.continue().catch(() => {});
            });

            onLog(`Navegando a: ${pageUrl}`);
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
            onLog('👆 Por favor, interactúa con la página: cierra anuncios y dale al Play. (Tus clics se están grabando)');
            
            maxTimer = setTimeout(() => { err(new Error('Tiempo máximo agotado.')); }, MAX_MS);

        } catch (e) {
            err(e);
        }
    });
}

/**
 * ─────────────────────────────────────────────────────────────
 * MODO 4: Ejecución de Macro (Aprendizaje por Demostración)
 * ─────────────────────────────────────────────────────────────
 */
async function macroPlayAndSniff(pageUrl, macroSteps, onLog = () => {}) {
    let browser = null;
    let resolved = false;
    let maxTimer = null;

    return new Promise(async (resolve, reject) => {
        let page = null;
        const cleanup = async () => {
            clearTimeout(maxTimer);
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
        };

        const ok  = (data) => { if (!resolved) { resolved = true; cleanup().then(() => resolve(data)); } };
        const err = (e)   => { if (!resolved) { resolved = true; cleanup().then(() => reject(e)); } };

        try {
            onLog('📼 Ejecutando Macro guardada...');
            browser = await getBrowser('new');
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

            await page.evaluateOnNewDocument(() => {
                const originalReplace = window.location.replace;
                window.location.replace = function(url) {
                    if (typeof url === 'string' && url.includes('about:blank')) return;
                    return originalReplace.apply(window.location, arguments);
                };
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            await page.setRequestInterception(true);
            page.on('request', req => {
                const url = req.url();
                if (resolved) return req.continue().catch(() => {});

                const resourceType = req.resourceType();
                if (['image', 'font'].includes(resourceType)) return req.abort().catch(() => {});

                const isAd = IGNORE_PATTERNS.some(p => url.includes(p));
                if (isAd) {
                    if (url.includes('3f1e4b04e92.js') || url.includes('about:blank')) {
                        onLog(`🛑 Interceptado y bloqueado: ${url.substring(0, 80)}...`);
                    }
                    return req.abort().catch(() => {});
                }

                const isM3U8 = url.includes('.m3u8') || url.includes('manifest.m3u8');
                if (isM3U8) {
                    onLog(`🎯 ¡Macro exitosa! Stream interceptado.`);
                    let refererCapturado = req.headers()['referer'] || null;
                    const finalUrl = refererCapturado ? `${url}|Referer=${refererCapturado}` : url;
                    
                    req.continue().catch(() => {});
                    
                    setTimeout(async () => {
                        try {
                            if (page && !page.isClosed()) await page.evaluate(() => window.stop()).catch(() => {}); // Early Abort
                        } catch(e) {}
                        ok({ streamUrl: finalUrl, macro: macroSteps });
                    }, 10);
                    return;
                }
                req.continue().catch(() => {});
            });

            onLog(`🌐 Navegando a: ${pageUrl}`);
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

            // Ejecutar la secuencia de clics
            for (let i = 0; i < macroSteps.length; i++) {
                if (resolved) break;
                const step = macroSteps[i];
                const waitTime = step.esperar > 5000 ? 5000 : (step.esperar < 500 ? 500 : step.esperar);
                
                onLog(`⏳ Esperando ${waitTime}ms para el clic ${i+1}...`);
                await new Promise(r => setTimeout(r, waitTime));
                
                if (resolved) break;
                
                try {
                    onLog(`🖱️ Clic ${i+1}/${macroSteps.length}: ${step.selector}`);
                    await page.click(step.selector);
                } catch (e) {
                    onLog(`⚠️ Clic falló en: ${step.selector}`);
                }
            }

            maxTimer = setTimeout(() => err(new Error('Tiempo máximo agotado sin encontrar stream.')), 2 * 60 * 1000);

        } catch (e) {
            cleanup();
            err(e);
        }
    });
}

/**
 * ─────────────────────────────────────────────────────────────
 * MODO 2: Bot Autónomo con Auto-Clic Inteligente
 * ─────────────────────────────────────────────────────────────
 */
async function autoPlayAndSniff(pageUrl, onLog = () => {}) {
    let browser = null;
    let resolved = false;
    let autoClickTimer = null;
    let maxTimer = null;

    return new Promise(async (resolve, reject) => {
        let page = null;
        const cleanup = async () => {
            clearTimeout(autoClickTimer);
            clearTimeout(maxTimer);
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
        };

        const ok  = url => { if (!resolved) { resolved = true; cleanup().then(() => resolve(url)); } };
        const err = e   => { if (!resolved) { resolved = true; cleanup().then(() => reject(e)); } };

        try {
            onLog('🤖 Solicitando pestaña (AutoBot)...');
            browser = await getBrowser('new');
            page = await browser.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
            
            // Evitar detección de webdriver y bloqueos
            await page.evaluateOnNewDocument(() => {
                const originalReplace = window.location.replace;
                window.location.replace = function(url) {
                    if (typeof url === 'string' && url.includes('about:blank')) return;
                    return originalReplace.apply(window.location, arguments);
                };
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            await page.setRequestInterception(true);
            page.on('request', req => {
                const url = req.url();
                if (resolved) return req.continue().catch(() => {});

                const resourceType = req.resourceType();
                if (['image', 'font'].includes(resourceType)) return req.abort().catch(() => {});

                const isAd = IGNORE_PATTERNS.some(p => url.includes(p));
                if (isAd) return req.abort().catch(() => {});

                const isM3U8 = url.includes('.m3u8') || url.includes('manifest.m3u8');
                if (isM3U8) {
                    onLog(`🎯 ¡Stream .m3u8 interceptado!`);
                    let refererCapturado = req.headers()['referer'] || null;
                    const finalUrl = refererCapturado ? `${url}|Referer=${refererCapturado}` : url;
                    
                    req.continue().catch(() => {});
                    
                    setTimeout(async () => {
                        try {
                            if (page && !page.isClosed()) await page.evaluate(() => window.stop()).catch(() => {}); // Early Abort
                        } catch(e) {}
                        ok({ streamUrl: finalUrl });
                    }, 10);
                    return;
                }
                req.continue().catch(() => {});
            });

            onLog(`🌐 Navegando a: ${pageUrl}`);
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
                onLog(`⚠️ Carga lenta, intentando auto-clic de todas formas...`);
            });

            onLog('📄 Buscando popups y reproductor...');

            const tryAutoPlay = async () => {
                if (resolved) return;

                try {
                    const clicked = await page.evaluate((selectors) => {
                        // 1. Cerrar cookies y overlays
                        const closeSelectors = [
                            '[id*="cookie"] button', '[class*="cookie"] button', 
                            '#didomi-notice-agree-button', '#onetrust-accept-btn-handler',
                            'button[class*="close"]', 'button[aria-label*="cerrar" i]', 'button[aria-label*="close" i]',
                            '.modal-close', '.popup-close', '[class*="dismiss"]'
                        ];
                        for (const sel of closeSelectors) {
                            try {
                                const btns = Array.from(document.querySelectorAll(sel));
                                for (const btn of btns) {
                                    if (btn.offsetWidth > 0 && btn.offsetHeight > 0) btn.click();
                                }
                            } catch (e) {}
                        }

                        // 2. Forzar Play de <video>
                        const videos = Array.from(document.querySelectorAll('video'));
                        for (const v of videos) {
                            if (v.paused || v.readyState >= 2) {
                                try { v.muted = true; v.play(); return 'video.play()'; } catch { }
                            }
                        }

                        // 3. Buscar botones por texto (Regex)
                        const allButtons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
                        const playRegex = /^(play|reproducir|directo|en directo|ver ahora|emisión en directo)$/i;
                        for (const btn of allButtons) {
                            if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                                if (playRegex.test(btn.innerText.trim())) {
                                    btn.click();
                                    return `click text: ${btn.innerText.trim()}`;
                                }
                            }
                        }

                        // 4. Buscar botones por selectores de clases comunes
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el && sel !== 'video') {
                                if (el.getBoundingClientRect().width > 0) {
                                    el.click();
                                    return `click selector: ${sel}`;
                                }
                            }
                        }

                        // 5. Clic al centro de un contenedor de video
                        const containers = document.querySelectorAll('[class*="player"], [class*="video"]');
                        for (const c of containers) {
                            const r = c.getBoundingClientRect();
                            if (r.width > 100 && r.height > 100) {
                                const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
                                if (el) { el.click(); return 'click center'; }
                            }
                        }

                        return null;
                    }, PLAY_SELECTORS);

                    if (clicked) onLog(`🖱️ Interacción: ${clicked}`);
                } catch { }

                if (!resolved) autoClickTimer = setTimeout(tryAutoPlay, 2500);
            };

            autoClickTimer = setTimeout(tryAutoPlay, 1500);
            maxTimer = setTimeout(() => err(new Error('Tiempo máximo (3 min) agotado.')), 3 * 60 * 1000);

        } catch (e) {
            cleanup();
            err(e);
        }
    });
}

/**
 * ─────────────────────────────────────────────────────────────
 * MODO 3: yt-dlp (Descargador universal)
 * ─────────────────────────────────────────────────────────────
 */
function extractYtDlp(url, onLog = () => {}) {
    return new Promise((resolve, reject) => {
        onLog(`⚡ Ejecutando yt-dlp...`);
        const cmd = `"${path.join(__dirname, 'yt-dlp')}" -g --no-warnings "${url}"`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) return reject(new Error(stderr || error.message || "Error yt-dlp"));
            const streamUrl = stdout.trim().split('\n')[0];
            if (streamUrl && streamUrl.startsWith('http')) {
                onLog(`✅ Stream encontrado.`);
                resolve(streamUrl);
            } else {
                reject(new Error('yt-dlp falló.'));
            }
        });
    });
}

/**
 * ─────────────────────────────────────────────────────────────
 * MODO 5: Extracción directa por API (Ligero, sin Puppeteer)
 * ─────────────────────────────────────────────────────────────
 */
module.exports = { sniffNetwork, autoPlayAndSniff, extractYtDlp, macroPlayAndSniff };
