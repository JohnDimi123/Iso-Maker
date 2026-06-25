/**
 * Generate the application icon set from a source PNG, using only Node built-ins
 * (zlib) so the project keeps its zero-dependency stance.
 *
 *   node scripts/make-icon.mjs [sourcePng]
 *
 * Produces:
 *   build/icon.ico   — multi-resolution Windows icon (16…256, PNG-compressed)
 *   build/icon.png   — 512×512 PNG (Linux / general use)
 *
 * Supports 8-bit, non-interlaced PNG sources of colour type 2 (RGB) or 6 (RGBA).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || resolve(root, 'build/logo-src.png');

// ---- CRC32 (PNG chunk checksum) ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- decode PNG → { width, height, pixels:RGBA } ----
function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}); need 8-bit RGB/RGBA`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      line[x] = v;
    }
    prev = line;
    for (let x = 0; x < width; x++) {
      const si = x * channels, di = (y * width + x) * 4;
      out[di] = line[si];
      out[di + 1] = line[si + 1];
      out[di + 2] = line[si + 2];
      out[di + 3] = channels === 4 ? line[si + 3] : 255;
    }
  }
  return { width, height, pixels: out };
}

// ---- pad to a transparent square ----
function padSquare(img) {
  const s = Math.max(img.width, img.height);
  if (s === img.width && s === img.height) return img;
  const out = Buffer.alloc(s * s * 4);
  const ox = (s - img.width) >> 1, oy = (s - img.height) >> 1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4, di = ((y + oy) * s + (x + ox)) * 4;
      out[di] = img.pixels[si];
      out[di + 1] = img.pixels[si + 1];
      out[di + 2] = img.pixels[si + 2];
      out[di + 3] = img.pixels[si + 3];
    }
  return { width: s, height: s, pixels: out };
}

// ---- alpha-weighted box resize → N×N (avoids dark halos on transparent edges) ----
function resize(img, N) {
  const { width: W, height: H, pixels: P } = img;
  const out = Buffer.alloc(N * N * 4);
  for (let oy = 0; oy < N; oy++)
    for (let ox = 0; ox < N; ox++) {
      const x0 = Math.floor((ox * W) / N), x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * W) / N));
      const y0 = Math.floor((oy * H) / N), y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * H) / N));
      let r = 0, g = 0, b = 0, sa = 0, cnt = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4, al = P[i + 3] / 255;
          r += P[i] * al; g += P[i + 1] * al; b += P[i + 2] * al; sa += al; cnt++;
        }
      const di = (oy * N + ox) * 4;
      out[di] = sa > 0 ? Math.round(r / sa) : 0;
      out[di + 1] = sa > 0 ? Math.round(g / sa) : 0;
      out[di + 2] = sa > 0 ? Math.round(b / sa) : 0;
      out[di + 3] = Math.round((sa / cnt) * 255);
    }
  return out;
}

// ---- encode RGBA → PNG ----
function encodePng(N, pixels) {
  const stride = N * 4;
  const raw = Buffer.alloc((stride + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---- assemble multi-image ICO (PNG-compressed entries) ----
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  const datas = [];
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;     // width  (0 ⇒ 256)
    dir[b + 1] = e.size >= 256 ? 0 : e.size; // height (0 ⇒ 256)
    dir.writeUInt16LE(1, b + 4);             // colour planes
    dir.writeUInt16LE(32, b + 6);            // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
    datas.push(e.png);
  });
  return Buffer.concat([header, dir, ...datas]);
}

// ---- run ----
const src = padSquare(decodePng(readFileSync(SRC)));
mkdirSync(resolve(root, 'build'), { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256];
const entries = sizes.map((s) => ({ size: s, png: encodePng(s, resize(src, s)) }));
writeFileSync(resolve(root, 'build/icon.ico'), buildIco(entries));
writeFileSync(resolve(root, 'build/icon.png'), encodePng(512, resize(src, 512)));

console.log(`icon.ico  : ${sizes.join(',')} px (${entries.reduce((a, e) => a + e.png.length, 0)} bytes of image data)`);
console.log('icon.png  : 512×512');
console.log('done');
