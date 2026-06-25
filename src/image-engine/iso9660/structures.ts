/**
 * Low-level ISO9660 / Joliet on-disc encoding primitives.
 *
 * References:
 *  - ECMA-119 (ISO 9660)
 *  - Joliet specification (Microsoft)
 *  - "El Torito" Bootable CD-ROM Format Specification v1.0
 */
import { SECTOR_SIZE } from '../../shared/constants';

export const STANDARD_ID = 'CD001';
export const JOLIET_ESCAPE = Buffer.from([0x25, 0x2f, 0x45]); // "%/E" UCS-2 level 3

export type VolumeDescriptorType = 0 | 1 | 2 | 255;

/** ISO 7.2.3 — 16-bit value stored little- then big-endian (4 bytes). */
export function writeBothEndian16(buf: Buffer, off: number, v: number): void {
  buf.writeUInt16LE(v & 0xffff, off);
  buf.writeUInt16BE(v & 0xffff, off + 2);
}

/** ISO 7.3.3 — 32-bit value stored little- then big-endian (8 bytes). */
export function writeBothEndian32(buf: Buffer, off: number, v: number): void {
  buf.writeUInt32LE(v >>> 0, off);
  buf.writeUInt32BE(v >>> 0, off + 4);
}

/** Pad/truncate an ASCII string into a fixed-width, space-filled field. */
export function writeAString(buf: Buffer, off: number, s: string, len: number): void {
  const ascii = Buffer.from(s, 'ascii');
  for (let i = 0; i < len; i++) buf[off + i] = i < ascii.length ? ascii[i] : 0x20;
}

/** Encode a string as UCS-2 big-endian into a fixed field, space-padded (0x00 0x20). */
export function writeJolietString(buf: Buffer, off: number, s: string, len: number): void {
  const enc = ucs2be(s);
  for (let i = 0; i < len; i++) {
    if (i < enc.length) buf[off + i] = enc[i];
    else buf[off + i] = i % 2 === 0 ? 0x00 : 0x20;
  }
}

/** UCS-2 big-endian encoding of a JS string. */
export function ucs2be(s: string): Buffer {
  const le = Buffer.from(s, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

/** ISO 8.4.26.1 — 17-byte decimal date/time used in volume descriptors. */
export function encodeDecDateTime(date: Date | null): Buffer {
  const buf = Buffer.alloc(17, 0x30); // ASCII '0'
  if (!date) {
    buf.fill(0x30);
    buf[16] = 0;
    return buf;
  }
  const s =
    pad4(date.getUTCFullYear()) +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    '00';
  Buffer.from(s, 'ascii').copy(buf, 0);
  buf[16] = 0; // GMT offset (15-min intervals)
  return buf;
}

/** ISO 9.1.5 — 7-byte directory-record date/time. */
export function encodeDirDateTime(date: Date): Buffer {
  const buf = Buffer.alloc(7);
  buf[0] = Math.max(0, date.getUTCFullYear() - 1900) & 0xff;
  buf[1] = date.getUTCMonth() + 1;
  buf[2] = date.getUTCDate();
  buf[3] = date.getUTCHours();
  buf[4] = date.getUTCMinutes();
  buf[5] = date.getUTCSeconds();
  buf[6] = 0; // GMT offset
  return buf;
}

export function sectorsFor(bytes: number): number {
  return Math.ceil(bytes / SECTOR_SIZE);
}

export function padToSector(len: number): number {
  return sectorsFor(len) * SECTOR_SIZE;
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
function pad4(n: number): string {
  return n.toString().padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Name mangling
// ---------------------------------------------------------------------------

const D_CHARS = /[^A-Z0-9_]/g;

/** Produce a valid ISO9660 directory identifier (level 2: up to 31 d-chars). */
export function isoDirName(name: string, level1: boolean): string {
  let n = name.toUpperCase().replace(/\./g, '_').replace(D_CHARS, '_');
  const max = level1 ? 8 : 31;
  if (n.length > max) n = n.slice(0, max);
  if (n.length === 0) n = '_';
  return n;
}

/** Produce a valid ISO9660 file identifier with version, e.g. "READ_ME.TXT;1". */
export function isoFileName(name: string, level1: boolean): string {
  const dot = name.lastIndexOf('.');
  let base = (dot >= 0 ? name.slice(0, dot) : name).toUpperCase().replace(D_CHARS, '_');
  let ext = (dot >= 0 ? name.slice(dot + 1) : '').toUpperCase().replace(D_CHARS, '_');
  if (level1) {
    base = base.slice(0, 8);
    ext = ext.slice(0, 3);
  } else {
    // Level 2: combined base+ext <= 30.
    base = base.slice(0, 26);
    ext = ext.slice(0, 26);
    if (base.length + ext.length > 30) base = base.slice(0, Math.max(1, 30 - ext.length));
  }
  if (base.length === 0) base = '_';
  return (ext.length > 0 ? `${base}.${ext}` : base) + ';1';
}

/**
 * Compute the directory-identifier bytes for a node in a given variant.
 * Returns the raw identifier bytes (without the length byte).
 */
export function identifierBytes(
  name: string,
  isDir: boolean,
  variant: 'iso' | 'joliet',
  level1: boolean
): Buffer {
  if (variant === 'joliet') {
    let n = name;
    // Joliet permits up to 64 UCS-2 chars. Unlike ISO9660, real-world Joliet
    // names carry no ";1" version suffix (matching Windows behaviour).
    if (n.length > 64) n = n.slice(0, 64);
    return ucs2be(n);
  }
  const id = isDir ? isoDirName(name, level1) : isoFileName(name, level1);
  return Buffer.from(id, 'ascii');
}
