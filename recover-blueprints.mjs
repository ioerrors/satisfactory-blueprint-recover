#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { Parser, SaveEntity } from "@etothepii/satisfactory-file-parser";

const APP_ID = "526870";
const BLUEPRINT_PROXY_TYPE = "/Script/FactoryGame.FGBlueprintProxy";
const ICON_LIBRARY = "/Game/FactoryGame/-Shared/Blueprint/IconLibrary";
const ICON_LIBRARY_TYPE = "IconLibrary";
const BLUEPRINT_HEADER_VERSION = 2;
const BLUEPRINT_CONFIG_VERSION = 6;
const VALIDATED_SAVE_VERSION = 60;

const BUILTIN_ICON_MAP = [
    { displayName: "Bus Splitter", iconID: 45, aliases: ["Belt Bus Splitter"] },
    { displayName: "Circuit Board", iconID: 243, aliases: ["CircuitBoard"] },
    { displayName: "Computer", iconID: 271 },
    { displayName: "Crystal Oscillator", iconID: 270 },
    { displayName: "Encased Industrial Beam", iconID: 221, aliases: ["Encased Beam"] },
    { displayName: "Modular Frame", iconID: 233, aliases: ["Modular Frames"] },
    { displayName: "Motor", iconID: 223, aliases: ["Motors"] },
    { displayName: "Pressure Conversion Cube", iconID: 268 },
    { displayName: "Reinforced Iron Plate", iconID: 207, aliases: ["Reinforced Iron Plates"] },
    { displayName: "Rotor", iconID: 232, aliases: ["Rotors"] },
    { displayName: "Stator", iconID: 247, aliases: ["Stators"] },
    { displayName: "AI Limiter", iconID: 230, aliases: ["AI Limiters"] },
    { displayName: "Fused Modular Frame", iconID: 265 },
    { displayName: "Heat Sink", iconID: 258, aliases: ["Heat Sinks"] },
    { displayName: "Heavy Modular Frame", iconID: 225, aliases: ["Heavy Modular Frames"] },
    { displayName: "High-Speed Connector", iconID: 226, aliases: ["High Speed Connector", "High Speed Connectors"] },
    { displayName: "Supercomputer", iconID: 267, aliases: ["Supercomputers"] },
    { displayName: "SAM Fluctuator", iconID: 799 },
    { displayName: "Turbo Motor", iconID: 273, aliases: ["Turbo Motors"] },
    { displayName: "Dark Matter Crystal", iconID: 804 },
    { displayName: "Ficsite Ingot", iconID: 813 },
    { displayName: "Ficsonium", iconID: 858 },
    { displayName: "Non-Fissile Uranium", iconID: 264, aliases: ["Non Fissile Uranium"] },
    { displayName: "Nuclear Pasta", iconID: 304 },
    { displayName: "Plutonium Fuel Rod", iconID: 269, aliases: ["Plutonium Fuel Rods"] },
    { displayName: "Singularity Cell", iconID: 805 }
];

/*
 * Satisfactory placed-blueprint recovery
 *
 * Normal usage:
 *   node recover-blueprints.mjs
 *
 * The no-argument path discovers Satisfactory saves, chooses the newest save,
 * analyzes placed blueprint instances, reconstructs blueprint files, and writes
 * missing blueprints directly to SaveGames/blueprints/<session>.
 *
 * Public options intentionally stay small. Reverse-engineering fixtures,
 * cluster JSON, serializer templates, and materializer prototypes are internal
 * implementation details, not user inputs.
 */

function usage(exitCode = 0) {
    console.log(`
Satisfactory Blueprint Recovery

usage:
  node recover-blueprints.mjs
  node recover-blueprints.mjs --select
  node recover-blueprints.mjs --save <file.sav>
  node recover-blueprints.mjs --list

options:
  --save <file.sav>        Recover from an explicit save.
  --select                 Interactively choose from discovered saves.
  --list                   List discovered saves and exit.
  --out <directory>        Write somewhere else instead of the game's
                           blueprint directory for the selected session.
  --overwrite-existing     Replace existing .sbp/.sbpcfg pairs.
  --dry-run                Analyze and report without writing files.
  --no-icons               Disable optional icon enrichment.
  --verbose                Print cluster-selection details.
  --debug-dump <file.json> Write internal placement analysis for debugging.
  --help                    Show this help.

default:
  With no arguments, the newest discovered Satisfactory save is used and
  recovered blueprints are installed directly into that session's blueprint
  directory. Existing blueprint files are left untouched.
`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const out = {
        save: null,
        select: false,
        list: false,
        outDir: null,
        overwriteExisting: false,
        dryRun: false,
        noIcons: false,
        verbose: false,
        debugDump: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];

        const needValue = name => {
            const value = argv[++i];
            if (!value || value.startsWith("--"))
                throw new Error(`${name} requires a value`);
            return value;
        };

        switch (arg) {
            case "--save":
                out.save = needValue("--save");
                break;
            case "--select":
                out.select = true;
                break;
            case "--list":
                out.list = true;
                break;
            case "--out":
                out.outDir = needValue("--out");
                break;
            case "--overwrite-existing":
                out.overwriteExisting = true;
                break;
            case "--dry-run":
                out.dryRun = true;
                break;
            case "--no-icons":
                out.noIcons = true;
                break;
            case "--verbose":
                out.verbose = true;
                break;
            case "--debug-dump":
                out.debugDump = needValue("--debug-dump");
                break;
            case "-h":
            case "--help":
                usage(0);
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    const selectionModes =
        Number(Boolean(out.save)) +
        Number(out.select);

    if (selectionModes > 1)
        throw new Error("--save and --select are mutually exclusive");

    return out;
}

function toArrayBuffer(buf) {
    return buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength
    );
}

/*
 * Preserve the prototypes of parser-owned SaveEntity / SaveComponent objects.
 * A JSON round-trip would destroy them, and mutating the original parsed save
 * would corrupt subsequent blueprint recoveries in the same batch.
 */
function deepClone(value, seen = new Map()) {
    if (
        value === null ||
        typeof value !== "object"
    ) {
        return value;
    }

    if (seen.has(value))
        return seen.get(value);

    if (value instanceof ArrayBuffer)
        return value.slice(0);

    if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
            const copy = new DataView(
                value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength
                )
            );
            seen.set(value, copy);
            return copy;
        }

        const copy = new value.constructor(value);
        seen.set(value, copy);
        return copy;
    }

    if (value instanceof Date) {
        const copy = new Date(value);
        seen.set(value, copy);
        return copy;
    }

    if (value instanceof Map) {
        const copy = new Map();
        seen.set(value, copy);

        for (const [k, v] of value)
            copy.set(deepClone(k, seen), deepClone(v, seen));

        return copy;
    }

    if (value instanceof Set) {
        const copy = new Set();
        seen.set(value, copy);

        for (const v of value)
            copy.add(deepClone(v, seen));

        return copy;
    }

    if (Array.isArray(value)) {
        const copy = [];
        seen.set(value, copy);

        for (const v of value)
            copy.push(deepClone(v, seen));

        return copy;
    }

    const copy = Object.create(Object.getPrototypeOf(value));
    seen.set(value, copy);

    for (const key of Reflect.ownKeys(value)) {
        const descriptor =
            Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor)
            continue;

        if ("value" in descriptor)
            descriptor.value = deepClone(descriptor.value, seen);

        Object.defineProperty(copy, key, descriptor);
    }

    return copy;
}

function qNorm(q) {
    q ??= { x: 0, y: 0, z: 0, w: 1 };

    const n =
        Math.hypot(
            q.x ?? 0,
            q.y ?? 0,
            q.z ?? 0,
            q.w ?? 1
        ) || 1;

    return {
        x: (q.x ?? 0) / n,
        y: (q.y ?? 0) / n,
        z: (q.z ?? 0) / n,
        w: (q.w ?? 1) / n
    };
}

function qConj(q) {
    return {
        x: -q.x,
        y: -q.y,
        z: -q.z,
        w: q.w
    };
}

function qMul(a, b) {
    return {
        x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
        y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
        z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
        w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z
    };
}

function qRotate(q, v) {
    const p = {
        x: v.x,
        y: v.y,
        z: v.z,
        w: 0
    };

    const r = qMul(
        qMul(q, p),
        qConj(q)
    );

    return {
        x: r.x,
        y: r.y,
        z: r.z
    };
}

