# Iso Maker

A modern, open-source, **ImgBurn-style** optical-disc imaging, burning, verification and
diagnostics suite. Iso Maker pairs a clean, mode-based desktop UI (Electron + TypeScript)
with a modular engine architecture and a full-featured command-line interface for
automation and batch processing.

> **Honest status.** Image building, inspection, verification, extraction, conversion,
> diagnostics, discovery, the CLI and the UI are **fully real** and tested (the ISO builder
> is cross-checked against `pycdlib` in CI). **Physical burning is implemented** through
> platform adapters — **IMAPI2** on Windows (the subsystem the Windows shell itself uses)
> and **growisofs/wodim** on Linux — registered automatically for real drives. Because CI
> has no optical hardware, those burn/rip paths are **not exercised by CI and must be
> validated on a real machine**; with no physical drive present the pipeline falls back to a
> clearly-labelled **simulation** so the whole workflow stays usable. See the table below.

---

## Feature status

| Area | Capability | Status |
|------|------------|--------|
| **Build** | Create ISO9660 images from files/folders | ✅ Real |
| | Joliet (long/Unicode names) | ✅ Real |
| | El Torito bootable images (no-emulation / floppy / HDD, boot info table) | ✅ Real |
| | Calculate final image size before building | ✅ Real |
| | Drag-and-drop file selection | ✅ Real (GUI) |
| | Streaming write for very large images (>50 GB) | ✅ Real (1 MiB chunks, bounded memory) |
| | UDF file system | 🟡 Flagged in API; ISO9660+Joliet emitted today |
| **Read / Image mgmt** | Inspect ISO / BIN-CUE / IMG / NRG (label, fs, capacity, tracks) | ✅ Real |
| | List & extract files from ISO/Joliet images | ✅ Real |
| | Convert BIN/IMG → ISO (single data track) | ✅ Real |
| | Create image from disc / rip (sector copy of the device) | 🟢 Implemented; validate on hardware |
| | Pluggable image-format architecture | ✅ Real |
| | Virtual mount | 🟡 Documented; OS-dependent, not bundled |
| **Verify** | CRC32 / MD5 / SHA-1 / SHA-256 hashing | ✅ Real |
| | Sector-by-sector source/target compare | ✅ Real |
| | Detailed verification reports | ✅ Real |
| **Discovery** | Detect optical drives + capabilities + media | ✅ Real (lsblk/sysfs, WMI, drutil) + simulated fallback |
| **Test / Diagnostics** | Sequential read-performance test | ✅ Real (files & readable devices) |
| | Surface scan / slow-region & bad-sector detection | ✅ Real |
| | Detailed troubleshooting logs | ✅ Real |
| **Write / Burn** | Burn an image to a physical disc (Windows IMAPI2 / Linux growisofs/wodim) | 🟢 Implemented; validate on hardware |
| | Build files/folders → image → burn in one step | 🟢 Implemented; validate on hardware |
| | Burn pipeline: erase → write → finalize → verify | ✅ Real (simulated when no physical drive) |
| | Write-speed selection, buffer-underrun model, retries, layer break | ✅ Real / modelled |
| | Job queue & batch processing | ✅ Real |
| **UI** | ImgBurn-style launcher ("What would you like to do?") + classic menu bar | ✅ Real |
| | Custom application icon (burning-disc logo) | ✅ Real |
| | Settings dialog (General / Build / Write), About dialog | ✅ Real |
| | Real-time progress, speed graph, ETA, log console | ✅ Real |
| | Dark / light themes | ✅ Real |
| **CLI** | `build`, `info`, `list`, `extract`, `convert`, `verify`, `checksum`, `test`, `discover`, `burn`, `formats`, `plugin` | ✅ Real |
| **Packaging** | Windows NSIS setup `.exe`, Linux AppImage | ✅ via electron-builder + CI |

