/**
 * Preload bridge. Exposes a minimal, typed `window.isoMaker` API to the
 * renderer over context isolation — the renderer never touches Node/Electron
 * internals directly.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { Channels, Events, type IsoMakerApi } from '../shared/ipc-contract';

const api: IsoMakerApi = {
  appInfo: () => ipcRenderer.invoke(Channels.appInfo),
  listDrives: (includeSimulated) => ipcRenderer.invoke(Channels.listDrives, includeSimulated),
  inspectImage: (path) => ipcRenderer.invoke(Channels.inspectImage, path),
  listImage: (path) => ipcRenderer.invoke(Channels.listImage, path),
  listFormats: () => ipcRenderer.invoke(Channels.listFormats),
  scanSources: (paths) => ipcRenderer.invoke(Channels.scanSources, paths),
  buildSize: (spec) => ipcRenderer.invoke(Channels.buildSize, spec),
  buildIso: (spec) => ipcRenderer.invoke(Channels.buildRun, spec),
  extract: (path, opts) => ipcRenderer.invoke(Channels.extract, path, opts),
  convertToIso: (src, out) => ipcRenderer.invoke(Channels.convert, src, out),
  verify: (spec) => ipcRenderer.invoke(Channels.verifyRun, spec),
  checksum: (path, algorithms) => ipcRenderer.invoke(Channels.checksum, path, algorithms),
  readTest: (path) => ipcRenderer.invoke(Channels.testRead, path),
  readDiscToImage: (driveId, outPath) => ipcRenderer.invoke(Channels.readDisc, driveId, outPath),
  burn: (req) => ipcRenderer.invoke(Channels.burnRun, req),
  cancelBurn: (jobId) => ipcRenderer.invoke(Channels.burnCancel, jobId),
  chooseFiles: () => ipcRenderer.invoke(Channels.dialogOpenFiles),
  chooseFolder: () => ipcRenderer.invoke(Channels.dialogOpenFolder),
  chooseSave: (defaultName) => ipcRenderer.invoke(Channels.dialogSave, defaultName),
  chooseImage: () => ipcRenderer.invoke(Channels.dialogOpenImage),
  onProgress: (cb) => {
    const listener = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on(Events.progress, listener);
    return () => ipcRenderer.removeListener(Events.progress, listener);
  },
  onLog: (cb) => {
    const listener = (_e: unknown, payload: Parameters<typeof cb>[0]) => cb(payload);
    ipcRenderer.on(Events.log, listener);
    return () => ipcRenderer.removeListener(Events.log, listener);
  }
};

contextBridge.exposeInMainWorld('isoMaker', api);
