import {
  DEFAULT_RESOLUTION,
  findDevice,
  findResolution,
  listDevices,
  logTrackInfo,
  openVideo,
  supportedResolutions,
} from './capture.js';
import { createAudioOutput } from './audio.js';
import { createInfoPanel, createOverlay } from './overlay.js';
import { closeOpenMenu, createSelect } from './select.js';
import { createClipAudio } from './clipaudio.js';
import { createReplayBuffer } from './replay.js';
import { createBrowserShare } from './share.js';

const NO_AUDIO = 'none';
const RETRY_DELAY_MS = 1500;
// Logo depois de reconectar, a placa pode recusar a abertura por alguns instantes.
const OPEN_ATTEMPTS = 3;
const VIDEO_ICON =
  '<svg class="cm-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="14" height="12" rx="2"></rect><path d="M16 10.5l6-3.5v10l-6-3.5"></path></svg>';
const AUDIO_ICON =
  '<svg class="cm-i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h3l2-5 3 11 3-14 3 11 1.5-3H22"></path></svg>';
const RESOLUTION_ICON =
  '<svg class="cm-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 18v3"></path></svg>';
const MIC_ICON =
  '<svg class="cm-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"></path></svg>';
const THUMB_WIDTH = 320;

const $ = (selector) => document.querySelector(selector);

const video = $('#video');
const setup = $('#setup');
const picker = $('#picker');
const pickerMessage = $('#message');
const startButton = $('#start');
const statusScreen = $('#status');
const statusBox = $('.cm-status');
const statusTitle = $('#status-title');
const statusText = $('#status-text');
const retryButton = $('#retry');
const overlayMessage = $('#overlay-message');
const muteButton = $('#mute');
const volumeSlider = $('#volume');
const volumeFill = $('#volume-fill');
const volumePct = $('#volume-pct');
const recDot = $('#rec');
const clipButtons = { 30: $('#clip-30'), 60: $('#clip-60'), 300: $('#clip-300') };
const collectionButton = $('#collection');
const shareButton = $('#share');
const latencyButton = $('#latency');

const api = window.captureMirror;
const output = createAudioOutput(api);
const overlay = createOverlay($('#overlay'));
const infoPanel = createInfoPanel($('#info'), video);
const clipAudio = createClipAudio(api);
const share = createBrowserShare({
  api,
  audioTrack: () => output.shareTrack(),
  onChange: (connected) => {
    // A guia toca o mesmo som. Se o app também tocasse, ele sairia dobrado.
    output.setLocalOutput(!connected);
    render();
  },
});
const replay = createReplayBuffer({
  onError: (error) => {
    clipErrors.replay = error;
    render();
  },
});

const pickerVideo = createSelect($('#video-device'), {
  label: 'Seletor de vídeo',
  direction: 'down',
  onChange: () => renderSelects(),
});
const pickerAudio = createSelect($('#audio-device'), {
  label: 'Seletor de áudio',
  direction: 'up',
  onChange: () => renderSelects(),
});
const overlayVideo = createSelect($('#overlay-video'), {
  label: 'Seletor de vídeo',
  direction: 'up',
  icon: VIDEO_ICON,
  onChange: (value) => chooseFromOverlay('video', value),
});
const overlayResolution = createSelect($('#overlay-resolution'), {
  label: 'Resolução da imagem',
  direction: 'up',
  icon: RESOLUTION_ICON,
  onChange: (value) => chooseResolution(value),
});
const overlayAudio = createSelect($('#overlay-audio'), {
  label: 'Seletor de áudio',
  direction: 'up',
  icon: AUDIO_ICON,
  onChange: (value) => chooseFromOverlay('audio', value),
});
const overlayMic = createSelect($('#overlay-mic'), {
  label: 'Microfone no clipe',
  direction: 'up',
  icon: MIC_ICON,
  onChange: (value) => chooseClipMic(value),
});

// O que a pessoa escolheu. sync() faz o que está aberto corresponder a isto.
const desired = { video: null, audio: null };
const live = { video: null, audio: null };
const errors = { video: null, audio: null };
const failedAttempts = { video: 0, audio: 0 };

