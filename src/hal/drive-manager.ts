/**
 * Drive manager — the public face of the hardware abstraction layer.
 *
 * Selects the appropriate platform backend at runtime and merges in the
 * always-available simulated drives so the UI/engines have something to act
 * on even with no optical hardware present.
 */
import type { DriveInfo } from '../shared/types';
import { logger } from '../core/logger';
import type { DriveBackend } from './types';
import { SimulatedBackend } from './platform/simulated';
import { LinuxBackend } from './platform/linux';
import { Win32Backend } from './platform/win32';
import { DarwinBackend } from './platform/darwin';

export interface ListOptions {
  /** Include the virtual/simulated drives (default: true). */
  includeSimulated?: boolean;
}

export class DriveManager {
  private readonly backend: DriveBackend;
  private readonly simulated = new SimulatedBackend();
  private cache: DriveInfo[] = [];

  constructor() {
    switch (process.platform) {
      case 'win32':
        this.backend = new Win32Backend();
        break;
      case 'darwin':
        this.backend = new DarwinBackend();
        break;
      case 'linux':
        this.backend = new LinuxBackend();
        break;
      default:
        this.backend = this.simulated;
    }
  }

  async listDrives(opts: ListOptions = {}): Promise<DriveInfo[]> {
    const includeSimulated = opts.includeSimulated ?? true;
    let real: DriveInfo[] = [];
    try {
      real = this.backend === this.simulated ? [] : await this.backend.detectDrives();
    } catch (err) {
      logger.child('hal').warn(`Drive detection failed: ${(err as Error).message}`);
    }
    const drives = [...real];
    if (includeSimulated || real.length === 0) {
      drives.push(...(await this.simulated.detectDrives()));
    }
    this.cache = drives;
    logger.child('hal').debug(`Detected ${real.length} physical + simulated drives`);
    return drives;
  }

  async getDrive(id: string): Promise<DriveInfo | undefined> {
    if (this.cache.length === 0) await this.listDrives();
    return this.cache.find((d) => d.id === id);
  }
}

export const driveManager = new DriveManager();
