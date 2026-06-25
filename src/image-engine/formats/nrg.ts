/**
 * Nero NRG handler.
 *
 * Detects the trailing "NERO" (v1) / "NER5" (v2) chunk that points at the
 * NRG chunk list and reports basic geometry. Full per-track DAOX/ETN2 chunk
 * decoding is a documented extension point.
 */
import * as fs from 'node:fs';
import { SECTOR_SIZE } from '../../shared/constants';
import type { ImageInfo } from '../../shared/types';
import type { ImageFormatHandler } from './registry';

function readTrailer(filePath: string): { version: 1 | 2 | 0; chunkOffset: number } {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 12) return { version: 0, chunkOffset: 0 };
    const tail = Buffer.alloc(12);
    fs.readSync(fd, tail, 0, 12, size - 12);
    // v2 footer: "NER5" + uint64 BE offset (last 12 bytes).
    if (tail.toString('ascii', 0, 4) === 'NER5') {
      return { version: 2, chunkOffset: Number(tail.readBigUInt64BE(4)) };
    }
    // v1 footer: "NERO" + uint32 BE offset (last 8 bytes).
    if (tail.toString('ascii', 4, 8) === 'NERO') {
      return { version: 1, chunkOffset: tail.readUInt32BE(8) };
    }
    return { version: 0, chunkOffset: 0 };
  } finally {
    fs.closeSync(fd);
  }
}

export const nrgFormat: ImageFormatHandler = {
  id: 'nrg',
  name: 'Nero NRG',
  extensions: ['.nrg'],
  detect(filePath) {
    if (!filePath.toLowerCase().endsWith('.nrg')) return false;
    return readTrailer(filePath).version !== 0;
  },
  async info(filePath): Promise<ImageInfo> {
    const size = fs.statSync(filePath).size;
    const trailer = readTrailer(filePath);
    const notes: string[] = [];
    if (trailer.version === 0) notes.push('No NRG trailer found; file may be truncated.');
    else notes.push(`Nero image v${trailer.version}; chunk list at offset ${trailer.chunkOffset}.`);
    notes.push('Per-track decoding (DAOX/ETN2) is available as a plugin extension point.');
    return {
      format: 'nrg',
      formatName: `Nero NRG v${trailer.version || '?'}`,
      filePath,
      sizeBytes: size,
      sectorSize: SECTOR_SIZE,
      sectorCount: Math.ceil(size / SECTOR_SIZE),
      fileSystem: 'unknown',
      bootable: false,
      notes
    };
  }
};
