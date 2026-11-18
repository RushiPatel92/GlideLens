/*
 * The contrast floor for panel text.
 *
 *   node --test tests/contrast_floor.test.js
 *
 * DEV-ONLY, like its siblings. Every panel sits on #1e1e2e, and #9a9ab3
 * (about 6.0:1 there) is the dimmest grey any text in them may use. The greys
 * below it drifted apart panel by panel until twenty uses failed WCAG AA's
 * 4.5:1 for small text and another fifty sat in ten near-identical shades, so
 * this reads the source rather than trusting the next panel to remember.
 *
 * What it reads, in each *_ui.js panel file and content.js (the palette):
 *   - every CSS `color:` declaration with a hex value, inline style
 *     attributes in template strings included;
 *   - every `color:var(--name)` whose custom property the same file defines
 *     as a hex value, since a token hides its colour from a plain scan;
 *   - every `.style.color = "#..."` set from script.
 * A value under 5.8:1 on #1e1e2e fails unless it is on the allow-list below,
 * for the file, the colour and a piece of the line that says which rule it
 * is. An entry nothing matches any more fails too, so the list cannot keep
 * an exemption for a rule that has gone.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PANEL_BACKGROUND = "#1e1e2e";
const FLOOR = "#9a9ab3";
const MIN_RATIO = 5.8;

/* Each exemption, with its reason beside it. `where` must appear on the line
 * that carries the colour (for a token, the line that uses it). */
const ALLOWED = [
  // Dark text on a coloured fill: measured against that fill, not the panel.
  { file: "translation_lens_ui.js", hex: "#2a1620", where: "background:var(--gap)", why: "dark text on the pink 'gap' fill" },
  { file: "code_search_ui.js", hex: "#2a0d1a", where: "background:var(--pink)", why: "dark text on the pink primary button" },
  { file: "impersonate_ui.js", hex: "#2a0d1a", where: ".search-btn", why: "dark text on the pink Search button" },
  { file: "impersonate_ui.js", hex: "#2a0d1a", where: ".row:hover .row-go", why: "dark text on a row's Impersonate, filled while the row is hovered or focused" },
  { file: "impersonate_ui.js", hex: "#2a0d1a", where: ".confirm-actions .go", why: "dark text on the pink confirm button" },
  { file: "record_search_ui.js", hex: "#2a0d1a", where: ".search-btn", why: "dark text on the pink Search button" },
  { file: "update_set_lens_ui.js", hex: "#2a0d1a", where: ".btn.pink", why: "dark text on the pink button" },
  { file: "version_lens_ui.js", hex: "#2a0d1a", where: ".btn.pink", why: "dark text on the pink button" },
  // Decorative marks, not text.
  { file: "translation_lens_ui.js", hex: "#4d4d68", where: ".subtitle .sep", why: "separator dot between subtitle facts" },
  { file: "translation_lens_ui.js", hex: "#4d4d68", where: ".summary .sep", why: "separator dot between summary facts" },
  { file: "translation_lens_ui.js", hex: "#5b5b7e", where: ".evidence li::before", why: "list bullet" },
  // Update Set Lens and Version Lens keep their passing greys: the owner
  // called those two panels right as they are (2026-11-16 review).
  { file: "update_set_lens_ui.js", hex: "#8d8da6", where: ".b-current", why: "owner kept Update Set Lens greys" },
  { file: "update_set_lens_ui.js", hex: "#8f8fa9", where: ".r-sub", why: "owner kept Update Set Lens greys" },
  { file: "update_set_lens_ui.js", hex: "#9292aa", where: "var(--muted)", why: "owner kept Update Set Lens greys (--muted token)" },
  { file: "version_lens_ui.js", hex: "#8d8da6", where: ".b-there.missing", why: "owner kept Version Lens greys" },
  { file: "version_lens_ui.js", hex: "#8d8da6", where: ".b-current", why: "owner kept Version Lens greys" },
  // The "nothing here" cell (.r-none) uses this token too: it failed AA at
  // #77778f, and #9a9ab3 made it brighter than .r-who and the missing badge
  // beside it, so it takes the panel's own --muted (5.4:1) and keeps their order.
  { file: "version_lens_ui.js", hex: "#9292aa", where: "var(--muted)", why: "owner kept Version Lens greys (--muted token, .r-none included)" },
];

