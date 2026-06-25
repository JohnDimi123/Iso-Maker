/**
 * Main-process IPC handlers. Each channel maps directly onto an engine call.
 * Progress + log events are streamed to the renderer via webContents.send.
 */
import { ipcMain, dialog, BrowserWindow, app } from 'electron';
import * as fs from 'node:fs';
import { Channels, Events, type BurnRequest, type BurnResponse } from '../shared/ipc-contract';
import type { BuildSpec, HashAlgorithm, ProgressEvent, VerifySpec } from '../shared/types';
import { SUPPORTED_IMAGE_EXTENSIONS, APP_NAME } from '../shared/constants';
import { logger } from '../core/logger';
import {
  inspect,
  listFormats,
  buildIso,
  calculateBuildSize,
  convertToIso,
  scanSources,
  Iso9660Reader
} from '../image-engine';
import { verify, checksum } from '../verify-engine';
import { driveManager } from '../hal';
import { burnEngine, readTest } from '../burn-engine';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const emitProgress = (e: ProgressEvent) => broadcast(Events.progress, e);

export function registerIpcHandlers(): void {
  // Stream every log entry to the renderer console.
  logger.events.on('log', (entry) => broadcast(Events.log, entry));

  ipcMain.handle(Channels.appInfo, () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }));

  ipcMain.handle(Channels.listDrives, (_e, includeSimulated: boolean) =>
    driveManager.listDrives({ includeSimulated })
  );

  ipcMain.handle(Channels.inspectImage, (_e, path: string) => inspect(path));

  ipcMain.handle(Channels.listImage, (_e, path: string) => {
    const reader = Iso9660Reader.open(path);
    try {
      return reader.listAll();
    } finally {
      reader.close();
    }
  });

  ipcMain.handle(Channels.listFormats, () =>
    listFormats().map((f) => ({ id: f.id, name: f.name, extensions: f.extensions }))
  );

  ipcMain.handle(Channels.scanSources, (_e, paths: string[]) =>
    scanSources(paths.map((p) => ({ sourcePath: p })))
  );

  ipcMain.handle(Channels.buildSize, (_e, spec: BuildSpec) => calculateBuildSize(spec));

  ipcMain.handle(Channels.buildRun, (_e, spec: BuildSpec) =>
    buildIso(spec, (done, total, message) =>
      emitProgress({
        jobId: 'build',
        phase: 'building',
        percent: total ? (done / total) * 100 : 100,
        bytesProcessed: done,
        totalBytes: total,
        speedBps: 0,
        etaSeconds: 0,
        message
      })
    )
  );

  ipcMain.handle(Channels.extract, (_e, path: string, opts: { outDir?: string; file?: string }) => {
    const reader = Iso9660Reader.open(path);
    try {
      if (opts.file) {
        reader.extractFile(opts.file, opts.outDir ?? opts.file);
        return { count: 1 };
      }
      const count = reader.extractAll(opts.outDir ?? './extracted', (p, done, total) =>
        emitProgress({
          jobId: 'extract',
          phase: 'reading',
          percent: total ? (done / total) * 100 : 100,
          bytesProcessed: done,
          totalBytes: total,
          speedBps: 0,
          etaSeconds: 0,
          message: p
        })
      );
      return { count };
    } finally {
      reader.close();
    }
  });

  ipcMain.handle(Channels.convert, async (_e, src: string, out: string) => {
    const result = await convertToIso(src, out, (done, total) =>
      emitProgress({
        jobId: 'convert',
        phase: 'building',
        percent: total ? (done / total) * 100 : 100,
        bytesProcessed: done,
        totalBytes: total,
        speedBps: 0,
        etaSeconds: 0
      })
    );
    return { bytesWritten: result.bytesWritten };
  });

  ipcMain.handle(Channels.verifyRun, (_e, spec: VerifySpec) =>
    verify(spec, (phase, done, total) =>
      emitProgress({
        jobId: 'verify',
        phase: 'verifying',
        percent: total ? (done / total) * 100 : 100,
        bytesProcessed: done,
        totalBytes: total,
        speedBps: 0,
        etaSeconds: 0,
        message: phase
      })
    )
  );

  ipcMain.handle(Channels.checksum, (_e, path: string, algorithms: HashAlgorithm[]) =>
    checksum(path, algorithms, (done, total) =>
      emitProgress({
        jobId: 'checksum',
        phase: 'verifying',
        percent: total ? (done / total) * 100 : 100,
        bytesProcessed: done,
        totalBytes: total,
        speedBps: 0,
        etaSeconds: 0
      })
    )
  );

  ipcMain.handle(Channels.testRead, (_e, path: string) =>
    readTest(path, (done, total, speed) =>
      emitProgress({
        jobId: 'test',
        phase: 'testing',
        percent: total ? (done / total) * 100 : 100,
        bytesProcessed: done * 2048,
        totalBytes: total * 2048,
        speedBps: speed,
        etaSeconds: 0
      })
    )
  );

  // Rip a physical disc to an image file (sequential sector copy of the device).
  // Real hardware path — not exercised in CI.
  ipcMain.handle(Channels.readDisc, async (_e, driveId: string, outPath: string) => {
    const drives = await driveManager.listDrives({ includeSimulated: true });
    const drive = drives.find((d) => d.id === driveId);
    if (!drive) throw new Error('Drive not found.');
    if (drive.simulated)
      throw new Error('This is a simulated drive — reading a disc to an image requires a physical drive with media.');
    if (!drive.media.present) throw new Error('No disc present in the drive.');

    const sectorSize = drive.media.sectorSize || 2048;
    const totalBytes = drive.media.capacityBytes || drive.media.totalSectors * sectorSize;
    const log = logger.child('rip');
    log.info(`Reading ${drive.devicePath} -> ${outPath} (${totalBytes} bytes)`);
    const fd = fs.openSync(drive.devicePath, 'r');
    const out = fs.openSync(outPath, 'w');
    const buf = Buffer.alloc(1 << 20);
    let pos = 0;
    try {
      for (;;) {
        const want = totalBytes > 0 ? Math.min(buf.length, totalBytes - pos) : buf.length;
        if (want <= 0) break;
        const n = fs.readSync(fd, buf, 0, want, pos);
        if (n <= 0) break;
        fs.writeSync(out, buf, 0, n);
        pos += n;
        emitProgress({
          jobId: 'rip',
          phase: 'reading',
          percent: totalBytes ? (pos / totalBytes) * 100 : 0,
          bytesProcessed: pos,
          totalBytes,
          speedBps: 0,
          etaSeconds: 0,
          message: 'Reading disc'
        });
      }
    } finally {
      fs.closeSync(fd);
      fs.closeSync(out);
    }
    log.success(`Disc image written: ${outPath} (${pos} bytes)`);
    return { bytesWritten: pos };
  });

  ipcMain.handle(Channels.burnRun, async (_e, req: BurnRequest): Promise<BurnResponse> => {
    await driveManager.listDrives({ includeSimulated: true });
    const spec = burnEngine.createJob(req.imagePath, req.driveId, req.options);
    burnEngine.enqueue(spec);
    const onProgress = (e: ProgressEvent) => emitProgress(e);
    const unsub = burnEngine.queue.events.on('progress', onProgress);
    try {
      const summary = await burnEngine.process();
      const job = burnEngine.list().find((j) => j.spec.id === spec.id);
      return {
        ok: summary.failed === 0 && job?.status === 'succeeded',
        simulated: job?.simulated ?? true,
        jobId: spec.id,
        error: job?.error,
        verify: job?.verifyResult
      };
    } finally {
      unsub();
    }
  });

  ipcMain.handle(Channels.burnCancel, (_e, jobId: string) => {
    burnEngine.cancel(jobId);
  });

  // Dialogs
  ipcMain.handle(Channels.dialogOpenFiles, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle(Channels.dialogOpenFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(Channels.dialogOpenImage, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Disc images', extensions: SUPPORTED_IMAGE_EXTENSIONS.map((e) => e.slice(1)) }]
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle(Channels.dialogSave, async (_e, defaultName: string) => {
    const r = await dialog.showSaveDialog({ defaultPath: defaultName });
    return r.canceled ? null : r.filePath ?? null;
  });
}
