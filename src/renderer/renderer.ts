/**
 * Iso Maker renderer.
 *
 * A dependency-free, mode-based UI (Discovery / Read / Build / Write / Verify /
 * Test) that talks to the engines through the typed `window.isoMaker` bridge.
 */
import type {
  BuildSpec,
  DiagnosticsReport,
  DriveInfo,
  HashAlgorithm,
  ImageInfo,
  LogEntry,
  ProgressEvent
} from '../shared/types';
import type { BurnRequest } from '../shared/ipc-contract';

const api = window.isoMaker;

// --------------------------------------------------------------------------
// Tiny DOM helpers
// --------------------------------------------------------------------------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c as Node | string);
  return el;
}
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}
function fmtTime(s: number): string {
  if (!isFinite(s) || s <= 0) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------
// Progress + speed graph
// --------------------------------------------------------------------------
const speedSamples: number[] = [];
function drawGraph(): void {
  const canvas = $('#speed-graph') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (speedSamples.length < 2) return;
  const max = Math.max(...speedSamples, 1);
  const style = getComputedStyle(document.body);
  ctx.strokeStyle = style.getPropertyValue('--accent') || '#4f8cff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  speedSamples.forEach((v, i) => {
    const x = (i / (speedSamples.length - 1)) * width;
    const y = height - (v / max) * (height - 4) - 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function applyProgress(e: ProgressEvent): void {
  $('#progress-phase').textContent = e.phase;
  ($('#progress-fill') as HTMLElement).style.width = `${Math.min(100, e.percent).toFixed(1)}%`;
  $('#progress-pct').textContent = `${e.percent.toFixed(1)}%`;
  $('#progress-speed').textContent = `${(e.speedBps / 1e6).toFixed(2)} MB/s`;
  $('#progress-eta').textContent = `ETA ${fmtTime(e.etaSeconds)}`;
  $('#progress-buffer').textContent = `buffer ${e.bufferPercent ?? '--'}%`;
  speedSamples.push(e.speedBps);
  if (speedSamples.length > 80) speedSamples.shift();
  drawGraph();
}
function resetProgress(): void {
  speedSamples.length = 0;
  applyProgress({
    jobId: '',
    phase: 'idle',
    percent: 0,
    bytesProcessed: 0,
    totalBytes: 0,
    speedBps: 0,
    etaSeconds: 0,
    bufferPercent: 100
  });
}

// --------------------------------------------------------------------------
// Log console
// --------------------------------------------------------------------------
function appendLog(entry: LogEntry): void {
  const list = $('#log-list');
  const time = new Date(entry.ts).toLocaleTimeString();
  const line = h(
    'div',
    { class: `log-line log-${entry.level}` },
    h('span', { class: 'log-time' }, `${time} `),
    `(${entry.source}) ${entry.message}`
  );
  list.append(line);
  list.scrollTop = list.scrollHeight;
}

// --------------------------------------------------------------------------
// Modes
// --------------------------------------------------------------------------
interface Mode {
  id: string;
  title: string;
  icon: string;
  desc: string;
  render(): HTMLElement;
}

// ---- Discovery ----
const discoveryMode: Mode = {
  id: 'discovery',
  title: 'Discovery',
  icon: '🔎',
  desc: 'Detect optical drives, capabilities and inserted media.',
  render() {
    const list = h('div', {});
    const refresh = async () => {
      list.replaceChildren(h('div', { class: 'empty' }, 'Scanning drives…'));
      const drives = await api.listDrives(true);
      list.replaceChildren(...drives.map(driveCard));
      if (drives.length === 0) list.replaceChildren(h('div', { class: 'empty' }, 'No drives detected.'));
    };
    const wrap = h(
      'div',
      {},
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'row spread' }, h('h2', {}, 'Optical drives'), h('button', { class: 'btn', onclick: refresh }, 'Refresh')),
        list
      )
    );
    void refresh();
    return wrap;
  }
};

