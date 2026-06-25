/** Human-readable verification report rendering. */
import type { HashResult, SectorMismatch, VerifyResult } from '../shared/types';

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

function hashLines(label: string, hashes: HashResult[]): string {
  if (hashes.length === 0) return `${label}: (none)`;
  return [`${label}:`, ...hashes.map((h) => `  ${h.algorithm.toUpperCase().padEnd(7)} ${h.hex}`)].join('\n');
}

function mismatchLines(mismatches: SectorMismatch[]): string {
  if (mismatches.length === 0) return 'Mismatches: none';
  const head = mismatches
    .slice(0, 20)
    .map(
      (m) =>
        `  sector ${m.sector} (+${m.offset}): source=0x${m.sourceByte
          .toString(16)
          .padStart(2, '0')} target=0x${m.targetByte.toString(16).padStart(2, '0')}`
    );
  return [`Mismatches: ${mismatches.length}${mismatches.length >= 50 ? '+' : ''}`, ...head].join('\n');
}

export function renderReport(
  params: Omit<VerifyResult, 'report'> & { sourcePath: string; targetPath: string }
): string {
  const status = params.ok ? 'PASSED [OK]' : 'FAILED [X]';
  return [
    '==================================================',
    `  Iso Maker — Verification Report`,
    `  ${new Date().toISOString()}`,
    '==================================================',
    `Result:           ${status}`,
    `Source:           ${params.sourcePath}`,
    `Target:           ${params.targetPath}`,
    `Sectors compared: ${params.sectorsCompared}`,
    `Bytes compared:   ${params.bytesCompared} (${fmtBytes(params.bytesCompared)})`,
    `Duration:         ${(params.durationMs / 1000).toFixed(2)} s`,
    '',
    hashLines('Source hashes', params.sourceHashes),
    '',
    hashLines('Target hashes', params.targetHashes),
    '',
    mismatchLines(params.mismatches),
    '=================================================='
  ].join('\n');
}
