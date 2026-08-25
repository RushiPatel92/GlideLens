/*
 * package.mjs — build the Chrome Web Store / distribution zip.
 *
 *   node package.mjs            build dist/glidelens-<version>.zip
 *   node package.mjs --check    run every guard, build nothing
 *
 * Why Node and not the old bash package.sh
 * ----------------------------------------
 * package.sh (removed in 0.6.0, recoverable at `git show 371270f^:package.sh`)
 * shelled out to `zip`. That binary is not present on the Windows/Git-Bash setup
 * this repo is developed on, so the script could not run here at all. PowerShell's
 * Compress-Archive is available but writes entry paths with backslash separators
 * on Windows PowerShell 5.1 — the old script already carried a workaround for
 * archivers that do this — and Chrome will not load a zip shaped that way.
 * Node is already required for `tests/`, ships zlib, and lets us control every
 * byte of the entry paths. So the archive is written here directly. No
 * dependencies, consistent with the rest of the project.
 *
 * ALLOWLIST, not exclusion — inherited from package.sh and still right. An
 * exclusion list ships anything it was not told to skip, so every dev file added
 * later (plan docs, agent configs, .github/) silently ends up in the
 * distributable. Naming what ships inverts the failure mode: the risk becomes a
 * NEW asset being left out, which the guards below turn into a loud build
 * failure instead of a broken install.
 *
 * THE GUARDS ARE DERIVED FROM SOURCE, NOT HAND-MAINTAINED. This is the whole
 * point of the rewrite. package.sh cross-checked SHIP against manifest.json
 * only, and its own comment admitted the gap: "popup.js/popup.css are pulled in
 * by popup.html, and debug_timeline_main.js is injected on demand, so those
 * still rely on SHIP". That gap was not theoretical. Code Search shipped in
 * 0.9.x as two lazily-injected files that are DELIBERATELY absent from
 * manifest.json, so a manifest-only cross-check could never have noticed them
 * missing: restoring package.sh unchanged would have produced a zip that passed
 * its own build guard and shipped a Code Search command failing at runtime.
 *
 * So every way this extension can reference a file is parsed out of the source
 * and checked:
 *
 *   1. manifest.json          — any "….js|html|css|png|svg|json" string
 *   2. importScripts(...)     — service worker imports
 *   3. executeScript({files}) — lazily injected content scripts
 *   4. popup.html             — <script src> and <link href>
 *
 * Add a fifth way to load a file and this script must learn about it. That is a
 * smaller and much louder failure than a silently incomplete allowlist.
 */

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "dist");

/* Everything that ships, and nothing else. Directories are included whole. */
const SHIP = [
  "manifest.json",
  "background.js",
  "content.js",
  "debug_timeline_main.js",
  "debug_timeline_ui.js",
  "hidden_variables_ui.js",
  "catalog_insight_ui.js",
  "code_search.js",
  "code_search_ui.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "icons",
  // Not loaded by Chrome. Ships because the MIT licence requires the notice to
  // travel with "all copies", and a store download is a copy.
  "LICENSE",
];

/*
 * Must never ship. The allowlist already excludes these — this is a second,
 * independent assertion against the actual archive contents, because the cost
 * of being wrong is publishing development instructions or private working
 * notes in the store artifact.
 */
const MUST_NOT_SHIP = [
  /^CLAUDE\.md$/i,
  /^AGENTS\.md$/i,
  /^ARCHITECTURE\.md$/i,
  /^DEVELOPMENT\.md$/i,
  /^RELEASING\.md$/i,
  /^README\.md$/i,
  /^CHANGELOG\.md$/i,
  /^package\.mjs$/i,
  /^tests\//,
  /^docs\//,
  /^plans\//,
  /^memory\//,
  /^\.github\//,
  /^\.claude\//,
  /^\.codex\//,
  /^\.git(attributes|ignore)?\//,
  /(^|\/)\.DS_Store$/,
  /\.zip$/i,
];

const read = (file) => readFileSync(join(ROOT, file), "utf8");
const problems = [];
const fail = (message) => problems.push(message);

/* ---------------------------------------------------------------------------
 * Collect every file the extension references, from source
 * ------------------------------------------------------------------------- */

/* Sources that can pull in a file at runtime. Scanned wholesale rather than
 * named individually, so a new file using executeScript is covered on arrival. */
const SCANNED_SOURCES = SHIP.filter((entry) => entry.endsWith(".js"));

function manifestReferences() {
  const found = new Set();
  const text = read("manifest.json");
  for (const match of text.matchAll(/"([^"]+\.(?:js|html|css|png|svg|json))"/g)) {
    found.add(match[1]);
  }
  return found;
}

function importScriptsReferences() {
  const found = new Set();
  for (const source of SCANNED_SOURCES) {
    const text = read(source);
    for (const call of text.matchAll(/importScripts\(([^)]*)\)/g)) {
      for (const literal of call[1].matchAll(/["']([^"']+)["']/g)) {
        found.add(literal[1]);
      }
    }
  }
  return found;
}