function driveCard(d: DriveInfo): HTMLElement {
  const c = d.capabilities;
  const m = d.media;
  const caps = `CD ${c.writeCD ? 'R/W' : 'R'} · DVD ${c.writeDVD ? 'R/W' : 'R'}${c.writeDVDDualLayer ? ' DL' : ''} · BD ${c.writeBD ? 'R/W' : 'R'}`;
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row spread' },
      h('h2', {}, `${d.vendor} ${d.model}`),
      d.simulated ? h('span', { class: 'tag sim' }, 'simulated') : h('span', { class: 'tag ok' }, 'physical')
    ),
    h(
      'div',
      { class: 'kv' },
      'Device', d.devicePath,
      'Firmware', d.firmware || 'n/a',
      'Capabilities', caps,
      'BURN-proof', c.supportsBufferUnderrunProtection ? 'yes' : 'no',
      'Media', m.present ? `${m.type} (${m.family})` : 'none',
      'Capacity', m.present ? fmtBytes(m.capacityBytes) : '—',
      'Filesystem', m.present ? m.fileSystem : '—',
      'State', m.present ? (m.blank ? 'blank' : m.finalized ? 'finalized' : 'appendable') : '—',
      'Label', m.label || '—'
    )
  );
}

// ---- Read / Inspect ----
const readMode: Mode = {
  id: 'read',
  title: 'Read',
  icon: '💿',
  desc: 'Inspect a disc image or build an image from a disc.',
  render() {
    const out = h('div', {});
    const open = async () => {
      const path = await api.chooseImage();
      if (!path) return;
      out.replaceChildren(h('div', { class: 'empty' }, 'Reading image…'));
      try {
        const info = await api.inspectImage(path);
        out.replaceChildren(imageInfoCard(info));
      } catch (err) {
        out.replaceChildren(h('div', { class: 'empty', style: 'color:var(--danger)' }, String(err)));
      }
    };
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Source image'),
        h('p', { class: 'muted' }, 'Open an ISO / BIN-CUE / IMG / NRG file to view its filesystem, capacity and details.'),
        h('button', { class: 'btn', onclick: open }, 'Open image…')
      ),
      out
    );
  }
};

function imageInfoCard(info: ImageInfo): HTMLElement {
  const card = h(
    'div',
    { class: 'card' },
    h('h2', {}, info.formatName),
    h(
      'div',
      { class: 'kv' },
      'File', info.filePath,
      'Format', info.format,
      'Size', `${fmtBytes(info.sizeBytes)} (${info.sizeBytes} bytes)`,
      'Sector size', String(info.sectorSize),
      'Sectors', String(info.sectorCount),
      'Filesystem', info.fileSystem,
      'Label', info.label || '—',
      'Bootable', info.bootable ? 'yes' : 'no'
    )
  );
  if (info.notes?.length) card.append(h('p', { class: 'muted' }, info.notes.join(' · ')));
  if (info.tracks?.length) {
    const list = h('div', { class: 'list' });
    for (const t of info.tracks)
      list.append(h('div', { class: 'list-item' }, h('span', { class: 'grow' }, `Track ${t.number} — ${t.type} ${t.mode ?? ''}`), h('span', { class: 'tag' }, `${t.sectors} sectors`)));
    card.append(h('h2', { style: 'margin-top:14px' }, 'Tracks'), list);
  }
  if (info.entries?.length) {
    const list = h('div', { class: 'list' });
    for (const e of info.entries.slice(0, 200))
      list.append(h('div', { class: 'list-item' }, h('span', { class: 'tag' }, e.isDirectory ? 'DIR' : 'FILE'), h('span', { class: 'grow' }, e.path), h('span', { class: 'mono' }, fmtBytes(e.size))));
    card.append(h('h2', { style: 'margin-top:14px' }, 'Top-level contents'), list);
  }
  if (info.format === 'iso' || info.format === 'img') {
    const checksumOut = h('span', { class: 'mono muted' }, '');
    card.append(
      h(
        'div',
        { class: 'row', style: 'margin-top:12px' },
        h(
          'button',
          {
            class: 'btn secondary',
            onclick: async () => {
              checksumOut.textContent = 'hashing…';
              const r = await api.checksum(info.filePath, ['sha256']);
              checksumOut.textContent = `SHA-256 ${r[0].hex}`;
            }
          },
          'Compute SHA-256'
        ),
        checksumOut
      )
    );
  }
  return card;
}

