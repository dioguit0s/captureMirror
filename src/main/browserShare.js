const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Porta fixa: se o app reiniciar, a guia que já estava aberta se reconecta sozinha.
// Se ela estiver ocupada, o sistema escolhe outra, e a guia precisa ser reaberta.
const PREFERRED_PORT = 47830;
const HOST = '127.0.0.1';
const PLAYER_DIR = path.join(__dirname, '../player');
const FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/player.js': { file: 'player.js', type: 'text/javascript; charset=utf-8' },
  '/player.css': { file: 'player.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};
const MAX_BODY_BYTES = 256 * 1024;
const KEEPALIVE_MS = 15000;
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

let server = null;
let port = null;
// Uma guia por vez: codificar o vídeo para várias guias custaria CPU à toa.
let viewer = null;
let lastStatus = null;
let onViewer = () => {};
let onSignal = () => {};

const url = () => (port ? `http://${HOST}:${port}/` : null);

// Só aceita pedidos feitos para o próprio endereço local. Isso barra páginas de
// outros sites que tentem falar com o servidor por DNS rebinding.
function isLocalHost(req) {
  return req.headers.host === `${HOST}:${port}` || req.headers.host === `localhost:${port}`;
}

function isSameOrigin(req) {
  const { origin } = req.headers;
  return origin === `http://${HOST}:${port}` || origin === `http://localhost:${port}`;
}

function sendEvent(target, type, data = {}) {
  target?.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function dropViewer(target, reason) {
  if (!target) return;
  clearInterval(target.keepalive);
  if (reason) sendEvent(target, reason);
  target.res.end();
}

function openEvents(req, res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
  });
  // Uma guia nova assume o lugar da anterior.
  const previous = viewer;
  viewer = null;
  dropViewer(previous, 'replaced');

  const current = { id: crypto.randomUUID(), res, keepalive: null };
  // Comentários periódicos mantêm a conexão viva e revelam guias fechadas.
  current.keepalive = setInterval(() => res.write(': ping\n\n'), KEEPALIVE_MS);
  viewer = current;
  res.write('retry: 2000\n\n');
  sendEvent(current, 'hello', { id: current.id });
  if (lastStatus) sendEvent(current, 'status', lastStatus);
  onViewer(current.id);

  req.on('close', () => {
    clearInterval(current.keepalive);
    if (viewer !== current) return;
    viewer = null;
    onViewer(null);
  });
}

function readSignal(req, res) {
  if (!isSameOrigin(req) || !req.headers['content-type']?.startsWith('application/json')) {
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, SECURITY_HEADERS).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let message;
    try {
      message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    // Resposta de uma guia que já foi substituída: ignora.
    if (!viewer || message?.id !== viewer.id || message.description?.type !== 'answer') {
      res.writeHead(409, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(204, SECURITY_HEADERS).end();
    onSignal({ id: viewer.id, description: { type: 'answer', sdp: String(message.description.sdp) } });
  });
}

function serveFile(pathname, res) {
  const entry = FILES[pathname];
  if (!entry) {
    res.writeHead(404, SECURITY_HEADERS).end();
    return;
  }
  fs.readFile(path.join(PLAYER_DIR, entry.file), (error, body) => {
    if (error) {
      res.writeHead(500, SECURITY_HEADERS).end();
      return;
    }
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': entry.type }).end(body);
  });
}

function handle(req, res) {
  if (!isLocalHost(req)) {
    res.writeHead(403, SECURITY_HEADERS).end();
    return;
  }
  const { pathname } = new URL(req.url, url());
  if (req.method === 'GET' && pathname === '/events') openEvents(req, res);
  else if (req.method === 'POST' && pathname === '/signal') readSignal(req, res);
  else if (req.method === 'GET') serveFile(pathname, res);
  else res.writeHead(405, SECURITY_HEADERS).end();
}

function listen(candidate) {
  return new Promise((resolve, reject) => {
    const instance = http.createServer(handle);
    instance.once('error', reject);
    instance.listen(candidate, HOST, () => {
      instance.off('error', reject);
      resolve(instance);
    });
  });
}

async function start(handlers) {
  ({ onViewer, onSignal } = handlers);
  try {
    server = await listen(PREFERRED_PORT);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    console.warn(`porta ${PREFERRED_PORT} em uso: o modo navegador vai usar outra`);
    server = await listen(0);
  }
  port = server.address().port;
  return url();
}

function stop() {
  dropViewer(viewer);
  viewer = null;
  server?.close();
  server = null;
}

// Mensagens do app para a guia: a oferta WebRTC e o estado da imagem.
function sendOffer(id, description) {
  if (viewer?.id === id) sendEvent(viewer, 'offer', { description });
}

function sendStatus(status) {
  lastStatus = status;
  sendEvent(viewer, 'status', status);
}

module.exports = {
  start,
  stop,
  url,
  sendOffer,
  sendStatus,
  currentViewer: () => viewer?.id ?? null,
};
