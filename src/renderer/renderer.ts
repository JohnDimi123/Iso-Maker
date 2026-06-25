/**
 * Iso Maker renderer.
 *
 * An ImgBurn-style, dependency-free UI: a classic menu bar + a "What would you
 * like to do?" launcher of mode tiles, each talking to the engines through the
 * typed `window.isoMaker` bridge.
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
// Settings (persisted to localStorage; modes read their defaults from here)
// --------------------------------------------------------------------------
interface Settings {
  theme: 'light' | 'dark';
  showLog: boolean;
  defaultLabel: string;
  joliet: boolean;
  udf: boolean;
  verify: boolean;
  finalize: boolean;
  bup: boolean;
}
const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  showLog: true,
  defaultLabel: 'ISO_VOLUME',
  joliet: true,
  udf: false,
  verify: true,
  finalize: true,
  bup: true
};
function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('isomaker-settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
const settings = loadSettings();
function applySettings(): void {
  document.body.dataset.theme = settings.theme;
  $('#console').style.display = settings.showLog ? '' : 'none';
  drawGraph();
}
function saveSettings(): void {
  localStorage.setItem('isomaker-settings', JSON.stringify(settings));
  applySettings();
}

let appVersion = '';
let appPlatform = '';

// --------------------------------------------------------------------------
// Progress + speed graph
// --------------------------------------------------------------------------
const speedSamples: number[] = [];
function drawGraph(): void {
  const canvas = $('#speed-graph') as HTMLCanvasElement;
  const ctx = canvas?.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (speedSamples.length < 2) return;
  const max = Math.max(...speedSamples, 1);
  const style = getComputedStyle(document.body);
  ctx.strokeStyle = style.getPropertyValue('--accent') || '#2f6fe0';
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

function statusReplace(el: HTMLElement, msg: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const color = kind === 'ok' ? 'var(--ok)' : kind === 'error' ? 'var(--danger)' : 'var(--text-dim)';
  el.replaceChildren(h('span', { style: `color:${color}` }, msg));
}

// --------------------------------------------------------------------------
// Shared drive/speed controls
// --------------------------------------------------------------------------
function driveControls() {
  let drives: DriveInfo[] = [];
  const driveSelect = h('select', { style: 'flex:1;min-width:0' }) as HTMLSelectElement;
  const speedSelect = h('select', {}) as HTMLSelectElement;
  const refreshSpeeds = () => {
    const drive = drives.find((d) => d.id === driveSelect.value);
    const speeds = drive?.media.writeSpeeds ?? [{ multiplier: 0, kbps: 0, label: 'MAX (auto)' }];
    speedSelect.replaceChildren(...speeds.map((s) => h('option', { value: String(s.kbps) }, s.label)));
  };
  const load = async () => {
    const sel = driveSelect.value;
    drives = await api.listDrives(true);
    driveSelect.replaceChildren(
      ...drives.map((d) => {
        const m = d.media;
        const state = m.present
          ? `${m.type}${m.blank ? ', blank' : m.finalized ? ', finalized' : ''} · ${fmtBytes(m.capacityBytes)}`
          : 'no media';
        return h('option', { value: d.id }, `${d.vendor} ${d.model}${d.simulated ? ' (sim)' : ''} — ${state}`);
      })
    );
    if (sel && drives.some((d) => d.id === sel)) driveSelect.value = sel;
    refreshSpeeds();
  };
  const refreshBtn = h('button', { class: 'ghost-btn', title: 'Re-scan drives & inserted media', onclick: () => void load() }, '↻');
  // Field that pairs the drive selector with its refresh button.
  const driveField = h('label', { class: 'field' }, 'Drive', h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, driveSelect, refreshBtn));
  driveSelect.addEventListener('change', refreshSpeeds);
  void load();
  return { driveSelect, speedSelect, refreshBtn, driveField, getDrives: () => drives };
}

// --------------------------------------------------------------------------
// Modes
// --------------------------------------------------------------------------
interface Mode {
  id: string;
  title: string;
  render(): HTMLElement;
}

// ---- Discovery ----
const discoveryMode: Mode = {
  id: 'discovery',
  title: 'Discovery',
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
  title: 'Inspect image file',
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

// ---- Source-file picker (shared by Build + Write files/folders) ----
function sourcePicker() {
  const sources: { sourcePath: string; name: string }[] = [];
  const fileList = h('div', { class: 'list' });
  const renderList = () => {
    fileList.replaceChildren(
      ...(sources.length
        ? sources.map((s, i) =>
            h(
              'div',
              { class: 'list-item' },
              h('span', { class: 'grow', title: s.sourcePath }, s.name),
              h('span', { class: 'mono muted' }, s.sourcePath),
              h('button', { class: 'ghost-btn', onclick: () => { sources.splice(i, 1); renderList(); } }, '✕')
            )
          )
        : [h('div', { class: 'empty' }, 'No files added.')])
    );
  };
  const addPaths = (paths: string[]) => {
    for (const p of paths) {
      const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
      if (!sources.some((s) => s.sourcePath === p)) sources.push({ sourcePath: p, name });
    }
    renderList();
  };
  renderList();

  const dropzone = h('div', { class: 'dropzone' }, 'Drag files & folders here, or use the buttons below.');
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    const paths = files.map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
    if (paths.length) addPaths(paths);
  });

  const node = h(
    'div',
    { class: 'card' },
    h('h2', {}, 'Source files'),
    dropzone,
    h(
      'div',
      { class: 'row', style: 'margin:12px 0' },
      h('button', { class: 'btn secondary', onclick: async () => addPaths(await api.chooseFiles()) }, '+ Add files'),
      h('button', { class: 'btn secondary', onclick: async () => { const d = await api.chooseFolder(); if (d) addPaths([d]); } }, '+ Add folder'),
      h('button', { class: 'ghost-btn', onclick: () => { sources.length = 0; renderList(); } }, 'Clear')
    ),
    fileList
  );
  return { node, sources, scan: () => api.scanSources(sources.map((s) => s.sourcePath)) };
}

// ---- Build (Create image file from files/folders) ----
const buildMode: Mode = {
  id: 'build',
  title: 'Create image file from files/folders',
  render() {
    const picker = sourcePicker();
    const sizeOut = h('div', { class: 'muted' }, 'No size calculated yet.');
    const resultOut = h('div', {});

    const label = h('input', { type: 'text', value: settings.defaultLabel }) as HTMLInputElement;
    const joliet = h('input', { type: 'checkbox', checked: settings.joliet }) as HTMLInputElement;
    const udf = h('input', { type: 'checkbox', checked: settings.udf }) as HTMLInputElement;
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

    const calcSize = async () => {
      if (!picker.sources.length) return statusReplace(sizeOut, 'Add files first.', 'error');
      sizeOut.textContent = 'Calculating…';
      const { nodes } = await picker.scan();
      const size = await api.buildSize({ ...buildSpec(''), sources: nodes });
      statusReplace(sizeOut, `Estimated image size: ${fmtBytes(size.sizeBytes)} (${size.sectorCount} sectors)`, 'ok');
    };

    const doBuild = async () => {
      if (!picker.sources.length) return statusReplace(resultOut, 'Add files first.', 'error');
      const output = await api.chooseSave(`${label.value || 'image'}.iso`);
      if (!output) return;
      resetProgress();
      resultOut.replaceChildren(h('div', { class: 'empty' }, 'Building…'));
      try {
        const { nodes } = await picker.scan();
        const result = await api.buildIso({ ...buildSpec(output), sources: nodes });
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
      picker.node,
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
            h('button', { class: 'ghost-btn', onclick: async () => { const f = await api.chooseFiles(); if (f[0]) bootImage.value = f[0]; } }, 'Browse'),
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

// ---- Write image file to disc ----
const writeMode: Mode = {
  id: 'write',
  title: 'Write image file to disc',
  render() {
    let imagePath = '';
    let lastJobId = '';
    const imageLabel = h('span', { class: 'mono muted' }, 'No image selected');
    const { driveSelect, speedSelect, driveField } = driveControls();
    const testMode = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const verifyChk = h('input', { type: 'checkbox', checked: settings.verify }) as HTMLInputElement;
    const finalizeChk = h('input', { type: 'checkbox', checked: settings.finalize }) as HTMLInputElement;
    const eraseChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const bupChk = h('input', { type: 'checkbox', checked: settings.bup }) as HTMLInputElement;
    const result = h('div', {});

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
          `${res.ok ? 'Burn succeeded' : 'Burn failed'}${res.simulated ? ' (simulation — no physical drive)' : ''}`,
          res.error ? `Error: ${res.error}` : '',
          res.verify ? `Verification: ${res.verify.ok ? 'PASSED' : 'FAILED'}` : ''
        ].filter(Boolean);
        result.replaceChildren(
          h('div', { class: 'card' }, h('h2', {}, 'Result'),
            ...lines.map((l) => h('div', { class: 'muted', style: `color:${kind === 'ok' ? 'var(--ok)' : 'var(--danger)'}` }, l)),
            res.verify ? h('pre', { class: 'report' }, res.verify.report) : null)
        );
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
          driveField,
          h('label', { class: 'field' }, 'Write speed', speedSelect)),
        h('div', { class: 'row', style: 'gap:18px;margin-top:12px' },
          h('label', { class: 'check' }, testMode, 'Test mode (simulate)'),
          h('label', { class: 'check' }, verifyChk, 'Verify after burn'),
          h('label', { class: 'check' }, finalizeChk, 'Finalize disc'),
          h('label', { class: 'check' }, eraseChk, 'Erase first (RW)'),
          h('label', { class: 'check' }, bupChk, 'Buffer-underrun protection'))),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: burn }, '🔥 Write'),
          h('button', { class: 'btn danger', onclick: () => lastJobId && api.cancelBurn(lastJobId) }, 'Cancel')),
        result)
    );
  }
};

// ---- Write files/folders to disc (build → burn in one step) ----
const writeFilesMode: Mode = {
  id: 'writefiles',
  title: 'Write files/folders to disc',
  render() {
    const picker = sourcePicker();
    const { driveSelect, speedSelect, driveField } = driveControls();
    const label = h('input', { type: 'text', value: settings.defaultLabel }) as HTMLInputElement;
    const joliet = h('input', { type: 'checkbox', checked: settings.joliet }) as HTMLInputElement;
    const verifyChk = h('input', { type: 'checkbox', checked: settings.verify }) as HTMLInputElement;
    const finalizeChk = h('input', { type: 'checkbox', checked: settings.finalize }) as HTMLInputElement;
    const keepImage = h('input', { type: 'checkbox' }) as HTMLInputElement;
    let lastJobId = '';
    const result = h('div', {});

    const go = async () => {
      if (!picker.sources.length) return statusReplace(result, 'Add files first.', 'error');
      if (!driveSelect.value) return statusReplace(result, 'Select a drive first.', 'error');
      const output = await api.chooseSave(`${label.value || 'image'}.iso`);
      if (!output) return;
      resetProgress();
      result.replaceChildren(h('div', { class: 'empty' }, 'Building image…'));
      try {
        const { nodes } = await picker.scan();
        const built = await api.buildIso({
          volumeLabel: label.value || 'ISO_VOLUME',
          sources: nodes,
          fileSystems: { iso9660: true, joliet: joliet.checked, udf: false },
          boot: { enabled: false, emulation: 'none', bootInfoTable: false },
          outputPath: output,
          strictIso9660: false
        });
        result.replaceChildren(h('div', { class: 'empty' }, `Image built (${fmtBytes(built.sizeBytes)}). Burning…`));
        const res = await api.burn({
          imagePath: built.outputPath,
          driveId: driveSelect.value,
          options: {
            speedKbps: parseInt(speedSelect.value || '0', 10),
            testMode: false,
            verify: verifyChk.checked,
            finalize: finalizeChk.checked,
            eraseFirst: false,
            eraseMode: 'quick',
            retries: 3,
            bufferUnderrunProtection: settings.bup,
            layerBreak: 0
          }
        });
        lastJobId = res.jobId;
        const ok = res.ok;
        result.replaceChildren(
          h('div', { class: 'card' }, h('h2', {}, 'Result'),
            h('div', { style: `color:${ok ? 'var(--ok)' : 'var(--danger)'}` },
              `${ok ? 'Files written to disc' : 'Burn failed'}${res.simulated ? ' (simulation — no physical drive)' : ''}`),
            res.error ? h('div', { style: 'color:var(--danger)' }, res.error) : null,
            res.verify ? h('div', { class: 'muted' }, `Verification: ${res.verify.ok ? 'PASSED' : 'FAILED'}`) : null,
            keepImage.checked ? h('div', { class: 'muted' }, `Image kept at ${built.outputPath}`) : null)
        );
      } catch (err) {
        statusReplace(result, String(err), 'error');
      }
    };

    return h(
      'div',
      {},
      picker.node,
      h('div', { class: 'card' }, h('h2', {}, 'Destination & options'),
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, 'Volume label', label),
          driveField),
        h('div', { class: 'grid-2', style: 'margin-top:12px' },
          h('label', { class: 'field' }, 'Write speed', speedSelect),
          h('div', { class: 'row', style: 'align-items:flex-end;gap:16px' },
            h('label', { class: 'check' }, joliet, 'Joliet'),
            h('label', { class: 'check' }, verifyChk, 'Verify'),
            h('label', { class: 'check' }, finalizeChk, 'Finalize'),
            h('label', { class: 'check' }, keepImage, 'Keep image')))),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: go }, '🔥 Build & Write'),
          h('button', { class: 'btn danger', onclick: () => lastJobId && api.cancelBurn(lastJobId) }, 'Cancel')),
        result)
    );
  }
};

// ---- Create image file from disc (rip) ----
const ripMode: Mode = {
  id: 'rip',
  title: 'Create image file from disc',
  render() {
    const { driveSelect, driveField, getDrives } = driveControls();
    const result = h('div', {});
    const rip = async () => {
      const drive = getDrives().find((d) => d.id === driveSelect.value);
      if (!drive) return statusReplace(result, 'Select a drive first.', 'error');
      if (drive.simulated)
        return statusReplace(result, 'This is a simulated drive. Reading a real disc needs a physical drive with media inserted.', 'error');
      const out = await api.chooseSave(`${drive.media.label || 'disc'}.iso`);
      if (!out) return;
      resetProgress();
      result.replaceChildren(h('div', { class: 'empty' }, 'Reading disc…'));
      try {
        const r = await api.readDiscToImage(drive.id, out);
        result.replaceChildren(
          h('div', { class: 'card' }, h('h2', {}, 'Image created'),
            h('div', { class: 'kv' }, 'Output', out, 'Bytes read', fmtBytes(r.bytesWritten)))
        );
      } catch (err) {
        statusReplace(result, String(err), 'error');
      }
    };
    return h(
      'div',
      {},
      h('div', { class: 'card' }, h('h2', {}, 'Source disc'),
        h('p', { class: 'muted' }, 'Reads the inserted disc sector-by-sector into an .iso image. Requires a physical drive with media.'),
        driveField,
        h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: rip }, 'Read disc to image…')),
        result)
    );
  }
};

// ---- Verify ----
const verifyMode: Mode = {
  id: 'verify',
  title: 'Verify',
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
  title: 'Read test & surface scan',
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

const allModes: Mode[] = [writeMode, writeFilesMode, ripMode, buildMode, verifyMode, discoveryMode, readMode, testMode2];

// --------------------------------------------------------------------------
// Launcher (home)
// --------------------------------------------------------------------------
// Classic-style inline icons (much closer to the ImgBurn look than emoji).
const ICONS: Record<string, string> = {
  doc: `<svg width="36" height="36" viewBox="0 0 36 36"><path d="M7 2.5h14.5L29 10v23.5H7z" fill="#fff" stroke="#8a8a76"/><path d="M21.5 2.5V10H29" fill="#e6e6d8" stroke="#8a8a76"/><g stroke="#9fb0c2" stroke-width="1.4"><path d="M11 16h14M11 20h14M11 24h10"/></g></svg>`,
  folder: `<svg width="36" height="36" viewBox="0 0 36 36"><path d="M3 8h11l3 3.5h16V30H3z" fill="#e7a93a" stroke="#a9781f"/><path d="M3 13.5h30V30H3z" fill="#ffd25e" stroke="#a9781f"/></svg>`,
  disc: `<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.5" fill="#c9ced6" stroke="#828892"/><circle cx="18" cy="18" r="14.5" fill="none" stroke="#eef2f6"/><path d="M9 9a13 13 0 0 1 13-3" fill="none" stroke="#fff" stroke-width="2" opacity=".7"/><circle cx="18" cy="18" r="4.3" fill="#fff" stroke="#828892"/><circle cx="18" cy="18" r="1.5" fill="#c9ced6"/></svg>`,
  mag: `<svg width="36" height="36" viewBox="0 0 36 36"><circle cx="15" cy="15" r="9.5" fill="#dcefff" stroke="#34679c" stroke-width="2.2"/><circle cx="15" cy="15" r="5.5" fill="#bfe0ff" opacity=".6"/><line x1="22" y1="22" x2="32" y2="32" stroke="#34679c" stroke-width="3.4" stroke-linecap="round"/></svg>`,
  drive: `<svg width="36" height="36" viewBox="0 0 36 36"><rect x="3" y="9" width="30" height="17" rx="2" fill="#d9d9cc" stroke="#85857247"/><rect x="3" y="9" width="30" height="17" rx="2" fill="none" stroke="#85857a"/><rect x="6" y="13" width="15" height="3.4" rx="1" fill="#fff" stroke="#b6b6a6"/><circle cx="27.5" cy="17.5" r="2.4" fill="#79a544"/></svg>`,
  arrow: `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 9h10V4.5L20 11l-8 6.5V13H2z" fill="#2f6fd6" stroke="#1c4f9c"/></svg>`
};
function ico(kind: string): HTMLElement {
  if (kind === 'discBurn') return h('img', { src: 'icon.png', class: 'ic ic-disc', width: '36', height: '36', alt: '' });
  return h('span', { class: 'ic', html: ICONS[kind] ?? '' });
}

interface Tile {
  src: string;
  tgt?: string;
  title: string;
  view: string;
}
const TILES: Tile[] = [
  { src: 'doc', tgt: 'discBurn', title: 'Write image file to disc', view: 'write' },
  { src: 'folder', tgt: 'discBurn', title: 'Write files/folders to disc', view: 'writefiles' },
  { src: 'disc', tgt: 'doc', title: 'Create image file from disc', view: 'rip' },
  { src: 'folder', tgt: 'doc', title: 'Create image file from files/folders', view: 'build' },
  { src: 'mag', tgt: 'disc', title: 'Verify disc', view: 'verify' },
  { src: 'drive', title: 'Discovery', view: 'discovery' }
];

function renderHome(): HTMLElement {
  const grid = h('div', { id: 'launcher' });
  for (const t of TILES) {
    grid.append(
      h(
        'div',
        { class: 'tile', onclick: () => showView(t.view) },
        h('div', { class: 'tile-ico' }, ico(t.src), t.tgt ? ico('arrow') : null, t.tgt ? ico(t.tgt) : null),
        h('div', { class: 'tile-text' }, t.title)
      )
    );
  }
  return h('div', { class: 'home' }, h('div', { class: 'launcher-head' }, 'What would you like to do?'), grid);
}

// --------------------------------------------------------------------------
// Routing + breadcrumb
// --------------------------------------------------------------------------
function setBreadcrumb(title: string | null): void {
  const bc = $('#breadcrumb');
  if (!title) {
    bc.replaceChildren();
    bc.style.display = 'none';
    return;
  }
  bc.style.display = '';
  bc.replaceChildren(
    h('a', { onclick: showHome }, '⌂ Home'),
    h('span', {}, '▸'),
    h('span', { class: 'crumb-title' }, title)
  );
}

function showHome(): void {
  setBreadcrumb(null);
  $('#content').replaceChildren(renderHome());
  resetProgress();
  closeMenus();
}

function showView(id: string): void {
  const m = allModes.find((x) => x.id === id);
  if (!m) return showHome();
  setBreadcrumb(m.title);
  $('#content').replaceChildren(m.render());
  resetProgress();
  closeMenus();
}

// --------------------------------------------------------------------------
// Menu bar
// --------------------------------------------------------------------------
type Entry = 'sep' | { label: string; hint?: string; action: () => void };

function closeMenus(): void {
  document.querySelectorAll('.menu-dropdown').forEach((d) => ((d as HTMLElement).hidden = true));
  document.querySelectorAll('.menu-item.open').forEach((i) => i.classList.remove('open'));
}

function menuItem(label: string, entries: Entry[]): HTMLElement {
  const dd = h('div', { class: 'menu-dropdown' });
  dd.hidden = true;
  for (const e of entries) {
    if (e === 'sep') {
      dd.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    dd.append(
      h('div', { class: 'menu-entry', onclick: () => { closeMenus(); e.action(); } },
        h('span', {}, e.label),
        e.hint ? h('span', { class: 'hint' }, e.hint) : null)
    );
  }
  const item = h('div', { class: 'menu-item' }, label, dd);
  item.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const wasOpen = !dd.hidden;
    closeMenus();
    if (!wasOpen) {
      item.classList.add('open');
      dd.hidden = false;
      dd.style.left = `${item.offsetLeft}px`;
    }
  });
  return item;
}

function buildMenubar(): void {
  const modeEntry = (id: string): Entry => {
    const m = allModes.find((x) => x.id === id)!;
    return { label: m.title, action: () => showView(id) };
  };
  const bar = $('#menubar');
  bar.replaceChildren(
    menuItem('File', [
      { label: 'Home', action: showHome },
      'sep',
      { label: 'Exit', action: () => window.close() }
    ]),
    menuItem('View', [
      { label: 'Toggle log window', action: () => { settings.showLog = !settings.showLog; saveSettings(); } },
      { label: 'Toggle light / dark theme', action: () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; saveSettings(); } }
    ]),
    menuItem('Mode', [
      { label: 'Home', action: showHome },
      'sep',
      modeEntry('write'),
      modeEntry('writefiles'),
      modeEntry('rip'),
      modeEntry('build'),
      modeEntry('verify'),
      modeEntry('read'),
      modeEntry('test'),
      modeEntry('discovery')
    ]),
    menuItem('Tools', [
      { label: 'Settings…', action: openSettings },
      { label: 'Discovery (drives)…', action: () => showView('discovery') }
    ]),
    menuItem('Help', [{ label: 'About Iso Maker…', action: openAbout }])
  );
}

// --------------------------------------------------------------------------
// Modal dialogs (Settings / About)
// --------------------------------------------------------------------------
function openModal(node: HTMLElement): void {
  $('#modal').replaceChildren(node);
  $('#modal-overlay').hidden = false;
}
function closeModal(): void {
  $('#modal-overlay').hidden = true;
  $('#modal').replaceChildren();
}
function dialog(title: string, body: HTMLElement, foot: HTMLElement[]): HTMLElement {
  return h(
    'div',
    {},
    h('div', { class: 'dialog-title' }, h('span', {}, title), h('span', { class: 'x', onclick: closeModal }, '✕')),
    h('div', { class: 'dialog-body' }, body),
    h('div', { class: 'dialog-foot' }, ...foot)
  );
}

function openSettings(): void {
  const theme = h('select', {}, ...['light', 'dark'].map((v) => h('option', { value: v, ...(settings.theme === v ? { selected: 'selected' } : {}) }, v))) as HTMLSelectElement;
  const showLog = h('input', { type: 'checkbox', checked: settings.showLog }) as HTMLInputElement;
  const defLabel = h('input', { type: 'text', value: settings.defaultLabel }) as HTMLInputElement;
  const joliet = h('input', { type: 'checkbox', checked: settings.joliet }) as HTMLInputElement;
  const udf = h('input', { type: 'checkbox', checked: settings.udf }) as HTMLInputElement;
  const verify = h('input', { type: 'checkbox', checked: settings.verify }) as HTMLInputElement;
  const finalize = h('input', { type: 'checkbox', checked: settings.finalize }) as HTMLInputElement;
  const bup = h('input', { type: 'checkbox', checked: settings.bup }) as HTMLInputElement;

  const pages: Record<string, HTMLElement> = {
    General: h('div', { class: 'tabpage' },
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, 'Theme', theme),
        h('label', { class: 'check', style: 'align-self:flex-end' }, showLog, 'Show log window'))),
    Build: h('div', { class: 'tabpage' },
      h('label', { class: 'field' }, 'Default volume label', defLabel),
      h('div', { class: 'row', style: 'gap:18px;margin-top:12px' },
        h('label', { class: 'check' }, joliet, 'Joliet by default'),
        h('label', { class: 'check' }, udf, 'UDF by default'))),
    Write: h('div', { class: 'tabpage' },
      h('div', { class: 'row', style: 'gap:18px' },
        h('label', { class: 'check' }, verify, 'Verify after burn'),
        h('label', { class: 'check' }, finalize, 'Finalize disc'),
        h('label', { class: 'check' }, bup, 'Buffer-underrun protection')))
  };
  const tabsRow = h('div', { class: 'tabs' });
  const pageHost = h('div', {});
  Object.keys(pages).forEach((name, i) => {
    const tab = h('div', { class: `tab${i === 0 ? ' active' : ''}`, onclick: () => {
      tabsRow.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      pageHost.replaceChildren(pages[name]);
    } }, name);
    tabsRow.append(tab);
    if (i === 0) pageHost.replaceChildren(pages[name]);
  });

  const save = () => {
    settings.theme = theme.value as Settings['theme'];
    settings.showLog = showLog.checked;
    settings.defaultLabel = defLabel.value || 'ISO_VOLUME';
    settings.joliet = joliet.checked;
    settings.udf = udf.checked;
    settings.verify = verify.checked;
    settings.finalize = finalize.checked;
    settings.bup = bup.checked;
    saveSettings();
    closeModal();
  };
  openModal(dialog('Settings', h('div', {}, tabsRow, pageHost), [
    h('button', { class: 'btn secondary', onclick: closeModal }, 'Cancel'),
    h('button', { class: 'btn', onclick: save }, 'OK')
  ]));
}

function openAbout(): void {
  openModal(
    dialog(
      'About Iso Maker',
      h('div', { class: 'about' },
        h('img', { src: 'icon.png', alt: '' }),
        h('div', {},
          h('div', { style: 'font-size:16px;font-weight:700' }, 'Iso Maker'),
          h('div', { class: 'muted' }, appVersion ? `Version ${appVersion} · ${appPlatform}` : ''),
          h('p', { style: 'margin:10px 0 0' }, 'A modern, ImgBurn-style optical disc imaging, burning, verification and diagnostics suite.'),
          h('p', { class: 'muted', style: 'margin:8px 0 0' }, 'Imaging & verification are fully functional. Physical burning uses the platform burn adapter (IMAPI2 on Windows; growisofs/wodim on Linux) when a real drive is present, and otherwise simulates.'))),
      [h('button', { class: 'btn', onclick: closeModal }, 'Close')]
    )
  );
}

// --------------------------------------------------------------------------
// Init
// --------------------------------------------------------------------------
async function init(): Promise<void> {
  applySettings();
  buildMenubar();
  showHome();

  api.onProgress(applyProgress);
  api.onLog(appendLog);
  $('#clear-log').addEventListener('click', () => $('#log-list').replaceChildren());
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#menubar')) closeMenus();
  });
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeMenus();
    }
  });

  try {
    const info = await api.appInfo();
    appVersion = info.version;
    appPlatform = `${info.platform}/${info.arch}`;
    $('#status-text').textContent = `Ready — Iso Maker ${info.version} (${appPlatform})`;
  } catch {
    /* ignore */
  }
}

window.addEventListener('DOMContentLoaded', init);