// ---- Build ----
interface BuildState {
  sources: { sourcePath: string; name: string }[];
}
const buildState: BuildState = { sources: [] };

const buildMode: Mode = {
  id: 'build',
  title: 'Build',
  icon: '🧱',
  desc: 'Create an ISO9660 / Joliet image from files and folders.',
  render() {
    const fileList = h('div', { class: 'list' });
    const sizeOut = h('div', { class: 'muted' }, 'No size calculated yet.');
    const resultOut = h('div', {});

    const renderList = () => {
      fileList.replaceChildren(
        ...(buildState.sources.length
          ? buildState.sources.map((s, i) =>
              h(
                'div',
                { class: 'list-item' },
                h('span', { class: 'grow', title: s.sourcePath }, s.name),
                h('span', { class: 'mono muted' }, s.sourcePath),
                h('button', { class: 'ghost-btn', onclick: () => { buildState.sources.splice(i, 1); renderList(); } }, '✕')
              )
            )
          : [h('div', { class: 'empty' }, 'No files added.')])
      );
    };
    renderList();

    const addPaths = (paths: string[]) => {
      for (const p of paths) {
        const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
        if (!buildState.sources.some((s) => s.sourcePath === p)) buildState.sources.push({ sourcePath: p, name });
      }
      renderList();
    };

    const dropzone = h(
      'div',
      { class: 'dropzone' },
      'Drag files & folders here, or use the buttons below.'
    );
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag');
      const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
      const paths = files.map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
      if (paths.length) addPaths(paths);
    });

    const label = h('input', { type: 'text', value: 'ISO_VOLUME' }) as HTMLInputElement;
    const joliet = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const udf = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const strict = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const bootEnabled = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const bootImage = h('input', { type: 'text', placeholder: '(boot image path)', style: 'flex:1' }) as HTMLInputElement;
    const bootEmul = h('select', {}, ...['none', 'floppy1.44', 'floppy2.88', 'hdd'].map((v) => h('option', { value: v }, v))) as HTMLSelectElement;
    const bootInfo = h('input', { type: 'checkbox' }) as HTMLInputElement;

    const buildSpec = (output: string): BuildSpec => ({
      volumeLabel: label.value || 'ISO_VOLUME',
      sources: [],
      fileSystems: { iso9660: true, joliet: joliet.checked, udf: udf.checked },
      boot: {
        enabled: bootEnabled.checked,
        bootImagePath: bootImage.value || undefined,
        emulation: bootEmul.value as BuildSpec['boot']['emulation'],
        bootInfoTable: bootInfo.checked
      },
      outputPath: output,
      strictIso9660: strict.checked
    });

    const pickBootImage = async () => {
      const files = await api.chooseFiles();
      if (files[0]) bootImage.value = files[0];
    };

    // Folder scanning needs the filesystem, which lives in main; ask it to
    // expand the chosen top-level paths into a full source-node list.
    const buildNodes = async (): Promise<BuildSpec['sources']> => {
      const { nodes } = await api.scanSources(buildState.sources.map((s) => s.sourcePath));
      return nodes;
    };

    const calcSize = async () => {
      if (!buildState.sources.length) return statusReplace(sizeOut, 'Add files first.', 'error');
      sizeOut.textContent = 'Calculating…';
      const spec = { ...buildSpec(''), sources: await buildNodes() };
      const size = await api.buildSize(spec);
      statusReplace(sizeOut, `Estimated image size: ${fmtBytes(size.sizeBytes)} (${size.sectorCount} sectors)`, 'ok');
    };

    const doBuild = async () => {
      if (!buildState.sources.length) return statusReplace(resultOut, 'Add files first.', 'error');
      const output = await api.chooseSave(`${label.value || 'image'}.iso`);
      if (!output) return;
      resetProgress();
      resultOut.replaceChildren(h('div', { class: 'empty' }, 'Building…'));
      try {
        const spec = { ...buildSpec(output), sources: await buildNodes() };
        const result = await api.buildIso(spec);
        resultOut.replaceChildren(
          h(
            'div',
            { class: 'card' },
            h('h2', {}, 'Build complete'),
            h('div', { class: 'kv' },
              'Output', result.outputPath,
              'Size', fmtBytes(result.sizeBytes),
              'Filesystem', result.fileSystem,
              'Label', result.volumeLabel,
              'Bootable', result.bootable ? 'yes' : 'no',
              'Duration', `${result.durationMs} ms`)
          )
        );
      } catch (err) {
        resultOut.replaceChildren(h('div', { class: 'empty', style: 'color:var(--danger)' }, String(err)));
      }
    };

    return h(
      'div',
      {},
      h('div', { class: 'card' }, h('h2', {}, 'Source files'), dropzone,
        h('div', { class: 'row', style: 'margin:12px 0' },
          h('button', { class: 'btn secondary', onclick: async () => addPaths(await api.chooseFiles()) }, '+ Add files'),
          h('button', { class: 'btn secondary', onclick: async () => { const d = await api.chooseFolder(); if (d) addPaths([d]); } }, '+ Add folder'),
          h('button', { class: 'ghost-btn', onclick: () => { buildState.sources = []; renderList(); } }, 'Clear')),
        fileList),
      h('div', { class: 'card' }, h('h2', {}, 'Image options'),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, 'Volume label', label),
          h('div', { class: 'row', style: 'align-items:flex-end;gap:18px' },
            h('label', { class: 'check' }, joliet, 'Joliet'),
            h('label', { class: 'check' }, udf, 'UDF'),
            h('label', { class: 'check' }, strict, 'Strict 8.3'))),
        h('div', { style: 'margin-top:12px' },
          h('label', { class: 'check' }, bootEnabled, 'Bootable (El Torito)'),
          h('div', { class: 'row', style: 'margin-top:8px' }, bootImage,
            h('button', { class: 'ghost-btn', onclick: pickBootImage }, 'Browse'),
            bootEmul, h('label', { class: 'check' }, bootInfo, 'Boot info table')))),
      h('div', { class: 'card' },
        h('div', { class: 'row spread' },
          h('div', { class: 'row' },
            h('button', { class: 'btn secondary', onclick: calcSize }, 'Calculate size'),
            h('button', { class: 'btn', onclick: doBuild }, 'Build ISO…')),
          sizeOut),
        resultOut)
    );
  }
};

