/**
 * Integration tests for the ISO9660/Joliet build → read round-trip and the
 * verification engine. Run with `npm test` (builds first, then `node --test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { buildIso, calculateBuildSize, scanSources, Iso9660Reader } from '../image-engine';
import { verify, hashFile } from '../verify-engine';
import type { BuildSpec } from '../shared/types';

function tmp(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'isomaker-test-'));
}

function makeFixture(dir: string): { files: Record<string, Buffer> } {
  fs.mkdirSync(join(dir, 'sub/deep'), { recursive: true });
  const files: Record<string, Buffer> = {
    'root.txt': Buffer.from('root content\n'),
    'binary.dat': Buffer.from([0, 1, 2, 3, 255, 254, 0, 42]),
    'sub/Long Name File.md': Buffer.from('# heading\nsome markdown\n'),
    'sub/deep/buried.bin': Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256))
  };
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(join(dir, rel, '..'), { recursive: true });
    fs.writeFileSync(join(dir, rel), data);
  }
  return { files };
}

function specFor(srcDir: string, out: string): BuildSpec {
  const { nodes } = scanSources([{ sourcePath: srcDir }]);
  // Re-root the scanned nodes so contents land at the image root.
  const base = srcDir.split(/[\\/]/).pop()!;
  const sources = nodes
    .map((n) => ({ ...n, targetPath: n.targetPath.slice(base.length + 1) }))
    .filter((n) => n.targetPath.length > 0);
  return {
    volumeLabel: 'TEST_VOL',
    sources,
    fileSystems: { iso9660: true, joliet: true, udf: false },
    boot: { enabled: false, emulation: 'none' },
    outputPath: out
  };
}

test('build produces an ISO whose size matches the layout calculation', async () => {
  const dir = tmp();
  makeFixture(dir);
  const out = join(dir, 'out.iso');
  const spec = specFor(dir, out);
  const predicted = calculateBuildSize(spec);
  const result = await buildIso(spec);
  assert.equal(result.sizeBytes, predicted.sizeBytes, 'predicted size must equal actual size');
  assert.equal(fs.statSync(out).size, result.sizeBytes, 'file on disk must match reported size');
  assert.equal(result.fileSystem, 'ISO9660+Joliet');
});

test('reader round-trips every file byte-for-byte', async () => {
  const dir = tmp();
  const { files } = makeFixture(dir);
  const out = join(dir, 'out.iso');
  await buildIso(specFor(dir, out));

  const reader = Iso9660Reader.open(out);
  try {
    const info = reader.info(out)!;
    assert.equal(info.label, 'TEST_VOL');
    assert.equal(info.fileSystem, 'ISO9660+Joliet');

    const listed = reader.listAll().filter((e) => !e.isDirectory);
    assert.equal(listed.length, Object.keys(files).length, 'all files present');

    const extractDir = join(dir, 'extracted');
    reader.extractAll(extractDir);
    for (const [rel, data] of Object.entries(files)) {
      const got = fs.readFileSync(join(extractDir, rel));
      assert.deepEqual(got, data, `content mismatch for ${rel}`);
    }
  } finally {
    reader.close();
  }
});

test('verify reports PASS for identical files and FAIL for a corrupted copy', async () => {
  const dir = tmp();
  makeFixture(dir);
  const a = join(dir, 'a.iso');
  await buildIso(specFor(dir, a));
  const b = join(dir, 'b.iso');
  fs.copyFileSync(a, b);

  const pass = await verify({ sourcePath: a, targetPath: b, sectorSize: 2048, algorithms: ['md5', 'sha256'] });
  assert.equal(pass.ok, true, 'identical copies must verify');
  assert.equal(pass.mismatches.length, 0);

  // Corrupt one byte well inside the data area.
  const fd = fs.openSync(b, 'r+');
  fs.writeSync(fd, Buffer.from([0xff]), 0, 1, 40000);
  fs.closeSync(fd);

  const fail = await verify({ sourcePath: a, targetPath: b, sectorSize: 2048, algorithms: ['sha256'] });
  assert.equal(fail.ok, false, 'corrupted copy must fail verification');
  assert.ok(fail.mismatches.length > 0, 'mismatch must be located');
});

test('hashFile is deterministic and matches a known empty-input digest', async () => {
  const dir = tmp();
  const f = join(dir, 'empty');
  fs.writeFileSync(f, '');
  const [sha] = await hashFile(f, ['sha256']);
  assert.equal(sha.hex, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
