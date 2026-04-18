import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sniff', {
  platform: process.platform,
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  showSaveDialog: (opts: Electron.SaveDialogOptions) =>
    ipcRenderer.invoke('show-save-dialog', opts),
  exportFile: (filePath: string, data: string) =>
    ipcRenderer.invoke('export-file', filePath, data),
  getAppDataPath: () => ipcRenderer.invoke('get-app-data-path'),
});
