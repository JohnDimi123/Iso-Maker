/** ISO9660 / Joliet image format handler. */
import * as fs from 'node:fs';
import { SECTOR_SIZE } from '../../shared/constants';
import type { ImageInfo } from '../../shared/types';
import { Iso9660Reader } from '../iso9660/reader';
import type { ImageFormatHandler } from './registry';

export const isoFormat: ImageFormatHandler = {
  id: 'iso',
  name: 'ISO9660 / Joliet',
  extensions: ['.iso'],
  detect(_filePath, header) {
    // "CD001" identifier lives at offset 1 of the volume descriptor at LBA 16.
    const off = 16 * SECTOR_SIZE + 1;
    if (header.length > off + 5) return header.toString('ascii', off, off + 5) === 'CD001';
    return false;
  },
  async info(filePath): Promise<ImageInfo> {
    const reader = Iso9660Reader.open(filePath);
    try {
      const info = reader.info(filePath);
      if (info) return info;
      const size = fs.statSync(filePath).size;
      return {
        format: 'iso',
        formatName: 'ISO image (unparsed)',
        filePath,
        sizeBytes: size,
        sectorSize: SECTOR_SIZE,
        sectorCount: Math.ceil(size / SECTOR_SIZE),
        fileSystem: 'unknown',
        bootable: false,
        notes: ['File has an .iso extension but no readable ISO9660 descriptor.']
      };
    } finally {
      reader.close();
    }
  }
};
