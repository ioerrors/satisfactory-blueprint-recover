import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");

function firstExisting(label, candidates) {
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(
        `Could not find ${label} license. Tried:\n` +
        candidates.map(x => `  ${x}`).join("\n")
    );
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

const nodeDir = path.dirname(process.execPath);

const nodeLicense = firstExisting("Node.js", [
    path.join(nodeDir, "LICENSE"),
    path.join(nodeDir, "LICENSE.md"),
    path.resolve(nodeDir, "..", "LICENSE"),
    path.resolve(nodeDir, "..", "LICENSE.md"),
    path.resolve(nodeDir, "..", "..", "LICENSE"),
]);

const parserRoot = path.join(
    root,
    "node_modules",
    "@etothepii",
    "satisfactory-file-parser"
);

const pakoRoot = path.join(
    root,
    "node_modules",
    "pako"
);

const parserPackage = readJson(
    path.join(parserRoot, "package.json")
);

const pakoPackage = readJson(
    path.join(pakoRoot, "package.json")
);

const parserLicense = firstExisting(
    "@etothepii/satisfactory-file-parser",
    [
        path.join(parserRoot, "LICENSE"),
        path.join(parserRoot, "LICENSE.md"),
        path.join(parserRoot, "LICENCE"),
        path.join(parserRoot, "LICENCE.md"),
    ]
);

const pakoLicense = firstExisting(
    "pako",
    [
        path.join(pakoRoot, "LICENSE"),
        path.join(pakoRoot, "LICENSE.md"),
    ]
);

const sections = [
    {
        title: `Node.js ${process.version}`,
        file: nodeLicense,
    },
    {
        title:
            `@etothepii/satisfactory-file-parser ` +
            `${parserPackage.version}`,
        file: parserLicense,
    },
    {
        title: `pako ${pakoPackage.version}`,
        file: pakoLicense,
    },
];

fs.mkdirSync(dist, {
    recursive: true,
});

let output =
    "THIRD-PARTY LICENSE NOTICES\n" +
    "===========================\n\n" +
    "This standalone distribution contains the following " +
    "third-party software.\n\n";

for (const section of sections) {
    output +=
        "\n" +
        "=".repeat(78) +
        "\n" +
        section.title +
        "\n" +
        "=".repeat(78) +
        "\n\n" +
        fs.readFileSync(section.file, "utf8").trim() +
        "\n";
}

const destination = path.join(
    dist,
    "THIRD_PARTY_LICENSES.txt"
);

fs.writeFileSync(destination, output);

console.log(`Wrote ${destination}`);
