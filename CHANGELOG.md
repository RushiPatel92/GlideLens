# Changelog

All notable changes to GlideLens are recorded here. The version is the one
in [`manifest.json`](manifest.json). Work can be staged under **Unreleased**;
when a release is cut, rename that section and bump the manifest in the same
change.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Dates are `YYYY-MM-DD` (Europe/London). Releases before 0.4.0 were not tagged
individually, so 0.3.0 is recorded as a single baseline rather than
reconstructed version by version.

## [Unreleased]

### Added
- **An MIT licence.** The repository was public with no `LICENSE` file, which
  means "all rights reserved" rather than open source — nobody could legally
  reuse or fork it, which was never the intent.

### Removed
- **The `activeTab` permission.** It was doing nothing: the
  `https://*.service-now.com/*` host permission already exposes the tab URL on
  the only tabs the extension works on, and on any other tab the URL is simply
  absent, which is exactly what makes the popup say "not SN". One fewer
  permission to declare, justify, and have a reviewer weigh.

### Fixed
- **A literal NUL byte in `catalog_insight_ui.js` is now the `\0` escape.** The
  "not variable-specific" group key was written as a raw U+0000 in the source
  rather than as an escape sequence. It ran correctly — the runtime value is
  identical — but a NUL makes tooling classify the file as binary: `git` stored
  it without line-ending normalisation and `grep` refused to search it, reporting
  only "Binary file matches". A store reviewer's scanners see the same thing, and
  a binary-looking script in an extension package is not what you want them
  asking about. Normalising it also converts the file's stored line endings to
  LF, like every other file, which is why its diff looks larger than one line.
- **The popup builds its rows as DOM nodes instead of markup.** Instance-supplied
  values — the signed-in user's own first and last name, the node, the build, the
  table — were interpolated into an `innerHTML` string. MV3's page CSP stops an
  injected `<script>` from running, but it does not stop markup: an `<img src>`
  pointing off-instance would still have fired a request from the privileged
  popup, and injected elements could have dressed themselves up as popup chrome.
  Every value is now set with `textContent`.

### Changed
- **The site moved to `rushipatel92.github.io/GlideLens/`.** It was served from
  a subdomain of a consultancy's domain, which is the wrong signal for what this
  is: a free, unmonetised personal project with no company behind it. That
  distinction also has a concrete consequence — the Chrome Web Store requires an
  EEA trader/non-trader declaration, and a professional-purpose listing must
  publish the developer's legal name, address and phone number publicly.
  GlideLens is not a commercial activity, so the hosting now says so too. The
  privacy policy moves with it, and `docs/CNAME` is gone. The page itself never
  named the company — the domain was the only place it appeared.

## [0.11.0] - 2026-08-22

### Added
- **A declared browser floor: `minimum_chrome_version` is now `111`.** The five
  panels colour themselves with CSS `color-mix()`, which arrived in Chrome 111
  (March 2023) and is used in 43 places across every panel — not just the
  palette. On anything older the panels still open, but parts of them render
  unreadable rather than merely unstyled. Declaring the floor makes the browser
  refuse the install instead of leaving someone to find that out for
  themselves. Nothing else in the extension needs anything newer: there is no
  `:has()`, no container query, no `structuredClone`, and `world: "MAIN"` has
  been available since Chrome 95.
