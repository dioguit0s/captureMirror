// Os ids "default" e "communications" são apelidos de um dispositivo que já está
// na lista. Sem eles, cada placa aparece uma vez só.
const isRealDevice = ({ deviceId }) =>
  deviceId && deviceId !== 'default' && deviceId !== 'communications';

export async function listDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(isRealDevice);
  return {
    video: devices.filter(({ kind }) => kind === 'videoinput'),
    audio: devices.filter(({ kind }) => kind === 'audioinput'),
  };
}

// O deviceId pode mudar entre execuções. O label é a segunda opção, mais estável.
export function findDevice(devices, saved) {
  return (
    devices.find(({ deviceId }) => deviceId === saved.id) ??
    devices.find(({ label }) => label && label === saved.label)
  );
}

// deviceId é exact: com ideal, o Chromium poderia trocar a placa pela webcam sem avisar.
export async function openVideo(deviceId) {
  const device = { deviceId: { exact: deviceId } };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        ...device,
        // 720p: na placa testada (MS2109), 1080p declara 60 FPS, mas só 30 chegam à tela.
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
    });
  } catch (error) {
    // Algumas placas falham ao iniciar nesse modo, mesmo com ideal.
    console.warn(`720p60 falhou (${error.name}). Tentando o modo padrão do dispositivo.`);
    return navigator.mediaDevices.getUserMedia({ video: device });
  }
}

export function openAudio(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
    },
  });
}

// O formato de pixel não aparece aqui: o Chromium o escolhe e não o expõe ao JS.
export function logTrackInfo(track) {
  console.log(`${track.kind}: ${track.label}`);
  console.log(`  capacidades: ${JSON.stringify(track.getCapabilities())}`);
  console.log(`  em uso: ${JSON.stringify(track.getSettings())}`);
}