function toProxyLocal(world, proxy) {
    const pq = qNorm(proxy.rotation);
    const inv = qConj(pq);
    const wq = qNorm(world.rotation);

    const delta = {
        x:
            (world.translation?.x ?? 0) -
            (proxy.translation?.x ?? 0),
        y:
            (world.translation?.y ?? 0) -
            (proxy.translation?.y ?? 0),
        z:
            (world.translation?.z ?? 0) -
            (proxy.translation?.z ?? 0)
    };

    const rotated = qRotate(inv, delta);

    const ps =
        proxy.scale3d ??
        { x: 1, y: 1, z: 1 };

    const ws =
        world.scale3d ??
        { x: 1, y: 1, z: 1 };

    return {
        rotation: qNorm(
            qMul(inv, wq)
        ),
        translation: {
            x: rotated.x / (ps.x || 1),
            y: rotated.y / (ps.y || 1),
            z: rotated.z / (ps.z || 1)
        },
        scale3d: {
            x: ws.x / (ps.x || 1),
            y: ws.y / (ps.y || 1),
            z: ws.z / (ps.z || 1)
        }
    };
}

function safeFilename(name) {
    let out = String(name ?? "")
        /* Windows-invalid chars are also undesirable on portable archives. */
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/[. ]+$/g, "")
        .trim();

    if (!out)
        out = "Recovered Blueprint";

    /* Windows reserved device basenames, with or without an extension. */
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(out))
        out = `_${out}`;

    return out;
}

function normalizeTitle(value) {
    return String(value ?? "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
 * Mild plural tolerance:
 *   MOTOR  -> matches MOTORS
 *   PIPE   -> matches PIPES
 *
 * Longest display name still wins, so:
 *   HEAVY MODULAR FRAME beats MODULAR FRAME.
 */
function titleContainsCandidate(title, candidate) {
    if (!candidate)
        return false;

    if (title.includes(candidate))
        return true;

    const words = candidate.split(" ");

    if (!words.length)
        return false;

    const last = words.at(-1);

    for (const suffix of ["S", "ES"]) {
        const plural =
            [...words.slice(0, -1), last + suffix]
                .join(" ");

        if (title.includes(plural))
            return true;
    }

    return false;
}

/*
 * Icon enrichment is deliberately non-critical. The built-in map is seeded
 * from known-good vanilla Blueprint Icon Library IDs; no external map is
 * required for normal recovery.
 */
function createIconResolver({
    disabled,
    entries = BUILTIN_ICON_MAP,
    defaultLibrary = ICON_LIBRARY,
    defaultLibraryType = ICON_LIBRARY_TYPE,
    warn
}) {
    if (disabled) {
        return {
            status: "disabled",
            entryCount: 0,
            resolve: () => null
        };
    }

    try {
        const candidates = [];

        for (const row of entries) {
            if (!row?.displayName)
                continue;

            if (!Number.isInteger(row.iconID)) {
                warn?.(
                    `Ignoring built-in icon entry "${row.displayName}": ` +
                    `iconID is not an integer`
                );
                continue;
            }

            const names = [
                row.displayName,
                ...(Array.isArray(row.aliases) ? row.aliases : [])
            ];

            for (const name of names) {
                const normalized = normalizeTitle(name);

                if (!normalized)
                    continue;

                candidates.push({
                    normalized,
                    sourceName: String(row.displayName),
                    iconID: row.iconID,
                    referencedIconLibrary:
                        row.referencedIconLibrary ?? defaultLibrary,
                    iconLibraryType:
                        row.iconLibraryType ?? defaultLibraryType
                });
            }
        }

        candidates.sort(
            (a, b) =>
                b.normalized.length -
                a.normalized.length ||
                a.normalized.localeCompare(b.normalized)
        );

        return {
            status: "ready",
            entryCount: candidates.length,

            resolve(blueprintName) {
                const normalizedBlueprint =
                    normalizeTitle(blueprintName);

                for (const candidate of candidates) {
                    if (
                        titleContainsCandidate(
                            normalizedBlueprint,
                            candidate.normalized
                        )
                    ) {
                        return {
                            iconID: candidate.iconID,
                            referencedIconLibrary:
                                candidate.referencedIconLibrary,
                            iconLibraryType:
                                candidate.iconLibraryType,
                            matchedDisplayName:
                                candidate.sourceName
                        };
                    }
                }

                return null;
            }
        };
    } catch (err) {
        warn?.(
            `Icon subsystem unavailable: ${err.message}. ` +
            `Blueprint recovery will continue with default icons.`
        );

        return {
            status: "error",
            entryCount: 0,
            error: String(err?.stack ?? err),
            resolve: () => null
        };
    }
}


function uniqueExistingDirectories(candidates) {
    const out = [];
    const seen = new Set();

    for (const candidate of candidates) {
        if (!candidate)
            continue;

        const resolved = path.resolve(candidate);

        let real;
        try {
            real = fs.realpathSync.native(resolved);
        } catch {
            continue;
        }

        let stat;
        try {
            stat = fs.statSync(real);
        } catch {
            continue;
        }

        if (!stat.isDirectory() || seen.has(real))
            continue;

        seen.add(real);
        out.push(real);
    }

    return out;
}

/*
 * Steam's libraryfolders.vdf is deliberately parsed only for its path fields.
 * We do not need a general VDF parser here, and keeping this tiny avoids a
 * dependency whose sole purpose would be installation discovery.
 */
function readSteamLibraryFolders(steamRoot) {
    const vdf = path.join(
        steamRoot,
        "steamapps",
        "libraryfolders.vdf"
    );

    let text;
    try {
        text = fs.readFileSync(vdf, "utf8");
    } catch {
        return [];
    }

    const libraries = [];
    const re = /"path"\s+"((?:\\.|[^"])*)"/g;
    let match;

    while ((match = re.exec(text))) {
        const decoded = match[1]
            .replace(/\\\\/g, "\\")
            .replace(/\\"/g, '"');

        libraries.push(decoded);
    }

    return libraries;
}

function discoverLinuxSteamLibraries() {
    const home = os.homedir();

    const steamRoots = [
        process.env.STEAM_COMPAT_CLIENT_INSTALL_PATH,
        path.join(home, ".steam", "debian-installation"),
        path.join(home, ".steam", "steam"),
        path.join(home, ".local", "share", "Steam"),
        path.join(
            home,
            ".var",
            "app",
            "com.valvesoftware.Steam",
            ".local",
            "share",
            "Steam"
        )
    ];

    const roots = uniqueExistingDirectories(steamRoots);
    const libraries = [...roots];

    for (const root of roots)
        libraries.push(...readSteamLibraryFolders(root));

    return uniqueExistingDirectories(libraries);
}