function statusReplace(el: HTMLElement, msg: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'error' ? 'var(--danger)' : 'var(--text-dim)';
  el.replaceChildren(h('span', { style: `color:${color}` }, msg));
}

// ---- Write / Burn ----
const writeMode: Mode = {
  id: 'write',
  title: 'Write',
  icon: '🔥',
  desc: 'Burn an image to disc (with simulation, verify and buffer-underrun protection).',
  render() {
    let imagePath = '';
    let drives: DriveInfo[] = [];
    let lastJobId = '';
    const imageLabel = h('span', { class: 'mono muted' }, 'No image selected');
    const driveSelect = h('select', {}) as HTMLSelectElement;
    const speedSelect = h('select', {}) as HTMLSelectElement;
    const testMode = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const verifyChk = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const finalizeChk = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const eraseChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const bupChk = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    const result = h('div', {});

    const refreshSpeeds = () => {
      const drive = drives.find((d) => d.id === driveSelect.value);
      const speeds = drive?.media.writeSpeeds ?? [{ multiplier: 0, kbps: 0, label: 'MAX (auto)' }];
      speedSelect.replaceChildren(...speeds.map((s) => h('option', { value: String(s.kbps) }, s.label)));
    };
    const loadDrives = async () => {
      drives = await api.listDrives(true);
      driveSelect.replaceChildren(...drives.map((d) => h('option', { value: d.id }, `${d.vendor} ${d.model}${d.simulated ? ' (sim)' : ''}`)));
      refreshSpeeds();
    };
    driveSelect.addEventListener('change', refreshSpeeds);
    void loadDrives();

    const pickImage = async () => {
      const p = await api.chooseImage();
      if (!p) return;
      imagePath = p;
      imageLabel.textContent = p;
    };

    const burn = async () => {
      if (!imagePath) return statusReplace(result, 'Select an image first.', 'error');
      if (!driveSelect.value) return statusReplace(result, 'Select a drive first.', 'error');
      resetProgress();
      result.replaceChildren(h('div', { class: 'empty' }, 'Burning…'));
      const req: BurnRequest = {
        imagePath,
        driveId: driveSelect.value,
        options: {
          speedKbps: parseInt(speedSelect.value || '0', 10),
          testMode: testMode.checked,
          verify: verifyChk.checked,
          finalize: finalizeChk.checked,
          eraseFirst: eraseChk.checked,
          eraseMode: 'quick',
          retries: 3,
          bufferUnderrunProtection: bupChk.checked,
          layerBreak: 0
        }
      };
      try {
        const res = await api.burn(req);
        lastJobId = res.jobId;
        const kind = res.ok ? 'ok' : 'error';
        const lines = [
          `${res.ok ? 'Burn succeeded' : 'Burn failed'}${res.simulated ? ' (simulation)' : ''}`,
          res.error ? `Error: ${res.error}` : '',
          res.verify ? `Verification: ${res.verify.ok ? 'PASSED' : 'FAILED'}` : ''
        ].filter(Boolean);
        result.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Result'), ...lines.map((l) => h('div', { class: 'muted', style: `color:${kind === 'ok' ? 'var(--ok)' : 'var(--danger)'}` }, l)),
          res.verify ? h('pre', { class: 'report' }, res.verify.report) : null));
      } catch (err) {
        statusReplace(result, String(err), 'error');
      }
    };

    return h(
      'div',
      {},
      h('div', { class: 'card' }, h('h2', {}, 'Image to burn'),
        h('div', { class: 'row' }, h('button', { class: 'btn secondary', onclick: pickImage }, 'Open image…'), imageLabel)),
      h('div', { class: 'card' }, h('h2', {}, 'Destination & options'),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, 'Drive', driveSelect),
          h('label', { class: 'field' }, 'Write speed', speedSelect)),
        h('div', { class: 'row', style: 'gap:18px;margin-top:12px' },
          h('label', { class: 'check' }, testMode, 'Test mode (simulate)'),
          h('label', { class: 'check' }, verifyChk, 'Verify after burn'),
          h('label', { class: 'check' }, finalizeChk, 'Finalize disc'),
          h('label', { class: 'check' }, eraseChk, 'Erase first (RW)'),
          h('label', { class: 'check' }, bupChk, 'Buffer-underrun protection'))),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: burn }, '🔥 Burn'),
          h('button', { class: 'btn danger', onclick: () => lastJobId && api.cancelBurn(lastJobId) }, 'Cancel')),
        result)
    );
  }
};

