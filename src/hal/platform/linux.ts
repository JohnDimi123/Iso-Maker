/**
 * Linux optical drive backend.
 *
 * Uses `lsblk` JSON when available (rich vendor/model/fs/label data) and
 * falls back to scanning /sys/block for `sr*` devices. Detection is purely
 * metadata based — the raw device node is intentionally never opened here, so
 * the call can never block on a spinning-up or empty drive.
 */
import * as fs from 'node:fs';
import type { DriveInfo, FileSystemType, MediaInfo } from '../../shared/types';
import type { DriveBackend } from '../types';
import { blankMedia, emptyCapabilities, familyOf, noMedia, writeSpeedsFor, tryExec } from '../util';

function mapFsType(fstype: string | null): FileSystemType {
  if (!fstype) return 'unknown';
  if (fstype === 'iso9660') return 'ISO9660';
  if (fstype === 'udf') return 'UDF';
  return 'unknown';
}

function readSys(path: string): string {
  try {
    return fs.readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

export class LinuxBackend implements DriveBackend {
  readonly platform = 'linux' as const;

  async detectDrives(): Promise<DriveInfo[]> {
    const viaLsblk = await this.viaLsblk();
    if (viaLsblk.length > 0) return viaLsblk;
    return this.viaSysfs();
  }

  private async viaLsblk(): Promise<DriveInfo[]> {
    const out = await tryExec('lsblk', ['-J', '-b', '-o', 'NAME,TYPE,VENDOR,MODEL,REV,SIZE,FSTYPE,LABEL']);
    if (!out) return [];
    let parsed: { blockdevices?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(out);
    } catch {
      return [];
    }
    const roms = (parsed.blockdevices ?? []).filter((d) => d.type === 'rom');
    return roms.map((d, i) => {
      const name = String(d.name);
      const size = Number(d.size ?? 0);
      const present = size > 0;
      const fsType = mapFsType((d.fstype as string) ?? null);
      let media: MediaInfo;
      if (!present) {
        media = noMedia();
      } else {
        media = blankMedia('DVD-ROM', size);
        media.blank = false;
        media.finalized = true;
        media.fileSystem = fsType;
        media.label = (d.label as string) || undefined;
        media.usedSectors = Math.floor(size / 2048);
        media.usedBytes = size;
        media.freeBytes = 0;
        media.writeSpeeds = writeSpeedsFor('DVD');
      }
      return {
        id: `linux-${name}`,
        devicePath: `/dev/${name}`,
        vendor: String(d.vendor || '').trim() || 'Unknown',
        model: String(d.model || '').trim() || name,
        firmware: String(d.rev || '').trim(),
        simulated: false,
        capabilities: emptyCapabilities(),
        media
      } satisfies DriveInfo;
    });
  }

  private async viaSysfs(): Promise<DriveInfo[]> {
    let names: string[] = [];
    try {
      names = fs.readdirSync('/sys/block').filter((n) => n.startsWith('sr'));
    } catch {
      return [];
    }
    return names.map((name) => {
      const dev = `/sys/block/${name}/device`;
      const size512 = Number(readSys(`/sys/block/${name}/size`) || '0');
      const capacity = size512 * 512;
      const present = capacity > 0;
      const media = present ? blankMedia('DVD-ROM', capacity) : noMedia();
      if (present) {
        media.blank = false;
        media.finalized = true;
        media.fileSystem = 'unknown';
        media.family = familyOf(media.type);
      }
      return {
        id: `linux-${name}`,
        devicePath: `/dev/${name}`,
        vendor: readSys(`${dev}/vendor`) || 'Unknown',
        model: readSys(`${dev}/model`) || name,
        firmware: readSys(`${dev}/rev`),
        simulated: false,
        capabilities: emptyCapabilities(),
        media
      } satisfies DriveInfo;
    });
  }
}