function saveRootsFromWinePrefix(prefix) {
    if (!prefix)
        return [];

    const usersDir = path.join(
        prefix,
        "drive_c",
        "users"
    );

    let users;
    try {
        users = fs.readdirSync(usersDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const candidates = [];

    for (const user of users) {
        if (!user.isDirectory())
            continue;

        candidates.push(
            path.join(
                usersDir,
                user.name,
                "AppData",
                "Local",
                "FactoryGame",
                "Saved",
                "SaveGames"
            )
        );
    }

    return uniqueExistingDirectories(candidates);
}

/*
 * Installation discovery is intentionally isolated from recovery logic.
 *
 * Supported automatically:
 *   - Windows native: %LOCALAPPDATA%/FactoryGame/Saved/SaveGames
 *   - Linux Steam/Proton, including secondary Steam libraries + Flatpak Steam
 *   - An active Wine/Proton prefix exposed through WINEPREFIX or
 *     STEAM_COMPAT_DATA_PATH
 *
 * Any platform/setup can still use --save explicitly. Once a SaveGames path
 * has been found, the rest of the recovery pipeline is platform-agnostic.
 */
function discoverSaveRoots() {
    const home = os.homedir();
    const candidates = [];

    if (process.platform === "win32") {
        const localAppData =
            process.env.LOCALAPPDATA ??
            path.join(home, "AppData", "Local");

        candidates.push(
            path.join(
                localAppData,
                "FactoryGame",
                "Saved",
                "SaveGames"
            )
        );
    }

    if (process.platform === "linux") {
        /*
         * When launched from a Proton-aware environment this may already point
         * at .../compatdata/526870. It is useful for nonstandard Steam roots.
         */
        const compatData =
            process.env.STEAM_COMPAT_DATA_PATH;

        if (compatData) {
            candidates.push(
                ...saveRootsFromWinePrefix(
                    path.join(compatData, "pfx")
                )
            );
        }

        if (process.env.WINEPREFIX) {
            candidates.push(
                ...saveRootsFromWinePrefix(
                    process.env.WINEPREFIX
                )
            );
        }

        for (const library of discoverLinuxSteamLibraries()) {
            const prefix = path.join(
                library,
                "steamapps",
                "compatdata",
                APP_ID,
                "pfx"
            );

            candidates.push(
                ...saveRootsFromWinePrefix(prefix)
            );
        }
    }

    return uniqueExistingDirectories(candidates);
}

/*
 * Actual world saves are stored below a profile/server directory inside
 * SaveGames. SaveGames itself can also contain management/configuration .sav
 * files (for example ServerManager_V2.sav); those are not world saves and must
 * not participate in "newest save" selection.
 */
function walkSaveFiles(root) {
    const out = [];

    let topEntries;
    try {
        topEntries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return out;
    }

    const profileDirs = topEntries.filter(entry =>
        entry.isDirectory() &&
        entry.name.toLowerCase() !== "blueprints"
    );

    function walk(dir, depth) {
        if (depth > 2)
            return;

        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const full = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (entry.name.toLowerCase() === "blueprints")
                    continue;

                walk(full, depth + 1);
                continue;
            }

            if (
                entry.isFile() &&
                entry.name.toLowerCase().endsWith(".sav")
            ) {
                let stat;
                try {
                    stat = fs.statSync(full);
                } catch {
                    continue;
                }

                out.push({
                    path: full,
                    name: entry.name,
                    mtimeMs: stat.mtimeMs,
                    size: stat.size,
                    saveGamesRoot: root
                });
            }
        }
    }

    for (const profile of profileDirs)
        walk(path.join(root, profile.name), 0);

    return out;
}

function discoverSaves() {
    const roots = discoverSaveRoots();
    const seen = new Set();
    const saves = [];

    for (const save of roots.flatMap(walkSaveFiles)) {
        let identity;

        try {
            identity = fs.realpathSync.native(save.path);
        } catch {
            identity = path.resolve(save.path);
        }

        if (seen.has(identity))
            continue;

        seen.add(identity);
        saves.push(save);
    }

    saves.sort(
        (a, b) =>
            b.mtimeMs - a.mtimeMs ||
            a.path.localeCompare(b.path)
    );

    return saves;
}

function parseSaveFile(saveInfo) {
    const bytes = fs.readFileSync(saveInfo.path);

    const save = Parser.ParseSave(
        saveInfo.path,
        toArrayBuffer(bytes),
        { throwErrors: true }
    );

    const sessionName =
        String(save?.header?.sessionName ?? "").trim();

    if (!sessionName) {
        throw new Error(
            "parsed file has no sessionName in its Satisfactory save header"
        );
    }

    return { save, sessionName };
}

/*
 * Zero-argument mode is intentionally forgiving: filesystem discovery is a
 * heuristic, so if a candidate is corrupt or not a playable world save, skip
 * it and try the next-newest candidate. Explicit --save/--select choices do
 * not silently substitute another file.
 */
function newestParsableSave(candidates, warn = () => {}) {
    const rejected = [];

    for (const candidate of candidates) {
        try {
            const parsed = parseSaveFile(candidate);
            return {
                selected: candidate,
                ...parsed,
                rejected
            };
        } catch (err) {
            rejected.push({
                path: candidate.path,
                error: String(err?.message ?? err)
            });

            warn(
                `Skipping non-world or unreadable save candidate ` +
                `${candidate.name}: ${err?.message ?? err}`
            );
        }
    }

    throw new Error(
        "No discovered .sav candidate could be parsed as a Satisfactory world save. " +
        "Use --save <file.sav> to specify one explicitly."
    );
}

function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;

    const units = ["KiB", "MiB", "GiB"];
    let value = bytes / 1024;
    let unit = units[0];

    for (let i = 1; i < units.length && value >= 1024; i++) {
        value /= 1024;
        unit = units[i];
    }

    return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function formatLocalDate(ms) {
    return new Date(ms).toLocaleString();
}

function printSaveList(saves) {
    if (!saves.length) {
        console.log("No Satisfactory saves discovered.");
        return;
    }

    const width = String(saves.length).length;

    for (let i = 0; i < saves.length; i++) {
        const save = saves[i];

        const latest =
            i === 0
                ? "  [latest]"
                : "";

        console.log(
            `${String(i + 1).padStart(width)}. ` +
            `${save.name}  |  ${formatLocalDate(save.mtimeMs)}  |  ${formatBytes(save.size)}` +
            latest
        );
        console.log(`    ${save.path}`);
    }
}

async function selectSaveInteractively(saves) {
    if (!saves.length)
        throw new Error("No Satisfactory saves discovered");

    printSaveList(saves);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        while (true) {
            const answer =
                (await rl.question(
                    `Select save [1-${saves.length}, default 1]: `
                )).trim();

            if (!answer)
                return saves[0];

            const n = Number(answer);

            if (
                Number.isInteger(n) &&
                n >= 1 &&
                n <= saves.length
            ) {
                return saves[n - 1];
            }

            console.log("Invalid selection.");
        }
    } finally {
        rl.close();
    }
}

function findSaveGamesRoot(savePath) {
    let current =
        path.dirname(
            path.resolve(savePath)
        );

    while (true) {
        if (
            path.basename(current)
                .toLowerCase() === "savegames"
        ) {
            return current;
        }

        const parent =
            path.dirname(current);

        if (parent === current)
            return null;

        current = parent;
    }
}

function getBlueprintName(proxy) {
    return (
        proxy?.properties
            ?.mBlueprintName
            ?.value
            ?.value ??
        null
    );
}

function getBlueprintProxyRef(obj) {
    return (
        obj?.properties
            ?.mBlueprintProxy
            ?.value
            ?.pathName ??
        null
    );
}

function canonicalQuaternion(q) {
    let out = qNorm(q);

    /*
     * q and -q represent the same rotation. Pick one sign so otherwise
     * identical placements hash identically.
     */
    const sign =
        out.w < 0 ||
        (
            out.w === 0 &&
            (
                out.z < 0 ||
                (
                    out.z === 0 &&
                    (
                        out.y < 0 ||
                        (
                            out.y === 0 &&
                            out.x < 0
                        )
                    )
                )
            )
        )
            ? -1
            : 1;

    if (sign < 0) {
        out = {
            x: -out.x,
            y: -out.y,
            z: -out.z,
            w: -out.w
        };
    }

    return out;
}

function roundFingerprintNumber(value) {
    const n = Number(value ?? 0);

    if (!Number.isFinite(n))
        return 0;

    return Math.round(n * 1000) / 1000;
}

function transformFingerprint(transform) {
    const q =
        canonicalQuaternion(
            transform?.rotation
        );

    const t =
        transform?.translation ??
        { x: 0, y: 0, z: 0 };

    const sc =
        transform?.scale3d ??
        { x: 1, y: 1, z: 1 };

    return [
        roundFingerprintNumber(t.x),
        roundFingerprintNumber(t.y),
        roundFingerprintNumber(t.z),
        roundFingerprintNumber(q.x),
        roundFingerprintNumber(q.y),
        roundFingerprintNumber(q.z),
        roundFingerprintNumber(q.w),
        roundFingerprintNumber(sc.x),
        roundFingerprintNumber(sc.y),
        roundFingerprintNumber(sc.z)
    ].join(",");
}

