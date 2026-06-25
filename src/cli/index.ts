/**
 * Iso Maker command-line interface.
 *
 * Provides automation/batch access to every software engine: discover drives,
 * inspect images, build ISOs, extract, convert, verify, checksum, read-test
 * and (simulated) burn.
 */
import * as path from 'node:path';
import { logger, consoleSink } from '../core/logger';
import { IsoMakerError } from '../core/errors';
import { APP_NAME } from '../shared/constants';
import {
  inspect,
  listFormats,
  buildIso,
  calculateBuildSize,
  scanSources,
  convertToIso,
  Iso9660Reader,
  loadFormatPlugin,
  type SourceInput
} from '../image-engine';
import { verify, checksum } from '../verify-engine';
import { driveManager } from '../hal';
import { burnEngine, readTest } from '../burn-engine';
import type { BuildSpec, HashAlgorithm } from '../shared/types';

const VERSION = '0.1.0';

interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [], flags: {} };
  const shorts: Record<string, string> = { o: 'output', f: 'file', d: 'drive', s: 'speed' };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) out.flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.flags[body] = argv[++i];
      else out.flags[body] = true;
    } else if (tok.startsWith('-') && tok.length > 1) {
      const key = shorts[tok.slice(1)] ?? tok.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else {
      out._.push(tok);
    }
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

function progressBar(percent: number, suffix = ''): void {
  const width = 30;
  const filled = Math.round((percent / 100) * width);
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
  process.stderr.write(`\r[${bar}] ${percent.toFixed(1).padStart(5)}% ${suffix}        `);
}
function endBar(): void {
  process.stderr.write('\n');
}

const HELP = `${APP_NAME} CLI v${VERSION}

Usage: isomaker <command> [options]

Commands:
  discover                         List optical drives, capabilities and media
  info <image>                     Show image metadata (ISO/BIN-CUE/IMG/NRG)
  list <image.iso>                 List all files inside an ISO
  build -o <out.iso> <paths...>    Build an ISO9660/Joliet image from files/folders
       [--label NAME] [--no-joliet] [--udf] [--strict]
       [--boot <img> --boot-emul none|floppy1.44|floppy2.88|hdd] [--boot-info]
       [--size-only]
  extract <image.iso> [--out dir] [--file pathInImage]
  convert <image> -o <out.iso>     Convert BIN/IMG to ISO (single data track)
  verify <source> <target> [--algo sha256,md5] [--sector 2048]
  checksum <image> [--algo sha256,md5,sha1,crc32]
  test <image|device>              Sequential read test + surface scan
  burn <image> -d <driveId> [-s <kbps>] [--simulate] [--no-verify]
       [--no-finalize] [--erase] [--erase-mode quick|full] [--retries N]
  formats                          List registered image-format handlers
  plugin <module>                  Load an external format plugin and exit

Global:
  --log-file <path>   Also write logs to a file
  -h, --help          Show this help
  -v, --version       Show version
`;

async function cmdDiscover(): Promise<void> {
  const drives = await driveManager.listDrives({ includeSimulated: true });
  console.log(`Found ${drives.length} drive(s):\n`);
  for (const d of drives) {
    const c = d.capabilities;
    console.log(`● ${d.vendor} ${d.model} [${d.id}]${d.simulated ? '  (simulated)' : ''}`);
    console.log(`    Device:    ${d.devicePath}   Firmware: ${d.firmware || 'n/a'}`);
    console.log(
      `    Writes:    CD:${c.writeCD ? 'Y' : 'N'} DVD:${c.writeDVD ? 'Y' : 'N'} DVD-DL:${
        c.writeDVDDualLayer ? 'Y' : 'N'
      } BD:${c.writeBD ? 'Y' : 'N'}  BURN-proof:${c.supportsBufferUnderrunProtection ? 'Y' : 'N'}`
    );
    const m = d.media;
    if (m.present) {
      console.log(
        `    Media:     ${m.type} (${m.family})  ${fmtBytes(m.capacityBytes)}  fs:${m.fileSystem}` +
          `  ${m.blank ? 'blank' : m.finalized ? 'finalized' : 'appendable'}${m.label ? `  label:${m.label}` : ''}`
      );
    } else {
      console.log('    Media:     (none)');
    }
    console.log('');
  }
}

async function cmdInfo(args: ParsedArgs): Promise<void> {
  const file = args._[0];
  if (!file) throw new Error('info: expected an image path');
  const info = await inspect(file);
  console.log(`File:        ${info.filePath}`);
  console.log(`Format:      ${info.formatName} (${info.format})`);
  console.log(`Size:        ${fmtBytes(info.sizeBytes)} (${info.sizeBytes} bytes)`);
  console.log(`Sector size: ${info.sectorSize}`);
  console.log(`Sectors:     ${info.sectorCount}`);
  console.log(`Filesystem:  ${info.fileSystem}`);
  if (info.label) console.log(`Label:       ${info.label}`);
  console.log(`Bootable:    ${info.bootable ? 'yes' : 'no'}`);
  if (info.tracks?.length) {
    console.log('Tracks:');
    for (const t of info.tracks) {
      console.log(`  #${t.number} ${t.type} ${t.mode ?? ''} sectorSize=${t.sectorSize} sectors=${t.sectors}`);
    }
  }
  if (info.entries?.length) {
    console.log('Top-level entries:');
    for (const e of info.entries.slice(0, 50)) {
      console.log(`  ${e.isDirectory ? 'd' : '-'} ${fmtBytes(e.size).padStart(10)}  ${e.path}`);
    }
  }
  if (info.notes?.length) {
    console.log('Notes:');
    for (const n of info.notes) console.log(`  • ${n}`);
  }
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const file = args._[0];
  if (!file) throw new Error('list: expected an ISO path');
  const reader = Iso9660Reader.open(file);
  try {
    const entries = reader.listAll();
    for (const e of entries) {
      console.log(`${e.isDirectory ? 'd' : '-'} ${fmtBytes(e.size).padStart(10)}  ${e.path}`);
    }
    console.log(`\n${entries.length} entries`);
  } finally {
    reader.close();
  }
}

async function cmdBuild(args: ParsedArgs): Promise<void> {
  const output = args.flags.output as string;
  if (!output) throw new Error('build: -o/--output is required');
  if (args._.length === 0) throw new Error('build: expected one or more source paths');

  const inputs: SourceInput[] = args._.map((p) => ({ sourcePath: path.resolve(p) }));
  const { nodes, totalBytes } = scanSources(inputs);

  const spec: BuildSpec = {
    volumeLabel: (args.flags.label as string) || 'ISO_VOLUME',
    sources: nodes,
    fileSystems: {
      iso9660: true,
      joliet: args.flags['no-joliet'] ? false : true,
      udf: !!args.flags.udf
    },
    boot: {
      enabled: !!args.flags.boot,
      bootImagePath: typeof args.flags.boot === 'string' ? path.resolve(args.flags.boot) : undefined,
      emulation: (args.flags['boot-emul'] as BuildSpec['boot']['emulation']) || 'none',
      bootInfoTable: !!args.flags['boot-info']
    },
    outputPath: path.resolve(output),
    strictIso9660: !!args.flags.strict
  };

  const size = calculateBuildSize(spec);
  console.log(`Sources: ${nodes.length} nodes, ${fmtBytes(totalBytes)} of data`);
  console.log(`Estimated image size: ${fmtBytes(size.sizeBytes)} (${size.sectorCount} sectors)`);
  if (args.flags['size-only']) return;

  const result = await buildIso(spec, (done, total, msg) => {
    progressBar(total ? (done / total) * 100 : 100, msg);
  });
  endBar();
  console.log(`Built ${result.outputPath}`);
  console.log(
    `  ${fmtBytes(result.sizeBytes)}  fs:${result.fileSystem}  label:${result.volumeLabel}` +
      `  bootable:${result.bootable ? 'yes' : 'no'}  in ${result.durationMs} ms`
  );
}

async function cmdExtract(args: ParsedArgs): Promise<void> {
  const file = args._[0];
  if (!file) throw new Error('extract: expected an ISO path');
  const reader = Iso9660Reader.open(file);
  const outFlag = (args.flags.out as string) || (args.flags.output as string) || '';
  try {
    if (typeof args.flags.file === 'string') {
      const dest = outFlag || path.basename(args.flags.file);
      const n = reader.extractFile(args.flags.file, dest);
      console.log(`Extracted ${args.flags.file} -> ${dest} (${fmtBytes(n)})`);
    } else {
      const dir = outFlag || './extracted';
      const count = reader.extractAll(dir, (p, done, total) =>
        progressBar(total ? (done / total) * 100 : 100, p)
      );
      endBar();
      console.log(`Extracted ${count} files to ${dir}`);
    }
  } finally {
    reader.close();
  }
}

async function cmdConvert(args: ParsedArgs): Promise<void> {
  const file = args._[0];
  const output = args.flags.output as string;
  if (!file || !output) throw new Error('convert: usage convert <image> -o <out.iso>');
  const result = await convertToIso(path.resolve(file), path.resolve(output), (done, total) =>
    progressBar(total ? (done / total) * 100 : 100)
  );
  endBar();
  console.log(`Converted ${result.sourceFormat} -> ISO: ${result.outputPath} (${fmtBytes(result.bytesWritten)})`);
}

async function cmdVerify(args: ParsedArgs): Promise<void> {
  const [source, target] = args._;
  if (!source || !target) throw new Error('verify: usage verify <source> <target>');
  const algorithms = ((args.flags.algo as string) || 'sha256')
    .split(',')
    .map((a) => a.trim()) as HashAlgorithm[];
  const sectorSize = parseInt((args.flags.sector as string) || '2048', 10);
  const result = await verify({ sourcePath: source, targetPath: target, sectorSize, algorithms }, (phase, d, t) =>
    progressBar(t ? (d / t) * 100 : 100, phase)
  );
  endBar();
  console.log(result.report);
  process.exitCode = result.ok ? 0 : 2;
}

async function cmdChecksum(args: ParsedArgs): Promise<void> {
  const file = args._[0];
  if (!file) throw new Error('checksum: expected a file path');
  const algorithms = ((args.flags.algo as string) || 'sha256,md5')
    .split(',')
    .map((a) => a.trim()) as HashAlgorithm[];
  const results = await checksum(file, algorithms, (d, t) => progressBar(t ? (d / t) * 100 : 100));
  endBar();
  for (const r of results) console.log(`${r.algorithm.toUpperCase().padEnd(7)} ${r.hex}`);
}

async function cmdTest(args: ParsedArgs): Promise<void> {
  const target = args._[0];
  if (!target) throw new Error('test: expected an image or device path');
  const report = await readTest(target, (done, total, speed) =>
    progressBar(total ? (done / total) * 100 : 100, `${(speed / 1e6).toFixed(1)} MB/s`)
  );
  endBar();
  console.log(report.summary);
}

async function cmdBurn(args: ParsedArgs): Promise<void> {
  const image = args._[0];
  const driveId = args.flags.drive as string;
  if (!image || !driveId) throw new Error('burn: usage burn <image> -d <driveId>');
  await driveManager.listDrives({ includeSimulated: true });

  const spec = burnEngine.createJob(path.resolve(image), driveId, {
    speedKbps: args.flags.speed ? parseInt(args.flags.speed as string, 10) : 0,
    testMode: !!args.flags.simulate,
    verify: !args.flags['no-verify'],
    finalize: !args.flags['no-finalize'],
    eraseFirst: !!args.flags.erase,
    eraseMode: (args.flags['erase-mode'] as 'quick' | 'full') || 'quick',
    retries: args.flags.retries ? parseInt(args.flags.retries as string, 10) : 3
  });
  burnEngine.enqueue(spec);
  burnEngine.queue.events.on('progress', (e) => progressBar(e.percent, `${e.phase} ${(e.speedBps / 1e6).toFixed(1)}MB/s buf:${e.bufferPercent ?? '-'}%`));
  const summary = await burnEngine.process();
  endBar();
  const job = burnEngine.list().find((j) => j.spec.id === spec.id);
  if (job?.verifyResult) console.log(`Verification: ${job.verifyResult.ok ? 'PASSED' : 'FAILED'}`);
  console.log(`Queue drained: ${summary.completed} completed, ${summary.failed} failed`);
  process.exitCode = summary.failed > 0 ? 2 : 0;
}

function cmdFormats(): void {
  console.log('Registered image formats:');
  for (const f of listFormats()) {
    console.log(`  ${f.id.padEnd(8)} ${f.name} (${f.extensions.join(', ')})`);
  }
}

async function main(): Promise<void> {
  logger.addSink(consoleSink);
  logger.setLevel('info');
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (typeof args.flags['log-file'] === 'string') logger.addFileSink(args.flags['log-file']);
  if (args.flags.version || args.flags.v) return void console.log(`${APP_NAME} v${VERSION}`);
  const cmd = args._.shift();
  if (!cmd || args.flags.help || args.flags.h) return void console.log(HELP);

  switch (cmd) {
    case 'discover':
      return cmdDiscover();
    case 'info':
      return cmdInfo(args);
    case 'list':
      return cmdList(args);
    case 'build':
      return cmdBuild(args);
    case 'extract':
      return cmdExtract(args);
    case 'convert':
      return cmdConvert(args);
    case 'verify':
      return cmdVerify(args);
    case 'checksum':
      return cmdChecksum(args);
    case 'test':
      return cmdTest(args);
    case 'burn':
      return cmdBurn(args);
    case 'formats':
      return cmdFormats();
    case 'plugin': {
      const ok = loadFormatPlugin(path.resolve(args._[0] || ''));
      cmdFormats();
      process.exitCode = ok ? 0 : 1;
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof IsoMakerError) console.error(`\nError [${err.category}]: ${err.message}`);
  else console.error(`\nError: ${(err as Error).message}`);
  process.exitCode = 1;
});