// audio: entradas do Windows, para o som da placa (motor nativo).
// mic: entradas do Chromium, para o microfone dos clipes (getUserMedia).
let devices = { video: [], audio: [], mic: [] };
let muted = false;
// Modo raw: o som da placa pula os efeitos do Windows (Dolby e afins).
let lowLatency = true;
let audioInfo = null;
// Microfone que entra só nos clipes. null = nenhum.
let desiredMic = null;
let desiredResolution = DEFAULT_RESOLUTION;
// Modos que a placa aberta suporta, lidos das capacidades da faixa de vídeo.
let videoCapabilities = null;
// Enquanto a placa reabre noutro modo, a tela de "Sem sinal" não aparece.
let switchingResolution = false;
const clipErrors = { replay: null, loopback: null, mic: null, save: null };
let clipping = false;
let shortcuts = { shortcuts: [], failed: [] };
let retryTimer = null;
let syncing = false;
let syncAgain = false;

const describe = ({ deviceId, label }) => ({ id: deviceId, label });
const toOption = ({ deviceId, label }) => ({ value: deviceId, label: label || 'Sem nome' });

function disconnectedLabel(list, wanted) {
  return wanted && !findDevice(list, wanted) ? `${wanted.label} (desconectado)` : '';
}

function renderSelects() {
  const videoOptions = devices.video.map(toOption);
  const keptVideo = videoOptions.some(({ value }) => value === pickerVideo.value);
  pickerVideo.setOptions(
    videoOptions,
    keptVideo ? pickerVideo.value : (videoOptions[0]?.value ?? ''),
    'Nenhum dispositivo',
  );

  // Sem placa, o seletor de áudio também fica inativo, como no protótipo.
  // O áudio começa sem escolha: se viesse um microfone por padrão, o som dele
  // sairia nos alto-falantes e poderia causar microfonia.
  const audioChoices = [{ value: NO_AUDIO, label: 'Sem áudio' }, ...devices.audio.map(toOption)];
  const keptAudio = audioChoices.some(({ value }) => value === pickerAudio.value);
  pickerAudio.setOptions(
    videoOptions.length ? audioChoices : [],
    keptAudio ? pickerAudio.value : '',
    videoOptions.length ? 'Selecione...' : 'Nenhum dispositivo',
  );
  startButton.disabled = !pickerVideo.value || !pickerAudio.value;

  overlayVideo.setOptions(videoOptions, desired.video?.id ?? '', disconnectedLabel(devices.video, desired.video));
  overlayResolution.setOptions(
    supportedResolutions(videoCapabilities).map(({ id, label }) => ({ value: id, label })),
    desiredResolution,
    findResolution(desiredResolution).label,
  );
  overlayAudio.setOptions(
    audioChoices,
    desired.audio?.id ?? NO_AUDIO,
    disconnectedLabel(devices.audio, desired.audio),
  );
  overlayMic.setOptions(
    [{ value: NO_AUDIO, label: 'Sem microfone no clipe' }, ...devices.mic.map(toOption)],
    desiredMic?.id ?? NO_AUDIO,
    disconnectedLabel(devices.mic, desiredMic),
  );
}

function statusContent() {
  const error = errors.video;
  if (!error) {
    return {
      title: 'Sem sinal',
      text: 'Reconectando automaticamente quando a placa voltar',
      isError: false,
    };
  }
  if (error.name === 'NotReadableError') {
    return {
      title: 'Placa em uso por outro aplicativo',
      text: 'Feche o outro programa que está usando a placa, como o OBS, e tente de novo.',
      isError: true,
    };
  }
  return {
    title: 'Não foi possível abrir a placa',
    text: `Desconecte a placa do USB e conecte de novo. (${error.name})`,
    isError: true,
  };
}

function audioMessage() {
  if (!desired.audio || live.audio) {
    if (muted) return 'Silenciado. A transmissão e os clipes também ficam sem som.';
    return share.connected && desired.audio ? 'O som está saindo pela guia do navegador.' : '';
  }
  return errors.audio ? `Não foi possível abrir o áudio (${errors.audio.name}).` : 'Dispositivo de áudio desconectado.';
}

function clipMessage() {
  const { replay: replayError, loopback, mic, save } = clipErrors;
  if (save) return `Não foi possível salvar o clipe (${save.name}).`;
  if (replayError) return `Clipes indisponíveis (${replayError.name}).`;
  if (loopback) return `Os clipes estão sem o som do PC (${loopback.name}).`;
  if (mic) return `Não foi possível abrir o microfone do clipe (${mic.name}).`;
  if (shortcuts.failed.length) return `Atalho em uso por outro aplicativo: ${shortcuts.failed.join(', ')}.`;
  return '';
}