const linear = (channel) => {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
};

const luminance = (hex) => {
  let digits = hex.slice(1);
  if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrast = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const HEX = "#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b";

function panelFiles() {
  return fs
    .readdirSync(ROOT)
    .filter((name) => /_ui\.js$/.test(name) || name === "content.js")
    .sort();
}

/* Every text colour the file sets, as { file, line, hex, text }. */
function textColours(file) {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split(/\r?\n/);
  const tokens = Object.create(null);
  lines.forEach((text) => {
    const definition = new RegExp("--([\\w-]+):\\s*(" + HEX + ")", "g");
    let match;
    while ((match = definition.exec(text))) tokens[match[1]] = match[2].toLowerCase();
  });

  const out = [];
  lines.forEach((text, index) => {
    const patterns = [
      new RegExp("(?:^|[^-\\w])color:\\s*(" + HEX + ")", "g"),
      new RegExp("\\.style\\.color\\s*=\\s*[\"'](" + HEX + ")", "g"),
    ];
    patterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(text))) {
        out.push({ file, line: index + 1, hex: match[1].toLowerCase(), text });
      }
    });
    const viaToken = /(?:^|[^-\w])color:\s*var\(--([\w-]+)\)/g;
    let match;
    while ((match = viaToken.exec(text))) {
      if (tokens[match[1]]) out.push({ file, line: index + 1, hex: tokens[match[1]], text });
    }
  });
  return out;
}

const allowedFor = (use) =>
  ALLOWED.find(
    (entry) => entry.file === use.file && entry.hex === use.hex && use.text.includes(entry.where)
  );

test("the floor grey itself clears the floor", () => {
  const ratio = contrast(FLOOR, PANEL_BACKGROUND);
  assert.ok(ratio >= MIN_RATIO, FLOOR + " is " + ratio.toFixed(2) + ":1");
});

test("the scan finds the panels and reads their colours", () => {
  const files = panelFiles();
  ["code_search_ui.js", "catalog_insight_ui.js", "translation_lens_ui.js", "content.js"].forEach((name) =>
    assert.ok(files.includes(name), name + " is scanned")
  );
  const uses = files.flatMap(textColours);
  assert.ok(uses.length > 100, "a scan that reads nothing passes everything (" + uses.length + ")");
  assert.ok(
    uses.some((use) => use.file === "impersonate_ui.js" && use.text.includes("var(--muted)")),
    "a colour behind a custom property is read"
  );
});

test("no panel text is dimmer than #9a9ab3 on the panel background", () => {
  const failures = panelFiles()
    .flatMap(textColours)
    .filter((use) => contrast(use.hex, PANEL_BACKGROUND) < MIN_RATIO && !allowedFor(use))
    .map(
      (use) =>
        use.file + ":" + use.line + "  " + use.hex + "  " +
        contrast(use.hex, PANEL_BACKGROUND).toFixed(2) + ":1  " + use.text.trim().slice(0, 80)
    );
  assert.deepStrictEqual(failures, [], "use " + FLOOR + " or brighter:\n" + failures.join("\n"));
});

test("every exemption on the allow-list is still in use, and has a reason", () => {
  const uses = panelFiles().flatMap(textColours);
  ALLOWED.forEach((entry) => {
    assert.ok(entry.why, "an exemption says why");
    assert.ok(
      contrast(entry.hex, PANEL_BACKGROUND) < MIN_RATIO,
      entry.file + " " + entry.hex + " passes now; drop it from the list"
    );
    assert.ok(
      uses.some((use) => allowedFor(use) === entry),
      entry.file + " " + entry.hex + " '" + entry.where + "' is no longer used; drop it from the list"
    );
  });
});
