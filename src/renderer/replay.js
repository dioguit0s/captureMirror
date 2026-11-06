import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from '../../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs';

// Buffer de replay: vídeo e áudio são codificados o tempo todo e só os pacotes dos
// últimos segundos ficam na memória. Nada vai para o disco até alguém clipar.
export const MAX_CLIP_SECONDS = 60;
// Margem de um quadro-chave: o corte começa sempre num quadro-chave.
const KEEP_US = (MAX_CLIP_SECONDS + 2) * 1e6;
const KEYFRAME_INTERVAL_US = 1e6;
// Se o encoder ficar para trás, descarta quadros em vez de acumular atraso e memória.
const MAX_ENCODE_QUEUE = 8;
const AUDIO_BITRATE = 160_000;
// Um quadro AAC tem 1024 amostras: é a duração do último pacote de áudio do clipe.
const AAC_FRAME_US = (1024 / 48000) * 1e6;

// 8 Mbps em 720p60, proporcional para outras resoluções e taxas.
const videoBitrate = (width, height, fps) =>
  Math.round(Math.min(20e6, Math.max(2e6, (8e6 * width * height * fps) / (1280 * 720 * 60))));

// Em ordem de preferência. prefer-hardware falha no isConfigSupported se a GPU não
// tiver encoder, e aí cai para o software.
function videoCandidates(width, height, fps) {
  const base = { width, height, framerate: fps, bitrate: videoBitrate(width, height, fps), latencyMode: 'realtime' };
  const avc = { ...base, avc: { format: 'avc' } };
  return [
    { muxCodec: 'avc', config: { ...avc, codec: 'avc1.64002A', hardwareAcceleration: 'prefer-hardware' } },
    { muxCodec: 'avc', config: { ...avc, codec: 'avc1.4D402A', hardwareAcceleration: 'prefer-hardware' } },
    { muxCodec: 'avc', config: { ...avc, codec: 'avc1.64002A' } },
    { muxCodec: 'avc', config: { ...avc, codec: 'avc1.42002A' } },
    { muxCodec: 'vp9', config: { ...base, codec: 'vp09.00.41.08' } },
  ];
}

function audioCandidates(sampleRate, numberOfChannels) {
  const base = { sampleRate, numberOfChannels, bitrate: AUDIO_BITRATE };
  return [
    { muxCodec: 'aac', config: { ...base, codec: 'mp4a.40.2' } },
    { muxCodec: 'opus', config: { ...base, codec: 'opus' } },
  ];
}

async function pickConfig(Encoder, candidates) {
  for (const candidate of candidates) {
    try {
      const { supported } = await Encoder.isConfigSupported(candidate.config);
      if (supported) return candidate;
    } catch {
      // Configuração inválida para este navegador: tenta a próxima.
    }
  }
  throw new DOMException('Nenhum codec disponível', 'NotSupportedError');
}

function copyChunk(chunk, offset) {
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  return { type: chunk.type, timestamp: chunk.timestamp + offset, duration: chunk.duration ?? 0, data };
}

// Os timestamps de vídeo e de áudio do Chromium podem ter origens diferentes. Cada
// faixa é levada para o relógio de performance.now() pela chegada do primeiro quadro.
const clockOffset = (timestamp) => performance.now() * 1000 - timestamp;

// Lê uma faixa até ela acabar ou o leitor ser cancelado.
function pump(track, onFrame, onError) {
  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
  let cancelled = false;
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      await onFrame(value);
    }
  })().catch((error) => {
    if (!cancelled) onError(error);
  });
  return {
    cancel() {
      cancelled = true;
      reader.cancel().catch(() => {});
    },
  };
}

