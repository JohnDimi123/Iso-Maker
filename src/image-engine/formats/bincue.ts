/** BIN/CUE image format handler — parses cue sheets into a track list. */
import * as fs from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { RAW_SECTOR_SIZE, SECTOR_SIZE } from '../../shared/constants';
import type { ImageInfo, ImageTrack } from '../../shared/types';
import type { ImageFormatHandler } from './registry';

interface CueTrack {
  number: number;
  mode: string;
  sectorSize: number;
  type: 'data' | 'audio';
}

function sectorSizeForMode(mode: string): number {
  const m = mode.toUpperCase();
  if (m === 'MODE1/2048') return SECTOR_SIZE;
  if (m.endsWith('/2352') || m === 'AUDIO') return RAW_SECTOR_SIZE;
  if (m.endsWith('/2336')) return 2336;
  return RAW_SECTOR_SIZE;
}

function parseCue(cuePath: string): { binFile: string; tracks: CueTrack[] } {
  const text = fs.readFileSync(cuePath, 'utf8');
  const tracks: CueTrack[] = [];
  let binFile = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const fileMatch = trimmed.match(/^FILE\s+"?(.+?)"?\s+(\w+)$/i);
    if (fileMatch) {
      binFile = fileMatch[1];
      continue;
    }
    const trackMatch = trimmed.match(/^TRACK\s+(\d+)\s+(\S+)/i);
    if (trackMatch) {
      const mode = trackMatch[2];
      tracks.push({
        number: parseInt(trackMatch[1], 10),
        mode,
        sectorSize: sectorSizeForMode(mode),
        type: /AUDIO/i.test(mode) ? 'audio' : 'data'
      });
    }
  }
  return { binFile, tracks };
}

export const binCueFormat: ImageFormatHandler = {
  id: 'bincue',
  name: 'BIN/CUE',
  extensions: ['.cue', '.bin'],
  detect(filePath, header) {
    if (filePath.toLowerCase().endsWith('.cue')) {
      return /\bTRACK\b/i.test(header.toString('utf8'));
    }
    return false;
  },
  async info(filePath): Promise<ImageInfo> {
    // Accept either the .cue or the .bin; prefer the .cue for metadata.
    let cuePath = filePath;
    if (filePath.toLowerCase().endsWith('.bin')) {
      const guess = filePath.replace(/\.bin$/i, '.cue');
      if (fs.existsSync(guess)) cuePath = guess;
    }

    const notes: string[] = [];
    let tracks: ImageTrack[] = [];
    let binPath = filePath.toLowerCase().endsWith('.bin') ? filePath : '';
    let primarySectorSize = RAW_SECTOR_SIZE;

    if (cuePath.toLowerCase().endsWith('.cue') && fs.existsSync(cuePath)) {
      const parsed = parseCue(cuePath);
      binPath = parsed.binFile ? join(dirname(cuePath), basename(parsed.binFile)) : binPath;
      const binSize = binPath && fs.existsSync(binPath) ? fs.statSync(binPath).size : 0;
      if (!binPath || !fs.existsSync(binPath)) notes.push(`Referenced BIN file not found: ${parsed.binFile}`);
      primarySectorSize = parsed.tracks[0]?.sectorSize ?? RAW_SECTOR_SIZE;
      // Single-bin layout: distribute sectors across tracks evenly is non-trivial;
      // report each track's mode and the overall sector count of the bin.
      let start = 0;
      tracks = parsed.tracks.map<ImageTrack>((t) => {
        const track: ImageTrack = {
          number: t.number,
          type: t.type,
          mode: t.mode,
          sectorSize: t.sectorSize,
          startSector: start,
          sectors: parsed.tracks.length === 1 && binSize ? Math.floor(binSize / t.sectorSize) : 0,
          file: binPath ? basename(binPath) : undefined
        };
        start += track.sectors;
        return track;
      });
      if (parsed.tracks.length > 1) {
        notes.push('Multi-track BIN/CUE: per-track sector counts require INDEX parsing (not yet computed).');
      }
    } else {
      notes.push('No cue sheet found; reporting raw BIN geometry.');
    }

    const size = binPath && fs.existsSync(binPath) ? fs.statSync(binPath).size : fs.statSync(filePath).size;
    return {
      format: 'bincue',
      formatName: 'BIN/CUE disc image',
      filePath: cuePath,
      sizeBytes: size,
      sectorSize: primarySectorSize,
      sectorCount: Math.floor(size / primarySectorSize),
      fileSystem: 'unknown',
      bootable: false,
      tracks,
      notes
    };
  }
};
