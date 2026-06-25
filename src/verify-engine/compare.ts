/** Sector-by-sector binary comparison between two images/files. */
import * as fs from 'node:fs';
import type { SectorMismatch } from '../shared/types';

export interface CompareProgress {
  (bytesCompared: number, totalBytes: number): void;
}

export interface CompareResult {
  sectorsCompared: number;
  bytesCompared: number;
  mismatches: SectorMismatch[];
  sizeMismatch: boolean;
  sourceSize: number;
  targetSize: number;
}

/**
 * Compare two files sector by sector. Stops collecting detailed mismatches
 * after `maxMismatches` but keeps counting compared sectors.
 */
export async function compareFiles(
  sourcePath: string,
  targetPath: string,
  sectorSize: number,
  onProgress?: CompareProgress,
  maxMismatches = 50
): Promise<CompareResult> {
  const sourceSize = fs.statSync(sourcePath).size;
  const targetSize = fs.statSync(targetPath).size;
  const compareLen = Math.min(sourceSize, targetSize);

  const a = fs.openSync(sourcePath, 'r');
  const b = fs.openSync(targetPath, 'r');
  const mismatches: SectorMismatch[] = [];
  let bytesCompared = 0;
  let sectorsCompared = 0;

  try {
    const bufA = Buffer.alloc(1 << 20);
    const bufB = Buffer.alloc(1 << 20);
    // Keep the read window a whole number of sectors.
    const window = Math.max(sectorSize, Math.floor(bufA.length / sectorSize) * sectorSize);
    let pos = 0;
    while (pos < compareLen) {
      const toRead = Math.min(window, compareLen - pos);
      fs.readSync(a, bufA, 0, toRead, pos);
      fs.readSync(b, bufB, 0, toRead, pos);
      for (let i = 0; i < toRead; i++) {
        if (bufA[i] !== bufB[i] && mismatches.length < maxMismatches) {
          const absolute = pos + i;
          mismatches.push({
            sector: Math.floor(absolute / sectorSize),
            offset: absolute % sectorSize,
            sourceByte: bufA[i],
            targetByte: bufB[i]
          });
        }
      }
      pos += toRead;
      bytesCompared = pos;
      sectorsCompared = Math.ceil(pos / sectorSize);
      onProgress?.(bytesCompared, compareLen);
    }
  } finally {
    fs.closeSync(a);
    fs.closeSync(b);
  }

  return {
    sectorsCompared,
    bytesCompared,
    mismatches,
    sizeMismatch: sourceSize !== targetSize,
    sourceSize,
    targetSize
  };
}
