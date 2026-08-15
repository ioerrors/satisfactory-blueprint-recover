import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = process.cwd();
const dist = path.join(root, "dist");

const platformNames = {
    linux: "linux",
    win32: "windows",
};

const platform = platformNames[process.platform];

if (!platform) {
    throw new Error(
        `Binary builds currently support Linux and Windows, not ${process.platform}`
    );
}

if (process.arch !== "x64") {
    throw new Error(
        `Binary builds currently support x64, not ${process.arch}`
    );
}

const nodeMajor = Number(process.versions.node.split(".")[0]);

if (nodeMajor < 25) {
    throw new Error(
        `Binary builds require Node 25.5+; running ${process.version}`
    );
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const bundle = path.join(
    dist,
    "recover-blueprints.bundle.mjs"
);

await build({
    entryPoints: [
        path.join(root, "recover-blueprints.mjs")
    ],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    sourcemap: false,
});

const extension =
    process.platform === "win32"
        ? ".exe"
        : "";

const output = path.join(
    dist,
    `satisfactory-blueprint-recover-${platform}-x64${extension}`
);

const seaConfig = path.join(
    dist,
    "sea-config.json"
);

fs.writeFileSync(
    seaConfig,
    JSON.stringify(
        {
            main: bundle,
            mainFormat: "module",
            output,
            disableExperimentalSEAWarning: true,
            useSnapshot: false,
            useCodeCache: false
        },
        null,
        2
    )
);

console.log(
    `Building ${path.basename(output)} with ${process.version}...`
);

execFileSync(
    process.execPath,
    [
        "--build-sea",
        seaConfig
    ],
    {
        stdio: "inherit"
    }
);

if (process.platform !== "win32") {
    fs.chmodSync(output, 0o755);
}

console.log(`\nBuilt:\n  ${output}`);
