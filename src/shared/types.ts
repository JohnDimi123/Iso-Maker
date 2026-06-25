/**
 * Shared domain types for Iso Maker.
 *
 * These types form the contract between the engines (image/burn/verify),
 * the hardware abstraction layer (HAL), the CLI and the UI. They are
 * intentionally serialisable (plain data) so they can cross the Electron
 * IPC boundary unchanged.
 */

// ---------------------------------------------------------------------------
// Media & file systems
// ---------------------------------------------------------------------------

export type MediaType =
  | 'CD-ROM'
  | 'CD-R'
  | 'CD-RW'
  | 'DVD-ROM'
  | 'DVD-R'
  | 'DVD-RW'
  | 'DVD+R'
  | 'DVD+RW'
  | 'DVD-R DL'
  | 'DVD+R DL'
  | 'DVD-RAM'
  | 'BD-ROM'
  | 'BD-R'
  | 'BD-RE'
  | 'BD-R DL'
  | 'BD-R XL'
  | 'unknown';

export type DiscFamily = 'CD' | 'DVD' | 'BD' | 'unknown';

export type FileSystemType = 'ISO9660' | 'Joliet' | 'UDF' | 'ISO9660+Joliet' | 'HFS' | 'none' | 'unknown';

/** A single selectable/usable write speed expressed both as a multiplier and KB/s. */
export interface WriteSpeed {
  /** Human multiplier, e.g. 4 for "4x". 0 means "max / auto". */
  multiplier: number;
  /** Kilobytes per second (1000-based, as drives report). */
  kbps: number;
  label: string;
}

// ---------------------------------------------------------------------------
// Drives & inserted media (HAL)
// ---------------------------------------------------------------------------

export interface DriveCapabilities {
  readCD: boolean;
  writeCD: boolean;
  readDVD: boolean;
  writeDVD: boolean;
  writeDVDDualLayer: boolean;
  readBD: boolean;
  writeBD: boolean;
  supportsBufferUnderrunProtection: boolean;
  supportsTestWrite: boolean;
  supportedMedia: MediaType[];
}

export interface MediaInfo {
  present: boolean;
  type: MediaType;
  family: DiscFamily;
  label?: string;
  fileSystem: FileSystemType;
  /** Logical sector size in bytes (2048 for data discs). */
  sectorSize: number;
  /** Total addressable sectors of the media. */
  totalSectors: number;
  /** Sectors already written / used. */
  usedSectors: number;
  capacityBytes: number;
  usedBytes: number;
  freeBytes: number;
  erasable: boolean;
  finalized: boolean;
  blank: boolean;
  sessions: number;
  /** Layer-break position (sectors) for dual-layer media, if applicable. */
  layerBreak?: number;
  writeSpeeds: WriteSpeed[];
}

export interface DriveInfo {
  id: string;
  /** OS device path, e.g. /dev/sr0, \\.\\D:, /dev/disk2. */
  devicePath: string;
  vendor: string;
  model: string;
  firmware: string;
  /** True when this drive is a synthesised/simulated device. */
  simulated: boolean;
  capabilities: DriveCapabilities;
  media: MediaInfo;
}

// ---------------------------------------------------------------------------
// Image files
// ---------------------------------------------------------------------------

export type ImageFormatId = 'iso' | 'bincue' | 'img' | 'nrg' | 'mds' | 'unknown';

export interface ImageTrack {
  number: number;
  type: 'data' | 'audio';
  mode?: string; // MODE1/2048, MODE2/2352, AUDIO ...
  sectorSize: number;
  startSector: number;
  sectors: number;
  file?: string;
}

export interface ImageFileEntry {
  path: string; // path within the image
  size: number;
  isDirectory: boolean;
  sector?: number;
}

