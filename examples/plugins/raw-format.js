/**
 * Example Iso Maker image-format plugin.
 *
 * Demonstrates the plugin contract: export an `ImageFormatHandler` as
 * `format` (or `default`/`handler`). Load it with:
 *
 *     isomaker plugin ./examples/plugins/raw-format.js
 *
 * This handler claims ".raw" sector dumps and reports basic geometry.
 */
const fs = require('node:fs');

const SECTOR_SIZE = 2048;

module.exports.format = {
  id: 'raw',
  name: 'Raw sector dump (.raw)',
  extensions: ['.raw'],
  detect(filePath) {
    return filePath.toLowerCase().endsWith('.raw');
  },
  async info(filePath) {
    const size = fs.statSync(filePath).size;
    return {
      format: 'raw',
      formatName: 'Raw sector dump',
      filePath,
      sizeBytes: size,
      sectorSize: SECTOR_SIZE,
      sectorCount: Math.ceil(size / SECTOR_SIZE),
      fileSystem: 'unknown',
      bootable: false,
      notes: ['Loaded via the example raw-format plugin.']
    };
  }
};
