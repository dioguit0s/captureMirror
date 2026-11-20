// Os ids "default" e "communications" são apelidos de um dispositivo que já está
// na lista. Sem eles, cada placa aparece uma vez só.
const isRealDevice = ({ deviceId }) =>
  deviceId && deviceId !== 'default' && deviceId !== 'communications';

// O WebView2 só revela ids e nomes depois de uma permissão concedida. O Rust
// concede sem perguntar, mas alguém precisa pedir: uma abertura rápida resolve,
// e a permissão fica salva no perfil do app para as próximas vezes.
let permissionAsked = false;

async function ensurePermission(devices) {
  if (permissionAsked || devices.some(({ deviceId }) => deviceId)) return false;
  permissionAsked = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch (error) {
    console.error(`permissão de mídia: ${error.name}: ${error.message}`);
    return false;
  }
}

export async function listDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (await ensurePermission(devices)) devices = await navigator.mediaDevices.enumerateDevices();
  devices = devices.filter(isRealDevice);
  return {
    video: devices.filter(({ kind }) => kind === 'videoinput'),
    audio: devices.filter(({ kind }) => kind === 'audioinput'),
  };
}

// O deviceId pode mudar entre execuções. O label é a segunda opção, mais estável.
// O nome também vale com ou sem o id USB no fim: o Chromium escreve
// "Placa (534d:2109)", o Windows só "Placa". Assim a escolha salva pelo app
// antigo continua valendo no motor de áudio nativo.
export function findDevice(devices, saved) {
  const sameName = (label) =>
    label && saved.label && (label === saved.label || saved.label.startsWith(`${label} (`) || label.startsWith(`${saved.label} (`));
  return devices.find(({ deviceId }) => deviceId === saved.id) ?? devices.find(({ label }) => sameName(label));
}

// Modos oferecidos no overlay. O padrão é 720p: na placa testada (MS2109), 1080p
// declara 60 FPS, mas só 30 chegam à tela. Placas melhores aguentam 1080p60.
export const RESOLUTIONS = [
  { id: '2160p', label: '2160p (4K)', width: 3840, height: 2160 },
  { id: '1440p', label: '1440p', width: 2560, height: 1440 },
  { id: '1080p', label: '1080p', width: 1920, height: 1080 },
  { id: '720p', label: '720p', width: 1280, height: 720 },
  { id: '480p', label: '480p', width: 854, height: 480 },
];
export const DEFAULT_RESOLUTION = '720p';

export const findResolution = (id) =>
  RESOLUTIONS.find((mode) => mode.id === id) ?? RESOLUTIONS.find((mode) => mode.id === DEFAULT_RESOLUTION);

// Só os modos que a placa diz suportar. Sem capacidades, mostra todos até 1080p.
export function supportedResolutions(capabilities) {
  const maxWidth = capabilities?.width?.max ?? 1920;
  const maxHeight = capabilities?.height?.max ?? 1080;
  const modes = RESOLUTIONS.filter(({ width, height }) => width <= maxWidth && height <= maxHeight);
  return modes.length ? modes : RESOLUTIONS.slice(-1);
}

// deviceId é exact: com ideal, o Chromium poderia trocar a placa pela webcam sem avisar.
export async function openVideo(deviceId, resolutionId) {
  const device = { deviceId: { exact: deviceId } };
  const { width, height, label } = findResolution(resolutionId);
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        ...device,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: 60 },
      },
    });
  } catch (error) {
    // Algumas placas falham ao iniciar nesse modo, mesmo com ideal.
    console.warn(`${label}60 falhou (${error.name}). Tentando o modo padrão do dispositivo.`);
    return navigator.mediaDevices.getUserMedia({ video: device });
  }
}


// O formato de pixel não aparece aqui: o Chromium o escolhe e não o expõe ao JS.
export function logTrackInfo(track) {
  console.log(`${track.kind}: ${track.label}`);
  console.log(`  capacidades: ${JSON.stringify(track.getCapabilities())}`);
  console.log(`  em uso: ${JSON.stringify(track.getSettings())}`);
}