function createVideoTrackEncoder(track, store, onError) {
  let encoder = null;
  let configuring = null;
  let size = '';
  let offset = null;
  let lastKey = -Infinity;
  let closed = false;

  async function configure(frame) {
    const width = frame.displayWidth - (frame.displayWidth % 2);
    const height = frame.displayHeight - (frame.displayHeight % 2);
    const fps = Math.round(track.getSettings().frameRate || 60);
    const choice = await pickConfig(VideoEncoder, videoCandidates(width, height, fps));
    if (closed) return;
    console.log(`replay: vídeo ${choice.config.codec} ${choice.config.hardwareAcceleration ?? 'auto'} ${width}x${height}@${fps}`);
    if (encoder?.state === 'configured') encoder.close();
    // Pacotes de configurações diferentes não podem ir para o mesmo arquivo.
    store.reset();
    store.videoCodec = choice.muxCodec;
    store.frameRate = fps;
    lastKey = -Infinity;
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) store.videoConfig = meta.decoderConfig;
        store.pushVideo(copyChunk(chunk, offset));
      },
      error: (error) => {
        if (!closed) onError(error);
      },
    });
    encoder.configure(choice.config);
  }

  const pumping = pump(track, async (frame) => {
    try {
      offset ??= clockOffset(frame.timestamp);
      const frameSize = `${frame.displayWidth}x${frame.displayHeight}`;
      if (frameSize !== size) {
        size = frameSize;
        configuring = configure(frame);
      }
      if (configuring) {
        await configuring;
        configuring = null;
      }
      if (closed || encoder?.state !== 'configured' || encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return;
      const keyFrame = frame.timestamp - lastKey >= KEYFRAME_INTERVAL_US;
      if (keyFrame) lastKey = frame.timestamp;
      encoder.encode(frame, { keyFrame });
    } finally {
      frame.close();
    }
  }, onError);

  return {
    async close() {
      closed = true;
      pumping.cancel();
      if (encoder && encoder.state !== 'closed') encoder.close();
      track.stop();
    },
  };
}

function createAudioTrackEncoder(track, store, onError) {
  let encoder = null;
  let configuring = null;
  let offset = null;
  let closed = false;

  async function configure(data) {
    const choice = await pickConfig(AudioEncoder, audioCandidates(data.sampleRate, data.numberOfChannels));
    if (closed) return;
    console.log(`replay: áudio ${choice.config.codec} ${data.sampleRate} Hz ${data.numberOfChannels} canais`);
    store.audioCodec = choice.muxCodec;
    encoder = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) store.audioConfig = meta.decoderConfig;
        store.pushAudio(copyChunk(chunk, offset));
      },
      error: (error) => {
        if (!closed) onError(error);
      },
    });
    encoder.configure(choice.config);
  }

  const pumping = pump(track, async (data) => {
    try {
      offset ??= clockOffset(data.timestamp);
      configuring ??= configure(data);
      await configuring;
      if (!closed && encoder?.state === 'configured') encoder.encode(data);
    } finally {
      data.close();
    }
  }, onError);

  return {
    async close() {
      closed = true;
      pumping.cancel();
      if (encoder && encoder.state !== 'closed') encoder.close();
      track.stop();
    },
  };
}

function createStore() {
  const store = {
    video: [],
    audio: [],
    videoCodec: null,
    videoConfig: null,
    audioCodec: null,
    audioConfig: null,
    frameRate: 60,
    reset() {
      store.video = [];
      store.audio = [];
      store.videoConfig = null;
    },
    pushVideo(packet) {
      // Até o primeiro quadro-chave, os pacotes não decodificam sozinhos.
      if (!store.video.length && packet.type !== 'key') return;
      store.video.push(packet);
      if (packet.type === 'key') store.trim(packet.timestamp);
    },
    pushAudio(packet) {
      store.audio.push(packet);
    },
    // Mantém tudo a partir do último quadro-chave anterior ao limite de tempo.
    trim(newest) {
      const cutoff = newest - KEEP_US;
      let drop = 0;
      for (let i = 1; i < store.video.length; i += 1) {
        if (store.video[i].type !== 'key') continue;
        if (store.video[i].timestamp > cutoff) break;
        drop = i;
      }
      if (drop) store.video.splice(0, drop);
      const first = store.video[0]?.timestamp ?? newest;
      let audioDrop = 0;
      while (audioDrop < store.audio.length && store.audio[audioDrop].timestamp < first) audioDrop += 1;
      if (audioDrop) store.audio.splice(0, audioDrop);
    },
  };
  return store;
}