export interface ImageInfo {
  format: ImageFormatId;
  formatName: string;
  filePath: string;
  sizeBytes: number;
  sectorSize: number;
  sectorCount: number;
  fileSystem: FileSystemType;
  label?: string;
  bootable: boolean;
  tracks?: ImageTrack[];
  /** Top-level listing (lazy / optional). */
  entries?: ImageFileEntry[];
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Build mode (folder/files -> image)
// ---------------------------------------------------------------------------

export interface BuildSourceNode {
  /** Destination path inside the image (POSIX style, no leading slash for root children). */
  targetPath: string;
  /** Absolute source path on disk. Empty for synthetic directories. */
  sourcePath: string;
  isDirectory: boolean;
  size: number;
}

export interface BootOptions {
  enabled: boolean;
  /** Path to the boot image file (e.g. an El Torito no-emulation image). */
  bootImagePath?: string;
  emulation: 'none' | 'floppy1.44' | 'floppy2.88' | 'hdd';
  loadSegment?: number;
  loadSectorCount?: number;
  bootInfoTable?: boolean;
}

export interface BuildSpec {
  volumeLabel: string;
  sources: BuildSourceNode[];
  fileSystems: {
    iso9660: boolean;
    joliet: boolean;
    udf: boolean;
  };
  boot: BootOptions;
  outputPath: string;
  /** When set, restrict ISO9660 names to strict 8.3 (level 1). */
  strictIso9660?: boolean;
}

export interface BuildResult {
  outputPath: string;
  sizeBytes: number;
  sectorCount: number;
  fileSystem: FileSystemType;
  volumeLabel: string;
  bootable: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Burn / write
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface BurnOptions {
  speedKbps: number; // 0 = automatic / max
  /** Simulate the burn (test mode) — no data committed to media. */
  testMode: boolean;
  /** Verify written media against source afterwards. */
  verify: boolean;
  /** Finalise / close the disc after writing. */
  finalize: boolean;
  /** Erase rewritable media before writing. */
  eraseFirst: boolean;
  eraseMode: 'quick' | 'full';
  ejectWhenDone: boolean;
  /** Layer-break sector for DL media (0 = auto). */
  layerBreak: number;
  /** Number of automatic retries for recoverable errors. */
  retries: number;
  bufferUnderrunProtection: boolean;
}

export interface BurnJobSpec {
  id: string;
  sourceImagePath: string;
  driveId: string;
  options: BurnOptions;
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export type HashAlgorithm = 'crc32' | 'md5' | 'sha1' | 'sha256';

export interface HashResult {
  algorithm: HashAlgorithm;
  hex: string;
  bytesHashed: number;
}

export interface VerifySpec {
  /** "source" is typically the image; "target" the burned disc or a copy. */
  sourcePath: string;
  targetPath: string;
  sectorSize: number;
  algorithms: HashAlgorithm[];
}

export interface SectorMismatch {
  sector: number;
  offset: number;
  sourceByte: number;
  targetByte: number;
}

export interface VerifyResult {
  ok: boolean;
  sectorsCompared: number;
  bytesCompared: number;
  mismatches: SectorMismatch[];
  sourceHashes: HashResult[];
  targetHashes: HashResult[];
  durationMs: number;
  report: string;
}

// ---------------------------------------------------------------------------
// Progress, logging & diagnostics
// ---------------------------------------------------------------------------

export type OperationPhase =
  | 'idle'
  | 'preparing'
  | 'reading'
  | 'building'
  | 'writing'
  | 'finalizing'
  | 'verifying'
  | 'erasing'
  | 'testing'
  | 'done'
  | 'error';

export interface ProgressEvent {
  jobId: string;
  phase: OperationPhase;
  percent: number; // 0..100
  bytesProcessed: number;
  totalBytes: number;
  /** Instantaneous transfer speed in bytes/sec. */
  speedBps: number;
  etaSeconds: number;
  /** Drive/host buffer fill 0..100 (for buffer-underrun visualisation). */
  bufferPercent?: number;
  message?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
}

export interface SurfaceScanBlock {
  sector: number;
  count: number;
  status: 'ok' | 'slow' | 'error';
  readMs: number;
}

export interface DiagnosticsReport {
  driveId: string;
  media: MediaInfo;
  blocks: SurfaceScanBlock[];
  badSectors: number;
  averageSpeedBps: number;
  generatedAt: number;
  summary: string;
}
