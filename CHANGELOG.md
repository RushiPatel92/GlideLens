# Changelog

All notable changes to SN Dev Helper are recorded here. The version is the one
in [`manifest.json`](manifest.json); bump it in the same change that adds an
entry below.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Dates are `YYYY-MM-DD` (Europe/London). Releases before 0.4.0 were not tagged
individually, so 0.3.0 is recorded as a single baseline rather than
reconstructed version by version.

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

[0.6.0]: https://github.com/RushiPatel92/sndevhelper/releases/tag/v0.6.0
[0.5.0]: https://github.com/RushiPatel92/sndevhelper/releases/tag/v0.5.0
[0.4.0]: https://github.com/RushiPatel92/sndevhelper/releases/tag/v0.4.0