// "os últimos 30 s", "o último minuto", "os últimos 5 minutos".
function clipSpan(seconds) {
  if (seconds === 60) return 'o último minuto';
  return seconds > 60 ? `os últimos ${seconds / 60} minutos` : `os últimos ${seconds} s`;
}

function renderClipControls() {
  const ready = replay.running && !clipping;
  recDot.hidden = !replay.running;
  recDot.title = 'Guardando o último minuto na memória para os clipes';
  for (const shortcut of shortcuts.shortcuts) {
    const button = clipButtons[shortcut.seconds];
    if (!button) continue;
    button.disabled = !ready;
    const label = clipSpan(shortcut.seconds);
    button.title = `Clipar ${label} (${shortcut.label})`;
    button.setAttribute('aria-label', button.title);
  }
}

function render() {
  const inSetup = !desired.video;
  setup.hidden = !inSetup;
  overlay.setEnabled(!inSetup);

  statusScreen.hidden = inSetup || Boolean(live.video) || switchingResolution;
  if (!statusScreen.hidden) {
    const { title, text, isError } = statusContent();
    statusTitle.textContent = title;
    statusText.textContent = text;
    statusBox.classList.toggle('is-error', isError);
    retryButton.hidden = !isError;
  }

  pickerMessage.textContent = devices.video.length
    ? ''
    : 'Nenhuma placa de captura encontrada. Conecte a placa ao USB.';

  const note = [audioMessage(), clipMessage()].filter(Boolean).join(' ');
  overlayMessage.textContent = note;
  overlayMessage.hidden = !note;

  const muteLabel = muted ? 'Ativar o som (M)' : 'Silenciar (M)';
  muteButton.setAttribute('aria-pressed', String(muted));
  muteButton.setAttribute('aria-label', muteLabel);
  muteButton.title = muteLabel;
  document.body.classList.toggle('is-muted', muted);

  const shareLabel = share.connected
    ? 'Guia do navegador conectada. Clique para abrir outra.'
    : 'Abrir numa guia do navegador, para compartilhar com som no Google Meet';
  shareButton.setAttribute('aria-pressed', String(share.connected));
  shareButton.setAttribute('aria-label', shareLabel);
  shareButton.title = shareLabel;

  const latencyLabel = !lowLatency
    ? 'Baixa latência desligada: o som passa pelos efeitos do Windows. Clique para ligar.'
    : audioInfo && !audioInfo.raw
      ? 'Baixa latência ligada, mas a saída de som não aceitou pular os efeitos do Windows.'
      : 'Baixa latência: o som da placa pula os efeitos do Windows (Dolby e afins). Clique para desligar.';
  latencyButton.setAttribute('aria-pressed', String(lowLatency));
  latencyButton.setAttribute('aria-label', latencyLabel);
  latencyButton.title = latencyLabel;
  renderClipControls();
}

function renderVolume() {
  volumeFill.style.width = `${volumeSlider.value}%`;
  volumePct.textContent = `${volumeSlider.value}%`;
}

function close(kind) {
  live[kind]?.stream.getTracks().forEach((track) => track.stop());
  live[kind] = null;
  if (kind === 'video') {
    video.srcObject = null;
    share.setVideoTrack(null);
    replay.stop().then(render);
  } else {
    output.close();
  }
}

// O buffer começa junto com a imagem e para quando a placa sai.
async function startReplay(stream) {
  try {
    await clipAudio.startLoopback();
    clipErrors.loopback = null;
  } catch (error) {
    // Sem o som do PC, os clipes ainda saem com a imagem (e o microfone, se houver).
    console.error(`loopback: ${error.name}: ${error.message}`);
    clipErrors.loopback = error;
  }
  if (live.video?.stream !== stream) return;
  clipErrors.replay = null;
  await replay.start(stream.getVideoTracks()[0].clone(), clipAudio.track?.clone() ?? null);
  syncMic();
  render();
}

