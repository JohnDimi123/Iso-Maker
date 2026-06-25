/**
 * Verification engine.
 *
 * Verifies an image against a burned disc / copy by hashing both ends and
 * comparing them sector by sector, then renders a detailed report. Also used
 * to check the integrity of a single image (hash-only mode).
 */
import * as fs from 'node:fs';
import type { HashAlgorithm, HashResult, VerifyResult, VerifySpec } from '../shared/types';
import { logger } from '../core/logger';
import { hashFile } from './hash';
import { compareFiles } from './compare';
import { renderReport } from './report';

export { hashFile } from './hash';
export { compareFiles } from './compare';
export { renderReport } from './report';

export interface VerifyProgress {
  (phase: 'hashing-source' | 'hashing-target' | 'comparing', done: number, total: number): void;
}

export async function verify(spec: VerifySpec, onProgress?: VerifyProgress): Promise<VerifyResult> {
  const log = logger.child('verify');
  const started = Date.now();
  const algorithms = spec.algorithms.length ? spec.algorithms : (['sha256'] as HashAlgorithm[]);

  log.info(`Hashing source: ${spec.sourcePath}`);
  const sourceHashes = await hashFile(spec.sourcePath, algorithms, (d, t) =>
    onProgress?.('hashing-source', d, t)
  );

  log.info(`Hashing target: ${spec.targetPath}`);
  const targetHashes = await hashFile(spec.targetPath, algorithms, (d, t) =>
    onProgress?.('hashing-target', d, t)
  );

  log.info('Comparing sectors');
  const cmp = await compareFiles(spec.sourcePath, spec.targetPath, spec.sectorSize, (d, t) =>
    onProgress?.('comparing', d, t)
  );

  const hashesMatch = algorithms.every((alg) => {
    const a = sourceHashes.find((h) => h.algorithm === alg)?.hex;
    const b = targetHashes.find((h) => h.algorithm === alg)?.hex;
    return a !== undefined && a === b;
  });
  const ok = hashesMatch && cmp.mismatches.length === 0 && !cmp.sizeMismatch;

  const base: Omit<VerifyResult, 'report'> = {
    ok,
    sectorsCompared: cmp.sectorsCompared,
    bytesCompared: cmp.bytesCompared,
    mismatches: cmp.mismatches,
    sourceHashes,
    targetHashes,
    durationMs: Date.now() - started
  };
  const report = renderReport({ ...base, sourcePath: spec.sourcePath, targetPath: spec.targetPath });
  if (ok) log.success('Verification passed');
  else log.error(`Verification failed (${cmp.mismatches.length} mismatches, size mismatch: ${cmp.sizeMismatch})`);

  return { ...base, report };
}

/** Integrity check of a single image (hash digest only). */
export async function checksum(
  filePath: string,
  algorithms: HashAlgorithm[],
  onProgress?: (done: number, total: number) => void
): Promise<HashResult[]> {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  return hashFile(filePath, algorithms, onProgress);
}
