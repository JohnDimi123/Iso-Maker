/** Electron main process bootstrap. */
import { app, BrowserWindow, Menu } from 'electron';
import { join } from 'node:path';
import { logger, consoleSink } from '../core/logger';
import { APP_NAME } from '../shared/constants';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#15161c',
    title: APP_NAME,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  logger.addSink(consoleSink);
  try {
    logger.addFileSink(join(app.getPath('logs'), 'isomaker.log'));
  } catch {
    /* logs path may be unavailable in some environments */
  }
  logger.child('app').info(`${APP_NAME} starting (electron ${process.versions.electron})`);

  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