The ISO builder is validated against the third-party [`pycdlib`](https://github.com/clalancette/pycdlib)
reader and `file(1)` in CI-style round-trip tests (build → independent read → byte compare).

---

## Architecture

Strict separation of concerns — UI, engines and hardware are independent layers:

```
src/
  shared/        Domain types, constants, IPC contract (serialisable, cross-boundary)
  core/          Logger, typed event bus, error hierarchy, progress/ETA tracker
  image-engine/  ISO9660+Joliet+El Torito builder, reader/extractor, format registry
                 (iso, bincue, img, nrg), build-source scanner, converter
  verify-engine/ Streaming hashing, sector compare, report rendering
  hal/           Hardware Abstraction Layer: drive discovery backends
                 (linux/win32/darwin) + always-available simulated backend
  burn-engine/   Burn writer (simulation + RealBurnAdapter hook), buffer model,
                 job + queue, diagnostics/read-test
  cli/           Command-line interface over every engine
  main/          Electron main process + IPC handlers
  preload/       Context-isolated bridge (window.isoMaker)
  renderer/      Mode-based UI, speed graph, theming, log console
```

Real physical burning is added by implementing `RealBurnAdapter` (see
`src/burn-engine/writer.ts`) and registering it for a platform — the rest of the
application (UI, queue, verify, diagnostics) is already wired to use it.

---

## Getting started

```bash
npm install            # if the Electron binary download is blocked, see note below
npm run build          # bundle main, preload, renderer, cli and tests
npm test               # build → ISO round-trip / verify integration tests
npm start              # launch the desktop app
```

> If your network blocks Electron's post-install binary download, install with
> `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`. You can still typecheck, build and use
> the **CLI**; the GUI needs the Electron binary (CI installs it normally).

### CLI examples

```bash
# Build a bootable, Joliet-enabled ISO from files and folders
isomaker build -o release.iso --label MY_DISC \
  --boot boot.img --boot-emul none --boot-info \
  ./payload ./README.txt

# Inspect / list / extract
isomaker info release.iso
isomaker list release.iso
isomaker extract release.iso --out ./contents

# Convert, verify, hash
isomaker convert game.cue -o game.iso
isomaker verify master.iso burned-copy.iso --algo sha256,md5
isomaker checksum release.iso --algo crc32,sha256

# Drives, diagnostics, and a (simulated) burn
isomaker discover
isomaker test release.iso
isomaker burn release.iso -d sim-0 --speed 0 --simulate
```

Run `isomaker --help` for the full command reference.

---

## Plugin system

Image formats are contributed through a registry. A plugin is any CommonJS module that
exports an `ImageFormatHandler` (as `default`, `format` or `handler`):

```js
// my-format.js
module.exports.format = {
  id: 'cdi',
  name: 'DiscJuggler CDI',
  extensions: ['.cdi'],
  detect: (filePath, header) => header.toString('ascii', 0, 4) === 'CDI ',
  async info(filePath) { /* return an ImageInfo */ }
};
```

```bash
isomaker plugin ./my-format.js   # registers it, then lists all formats
```

An example plugin lives in [`examples/plugins/raw-format.js`](examples/plugins/raw-format.js).

---

## Packaging & releases

A Windows setup `.exe` (NSIS) and a Linux AppImage are produced by
[`electron-builder`](https://www.electron.build/):

```bash
npm run dist:win     # IsoMaker-Setup-<version>.exe  -> ./release
npm run dist:linux   # IsoMaker-<version>.AppImage   -> ./release
```

Pushing a `vX.Y.Z` tag triggers **`.github/workflows/release.yml`**, which builds the
Windows installer on a Windows runner and publishes it to the GitHub **Releases** tab
automatically.

---

## Physical burning — status & validation

Real burn adapters are implemented in [`src/burn-engine/real-adapter.ts`](src/burn-engine/real-adapter.ts)
and registered automatically per platform for non-simulated drives:

- **Windows** — IMAPI2 (`MsftDiscFormat2Data`) driven through PowerShell; no native addon.
- **Linux** — `growisofs` (DVD/BD) or `wodim` (CD); install `dvd+rw-tools` / `cdrkit`.

Because the CI runners have no optical hardware, these paths are **not covered by automated
tests**. To validate on a real machine: insert blank media, open *Write image file to disc*,
pick the physical drive, and burn. Remaining polish:

1. Fine-grained IMAPI2 progress (per-sector `Update` events) and write-speed selection on Linux.
2. macOS adapter over `drutil` / DiscRecording.
3. Post-burn verification that reads sectors back from the burned disc (currently re-hashes the source).

The HAL and burn-engine interfaces are designed so these slot in without touching the UI,
queue, verification or diagnostics code.

## License

MIT — see [LICENSE](LICENSE).
