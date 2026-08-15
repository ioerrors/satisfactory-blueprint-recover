# Satisfactory Blueprint Recovery

Recovers missing `.sbp` / `.sbpcfg` files from blueprint instances that still exist in a Satisfactory save.

## Install

```bash
npm install
```

## Normal use

```bash
node recover-blueprints.mjs
```

With no arguments the tool discovers local Satisfactory **world saves**, chooses the newest parsable save, analyzes its placed blueprints, and restores missing blueprint files into that save session's blueprint directory. Existing blueprint files are not overwritten.

The discovery layer intentionally ignores `.sav` management/config files stored directly in `SaveGames` (for example `ServerManager_V2.sav`). If a discovered candidate is corrupt or not a world save, zero-argument mode falls through to the next-newest candidate.

Other useful modes:

```bash
node recover-blueprints.mjs --select
node recover-blueprints.mjs --list
node recover-blueprints.mjs --save /path/to/save.sav
node recover-blueprints.mjs --out ./recovered-blueprints
node recover-blueprints.mjs --dry-run
```

Run `node recover-blueprints.mjs --help` for the full option list.

## Platform discovery

Automatic save discovery currently supports:

- Windows native installs via `%LOCALAPPDATA%/FactoryGame/Saved/SaveGames`.
- Linux Steam/Proton, including common Steam locations, Flatpak Steam, and secondary Steam libraries found through `libraryfolders.vdf`.
- Active Wine/Proton prefixes exposed through `WINEPREFIX` or `STEAM_COMPAT_DATA_PATH`.

The recovery engine itself is platform-independent. On unusual launchers/prefix layouts, pass a save explicitly with `--save`; output is still inferred from that save's `SaveGames` ancestor when possible.

## Current format support

The self-contained blueprint writer is currently validated against Satisfactory 1.2 save format 60. Other save versions are attempted best-effort with an explicit warning.

## Limitations

- A blueprint can only be recovered if at least one placed instance of it still exists in the save.
- If several structurally different placements exist under the same blueprint name, the tool selects the dominant current structural variant as the recovery source.
- Original per-blueprint UI metadata may no longer exist in the save. Icons are reconstructed best-effort and otherwise fall back to a default.
- Some lightweight-buildable cosmetic metadata may not be reconstructed perfectly. Geometry, recipes, transforms, and buildable configuration are recovered independently of this cosmetic metadata.

The tool reads the selected `.sav`; it does not modify the world save itself. Recovered blueprint files are written separately, and existing blueprint files are not overwritten unless explicitly requested.
