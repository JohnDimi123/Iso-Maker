/**
 * Burn job queue — supports queueing multiple jobs and batch processing.
 * Jobs run sequentially; the queue is cancellable per job or as a whole.
 */
import type { JobStatus, ProgressEvent } from '../shared/types';
import { TypedEmitter } from '../core/event-bus';
import { logger } from '../core/logger';
import { isCancellation } from '../core/errors';
import { BurnJob } from './job';

export type JobRunner = (job: BurnJob, onProgress: (e: ProgressEvent) => void) => Promise<void>;

type QueueEvents = {
  progress: ProgressEvent;
  status: { jobId: string; status: JobStatus; error?: string };
  drained: { completed: number; failed: number };
};

export class BurnQueue {
  readonly events = new TypedEmitter<QueueEvents>();
  private jobs: BurnJob[] = [];
  private processing = false;

  constructor(private readonly runner: JobRunner) {}

  add(job: BurnJob): BurnJob {
    this.jobs.push(job);
    this.events.emit('status', { jobId: job.spec.id, status: 'queued' });
    return job;
  }

  remove(jobId: string): boolean {
    const job = this.jobs.find((j) => j.spec.id === jobId);
    if (!job || job.status === 'running') return false;
    this.jobs = this.jobs.filter((j) => j.spec.id !== jobId);
    return true;
  }

  cancel(jobId: string): void {
    this.jobs.find((j) => j.spec.id === jobId)?.cancel();
  }

  cancelAll(): void {
    for (const job of this.jobs) job.cancel();
  }

  list(): BurnJob[] {
    return [...this.jobs];
  }

  /** Process all queued jobs sequentially. Safe to call repeatedly. */
  async process(): Promise<{ completed: number; failed: number }> {
    if (this.processing) return { completed: 0, failed: 0 };
    this.processing = true;
    const log = logger.child('queue');
    let completed = 0;
    let failed = 0;
    try {
      for (const job of this.jobs) {
        if (job.status !== 'queued') continue;
        if (job.aborted) {
          this.setStatus(job, 'cancelled');
          continue;
        }
        job.status = 'running';
        job.startedAt = Date.now();
        this.events.emit('status', { jobId: job.spec.id, status: 'running' });
        log.info(`Starting job ${job.spec.id}`);
        try {
          await this.runner(job, (e) => this.events.emit('progress', e));
          job.status = 'succeeded';
          completed += 1;
          this.setStatus(job, 'succeeded');
        } catch (err) {
          if (isCancellation(err)) {
            this.setStatus(job, 'cancelled');
          } else {
            job.error = (err as Error).message;
            job.status = 'failed';
            failed += 1;
            log.error(`Job ${job.spec.id} failed: ${job.error}`);
            this.setStatus(job, 'failed', job.error);
          }
        } finally {
          job.finishedAt = Date.now();
        }
      }
    } finally {
      this.processing = false;
    }
    this.events.emit('drained', { completed, failed });
    return { completed, failed };
  }

  private setStatus(job: BurnJob, status: JobStatus, error?: string): void {
    job.status = status;
    this.events.emit('status', { jobId: job.spec.id, status, error });
  }
}
