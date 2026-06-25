/**
 * ISO9660 / Joliet reader and extractor.
 *
 * Parses the Primary Volume Descriptor (and the Joliet Supplementary
 * descriptor when present), enumerates the directory tree and extracts
 * files. Used for the "Read" mode, image inspection, conversion and the
 * `info`/`extract` CLI commands.
 */
import * as fs from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { SECTOR_SIZE } from '../../shared/constants';
import { Errors } from '../../core/errors';
import type { FileSystemType, ImageFileEntry, ImageInfo } from '../../shared/types';
import { ucs2be } from './structures';

interface RawRecord {
  name: string;
  isDir: boolean;
  extentLBA: number;
  dataLength: number;
}

interface VolumeDescriptor {
  type: number;
  rootLBA: number;
  rootLength: number;
  label: string;
  volumeSpaceSize: number;
  blockSize: number;
  joliet: boolean;
}

function decodeName(id: Buffer, joliet: boolean): string {
  if (id.length === 1 && (id[0] === 0 || id[0] === 1)) return id[0] === 0 ? '.' : '..';
  let name: string;
  if (joliet) {
    // UCS-2 big-endian -> JS string.
    const le = Buffer.alloc(id.length);
    for (let i = 0; i + 1 < id.length; i += 2) {
      le[i] = id[i + 1];
      le[i + 1] = id[i];
    }
    name = le.toString('utf16le');
  } else {
    name = id.toString('ascii');
  }
  const semi = name.indexOf(';');
  if (semi >= 0) name = name.slice(0, semi);
  if (name.endsWith('.')) name = name.slice(0, -1);
  return name;
}

export class Iso9660Reader {
  private constructor(
    private readonly fd: number,
    readonly fileSize: number
  ) {}

