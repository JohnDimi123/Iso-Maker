/**
 * Image engine entry point.
 *
 * Registers the built-in format handlers and re-exports the high-level
 * operations used by the CLI, IPC layer and UI.
 */
import { registerFormat, inspect, listFormats, resolveHandler, type ImageFormatHandler } from './formats/registry';
import { isoFormat } from './formats/iso';
import { binCueFormat } from './formats/bincue';
import { imgFormat } from './formats/img';
import { nrgFormat } from './formats/nrg';
import { logger } from '../core/logger';

// Register the built-in formats. Plugins may override or extend these.
for (const fmt of [isoFormat, binCueFormat, imgFormat, nrgFormat]) registerFormat(fmt);

export { inspect, listFormats, resolveHandler, registerFormat };
export type { ImageFormatHandler };
export { buildIso, calculateBuildSize, deriveFileSystem } from './iso9660/builder';
export { Iso9660Reader } from './iso9660/reader';
export { scanSources, type SourceInput } from './build-sources';
export { convertToIso, type ConvertResult } from './convert';

/**
 * Load an external format plugin (CommonJS module exporting `default` or a
 * named `format` of type {@link ImageFormatHandler}).
 */
export function loadFormatPlugin(modulePath: string): boolean {
  const log = logger.child('plugins');
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modulePath);
    const handler: ImageFormatHandler | undefined = mod.default ?? mod.format ?? mod.handler;
    if (handler && handler.id && typeof handler.info === 'function') {
      registerFormat(handler);
      log.success(`Loaded format plugin '${handler.id}' from ${modulePath}`);
      return true;
    }
    log.warn(`Plugin ${modulePath} did not export a valid format handler`);
    return false;
  } catch (err) {
    log.error(`Failed to load plugin ${modulePath}: ${(err as Error).message}`);
    return false;
  }
}
