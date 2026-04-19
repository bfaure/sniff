import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let mainWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;
const SERVER_PORT = 47120;
const RENDERER_DEV_PORT = 5173;

// Packaged app lives at resources/app/ (asar disabled — see electron-builder.yml
// for why). Renderer static assets ship separately at resources/renderer/ via
// extraResources; we hand that path to the backend so Fastify serves them at
// the same origin as the API, sidestepping file:// + /api + /ws breakage.
const RESOURCES_DIR = isDev ? path.join(__dirname, '..') : process.resourcesPath;

function rendererDir(): string {
  if (isDev) return path.join(__dirname, '..', '..', 'renderer', 'dist');
  return path.join(RESOURCES_DIR, 'renderer');
}

function configureBackendEnv(): void {
  // SQLite database lives under userData so it survives upgrades and is writable.
  const userData = app.getPath('userData');
  const dbPath = path.join(userData, 'sniff.db');
  // Prisma file URL on Windows must use forward slashes.
  process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
  process.env.SNIFF_SERVER_PORT = String(SERVER_PORT);
  // Tell the backend to serve the renderer. In dev we skip this so Vite's
  // :5173 dev server stays the single source of truth for the UI.
  if (!isDev) process.env.SNIFF_RENDERER_DIR = rendererDir();
}

async function startBackend() {
  configureBackendEnv();

  // Compiled backend lives at @sniff/backend/dist/. Use dynamic imports because
  // electron's main bundle is CommonJS and the backend is ESM.
  const caSpec = '@sniff/backend/dist/proxy/ca.js';
  const serverSpec = '@sniff/backend/dist/server.js';

  const { setCertDir } = (await import(caSpec)) as { setCertDir: (dir: string) => void };
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
    // Serve the renderer from the backend (same origin as /api and /ws).
    mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/`);
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

// If startBackend() rejects, the unhandled promise will silently leave the app
// without a window — show the error and quit so the failure mode is visible.
function showFatal(err: unknown): void {
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  console.error('[electron] fatal:', message);
  try {
    dialog.showErrorBox('Sniff failed to start', message);
  } catch {
    /* dialog may not be ready */
  }
  app.exit(1);
}

app.whenReady().then(async () => {
  try {
    setupIPC();
    await startBackend();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (err) {
    showFatal(err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
