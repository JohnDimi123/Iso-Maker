/**
 * Platform burn adapters — real, hardware-level optical writing.
 *
 * IMPORTANT: these paths require a physical writer + media and are therefore
 * NOT exercised by CI (which has no optical hardware). They must be validated
 * on a real machine. They engage only for physical (non-simulated) drives; a
 * simulated drive keeps using the writer's built-in simulation.
 *
 *   Windows : Image Mastering API v2 (IMAPI2), driven through PowerShell — the
 *             same subsystem the Windows shell uses to burn ISO images. No
 *             native addon required.
 *   Linux   : growisofs (DVD/BD) or wodim/cdrecord (CD), when installed.
 *
 * Progress: real per-sector progress is surfaced where the platform reports it
 * (Linux tool output; IMAPI2 Update events). As a fallback the elapsed-time
 * estimate (from the selected speed + image size) drives the bar so the UI
 * still moves, then snaps to 100% on completion.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import type { DriveInfo, ProgressEvent } from '../shared/types';
import { logger } from '../core/logger';
import { Errors, isCancellation } from '../core/errors';
import type { BurnJob } from './job';
import { registerBurnAdapter, type ProgressSink, type RealBurnAdapter } from './writer';
import { bytesPerSecond } from './speed';

const log = logger.child('burn:real');

/** Spawn a process, deliver complete output lines, honour cooperative abort. */
function run(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
  signal: { aborted: boolean }
): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let buf = '';
    const handle = (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
      }
    };
    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);
    const timer = setInterval(() => {
      if (signal.aborted) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }, 250);
    child.on('error', (e) => {
      clearInterval(timer);
      rejectP(e);
    });
    child.on('close', (code) => {
      clearInterval(timer);
      if (buf.trim()) onLine(buf.trim());
      resolveP(code ?? 0);
    });
  });
}

/** Build a progress emitter that never goes backwards and fills required fields. */
function progressEmitter(job: BurnJob, totalBytes: number, bps: number, onProgress: ProgressSink) {
  let last = 0;
  return (percent: number, message?: string, phase: ProgressEvent['phase'] = 'writing') => {
    last = Math.max(last, Math.min(100, percent));
    const bytesProcessed = Math.min(totalBytes, Math.round((last / 100) * totalBytes));
    onProgress({
      jobId: job.spec.id,
      phase,
      percent: last,
      bytesProcessed,
      totalBytes,
      speedBps: bps,
      etaSeconds: (totalBytes - bytesProcessed) / Math.max(1, bps),
      bufferPercent: 100,
      message: message ?? `Writing @ ${(bps / 1e6).toFixed(2)} MB/s`
    });
  };
}