// O microfone só fica aberto enquanto a imagem está no ar.
function syncMic() {
  const device = live.video && desiredMic ? findDevice(devices.mic, desiredMic) : null;
  clipAudio
    .setMic(device?.deviceId ?? null)
    .then(() => {
      if (clipErrors.mic && clipAudio.micId) {
        clipErrors.mic = null;
        render();
      }
    })
    .catch((error) => {
      console.error(`microfone do clipe: ${error.name}: ${error.message}`);
      clipErrors.mic = error;
      render();
    });
}

function chooseClipMic(value) {
  const device = devices.mic.find(({ deviceId }) => deviceId === value);
  desiredMic = device ? describe(device) : null;
  api.saveSettings({ clipMic: desiredMic });
  clipErrors.mic = null;
  syncMic();
  renderSelects();
  render();
}

// Miniatura para a coleção: o quadro que está na tela no momento do clipe.
async function grabThumbnail() {
  if (!video.videoWidth) return null;
  const canvas = new OffscreenCanvas(THUMB_WIDTH, Math.round((THUMB_WIDTH * video.videoHeight) / video.videoWidth));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return blob.arrayBuffer();
}

async function saveClip(seconds) {
  if (clipping || !replay.running) return;
  clipping = true;
  render();
  // A miniatura é o quadro na tela no momento do pedido.
  let started = false;
  try {
    if (!replay.hasPackets) return;
    await api.beginClip(await grabThumbnail());
    started = true;
    const result = await replay.clip(seconds, (position, data) => api.writeClip(position, data));
    if (!result) {
      api.abortClip();
      return;
    }
    await api.finishClip(result.duration);
    clipErrors.save = null;
  } catch (error) {
    if (started) api.abortClip();
    console.error(`clipe: ${error.name}: ${error.message}`);
    clipErrors.save = error;
    overlay.show();
  } finally {
    clipping = false;
    render();
  }
}

function clearErrors() {
  for (const kind of ['video', 'audio']) {
    errors[kind] = null;
    failedAttempts[kind] = 0;
  }
}

// variant distingue aberturas do mesmo dispositivo, como a resolução do vídeo.
async function open(kind, opener, attach, variant = '') {
  const wanted = desired[kind];
  if (!wanted) {
    close(kind);
    return;
  }
  if (live[kind]?.id === wanted.id && live[kind].variant === variant) return;
  close(kind);

  const device = findDevice(devices[kind], wanted);
  if (!device || errors[kind]) return;

  if (device.deviceId !== wanted.id) {
    desired[kind] = describe(device);
    api.saveSettings({ [kind]: desired[kind] });
  }

  try {
    const stream = await opener(device.deviceId);
    stream.getTracks().forEach(logTrackInfo);
    live[kind] = { id: device.deviceId, variant, stream };
    failedAttempts[kind] = 0;
    await attach(stream);
    // A placa saiu do USB: este evento dispara, e o stream não volta mais.
    stream.getTracks()[0].addEventListener('ended', () => {
      if (live[kind]?.stream !== stream) return;
      close(kind);
      sync();
    });
  } catch (error) {
    console.error(`${kind}: ${error.name}: ${error.message}`);
    const deviceGone = error.name === 'OverconstrainedError' || error.name === 'NotFoundError';
    failedAttempts[kind] += 1;
    if (!deviceGone && failedAttempts[kind] >= OPEN_ATTEMPTS) errors[kind] = error;
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  // Além do devicechange, tenta de novo com o tempo, porque ele pode disparar
  // antes de a placa estar pronta. Com erro, espera a pessoa agir.
  const pending = ['video', 'audio'].some((kind) => desired[kind] && !live[kind] && !errors[kind]);
  if (pending) retryTimer = setTimeout(sync, RETRY_DELAY_MS);
}

// Fila de uma posição: abrir um dispositivo é lento, e duas aberturas ao mesmo
// tempo poderiam deixar um stream perdido sem ninguém para fechá-lo.
// Vídeo e microfone vêm do Chromium; o som da placa, do Windows (motor nativo).
async function loadDevices() {
  const { video, audio: mic } = await listDevices();
  let audio = [];
  try {
    audio = (await api.audio.list()).map(({ id, label }) => ({ deviceId: id, label, kind: 'audioinput' }));
  } catch (error) {
    console.error(`dispositivos de áudio: ${error.name}: ${error.message}`);
  }
  return { video, audio, mic };
}

async function sync() {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      devices = await loadDevices();
      await open(
        'video',
        (deviceId) => openVideo(deviceId, desiredResolution),
        (stream) => {
          video.srcObject = stream;
          share.setVideoTrack(stream.getVideoTracks()[0]);
          videoCapabilities = stream.getVideoTracks()[0].getCapabilities?.() ?? null;
          startReplay(stream).catch((error) => {
            clipErrors.replay = error;
            render();
          });
        },
        desiredResolution,
      );
      switchingResolution = false;
      await open(
        'audio',
        (deviceId) => output.open(deviceId, devices.audio.find((item) => item.deviceId === deviceId)?.label ?? ''),
        () => {},
      );
      syncMic();
      renderSelects();
      render();
    } while (syncAgain);
  } finally {
    syncing = false;
  }
  scheduleRetry();
}

