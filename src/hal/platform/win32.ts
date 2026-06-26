/**
 * Windows optical drive backend.
 *
 * Media state is probed through **IMAPI2** (the same subsystem used to burn),
 * because `Win32_CDROMDrive` reports a *blank* disc as "no media" (it has no
 * filesystem, so WMI sets MediaLoaded=false / Size=0) — which would make every
 * blank-disc burn fail with "no writable media". IMAPI2 knows blank writable
 * media, its physical type and its true capacity. If the IMAPI2 probe yields
 * nothing (e.g. odd drivers), we fall back to the WMI enumeration.
 *
 * Real read/write I/O is performed by the burn engine's Windows adapter
 * (also IMAPI2), which plugs into this layer.
 */
import type { DriveInfo, MediaInfo, MediaType } from '../../shared/types';
import type { DriveBackend } from '../types';
import { blankMedia, emptyCapabilities, familyOf, noMedia, tryExec, writeSpeedsFor } from '../util';
import { logger } from '../../core/logger';

const log = logger.child('hal:win32');

interface CimDrive {
  Drive?: string;
  Id?: string;
  Caption?: string;
  Manufacturer?: string;
  MediaLoaded?: boolean;
  Size?: number | string;
  MediaType?: string;
}

interface ImapiDrive {
  drive?: string;
  vendor?: string;
  product?: string;
  rev?: string;
  present?: boolean;
  blank?: boolean;
  mediaType?: number;
  totalSectors?: number;
  freeSectors?: number;
  err?: string;
}

/** IMAPI_MEDIA_PHYSICAL_TYPE → our MediaType union. */
function mapMediaType(t: number): MediaType {
  switch (t) {
    case 1: return 'CD-ROM';
    case 2: return 'CD-R';
    case 3: return 'CD-RW';
    case 4: return 'DVD-ROM';
    case 5: return 'DVD-RAM';
    case 6: return 'DVD+R';
    case 7: return 'DVD+RW';
    case 8: return 'DVD+R DL';
    case 9: return 'DVD-R';
    case 10: return 'DVD-RW';
    case 11: return 'DVD-R DL';
    case 13: return 'DVD+RW';
    case 17: return 'BD-ROM';
    case 18: return 'BD-R';
    case 19: return 'BD-RE';
    default: return 'unknown';
  }
}

// PowerShell IMAPI2 probe: one JSON record per recorder with media details.
// Captures the COM error message per recorder so detection problems are
// diagnosable from the operation log.
const IMAPI_PROBE = [
  '$ErrorActionPreference=\'SilentlyContinue\';$out=@();',
  'try{$m=New-Object -ComObject IMAPI2.MsftDiscMaster2;',
  'foreach($id in $m){$rec=$null;$drive=\'\';$vendor=\'\';$product=\'\';$rev=\'\';',
  '$present=$false;$blank=$false;$mt=0;$total=0;$free=0;$err=\'\';',
  'try{$rec=New-Object -ComObject IMAPI2.MsftDiscRecorder2;$rec.InitializeDiscRecorder($id);',
  'if($rec.VolumePathNames.Count -gt 0){$drive=$rec.VolumePathNames[0]};',
  '$vendor=$rec.VendorId;$product=$rec.ProductId;$rev=$rec.ProductRevision}catch{$err=\'rec:\'+$_.Exception.Message};',
  'try{$d=New-Object -ComObject IMAPI2.MsftDiscFormat2Data;$d.Recorder=$rec;',
  '$total=[int64]$d.TotalSectorsOnMedia;$free=[int64]$d.FreeSectorsOnMedia;',
  '$blank=[bool]$d.MediaPhysicallyBlank;$mt=[int]$d.CurrentPhysicalMediaType;',
  '$present=($total -gt 0)}catch{$present=$false;$err=\'media:\'+$_.Exception.Message};',
  '$out+=[pscustomobject]@{drive=$drive;vendor=$vendor;product=$product;rev=$rev;present=$present;blank=$blank;mediaType=$mt;totalSectors=$total;freeSectors=$free;err=$err}}}catch{$out=@()};',
  '$out|ConvertTo-Json -Compress'
].join('');

export class Win32Backend implements DriveBackend {
  readonly platform = 'win32' as const;

