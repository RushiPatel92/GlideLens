# Developing GlideLens

This document covers local development, testing, packaging, repository layout,
and verification against a ServiceNow developer instance. Read
`ARCHITECTURE.md` before changing runtime behavior.

## Run and debug

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the repository root.
3. After editing, click the extension card's reload icon.
4. Refresh the ServiceNow tab after changing a content script.

There is no build step during development. A file needed by Chrome must be
committed and referenced by `manifest.json` or by the page or script that loads
it.

GitHub's **Code → Download ZIP** contains every committed file. Chrome ignores
the project documentation and tests when the extracted repository is loaded
unpacked. The store artifact is different and uses an explicit allowlist.

## Tests and validation

Run all Node tests explicitly so behavior does not depend on Node's directory
discovery rules:

```powershell
node --test tests/code_search.test.js tests/code_search_api.test.js tests/code_search_ui.test.js tests/frame_discovery.test.js tests/search_transport_frames.test.js tests/record_search.test.js tests/command_palette.test.js tests/content_context.test.js tests/open_url.test.js tests/debug_timeline.test.js tests/debug_timeline_frames.test.js tests/prefill_settle.test.js tests/variable_values_native.test.js
```

The suites cover:

- `code_search.test.js` — query parsing, adapters, verification, snippets,
  inheritance probing, redaction, pooling, and orchestration.
- `code_search_api.test.js` — the instance Code Search endpoint, coverage map,
  ignored table scope, saturation, and adapter merging.
- `code_search_ui.test.js` — result identity and separate match/record counts.
- `frame_discovery.test.js` — the shared frame discovery and per-frame
  injection every worker read now uses: announcement collection, the frame-0
  fallback, cross-tab announcement rejection, and the regressions that matter —
  a frame that never settles, one that rejects, and all of them hanging at once
  must each leave the read answering rather than pending, with the failed frames
  reported rather than dropped. Also that discovery is fresh unless the caller
  opts into the cache, that the cache expires and is dropped on navigation, and
  that an `accept` predicate resolves a read without waiting for a hung sibling.
- `search_transport_frames.test.js` — safe token-frame discovery without
  `allFrames`, including hung-frame isolation and per-tab caching.
- `record_search.test.js` — bounded table lookup, table/field safety, live
  preset intersection, explicit field selection, complete-term verification,
  result actions/caps, error categories, exact sys_id fallback, and stale
  search cancellation.
- `command_palette.test.js` — the pure palette model: label/description
  matching, relevance ranking (every built-in command must rank first for its
  own exact label, and groups must stay contiguous),
  the accepted unique built-in labels, declared group order, the
  single-appearance favourite, the stable Debug Timeline favourite key across
  Start/Stop, rejection of duplicate labels and implicit input labels, and
  source assertions for the listbox, `aria-activedescendant`, focus trap, and
  shared panel headings.
- `content_context.test.js` — conservative table and sys_id detection from page
  URLs, including the classic `*_list.do` suffix strip, classic record routes,
  encoded URLs, and the complete Workspace experience path. Workspace support is
  asserted as an `(experience path, table)` pair rather than a segment count:
  each supported pair resolves to its stored reader, and every half-match — the
  right table on the wrong experience, the right experience with the wrong
  table, a path prefix, a reversed or extended path — is refused.
- `open_url.test.js` — `OPEN_URL` tab placement beside the originating tab, and
  the fallback to Chrome's default placement when tab context is missing or
  invalid.
- `debug_timeline.test.js` — reversible MAIN-world recording, including all
  GlideAjax entry points.
- `debug_timeline_frames.test.js` — discovery and injection across concrete
  frames without hanging on helper frames.
- `prefill_settle.test.js` — installation and removal of GlideAjax settle
  tracking around catalog-variable prefill.
- `variable_values_native.test.js` — classic RITM identity before/after reads,
  Workspace-aware embedded-classic selection, exact `variables.<name>` classic
  reads and same-snapshot page timezone, record-producer `question_answer`
  routing, metadata-first secret-safe stored
  reads, producer definition enumeration, MRVS-child consolidation, multi-row
  stored reads and structural row comparison, positive
  type policy, row presence, duplicates,
  failure/empty/truncated states, scalar and List Collector comparison,
  date and timezone-aware date/time normalisation, retired-variable
  filtering,
  prototype collisions, portal masked-type behavior, copy safety, and native
  panel accessibility/source invariants. Workspace coverage includes frame-0
  transport, identity-before-geometry form selection, collapsed/stale forms,
  exact safe state-map pulls, `canRead` non-access, its per-surface type policy
  and the proof that no surface inherits another's proven types,
  that both worlds gate on the identical surface allowlist and an unlisted
  surface is refused before any read,
  producer-backed Workspace records and the definition-completeness field each
  stored reader actually sets,
  Select Box raw-value/display-label separation, malformed representation
  rejection, end-to-end Checkbox boolean comparison refusing both a disagreeing
  and an unrecognised pair, tri-state visibility, verdict-derived panel
  completeness, and structurally honest stored-only copy.