// Duração de cada pacote pela distância até o próximo. O Chromium nem sempre a informa.
function withDurations(packets, fallbackUs) {
  return packets.map((packet, i) => {
    const next = packets[i + 1];
    const duration = next ? next.timestamp - packet.timestamp : packet.duration || fallbackUs;
    return { ...packet, duration: Math.max(duration, 1) };
  });
}

async function mux({ video, audio, videoCodec, videoConfig, audioCodec, audioConfig }) {
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSource = new EncodedVideoPacketSource(videoCodec);
  output.addVideoTrack(videoSource);
  let audioSource = null;
  if (audio.length && audioConfig) {
    audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addAudioTrack(audioSource);
  }
  await output.start();

  const start = video[0].timestamp;
  const toPacket = (packet) =>
    new EncodedPacket(packet.data, packet.type, (packet.timestamp - start) / 1e6, packet.duration / 1e6);

  // Intercala por tempo: é a ordem que o muxer espera para montar o arquivo.
  let v = 0;
  let a = 0;
  while (v < video.length || (audioSource && a < audio.length)) {
    const takeVideo = !audioSource || a >= audio.length || (v < video.length && video[v].timestamp <= audio[a].timestamp);
    if (takeVideo) {
      await videoSource.add(toPacket(video[v]), v === 0 ? { decoderConfig: videoConfig } : undefined);
      v += 1;
    } else {
      await audioSource.add(toPacket(audio[a]), a === 0 ? { decoderConfig: audioConfig } : undefined);
      a += 1;
    }
  }
  await output.finalize();
  return output.target.buffer;
}

export function createReplayBuffer({ onError }) {
  let store = null;
  let encoders = [];

  async function stop() {
    const closing = encoders;
    encoders = [];
    store = null;
    await Promise.all(closing.map((encoder) => encoder.close()));
  }

  function fail(error) {
    console.error(`replay: ${error.name}: ${error.message}`);
    stop();
    onError(error);
  }

  return {
    get running() {
      return Boolean(store);
    },

    // As faixas recebidas passam a ser do buffer, que as para ao parar.
    // Passe clones para não afetar a exibição.
    async start(videoTrack, audioTrack) {
      await stop();
      store = createStore();
      encoders = [createVideoTrackEncoder(videoTrack, store, fail)];
      if (audioTrack) encoders.push(createAudioTrackEncoder(audioTrack, store, fail));
    },

    stop,

    // Monta o MP4 dos últimos `seconds` segundos, ou do que houver no buffer.
    async clip(seconds) {
      if (!store?.video.length || !store.videoConfig) return null;
      const { video, audio } = store;
      const end = video.at(-1).timestamp;
      const target = end - seconds * 1e6;
      let first = 0;
      for (let i = 0; i < video.length; i += 1) {
        if (video[i].timestamp > target) break;
        if (video[i].type === 'key') first = i;
      }
      // Cópias rasas: o buffer continua recebendo pacotes enquanto o arquivo é montado.
      const clipVideo = withDurations(video.slice(first), 1e6 / store.frameRate);
      const start = clipVideo[0].timestamp;
      const clipAudio = withDurations(
        audio.filter(({ timestamp }) => timestamp >= start && timestamp <= end),
        AAC_FRAME_US,
      );
      const buffer = await mux({ ...store, video: clipVideo, audio: clipAudio });
      const last = clipVideo.at(-1);
      return { buffer, duration: (last.timestamp + last.duration - start) / 1e6 };
    },
  };
}