  async detectDrives(): Promise<DriveInfo[]> {
    const viaImapi = await this.detectViaImapi();
    if (viaImapi.length) return viaImapi;
    log.warn('IMAPI2 probe yielded no drives — falling back to Win32_CDROMDrive (blank media may not be detected)');
    return this.detectViaWmi();
  }

  private async detectViaImapi(): Promise<DriveInfo[]> {
    const out = await tryExec(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', IMAPI_PROBE],
      12000
    );
    if (!out) {
      log.warn('IMAPI2 probe produced no output (PowerShell/COM unavailable or timed out)');
      return [];
    }
    let data: ImapiDrive | ImapiDrive[];
    try {
      data = JSON.parse(out);
    } catch {
      log.warn(`IMAPI2 probe output was not JSON: ${out.slice(0, 120)}`);
      return [];
    }
    const recs = Array.isArray(data) ? data : [data];
    log.info(`IMAPI2: ${recs.length} recorder(s)`);
    for (const r of recs) {
      log.info(
        `  ${r.drive || '?'} present=${!!r.present} blank=${!!r.blank} type=${r.mediaType ?? 0} ` +
          `sectors=${r.totalSectors ?? 0}${r.err ? ` err=${r.err}` : ''}`
      );
    }
    return recs
      .filter((r) => r && (r.drive || r.product))
      .map((r, i) => {
        let media: MediaInfo;
        if (r.present && (r.totalSectors ?? 0) > 0) {
          const type = mapMediaType(r.mediaType ?? 0);
          const family = familyOf(type);
          const totalSectors = r.totalSectors ?? 0;
          const freeSectors = r.freeSectors ?? 0;
          const capacityBytes = totalSectors * 2048;
          const freeBytes = freeSectors * 2048;
          const usedBytes = Math.max(0, capacityBytes - freeBytes);
          const blank = !!r.blank;
          media = {
            present: true,
            type,
            family,
            fileSystem: blank ? 'none' : 'unknown',
            sectorSize: 2048,
            totalSectors,
            usedSectors: Math.floor(usedBytes / 2048),
            capacityBytes,
            usedBytes,
            freeBytes,
            erasable: /RW|RE|RAM/.test(type),
            finalized: !blank && freeBytes === 0,
            blank,
            sessions: blank ? 0 : 1,
            writeSpeeds: writeSpeedsFor(family)
          };
        } else {
          media = noMedia();
        }
        const drive = (r.drive || '').trim();
        return {
          id: `win-${drive || i}`,
          devicePath: drive || `\\\\.\\CdRom${i}`,
          vendor: (r.vendor || '').trim() || 'Unknown',
          model: (r.product || '').trim() || 'Optical Drive',
          firmware: (r.rev || '').trim(),
          simulated: false,
          capabilities: emptyCapabilities(),
          media
        } satisfies DriveInfo;
      });
  }

  private async detectViaWmi(): Promise<DriveInfo[]> {
    const out = await tryExec(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_CDROMDrive | Select-Object Id,Drive,Caption,Manufacturer,MediaLoaded,Size,MediaType | ConvertTo-Json -Compress'
      ],
      8000
    );
    if (!out) return [];
    let data: CimDrive | CimDrive[];
    try {
      data = JSON.parse(out);
    } catch {
      return [];
    }
    const drives = Array.isArray(data) ? data : [data];
    return drives.map((d, i) => {
      const size = Number(d.Size ?? 0);
      const loaded = !!d.MediaLoaded && size > 0;
      let media: MediaInfo;
      if (!loaded) {
        media = noMedia();
      } else {
        media = blankMedia('DVD-ROM', size);
        media.blank = false;
        media.finalized = true;
        media.fileSystem = 'unknown';
        media.usedBytes = size;
        media.usedSectors = Math.floor(size / 2048);
        media.freeBytes = 0;
      }
      return {
        id: `win-${d.Drive || d.Id || i}`,
        devicePath: d.Drive || String(d.Id || `\\\\.\\CdRom${i}`),
        vendor: (d.Manufacturer || '').trim() || 'Unknown',
        model: (d.Caption || '').trim() || 'Optical Drive',
        firmware: '',
        simulated: false,
        capabilities: emptyCapabilities(),
        media
      } satisfies DriveInfo;
    });
  }
}