function analyzeBlueprintPlacements(save) {
    const worldObjects =
        save.levels
            ?.Persistent_Level
            ?.objects;

    if (!Array.isArray(worldObjects)) {
        throw new Error(
            "Persistent_Level.objects not found in parsed save"
        );
    }

    const buildableSubsystem =
        findBuildableSubsystemObject(
            worldObjects
        );

    const proxyByName =
        new Map();

    const proxyIndexByInstance =
        new Map();

    for (let i = 0; i < worldObjects.length; i++) {
        const obj = worldObjects[i];

        if (obj?.typePath !== BLUEPRINT_PROXY_TYPE)
            continue;

        const bpName =
            getBlueprintName(obj);

        if (!bpName)
            continue;

        const record = {
            proxyIndex: i,
            proxy: obj,
            bpName
        };

        proxyIndexByInstance.set(
            obj.instanceName,
            record
        );

        if (!proxyByName.has(bpName))
            proxyByName.set(bpName, []);

        proxyByName.get(bpName).push(record);
    }

    const ordinaryByProxy =
        new Map();

    for (let i = 0; i < worldObjects.length; i++) {
        const obj = worldObjects[i];
        const proxyName =
            getBlueprintProxyRef(obj);

        if (!proxyName)
            continue;

        if (!ordinaryByProxy.has(proxyName))
            ordinaryByProxy.set(proxyName, []);

        ordinaryByProxy.get(proxyName).push({
            objectIndex: i
        });
    }

    const lightweightByProxy =
        new Map();

    const groups =
        buildableSubsystem
            ?.specialProperties
            ?.buildables ??
        [];

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        const typePath =
            lightweightGroupTypePath(group);

        const instances =
            group?.instances ??
            [];

        for (
            let instanceIndex = 0;
            instanceIndex < instances.length;
            instanceIndex++
        ) {
            const instance =
                instances[instanceIndex];

            const proxyName =
                instance
                    ?.blueprintProxy
                    ?.pathName;

            if (!proxyName)
                continue;

            if (!lightweightByProxy.has(proxyName))
                lightweightByProxy.set(proxyName, []);

            lightweightByProxy
                .get(proxyName)
                .push({
                    groupIndex,
                    instanceIndex,
                    typePath
                });
        }
    }

    const clusterData = {};

    for (const [bpName, proxies] of proxyByName) {
        const byFingerprint =
            new Map();

        for (const record of proxies) {
            const proxy =
                record.proxy;

            const ordinary =
                ordinaryByProxy.get(
                    proxy.instanceName
                ) ?? [];

            const lightweight =
                lightweightByProxy.get(
                    proxy.instanceName
                ) ?? [];

            const tokens = [];

            for (const entry of ordinary) {
                const obj =
                    worldObjects[
                        entry.objectIndex
                    ];

                if (!obj?.transform)
                    continue;

                tokens.push(
                    `O|${obj.typePath}|` +
                    transformFingerprint(
                        toProxyLocal(
                            obj.transform,
                            proxy.transform
                        )
                    )
                );
            }

            for (const entry of lightweight) {
                const instance =
                    groups[
                        entry.groupIndex
                    ]?.instances?.[
                        entry.instanceIndex
                    ];

                if (!instance?.transform)
                    continue;

                tokens.push(
                    `L|${entry.typePath ?? ""}|` +
                    transformFingerprint(
                        toProxyLocal(
                            instance.transform,
                            proxy.transform
                        )
                    )
                );
            }

            tokens.sort();

            const fingerprint =
                crypto
                    .createHash("sha256")
                    .update(tokens.join("\n"))
                    .digest("hex")
                    .slice(0, 16);

            const placement = {
                proxyIndex:
                    record.proxyIndex,
                ordinary,
                lightweight,
                memberCount:
                    ordinary.length +
                    lightweight.length
            };

            if (!byFingerprint.has(fingerprint)) {
                byFingerprint.set(
                    fingerprint,
                    {
                        fingerprint,
                        placementCount: 0,
                        memberCount:
                            placement.memberCount,
                        placements: []
                    }
                );
            }

            const cluster =
                byFingerprint.get(
                    fingerprint
                );

            cluster.placementCount++;
            cluster.memberCount =
                Math.max(
                    cluster.memberCount,
                    placement.memberCount
                );

            cluster.placements.push(
                placement
            );
        }

        clusterData[bpName] =
            [...byFingerprint.values()]
                .sort(
                    (a, b) =>
                        b.placementCount -
                            a.placementCount ||
                        b.memberCount -
                            a.memberCount ||
                        a.fingerprint.localeCompare(
                            b.fingerprint
                        )
                );
    }

    return {
        clusterData,
        worldObjects,
        buildableSubsystem,
        proxyCount:
            proxyIndexByInstance.size,
        blueprintNames:
            Object.keys(clusterData).length
    };
}

function inferDesignerDimension(bpName) {
    const match =
        String(bpName)
            .match(
                /\b(\d+)\s*[xX]\s*(\d+)\b/
            );

    if (match) {
        const n =
            Math.max(
                Number(match[1]),
                Number(match[2])
            );

        if (
            Number.isFinite(n) &&
            n >= 4 &&
            n <= 10
        ) {
            return {
                x: n,
                y: n,
                z: n
            };
        }
    }

    /*
     * v2 used a 5x5 current-format canary for every recovered blueprint and
     * the game accepted it. Keep that proven fallback when the original
     * designer size is not recoverable from placement data.
     */
    return {
        x: 5,
        y: 5,
        z: 5
    };
}

function findPlayerInfoHandle(worldObjects, buildableSubsystem) {
    for (const obj of worldObjects) {
        const handle =
            obj?.properties
                ?.BuiltBy
                ?.value;

        if (
            handle &&
            Number.isFinite(
                handle.serviceProvider
            ) &&
            Number.isFinite(
                handle.playerInfoTableIndex
            )
        ) {
            return deepClone(handle);
        }
    }

    for (
        const group of
        buildableSubsystem
            ?.specialProperties
            ?.buildables ??
        []
    ) {
        for (const instance of group?.instances ?? []) {
            const handle =
                instance?.builtBy;

            if (
                handle &&
                Number.isFinite(
                    handle.serviceProvider
                ) &&
                Number.isFinite(
                    handle.playerInfoTableIndex
                )
            ) {
                return deepClone(handle);
            }
        }
    }

    return {
        serviceProvider: 0,
        playerInfoTableIndex: 0
    };
}

function findEntityMetadataShell(worldObjects) {
    const candidates =
        worldObjects.filter(
            obj =>
                obj?.type === "SaveEntity" &&
                (
                    obj
                        ?.properties
                        ?.mBuiltWithRecipe ||
                    obj
                        ?.parentObject
                        ?.pathName ===
                        "Persistent_Level:PersistentLevel.BuildableSubsystem"
                )
        );

    const shell =
        candidates[0] ??
        worldObjects.find(
            obj =>
                obj?.type ===
                "SaveEntity"
        );

    if (!shell) {
        throw new Error(
            "Could not find a SaveEntity metadata shell in the save"
        );
    }

    return shell;
}

function makeObjectProperty(
    name,
    value
) {
    return {
        type: "ObjectProperty",
        name,
        propertyTagType: {
            name: "ObjectProperty",
            children: []
        },
        value: deepClone(
            value ?? {
                levelName: "",
                pathName: ""
            }
        )
    };
}

function makeFloatProperty(
    name,
    value
) {
    return {
        type: "FloatProperty",
        name,
        propertyTagType: {
            name: "FloatProperty",
            children: []
        },
        value: Number(value ?? 0)
    };
}

function makeByteProperty(
    name,
    value
) {
    return {
        type: "ByteProperty",
        name,
        propertyTagType: {
            name: "ByteProperty",
            children: []
        },
        value: {
            type: undefined,
            value: Number(value ?? 0)
        }
    };
}

function makeBuiltByProperty(handle) {
    return {
        type: "StructProperty",
        name: "BuiltBy",
        propertyTagType: {
            name: "StructProperty",
            children: [
                {
                    name: "PlayerInfoHandle",
                    children: [
                        {
                            name: "/Script/FactoryGame",
                            children: []
                        }
                    ]
                }
            ]
        },
        flags: 8,
        value: deepClone(handle)
    };
}

function makeCustomizationProperty(lw) {
    const properties = {};

    const refs = [
        ["SwatchDesc", lw?.usedSwatchSlot],
        ["MaterialDesc", lw?.usedMaterial],
        ["PatternDesc", lw?.usedPattern],
        ["SkinDesc", lw?.usedSkin],
        ["PaintFinishDesc", lw?.usedPaintFinish]
    ];

    for (const [name, ref] of refs) {
        if (ref?.pathName) {
            properties[name] =
                makeObjectProperty(
                    name,
                    ref
                );
        }
    }

    return {
        type: "StructProperty",
        name: "mCustomizationData",
        propertyTagType: {
            name: "StructProperty",
            children: [
                {
                    name: "FactoryCustomizationData",
                    children: [
                        {
                            name: "/Script/FactoryGame",
                            children: []
                        }
                    ]
                }
            ]
        },
        value: {
            type: "FactoryCustomizationData",
            properties
        }
    };
}

