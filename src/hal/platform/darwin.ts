/**
 * macOS optical drive backend.
 *
 * Parses `drutil status` for the loaded-media summary. Apple removed built-in
 * optical drives long ago, so on most Macs this yields an external drive or
 * nothing; the simulated backend covers the empty case.
 */
import type { DriveInfo, MediaInfo } from '../../shared/types';
import type { DriveBackend } from '../types';
import { blankMedia, emptyCapabilities, noMedia, tryExec } from '../util';

export class DarwinBackend implements DriveBackend {
  readonly platform = 'darwin' as const;

  async detectDrives(): Promise<DriveInfo[]> {
    const out = await tryExec('drutil', ['status'], 5000);
    if (!out) return [];
    if (/no media present/i.test(out) && !/Vendor/i.test(out)) {
      return [
        {
          id: 'darwin-0',
          devicePath: '/dev/disk-optical',
          vendor: 'Unknown',
          model: 'Optical Drive',
          firmware: '',
          simulated: false,
          capabilities: emptyCapabilities(),
          media: noMedia()
        }
      ];
    }
    const typeMatch = out.match(/Type:\s*(\S+)/i);
    const present = /Type:/i.test(out);
    let media: MediaInfo = noMedia();
    if (present) {
      media = blankMedia('DVD-ROM', 4_700_000_000);
      media.blank = /blank/i.test(out);
      media.fileSystem = 'unknown';
    }
    return [
      {
        id: 'darwin-0',
        devicePath: '/dev/disk-optical',
        vendor: 'Apple',
        model: typeMatch ? `Optical (${typeMatch[1]})` : 'Optical Drive',
        firmware: '',
        simulated: false,
        capabilities: emptyCapabilities(),
        media
      }
    ];
  }
}
