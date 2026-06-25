/** Shared helpers for the hardware abstraction layer. */
import { execFile } from 'node:child_process';
import { SPEED_1X } from '../shared/constants';
import type {
  DiscFamily,
  DriveCapabilities,
  MediaInfo,
  MediaType,
  WriteSpeed
} from '../shared/types';

export function familyOf(media: MediaType): DiscFamily {
  if (media.startsWith('CD')) return 'CD';
  if (media.startsWith('DVD')) return 'DVD';
  if (media.startsWith('BD')) return 'BD';
  return 'unknown';
}

/** Generate a plausible set of selectable write speeds for a disc family. */
export function writeSpeedsFor(family: DiscFamily): WriteSpeed[] {
  const base = SPEED_1X[family] ?? SPEED_1X.DVD;
  const multipliers: Record<DiscFamily, number[]> = {
    CD: [4, 8, 16, 24, 32, 48],
    DVD: [2, 4, 6, 8, 12, 16],
    BD: [2, 4, 6, 8, 12, 16],
    unknown: [1, 2, 4]
  };
  const speeds = multipliers[family].map<WriteSpeed>((m) => ({
    multiplier: m,
    kbps: Math.round((base * m) / 1000),
    label: `${m}x`
  }));
  return [{ multiplier: 0, kbps: 0, label: 'MAX (auto)' }, ...speeds];
}

export function emptyCapabilities(): DriveCapabilities {
  return {
    readCD: true,
    writeCD: true,
    readDVD: true,
    writeDVD: true,
    writeDVDDualLayer: true,
    readBD: true,
    writeBD: true,
    supportsBufferUnderrunProtection: true,
    supportsTestWrite: true,
    supportedMedia: [
      'CD-R',
      'CD-RW',
      'DVD-R',
      'DVD+R',
      'DVD-RW',
      'DVD+RW',
      'DVD-R DL',
      'DVD+R DL',
      'BD-R',
      'BD-RE',
      'BD-R DL'
    ]
  };
}

export function blankMedia(type: MediaType, capacityBytes: number): MediaInfo {
  const family = familyOf(type);
  const sectorSize = 2048;
  const totalSectors = Math.floor(capacityBytes / sectorSize);
  return {
    present: true,
    type,
    family,
    fileSystem: 'none',
    sectorSize,
    totalSectors,
    usedSectors: 0,
    capacityBytes,
    usedBytes: 0,
    freeBytes: capacityBytes,
    erasable: type.endsWith('RW') || type.endsWith('RE') || type === 'DVD-RAM',
    finalized: false,
    blank: true,
    sessions: 0,
    writeSpeeds: writeSpeedsFor(family)
  };
}

export function noMedia(): MediaInfo {
  return {
    present: false,
    type: 'unknown',
    family: 'unknown',
    fileSystem: 'none',
    sectorSize: 2048,
    totalSectors: 0,
    usedSectors: 0,
    capacityBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
    erasable: false,
    finalized: false,
    blank: false,
    sessions: 0,
    writeSpeeds: []
  };
}

/** Run a command with a timeout, resolving to stdout or null on any failure. */
export function tryExec(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(err ? null : stdout.toString());
      });
    } catch {
      resolve(null);
    }
  });
}
