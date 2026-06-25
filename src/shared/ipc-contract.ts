/**
 * IPC contract shared by the Electron main process, the preload bridge and
 * the renderer. Channel names live here so all three stay in sync.
 */
import type {
  BuildResult,
  BuildSourceNode,
  BuildSpec,
  DiagnosticsReport,
  DriveInfo,
  HashAlgorithm,
  HashResult,
  ImageFileEntry,
  ImageInfo,
  LogEntry,
  ProgressEvent,
  VerifyResult,
  VerifySpec
} from './types';

export const Channels = {
  appInfo: 'app:info',
  listDrives: 'drives:list',
  inspectImage: 'image:inspect',
  listImage: 'image:list',
  listFormats: 'image:formats',
  scanSources: 'build:scan',
  buildSize: 'build:size',
  buildRun: 'build:run',
  extract: 'image:extract',
  convert: 'image:convert',
  verifyRun: 'verify:run',
  checksum: 'verify:checksum',
  testRead: 'test:read',
  burnRun: 'burn:run',
  burnCancel: 'burn:cancel',
  dialogOpenFiles: 'dialog:openFiles',
  dialogOpenFolder: 'dialog:openFolder',
  dialogSave: 'dialog:save',
  dialogOpenImage: 'dialog:openImage'
} as const;

export const Events = {
  progress: 'evt:progress',
  log: 'evt:log'
} as const;

export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
}

export interface BurnRequest {
  imagePath: string;
  driveId: string;
  options: {
    speedKbps: number;
    testMode: boolean;
    verify: boolean;
    finalize: boolean;
    eraseFirst: boolean;
    eraseMode: 'quick' | 'full';
    retries: number;
    bufferUnderrunProtection: boolean;
    layerBreak: number;
  };
}

export interface BurnResponse {
  ok: boolean;
  simulated: boolean;
  jobId: string;
  error?: string;
  verify?: VerifyResult;
}

export interface FormatSummary {
  id: string;
  name: string;
  extensions: string[];
}

/** The surface exposed to the renderer via `window.isoMaker`. */
export interface IsoMakerApi {
  appInfo(): Promise<AppInfo>;
  listDrives(includeSimulated: boolean): Promise<DriveInfo[]>;
  inspectImage(path: string): Promise<ImageInfo>;
  listImage(path: string): Promise<ImageFileEntry[]>;
  listFormats(): Promise<FormatSummary[]>;
  scanSources(paths: string[]): Promise<{ nodes: BuildSourceNode[]; totalBytes: number }>;
  buildSize(spec: BuildSpec): Promise<{ sizeBytes: number; sectorCount: number }>;
  buildIso(spec: BuildSpec): Promise<BuildResult>;
  extract(path: string, opts: { outDir?: string; file?: string }): Promise<{ count: number }>;
  convertToIso(src: string, out: string): Promise<{ bytesWritten: number }>;
  verify(spec: VerifySpec): Promise<VerifyResult>;
  checksum(path: string, algorithms: HashAlgorithm[]): Promise<HashResult[]>;
  readTest(path: string): Promise<DiagnosticsReport>;
  burn(req: BurnRequest): Promise<BurnResponse>;
  cancelBurn(jobId: string): Promise<void>;
  chooseFiles(): Promise<string[]>;
  chooseFolder(): Promise<string | null>;
  chooseSave(defaultName: string): Promise<string | null>;
  chooseImage(): Promise<string | null>;
  onProgress(cb: (e: ProgressEvent) => void): () => void;
  onLog(cb: (e: LogEntry) => void): () => void;
}

declare global {
  interface Window {
    isoMaker: IsoMakerApi;
  }
}
