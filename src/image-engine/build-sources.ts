/**
 * Turn dropped files/folders into a flat {@link BuildSourceNode} list for the
 * ISO builder. Supports drag-and-drop selection (the renderer passes absolute
 * paths) and recursive folder scanning.
 */
import * as fs from 'node:fs';
import { basename, join, posix } from 'node:path';
import type { BuildSourceNode } from '../shared/types';

export interface SourceInput {
  /** Absolute path on disk. */
  sourcePath: string;
  /** Optional destination directory inside the image (POSIX). Defaults to root. */
  targetDir?: string;
}

/** Recursively expand inputs into build nodes; also returns the aggregate size. */
export function scanSources(inputs: SourceInput[]): { nodes: BuildSourceNode[]; totalBytes: number } {
  const nodes: BuildSourceNode[] = [];
  let totalBytes = 0;

  const addDir = (absPath: string, targetPath: string) => {
    nodes.push({ targetPath, sourcePath: absPath, isDirectory: true, size: 0 });
    for (const entry of fs.readdirSync(absPath, { withFileTypes: true })) {
      const childAbs = join(absPath, entry.name);
      const childTarget = posix.join(targetPath, entry.name);
      if (entry.isDirectory()) addDir(childAbs, childTarget);
      else if (entry.isFile()) addFile(childAbs, childTarget);
    }
  };

  const addFile = (absPath: string, targetPath: string) => {
    const size = fs.statSync(absPath).size;
    totalBytes += size;
    nodes.push({ targetPath, sourcePath: absPath, isDirectory: false, size });
  };

  for (const input of inputs) {
    const name = basename(input.sourcePath);
    const target = input.targetDir ? posix.join(input.targetDir, name) : name;
    const st = fs.statSync(input.sourcePath);
    if (st.isDirectory()) addDir(input.sourcePath, target);
    else addFile(input.sourcePath, target);
  }

  return { nodes, totalBytes };
}
