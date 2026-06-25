/**
 * ISO9660 + Joliet (+ optional El Torito boot) image builder.
 *
 * Builds a fully valid, mountable ISO image from a flat list of source nodes.
 * The implementation runs in two passes:
 *   1. layout()  — assigns every structure a logical block address (LBA).
 *   2. write()   — streams structures + file data to the output in LBA order.
 *
 * File data is streamed in 1 MiB chunks so images far larger than RAM
 * (the >50 GB requirement) can be produced with bounded memory.
 */
import * as fs from 'node:fs';
import { basename } from 'node:path';
import { SECTOR_SIZE } from '../../shared/constants';
import { Errors } from '../../core/errors';
import type { BuildSpec, BuildResult, FileSystemType } from '../../shared/types';
import {
  STANDARD_ID,
  JOLIET_ESCAPE,
  writeBothEndian16,
  writeBothEndian32,
  writeAString,
  writeJolietString,
  encodeDecDateTime,
  encodeDirDateTime,
  identifierBytes,
  sectorsFor
} from './structures';

// ---------------------------------------------------------------------------
// In-memory tree
// ---------------------------------------------------------------------------

interface Extent {
  lba: number;
  sectors: number;
  bytes: number;
}

interface FileNode {
  kind: 'file';
  name: string;
  sourcePath: string;
  size: number;
  dataLBA: number;
}

interface DirNode {
  kind: 'dir';
  name: string;
  parent: DirNode | null;
  children: Array<DirNode | FileNode>;
  iso: Extent;
  joliet: Extent;
  pathIndexIso: number;
  pathIndexJoliet: number;
}

type AnyNode = DirNode | FileNode;

function newDir(name: string, parent: DirNode | null): DirNode {
  return {
    kind: 'dir',
    name,
    parent,
    children: [],
    iso: { lba: 0, sectors: 1, bytes: SECTOR_SIZE },
    joliet: { lba: 0, sectors: 1, bytes: SECTOR_SIZE },
    pathIndexIso: 1,
    pathIndexJoliet: 1
  };
}

