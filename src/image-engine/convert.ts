/**
 * Image format conversion.
 *
 * Currently supports converting a single-data-track BIN (MODE1/2048,
 * MODE1/2352, MODE2/2352 form-1) or raw IMG into a plain ISO9660 image by
 * extracting the 2048-byte user area from each sector. ISO→ISO is a verified
 * copy. Audio/multi-track conversion is explicitly rejected rather than
 * producing a corrupt result.
 */
import * as fs from 'node:fs';
import { RAW_SECTOR_SIZE, SECTOR_SIZE } from '../shared/constants';
import { Errors } from '../core/errors';
import type { ImageFormatId } from '../shared/types';
import { inspect } from './formats/registry';

export interface ConvertProgress {
  (bytesWritten: number, totalBytes: number): void;
}

export interface ConvertResult {
  outputPath: string;
  sourceFormat: ImageFormatId;
  targetFormat: 'iso';
  bytesWritten: number;
}

export async function convertToIso(
  sourcePath: string,
  outputPath: string,
  onProgress?: ConvertProgress
): Promise<ConvertResult> {
  const info = await inspect(sourcePath);
  if (info.tracks && info.tracks.filter((t) => t.type === 'audio').length > 0) {
    throw Errors.unsupported('Cannot convert audio tracks to ISO; ISO9660 is a data-only format.');
  }
  if (info.tracks && info.tracks.length > 1) {
    throw Errors.unsupported('Multi-track images cannot be flattened into a single ISO.');
  }

  const sectorSize = info.format === 'bincue' ? info.sectorSize : SECTOR_SIZE;
  const mode = info.tracks?.[0]?.mode?.toUpperCase() ?? 'MODE1/2048';

  // For ISO/IMG already at 2048 we just copy.
  if ((info.format === 'iso' || info.format === 'img') && sectorSize === SECTOR_SIZE) {
    const bytes = streamCopy(sourcePath, outputPath, onProgress);
    return { outputPath, sourceFormat: info.format, targetFormat: 'iso', bytesWritten: bytes };
  }

  // BIN with the real disc image — locate the .bin if a .cue was supplied.
  let dataPath = sourcePath;
  if (sourcePath.toLowerCase().endsWith('.cue')) {
    const guess = sourcePath.replace(/\.cue$/i, '.bin');
    if (!fs.existsSync(guess)) throw Errors.io('Could not locate the BIN referenced by the cue sheet.');
    dataPath = guess;
  }

  if (sectorSize === SECTOR_SIZE) {
    const bytes = streamCopy(dataPath, outputPath, onProgress);
    return { outputPath, sourceFormat: info.format, targetFormat: 'iso', bytesWritten: bytes };
  }

  if (sectorSize !== RAW_SECTOR_SIZE) {
    throw Errors.unsupported(`Unsupported sector size for conversion: ${sectorSize}`);
  }

  // Extract the 2048-byte user field from each 2352-byte raw sector.
  const userOffset = mode.startsWith('MODE2') ? 24 : 16;
  return extractUserData(dataPath, outputPath, userOffset, info.format, onProgress);
}

function streamCopy(src: string, dest: string, onProgress?: ConvertProgress): number {
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(dest, 'w');
  try {
    const total = fs.fstatSync(inFd).size;
    const buf = Buffer.alloc(1 << 20);
    let written = 0;
    let pos = 0;
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      fs.writeSync(outFd, buf, 0, n);
      written += n;
      pos += n;
      onProgress?.(written, total);
    }
    return written;
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

function extractUserData(
  src: string,
  dest: string,
  userOffset: number,
  sourceFormat: ImageFormatId,
  onProgress?: ConvertProgress
): ConvertResult {
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(dest, 'w');
  try {
    const size = fs.fstatSync(inFd).size;
    const sectorCount = Math.floor(size / RAW_SECTOR_SIZE);
    const totalOut = sectorCount * SECTOR_SIZE;
    const raw = Buffer.alloc(RAW_SECTOR_SIZE);
    let written = 0;
    for (let i = 0; i < sectorCount; i++) {
      fs.readSync(inFd, raw, 0, RAW_SECTOR_SIZE, i * RAW_SECTOR_SIZE);
      fs.writeSync(outFd, raw, userOffset, SECTOR_SIZE);
      written += SECTOR_SIZE;
      if (i % 256 === 0) onProgress?.(written, totalOut);
    }
    onProgress?.(written, totalOut);
    return { outputPath: dest, sourceFormat, targetFormat: 'iso', bytesWritten: written };
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}
