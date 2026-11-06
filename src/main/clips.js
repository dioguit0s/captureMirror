const { app, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

// Miniatura (.jpg) e duração (.json) de cada clipe ficam numa subpasta, com o
// mesmo nome-base do .mp4.
const THUMBS = '.thumbs';

const clipsDir = () => path.join(app.getPath('videos'), 'Capture Mirror');
const thumbsDir = () => path.join(clipsDir(), THUMBS);
const baseName = (name) => name.slice(0, -path.extname(name).length);

// Os nomes vêm do renderer: só aceita um arquivo .mp4 direto na pasta de clipes.
function clipPath(name) {
  if (typeof name !== 'string' || path.basename(name) !== name || path.extname(name).toLowerCase() !== '.mp4') {
    return null;
  }
  return path.join(clipsDir(), name);
}

const thumbPath = (name) => path.join(thumbsDir(), `${baseName(name)}.jpg`);
const infoPath = (name) => path.join(thumbsDir(), `${baseName(name)}.json`);

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `Clipe ${day} ${time}`;
}

function uniqueName(date) {
  const base = stamp(date);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? `${base}.mp4` : `${base} (${n}).mp4`;
    if (!fs.existsSync(path.join(clipsDir(), name))) return name;
  }
}

async function save({ mp4, thumb, duration }) {
  await fs.promises.mkdir(thumbsDir(), { recursive: true });
  const name = uniqueName(new Date());
  // Grava com outro nome e renomeia: a coleção nunca lista um clipe pela metade.
  const temp = path.join(thumbsDir(), `${baseName(name)}.part`);
  await fs.promises.writeFile(temp, Buffer.from(mp4));
  if (thumb) await fs.promises.writeFile(thumbPath(name), Buffer.from(thumb));
  await fs.promises.writeFile(infoPath(name), JSON.stringify({ duration }));
  await fs.promises.rename(temp, clipPath(name));
  return { name, path: clipPath(name) };
}

function readInfo(name) {
  try {
    return JSON.parse(fs.readFileSync(infoPath(name), 'utf8'));
  } catch {
    return {};
  }
}

async function list() {
  let entries;
  try {
    entries = await fs.promises.readdir(clipsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const clips = [];
  for (const entry of entries) {
    if (!entry.isFile() || !clipPath(entry.name)) continue;
    try {
      const { size, mtimeMs } = await fs.promises.stat(clipPath(entry.name));
      clips.push({
        name: entry.name,
        size,
        date: mtimeMs,
        duration: readInfo(entry.name).duration ?? null,
        url: `clip://media/${encodeURIComponent(entry.name)}`,
        thumb: fs.existsSync(thumbPath(entry.name)) ? `clip://thumb/${encodeURIComponent(entry.name)}` : null,
      });
    } catch {
      // O arquivo sumiu entre o readdir e o stat.
    }
  }
  return clips.sort((a, b) => b.date - a.date);
}

// Vai para a Lixeira, de onde pode ser restaurado. A miniatura é só cache do app.
async function trash(name) {
  const file = clipPath(name);
  if (!file) return;
  await shell.trashItem(file);
  for (const extra of [thumbPath(name), infoPath(name)]) {
    await fs.promises.rm(extra, { force: true });
  }
}

function show(name) {
  const file = clipPath(name);
  if (file) shell.showItemInFolder(file);
}

async function openFolder() {
  await fs.promises.mkdir(clipsDir(), { recursive: true });
  await shell.openPath(clipsDir());
}

// clip://media/<nome.mp4> e clip://thumb/<nome.mp4>. Precisa ser registrado como
// privilegiado antes do ready (registerScheme) e tratado depois (handleProtocol).
const SCHEME = 'clip';

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

// Responde a pedidos de Range (206). Sem isso o player não consegue avançar no
// vídeo: o net.fetch de file:// ignora o Range e devolve sempre o arquivo inteiro.
function serveFile(file, request, type) {
  const { size } = fs.statSync(file);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
  if (!range || (!range[1] && !range[2])) {
    return new Response(Readable.toWeb(fs.createReadStream(file)), {
      status: 200,
      headers: { ...headers, 'Content-Length': String(size) },
    });
  }
  // "bytes=-N" pede os últimos N bytes.
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
    },
  });
}

function handleProtocol() {
  protocol.handle(SCHEME, (request) => {
    const { host, pathname } = new URL(request.url);
    const name = decodeURIComponent(pathname.slice(1));
    let file = clipPath(name);
    if (file && host === 'thumb') file = thumbPath(name);
    else if (host !== 'media') file = null;
    if (!file || !fs.existsSync(file)) return new Response(null, { status: 404 });
    return serveFile(file, request, host === 'thumb' ? 'image/jpeg' : 'video/mp4');
  });
}

module.exports = {
  clipPath,
  thumbPath,
  save,
  list,
  trash,
  show,
  openFolder,
  registerScheme,
  handleProtocol,
};
