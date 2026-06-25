#!/usr/bin/env node
// Build orchestration for Iso Maker.
// Bundles the Electron main process, preload, renderer and CLI with esbuild,
// and copies static renderer assets into dist/.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

// Discover integration test entry points (compiled for `node --test`).
const testDir = resolve(root, 'src/test');
const testEntries = existsSync(testDir)
  ? readdirSync(testDir)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => resolve(testDir, f))
  : [];

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production') }
};

/** Node-side builds (main, preload, cli) keep electron + native node external. */
const nodeBuilds = [
  {
    name: 'main',
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron']
  },
  {
    name: 'preload',
    entryPoints: [resolve(root, 'src/preload/preload.ts')],
    outfile: resolve(root, 'dist/preload/preload.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron']
  },
  {
    name: 'cli',
    entryPoints: [resolve(root, 'src/cli/index.ts')],
    outfile: resolve(root, 'dist/cli/index.js'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    banner: { js: '#!/usr/bin/env node' }
  }
];

/** Renderer runs in the browser context. */
const rendererBuild = {
  name: 'renderer',
  entryPoints: [resolve(root, 'src/renderer/renderer.ts')],
  outfile: resolve(root, 'dist/renderer/renderer.js'),
  platform: 'browser',
  target: 'chrome120',
  format: 'iife'
};

function copyStatic() {
  mkdirSync(resolve(root, 'dist/renderer'), { recursive: true });
  cpSync(resolve(root, 'src/renderer/index.html'), resolve(root, 'dist/renderer/index.html'));
  cpSync(resolve(root, 'src/renderer/styles.css'), resolve(root, 'dist/renderer/styles.css'));
  // Ship the window icon inside the package (dist is bundled by electron-builder).
  const icon = resolve(root, 'build/icon.png');
  if (existsSync(icon)) cpSync(icon, resolve(root, 'dist/renderer/icon.png'));
}

const testBuild =
  testEntries.length > 0
    ? {
        name: 'test',
        entryPoints: testEntries,
        outdir: resolve(root, 'dist/test'),
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        external: ['electron', 'node:test']
      }
    : null;

async function run() {
  // Strip the local `name` label — it is not a valid esbuild option.
  const all = [...nodeBuilds, rendererBuild, ...(testBuild ? [testBuild] : [])].map(
    ({ name, ...b }) => ({ ...common, ...b })
  );
  if (watch) {
    const ctxs = await Promise.all(all.map((b) => esbuild.context(b)));
    copyStatic();
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[build] watching for changes…');
  } else {
    await Promise.all(all.map((b) => esbuild.build(b)));
    copyStatic();
    console.log('[build] complete');
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