  static open(path: string): Iso9660Reader {
    const st = fs.statSync(path);
    const fd = fs.openSync(path, 'r');
    return new Iso9660Reader(fd, st.size);
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* ignore */
    }
  }

  private readSector(lba: number, count = 1): Buffer {
    const buf = Buffer.alloc(SECTOR_SIZE * count);
    fs.readSync(this.fd, buf, 0, buf.length, lba * SECTOR_SIZE);
    return buf;
  }

  /** Parse the volume descriptor set. Returns null if not an ISO9660 volume. */
  parseVolume(): { primary: VolumeDescriptor; joliet?: VolumeDescriptor; bootable: boolean } | null {
    if (this.fileSize < 17 * SECTOR_SIZE) return null;
    let primary: VolumeDescriptor | undefined;
    let joliet: VolumeDescriptor | undefined;
    let bootable = false;

    for (let lba = 16; lba < 16 + 32 && lba * SECTOR_SIZE < this.fileSize; lba++) {
      const sec = this.readSector(lba);
      if (sec.toString('ascii', 1, 6) !== 'CD001') {
        if (lba === 16) return null;
        break;
      }
      const type = sec[0];
      if (type === 255) break; // terminator
      if (type === 0) {
        bootable = true;
        continue;
      }
      if (type === 1 || type === 2) {
        const isJoliet = type === 2 && sec[88] === 0x25 && sec[89] === 0x2f;
        const desc: VolumeDescriptor = {
          type,
          label: this.readLabel(sec, isJoliet),
          volumeSpaceSize: sec.readUInt32LE(80),
          blockSize: sec.readUInt16LE(128) || SECTOR_SIZE,
          rootLBA: sec.readUInt32LE(156 + 2),
          rootLength: sec.readUInt32LE(156 + 10),
          joliet: isJoliet
        };
        if (type === 1) primary = desc;
        else if (isJoliet) joliet = desc;
      }
    }
    if (!primary) return null;
    return { primary, joliet, bootable };
  }

  private readLabel(sec: Buffer, joliet: boolean): string {
    const raw = sec.subarray(40, 72);
    if (joliet) {
      const le = Buffer.alloc(raw.length);
      for (let i = 0; i + 1 < raw.length; i += 2) {
        le[i] = raw[i + 1];
        le[i + 1] = raw[i];
      }
      return le.toString('utf16le').replace(/\0+$/, '').trim();
    }
    return raw.toString('ascii').trim();
  }

  private readDirectory(lba: number, length: number, joliet: boolean): RawRecord[] {
    const sectors = Math.max(1, Math.ceil(length / SECTOR_SIZE));
    const buf = this.readSector(lba, sectors);
    const records: RawRecord[] = [];
    let off = 0;
    while (off < buf.length) {
      const len = buf[off];
      if (len === 0) {
        // Advance to the next sector boundary.
        const next = (Math.floor(off / SECTOR_SIZE) + 1) * SECTOR_SIZE;
        if (next <= off) break;
        off = next;
        continue;
      }
      const extentLBA = buf.readUInt32LE(off + 2);
      const dataLength = buf.readUInt32LE(off + 10);
      const flags = buf[off + 25];
      const idLen = buf[off + 32];
      const id = buf.subarray(off + 33, off + 33 + idLen);
      records.push({
        name: decodeName(id, joliet),
        isDir: (flags & 0x02) !== 0,
        extentLBA,
        dataLength
      });
      off += len;
    }
    return records;
  }

  /** Recursively list every entry, depth-first. */
  listAll(maxEntries = 100000): ImageFileEntry[] {
    const vol = this.parseVolume();
    if (!vol) throw Errors.format('Not a valid ISO9660 image');
    const useJoliet = !!vol.joliet;
    const root = vol.joliet ?? vol.primary;
    const out: ImageFileEntry[] = [];

    const walk = (lba: number, length: number, prefix: string) => {
      if (out.length >= maxEntries) return;
      for (const rec of this.readDirectory(lba, length, useJoliet)) {
        if (rec.name === '.' || rec.name === '..') continue;
        const path = prefix ? `${prefix}/${rec.name}` : rec.name;
        out.push({ path, size: rec.dataLength, isDirectory: rec.isDir, sector: rec.extentLBA });
        if (rec.isDir) walk(rec.extentLBA, rec.dataLength, path);
      }
    };
    walk(root.rootLBA, root.rootLength, '');
    return out;
  }

  /** Build an {@link ImageInfo} summary. */
  info(filePath: string): ImageInfo | null {
    const vol = this.parseVolume();
    if (!vol) return null;
    const fileSystem: FileSystemType = vol.joliet ? 'ISO9660+Joliet' : 'ISO9660';
    const root = vol.joliet ?? vol.primary;
    const topLevel = this.readDirectory(root.rootLBA, root.rootLength, !!vol.joliet)
      .filter((r) => r.name !== '.' && r.name !== '..')
      .map<ImageFileEntry>((r) => ({
        path: r.name,
        size: r.dataLength,
        isDirectory: r.isDir,
        sector: r.extentLBA
      }));
    return {
      format: 'iso',
      formatName: 'ISO9660 / Joliet image',
      filePath,
      sizeBytes: vol.primary.volumeSpaceSize * vol.primary.blockSize,
      sectorSize: vol.primary.blockSize,
      sectorCount: vol.primary.volumeSpaceSize,
      fileSystem,
      label: (vol.joliet?.label || vol.primary.label).trim(),
      bootable: vol.bootable,
      entries: topLevel
    };
  }

  /** Locate a record for a slash-separated path within the image. */
  private resolve(path: string): RawRecord | null {
    const vol = this.parseVolume();
    if (!vol) return null;
    const useJoliet = !!vol.joliet;
    const root = vol.joliet ?? vol.primary;
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    let lba = root.rootLBA;
    let length = root.rootLength;
    let current: RawRecord | null = {
      name: '',
      isDir: true,
      extentLBA: lba,
      dataLength: length
    };
    for (const part of parts) {
      const recs = this.readDirectory(lba, length, useJoliet);
      const found = recs.find((r) => r.name.toLowerCase() === part.toLowerCase());
      if (!found) return null;
      current = found;
      lba = found.extentLBA;
      length = found.dataLength;
    }
    return current;
  }

  /** Extract a single file to a destination path on disk. */
  extractFile(pathInImage: string, destPath: string): number {
    const rec = this.resolve(pathInImage);
    if (!rec || rec.isDir) throw Errors.io(`File not found in image: ${pathInImage}`);
    fs.mkdirSync(dirname(destPath), { recursive: true });
    const out = fs.openSync(destPath, 'w');
    try {
      let remaining = rec.dataLength;
      let pos = rec.extentLBA * SECTOR_SIZE;
      const buf = Buffer.alloc(1 << 20);
      while (remaining > 0) {
        const toRead = Math.min(buf.length, remaining);
        const n = fs.readSync(this.fd, buf, 0, toRead, pos);
        if (n <= 0) break;
        fs.writeSync(out, buf, 0, n);
        remaining -= n;
        pos += n;
      }
      return rec.dataLength - remaining;
    } finally {
      fs.closeSync(out);
    }
  }

  /** Extract every file to a destination directory. */
  extractAll(destDir: string, onProgress?: (path: string, done: number, total: number) => void): number {
    const entries = this.listAll().filter((e) => !e.isDirectory);
    const total = entries.reduce((a, e) => a + e.size, 0);
    let done = 0;
    const root = resolve(destDir);
    for (const e of entries) {
      // Guard against path traversal from a maliciously crafted image
      // ("zip-slip"): drop any empty, '.' or '..' components and any leading
      // slash so every extracted file is confined to destDir, then verify the
      // resolved target still lives under the destination root.
      const rel = e.path.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join(sep);
      const target = join(root, rel);
      if (target !== root && !target.startsWith(root + sep)) {
        throw Errors.io(`Refusing to extract entry outside target directory: ${e.path}`);
      }
      this.extractFile(e.path, target);
      done += e.size;
      onProgress?.(e.path, done, total);
    }
    return entries.length;
  }
}
