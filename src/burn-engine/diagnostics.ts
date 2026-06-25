/**
 * Testing & diagnostics.
 *
 * `readTest` performs a real sequential read of an image file (or any
 * readable device path), measuring per-region throughput, flagging slow
 * regions and recording read errors / bad sectors. It produces a
 * {@link DiagnosticsReport} suitable for the Test mode UI and the `test` CLI
 * command.
 */
import * as fs from 'node:fs';
import { SECTOR_SIZE } from '../shared/constants';
import type { DiagnosticsReport, MediaInfo, SurfaceScanBlock } from '../shared/types';
import { logger } from '../core/logger';
import { noMedia } from '../hal/util';

export interface ReadTestProgress {
  (sectorsDone: number, sectorsTotal: number, speedBps: number): void;
}

export interface ReadTestOptions {
  /** Approximate number of surface-scan buckets to record. */
  buckets?: number;
  media?: MediaInfo;
  driveId?: string;
}

export async function readTest(
  path: string,
  onProgress?: ReadTestProgress,
  options: ReadTestOptions = {}
): Promise<DiagnosticsReport> {
  const log = logger.child('diagnostics');
  const size = fs.statSync(path).size;
  const totalSectors = Math.max(1, Math.ceil(size / SECTOR_SIZE));
  const buckets = options.buckets ?? 200;
  const bucketSectors = Math.max(512, Math.ceil(totalSectors / buckets));
  const blockBytes = bucketSectors * SECTOR_SIZE;

  const fd = fs.openSync(path, 'r');
  const blocks: SurfaceScanBlock[] = [];
  let badSectors = 0;
  let totalBytesRead = 0;
  const started = Date.now();

  try {
    const buf = Buffer.alloc(blockBytes);
    let sector = 0;
    while (sector < totalSectors) {
      const offset = sector * SECTOR_SIZE;
      const toRead = Math.min(blockBytes, size - offset);
      const t0 = Date.now();
      let status: SurfaceScanBlock['status'] = 'ok';
      let read = 0;
      try {
        read = fs.readSync(fd, buf, 0, toRead, offset);
      } catch (err) {
        status = 'error';
        badSectors += bucketSectors;
        log.error(`Read error at sector ${sector}: ${(err as Error).message}`);
      }
      const readMs = Date.now() - t0;
      totalBytesRead += read;
      // Flag suspiciously slow regions (heuristic media-quality signal).
      const blockSpeed = read > 0 && readMs > 0 ? (read / readMs) * 1000 : 0;
      if (status === 'ok' && readMs > 0 && blockSpeed > 0 && blockSpeed < 1_000_000) status = 'slow';

      blocks.push({ sector, count: bucketSectors, status, readMs });
      sector += bucketSectors;
      const elapsed = (Date.now() - started) / 1000;
      onProgress?.(Math.min(sector, totalSectors), totalSectors, elapsed > 0 ? totalBytesRead / elapsed : 0);
    }
  } finally {
    fs.closeSync(fd);
  }

  const durationS = Math.max(0.001, (Date.now() - started) / 1000);
  const averageSpeedBps = totalBytesRead / durationS;
  const slow = blocks.filter((b) => b.status === 'slow').length;
  const errors = blocks.filter((b) => b.status === 'error').length;
  const quality = errors > 0 ? 'POOR' : slow > blocks.length * 0.1 ? 'FAIR' : 'GOOD';

  const summary = [
    `Read test of ${path}`,
    `Size: ${(size / 1e6).toFixed(1)} MB, ${totalSectors} sectors`,
    `Average read speed: ${(averageSpeedBps / 1e6).toFixed(2)} MB/s`,
    `Regions scanned: ${blocks.length} (slow: ${slow}, errors: ${errors})`,
    `Estimated bad sectors: ${badSectors}`,
    `Media quality assessment: ${quality}`
  ].join('\n');

  log.success(`Read test complete: ${quality} (${(averageSpeedBps / 1e6).toFixed(2)} MB/s)`);

  return {
    driveId: options.driveId ?? path,
    media: options.media ?? { ...noMedia(), present: true, capacityBytes: size, totalSectors },
    blocks,
    badSectors,
    averageSpeedBps,
    generatedAt: Date.now(),
    summary
  };
}