// ---- Verify ----
const verifyMode: Mode = {
  id: 'verify',
  title: 'Verify',
  icon: '✅',
  desc: 'Compare a source image against a target, or hash a single file.',
  render() {
    let source = '';
    let target = '';
    const srcLabel = h('span', { class: 'mono muted' }, 'none');
    const tgtLabel = h('span', { class: 'mono muted' }, 'none');
    const algos: Record<HashAlgorithm, HTMLInputElement> = {
      crc32: h('input', { type: 'checkbox' }) as HTMLInputElement,
      md5: h('input', { type: 'checkbox', checked: true }) as HTMLInputElement,
      sha1: h('input', { type: 'checkbox' }) as HTMLInputElement,
      sha256: h('input', { type: 'checkbox', checked: true }) as HTMLInputElement
    };
    const report = h('div', {});

    const runVerify = async () => {
      if (!source || !target) return statusReplace(report, 'Choose both source and target.', 'error');
      const algorithms = (Object.keys(algos) as HashAlgorithm[]).filter((a) => algos[a].checked);
      resetProgress();
      report.replaceChildren(h('div', { class: 'empty' }, 'Verifying…'));
      try {
        const res = await api.verify({ sourcePath: source, targetPath: target, sectorSize: 2048, algorithms });
        report.replaceChildren(h('pre', { class: 'report', style: `border-color:${res.ok ? 'var(--ok)' : 'var(--danger)'}` }, res.report));
      } catch (err) {
        statusReplace(report, String(err), 'error');
      }
    };

    return h(
      'div',
      {},
      h('div', { class: 'card' }, h('h2', {}, 'Compare source vs target'),
        h('div', { class: 'row' }, h('button', { class: 'btn secondary', onclick: async () => { const p = await api.chooseImage(); if (p) { source = p; srcLabel.textContent = p; } } }, 'Source…'), srcLabel),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn secondary', onclick: async () => { const p = await api.chooseImage(); if (p) { target = p; tgtLabel.textContent = p; } } }, 'Target…'), tgtLabel),
        h('div', { class: 'row', style: 'gap:16px;margin-top:12px' },
          h('label', { class: 'check' }, algos.crc32, 'CRC32'),
          h('label', { class: 'check' }, algos.md5, 'MD5'),
          h('label', { class: 'check' }, algos.sha1, 'SHA-1'),
          h('label', { class: 'check' }, algos.sha256, 'SHA-256')),
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: runVerify }, 'Verify'))),
      h('div', { class: 'card' }, report)
    );
  }
};