// ---------------------------------------------------------------------------
// Windows — IMAPI2 via PowerShell
// ---------------------------------------------------------------------------
const WIN_BURN_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$Image,[Parameter(Mandatory=$true)][string]$Drive)
$ErrorActionPreference = 'Stop'
function Find-Recorder([string]$drive) {
  $master = New-Object -ComObject IMAPI2.MsftDiscMaster2
  if ($master.Count -eq 0) { return $null }
  $want = $drive.TrimEnd('\',':').ToUpper()
  foreach ($id in $master) {
    $r = New-Object -ComObject IMAPI2.MsftDiscRecorder2
    $r.InitializeDiscRecorder($id)
    foreach ($v in $r.VolumePathNames) {
      if ($v.TrimEnd('\',':').ToUpper() -eq $want) { return $r }
    }
  }
  # Fall back to the first recorder if the drive letter did not match.
  $r = New-Object -ComObject IMAPI2.MsftDiscRecorder2
  $r.InitializeDiscRecorder($master.Item(0))
  return $r
}
try {
  $recorder = Find-Recorder $Drive
  if (-not $recorder) { Write-Output 'ERROR No optical recorder found'; exit 1 }

  $stream = New-Object -ComObject ADODB.Stream
  $stream.Open(); $stream.Type = 1; $stream.LoadFromFile($Image)

  $data = New-Object -ComObject IMAPI2.MsftDiscFormat2Data
  if (-not $data.IsCurrentMediaSupported($recorder)) { Write-Output 'ERROR No writable/blank media in the drive'; exit 1 }
  $data.Recorder = $recorder
  $data.ClientName = 'Iso Maker'
  $data.ForceMediaToBeClosed = $true

  $action = {
    try {
      $a = $Event.SourceEventArgs
      if ($a.SectorCount -gt 0) { Write-Output ('PROGRESS ' + [int](($a.LastWrittenLba / $a.SectorCount) * 100)) }
    } catch {}
  }
  $sub = Register-ObjectEvent -InputObject $data -EventName Update -Action $action
  Write-Output 'PROGRESS 0'
  $data.Write($stream)
  Unregister-Event -SourceIdentifier $sub.Name -ErrorAction SilentlyContinue
  $stream.Close()
  Write-Output 'PROGRESS 100'; Write-Output 'DONE'; exit 0
} catch {
  Write-Output ('ERROR ' + $_.Exception.Message); exit 1
}
`;

const WIN_ERASE_PS = String.raw`
param([Parameter(Mandatory=$true)][string]$Drive,[int]$Full=0)
$ErrorActionPreference = 'Stop'
try {
  $master = New-Object -ComObject IMAPI2.MsftDiscMaster2
  if ($master.Count -eq 0) { Write-Output 'ERROR No optical recorder found'; exit 1 }
  $want = $Drive.TrimEnd('\',':').ToUpper(); $recorder = $null
  foreach ($id in $master) {
    $r = New-Object -ComObject IMAPI2.MsftDiscRecorder2; $r.InitializeDiscRecorder($id)
    foreach ($v in $r.VolumePathNames) { if ($v.TrimEnd('\',':').ToUpper() -eq $want) { $recorder = $r } }
  }
  if (-not $recorder) { $recorder = New-Object -ComObject IMAPI2.MsftDiscRecorder2; $recorder.InitializeDiscRecorder($master.Item(0)) }
  $erase = New-Object -ComObject IMAPI2.MsftDiscFormat2Erase
  $erase.Recorder = $recorder; $erase.ClientName = 'Iso Maker'; $erase.FullErase = ($Full -ne 0)
  $erase.EraseMedia(); Write-Output 'DONE'; exit 0
} catch { Write-Output ('ERROR ' + $_.Exception.Message); exit 1 }
`;

function writeTemp(content: string, name: string): string {
  const p = join(os.tmpdir(), `isomaker-${Date.now()}-${name}`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

class WindowsBurnAdapter implements RealBurnAdapter {
  supports(drive: DriveInfo): boolean {
    return process.platform === 'win32' && !drive.simulated;
  }

  async burn(job: BurnJob, drive: DriveInfo, onProgress: ProgressSink): Promise<void> {
    const iso = job.spec.sourceImagePath;
    const total = fs.statSync(iso).size;
    const bps = bytesPerSecond(job.spec.options.speedKbps, drive.media.family);
    const emit = progressEmitter(job, total, bps, onProgress);
    const start = Date.now();
    let realProgress = false;
    let errMsg = '';

    const est = setInterval(() => {
      if (job.signal.aborted || realProgress) return;
      emit(Math.min(95, ((Date.now() - start) / 1000) * bps * 100 / total));
    }, 500);

    const script = writeTemp(WIN_BURN_PS, 'burn.ps1');
    try {
      log.info(`IMAPI2 burn: ${iso} -> ${drive.devicePath}`);
      const code = await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, '-Image', iso, '-Drive', drive.devicePath],
        (line) => {
          if (line.startsWith('PROGRESS ')) {
            realProgress = true;
            emit(parseInt(line.slice(9), 10) || 0);
          } else if (line.startsWith('ERROR ')) errMsg = line.slice(6);
          else log.info(`imapi: ${line}`);
        },
        job.signal
      );
      if (job.signal.aborted) throw Errors.cancelled();
      if (code !== 0) throw Errors.hardware(`Burn failed via IMAPI2: ${errMsg || `exit ${code}`}`, false);
      emit(100, 'Write complete');
    } catch (err) {
      if (isCancellation(err)) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw Errors.hardware('PowerShell not found — required for IMAPI2 burning on Windows.', false);
      throw err;
    } finally {
      clearInterval(est);
      try {
        fs.unlinkSync(script);
      } catch {
        /* best effort */
      }
    }
  }

  async erase(drive: DriveInfo, mode: 'quick' | 'full', onProgress: ProgressSink): Promise<void> {
    const script = writeTemp(WIN_ERASE_PS, 'erase.ps1');
    let errMsg = '';
    try {
      onProgress({
        jobId: 'erase',
        phase: 'erasing',
        percent: 0,
        bytesProcessed: 0,
        totalBytes: drive.media.capacityBytes,
        speedBps: 0,
        etaSeconds: 0,
        message: `Erasing media (${mode})`
      });
      const code = await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, '-Drive', drive.devicePath, '-Full', mode === 'full' ? '1' : '0'],
        (line) => {
          if (line.startsWith('ERROR ')) errMsg = line.slice(6);
        },
        { aborted: false }
      );
      if (code !== 0) throw Errors.hardware(`Erase failed: ${errMsg || `exit ${code}`}`, false);
    } finally {
      try {
        fs.unlinkSync(script);
      } catch {
        /* best effort */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Linux — growisofs (DVD/BD) / wodim (CD)
// ---------------------------------------------------------------------------
class LinuxBurnAdapter implements RealBurnAdapter {
  supports(drive: DriveInfo): boolean {
    return process.platform === 'linux' && !drive.simulated;
  }

  async burn(job: BurnJob, drive: DriveInfo, onProgress: ProgressSink): Promise<void> {
    const iso = job.spec.sourceImagePath;
    const dev = drive.devicePath;
    const total = fs.statSync(iso).size;
    const bps = bytesPerSecond(job.spec.options.speedKbps, drive.media.family);
    const emit = progressEmitter(job, total, bps, onProgress);

    const isCD = drive.media.family === 'CD';
    const cmd = isCD ? 'wodim' : 'growisofs';
    const args = isCD
      ? [`dev=${dev}`, '-dao', '-eject', iso]
      : ['-dvd-compat', '-Z', `${dev}=${iso}`];

    log.info(`${cmd} burn: ${iso} -> ${dev}`);
    try {
      const code = await run(
        cmd,
        args,
        (line) => {
          // growisofs: "  12.3% done, estimate finish ..."; wodim: "Track 01:   12 of  700 MB written"
          const pct = /([\d.]+)%\s+done/.exec(line);
          const mb = /(\d+)\s+of\s+(\d+)\s+MB/.exec(line);
          if (pct) emit(parseFloat(pct[1]));
          else if (mb) emit((parseInt(mb[1], 10) / Math.max(1, parseInt(mb[2], 10))) * 100);
          else log.info(`${cmd}: ${line}`);
        },
        job.signal
      );
      if (job.signal.aborted) throw Errors.cancelled();
      if (code !== 0) throw Errors.hardware(`Burn failed (${cmd} exit ${code}).`, false);
      emit(100, 'Write complete');
    } catch (err) {
      if (isCancellation(err)) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw Errors.hardware(`'${cmd}' not found — install ${isCD ? 'wodim (cdrkit)' : 'dvd+rw-tools'} to burn on Linux.`, false);
      throw err;
    }
  }

  async erase(drive: DriveInfo, mode: 'quick' | 'full', onProgress: ProgressSink): Promise<void> {
    const dev = drive.devicePath;
    const isCD = drive.media.family === 'CD';
    const cmd = isCD ? 'wodim' : 'dvd+rw-format';
    const args = isCD ? [`dev=${dev}`, `blank=${mode === 'full' ? 'all' : 'fast'}`] : [mode === 'full' ? '-blank=full' : '-blank', dev];
    onProgress({
      jobId: 'erase',
      phase: 'erasing',
      percent: 0,
      bytesProcessed: 0,
      totalBytes: drive.media.capacityBytes,
      speedBps: 0,
      etaSeconds: 0,
      message: `Erasing media (${mode}) via ${cmd}`
    });
    const code = await run(cmd, args, (line) => log.info(`${cmd}: ${line}`), { aborted: false });
    if (code !== 0) throw Errors.hardware(`Erase failed (${cmd} exit ${code}).`, false);
  }
}

/** Register the burn adapter appropriate for the current platform. */
export function registerPlatformBurnAdapter(): void {
  if (process.platform === 'win32') {
    registerBurnAdapter(new WindowsBurnAdapter());
    log.info('Registered Windows IMAPI2 burn adapter (real burning enabled for physical drives)');
  } else if (process.platform === 'linux') {
    registerBurnAdapter(new LinuxBurnAdapter());
    log.info('Registered Linux growisofs/wodim burn adapter (real burning enabled for physical drives)');
  } else {
    log.info(`No real burn adapter for platform '${process.platform}'; burns will run as simulation`);
  }
}
