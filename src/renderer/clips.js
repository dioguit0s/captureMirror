// Coleção de clipes. Fica numa janela separada para não aparecer no Go Live.
const $ = (selector) => document.querySelector(selector);

const api = window.captureMirror;
const grid = $('#grid');
const empty = $('#empty');
const count = $('#count');
const template = $('#card');
const player = $('#player');
const playerVideo = $('#player-video');
const playerName = $('#player-name');

let current = null;

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function formatDuration(seconds) {
  if (seconds == null) return '';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${mb.toLocaleString('pt-BR', { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}

function openPlayer(clip) {
  current = clip;
  playerName.textContent = clip.name;
  playerName.title = clip.name;
  playerVideo.src = clip.url;
  player.showModal();
  playerVideo.play().catch(() => {});
}

function closePlayer() {
  if (player.open) player.close();
}

// Ao fechar (botão, Esc ou exclusão), o arquivo é solto para poder ir para a Lixeira.
player.addEventListener('close', () => {
  playerVideo.pause();
  playerVideo.removeAttribute('src');
  playerVideo.load();
  current = null;
});

function card(clip) {
  const item = template.content.firstElementChild.cloneNode(true);
  const thumb = item.querySelector('.cl-thumb');
  const image = item.querySelector('img');
  if (clip.thumb) image.src = clip.thumb;
  item.querySelector('.cl-duration').textContent = formatDuration(clip.duration);
  item.querySelector('.cl-date').textContent = dateFormat.format(clip.date);
  item.querySelector('.cl-size').textContent = formatSize(clip.size);
  thumb.title = `${clip.name}\nClique para assistir. Arraste para o Discord ou outra pasta.`;
  thumb.setAttribute('aria-label', `Assistir ${clip.name}`);
  thumb.addEventListener('click', () => openPlayer(clip));
  // O arrasto nativo do Electron leva o arquivo de verdade, e não só um link.
  thumb.addEventListener('dragstart', (event) => {
    event.preventDefault();
    api.startDrag(clip.name);
  });
  return item;
}

async function refresh() {
  const clips = await api.listClips();
  grid.replaceChildren(...clips.map(card));
  count.textContent = clips.length === 1 ? '1 clipe' : `${clips.length} clipes`;
  empty.hidden = clips.length > 0;
  const shortcuts = await api.clipShortcuts();
  empty.textContent = `Nenhum clipe ainda. Enquanto espelha a placa, use ${shortcuts.shortcuts
    .map(({ label, seconds }) => `${label} (${seconds === 60 ? '1 min' : `${seconds} s`})`)
    .join(' ou ')}, ou os botões do overlay.`;
  if (current && !clips.some(({ name }) => name === current.name)) closePlayer();
}

$('#open-folder').addEventListener('click', () => api.openClipsFolder());
$('#player-close').addEventListener('click', closePlayer);
$('#player-show').addEventListener('click', () => current && api.showClip(current.name));
$('#player-trash').addEventListener('click', async () => {
  if (!current) return;
  const { name } = current;
  closePlayer();
  await api.trashClip(name);
});
// Clique fora do vídeo, no fundo escuro, fecha o player.
player.addEventListener('click', (event) => {
  if (event.target === player) closePlayer();
});

api.onClipsChanged(refresh);
refresh();
