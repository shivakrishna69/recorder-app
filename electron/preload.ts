import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeApp: () => ipcRenderer.send('minimize-app'),
  maximizeApp: () => ipcRenderer.send('maximize-app'),
  openDashboard: () => ipcRenderer.send('open-dashboard'),
  initRecording: (mimeType?: string) => ipcRenderer.invoke('init-recording', mimeType),
  appendChunk: (sessionId: string, chunk: ArrayBuffer) => ipcRenderer.invoke('append-chunk', sessionId, chunk),
  finalizeRecording: (payload: any) => ipcRenderer.invoke('finalize-recording', payload),
  saveRecording: (payload: any) => ipcRenderer.invoke('save-recording', payload),
  getRecordings: () => ipcRenderer.invoke('get-recordings'),
  updateRecording: (payload: any) => ipcRenderer.invoke('update-recording', payload),
  deleteRecording: (id: number) => ipcRenderer.invoke('delete-recording', id),
  downloadRecording: (id: number) => ipcRenderer.invoke('download-recording', id),
  getRecordingServerPort: () => ipcRenderer.invoke('get-recording-server-port'),
  onRecordingState: (callback: any) => ipcRenderer.on('on-recording-state', (_event, value) => callback(value)),
  recordingStarted: () => ipcRenderer.send('recording-started'),
  recordingStopped: () => ipcRenderer.send('recording-stopped'),
  resizeWidget: (width: number, height: number) => ipcRenderer.send('resize-widget', { width, height }),
});
