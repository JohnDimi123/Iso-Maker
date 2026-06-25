# Iso Maker — project guide

Modern, ImgBurn-style optical disc imaging/burning suite. Electron + TypeScript GUI,
modular engines, and a full CLI. See `README.md` for the feature status table.

## Commands
- `npm run build` — bundle everything with esbuild → `dist/` (main, preload, renderer, cli, tests).
- `npm run typecheck` — `tsc --noEmit` over all of `src/`.
- `npm test` — builds, then runs `node --test` integration tests (ISO round-trip + verify).
- `npm start` — launch the desktop app (needs the Electron binary).
- `node dist/cli/index.js <cmd>` — run the CLI (`build`, `info`, `verify`, `discover`, …).
- `npm run dist:win` / `dist:linux` — package installers via electron-builder.

If Electron's binary download is blocked: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`
(typecheck/build/CLI/tests still work; only the GUI needs the binary).

## Layout & layering (keep these boundaries)
- `src/shared` — serialisable types, constants, IPC contract. No Node/Electron imports.
- `src/core` — logger, event bus, errors, progress tracker.
- `src/image-engine` — ISO9660/Joliet/El Torito builder (`iso9660/builder.ts`), reader
  (`iso9660/reader.ts`), format registry + handlers, build-source scanner, converter.
- `src/verify-engine` — hashing, sector compare, report.
- `src/hal` — drive discovery backends + simulated fallback. **Never opens raw device nodes**
  during detection (avoid blocking on empty drives); metadata only.
- `src/burn-engine` — burn writer (simulation + `RealBurnAdapter` hook), buffer model, queue,
  diagnostics. Real burning = implement `RealBurnAdapter` and `registerBurnAdapter`.
- `src/main` / `src/preload` / `src/renderer` — Electron shell; renderer talks only through
  `window.isoMaker` (see `src/shared/ipc-contract.ts`). Add a feature = new channel in the
  contract, handler in `main/ipc-handlers.ts`, method in `preload/preload.ts`, UI in renderer.

## Invariants worth protecting
- The ISO builder's `layout()` (LBA assignment) and the write pass must stay in lockstep;
  `buildIso` asserts `writer.lba === expected` at every section. Touch one, recheck the other.
- ISO9660 file identifiers carry `;1`; Joliet names do **not** (matches Windows/pycdlib).
- El Torito boot-system id must be NUL-padded, not space-padded.
- Tests cross-check against `pycdlib` in CI (`.github/workflows/ci.yml`).

## Releases
Pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml` on Windows, builds the NSIS
setup `.exe`, and publishes it to the GitHub Releases tab (electron-builder, `GITHUB_TOKEN`).