/** Build a directory tree from the flat list of build sources. */
function buildTree(spec: BuildSpec): DirNode {
  const root = newDir('', null);
  const dirCache = new Map<string, DirNode>([['', root]]);

  const ensureDir = (path: string): DirNode => {
    if (dirCache.has(path)) return dirCache.get(path)!;
    const idx = path.lastIndexOf('/');
    const parentPath = idx >= 0 ? path.slice(0, idx) : '';
    const name = idx >= 0 ? path.slice(idx + 1) : path;
    const parent = ensureDir(parentPath);
    let dir = parent.children.find((c): c is DirNode => c.kind === 'dir' && c.name === name);
    if (!dir) {
      dir = newDir(name, parent);
      parent.children.push(dir);
    }
    dirCache.set(path, dir);
    return dir;
  };

  // Sort so parent directories are created before their children.
  const sources = [...spec.sources].sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  for (const node of sources) {
    const norm = node.targetPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!norm) continue;
    if (node.isDirectory) {
      ensureDir(norm);
    } else {
      const idx = norm.lastIndexOf('/');
      const parentPath = idx >= 0 ? norm.slice(0, idx) : '';
      const name = idx >= 0 ? norm.slice(idx + 1) : norm;
      const parent = ensureDir(parentPath);
      if (!parent.children.some((c) => c.kind === 'file' && c.name === name)) {
        parent.children.push({ kind: 'file', name, sourcePath: node.sourcePath, size: node.size, dataLBA: 0 });
      }
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

function sortKey(node: AnyNode, variant: 'iso' | 'joliet', level1: boolean): Buffer {
  return identifierBytes(node.name, node.kind === 'dir', variant, level1);
}

/** Breadth-first directory ordering, children sorted by identifier (per ISO path-table rules). */
function bfsDirs(root: DirNode, variant: 'iso' | 'joliet', level1: boolean): DirNode[] {
  const out: DirNode[] = [root];
  let i = 0;
  while (i < out.length) {
    const dir = out[i++];
    const subdirs = dir.children
      .filter((c): c is DirNode => c.kind === 'dir')
      .sort((a, b) => Buffer.compare(sortKey(a, variant, level1), sortKey(b, variant, level1)));
    out.push(...subdirs);
  }
  return out;
}

function allFiles(root: DirNode): FileNode[] {
  const out: FileNode[] = [];
  const walk = (d: DirNode) => {
    for (const c of d.children.filter((x): x is DirNode => x.kind === 'dir')) walk(c);
    for (const f of d.children.filter((x): x is FileNode => x.kind === 'file')) out.push(f);
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Directory-record packing
// ---------------------------------------------------------------------------

function recordLen(idLen: number): number {
  return 33 + idLen + (idLen % 2 === 0 ? 1 : 0);
}

/** Compute how many sectors a directory's records occupy for a given variant. */
function packDirectorySize(dir: DirNode, variant: 'iso' | 'joliet', level1: boolean): Extent {
  const idLens = [1, 1]; // '.' and '..'
  for (const child of dir.children) {
    idLens.push(identifierBytes(child.name, child.kind === 'dir', variant, level1).length);
  }
  let sectors = 1;
  let pos = 0;
  for (const len of idLens) {
    const rl = recordLen(len);
    if (pos + rl > SECTOR_SIZE) {
      sectors++;
      pos = 0;
    }
    pos += rl;
  }
  return { lba: 0, sectors, bytes: sectors * SECTOR_SIZE };
}

// ---------------------------------------------------------------------------
// Layout pass
// ---------------------------------------------------------------------------

interface Layout {
  root: DirNode;
  level1: boolean;
  joliet: boolean;
  boot: boolean;
  isoOrder: DirNode[];
  jolietOrder: DirNode[];
  files: FileNode[];
  totalFileBytes: number;
  pvdLBA: number;
  bootRecordLBA: number;
  svdLBA: number;
  terminatorLBA: number;
  isoLPathLBA: number;
  isoMPathLBA: number;
  jolLPathLBA: number;
  jolMPathLBA: number;
  isoPathBytes: number;
  jolPathBytes: number;
  bootCatalogLBA: number;
  bootImageLBA: number;
  bootImageSize: number;
  bootSectorCount: number;
  volumeSpaceSize: number;
}

function pathTableBytes(order: DirNode[], variant: 'iso' | 'joliet', level1: boolean): number {
  let total = 0;
  for (const dir of order) {
    const idLen = dir.parent === null ? 1 : identifierBytes(dir.name, true, variant, level1).length;
    total += 8 + idLen + (idLen % 2 === 1 ? 1 : 0); // 8 fixed bytes + id + odd-pad
  }
  return total;
}

export function layout(spec: BuildSpec): Layout {
  const level1 = !!spec.strictIso9660;
  const joliet = spec.fileSystems.joliet;
  const boot = !!(spec.boot.enabled && spec.boot.bootImagePath);

  const root = buildTree(spec);
  const isoOrder = bfsDirs(root, 'iso', level1);
  const jolietOrder = joliet ? bfsDirs(root, 'joliet', level1) : [];

  isoOrder.forEach((d, i) => (d.pathIndexIso = i + 1));
  jolietOrder.forEach((d, i) => (d.pathIndexJoliet = i + 1));

  for (const d of isoOrder) d.iso = packDirectorySize(d, 'iso', level1);
  if (joliet) for (const d of jolietOrder) d.joliet = packDirectorySize(d, 'joliet', level1);

  const isoPathBytes = pathTableBytes(isoOrder, 'iso', level1);
  const jolPathBytes = joliet ? pathTableBytes(jolietOrder, 'joliet', level1) : 0;

  let lba = 16;
  const pvdLBA = lba++;
  const bootRecordLBA = boot ? lba++ : -1;
  const svdLBA = joliet ? lba++ : -1;
  const terminatorLBA = lba++;

  const isoLPathLBA = lba;
  lba += sectorsFor(isoPathBytes);
  const isoMPathLBA = lba;
  lba += sectorsFor(isoPathBytes);

  let jolLPathLBA = -1;
  let jolMPathLBA = -1;
  if (joliet) {
    jolLPathLBA = lba;
    lba += sectorsFor(jolPathBytes);
    jolMPathLBA = lba;
    lba += sectorsFor(jolPathBytes);
  }

  for (const d of isoOrder) {
    d.iso.lba = lba;
    lba += d.iso.sectors;
  }
  if (joliet) {
    for (const d of jolietOrder) {
      d.joliet.lba = lba;
      lba += d.joliet.sectors;
    }
  }

  let bootCatalogLBA = -1;
  let bootImageLBA = -1;
  let bootImageSize = 0;
  let bootSectorCount = 0;
  if (boot) {
    bootCatalogLBA = lba++;
    const st = fs.statSync(spec.boot.bootImagePath!);
    bootImageSize = st.size;
    bootImageLBA = lba;
    lba += sectorsFor(bootImageSize);
    bootSectorCount =
      spec.boot.emulation === 'none' ? Math.min(0xffff, Math.max(1, Math.ceil(bootImageSize / 512))) : 1;
  }

  const files = allFiles(root);
  let totalFileBytes = 0;
  for (const f of files) {
    f.dataLBA = lba;
    lba += sectorsFor(f.size);
    totalFileBytes += f.size;
  }

  return {
    root,
    level1,
    joliet,
    boot,
    isoOrder,
    jolietOrder,
    files,
    totalFileBytes,
    pvdLBA,
    bootRecordLBA,
    svdLBA,
    terminatorLBA,
    isoLPathLBA,
    isoMPathLBA,
    jolLPathLBA,
    jolMPathLBA,
    isoPathBytes,
    jolPathBytes,
    bootCatalogLBA,
    bootImageLBA,
    bootImageSize,
    bootSectorCount,
    volumeSpaceSize: lba
  };
}

// ---------------------------------------------------------------------------
// Sector writer
// ---------------------------------------------------------------------------

class SectorWriter {
  offset = 0;
  private readonly zeros = Buffer.alloc(1 << 20);
  constructor(private readonly fd: number) {}

  writeRaw(buf: Buffer): void {
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(this.fd, buf, written, buf.length - written, this.offset + written);
    }
    this.offset += buf.length;
  }

  writeZeros(n: number): void {
    let remaining = n;
    while (remaining > 0) {
      const chunk = Math.min(remaining, this.zeros.length);
      this.writeRaw(chunk === this.zeros.length ? this.zeros : this.zeros.subarray(0, chunk));
      remaining -= chunk;
    }
  }

  padToSector(): void {
    const rem = this.offset % SECTOR_SIZE;
    if (rem) this.writeZeros(SECTOR_SIZE - rem);
  }

  get lba(): number {
    return Math.floor(this.offset / SECTOR_SIZE);
  }
}

// ---------------------------------------------------------------------------
// Record / descriptor encoders
// ---------------------------------------------------------------------------

interface RecordSpec {
  idBytes: Buffer;
  isDir: boolean;
  extentLBA: number;
  dataLength: number;
}

function writeDirectoryRecord(buf: Buffer, off: number, rec: RecordSpec): number {
  const idLen = rec.idBytes.length;
  const len = recordLen(idLen);
  buf[off] = len;
  buf[off + 1] = 0; // extended attribute record length
  writeBothEndian32(buf, off + 2, rec.extentLBA);
  writeBothEndian32(buf, off + 10, rec.dataLength);
  encodeDirDateTime(new Date()).copy(buf, off + 18);
  buf[off + 25] = rec.isDir ? 0x02 : 0x00; // file flags
  buf[off + 26] = 0; // file unit size
  buf[off + 27] = 0; // interleave gap size
  writeBothEndian16(buf, off + 28, 1); // volume sequence number
  buf[off + 32] = idLen;
  rec.idBytes.copy(buf, off + 33);
  // Padding byte after identifier when idLen is even.
  if (idLen % 2 === 0) buf[off + 33 + idLen] = 0;
  return len;
}

function buildRecords(dir: DirNode, variant: 'iso' | 'joliet', level1: boolean): RecordSpec[] {
  const ext = (n: DirNode) => (variant === 'iso' ? n.iso : n.joliet);
  const recs: RecordSpec[] = [];
  const self = ext(dir);
  const parent = ext(dir.parent ?? dir);
  recs.push({ idBytes: Buffer.from([0]), isDir: true, extentLBA: self.lba, dataLength: self.bytes });
  recs.push({ idBytes: Buffer.from([1]), isDir: true, extentLBA: parent.lba, dataLength: parent.bytes });

  const children = [...dir.children].sort((a, b) =>
    Buffer.compare(sortKey(a, variant, level1), sortKey(b, variant, level1))
  );
  for (const child of children) {
    if (child.kind === 'dir') {
      const e = ext(child);
      recs.push({
        idBytes: identifierBytes(child.name, true, variant, level1),
        isDir: true,
        extentLBA: e.lba,
        dataLength: e.bytes
      });
    } else {
      recs.push({
        idBytes: identifierBytes(child.name, false, variant, level1),
        isDir: false,
        extentLBA: child.dataLBA,
        dataLength: child.size
      });
    }
  }
  return recs;
}

function writeDirectoryExtent(writer: SectorWriter, dir: DirNode, variant: 'iso' | 'joliet', level1: boolean): void {
  const recs = buildRecords(dir, variant, level1);
  let sector = Buffer.alloc(SECTOR_SIZE);
  let pos = 0;
  for (const rec of recs) {
    const len = recordLen(rec.idBytes.length);
    if (pos + len > SECTOR_SIZE) {
      writer.writeRaw(sector);
      sector = Buffer.alloc(SECTOR_SIZE);
      pos = 0;
    }
    writeDirectoryRecord(sector, pos, rec);
    pos += len;
  }
  writer.writeRaw(sector);
}

function writePathTable(
  writer: SectorWriter,
  order: DirNode[],
  variant: 'iso' | 'joliet',
  endian: 'le' | 'be',
  level1: boolean,
  byteLen: number
): void {
  const indexOf = (d: DirNode) => (variant === 'iso' ? d.pathIndexIso : d.pathIndexJoliet);
  const buf = Buffer.alloc(sectorsFor(byteLen) * SECTOR_SIZE);
  let off = 0;
  for (const dir of order) {
    const idBytes = dir.parent === null ? Buffer.from([0]) : identifierBytes(dir.name, true, variant, level1);
    const idLen = idBytes.length;
    const ext = variant === 'iso' ? dir.iso : dir.joliet;
    const parentNum = indexOf(dir.parent ?? dir);
    buf[off] = idLen;
    buf[off + 1] = 0; // extended attribute record length
    if (endian === 'le') {
      buf.writeUInt32LE(ext.lba >>> 0, off + 2);
      buf.writeUInt16LE(parentNum & 0xffff, off + 6);
    } else {
      buf.writeUInt32BE(ext.lba >>> 0, off + 2);
      buf.writeUInt16BE(parentNum & 0xffff, off + 6);
    }
    idBytes.copy(buf, off + 8);
    off += 8 + idLen + (idLen % 2 === 1 ? 1 : 0);
  }
  writer.writeRaw(buf);
}

function sanitizeLabel(label: string): string {
  return (label || 'ISO_VOLUME').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32);
}

function buildVolumeDescriptor(
  type: 0 | 1 | 2 | 255,
  layout: Layout,
  spec: BuildSpec,
  variant: 'iso' | 'joliet'
): Buffer {
  const buf = Buffer.alloc(SECTOR_SIZE);
  buf[0] = type;
  writeAString(buf, 1, STANDARD_ID, 5);
  buf[6] = 1; // version

  if (type === 255) return buf; // terminator: type + id + version, rest zero

  const joliet = variant === 'joliet';
  const now = new Date();

  if (joliet) {
    JOLIET_ESCAPE.copy(buf, 88); // escape sequences -> UCS-2 level 3
    writeJolietString(buf, 8, '', 32); // system identifier
    writeJolietString(buf, 40, spec.volumeLabel || 'ISO Volume', 32);
  } else {
    writeAString(buf, 8, 'ISO MAKER', 32);
    writeAString(buf, 40, sanitizeLabel(spec.volumeLabel), 32);
  }

  writeBothEndian32(buf, 80, layout.volumeSpaceSize);
  writeBothEndian16(buf, 120, 1); // volume set size
  writeBothEndian16(buf, 124, 1); // volume sequence number
  writeBothEndian16(buf, 128, SECTOR_SIZE); // logical block size

  const pathBytes = joliet ? layout.jolPathBytes : layout.isoPathBytes;
  const lPath = joliet ? layout.jolLPathLBA : layout.isoLPathLBA;
  const mPath = joliet ? layout.jolMPathLBA : layout.isoMPathLBA;
  writeBothEndian32(buf, 132, pathBytes);
  buf.writeUInt32LE(lPath >>> 0, 140);
  buf.writeUInt32LE(0, 144);
  buf.writeUInt32BE(mPath >>> 0, 148);
  buf.writeUInt32BE(0, 152);

  // Root directory record (34 bytes) at offset 156.
  const rootExt = joliet ? layout.root.joliet : layout.root.iso;
  writeDirectoryRecord(buf, 156, {
    idBytes: Buffer.from([0]),
    isDir: true,
    extentLBA: rootExt.lba,
    dataLength: rootExt.bytes
  });

  const writeIdField = joliet
    ? (o: number, s: string, l: number) => writeJolietString(buf, o, s, l)
    : (o: number, s: string, l: number) => writeAString(buf, o, s, l);
  writeIdField(190, '', 128); // volume set id
  writeIdField(318, joliet ? 'Iso Maker' : 'ISO MAKER', 128); // publisher
  writeIdField(446, joliet ? 'Iso Maker' : 'ISO MAKER', 128); // data preparer
  writeIdField(574, joliet ? 'Iso Maker' : 'ISO MAKER', 128); // application

  encodeDecDateTime(now).copy(buf, 813); // creation
  encodeDecDateTime(now).copy(buf, 830); // modification
  encodeDecDateTime(null).copy(buf, 847); // expiration
  encodeDecDateTime(now).copy(buf, 864); // effective
  buf[881] = 1; // file structure version
  return buf;
}

function buildBootRecord(layout: Layout): Buffer {
  const buf = Buffer.alloc(SECTOR_SIZE);
  buf[0] = 0;
  writeAString(buf, 1, STANDARD_ID, 5);
  buf[6] = 1;
  // The El Torito boot-system identifier must be NUL-padded (not space-padded),
  // otherwise strict readers fail to recognise the boot record. The buffer is
  // already zero-filled, so we just copy the ASCII bytes.
  Buffer.from('EL TORITO SPECIFICATION', 'ascii').copy(buf, 7);
  buf.writeUInt32LE(layout.bootCatalogLBA >>> 0, 71);
  return buf;
}

function buildBootCatalog(layout: Layout, spec: BuildSpec): Buffer {
  const buf = Buffer.alloc(SECTOR_SIZE);
  // Validation entry
  buf[0] = 1; // header id
  buf[1] = 0; // platform: 80x86
  buf[30] = 0x55;
  buf[31] = 0xaa;
  let sum = 0;
  for (let i = 0; i < 32; i += 2) sum = (sum + buf.readUInt16LE(i)) & 0xffff;
  buf.writeUInt16LE((0x10000 - sum) & 0xffff, 28);
  // Initial/default entry
  const mediaType =
    spec.boot.emulation === 'floppy1.44'
      ? 2
      : spec.boot.emulation === 'floppy2.88'
        ? 3
        : spec.boot.emulation === 'hdd'
          ? 4
          : 0;
  buf[32] = 0x88; // bootable
  buf[33] = mediaType;
  buf.writeUInt16LE(spec.boot.loadSegment ?? 0, 34);
  buf[36] = 0; // system type
  buf.writeUInt16LE(layout.bootSectorCount & 0xffff, 38);
  buf.writeUInt32LE(layout.bootImageLBA >>> 0, 40);
  return buf;
}

function loadBootImage(layout: Layout, spec: BuildSpec): Buffer {
  const data = fs.readFileSync(spec.boot.bootImagePath!);
  if (spec.boot.bootInfoTable && data.length >= 64) {
    // Standard 56-byte boot information table at offset 8.
    data.writeUInt32LE(layout.pvdLBA >>> 0, 8);
    data.writeUInt32LE(layout.bootImageLBA >>> 0, 12);
    data.writeUInt32LE(data.length >>> 0, 16);
    let checksum = 0;
    for (let i = 64; i + 4 <= data.length; i += 4) checksum = (checksum + data.readUInt32LE(i)) >>> 0;
    data.writeUInt32LE(checksum >>> 0, 20);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildProgress {
  (bytesProcessed: number, totalBytes: number, message: string): void;
}

export function calculateBuildSize(spec: BuildSpec): { sizeBytes: number; sectorCount: number } {
  const l = layout(spec);
  return { sizeBytes: l.volumeSpaceSize * SECTOR_SIZE, sectorCount: l.volumeSpaceSize };
}

export function deriveFileSystem(spec: BuildSpec): FileSystemType {
  if (spec.fileSystems.udf && spec.fileSystems.joliet) return 'UDF';
  if (spec.fileSystems.joliet) return 'ISO9660+Joliet';
  return 'ISO9660';
}

export async function buildIso(
  spec: BuildSpec,
  onProgress?: BuildProgress,
  signal?: { aborted: boolean }
): Promise<BuildResult> {
  if (!spec.outputPath) throw Errors.io('No output path specified');
  if (spec.sources.length === 0) throw Errors.format('Build contains no files');
  const started = Date.now();
  const l = layout(spec);

  const fd = fs.openSync(spec.outputPath, 'w');
  const writer = new SectorWriter(fd);
  const expect = (lba: number, what: string) => {
    if (writer.lba !== lba) {
      throw Errors.internal(`Layout drift writing ${what}: at LBA ${writer.lba}, expected ${lba}`);
    }
  };

  try {
    onProgress?.(0, l.totalFileBytes, 'Writing volume structures');
    writer.writeZeros(16 * SECTOR_SIZE); // system area

    expect(l.pvdLBA, 'PVD');
    writer.writeRaw(buildVolumeDescriptor(1, l, spec, 'iso'));
    if (l.boot) {
      expect(l.bootRecordLBA, 'boot record');
      writer.writeRaw(buildBootRecord(l));
    }
    if (l.joliet) {
      expect(l.svdLBA, 'SVD');
      writer.writeRaw(buildVolumeDescriptor(2, l, spec, 'joliet'));
    }
    expect(l.terminatorLBA, 'terminator');
    writer.writeRaw(buildVolumeDescriptor(255, l, spec, 'iso'));

    expect(l.isoLPathLBA, 'ISO L path table');
    writePathTable(writer, l.isoOrder, 'iso', 'le', l.level1, l.isoPathBytes);
    expect(l.isoMPathLBA, 'ISO M path table');
    writePathTable(writer, l.isoOrder, 'iso', 'be', l.level1, l.isoPathBytes);
    if (l.joliet) {
      expect(l.jolLPathLBA, 'Joliet L path table');
      writePathTable(writer, l.jolietOrder, 'joliet', 'le', l.level1, l.jolPathBytes);
      expect(l.jolMPathLBA, 'Joliet M path table');
      writePathTable(writer, l.jolietOrder, 'joliet', 'be', l.level1, l.jolPathBytes);
    }

    expect(l.isoOrder[0].iso.lba, 'ISO root directory');
    for (const dir of l.isoOrder) writeDirectoryExtent(writer, dir, 'iso', l.level1);
    if (l.joliet) for (const dir of l.jolietOrder) writeDirectoryExtent(writer, dir, 'joliet', l.level1);

    if (l.boot) {
      expect(l.bootCatalogLBA, 'boot catalog');
      writer.writeRaw(buildBootCatalog(l, spec));
      expect(l.bootImageLBA, 'boot image');
      writer.writeRaw(loadBootImage(l, spec));
      writer.padToSector();
    }

    // File data — streamed.
    let processed = 0;
    for (const file of l.files) {
      if (signal?.aborted) throw Errors.cancelled();
      expect(file.dataLBA, `file ${file.name}`);
      copyFileInto(writer, file.sourcePath, file.size, (n) => {
        processed += n;
        onProgress?.(processed, l.totalFileBytes, `Adding ${file.name}`);
      });
      writer.padToSector();
    }

    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  const sizeBytes = l.volumeSpaceSize * SECTOR_SIZE;
  return {
    outputPath: spec.outputPath,
    sizeBytes,
    sectorCount: l.volumeSpaceSize,
    fileSystem: deriveFileSystem(spec),
    volumeLabel: spec.volumeLabel,
    bootable: l.boot,
    durationMs: Date.now() - started
  };
}

function copyFileInto(
  writer: SectorWriter,
  sourcePath: string,
  size: number,
  onChunk: (n: number) => void
): void {
  const fd = fs.openSync(sourcePath, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let remaining = size;
    while (remaining > 0) {
      const toRead = Math.min(buf.length, remaining);
      const n = fs.readSync(fd, buf, 0, toRead, null);
      if (n <= 0) break;
      writer.writeRaw(buf.subarray(0, n));
      remaining -= n;
      onChunk(n);
    }
    if (remaining > 0) writer.writeZeros(remaining); // source shrank: pad
  } finally {
    fs.closeSync(fd);
  }
}

export const __testing = { layout, buildTree, basename };
