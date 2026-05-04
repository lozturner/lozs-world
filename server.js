/**
 * Loz's World - local server.
 *   1. Serve static world from /public.
 *   2. /proxy?u=<url> - proxies any URL, strips iframe-blocking headers.
 *   3. /api/assets    - lists model files in public/assets/.
 *   4. /api/suggest   - DuckDuckGo autocomplete proxy (returns JSON array of suggestions).
 *   5. /api/search    - returns a search-engine URL for a natural-language query.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = parseInt(process.env.PORT || '7777', 10);

// Detect packaged-EXE mode (pkg snapshots __dirname into a virtual /snapshot/...
// filesystem that's read-only and not visible to the user). When packaged we
// write user assets next to the .exe so drag-dropped STLs persist.
const IS_PACKAGED = typeof process.pkg !== 'undefined';
const APP_DIR = __dirname;
const DATA_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const ASSETS_DIR = path.join(DATA_DIR, 'public', 'assets');
if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

// Same-origin gate for /proxy: any visitor of an HTML page on this origin
// gets a session cookie; /proxy refuses requests without it. Stops random
// bots from finding the public URL and using us as an open web proxy.
const PROXY_SECRET = process.env.PROXY_SECRET
    || require('crypto').randomBytes(16).toString('hex');

// ---- Request logger (so we can see in the console whether the iPhone is even hitting us)
app.use((req, _res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || '?';
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}  <-- ${ip}`);
    next();
});

// ---- Health check: plain text, no dependencies. Test from iPhone first:
//      http://loz.local:7777/health
app.get('/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/plain').send(
        'Loz World OK\n' +
        'time:        ' + new Date().toISOString() + '\n' +
        'your IP:     ' + (req.ip || req.socket?.remoteAddress || '?') + '\n' +
        'user-agent:  ' + (req.headers['user-agent'] || '') + '\n'
    );
});

// ---- Live reload: browser opens an SSE connection to /livereload.
//      When a file under public/ changes, we push "reload" and the page refreshes.
//      When server.js itself changes, we exit with code 99; run.bat respawns us,
//      the browser's EventSource reconnects, sees onopen-after-close, and reloads.
const _liveReloadClients = new Set();
app.get('/livereload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': connected\n\n');
    _liveReloadClients.add(res);
    const ka = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ka); _liveReloadClients.delete(res); });
});

let _reloadTimer = null;
function _broadcastReload() {
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
        for (const c of _liveReloadClients) {
            try { c.write('data: reload\n\n'); } catch {}
        }
    }, 120);
}
try {
    fs.watch(path.join(__dirname, 'public'), { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        if (/^\./.test(path.basename(filename))) return; // ignore dotfiles / editor swap
        console.log(`[livereload] public/${filename} changed`);
        _broadcastReload();
    });
} catch (e) { console.log('[livereload] file watch unavailable:', e.message); }

// Self-restart on server.js change. Exit code 99 -> run.bat loops back.
try {
    let _selfRestartTimer = null;
    fs.watch(__filename, () => {
        clearTimeout(_selfRestartTimer);
        _selfRestartTimer = setTimeout(() => {
            console.log('[livereload] server.js changed - restarting (exit 99)');
            process.exit(99);
        }, 150);
    });
} catch {}

app.get('/api/assets', (_req, res) => {
    try {
        const files = fs.readdirSync(ASSETS_DIR, { withFileTypes: true })
            .filter(d => d.isFile()).map(d => d.name)
            .filter(n => /\.(stl|obj|glb|gltf|fbx|dae|3ds|ply)$/i.test(n))
            .map(name => {
                const stat = fs.statSync(path.join(ASSETS_DIR, name));
                return { name, url: '/assets/' + encodeURIComponent(name),
                    size: stat.size, ext: name.toLowerCase().split('.').pop(),
                    mtime: stat.mtimeMs };
            }).sort((a, b) => b.mtime - a.mtime);
        res.json({ assets: files, dir: ASSETS_DIR });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// DuckDuckGo autocomplete - server-side fetch to bypass CORS.
app.get('/api/suggest', (req, res) => {
    const q = String(req.query.q || '').slice(0, 200);
    if (!q) return res.json([]);
    const url = 'https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list';
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
            try {
                // DuckDuckGo returns [query, [suggestions]] or [{phrase: ...}, ...].
                const j = JSON.parse(data);
                const list = Array.isArray(j) && Array.isArray(j[1]) ? j[1]
                    : (Array.isArray(j) ? j.map(x => x.phrase || x).filter(Boolean) : []);
                res.json(list.slice(0, 8));
            } catch { res.json([]); }
        });
    }).on('error', () => res.json([]));
});

// Resolve a query string to a search URL.
app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ url: null });
    res.json({ url: 'https://duckduckgo.com/?q=' + encodeURIComponent(q) });
});

app.use('/proxy', (req, res, next) => {
    const cookie = req.headers.cookie || '';
    if (!cookie.split(/;\s*/).includes('lw=' + PROXY_SECRET)) {
        res.status(403).type('text/plain').send('Forbidden: open this site\'s home page first.');
        return;
    }
    const target = req.query.u;
    if (!target) { res.status(400).send('Missing ?u=<url>'); return; }
    let url;
    try { url = new URL(target); } catch { res.status(400).send('Invalid url'); return; }
    const proxy = createProxyMiddleware({
        target: url.origin, changeOrigin: true, followRedirects: false,
        selfHandleResponse: false, pathRewrite: () => url.pathname + url.search,
        on: {
            proxyRes: (pr) => {
                delete pr.headers['x-frame-options'];
                delete pr.headers['X-Frame-Options'];
                if (pr.headers['content-security-policy']) {
                    pr.headers['content-security-policy'] = pr.headers['content-security-policy']
                        .replace(/frame-ancestors[^;]*;?/gi, '').trim();
                }
                if (pr.headers.location) {
                    try {
                        const loc = new URL(pr.headers.location, url);
                        pr.headers.location = '/proxy?u=' + encodeURIComponent(loc.toString());
                    } catch {}
                }
            },
            error: (err, _req, r) => { if (!r.headersSent) r.status(502).send('Proxy error: ' + err.message); }
        }
    });
    return proxy(req, res, next);
});

