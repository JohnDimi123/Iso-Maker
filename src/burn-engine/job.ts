/** A single burn job with status + cooperative cancellation. */
import type { BurnJobSpec, JobStatus, VerifyResult } from '../shared/types';

let counter = 0;
export function newJobId(): string {
  counter += 1;
  return `job-${Date.now().toString(36)}-${counter}`;
}

export class BurnJob {
  status: JobStatus = 'queued';
  aborted = false;
  error?: string;
  verifyResult?: VerifyResult;
  simulated = false;
  startedAt?: number;
  finishedAt?: number;

  constructor(readonly spec: BurnJobSpec) {}

  get signal(): { aborted: boolean } {
    return this;
  }

  cancel(): void {
    this.aborted = true;
    if (this.status === 'queued' || this.status === 'running') this.status = 'cancelled';
  }
}
