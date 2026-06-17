/**
 * Dev server for the Opus 1.6.1 WASM + Vonage demo.
 * Sets Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy
 * so SharedArrayBuffer and WASM work in modern browsers.
 */
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, 'public');
const PORT   = process.env.PORT || 3000;

const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.wasm': 'application/wasm',
    '.css':  'text/css',
    '.map':  'application/json',
};

http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.join(PUBLIC, urlPath);
    const ext      = path.extname(filePath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found: ' + urlPath);
            return;
        }
        res.writeHead(200, {
            'Content-Type':                    MIME[ext] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy':      'same-origin',
            'Cross-Origin-Embedder-Policy':    'require-corp',
            'Access-Control-Allow-Origin':     '*',
            'Cache-Control':                   'no-cache',
        });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`Opus WASM demo running → http://localhost:${PORT}`);
    console.log('Open the URL, fill in your Vonage credentials, and click Connect.');
});
