/**
 * Windows optical drive backend.
 *
 * Queries WMI/CIM via PowerShell (`Win32_CDROMDrive`) for drive enumeration
 * and loaded-media state. On the production Windows build this provides real
 * drive discovery; real read/write I/O is performed by the burn engine's
 * Windows adapter (IMAPI2 / SPTI) which plugs into this layer.
 */
import type { DriveInfo, MediaInfo } from '../../shared/types';
import type { DriveBackend } from '../types';
import { blankMedia, emptyCapabilities, noMedia, tryExec } from '../util';

interface CimDrive {
  Drive?: string;
  Id?: string;
  Caption?: string;
  Manufacturer?: string;
  MediaLoaded?: boolean;
  Size?: number | string;
  MediaType?: string;
}

export class Win32Backend implements DriveBackend {
  readonly platform = 'win32' as const;

  async detectDrives(): Promise<DriveInfo[]> {
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