The Debug Timeline and prefill tests run page-owned code with browser-global
fakes. They do not replace testing timing and rendered behavior on a real
instance.

Before packaging, run the source-derived guards without writing an artifact:

```powershell
node package.mjs --check
```

## Store artifact packaging

Build the distribution archive with:

```powershell
node package.mjs
```

It writes `dist/glidelens-<version>.zip` and prints its SHA-256. Builds from the
same working copy are deterministic on one platform. Line-ending differences
mean Windows and Linux checkouts are not promised to produce identical bytes.

`package.mjs` owns the explicit `SHIP` allowlist. When adding a file that Chrome
loads, add it to `SHIP`. Its guards derive required assets from:

1. file references in `manifest.json`;
2. `importScripts(...)` calls;
3. `executeScript({ files })` calls; and
4. scripts and styles loaded by `popup.html`.

If the extension gains another loading mechanism, teach `package.mjs` to scan
it. Do not restore the removed Bash packager: it depended on an unavailable
`zip` binary and could not detect lazily injected files absent from the
manifest.

## Verifying Table API assumptions

Incorrect ServiceNow columns and dot-walks often return zero rows instead of an
error. Never infer them from memory.

A separate private, dependency-free PowerShell CLI is available for checking
the developer instance through the Table API. Read that repository's
`AGENTS.md` before use. It is intentionally cloned outside this repository; if
its location cannot be found, ask instead of guessing.

- Never clone or copy the CLI into this repository. Every committed file enters
  GitHub's repository ZIP, and extension runtime code must not depend on it.
- Invoke its `.ps1` entry point directly for encoded queries. A batch wrapper
  can treat `^` as an escape character and silently corrupt the query.
- Credentials stay outside both repositories. If the host allowlist rejects an
  instance, ask rather than widening it.

Previously verified assumptions include the `cat_item`/`catalog_item` split,
the `IO:` prefix on `catalog_ui_policy_action.catalog_variable`,
`super_class.name` dot-walking to a string, the two-hop
`sc_item_option.item_option_new.*` chain, and the defining-table inheritance
walk. Record Lens uses bounded technical-name reads on `sys_db_object` and
table-level `sys_documentation` rows for user-facing labels. It also confirmed that
`sys_dictionary.display` and `active` are readable, and that display fields can
be defined on a parent table. Some tables have no explicit display row and need
confirmed summary-field fallbacks. Known preset candidates for task, user,
group, configuration-item, and system-property tables were checked as live
dictionary rows; `sys_properties.value` is readable but intentionally never a
default. Reverify when platform behavior or the queried schema changes.

## Repository map

- `manifest.json` — MV3 configuration, permissions, content scripts, and the
  `_execute_action` command.
- `background.js` — service worker, URL opening, lazy injections, token-bearing
  REST routing, Service Portal MAIN-world helpers, and frame orchestration.
- `content.js` — isolated-world form and catalog DOM behavior plus Table API
  helpers.
- `popup.html`, `popup.js`, `popup.css` — toolbar popup.
- `code_search.js`, `code_search_ui.js` — lazily injected Code Search engine
  and results panel.
- `record_search.js`, `record_search_ui.js` — lazily injected metadata-driven
  Record Lens engine and read-only results panel (the files keep the older
  Record Search names).
- `debug_timeline_main.js`, `debug_timeline_ui.js` — MAIN-world recorder and
  isolated-world results UI.
- `catalog_insight_ui.js` — catalog client script/UI policy analysis, including
  variable-scoped views.
- `hidden_variables_ui.js` — shared Service Portal and classic RITM Variable
  Values panel, including stored/live comparison on the native path.
- `tests/` — developer-only Node tests.
- `docs/` — the public GitHub Pages site, not extension runtime code.
- `package.mjs` — dependency-free store artifact builder.

## Public site maintenance

GitHub Pages serves `docs/` from `main`. It is hand-written and reuses the
popup's design tokens. Assets must live inside `docs/`; parent-relative assets
are outside the Pages root.

The landing page's command list mirrors `content.js`, including each command's
label and its action description. Its Record Lens, Code Search, Catalog Logic,
Variable Values, and Debug Timeline demonstrations must match their real panels,
down to the panel headings.

The Record Lens demo additionally copies two engine rules verbatim rather than
approximating them, because they are the point of the feature: the known-table
presets that choose default fields, and `SENSITIVE_AUTO_FIELD_PATTERN`, which
keeps value/body/content/script/password-like fields out of the automatic
selection. If either changes in `record_search.js`, change the demo too —
`sys_properties.value` showing as "manual only" is the visible proof. Read the source rather than recreating panel behavior from memory,
including grouping, search fields, counts, buckets, and category labels.
Change a panel and its demonstration in the same change.

Translation and variable-insight icons modify ServiceNow's own form chrome and
should use real screenshots rather than a fabricated platform form. Keep demo
CSS names under the `dm-` prefix to avoid collisions with landing-page styles.

Media belongs on GitHub's attachment CDN rather than in the repository so the
repository install stays small.
