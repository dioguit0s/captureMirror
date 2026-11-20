// Som da placa. Toca pelo motor nativo (Rust + WASAPI), e não pelo Chromium:
// medido no notebook de teste, são ~65 ms da placa até a mixagem do Windows,
// contra ~120 ms pelo Web Audio. A diferença vem do modo raw, que pula os efeitos
// do driver (Dolby e afins), e de uma fila mínima.
//
// O som precisa sair do processo do app, que é o que o Discord captura. Por isso,
// volume e mute também afetam o que vai para o stream.
//
// placa ─> motor nativo (volume, mute) ─> alto-falantes
//      └─> getUserMedia ─> gain ─> share   (só com uma guia do modo navegador conectada)
//
// O modo navegador manda o som por WebRTC, que precisa de uma faixa do Chromium.
// Enquanto a guia está conectada, o app se cala e a placa também abre aqui.

// O Chromium põe o id USB no fim do nome ("... (534d:2109)"); o Windows, não.
export const sameDevice = (a, b) => Boolean(a && b) && (a === b || a.startsWith(`${b} (`) || b.startsWith(`${a} (`));

function nativeTrack(native, generation, label) {
  const track = new EventTarget();
  let info = {};
  Object.assign(track, {
    kind: 'audio',
    label,
    readyState: 'live',
    stop() {
      if (track.readyState === 'ended') return;
      track.readyState = 'ended';
      native.close(generation);
    },
    getCapabilities: () => ({ motor: 'WASAPI' }),
    getSettings: () => ({ ...info }),
    setInfo(value) {
      info = value;
    },
  });
  return track;
}

export function createAudioOutput(api) {
  const native = api.audio;
  let generation = 0;
  let current = null;
  let volume = 1;
  let muted = false;
  let localEnabled = true;
  let onInfo = () => {};

  // Caminho do modo navegador, pelo Chromium.
  let context = null;
  let gain = null;
  let share = null;
  let source = null;
  let shareStream = null;
  let shareOpening = null;

  native.onStatus(({ generation: id, state, info }) => {
    if (current?.generation !== id) return;
    if (state === 'lost') {
      // A placa saiu: o app trata como uma faixa que terminou.
      current.track.readyState = 'ended';
      current.track.dispatchEvent(new Event('ended'));
    } else if (state === 'open') {
      current.track.setInfo(info);
      onInfo(info);
    }
  });

  const applyGain = () => {
    if (gain) gain.gain.value = muted ? 0 : volume;
  };

  function ensureContext() {
    if (context) return;
    context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    gain = context.createGain();
    applyGain();
  }

  function stopShareSource() {
    source?.disconnect();
    source = null;
    shareStream?.getTracks().forEach((track) => track.stop());
    shareStream = null;
  }

  // Abre a mesma placa pelo Chromium, só para a guia.
  async function startShareSource() {
    if (localEnabled || !current || shareStream || shareOpening) return;
    const label = current.track.label;
    shareOpening = (async () => {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const device = devices.find((item) => item.kind === 'audioinput' && sameDevice(item.label, label));
      if (!device) throw new DOMException(`placa não encontrada no Chromium: ${label}`, 'NotFoundError');
      return navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: device.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    })();
    try {
      const stream = await shareOpening;
      if (localEnabled || current?.track.label !== label) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      ensureContext();
      shareStream = stream;
      source = context.createMediaStreamSource(stream);
      source.connect(gain);
      await context.resume();
    } catch (error) {
      console.error(`som da guia: ${error.name}: ${error.message}`);
    } finally {
      shareOpening = null;
    }
  }

  return {
    // Devolve algo com a forma de um MediaStream, para o app tratar a placa de
    // som como trata a de vídeo (abrir, fechar, saber quando ela sai).
    async open(deviceId, label) {
      generation += 1;
      const id = generation;
      const track = nativeTrack(native, id, label);
      current = { generation: id, track };
      try {
        const info = await native.open(deviceId, id);
        track.setInfo(info);
        onInfo(info);
      } catch (error) {
        if (current?.generation === id) current = null;
        throw Object.assign(new Error(error?.message ?? String(error)), { name: error?.name ?? 'AbortError' });
      }
      native.setVolume(volume);
      native.setMuted(muted);
      native.setLocal(localEnabled);
      stopShareSource();
      startShareSource();
      return { getTracks: () => [track] };
    },
    close() {
      current?.track.stop();
      current = null;
      stopShareSource();
    },
    setVolume(value) {
      volume = value;
      native.setVolume(value);
      applyGain();
    },
    setMuted(value) {
      muted = value;
      native.setMuted(value);
      applyGain();
    },
    // Com a guia do navegador tocando o mesmo som, o app se cala para não dobrar.
    setLocalOutput(enabled) {
      localEnabled = enabled;
      native.setLocal(enabled);
      if (enabled) stopShareSource();
      else startShareSource();
    },
    setLowLatency(enabled) {
      return native.setLowLatency(enabled);
    },
    onInfo(listener) {
      onInfo = listener;
    },
    // Faixa que sempre existe, mesmo sem placa: a conexão com a guia não precisa
    // ser refeita quando o dispositivo de áudio muda.
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
