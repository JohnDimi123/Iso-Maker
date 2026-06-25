/** Raw IMG handler — reuses the ISO reader when the dump contains ISO9660. */
import * as fs from 'node:fs';
import { SECTOR_SIZE } from '../../shared/constants';
import type { ImageInfo } from '../../shared/types';
import { Iso9660Reader } from '../iso9660/reader';
import type { ImageFormatHandler } from './registry';

export const imgFormat: ImageFormatHandler = {
  id: 'img',
  name: 'Raw IMG',
  extensions: ['.img'],
  detect(filePath) {
    return filePath.toLowerCase().endsWith('.img');
  },
  async info(filePath): Promise<ImageInfo> {
    const size = fs.statSync(filePath).size;
    const reader = Iso9660Reader.open(filePath);
    try {
      const iso = reader.info(filePath);
      if (iso) {
        return { ...iso, format: 'img', formatName: 'Raw IMG (ISO9660 filesystem)' };
      }
    } finally {
      reader.close();
    }
    return {
      format: 'img',
      formatName: 'Raw sector image',
      filePath,
      sizeBytes: size,
      sectorSize: SECTOR_SIZE,
      sectorCount: Math.ceil(size / SECTOR_SIZE),
      fileSystem: 'unknown',
      bootable: false,
      notes: ['Raw image with no recognised ISO9660 filesystem.']
    };
  }
};
