// Áudio dos clipes: som do PC (loopback) + microfone opcional, misturados num
// AudioContext que não toca nada. O microfone entra só no clipe: não sai nos
// alto-falantes e, por isso, não vai para o Discord.
//
// O loopback é tudo o que sai no dispositivo padrão do Windows. O som da placa
// entra porque o próprio app o toca, então volume e mute do app valem aqui também.
export function createClipAudio() {
  let context = null;
  let destination = null;
  let loopback = null;
  let mic = null;
  let micId = null;
  let micRequest = 0;

  function ensureContext() {
    if (context) return;
    context = new AudioContext({ sampleRate: 48000 });
    destination = context.createMediaStreamDestination();
    destination.channelCount = 2;
  }

  function attach(stream) {
    const source = context.createMediaStreamSource(stream);
    source.connect(destination);
    return { stream, source };
  }

  function detach(input) {
    input?.source.disconnect();
    input?.stream.getTracks().forEach((track) => track.stop());
  }

  return {
    // A faixa misturada. Fica a mesma durante toda a execução.
    get track() {
      return destination?.stream.getAudioTracks()[0] ?? null;
    },

    get hasLoopback() {
      return Boolean(loopback?.stream.getAudioTracks()[0]?.readyState === 'live');
    },

    async startLoopback() {
      ensureContext();
      if (this.hasLoopback) return;
      detach(loopback);
      loopback = null;
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      // O Chromium só entrega o loopback junto com uma captura de tela. A imagem não é usada.
      stream.getVideoTracks().forEach((track) => track.stop());
      if (!stream.getAudioTracks().length) throw new DOMException('Sem áudio do sistema', 'NotFoundError');
      loopback = attach(stream);
      await context.resume();
    },

    // deviceId null tira o microfone. Chamadas seguidas: vale a última.
    async setMic(deviceId) {
      ensureContext();
      if (deviceId === micId) return;
      const request = ++micRequest;
      micId = deviceId;
      detach(mic);
      mic = null;
      if (!deviceId) return;
      try {
        // Com o processamento de voz ligado: o microfone é para fala, e o
        // cancelamento de eco reduz o som do PC que vaza nele.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
        if (request !== micRequest) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mic = attach(stream);
        await context.resume();
      } catch (error) {
        if (request === micRequest) micId = null;
        throw error;
      }
    },

    get micId() {
      return micId;
    },
  };
}