function createBlueprintSkeleton({
    save,
    bpName,
    playerInfoHandle
}) {
    if (!save?.compressionInfo) {
        throw new Error(
            "Parsed save has no compressionInfo; cannot write blueprints"
        );
    }

    if (!save?.objectVersionData) {
        throw new Error(
            "Parsed save has no objectVersionData; this save version is not supported by the self-contained writer"
        );
    }

    return {
        name: bpName,
        compressionInfo:
            deepClone(
                save.compressionInfo
            ),
        header: {
            /*
             * Blueprint header v2/config v6 are the current 1.2 formats that
             * were validated against the user's native 1.2 blueprints.
             * save/build/object versions come from the selected save itself.
             */
            headerVersion: BLUEPRINT_HEADER_VERSION,
            saveVersion:
                save.header.saveVersion,
            buildVersion:
                save.header.buildVersion,
            designerDimension:
                inferDesignerDimension(
                    bpName
                ),
            itemCosts: [],
            recipeReferences: [],
            objectVersionData:
                deepClone(
                    save.objectVersionData
                )
        },
        config: {
            configVersion: BLUEPRINT_CONFIG_VERSION,
            description: "",
            color: {
                r: 0,
                g: 0,
                b: 0,
                a: 1
            },
            /*
             * 512 is a known-valid vanilla Blueprint Icon Library ID from the
             * surviving Dune configs. Most production blueprints get a more
             * specific icon through the soft-failing resolver.
             */
            iconID: 512,
            referencedIconLibrary:
                ICON_LIBRARY,
            iconLibraryType:
                ICON_LIBRARY_TYPE,
            lastEditedBy:
                deepClone(
                    playerInfoHandle
                )
        },
        objects: []
    };
}

function chooseCluster(clusterData, bpName) {
    const clusters =
        clusterData[bpName];

    if (!Array.isArray(clusters) || !clusters.length)
        throw new Error(
            `No current placement cluster for "${bpName}"`
        );

    return [...clusters].sort(
        (a, b) =>
            b.placementCount - a.placementCount ||
            b.memberCount - a.memberCount ||
            String(a.fingerprint)
                .localeCompare(
                    String(b.fingerprint)
                )
    )[0];
}

function stripWorldOnlyProperties(value) {
    if (!value || typeof value !== "object")
        return;

    if (Array.isArray(value)) {
        for (const child of value)
            stripWorldOnlyProperties(child);

        return;
    }

    /*
     * Proven absent from a current native .sbp:
     *   - mBlueprintProxy
     *   - mConveyorChainActor
     *
     * Proven valid in a current native .sbp and therefore preserved:
     *   - BuiltBy
     *   - mColorSlot
     *   - mSavedDirections
     *   - mCustomizationData
     *   - production configuration properties
     *   - etc.
     */
    delete value.mBlueprintProxy;
    delete value.mConveyorChainActor;

    for (const child of Object.values(value))
        stripWorldOnlyProperties(child);
}

function collectBuildRecipes(value, out, key = "") {
    if (!value || typeof value !== "object")
        return;

    if (
        key === "mBuiltWithRecipe" &&
        value?.value?.pathName
    ) {
        out.add(value.value.pathName);
    }

    if (Array.isArray(value)) {
        for (const child of value)
            collectBuildRecipes(child, out);
    } else {
        for (const [k, child] of Object.entries(value))
            collectBuildRecipes(child, out, k);
    }
}

function cleanExternalRefs(
    value,
    internalNames,
    allowedExternalRefs,
    stats
) {
    if (!value || typeof value !== "object")
        return;

    if (
        typeof value.levelName === "string" &&
        typeof value.pathName === "string" &&
        value.levelName === "Persistent_Level" &&
        value.pathName
    ) {
        const target =
            value.pathName;

        if (
            !internalNames.has(target) &&
            !allowedExternalRefs.has(target)
        ) {
            value.levelName = "";
            value.pathName = "";
            stats.disconnectedExternalRefs++;
            return;
        }
    }

    if (Array.isArray(value)) {
        for (const child of value) {
            cleanExternalRefs(
                child,
                internalNames,
                allowedExternalRefs,
                stats
            );
        }
    } else {
        for (const child of Object.values(value)) {
            cleanExternalRefs(
                child,
                internalNames,
                allowedExternalRefs,
                stats
            );
        }
    }
}


function findBuildableSubsystemObject(worldObjects) {
    return worldObjects.find(
        o => Array.isArray(o?.specialProperties?.buildables)
    ) ?? null;
}

function lightweightGroupTypePath(group) {
    return (
        group?.typeReference?.pathName ??
        group?.typePath ??
        null
    );
}

function collectLightweightForProxy(buildableSubsystem, proxyName) {
    const out = [];

    const groups =
        buildableSubsystem?.specialProperties?.buildables ?? [];

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const group = groups[groupIndex];
        const typePath = lightweightGroupTypePath(group);
        const instances = group?.instances ?? [];

        for (let instanceIndex = 0; instanceIndex < instances.length; instanceIndex++) {
            const instance = instances[instanceIndex];

            if (
                instance?.blueprintProxy?.pathName !== proxyName
            ) {
                continue;
            }

            out.push({
                groupIndex,
                instanceIndex,
                typePath,
                group,
                instance
            });
        }
    }

    return out;
}

function swatchToLegacyColorSlot(swatchRef) {
    const pathName =
        swatchRef?.pathName ??
        "";

    if (pathName.includes("SwatchDesc_Custom"))
        return 255;

    if (pathName.includes("SwatchDesc_Concrete"))
        return 18;

    const match =
        pathName.match(
            /SwatchDesc_Slot(\d+)/
        );

    if (match)
        return Number(match[1]);

    return null;
}

function allocateRecoveredInstanceName(typePath, usedNames, sequence) {
    const className =
        String(typePath ?? "")
            .split(".")
            .at(-1) ||
        "RecoveredBuildable_C";

    while (true) {
        const candidate =
            `Persistent_Level:PersistentLevel.${className}_${sequence.value++}`;

        if (!usedNames.has(candidate)) {
            usedNames.add(candidate);
            return candidate;
        }
    }
}

function materializeLightweightInstance({
    hit,
    metadataShell,
    proxy,
    usedNames,
    sequence,
    warnings,
    bpName
}) {
    const {
        typePath,
        instance
    } = hit;

    const label =
        `${bpName} lightweight[group=${hit.groupIndex},instance=${hit.instanceIndex}]`;

    if (!typePath) {
        return {
            entity: null,
            warning:
                `${label}: buildable group has no typeReference/typePath`
        };
    }

    /*
     * The fixture taught us the generic lightweight -> SaveEntity mapping.
     * We no longer require same-type native blueprint prototypes at runtime.
     *
     * Parser SaveEntity is a public class; creating it directly also gives the
     * writer the correct object shape/type discriminator.
     */
    const instanceName =
        allocateRecoveredInstanceName(
            typePath,
            usedNames,
            sequence
        );

    const entity =
        new SaveEntity(
            typePath,
            metadataShell?.rootObject ??
                "Persistent_Level",
            instanceName,
            "",
            metadataShell?.needTransform ??
                true
        );

    entity.flags =
        metadataShell?.flags;

    entity.saveCustomVersion =
        metadataShell?.saveCustomVersion ??
        0;

    entity.objectVersionData =
        metadataShell?.objectVersionData
            ? deepClone(
                metadataShell.objectVersionData
            )
            : undefined;

    entity.shouldMigrateObjectRefsToPersistent =
        Boolean(
            metadataShell
                ?.shouldMigrateObjectRefsToPersistent
        );

    entity.transform =
        deepClone(
            instance.transform
        );

    entity.wasPlacedInLevel = false;

    entity.parentObject = {
        levelName: "Persistent_Level",
        pathName:
            "Persistent_Level:PersistentLevel.BuildableSubsystem"
    };

    entity.components = [];

    const props = {};

    if (instance?.builtBy) {
        props.BuiltBy =
            makeBuiltByProperty(
                instance.builtBy
            );
    }

    if (instance?.usedRecipe?.pathName) {
        props.mBuiltWithRecipe =
            makeObjectProperty(
                "mBuiltWithRecipe",
                instance.usedRecipe
            );
    }

    props.mCustomizationData =
        makeCustomizationProperty(
            instance
        );

    /*
     * The native fixture showed mColorSlot on foundations/beams but not on
     * ordinary walls. Preserve that observed class behavior instead of adding
     * the property blindly to every lightweight object.
     */
    if (
        typePath.includes("/Foundation/") ||
        typePath.includes("/Beams/")
    ) {
        const slot =
            swatchToLegacyColorSlot(
                instance?.usedSwatchSlot
            );

        if (slot !== null) {
            props.mColorSlot =
                makeByteProperty(
                    "mColorSlot",
                    slot
                );
        }
    }

    const specific =
        instance
            ?.instanceSpecificData;

    if (specific?.hasValidStruct) {
        const structPath =
            specific
                ?.structReference
                ?.pathName ??
            "";

        if (
            structPath.endsWith(
                "BuildableBeamLightweightData"
            ) &&
            specific
                ?.properties
                ?.BeamLength
        ) {
            props.mLength =
                makeFloatProperty(
                    "mLength",
                    specific
                        .properties
                        .BeamLength
                        .value
                );
        } else {
            warnings.push(
                `${label}: unsupported lightweight instanceSpecificData ` +
                `${structPath || "<unknown>"}; generic entity fields were preserved`
            );
        }
    }

    if (
        Number(
            instance?.patternRotation ??
            0
        ) !== 0
    ) {
        warnings.push(
            `${label}: non-zero patternRotation is not yet materialized`
        );
    }

    entity.properties = props;

    stripWorldOnlyProperties(entity);

    return {
        entity,
        warning: null
    };
}