function choose(kind, value) {
  const device = devices[kind].find(({ deviceId }) => deviceId === value);
  desired[kind] = device ? describe(device) : null;
  api.saveSettings({ [kind]: desired[kind] });
}

function chooseFromOverlay(kind, value) {
  clearErrors();
  choose(kind, value);
  sync();
}

// Trocar o modo reabre a placa. O buffer de clipes recomeça junto, porque
// pacotes de resoluções diferentes não cabem no mesmo arquivo.
function chooseResolution(value) {
  desiredResolution = findResolution(value).id;
  api.saveSettings({ resolution: desiredResolution });
  switchingResolution = Boolean(live.video);
  clearErrors();
  sync();
}

function toggleMute() {
  muted = !muted;
  output.setMuted(muted);
  render();
  // Mute também silencia o stream, então o estado precisa ficar visível.
  overlay.show();
}

picker.addEventListener('submit', (event) => {
  event.preventDefault();
  clearErrors();
  choose('video', pickerVideo.value);
  choose('audio', pickerAudio.value);
  sync();
});

retryButton.addEventListener('click', () => {
  clearErrors();
  sync();
});

muteButton.addEventListener('click', toggleMute);
latencyButton.addEventListener('click', () => {
  lowLatency = !lowLatency;
  output.setLowLatency(lowLatency);
  api.saveSettings({ lowLatency });
  render();
  overlay.show();
});
output.onInfo((info) => {
  audioInfo = info;
  render();
});
clipButtons[30].addEventListener('click', () => saveClip(30));
clipButtons[60].addEventListener('click', () => saveClip(60));
clipButtons[300].addEventListener('click', () => saveClip(300));
collectionButton.addEventListener('click', () => api.openCollection());
shareButton.addEventListener('click', () => api.openShare());
api.onClipRequest((seconds) => saveClip(seconds));
volumeSlider.addEventListener('input', () => {
  output.setVolume(volumeSlider.value / 100);
  renderVolume();
  overlay.show();
});
volumeSlider.addEventListener('change', () => api.saveSettings({ volume: volumeSlider.value / 100 }));

document.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  const inSetup = !desired.video;
  if (event.key === 'F11') {
    event.preventDefault();
    api.toggleFullscreen();
  } else if (event.key === 'Escape') {
    if (!closeOpenMenu()) api.exitFullscreen();
  } else if (inSetup) {
    return;
  } else if (event.key === 'F1') {
    event.preventDefault();
    infoPanel.toggle();
  } else if (event.key.toLowerCase() === 'm') {
    event.preventDefault();
    toggleMute();
  } else if (event.key === 'Tab' || event.key.startsWith('Arrow')) {
    // O overlay escondido é inerte: sem isto, o teclado não chegaria aos controles.
    overlay.show();
  }
});

// O Windows avisa de dispositivos de som que o Chromium pode não listar.
api.audio.onDevicesChanged(() => sync());
navigator.mediaDevices.addEventListener('devicechange', () => {
  clearErrors();
  sync();
});

const saved = await api.loadSettings();
desired.video = saved.video;
desired.audio = saved.audio;
desiredMic = saved.clipMic;
desiredResolution = findResolution(saved.resolution).id;
shortcuts = await api.clipShortcuts();
lowLatency = saved.lowLatency !== false;
output.setLowLatency(lowLatency);
volumeSlider.value = Math.round(saved.volume * 100);
output.setVolume(saved.volume);
renderVolume();
sync();
share.start();
