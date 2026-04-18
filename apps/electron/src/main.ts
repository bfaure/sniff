import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let mainWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;
const SERVER_PORT = 47120;
const RENDERER_DEV_PORT = 5173;

async function startBackend() {
  // Dynamic imports so the TS compiler doesn't traverse backend ESM files
  // (electron builds as CommonJS; backend runs as ESM at runtime).
  const backendSpec = '@sniff/backend/src/proxy/ca.js';
  const serverSpec = '@sniff/backend/src/server.js';

  const { setCertDir } = (await import(backendSpec)) as { setCertDir: (dir: string) => void };
  setCertDir(path.join(app.getPath('userData'), 'certificates'));

  const { createServer } = (await import(serverSpec)) as {
    createServer: () => Promise<{ fastify: { listen: (opts: { port: number; host: string }) => Promise<void> } }>;
  };
  const { fastify } = await createServer();

  await fastify.listen({ port: SERVER_PORT, host: '127.0.0.1' });
  console.log(`[electron] backend started on port ${SERVER_PORT}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Sniff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL(`http://localhost:${RENDERER_DEV_PORT}`);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handlers
function setupIPC() {
  ipcMain.handle('open-external', (_event, url: string) => {
    return shell.openExternal(url);
  });

  ipcMain.handle('show-save-dialog', async (_event, opts) => {
    const result = await dialog.showSaveDialog(mainWindow!, opts);
    return result;
  });

  ipcMain.handle('export-file', async (_event, filePath: string, data: string) => {
    fs.writeFileSync(filePath, data);
    return { success: true };
  });

  ipcMain.handle('get-app-data-path', () => {
    return app.getPath('userData');
  });
}

app.whenReady().then(async () => {
  setupIPC();
  await startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
