// Modo navegador: manda a imagem e o som para uma guia do navegador por WebRTC.
// O Meet só compartilha som de guias e da tela inteira, nunca de uma janela.
// O main serve a página e leva a oferta e a resposta. Não há servidor STUN:
// tudo acontece dentro do próprio PC.

// Tudo é local, então dá para mandar bem mais do que numa rede de verdade.
const MAX_VIDEO_KBPS = 30000;
const START_VIDEO_KBPS = 12000;
const OPUS_PARAMS = 'stereo=1;sprop-stereo=1;maxaveragebitrate=256000';
// Coletar os candidatos dentro do PC leva milissegundos. O limite só evita esperar
// para sempre se alguma interface de rede demorar.
const GATHER_TIMEOUT_MS = 1500;
// H.264 costuma ter codificador por hardware. Se não houver, vale a ordem padrão.
const PREFERRED_VIDEO_CODEC = 'video/H264';
const NOT_MEDIA_CODECS = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03']);
const LOG_STATS_AFTER_MS = 5000;

function waitForCandidates(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function preferCodec(transceiver) {
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const preferred = codecs.filter(({ mimeType }) => mimeType === PREFERRED_VIDEO_CODEC);
  if (!preferred.length) return;
  transceiver.setCodecPreferences([...preferred, ...codecs.filter((codec) => !preferred.includes(codec))]);
}

// Junta parâmetros à linha a=fmtp de um formato, ou cria a linha se ela não existir.
function addFormatParams(lines, start, end, payload, params) {
  const prefix = `a=fmtp:${payload} `;
  for (let i = start; i < end; i += 1) {
    if (lines[i].startsWith(prefix)) {
      lines[i] = `${lines[i]};${params}`;
      return end;
    }
  }
  const rtpmap = lines.findIndex((line, i) => i >= start && i < end && line.startsWith(`a=rtpmap:${payload} `));
  if (rtpmap < 0) return end;
  lines.splice(rtpmap + 1, 0, `${prefix}${params}`);
  return end + 1;
}

// A resposta da guia diz ao app como enviar. Os parâmetros x-google-* tiram o
// vídeo do começo borrado (o WebRTC começa em ~300 kbps e sobe aos poucos), e os
// do Opus pedem som estéreo com taxa alta, em vez da de voz.
export function tuneAnswer(sdp) {
  const lines = sdp.split('\r\n');
  let i = 0;
  while (i < lines.length) {
    const media = /^m=(audio|video) \S+ \S+ (.*)$/.exec(lines[i]);
    if (!media) {
      i += 1;
      continue;
    }
    let end = lines.findIndex((line, j) => j > i && line.startsWith('m='));
    if (end < 0) end = lines.length;
    for (const payload of media[2].split(' ')) {
      const rtpmap = lines.find((line, j) => j > i && j < end && line.startsWith(`a=rtpmap:${payload} `));
      const codec = rtpmap?.split(' ')[1]?.split('/')[0].toLowerCase();
      if (!codec) continue;
      if (media[1] === 'audio' && codec === 'opus') {
        end = addFormatParams(lines, i, end, payload, OPUS_PARAMS);
      } else if (media[1] === 'video' && !NOT_MEDIA_CODECS.has(codec)) {
        end = addFormatParams(
          lines,
          i,
          end,
          payload,
          `x-google-start-bitrate=${START_VIDEO_KBPS};x-google-max-bitrate=${MAX_VIDEO_KBPS}`,
        );
      }
    }
    i = end;
  }
  return lines.join('\r\n');
}

export function createBrowserShare({ api, audioTrack, onChange }) {
  let viewer = null;
  let pc = null;
  let videoSender = null;
  let videoTrack = null;
  let connected = false;

  // Estatísticas do envio: codec, codificador, resolução, FPS e limitação.
  async function stats() {
    if (!pc) return null;
    const report = await pc.getStats();
    const result = {};
    report.forEach((entry) => {
      if (entry.type !== 'outbound-rtp') return;
      result[entry.kind] = {
        codec: report.get(entry.codecId)?.mimeType,
        encoder: entry.encoderImplementation,
        width: entry.frameWidth,
        height: entry.frameHeight,
        fps: entry.framesPerSecond,
        kbps: entry.targetBitrate && Math.round(entry.targetBitrate / 1000),
        limitation: entry.qualityLimitationReason,
      };
    });
    return result;
  }

  function setConnected(value) {
    if (connected === value) return;
    connected = value;
    onChange(connected);
  }

  function close() {
    pc?.close();
    pc = null;
    videoSender = null;
    setConnected(false);
  }

  async function connect(id) {
    close();
    viewer = id;
    if (!id) return;

    const current = new RTCPeerConnection({ iceServers: [] });
    pc = current;
    current.addEventListener('connectionstatechange', () => {
      if (pc !== current) return;
      const state = current.connectionState;
      if (state === 'connected') {
        setConnected(true);
        // Registro para diagnóstico: o codec escolhido e se o envio está limitado.
        setTimeout(async () => {
          if (pc === current) console.log(`modo navegador: ${JSON.stringify(await stats())}`);
        }, LOG_STATS_AFTER_MS);
      }
      // Se a conexão cair, a página abre outra sozinha, e o main avisa de novo.
      else if (state === 'failed' || state === 'closed' || state === 'disconnected') setConnected(false);
    });

    const video = current.addTransceiver(videoTrack ?? 'video', {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: MAX_VIDEO_KBPS * 1000, maxFramerate: 60 }],
    });
    preferCodec(video);
    videoSender = video.sender;
    current.addTransceiver(audioTrack(), {
      direction: 'sendonly',
      sendEncodings: [{ maxBitrate: 256000 }],
    });

    try {
      await current.setLocalDescription(await current.createOffer());
      await waitForCandidates(current);
      if (pc !== current) return;
      const { type, sdp } = current.localDescription;
      api.sendShareOffer(id, { type, sdp });
    } catch (error) {
      console.error(`modo navegador: ${error.name}: ${error.message}`);
      if (pc === current) close();
    }
  }

  async function answer(id, description) {
    if (id !== viewer || !pc || pc.signalingState !== 'have-local-offer') return;
    const current = pc;
    try {
      await current.setRemoteDescription({ type: 'answer', sdp: tuneAnswer(description.sdp) });
    } catch (error) {
      console.error(`modo navegador: ${error.name}: ${error.message}`);
      if (pc === current) close();
    }
  }

  api.onShareViewer((id) => connect(id));
  api.onShareAnswer((id, description) => answer(id, description));

  return {
    get connected() {
      return connected;
    },
    // A troca de placa ou de resolução só troca a faixa: a guia não reconecta.
    setVideoTrack(track) {
      videoTrack = track;
      // Para jogo, vale mais manter o FPS do que cada detalhe da imagem.
      if (track) track.contentHint = 'motion';
      videoSender?.replaceTrack(track).catch((error) => console.error(`modo navegador: ${error.message}`));
      api.sendShareStatus({ video: Boolean(track) });
    },
    async start() {
      api.sendShareStatus({ video: Boolean(videoTrack) });
      const { viewer: id } = await api.shareCurrent();
      if (id && id !== viewer) connect(id);
    },
    stats,
  };
}
