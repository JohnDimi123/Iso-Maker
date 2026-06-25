/** Write-speed / throughput helpers and the buffer-underrun model. */
import { SPEED_1X } from '../shared/constants';
import type { DiscFamily } from '../shared/types';

/** Resolve a configured speed (KB/s, 0 = auto) into bytes/second. */
export function bytesPerSecond(speedKbps: number, family: DiscFamily): number {
  if (speedKbps > 0) return speedKbps * 1000;
  const base = SPEED_1X[family] ?? SPEED_1X.DVD;
  const autoMultiplier: Record<DiscFamily, number> = { CD: 48, DVD: 16, BD: 12, unknown: 8 };
  return base * (autoMultiplier[family] ?? 8);
}

/**
 * Simple host-buffer simulation. The buffer drains as the drive consumes data
 * and refills from the host; with buffer-underrun protection the drive parks
 * instead of underrunning, so the level never reaches zero.
 */
export class BufferModel {
  private level = 100;
  constructor(private readonly protection: boolean) {}

  tick(): number {
    // Random walk biased towards full, with occasional dips.
    const drift = (Math.random() - 0.45) * 18;
    this.level = Math.max(0, Math.min(100, this.level + drift));
    if (this.protection && this.level < 8) this.level = 8; // BURN-Proof parks the laser
    return Math.round(this.level);
  }

  /** True when an unprotected drive has underrun (would ruin the disc). */
  underrun(): boolean {
    return !this.protection && this.level <= 0;
  }
}
