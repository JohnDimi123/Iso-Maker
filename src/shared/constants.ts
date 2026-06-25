/** Shared constants describing optical media geometry and app metadata. */

export const APP_NAME = 'Iso Maker';
export const APP_ID = 'org.isomaker.app';

/** Logical data sector size in bytes. */
export const SECTOR_SIZE = 2048;

/** Raw CD sector size (Mode 2 / audio). */
export const RAW_SECTOR_SIZE = 2352;

/** Base transfer rate (bytes/sec) for "1x" of each disc family. */
export const SPEED_1X: Record<string, number> = {
  CD: 150 * 1024, // 150 KiB/s
  DVD: 1385000, // 1.385 MB/s
  BD: 4_500_000 // 4.5 MB/s
};

/** Nominal capacities in bytes keyed by a friendly media descriptor. */
export const MEDIA_CAPACITY: Record<string, number> = {
  'CD-R 74min': 650 * 1024 * 1024,
  'CD-R 80min': 700 * 1024 * 1024,
  'DVD±R': 4_700_000_000,
  'DVD±R DL': 8_540_000_000,
  'BD-R 25': 25_000_000_000,
  'BD-R 50': 50_000_000_000,
  'BD-R 100': 100_000_000_000
};

/** Standard layer-break position for pressed/dual-layer DVD9 (sectors). */
export const DVD_DL_DEFAULT_LAYER_BREAK = 1_913_760;

export const SUPPORTED_IMAGE_EXTENSIONS = ['.iso', '.bin', '.cue', '.img', '.nrg', '.mds'];
