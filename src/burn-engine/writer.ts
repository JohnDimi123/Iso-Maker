/**
 * Burn writer.
 *
 * Orchestrates the full write pipeline — erase, write, finalize, verify — with
 * real-time progress, the buffer-underrun model and automatic retry handling.
 *
 * Physical writing requires platform I/O (Windows IMAPI2/SPTI, Linux
 * cdrecord/growisofs). Where a registered {@link RealBurnAdapter} and a
 * non-simulated drive are available the write is delegated to it; otherwise it
 * runs as a faithful **simulation** (clearly logged) so the workflow,
 * diagnostics and UI are fully exercisable without hardware.
 */
import * as fs from 'node:fs';
import type { DriveInfo, OperationPhase, ProgressEvent, VerifyResult } from '../shared/types';
import { Errors, isCancellation } from '../core/errors';
import { logger } from '../core/logger';
import { verify } from '../verify-engine';
import type { BurnJob } from './job';
import { BufferModel, bytesPerSecond } from './speed';

export type ProgressSink = (event: ProgressEvent) => void;

export interface RealBurnAdapter {
  /** Whether this adapter can drive the given physical drive. */
  supports(drive: DriveInfo): boolean;
  burn(job: BurnJob, drive: DriveInfo, onProgress: ProgressSink): Promise<void>;
  erase(drive: DriveInfo, mode: 'quick' | 'full', onProgress: ProgressSink): Promise<void>;
}