/* executeScript({ ..., files: ["a.js", "b.js"], ... }) — the lazily injected
 * scripts. These are the ones a manifest-only guard cannot see. */
function executeScriptFileReferences() {
  const found = new Set();
  for (const source of SCANNED_SOURCES) {
    const text = read(source);
    for (const block of text.matchAll(/\bfiles\s*:\s*\[([^\]]*)\]/g)) {
      for (const literal of block[1].matchAll(/["']([^"']+)["']/g)) {
        found.add(literal[1]);
      }
    }
  }
  return found;
}

function popupHtmlReferences() {
  const found = new Set();
  const text = read("popup.html");
  for (const match of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const value = match[1];
    if (/^(https?:|data:|#|\/\/)/i.test(value)) continue;
    found.add(value.replace(/^\.\//, ""));
  }
  return found;
}

/* ---------------------------------------------------------------------------
 * Build the file list from the allowlist
 * ------------------------------------------------------------------------- */

function expand(entry) {
  const absolute = join(ROOT, entry);
  let info;
  try {
    info = statSync(absolute);
  } catch (e) {
    fail(`allowlist names '${entry}', which does not exist`);
    return [];
  }
  if (info.isFile()) return [entry];

  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".DS_Store") continue;
      const child = join(dir, name);
      const childInfo = statSync(child);
      if (childInfo.isDirectory()) walk(child);
      else out.push(posix.join(...relative(ROOT, child).split(/[\\/]/)));
    }
  };
  walk(absolute);
  return out;
}

const files = SHIP.flatMap(expand);
const shipped = new Set(files);

/* ---------------------------------------------------------------------------
 * Guards
 * ------------------------------------------------------------------------- */

const checks = [
  ["manifest.json", manifestReferences()],
  ["importScripts()", importScriptsReferences()],
  ["executeScript({ files })", executeScriptFileReferences()],
  ["popup.html", popupHtmlReferences()],
];

for (const [origin, referenced] of checks) {
  for (const reference of [...referenced].sort()) {
    if (!shipped.has(reference)) {
      fail(
        `${origin} references '${reference}' but it is not in the archive.\n` +
          `             Add it to SHIP in package.mjs.`
      );
    }
  }
}

for (const file of files) {
  for (const pattern of MUST_NOT_SHIP) {
    if (pattern.test(file)) fail(`'${file}' must never ship (matched ${pattern})`);
  }
}

const manifest = JSON.parse(read("manifest.json"));
if (!manifest.version) fail("manifest.json has no version");

/* ---------------------------------------------------------------------------
 * Minimal ZIP writer (deflate + store), so no `zip` binary is needed
 * ------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

/* Fixed timestamp so two builds of the same working copy are byte-identical,
 * which makes "did this zip change?" answerable with a hash. 1980-01-01 is the
 * earliest a DOS timestamp can express.
 *
 * Reproducible per CHECKOUT, not per commit: .gitattributes pins eol only for
 * *.sh and *.svg, so with core.autocrlf=true a Windows clone gets CRLF in the
 * .js/.json/.html/.css files and a Linux clone gets LF. Same behaviour in
 * Chrome, different bytes, different hash. Pinning `* text eol=lf` would make
 * the artifact reproducible everywhere, at the cost of rewriting the line
 * endings of every file in the repo — deliberately not done here. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([Buffer.concat(locals), centralBuffer, end]);
}

/* ---------------------------------------------------------------------------
 * Run
 * ------------------------------------------------------------------------- */

if (problems.length) {
  console.error("package.mjs: refusing to build\n");
  for (const problem of problems) console.error("  - " + problem);
  console.error("");
  process.exit(1);
}

const checkOnly = process.argv.includes("--check");
const referencedCount = checks.reduce((total, [, set]) => total + set.size, 0);

console.log(
  `Guards passed: ${referencedCount} referenced path(s) across ` +
    `${checks.length} reference styles, all present; ` +
    `${files.length} file(s) staged.`
);

if (checkOnly) {
  console.log("--check given; nothing written.");
  process.exit(0);
}

const entries = files.map((name) => ({
  name,
  data: readFileSync(join(ROOT, name)),
}));
const zip = buildZip(entries);

mkdirSync(OUT_DIR, { recursive: true });
const outPath = resolve(OUT_DIR, `glidelens-${manifest.version}.zip`);
writeFileSync(outPath, zip);

console.log(`\nBuilt ${relative(ROOT, outPath).split(/[\\/]/).join("/")}`);
console.log(`  ${zip.length.toLocaleString()} bytes`);
console.log(`  sha256 ${createHash("sha256").update(zip).digest("hex")}`);
console.log("\nContents:");
for (const file of files) console.log("  " + file);
