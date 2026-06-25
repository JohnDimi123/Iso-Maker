/** Internal HAL backend contract. */
import type { DriveInfo } from '../shared/types';

export interface DriveBackend {
  readonly platform: NodeJS.Platform | 'simulated';
  /** Enumerate optical drives visible to this backend. */
  detectDrives(): Promise<DriveInfo[]>;
}
