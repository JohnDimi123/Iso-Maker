/**
 * Simulated drive backend.
 *
 * Always available, on every platform. It lets the entire application — UI,
 * burn engine, diagnostics — be exercised end to end without physical optical
 * hardware. Simulated drives are clearly flagged (`simulated: true`).
 */
import type { DriveInfo } from '../../shared/types';
import { MEDIA_CAPACITY } from '../../shared/constants';
import type { DriveBackend } from '../types';
import { blankMedia, emptyCapabilities, writeSpeedsFor } from '../util';

export class SimulatedBackend implements DriveBackend {
  readonly platform = 'simulated' as const;

  async detectDrives(): Promise<DriveInfo[]> {
    const blankBD = blankMedia('BD-R', MEDIA_CAPACITY['BD-R 25']);
    const dvdWithData = blankMedia('DVD+RW', MEDIA_CAPACITY['DVD±R']);
    // Make the DVD look like it already carries a finalized data disc.
    Object.assign(dvdWithData, {
      blank: false,
      finalized: true,
      fileSystem: 'ISO9660+Joliet',
      label: 'SAMPLE_DISC',
      sessions: 1,
      usedSectors: 256000,
      usedBytes: 256000 * 2048,
      freeBytes: 0,
      writeSpeeds: writeSpeedsFor('DVD')
    });

    return [
      {
        id: 'sim-0',
        devicePath: 'SIM:0',
        vendor: 'IsoMaker',
        model: 'Virtual BD-RE Writer',
        firmware: '1.00',
        simulated: true,
        capabilities: emptyCapabilities(),
        media: blankBD
      },
      {
        id: 'sim-1',
        devicePath: 'SIM:1',
        vendor: 'IsoMaker',
        model: 'Virtual DVD±RW Writer',
        firmware: '1.00',
        simulated: true,
        capabilities: emptyCapabilities(),
        media: dvdWithData
      }
    ];
  }
}