function positionRanges(entities) {
    const positions =
        entities
            .map(x => x.transform?.translation)
            .filter(Boolean);

    if (!positions.length)
        return null;

    const out = {};

    for (const axis of ["x", "y", "z"]) {
        const vals =
            positions.map(p => p[axis]);

        out[axis] = {
            min: Math.min(...vals),
            max: Math.max(...vals)
        };
    }

    return out;
}

function writeBlueprintPair({
    blueprint,
    outSbp,
    outCfg
}) {
    let mainHeader = null;
    const mainChunks = [];

    const summary =
        Parser.WriteBlueprintFiles(
            blueprint,
            header => {
                mainHeader = header;
            },
            chunk => {
                mainChunks.push(chunk);
            }
        );

    if (!mainHeader)
        throw new Error(
            "Writer produced no .sbp header"
        );

    const sbpBytes =
        Buffer.concat([
            Buffer.from(mainHeader),
            ...mainChunks.map(
                x => Buffer.from(x)
            )
        ]);

    const cfgBytes =
        Buffer.from(
            summary.configFileBinary
        );

    fs.writeFileSync(outSbp, sbpBytes);
    fs.writeFileSync(outCfg, cfgBytes);

    return {
        sbpBytes,
        cfgBytes
    };
}

function verifyBlueprintPair(
    outSbp,
    outCfg
) {
    const sbp =
        fs.readFileSync(outSbp);

    const cfg =
        fs.readFileSync(outCfg);

    const verify =
        Parser.ParseBlueprintFiles(
            `verify:${path.basename(outSbp)}`,
            toArrayBuffer(sbp),
            toArrayBuffer(cfg),
            { throwErrors: true }
        );

    const entities =
        verify.objects.filter(
            x => x.type === "SaveEntity"
        );

    const components =
        verify.objects.filter(
            x => x.type === "SaveComponent"
        );

    return {
        blueprint: verify,
        entities,
        components,
        ranges:
            positionRanges(entities)
    };
}

