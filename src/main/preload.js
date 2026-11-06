const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureMirror', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (patch) => ipcRenderer.send('settings:save', patch),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  exitFullscreen: () => ipcRenderer.send('window:exit-fullscreen'),

  // Clipes
  clipShortcuts: () => ipcRenderer.invoke('clips:shortcuts'),
  saveClip: (clip) => ipcRenderer.invoke('clips:save', clip),
  listClips: () => ipcRenderer.invoke('clips:list'),
  trashClip: (name) => ipcRenderer.invoke('clips:trash', name),
  showClip: (name) => ipcRenderer.send('clips:show', name),
  openClipsFolder: () => ipcRenderer.send('clips:open-folder'),
  openCollection: () => ipcRenderer.send('collection:open'),
  startDrag: (name) => ipcRenderer.send('clips:drag', name),
  onClipRequest: (listener) => ipcRenderer.on('clip:request', (_event, seconds) => listener(seconds)),
  onClipsChanged: (listener) => ipcRenderer.on('clips:changed', () => listener()),
});
