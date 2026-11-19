// Recebe a imagem e o som do Capture Mirror por WebRTC. A guia existe para o
// Meet poder compartilhar o som: ele não compartilha som de janelas.

const HINT_MS = 8000;
const IDLE_MS = 2000;
const RECONNECT_MS = 1000;
const GATHER_TIMEOUT_MS = 1500;

const $ = (selector) => document.querySelector(selector);
const video = $('#video');
const card = $('#card');
const cardTitle = $('#card-title');
const cardText = $('#card-text');
const cardAction = $('#card-action');
const hint = $('#hint');

const media = new MediaStream();
video.srcObject = media;

let events = null;
let viewer = null;
let pc = null;
let hasVideo = true;
let connected = false;
let replaced = false;
let needsClick = false;
let hintShown = false;
let hintTimer = null;
let idleTimer = null;

// Os elementos começam com o atributo hidden, para não piscarem antes do script.
for (const element of [card, hint]) {
  element.classList.add('is-hidden');
  element.hidden = false;
}

function setVisible(element, visible) {
  element.classList.toggle('is-hidden', !visible);
  element.inert = !visible;
}

function cardContent() {
  if (replaced) {
    return {
      title: 'Esta guia foi desconectada',
      text: 'O Capture Mirror foi aberto em outra guia.',
      action: 'Usar esta guia',
    };
  }
  if (!connected) {
    return {
      title: 'Esperando o Capture Mirror',
      text: 'Deixe o app aberto. Esta guia se conecta sozinha.',
    };
  }
  if (needsClick) {
    return {
      title: 'Clique para ligar a imagem e o som',
      text: 'O navegador só toca som depois de um clique na página.',
      action: 'Começar',
    };
  }
  if (!hasVideo) {
    return { title: 'Sem sinal', text: 'A imagem volta sozinha quando a placa voltar.' };
  }
  return null;
}

function render() {
  const content = cardContent();
  setVisible(card, Boolean(content));
  if (content) {
    cardTitle.textContent = content.title;
    cardText.textContent = content.text ?? '';
    cardAction.textContent = content.action ?? '';
    cardAction.hidden = !content.action;
  }
}

// A instrução aparece uma vez, quando a imagem entra, e some antes de a pessoa
// começar a compartilhar.
function showHint() {
  if (hintShown) return;
  hintShown = true;
  setVisible(hint, true);
  hintTimer = setTimeout(() => setVisible(hint, false), HINT_MS);
}

async function play() {
  try {
    await video.play();
    needsClick = false;
    if (connected && hasVideo) showHint();
  } catch (error) {
    // Sem um clique na página, o Chrome não deixa tocar som.
    if (error.name === 'NotAllowedError') needsClick = true;
  }
  render();
}

function waitForCandidates(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      resolve();
    });
  });
}

function closePeer() {
  pc?.close();
  pc = null;
  for (const track of media.getTracks()) media.removeTrack(track);
  connected = false;
}

function reconnect() {
  events?.close();
  events = null;
  closePeer();
  render();
  setTimeout(openEvents, RECONNECT_MS);
}

async function acceptOffer(description) {
  closePeer();
  const current = new RTCPeerConnection({ iceServers: [] });
  pc = current;

  current.addEventListener('track', ({ track, receiver }) => {
    // Menor atraso possível: dentro do PC quase não há variação na chegada.
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    else if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
    media.addTrack(track);
  });

  current.addEventListener('connectionstatechange', () => {
    if (pc !== current) return;
    const state = current.connectionState;
    if (state === 'connected') {
      connected = true;
      play();
    } else if (state === 'failed') {
      // Uma conexão nova recomeça do zero: o app faz outra oferta.
      reconnect();
    }
    render();
  });

  try {
    await current.setRemoteDescription(description);
    await current.setLocalDescription(await current.createAnswer());
    await waitForCandidates(current);
    if (pc !== current) return;
    const { type, sdp } = current.localDescription;
    await fetch('/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: viewer, description: { type, sdp } }),
    });
  } catch (error) {
    console.error(`Capture Mirror: ${error.name}: ${error.message}`);
    if (pc === current) reconnect();
  }
}

function openEvents() {
  if (events) return;
  replaced = false;
  const source = new EventSource('/events');
  events = source;

  source.addEventListener('hello', ({ data }) => {
    viewer = JSON.parse(data).id;
  });
  source.addEventListener('offer', ({ data }) => acceptOffer(JSON.parse(data).description));
  source.addEventListener('status', ({ data }) => {
    hasVideo = JSON.parse(data).video;
    if (hasVideo && connected && !needsClick) showHint();
    render();
  });
  source.addEventListener('replaced', () => {
    // Sem fechar, o EventSource reconectaria sozinho e tomaria a vez da outra guia.
    source.close();
    events = null;
    replaced = true;
    closePeer();
    render();
  });
  // O app fechou ou reiniciou. O EventSource tenta de novo sozinho.
  source.addEventListener('error', () => {
    if (events !== source) return;
    closePeer();
    render();
  });
}

cardAction.addEventListener('click', () => {
  if (replaced) openEvents();
  else play();
});

// Cursor some com o mouse parado, como no app.
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
});

window.addEventListener('pagehide', () => {
  clearTimeout(hintTimer);
  events?.close();
  closePeer();
});

render();
openEvents();
