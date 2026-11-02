import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8000);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.fbx': 'application/octet-stream',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.tga': 'image/x-tga',
};

function openBrowser(url) {
  let cmd, args;
  if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try { const child = spawn(cmd, args, { detached: true, stdio: 'ignore' }); child.unref(); } catch {}
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname); }
  catch { res.writeHead(400); res.end('Bad request'); return; }
  const candidate = path.resolve(ROOT, `.${pathname}`);
  if (candidate !== ROOT && !candidate.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  let file = candidate;
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); }
  catch { res.writeHead(404); res.end('Not found'); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('Read error'); });
    stream.pipe(res);
  });
});

server.on('error', err => {
  console.error(`Could not start the viewer on port ${PORT}: ${err.message}`);
  console.error('Close the other app using this port, or set PORT to another free port.');
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('Mannequin Viewer is ready.');
  console.log(`Open: ${url}`);
  console.log(`For a phone on the same Wi-Fi, open this PC's LAN IP on port ${PORT}.`);
  setTimeout(() => openBrowser(url), 800);
});
