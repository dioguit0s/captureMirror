// Ponte com o lado nativo (Rust). Tem o mesmo formato do antigo preload do Electron,
// e por isso o resto do renderer não precisa saber que o app roda no Tauri.
// Carregado antes dos outros módulos: eles leem window.captureMirror ao iniciar.
const { invoke, Channel } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const on = (event, listener) => {
  listen(event, ({ payload }) => listener(payload));
};

// Chamadas sem resposta: um erro só vai para o console.
const fire = (command, args) => {
  invoke(command, args).catch((error) => console.error(`${command}: ${error}`));
};

window.captureMirror = {
  loadSettings: () => invoke('settings_load'),
  saveSettings: (patch) => fire('settings_save', { patch }),
  toggleFullscreen: () => fire('window_toggle_fullscreen'),
  exitFullscreen: () => fire('window_exit_fullscreen'),

  // Clipes. O MP4 vai em blocos binários, com a posição de cada um: um clipe de
  // 5 min passa de 300 MB e não cabe numa chamada só.
  clipShortcuts: () => invoke('clips_shortcuts'),
  beginClip: (thumb) => invoke('clips_begin', new Uint8Array(thumb ?? new ArrayBuffer(0))),
  writeClip: (position, data) => invoke('clips_write', data, { headers: { 'x-position': String(position) } }),
  finishClip: (duration) => invoke('clips_finish', new Uint8Array(0), { headers: { 'x-duration': String(duration) } }),
  abortClip: () => fire('clips_abort'),
  listClips: () => invoke('clips_list'),
  trashClip: (name) => invoke('clips_trash', { name }),
  showClip: (name) => fire('clips_show', { name }),
  openClipsFolder: () => fire('clips_open_folder'),
  openCollection: () => fire('collection_open'),
  startDrag: (name) => fire('clips_drag', { name }),
  onClipRequest: (listener) => on('clip:request', listener),
  onClipsChanged: (listener) => on('clips:changed', () => listener()),

  // Modo navegador
  shareCurrent: () => invoke('share_current'),
  openShare: () => fire('share_open'),
  sendShareOffer: (id, description) => fire('share_offer', { id, description }),
  sendShareStatus: (status) => fire('share_status', { status }),
  onShareViewer: (listener) => on('share:viewer', listener),
  onShareAnswer: (listener) => on('share:answer', ({ id, description }) => listener(id, description)),

  // Áudio nativo: a placa toca pelo WASAPI, sem passar pelo Chromium.
  audio: {
    list: () => invoke('audio_list'),
    open: (id, generation) => invoke('audio_open', { id, generation }),
    close: (generation) => fire('audio_close', { generation }),
    setVolume: (value) => fire('audio_set_volume', { value }),
    setMuted: (value) => fire('audio_set_muted', { value }),
    setLocal: (enabled) => fire('audio_set_local', { enabled }),
    setLowLatency: (enabled) => fire('audio_set_low_latency', { enabled }),
    onDevicesChanged: (listener) => on('audio:devices', () => listener()),
    onStatus: (listener) => on('audio:status', listener),
    // Som do PC (loopback) para os clipes: blocos PCM float intercalados.
    startLoopback: (onChunk) => {
      const channel = new Channel();
      channel.onmessage = onChunk;
      return invoke('loopback_start', { channel });
    },
    stopLoopback: () => fire('loopback_stop'),
  },
};
