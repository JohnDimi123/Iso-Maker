/**
 * Image-format plugin registry.
 *
 * Each supported container (ISO, BIN/CUE, IMG, NRG, …) is described by an
 * {@link ImageFormatHandler}. Additional formats can be contributed at
 * runtime via {@link registerFormat}, which is what the plugin loader uses,
 * giving Iso Maker an extensible, ImgBurn-style format architecture.
 */
import { extname } from 'node:path';
import * as fs from 'node:fs';
import type { ImageFormatId, ImageInfo } from '../../shared/types';

export interface ImageFormatHandler {
  id: ImageFormatId;
  name: string;
  /** File extensions handled, lower-case with leading dot. */
  extensions: string[];
  /** Content sniff: inspect the first bytes / file to claim the file. */
  detect(filePath: string, header: Buffer): boolean;
  /** Produce a metadata summary for the file. */
  info(filePath: string): Promise<ImageInfo>;
}

const handlers: ImageFormatHandler[] = [];

export function registerFormat(handler: ImageFormatHandler): void {
  const idx = handlers.findIndex((h) => h.id === handler.id);
  if (idx >= 0) handlers[idx] = handler;
  else handlers.push(handler);
}

export function listFormats(): ImageFormatHandler[] {
  return [...handlers];
}

function readHeader(filePath: string, bytes = 4096): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolve the best handler for a file, preferring content detection then extension. */
export function resolveHandler(filePath: string): ImageFormatHandler | null {
  const ext = extname(filePath).toLowerCase();
  let header: Buffer = Buffer.alloc(0);
  try {
    header = readHeader(filePath);
  } catch {
    /* may be a .cue referencing data; detection can still run on extension */
  }
  // Content detection wins.
  for (const h of handlers) {
    try {
      if (h.detect(filePath, header)) return h;
    } catch {
      /* a handler that errors during detection simply abstains */
    }
  }
  // Fall back to extension.
  return handlers.find((h) => h.extensions.includes(ext)) ?? null;
}

export async function inspect(filePath: string): Promise<ImageInfo> {
  const handler = resolveHandler(filePath);
  if (!handler) {
    const size = fs.statSync(filePath).size;
    return {
      format: 'unknown',
      formatName: 'Unknown / raw data',
      filePath,
      sizeBytes: size,
      sectorSize: 2048,
      sectorCount: Math.ceil(size / 2048),
      fileSystem: 'unknown',
      bootable: false,
      notes: ['Format not recognised; treated as a raw sector dump.']
    };
  }
  return handler.info(filePath);
}