- **A privacy policy**, at
  [rushipatel92.github.io/GlideLens/privacy.html](https://rushipatel92.github.io/GlideLens/privacy.html).
  It sets out what the extension reads and why, what is cached locally (three
  small things), what leaves your device (nothing beyond requests to your own
  instance), what a Debug Timeline trace can contain, and what each permission
  is for. Required for a Chrome Web Store listing, and worth having regardless
  for a tool that reads your instance.
- An independence disclaimer on the site and in the README: GlideLens is not
  affiliated with or endorsed by ServiceNow, Inc.

### Changed
- **"It never writes" is now stated accurately.** The site said the extension
  never writes, which was wrong: Prefill changes unsaved fields on the catalog
  form in front of you. It never writes to a record and never submits a form,
  and that is now what the page says. The footer also drops "Proof of concept".
- **A store-artifact builder, `node package.mjs`.** Writes
  `dist/glidelens-<version>.zip` from an explicit allowlist, so the repository's
  "every committed file ships" no longer applies to the distributable — project
  notes, tests and the landing page stay out. Two builds of one working copy are
  byte-identical, and it prints the sha256.
  Its guards are derived from source rather than hand-maintained: it parses
  `manifest.json`, `importScripts(...)`, `executeScript({ files })` and
  `popup.html`, and refuses to build if any referenced file is missing from the
  allowlist, naming which of the four found it. That matters because the
  previous script cross-checked `manifest.json` alone, and Code Search's two
  files are deliberately absent from the manifest and injected lazily — it would
  have built a passing zip with a Code Search command that failed at runtime.

### Fixed
- **Prefill no longer rewrites the values it copies.** Four variables matched by
  name had random letters appended to them, and one choice variable had its
  value swapped for a different internal choice — rules collected from a single
  instance's catalog. On anybody else's catalog with the same variable names,
  the first silently corrupted the copied value and the second silently selected
  the wrong choice, with nothing in the UI to say either had happened. Both are
  gone: prefill now copies values through unchanged and matches choices only
  against the form's own choice list. This is the same class of fix as 0.10.1's
  prefill timing, and completes it.
- **A choice that does not match is now reported unfilled, not approximated.**
  The removed alias table was the only caller that let choice selection fall
  back to "whatever the first non-empty option is".
- **Catalog item names are escaped before rendering.** "What affects this
  catalog item" put the item's name straight into the panel's markup, so an item
  whose name contained HTML could inject into the page. Every other instance
  string in that panel was already escaped.

### Security
- **The popup no longer reads the session's CSRF token.** Its MAIN-world probe
  returned `g_ck` and the user's `sys_id` alongside the instance details it
  displays, and used neither. Nothing outside `background.js` needs the token,
  and it never leaves the page's own world there.

## [0.10.1] - 2026-07-31

### Fixed
- **Prefill now waits for the form to settle on any instance, not just one.**
  Setting a variable can start a catalog client script whose GlideAjax response
  arrives later and overwrites the variable filled after it. Which variables did
  that was decided from a hardcoded list of five variable names, so everyone
  whose catalog used different names got the short wait on exactly the variables
  that needed the long one — values that quietly reverted, on a run that
  reported success. Prefill now watches GlideAjax itself and waits for the
  requests to go quiet, so the wait fits the form in front of it. On forms that
  fire no requests it is also faster, because there is no longer a fixed
  one-second pause to sit through.

## [0.10.0] - 2026-07-31

### Changed
- **The toolbar icon is the GlideLens mark.** 0.9.0 renamed the extension but
  kept the old `SN` artwork, so the one place you look most often still showed
  the old name's mark. It is replaced at every size, tuned separately at 16px so
  it stays readable in the toolbar, and drawn on transparency so it sits
  correctly against both light and dark Chrome themes.

### Removed
- **"Copy portal variable debug info" is gone from the command palette.** It
  dumped the internals of the last prefill run as JSON — a diagnostic for
  building that feature, not something worth a slot in the Catalog group, and
  it had nothing to say unless a prefill had just run in the same page. Prefill
  itself is untouched.
- **"Toggle field names" is gone.** snUtils already shows technical field
  names, and duplicating it was never the point of this extension. The command
  has been removed from the palette, the site and the README, and the
  `Alt+Shift+F` shortcut is no longer registered — it will disappear from
  `chrome://extensions/shortcuts` when you reload the extension. The badge code
  itself is still in place, unreferenced, so the feature can come back cheaply
  if it is ever missed.

### Fixed
- **Debug Timeline now records `getXMLAnswer` GlideAjax calls.** They were
  missing entirely — a recording of a page whose scripts use that form showed
  no GlideAjax activity at all, which reads as "nothing happened" rather than
  "not captured". Only `getXML` and `getXMLWait` were patched, and
  `getXMLAnswer` does not reliably route through `getXML`. Those calls now
  appear with the same detail as the others: the Script Include, the method,
  every parameter, the decoded answer and the duration. Its callback receives
  the answer as a plain string rather than an XMLHttpRequest, which is why the
  response did not decode even on the builds where the call was seen.
  On platform builds where `getXMLAnswer` *does* delegate to `getXML`, the
  request is still recorded once rather than twice.

## [0.9.0] - 2026-07-30

### Changed
- **The extension is now called GlideLens.** It was SN Dev Helper. The name
  covers what it grew into — a way of looking at forms, catalogs and code —
  rather than the grab-bag of shortcuts it started as. You will see the new
  name on the extension card, in the popup, on the command palette, and at the
  top of anything you copy out of a results panel.
- The repository moved to `github.com/RushiPatel92/GlideLens`, so the
  Download-ZIP link and the file it saves changed name too. GitHub redirects
  the old address indefinitely, so an existing bookmark or clone keeps working.
  Nothing about an installed copy changes: reload it in place as usual, and
  every saved setting and cached search-coverage map survives, because only the
  visible names changed and none of the internal storage keys did.
- The toolbar icon still shows the old `SN` mark; new artwork is coming in a
  later release. Only the picture is stale — the card, the popup and the panels
  all say GlideLens.

### Added
- A palette command, **Recheck what code search can reach**, that re-reads the
  instance's search-group configuration and field definitions on demand instead
  of waiting out the seven-day cache. It reports what actually moved — tables
  added, removed or re-tuned, the instance index appearing or disappearing, or
  no change at all — because a refresh that says nothing looks exactly like one
  that did nothing. A failed read says so and leaves the cached coverage alone,
  rather than reporting the instance index as gone.

## [0.8.0] - 2026-07-29

### Added
- Code search now uses the instance's **own Code Search index** where it is
  available, and falls back to the Table API adapters where it is not. One
  request covers every record type the instance's search groups configure, so a
  normal search returns in about a second and a half instead of fanning out over
  a dozen table reads.
- A cached per-origin **coverage map** built from `sn_codesearch_table`, keyed
  per `table.field` rather than per table. An adapter is skipped only when the
  index genuinely covers every field it reads, so the sources the index does not
  reach keep running: dictionary and override logic, catalog variables,
  transform entries, record producers, catalog client scripts, and — because
  every search group configures `sys_ui_action` as `name,script` — UI Action
  conditions.
- The results panel now says when the instance index was not consulted and why,
  and marks any adapter it stood in for as skipped rather than silently omitting
  it.
- Results are grouped by record type rather than by which tier found them, so a
  table only ever produces one group — "UI action", not "UI action" beside
  "UI Action (instance search)". The **Source status** drawer still lists every
  source separately, because that is where a partial search has to be visible.
- Groups and the header now report matches **and** records — "6 matches in 2
  records" — because one record matching in its name, condition and script is
  three findings with three snippets. The "open in a list" button names how many
  records it will open, and a record's matches are kept together in the list.

### Fixed
- Source rows in the status drawer now show why a source was skipped and what
  error a failing source returned. Both were being tracked and never rendered.

### Security
- The instance index is read GET-only through the same single token-bearing
  frame as the Table API tier. Every line the endpoint returns is re-verified
  against the search term before rendering — it returns ±1 lines of context
  around each match, which would otherwise be reported as matches in their own
  right — and hits with sensitive-looking names are redacted on this path too.
- A `table:` filter is only ever passed to the endpoint for a table the coverage
  map contains. An unconfigured or misspelled table name is not rejected by the
  instance; it is silently ignored, and the response is a full unscoped search
  that would otherwise look like a scoped one.

## [0.7.0] - 2026-07-28

### Added
- **Read-only code search** from the command palette. **Search code…** searches
  14 Table API sources spanning everyday scripts and configuration source the
  platform's own code search commonly misses: Script Includes, Business Rules,
  Client Scripts, catalog client scripts, Script Actions, Scripted REST
  operations, dictionary and override logic, catalog variable definitions,
  transform logic, record producers, and UI Actions.
- Plain case-insensitive text, `"quoted phrase"`, and an explicit `table:`
  escape hatch for retrying a capped or slow source. Normal searches always
  cover every supported source, and a table-scoped results panel announces the
  reduced scope prominently. Every returned row is verified in the browser
  against the original term before it can render; this prevents an invalid or
  silently dropped Table API condition from turning into trusted false results.
  Regex is refused because an anchor-prefiltered regex search could silently
  miss matches.
- A larger, lazily loaded shadow-root results panel with grouped, line-numbered
  snippets, match highlighting, per-record and "open as list" links, filtering
  over loaded results, cancellation, result caps, and a source-status drawer
  that distinguishes no matches from denied, absent, timed-out, capped, and
  failed sources. Search files load only on first use and `manifest.json` needs
  no content-script entry.
- A cached, inheritance-aware registry probe validates each searchable
  table/field against the instance before use. Searches run through one
  token-bearing frame with bounded concurrency and per-source status; source
  bodies are not persisted, sensitive-named hits are redacted, and everything
  is GET-only.

### Fixed
- Catalog Client Script results no longer appear a second time under Client
  Scripts. The parent `sys_script_client` adapter now requests and verifies the
  concrete `sys_class_name`, excluding inherited `catalog_script_client` rows
  that are handled by their own adapter.
- Value-translation icons now appear only on fields whose dictionary type can
  have `sys_translated_text` rows, instead of opening an inevitably empty list
  from ordinary fields. The lookup covers inherited fields, is cached per table
  for the page, and fails open with a console warning rather than hiding a
  potentially valid icon.
- Single-row Table API reads now use the MAIN-world, CSRF-token-bearing path.
  On token-enforcing instances the previous isolated-world request returned
  401, then silently fell back to the form table; inherited fields such as
  `task.short_description` on an Incident could therefore open translation
  records against the wrong table.

## [0.6.0] - 2026-07-25

### Added
- **Variable insight icons** on Service Portal catalog forms. A small icon next
  to each rendered variable; clicking it opens "What affects this catalog item"
  scoped to that one variable — the onChange client scripts that watch it and
  the UI policy actions that target it — with a **Show all** affordance to clear
  the scope. Toggle with `Alt`+double-click on the form, or the **Toggle
  variable insight icons** palette command. onLoad/onSubmit scripts and
  variable-less policies stay form-level and are excluded from the scoped view.
- **Group by variable** toggle on the "What affects this catalog item" panel.
  onChange client scripts collapse under a header for the variable they watch,
  resolved from the `item_option_new` sys_id to a developer-facing name plus its
  click-to-expand question label; everything else falls under "Not
  variable-specific".
- **"Why isn't this firing" hints.** Rows that are inactive, or active but
  scoped to RITM/Task views only (`applies_catalog` off), get a ⚠ tag and a left
  accent explaining they will not run while ordering the item. Summary chips
  gain an "N inactive" and a highlighted "N won't run here" count, each hidden
  when zero; the won't-run note also lands in the copied text.
- **"Scripts in platform" / "Policies in platform"** footer buttons, opening the
  whole affecting set as a `catalog_script_client` or `catalog_ui_policy` list
  filtered with the same item + variable-set query the panel fetched. Each is
  disabled when its type has no rows.
- UI policy reads now also cover `catalog_ui_policy_action`, so each policy row
  carries what it does to a given variable (hides / mandatory / read-only / sets
  value). Still read-only, still same-origin Table API GETs.

### Changed
- **A teal + pink accent system across the whole extension**, replacing the
  muted lavender/purple. Teal (`#31d4c4`) is the workhorse — selection bars,
  focus rings, input carets, catalog group headers, the palette's active command
  and section labels, active filters, "in platform" buttons. Pink (`#ff6fae`) is
  the rare spark — the palette brand kicker, the pinned-command star, the popup
  brand mark, and the single primary button per surface. Semantic colours are
  untouched: green = active/connected, red = error/inactive, amber = won't-fire.
- Panel filter pills, category badges, and search boxes across the Debug
  Timeline, Hidden Variables, and Catalog Insight overlays were lifted out of
  the low-contrast tier they shared: resting pills are clearly readable, the
  active state leans harder on teal so selection still dominates, and the search
  box gets a lighter fill, a defined border, and a legible placeholder.

### Removed
- `package.sh`. It built a Chrome Web Store submission zip, and there is no plan
  to list on the store — everyone installs via GitHub's **Code → Download ZIP**,
  which ships the whole repo and works fine because Chrome ignores the files it
  does not recognise. Keeping it meant maintaining a `SHIP` allowlist alongside
  every new script for a distribution path nobody used. If the store ever
  becomes the plan, recover the script from git history rather than rewriting
  it.

### Fixed
- Catalog client-script grouping put every script under "Not variable-specific".
  The watched variable was read from `variable`, which is not the column on
  `catalog_script_client`, and the Table API silently drops unknown
  `sysparm_fields`. Both `cat_variable` and `variable` are now requested, and
  whichever resolves to a sys_id is used (stripping any `IO:` reference prefix).

## [0.5.0] - 2026-07-23

### Added
- **"What affects this catalog item"** command. A read-only panel listing the
  catalog client scripts (`catalog_script_client`) and catalog UI policies
  (`catalog_ui_policy`) bound to the current Service Portal item or its variable
  sets — script type, watched variable, active state, and which views they run
  on — each row a click-through to the platform record. All reads are
  same-origin Table API GETs; script bodies are never shown, so no new
  permissions and nothing to redact.

## [0.4.0] - 2026-07-23

### Added
- Extension icons at 16/32/48/128px, declared as both the top-level `icons`
  and `action.default_icon`. Chrome previously showed the generic puzzle-piece
  placeholder, so pinning the extension pinned a blank icon.

### Changed
- **Field-name badges and translation icons now survive a classic form
  re-render.** A `MutationObserver` re-applies whichever toggles are on after a
  section switch, related-list refresh, or UI Policy run, instead of the badges
  silently vanishing until you toggled again. Classic UI only; Agent Workspace
  forms still decorate on demand.
- `package.sh` now builds from an explicit allowlist and cross-checks the zip
  against every file `manifest.json` references, instead of shipping everything
  it was not told to exclude. This stops stray dev files (plan docs, agent
  configs) from landing in the distributable and fails the build if a
  manifest-referenced asset is left out.

### Removed
- Stale `plan-hidden-portal-variables.md`; that feature shipped in 0.3.0.

### Internal
- Added `.gitignore` (build artifact, local `memory/`) and `.gitattributes`
  pinning `*.sh` to LF so a fresh Windows clone does not get a CRLF
  `package.sh`.

## [0.3.0] - baseline

The feature set as of the first recorded version:

- Toolbar popup with detected instance info.
- `\` command palette on any ServiceNow tab: navigation, record helpers,
  toggles, and dev links.
- Technical field-name badges and translation icons on classic forms
  (`Alt+Shift+F` for field names).
- Best-effort Debug Timeline recorder for `g_form` calls, native field events,
  GlideAjax timing, and JavaScript errors.
- Portal catalog tools: prefill variables from a ticket, show all variable
  values (incl. hidden and variable-set variables), copy variable debug info.
- Record tools: copy sys_id, open playbook executions, open customer updates.

[0.11.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.11.0
[0.10.1]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.10.1
[0.10.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.10.0
[0.9.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.9.0
[0.8.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.8.0
[0.7.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.7.0
[0.6.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.6.0
[0.5.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.5.0
[0.4.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.4.0
