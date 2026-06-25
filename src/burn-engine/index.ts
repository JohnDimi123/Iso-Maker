/** Burn engine public API. */
import { driveManager } from '../hal';
import { Errors } from '../core/errors';
import type { BurnJobSpec, BurnOptions } from '../shared/types';
import { BurnJob, newJobId } from './job';
import { BurnQueue } from './queue';
import { runBurn } from './writer';

export { readTest, type ReadTestProgress } from './diagnostics';
export { registerBurnAdapter, type RealBurnAdapter } from './writer';
export { BurnJob, newJobId } from './job';
export { BurnQueue } from './queue';
export { bytesPerSecond } from './speed';

export function defaultBurnOptions(overrides: Partial<BurnOptions> = {}): BurnOptions {
  return {
    speedKbps: 0,
    testMode: false,
    verify: true,
    finalize: true,
    eraseFirst: false,
    eraseMode: 'quick',
    ejectWhenDone: false,
    layerBreak: 0,
    retries: 3,
    bufferUnderrunProtection: true,
    ...overrides
  };
}

export class BurnEngine {
  readonly queue: BurnQueue;

  constructor() {
    this.queue = new BurnQueue(async (job, onProgress) => {
      const drive = await driveManager.getDrive(job.spec.driveId);
      if (!drive) throw Errors.hardware(`Drive not found: ${job.spec.driveId}`);
      await runBurn(job, drive, onProgress);
    });
  }

  createJob(sourceImagePath: string, driveId: string, options: Partial<BurnOptions> = {}): BurnJobSpec {
    return { id: newJobId(), sourceImagePath, driveId, options: defaultBurnOptions(options) };
  }

  enqueue(spec: BurnJobSpec): BurnJob {
    return this.queue.add(new BurnJob(spec));
  }

  process(): Promise<{ completed: number; failed: number }> {
    return this.queue.process();
  }

  cancel(jobId: string): void {
    this.queue.cancel(jobId);
  }

  list(): BurnJob[] {
    return this.queue.list();
  }
}

export const burnEngine = new BurnEngine();
