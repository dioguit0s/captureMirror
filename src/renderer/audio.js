// O som precisa sair do processo do Electron, que é o que o Discord captura.
// Por isso, volume e mute também afetam o que vai para o stream.
export function createAudioOutput() {
  let context = null;
  let gain = null;
  let source = null;
  let volume = 1;
  let muted = false;

  const applyGain = () => {
    if (gain) gain.gain.value = muted ? 0 : volume;
  };

  return {
    async setStream(stream) {
      source?.disconnect();
      source = null;
      if (!stream) return;
      if (!context) {
        // Mesma taxa da captura, para evitar reamostragem.
        context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
        gain = context.createGain();
        gain.connect(context.destination);
        applyGain();
      }
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
  };
}