function recoverOne({
    bpName,
    save,
    worldObjects,
    byInstanceName,
    clusterData,
    buildableSubsystem,
    metadataShell,
    playerInfoHandle,
    iconResolver,
    outDir,
    overwriteExisting,
    dryRun
}) {
    const chosen =
        chooseCluster(
            clusterData,
            bpName
        );

    const placement =
        chosen.placements[0];

    const lightweightCount =
        placement.lightweight?.length ?? 0;

    const proxyOriginal =
        worldObjects[
            placement.proxyIndex
        ];

    if (
        proxyOriginal?.typePath !==
        "/Script/FactoryGame.FGBlueprintProxy"
    ) {
        throw new Error(
            "Selected proxy index is not FGBlueprintProxy"
        );
    }

    const proxy =
        deepClone(proxyOriginal);

    /*
     * Clone every entity/component before modifying it.
     */
    const entities = [];

    for (const entry of placement.ordinary ?? []) {
        const original =
            worldObjects[
                entry.objectIndex
            ];

        if (!original) {
            throw new Error(
                `Missing world object ${entry.objectIndex}`
            );
        }

        entities.push(
            deepClone(original)
        );
    }

    /*
     * Materialize compact lightweight buildables into ordinary current-format
     * SaveEntity objects using the mapping learned from the native fixture.
     */
    const materializationWarnings = [];

    const usedNames =
        new Set(
            entities
                .map(e => e?.instanceName)
                .filter(Boolean)
        );

    const lightweightHits =
        collectLightweightForProxy(
            buildableSubsystem,
            proxy.instanceName
        );

    if (lightweightHits.length !== lightweightCount) {
        materializationWarnings.push(
            `${bpName}: cluster recorded ${lightweightCount} lightweight members, ` +
            `but direct proxy scan found ${lightweightHits.length}`
        );
    }

    const sequence = {
        /*
         * Unreal object names are strings; this is simply a deterministic,
         * collision-checked suffix namespace for reconstructed entities.
         */
        value: 4000000000
    };

    let materializedLightweight = 0;
    let omittedLightweight = 0;

    for (const hit of lightweightHits) {
        const result =
            materializeLightweightInstance({
                hit,
                metadataShell,
                proxy,
                usedNames,
                sequence,
                warnings:
                    materializationWarnings,
                bpName
            });

        if (result.warning) {
            materializationWarnings.push(
                result.warning
            );
        }

        if (result.entity) {
            entities.push(
                result.entity
            );

            materializedLightweight++;
        } else {
            omittedLightweight++;
        }
    }

    /*
     * Component references use the original instanceName strings.
     * Resolve from the original save, then clone the component.
     */
    const components =
        new Map();

    for (const entity of entities) {
        for (
            const ref of
            entity.components ?? []
        ) {
            const componentName =
                ref?.pathName ??
                ref?.instanceName ??
                (
                    typeof ref === "string"
                        ? ref
                        : null
                );

            if (!componentName)
                continue;

            if (components.has(componentName))
                continue;

            const original =
                byInstanceName.get(
                    componentName
                );

            if (!original) {
                throw new Error(
                    `Could not resolve owned component ` +
                    componentName
                );
            }

            components.set(
                componentName,
                deepClone(original)
            );
        }
    }

    const recoveredObjects = [
        ...entities,
        ...components.values()
    ];

    const internalNames =
        new Set(
            recoveredObjects
                .map(
                    o => o?.instanceName
                )
                .filter(Boolean)
        );

    for (const obj of recoveredObjects)
        stripWorldOnlyProperties(obj);

    const stats = {
        disconnectedExternalRefs: 0
    };

    const allowedExternalRefs =
        new Set([
            "Persistent_Level:PersistentLevel.BuildableSubsystem"
        ]);

    for (const obj of recoveredObjects) {
        cleanExternalRefs(
            obj,
            internalNames,
            allowedExternalRefs,
            stats
        );
    }

    for (const entity of entities) {
        if (entity.transform) {
            entity.transform =
                toProxyLocal(
                    entity.transform,
                    proxy.transform
                );
        }
    }

    const recipePaths =
        new Set();

    for (const obj of recoveredObjects) {
        collectBuildRecipes(
            obj,
            recipePaths
        );
    }

    /*
     * Build the blueprint container directly from the selected save's version
     * metadata. Native test blueprints were needed to discover this format,
     * but are no longer runtime dependencies.
     */
    const blueprint =
        createBlueprintSkeleton({
            save,
            bpName,
            playerInfoHandle
        });

    blueprint.header.recipeReferences =
        [...recipePaths]
            .sort()
            .map(pathName => ({
                levelName: "",
                pathName
            }));

    /*
     * Intentionally not fabricated.
     * We can enrich material costs separately later.
     */
    blueprint.header.itemCosts = [];

    blueprint.objects =
        recoveredObjects;

    /*
     * Per-blueprint description/color metadata is not present in placed
     * world data, so use valid defaults and let the icon resolver enrich
     * the recoverable part.
     */
    blueprint.config.description = "";

    let icon = {
        status: "default",
        matchedDisplayName: null,
        error: null
    };

    if (iconResolver) {
        try {
            const resolved =
                iconResolver.resolve(bpName);

            if (resolved) {
                blueprint.config.iconID =
                    resolved.iconID;

                if (
                    resolved.referencedIconLibrary
                ) {
                    blueprint.config.referencedIconLibrary =
                        resolved.referencedIconLibrary;
                }

                if (
                    resolved.iconLibraryType
                ) {
                    blueprint.config.iconLibraryType =
                        resolved.iconLibraryType;
                }

                icon = {
                    status: "matched",
                    matchedDisplayName:
                        resolved.matchedDisplayName,
                    iconID:
                        resolved.iconID,
                    error: null
                };
            }
        } catch (err) {
            /*
             * CRITICAL ARCHITECTURAL RULE:
             * Icon lookup failure is cosmetic and MUST NOT abort recovery.
             */
            icon = {
                status: "error",
                matchedDisplayName: null,
                error:
                    String(
                        err?.message ?? err
                    )
            };
        }
    }

    const filename =
        safeFilename(bpName);

    const outSbp =
        path.join(
            outDir,
            `${filename}.sbp`
        );

    const outCfg =
        path.join(
            outDir,
            `${filename}.sbpcfg`
        );

    if (
        !overwriteExisting &&
        (
            fs.existsSync(outSbp) ||
            fs.existsSync(outCfg)
        )
    ) {
        return {
            status: "skipped",
            reason: "output-already-exists",
            name: bpName,
            fingerprint: chosen.fingerprint,
            outSbp,
            outCfg
        };
    }

    if (dryRun) {
        return {
            status: "recovered",
            dryRun: true,
            name: bpName,
            fingerprint:
                chosen.fingerprint,
            clusterPlacements:
                chosen.placementCount,
            ordinaryEntities:
                placement.ordinary?.length ?? 0,
            materializedLightweight,
            omittedLightweight,
            lightweightObjects:
                lightweightHits.length,
            partial:
                omittedLightweight > 0,
            materializationWarnings,
            totalEntities:
                entities.length,
            components:
                components.size,
            recipeReferences:
                blueprint.header.recipeReferences.length,
            itemCosts:
                blueprint.header.itemCosts.length,
            disconnectedExternalRefs:
                stats.disconnectedExternalRefs,
            ranges:
                positionRanges(entities),
            icon,
            outSbp,
            outCfg,
            sbpBytes: null,
            cfgBytes: null
        };
    }

    let wroteSbp = false;
    let wroteCfg = false;

    try {
        const written =
            writeBlueprintPair({
                blueprint,
                outSbp,
                outCfg
            });

        wroteSbp = true;
        wroteCfg = true;

        const verified =
            verifyBlueprintPair(
                outSbp,
                outCfg
            );

        if (
            verified.entities.length !==
            entities.length
        ) {
            throw new Error(
                `Verification entity count mismatch: ` +
                `${verified.entities.length} != ${entities.length}`
            );
        }

        if (
            verified.components.length !==
            components.size
        ) {
            throw new Error(
                `Verification component count mismatch: ` +
                `${verified.components.length} != ${components.size}`
            );
        }

        return {
            status: "recovered",
            name: bpName,
            fingerprint:
                chosen.fingerprint,
            clusterPlacements:
                chosen.placementCount,
            ordinaryEntities:
                placement.ordinary?.length ?? 0,
            materializedLightweight,
            omittedLightweight,
            lightweightObjects:
                lightweightHits.length,
            partial:
                omittedLightweight > 0,
            materializationWarnings,
            totalEntities:
                entities.length,
            components:
                components.size,
            recipeReferences:
                verified.blueprint
                    .header
                    .recipeReferences
                    .length,
            itemCosts:
                verified.blueprint
                    .header
                    .itemCosts
                    .length,
            disconnectedExternalRefs:
                stats.disconnectedExternalRefs,
            ranges:
                verified.ranges,
            icon,
            outSbp,
            outCfg,
            sbpBytes:
                written.sbpBytes.length,
            cfgBytes:
                written.cfgBytes.length
        };
    } catch (err) {
        /*
         * Do not leave a corrupt/half-written pair behind.
         */
        try {
            if (
                wroteSbp &&
                fs.existsSync(outSbp)
            ) {
                fs.unlinkSync(outSbp);
            }
        } catch {}

        try {
            if (
                wroteCfg &&
                fs.existsSync(outCfg)
            ) {
                fs.unlinkSync(outCfg);
            }
        } catch {}

        throw err;
    }
}

function printRecovered(result) {
    const iconText =
        result.icon?.status === "matched"
            ? `icon=${result.icon.matchedDisplayName} (${result.icon.iconID})`
            : result.icon?.status === "error"
                ? `icon=DEFAULT [lookup error]`
                : `icon=DEFAULT`;

    const prefix =
        result.partial
            ? "PART"
            : "OK  ";

    const lwText =
        result.lightweightObjects
            ? ` | lightweight ${result.materializedLightweight}/${result.lightweightObjects} materialized` +
              (result.omittedLightweight
                  ? `, ${result.omittedLightweight} omitted`
                  : "")
            : "";

    console.log(
        `${prefix} ${result.name} | ` +
        `${result.totalEntities} entities + ` +
        `${result.components} components` +
        lwText +
        ` | ${iconText}`
    );

    for (const warning of result.materializationWarnings ?? [])
        console.warn(`WARN ${warning}`);
}

function printSkipped(result) {
    console.log(
        `SKIP ${result.name} | ${result.reason}`
    );
}

