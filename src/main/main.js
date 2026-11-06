const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
} = require('electron');
const path = require('node:path');
const settings = require('./settings');
const clips = require('./clips');

const APP_TITLE = 'Capture Mirror';
const COLLECTION_TITLE = 'Capture Mirror — Clipes';
const SAVABLE_KEYS = ['video', 'audio', 'volume', 'clipMic'];
const MIN_VISIBLE_PX = 100;
const MAX_SNAP_DIP = 20;
// Globais: funcionam com qualquer janela em foco, como o Discord ou um jogo.
const CLIP_SHORTCUTS = [
  { accelerator: 'CommandOrControl+Shift+F9', label: 'Ctrl+Shift+F9', seconds: 30 },
  { accelerator: 'CommandOrControl+Shift+F10', label: 'Ctrl+Shift+F10', seconds: 60 },
];

let mainWindow = null;
let collectionWindow = null;
const failedShortcuts = [];

// backgroundThrottling: false não basta: no Windows, o Chromium detecta que a
// janela está coberta e para de renderizar. Sem estas flags, o Go Live perderia
// quadros sempre que outra janela ficasse na frente.
//
// MediaFoundationVideoCapture: testado com uma placa MS2109, o Media Foundation
// entrega só 30 FPS (ou falha) em 1080p60, enquanto o DirectShow entrega 60 reais.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaFoundationVideoCapture');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

clips.registerScheme();
// Mesmo id do electron-builder: o Windows usa para agrupar as notificações.
app.setAppUserModelId('com.capturemirror.app');

const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture']);

function allowMediaPermissions() {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  defaultSession.setPermissionCheckHandler((_webContents, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Os clipes gravam o som do PC (loopback). O Chromium só entrega esse áudio junto
  // com uma captura de vídeo, então a tela vai junto e o renderer a descarta.
  defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then(([source]) => callback(source ? { video: source, audio: 'loopback' } : {}))
      .catch((error) => {
        console.error(`loopback: ${error.message}`);
        callback({});
      });
  });
}

function isOnSomeDisplay({ x, y, width, height }) {
  return screen.getAllDisplays().some(({ workArea }) => {
    const visibleWidth = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x);
    const visibleHeight = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y);
    return visibleWidth >= MIN_VISIBLE_PX && visibleHeight >= MIN_VISIBLE_PX;
  });
}

// Com escala de tela fracionária (125%, por exemplo), uma posição que não cai num
// pixel físico inteiro faz o Chromium aumentar a janela ao criá-la. Como o tamanho
// é salvo ao fechar, ela cresceria um pouco a cada abertura.
function snapToPixelGrid(value, scale) {
  for (let candidate = value; candidate > value - MAX_SNAP_DIP; candidate -= 1) {
    if (Number.isInteger(candidate * scale)) return candidate;
  }
  return value;
}

// Sem configuração salva, 1280x720 é o tamanho do conteúdo. Os limites salvos
// incluem a moldura. Se a tela de antes sumiu, omitir x e y centraliza na principal.
function initialBounds() {
  const { bounds } = settings.load();
  if (!bounds) return { width: 1280, height: 720, useContentSize: true };
  const { width, height } = bounds;
  if (!isOnSomeDisplay(bounds)) return { width, height };
  const { scaleFactor } = screen.getDisplayMatching(bounds);
  return {
    ...bounds,
    x: snapToPixelGrid(bounds.x, scaleFactor),
    y: snapToPixelGrid(bounds.y, scaleFactor),
  };
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  backgroundThrottling: false,
  // Sem isso, o AudioContext ficaria suspenso até o primeiro clique.
  autoplayPolicy: 'no-user-gesture-required',
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

function lockDown(win) {
  // O Discord identifica a janela pelo título, então ele nunca pode mudar.
  win.on('page-title-updated', (event) => event.preventDefault());
  // Arrastar um arquivo para a janela não pode trocar a página do app.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (!app.isPackaged) {
    // As capacidades do dispositivo vão para o console e aparecem no terminal.
    win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`));
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    ...initialBounds(),
    title: APP_TITLE,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: '#000000',
    webPreferences: webPreferences(),
  });
  lockDown(win);
  // getNormalBounds ignora tela cheia: ao reabrir, a janela volta ao tamanho normal.
  win.on('close', () => settings.save({ bounds: win.getNormalBounds() }));
  // A coleção é uma janela auxiliar: fecha junto com a principal.
  win.on('closed', () => {
    mainWindow = null;
    collectionWindow?.close();
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow = win;
}

// Janela separada de propósito: o Go Live compartilha só a janela principal, e
// quem assiste não vê a coleção.
function openCollection() {
  if (collectionWindow) {
    if (collectionWindow.isMinimized()) collectionWindow.restore();
    collectionWindow.focus();
    return;
  }
  collectionWindow = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 480,
    minHeight: 360,
    title: COLLECTION_TITLE,
    backgroundColor: '#141414',
    webPreferences: webPreferences(),
  });
  lockDown(collectionWindow);
  collectionWindow.on('closed', () => {
    collectionWindow = null;
  });
  collectionWindow.loadFile(path.join(__dirname, '../renderer/clips.html'));
}

function notifySaved({ name }, duration) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Clipe salvo',
    body: `${Math.round(duration)} s · ${name}`,
    silent: true,
  });
  notification.on('click', openCollection);
  notification.show();
}

function registerShortcuts() {
  for (const { accelerator, label, seconds } of CLIP_SHORTCUTS) {
    const ok = globalShortcut.register(accelerator, () => mainWindow?.webContents.send('clip:request', seconds));
    // Outro app já usa a combinação. O overlay avisa.
    if (!ok) {
      failedShortcuts.push(label);
      console.warn(`atalho ${label} em uso por outro aplicativo`);
    }
  }
}

function registerIpc() {
  ipcMain.handle('settings:load', () => settings.load());
  ipcMain.on('settings:save', (_event, patch) => {
    const allowed = SAVABLE_KEYS.filter((key) => key in patch);
    settings.save(Object.fromEntries(allowed.map((key) => [key, patch[key]])));
  });
  ipcMain.on('window:toggle-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setFullScreen(!win.isFullScreen());
  });
  ipcMain.on('window:exit-fullscreen', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.setFullScreen(false);
  });

  ipcMain.handle('clips:shortcuts', () => ({
    shortcuts: CLIP_SHORTCUTS.map(({ label, seconds }) => ({ label, seconds })),
    failed: failedShortcuts,
  }));
  ipcMain.handle('clips:save', async (_event, clip) => {
    const saved = await clips.save(clip);
    notifySaved(saved, clip.duration);
    collectionWindow?.webContents.send('clips:changed');
    return saved.name;
  });
  ipcMain.handle('clips:list', () => clips.list());
  ipcMain.handle('clips:trash', async (_event, name) => {
    await clips.trash(name);
    collectionWindow?.webContents.send('clips:changed');
  });
  ipcMain.on('clips:show', (_event, name) => clips.show(name));
  ipcMain.on('clips:open-folder', () => clips.openFolder());
  ipcMain.on('collection:open', openCollection);
  // Arrastar o card leva o arquivo de verdade: dá para soltar no Discord ou no Explorer.
  ipcMain.on('clips:drag', (event, name) => {
    const file = clips.clipPath(name);
    if (!file) return;
    let icon = nativeImage.createFromPath(clips.thumbPath(name));
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '../../build/icon.png'));
    event.sender.startDrag({ file, icon: icon.resize({ width: 160 }) });
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  allowMediaPermissions();
  clips.handleProtocol();
  registerIpc();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