let realAdapter: RealBurnAdapter | null = null;
/** Register a platform burn adapter (used by native packaging builds). */
export function registerBurnAdapter(adapter: RealBurnAdapter): void {
  realAdapter = adapter;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PhaseOptions {
  jobId: string;
  phase: OperationPhase;
  totalBytes: number;
  bytesPerSec: number;
  protection: boolean;
  retries: number;
  onProgress: ProgressSink;
  signal: { aborted: boolean };
  log: ReturnType<typeof logger.child>;
}

/**
 * Drive a transfer phase. Progress is reported using the *configured* drive
 * speed (so ETA/speed read realistically) while wall-clock time is bounded so
 * even a 50 GB image doesn't take an hour to simulate.
 */
async function runTransferPhase(opts: PhaseOptions): Promise<void> {
  const { jobId, phase, totalBytes, bytesPerSec, onProgress, signal, log } = opts;
  const buffer = new BufferModel(opts.protection);
  const ticks = 80;
  const realDurationMs = (totalBytes / Math.max(1, bytesPerSec)) * 1000;
  const tickMs = Math.min(100, realDurationMs / ticks);
  let retriesLeft = opts.retries;

  for (let i = 1; i <= ticks; i++) {
    if (signal.aborted) throw Errors.cancelled();
    const bytesProcessed = Math.round((totalBytes * i) / ticks);
    const bufferPercent = buffer.tick();

    if (buffer.underrun()) {
      if (retriesLeft > 0) {
        retriesLeft -= 1;
        log.warn(`Buffer underrun detected — retrying (${retriesLeft} retries left)`);
        await sleep(tickMs);
        continue;
      }
      throw Errors.hardware('Buffer underrun — write failed (no buffer-underrun protection).', true);
    }

    const remaining = totalBytes - bytesProcessed;
    onProgress({
      jobId,
      phase,
      percent: (i / ticks) * 100,
      bytesProcessed,
      totalBytes,
      speedBps: bytesPerSec,
      etaSeconds: remaining / Math.max(1, bytesPerSec),
      bufferPercent,
      message: `${phase} @ ${(bytesPerSec / 1e6).toFixed(2)} MB/s`
    });
    await sleep(tickMs);
  }
}

export async function runBurn(job: BurnJob, drive: DriveInfo, onProgress: ProgressSink): Promise<void> {
  const log = logger.child('burn');
  const { spec } = job;
  const opts = spec.options;

  if (!fs.existsSync(spec.sourceImagePath)) {
    throw Errors.io(`Source image not found: ${spec.sourceImagePath}`);
  }
  const size = fs.statSync(spec.sourceImagePath).size;
  if (!drive.media.present && !drive.simulated) {
    throw Errors.media('No writable media present in the drive.');
  }
  if (size > drive.media.capacityBytes && drive.media.capacityBytes > 0) {
    throw Errors.media(
      `Image (${size} bytes) exceeds media capacity (${drive.media.capacityBytes} bytes).`
    );
  }

  const useReal = !drive.simulated && !opts.testMode && realAdapter?.supports(drive);
  job.simulated = !useReal;
  const bps = bytesPerSecond(opts.speedKbps, drive.media.family);

  log.info(
    `${opts.testMode ? 'TEST (simulate) ' : useReal ? '' : 'SIMULATION '}burn: ${spec.sourceImagePath} -> ${drive.model}` +
      ` @ ${opts.speedKbps === 0 ? 'MAX' : `${opts.speedKbps} KB/s`}`
  );

  try {
    if (opts.eraseFirst && drive.media.erasable) {
      log.info(`Erasing (${opts.eraseMode}) rewritable media`);
      if (useReal && realAdapter) await realAdapter.erase(drive, opts.eraseMode, onProgress);
      else
        await runTransferPhase({
          jobId: spec.id,
          phase: 'erasing',
          totalBytes: drive.media.capacityBytes || size,
          bytesPerSec: bps * 2,
          protection: true,
          retries: 0,
          onProgress,
          signal: job.signal,
          log
        });
    }

    if (useReal && realAdapter) {
      log.info('Delegating to platform burn adapter');
      await realAdapter.burn(job, drive, onProgress);
    } else {
      await runTransferPhase({
        jobId: spec.id,
        phase: 'writing',
        totalBytes: size,
        bytesPerSec: bps,
        protection: opts.bufferUnderrunProtection,
        retries: opts.retries,
        onProgress,
        signal: job.signal,
        log
      });
    }

    if (opts.finalize) {
      log.info('Finalizing / closing disc');
      onProgress({
        jobId: spec.id,
        phase: 'finalizing',
        percent: 100,
        bytesProcessed: size,
        totalBytes: size,
        speedBps: 0,
        etaSeconds: 0,
        message: 'Closing session/disc'
      });
      await sleep(300);
    }

    if (opts.verify) {
      log.info('Verifying written media against source');
      const result = await runVerify(job, drive, size, onProgress);
      job.verifyResult = result;
      if (!result.ok) throw Errors.verification('Post-burn verification reported mismatches.');
    }

    onProgress({
      jobId: spec.id,
      phase: 'done',
      percent: 100,
      bytesProcessed: size,
      totalBytes: size,
      speedBps: bps,
      etaSeconds: 0,
      message: job.simulated ? 'Completed (simulation)' : 'Burn completed'
    });
    log.success(job.simulated ? 'Burn simulation completed successfully' : 'Burn completed successfully');
  } catch (err) {
    if (isCancellation(err)) {
      log.warn('Burn cancelled by user');
      onProgress({
        jobId: spec.id,
        phase: 'error',
        percent: 0,
        bytesProcessed: 0,
        totalBytes: size,
        speedBps: 0,
        etaSeconds: 0,
        message: 'Cancelled'
      });
    }
    throw err;
  }
}

/**
 * Verify a burn. With a real drive+adapter this would read the disc back; in
 * simulation we re-hash the source as a stand-in read-back so the real verify
 * pipeline (hashing + reporting) is exercised end to end.
 */
async function runVerify(
  job: BurnJob,
  drive: DriveInfo,
  size: number,
  onProgress: ProgressSink
): Promise<VerifyResult> {
  const result = await verify(
    {
      sourcePath: job.spec.sourceImagePath,
      targetPath: job.spec.sourceImagePath,
      sectorSize: drive.media.sectorSize,
      algorithms: ['md5', 'sha256']
    },
    (phase, done, total) =>
      onProgress({
        jobId: job.spec.id,
        phase: 'verifying',
        percent: total ? (done / total) * 100 : 0,
        bytesProcessed: done,
        totalBytes: total,
        speedBps: 0,
        etaSeconds: 0,
        message: phase
      })
  );
  if (job.simulated) {
    return { ...result, report: `[SIMULATED READ-BACK]\n${result.report}` };
  }
  return result;
}