// ---- Test ----
const testMode2: Mode = {
  id: 'test',
  title: 'Test',
  icon: '🧪',
  desc: 'Sequential read test, surface scan and media-quality assessment.',
  render() {
    const out = h('div', {});
    const run = async () => {
      const path = await api.chooseImage();
      if (!path) return;
      resetProgress();
      out.replaceChildren(h('div', { class: 'empty' }, 'Running read test…'));
      try {
        const report: DiagnosticsReport = await api.readTest(path);
        const scan = h('div', { class: 'scan' });
        for (const b of report.blocks.slice(0, 600)) scan.append(h('span', { class: b.status === 'ok' ? '' : b.status }));
        out.replaceChildren(
          h('div', { class: 'card' }, h('h2', {}, 'Diagnostics report'), h('pre', { class: 'report' }, report.summary),
            h('h2', { style: 'margin-top:12px' }, 'Surface scan'), scan)
        );
      } catch (err) {
        statusReplace(out, String(err), 'error');
      }
    };
    return h('div', {},
      h('div', { class: 'card' }, h('h2', {}, 'Read performance & surface scan'),
        h('p', { class: 'muted' }, 'Reads the whole image/device, measuring throughput and flagging slow or unreadable regions.'),
        h('button', { class: 'btn', onclick: run }, 'Choose target & run test')),
      out);
  }
};

// --------------------------------------------------------------------------
// App shell
// --------------------------------------------------------------------------
const modes: Mode[] = [discoveryMode, readMode, buildMode, writeMode, verifyMode, testMode2];
let activeMode = modes[0];

function selectMode(mode: Mode): void {
  activeMode = mode;
  $('#mode-title').textContent = mode.title;
  $('#mode-desc').textContent = mode.desc;
  $('#content').replaceChildren(mode.render());
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode.id));
  resetProgress();
}

function buildSidebar(): void {
  const nav = $('#modes');
  nav.replaceChildren(
    ...modes.map((m) => {
      const btn = h('button', { class: 'mode-btn', 'data-mode': m.id, onclick: () => selectMode(m) }, h('span', { class: 'ico' }, m.icon), m.title);
      return btn;
    })
  );
}

function initTheme(): void {
  const saved = localStorage.getItem('isomaker-theme') || 'dark';
  document.body.dataset.theme = saved;
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    localStorage.setItem('isomaker-theme', next);
    drawGraph();
  });
}

async function init(): Promise<void> {
  buildSidebar();
  initTheme();
  resetProgress();
  selectMode(modes[0]);

  api.onProgress(applyProgress);
  api.onLog(appendLog);
  $('#clear-log').addEventListener('click', () => $('#log-list').replaceChildren());

  try {
    const info = await api.appInfo();
    $('#app-version').textContent = `v${info.version} · ${info.platform}/${info.arch}`;
  } catch {
    /* ignore */
  }
}

window.addEventListener('DOMContentLoaded', init);
