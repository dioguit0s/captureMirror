// O som precisa sair do processo do Electron, que é o que o Discord captura.
// Por isso, volume e mute também afetam o que vai para o stream.
//
// placa ─> gain (volume e mute) ─┬─> local (alto-falantes) ─> destination
//                                └─> share (modo navegador, sem passar pelo local)
export function createAudioOutput() {
  let context = null;
  let gain = null;
  let local = null;
  let share = null;
  let source = null;
  let volume = 1;
  let muted = false;
  let localEnabled = true;

  const applyGain = () => {
    if (gain) gain.gain.value = muted ? 0 : volume;
    if (local) local.gain.value = localEnabled ? 1 : 0;
  };

  function ensureContext() {
    if (context) return;
    // Mesma taxa da captura, para evitar reamostragem.
    context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    gain = context.createGain();
    local = context.createGain();
    gain.connect(local);
    local.connect(context.destination);
    applyGain();
  }

  return {
    async setStream(stream) {
      source?.disconnect();
      source = null;
      if (!stream) return;
      ensureContext();
      source = context.createMediaStreamSource(stream);
      source.connect(gain);
      await context.resume();
    },
    setVolume(value) {
      volume = value;
      applyGain();
    },
    setMuted(value) {
      muted = value;
      applyGain();
    },
    // Com a guia do navegador tocando o mesmo som, o app se cala para não dobrar.
    setLocalOutput(enabled) {
      localEnabled = enabled;
      applyGain();
    },
    // Faixa que sempre existe, mesmo sem placa de áudio: a conexão com a guia
    // não precisa ser refeita quando o dispositivo de áudio muda.
    shareTrack() {
      ensureContext();
      if (!share) {
        share = context.createMediaStreamDestination();
        share.channelCount = 2;
        gain.connect(share);
      }
      context.resume();
      return share.stream.getAudioTracks()[0];
    },
  };
}