async function main() {
    let args;

    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`ERROR: ${err.message}`);
        usage(1);
    }

    const warnings = [];

    const warn = message => {
        warnings.push(message);
        console.warn(`WARN ${message}`);
    };

    let discovered = [];

    if (!args.save || args.select || args.list) {
        discovered = discoverSaves();
    }

    if (args.list) {
        printSaveList(discovered);
        return;
    }

    let selected;
    let save;
    let sessionName;

    if (args.save) {
        const explicitPath = path.resolve(args.save);

        if (!fs.existsSync(explicitPath)) {
            throw new Error(
                `Save file does not exist: ${explicitPath}`
            );
        }

        const stat = fs.statSync(explicitPath);

        if (!stat.isFile()) {
            throw new Error(
                `--save is not a file: ${explicitPath}`
            );
        }

        selected = {
            path: explicitPath,
            name: path.basename(explicitPath),
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            saveGamesRoot: findSaveGamesRoot(explicitPath)
        };

        ({ save, sessionName } = parseSaveFile(selected));
    } else {
        if (!discovered.length) {
            throw new Error(
                "No Satisfactory world-save candidates were discovered. " +
                "Use --save <file.sav> to specify one explicitly."
            );
        }

        if (args.select) {
            selected = await selectSaveInteractively(discovered);
            ({ save, sessionName } = parseSaveFile(selected));
        } else {
            const resolved = newestParsableSave(discovered, warn);
            selected = resolved.selected;
            save = resolved.save;
            sessionName = resolved.sessionName;
        }
    }

    console.log("Satisfactory Blueprint Recovery");
    console.log();
    console.log("Using save:");
    console.log(`  ${selected.name}`);
    console.log(`  ${selected.path}`);
    console.log(`  modified ${formatLocalDate(selected.mtimeMs)}`);
    console.log();

    console.log(`Session: ${sessionName}`);
    console.log(
        `Save/build version: ${save.header.saveVersion}/${save.header.buildVersion}`
    );

    if (save.header.saveVersion !== VALIDATED_SAVE_VERSION) {
        warn(
            `The self-contained blueprint writer was validated on ` +
            `Satisfactory saveVersion ${VALIDATED_SAVE_VERSION}; this save reports ` +
            `${save.header.saveVersion}. Continuing best-effort using the ` +
            `selected save's version metadata.`
        );
    }

    const saveGamesRoot =
        selected.saveGamesRoot ??
        findSaveGamesRoot(selected.path);

    let outDir;

    if (args.outDir) {
        outDir = path.resolve(args.outDir);
    } else if (saveGamesRoot) {
        outDir = path.join(
            saveGamesRoot,
            "blueprints",
            sessionName
        );
    } else if (args.dryRun) {
        outDir = path.join(
            process.cwd(),
            `recovered-${safeFilename(sessionName)}`
        );
    } else {
        throw new Error(
            "Could not infer the game's SaveGames directory from the selected save. " +
            "Use --out <directory> to choose a destination explicitly."
        );
    }

    console.log();
    console.log("Analyzing placed blueprints...");

    const analysis =
        analyzeBlueprintPlacements(save);

    const {
        clusterData,
        worldObjects,
        buildableSubsystem
    } = analysis;

    console.log(
        `Found ${analysis.blueprintNames} blueprint names across ` +
        `${analysis.proxyCount} placed instances.`
    );

    if (!buildableSubsystem) {
        warn(
            "BuildableSubsystem lightweight data was not found; " +
            "ordinary entities can still be recovered."
        );
    }

    if (args.debugDump) {
        const debugPath = path.resolve(args.debugDump);
        fs.mkdirSync(path.dirname(debugPath), { recursive: true });
        fs.writeFileSync(
            debugPath,
            JSON.stringify(
                {
                    generatedAt: new Date().toISOString(),
                    sourceSave: selected.path,
                    sessionName,
                    blueprintNames: analysis.blueprintNames,
                    proxyCount: analysis.proxyCount,
                    clusters: clusterData
                },
                null,
                2
            ) + "\n"
        );
        console.log(`Debug analysis: ${debugPath}`);
    }

    const byInstanceName = new Map();

    for (const obj of worldObjects) {
        if (obj?.instanceName) {
            byInstanceName.set(
                obj.instanceName,
                obj
            );
        }
    }

    const metadataShell =
        findEntityMetadataShell(worldObjects);

    const playerInfoHandle =
        findPlayerInfoHandle(
            worldObjects,
            buildableSubsystem
        );

    const iconResolver =
        createIconResolver({
            disabled: args.noIcons,
            defaultLibrary: ICON_LIBRARY,
            defaultLibraryType: ICON_LIBRARY_TYPE,
            warn
        });

    if (iconResolver.status === "ready") {
        console.log(
            `Icon resolver ready: ${iconResolver.entryCount} normalized name candidates`
        );
    } else {
        console.log(
            `Icon resolver: ${iconResolver.status}`
        );
    }

    const names =
        Object.keys(clusterData)
            .sort((a, b) => a.localeCompare(b));

    if (!names.length) {
        console.log();
        console.log("No placed blueprint instances were found in this save.");
        return;
    }

    if (!args.dryRun) {
        fs.mkdirSync(
            outDir,
            { recursive: true }
        );
    }

    console.log();
    console.log(
        args.dryRun
            ? `Dry-run recovery of ${names.length} blueprint names...`
            : `Recovering ${names.length} blueprint names...`
    );

    if (args.verbose) {
        console.log();
        console.log("Selected placement clusters:");

        for (const bpName of names) {
            const cluster =
                chooseCluster(clusterData, bpName);

            const ordinary =
                cluster.placements?.[0]?.ordinary?.length ?? 0;

            const lightweight =
                cluster.placements?.[0]?.lightweight?.length ?? 0;

            console.log(
                `  ${bpName}: ${cluster.placementCount} placement(s), ` +
                `${ordinary + lightweight} members ` +
                `(${ordinary} ordinary + ${lightweight} lightweight), ` +
                `fingerprint ${cluster.fingerprint}`
            );
        }

        console.log();
    }

    const results = [];

    for (const bpName of names) {
        try {
            const result = recoverOne({
                bpName,
                save,
                worldObjects,
                byInstanceName,
                clusterData,
                buildableSubsystem,
                metadataShell,
                playerInfoHandle,
                iconResolver,
                outDir,
                overwriteExisting:
                    args.overwriteExisting,
                dryRun:
                    args.dryRun
            });

            results.push(result);

            if (result.status === "recovered") {
                printRecovered(result);
            } else {
                printSkipped(result);
            }
        } catch (err) {
            const failure = {
                status: "failed",
                name: bpName,
                error: String(err?.stack ?? err)
            };

            results.push(failure);

            /*
             * A bad individual blueprint does not destroy the rest of the
             * recovery batch. Attempt every current blueprint before exiting.
             */
            console.error(
                `FAIL ${bpName} | ${err.message}`
            );
        }
    }

    const recovered =
        results.filter(x => x.status === "recovered");

    const skipped =
        results.filter(x => x.status === "skipped");

    const failed =
        results.filter(x => x.status === "failed");

    const iconMatched =
        recovered.filter(x => x.icon?.status === "matched");

    const iconDefault =
        recovered.filter(x => x.icon?.status === "default");

    const iconErrors =
        recovered.filter(x => x.icon?.status === "error");

    const lightweightFound =
        recovered.reduce(
            (n, r) => n + (r.lightweightObjects ?? 0),
            0
        );

    const lightweightMaterialized =
        recovered.reduce(
            (n, r) => n + (r.materializedLightweight ?? 0),
            0
        );

    const lightweightOmitted =
        recovered.reduce(
            (n, r) => n + (r.omittedLightweight ?? 0),
            0
        );

    const report = {
        generatedAt: new Date().toISOString(),
        source: {
            save: selected.path,
            sessionName,
            saveGamesRoot,
            iconsDisabled: args.noIcons
        },
        output: {
            directory: outDir,
            dryRun: args.dryRun,
            overwriteExisting: args.overwriteExisting
        },
        format: {
            blueprintHeaderVersion: BLUEPRINT_HEADER_VERSION,
            blueprintConfigVersion: BLUEPRINT_CONFIG_VERSION,
            saveVersion: save.header.saveVersion,
            buildVersion: save.header.buildVersion
        },
        analysis: {
            blueprintNames: analysis.blueprintNames,
            placements: analysis.proxyCount
        },
        summary: {
            recovered: recovered.length,
            skipped: skipped.length,
            failed: failed.length,
            lightweight: {
                found: lightweightFound,
                materialized: lightweightMaterialized,
                omitted: lightweightOmitted
            },
            icons: {
                resolverStatus: iconResolver.status,
                matched: iconMatched.length,
                default: iconDefault.length,
                errors: iconErrors.length
            }
        },
        warnings,
        results
    };

    let reportPath = null;

    /*
     * Do not litter the actual Satisfactory blueprint directory with a JSON
     * report. A staging --out directory is developer/user-controlled, so the
     * report is useful there. --debug-dump already covers deep diagnostics.
     */
    if (args.outDir && !args.dryRun) {
        reportPath =
            path.join(
                outDir,
                "recovery-report.json"
            );

        fs.writeFileSync(
            reportPath,
            JSON.stringify(report, null, 2) + "\n"
        );
    }

    console.log();
    console.log("Recovery complete");
    console.log("-----------------");
    console.log(`${recovered.length} blueprints recovered`);
    console.log(`${skipped.length} skipped`);
    console.log(`${failed.length} failed`);
    console.log();
    console.log("Lightweight buildables");
    console.log(
        `  ${lightweightMaterialized}/${lightweightFound} materialized`
    );
    console.log(`  ${lightweightOmitted} omitted`);
    console.log();
    console.log("Icons");
    console.log(`  resolver: ${iconResolver.status}`);
    console.log(`  ${iconMatched.length} matched`);
    console.log(`  ${iconDefault.length} used default`);
    console.log(`  ${iconErrors.length} lookup errors`);
    console.log();

    if (args.dryRun) {
        console.log("Dry run: no files written.");
        console.log(`Would write to: ${outDir}`);
    } else {
        console.log(`Blueprint directory: ${outDir}`);
    }

    if (reportPath)
        console.log(`Report: ${reportPath}`);

    /*
     * Cosmetic icon failure never makes recovery fail. Unsupported individual
     * lightweight objects are partial warnings. Core per-blueprint failures
     * produce a non-zero status after the rest of the batch has been tried.
     */
    if (failed.length)
        process.exitCode = 2;
}

main().catch(err => {
    console.error(
        `FATAL: ${err?.stack ?? err}`
    );
    process.exitCode = 1;
});