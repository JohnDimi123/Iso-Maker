/** Streaming multi-algorithm hashing (CRC32 + MD5/SHA-1/SHA-256). */
import * as fs from 'node:fs';
import { createHash, type Hash } from 'node:crypto';
import type { HashAlgorithm, HashResult } from '../shared/types';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

class Crc32 {
  private crc = 0xffffffff;
  update(buf: Buffer): void {
    let crc = this.crc;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    this.crc = crc;
  }
  digest(): string {
    return ((this.crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }
}

export interface HashProgress {
  (bytesHashed: number, totalBytes: number): void;
}

/** Hash a file with one or more algorithms in a single pass. */
export async function hashFile(
  filePath: string,
  algorithms: HashAlgorithm[],
  onProgress?: HashProgress
): Promise<HashResult[]> {
  const total = fs.statSync(filePath).size;
  const crypto = new Map<HashAlgorithm, Hash>();
  let crc: Crc32 | undefined;
  for (const alg of algorithms) {
    if (alg === 'crc32') crc = new Crc32();
    else crypto.set(alg, createHash(alg === 'sha1' ? 'sha1' : alg === 'sha256' ? 'sha256' : 'md5'));
  }

  let bytesHashed = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc?.update(buf);
      for (const h of crypto.values()) h.update(buf);
      bytesHashed += buf.length;
      onProgress?.(bytesHashed, total);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });

  const results: HashResult[] = [];
  for (const alg of algorithms) {
    if (alg === 'crc32') results.push({ algorithm: 'crc32', hex: crc!.digest(), bytesHashed });
    else results.push({ algorithm: alg, hex: crypto.get(alg)!.digest('hex'), bytesHashed });
  }
  return results;
}