// Serve Three.js straight from node_modules so the page works without the
// internet (no unpkg.com, no CDN). Cache aggressively - the version is pinned.
// Self-host es-module-shims polyfill so older iOS Safari can use importmap.
app.use('/vendor/es-module-shims',
    express.static(path.join(__dirname, 'node_modules', 'es-module-shims', 'dist'), {
        maxAge: '7d', immutable: true,
    }));

app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three'), {
    maxAge: '7d', immutable: true,
}));

// Issue the proxy-gate cookie on any HTML page request.
app.use((req, res, next) => {
    if (req.method === 'GET' && (req.path === '/' || /\.html?$/i.test(req.path))) {
        res.setHeader('Set-Cookie',
            `lw=${PROXY_SECRET}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax`);
    }
    next();
});

// User-writable assets folder (next to the .exe in packaged mode) takes
// precedence over the snapshot, so drag-dropped STLs are findable.
app.use('/assets', express.static(ASSETS_DIR, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=300'),
}));

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, fp) => {
        if (/\.(stl|obj|glb|gltf|fbx|dae|3ds|ply|png|jpg)$/i.test(fp))
            res.setHeader('Cache-Control', 'public, max-age=300');
        else res.setHeader('Cache-Control', 'no-store');
    }
}));

// Find every LAN IPv4 address so phones/tablets on the same Wi-Fi
// can reach the world without the user having to figure out their IP.
const os = require('os');
function lanAddresses() {
    const ifaces = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(ifaces)) {
        for (const ni of ifaces[name]) {
            if (ni.family === 'IPv4' && !ni.internal) {
                addrs.push({ iface: name, addr: ni.address });
            }
        }
    }
    return addrs;
}

// ----- Friendly LAN name via mDNS / Bonjour -----
// Lets phones, iPads, and other PCs reach the world by typing
//   http://loz.local:7777
// instead of the bare IP. Change MDNS_NAME below if you want
// http://something-else.local:7777
const MDNS_NAME = 'loz';
let mdnsActive = false;
try {
    const { Bonjour } = require('bonjour-service');
    const bj = new Bonjour();
    bj.publish({ name: MDNS_NAME, type: 'http', port: PORT });
    mdnsActive = true;
    process.on('SIGINT', () => { try { bj.unpublishAll(() => bj.destroy()); } catch {} process.exit(0); });
} catch (e) {
    // Module not installed yet, or platform refuses the multicast bind.
    // Server still works fine; the friendly URL just won't be advertised.
}

// Bind to 0.0.0.0 explicitly so other devices on the LAN can reach us.
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Loz's World online`);
    console.log(`  -------------------------------------------------------------`);
    console.log(`  On THIS computer:    http://localhost:${PORT}`);
    const lan = lanAddresses();
    if (lan.length) {
        console.log(`\n  From phones / iPads / other PCs on the same Wi-Fi:`);
        if (mdnsActive) console.log(`    http://${MDNS_NAME}.local:${PORT}    (friendly name)`);
        else console.log(`    (friendly name unavailable - run "npm install" once to enable http://${MDNS_NAME}.local:${PORT})`);
        for (const a of lan) console.log(`    http://${a.addr}:${PORT}    (${a.iface})`);
        console.log(`\n  If those don't work, allow Node through Windows Firewall when prompted,`);
        console.log(`  or run:  netsh advfirewall firewall add rule name="Loz World" dir=in action=allow protocol=TCP localport=${PORT}`);
    }
    console.log(`\n  Search suggest:      http://localhost:${PORT}/api/suggest?q=...`);
    console.log(`  Assets:              ${ASSETS_DIR}\n`);

    // Packaged mode: auto-open the browser so users just double-click the .exe.
    if (IS_PACKAGED) {
        const { spawn } = require('child_process');
        const url = `http://localhost:${PORT}`;
        try {
            if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
            else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' });
            else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
        } catch {}
    }
});
