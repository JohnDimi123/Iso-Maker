/**
 * Progress + transfer-rate tracking shared by every long-running operation.
 *
 * Produces smoothed instantaneous speed (for speed graphs), an ETA, and a
 * simulated/real host-buffer fill level used to visualise buffer-underrun
 * protection.
 */
import type { OperationPhase, ProgressEvent } from '../shared/types';

export type ProgressCallback = (event: ProgressEvent) => void;

interface Sample {
  t: number;
  bytes: number;
}

export class ProgressTracker {
  private readonly start = Date.now();
  private samples: Sample[] = [];
  private bytesProcessed = 0;
  private bufferPercent = 100;

  constructor(
    public readonly jobId: string,
    public readonly totalBytes: number,
    private readonly onProgress: ProgressCallback,
    /** Sliding window (ms) for instantaneous-speed smoothing. */
    private readonly windowMs = 2000
  ) {}

  /** Record cumulative progress and emit an event. */
  update(bytesProcessed: number, phase: OperationPhase, message?: string): void {
    this.bytesProcessed = bytesProcessed;
    const now = Date.now();
    this.samples.push({ t: now, bytes: bytesProcessed });
    // Drop samples outside the smoothing window.
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();

    const speedBps = this.instantaneousSpeed();
    const remaining = Math.max(0, this.totalBytes - bytesProcessed);
    const etaSeconds = speedBps > 0 ? remaining / speedBps : 0;
    const percent = this.totalBytes > 0 ? Math.min(100, (bytesProcessed / this.totalBytes) * 100) : 0;

    this.onProgress({
      jobId: this.jobId,
      phase,
      percent,
      bytesProcessed,
      totalBytes: this.totalBytes,
      speedBps,
      etaSeconds,
      bufferPercent: this.bufferPercent,
      message
    });
  }

  /** Advance by a delta rather than an absolute value. */
  advance(deltaBytes: number, phase: OperationPhase, message?: string): void {
    this.update(this.bytesProcessed + deltaBytes, phase, message);
  }

  setBuffer(percent: number): void {
    this.bufferPercent = Math.max(0, Math.min(100, percent));
  }

  finish(phase: OperationPhase = 'done', message?: string): void {
    this.onProgress({
      jobId: this.jobId,
      phase,
      percent: 100,
      bytesProcessed: this.totalBytes,
      totalBytes: this.totalBytes,
      speedBps: this.averageSpeed(),
      etaSeconds: 0,
      bufferPercent: this.bufferPercent,
      message
    });
  }

  private instantaneousSpeed(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.bytes - first.bytes) / dt;
  }

  averageSpeed(): number {
    const dt = (Date.now() - this.start) / 1000;
    return dt > 0 ? this.bytesProcessed / dt : 0;
  }
}
