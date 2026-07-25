# SN Dev Helper — Claude Code project notes

A Manifest V3 Chrome extension of developer utilities for ServiceNow, in the
spirit of snUtils. Plain JS, zero runtime dependencies, zero build step.

## Run / debug loop
- Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → this folder.
- After editing, click the **reload** icon on the extension card. For
  content-script changes, also refresh the ServiceNow tab.
- Package for the Chrome Web Store: `bash package.sh`. It ships an explicit
  allowlist (`SHIP`) rather than an exclusion list, then cross-checks the zip
  against every file `manifest.json` references. **Adding a new script or asset
  means adding it to `SHIP`** — the manifest cross-check catches manifest-
  referenced files, but `popup.js`/`popup.css` (pulled in by `popup.html`) and
  `debug_timeline_main.js` (injected on demand) are invisible to it.

## Architecture (read before changing message flow)
ServiceNow's classic UI runs the real app inside an iframe named **`gsft_main`**;
the toolbar/shell is the top frame. The form DOM (labels, fields) lives in
`gsft_main`. Two consequences drive the whole design:

1. **Two JS worlds.** A content script runs in an *isolated* world: it can
   read/modify the DOM but CANNOT see page globals (`g_form`, `g_user`, `g_ck`).
   To read those we call `chrome.scripting.executeScript({ world: "MAIN" })`
   from `popup.js`. DOM-only work stays in `content.js`.
2. **Frames.** Content scripts and `executeScript` run with `allFrames`, then we
   pick the frame that actually returned SN context (the one with `g_form`).

### Message flow
- popup → content script: `chrome.tabs.sendMessage` (`TOGGLE_FIELD_NAMES`,
  `TOGGLE_TRANSLATIONS`). Delivered to all frames; `gsft_main` does the work.
- content script → service worker: `chrome.runtime.sendMessage` (`OPEN_URL`),
  because content scripts can't call `chrome.tabs.create`.
- keyboard command (`background.js`) → content script for the field-name toggle.

### REST from the content script
`content.js` calls the Table API (`/api/now/table/...`) directly. This works
because `gsft_main` is **same-origin** with the instance, so the session cookie
authenticates the GET. Cross-origin fetches would NOT work from a content
script under MV3 — they'd have to move to the service worker. Reads here assume
GET doesn't require the CSRF token; if an instance enforces it, calls throw and
the caller falls back gracefully.

## Files
- `manifest.json` — MV3 config, permissions, content scripts, command.
- `content.js` — isolated world: field-name badges, translation icons,
  dictionary-inheritance resolution, Table API helper (`snGet`).
- `debug_timeline_ui.js` - isolated-world recording indicator and filterable
  Debug Timeline results panel.
- `catalog_insight_ui.js` - isolated-world panel for "What affects this catalog
  item" (catalog client scripts + UI policies). Loaded before `content.js`.
  Also serves the per-variable scoped view (`focusVariable`) opened by the
  variable insight icons.
- `debug_timeline_main.js` - MAIN-world Debug Timeline recorder imported by
  the service worker and injected into every frame on demand.
- `popup.js` / `popup.html` / `popup.css` — popup UI: instance info, quick table
  open, dev links, copy sys_id, toggles.
- `background.js` — service worker: keyboard command + `OPEN_URL` handler.

## Feature notes
- **Translation icons** add two icons per label:
  - Globe → `sys_documentation` (label/plural/hint, per `table.field`). The
    defining table is resolved by walking `sys_db_object.super_class` and
    checking `sys_dictionary`, so inherited fields resolve correctly.
  - "Languages" glyph → `sys_translated_text` (per-record VALUE translations),
    filtered by `documentkey=<record sys_id>^fieldname=<field>` when a record is
    open, else `tablename^fieldname`.
- **Field-name badges** parse the classic label id format `label.<table>.<field>`.
- **Variable insight icons** (Service Portal catalog forms) drop a per-variable
  icon; clicking opens Catalog Insight scoped to that variable's onChange client
  scripts and UI policy actions. Toggle with Alt+double-click or the palette.
  The variable's internal name and definition sys_id live only in the Angular
  `field` model, so `background.js` runs `mapPortalVariableAnchors()` in the MAIN
  world to stamp `data-snh-var*` onto each variable element; `content.js` anchors
  icons off those stamps (label span `sp_field_label_<name>`, or the control
  container for booleans). Re-apply uses its own SP-scoped observer (the classic
  TOGGLE PERSISTENCE observer is deliberately not reused), and the MAIN-world
  restamp fires only when a variable is unstamped. Per-variable attribution is
  precise for onChange scripts (watched variable) and UI policy actions
  (`catalog_ui_policy_action`, matched by sys_id and name); onLoad/onSubmit and
  variable-less policies are form-level and excluded from the scoped view.
- **Debug Timeline** is a best-effort, single-page interaction recorder for
  public `g_form` calls, native field events, GlideAjax timing, and JavaScript
  errors. It does not promise named Client Script or UI Policy attribution.
  MAIN-world patches must remain reversible and traces must stay capped and
  redact fields or parameters whose names indicate secrets.

## Conventions & constraints
- **IMPORTANT — Never delete a branch from GitHub or any Git remote.** Remote
  branches must remain intact after merges and during cleanup. Cleanup may
  delete a local branch only; it must never use `git push --delete`, GitHub's
  branch deletion controls, or any equivalent remote-branch deletion action.
- **IMPORTANT — Building is not deploying. Never push, open a PR, merge, or tag
  without an explicit, separate instruction to do so.** "Build this", "implement
  this", "go ahead", "fix it", and similar are authorization to write code
  LOCALLY only. Stop after committing to the local feature branch and hand it
  back so the user can load the extension and test it in their own browser.
  Nothing reaches GitHub — no `git push`, no `gh pr create`, no `gh pr merge`,
  no `git tag`/tag push — until the user, having had the chance to test, asks
  to deploy/publish/"commit and push"/"raise a PR". When in doubt, ask; do not
  assume. The user tests the real extension before anything is shared.
- When the user DOES ask to deploy, publish, or "commit and push" a feature
  branch to GitHub, run the full workflow: validate and commit the branch, push
  it, open a pull request to `main`, merge and verify the pull request, then
  fetch, switch to, and fast-forward local `main`. A successful branch push
  alone is not completion. Stop after pushing the feature branch only when the
  user explicitly says "push branch only" or otherwise asks not to merge.
  Always preserve the remote feature branch.
- When Codex materially contributes to a commit, add the official Git trailer
  `Co-authored-by: Codex <noreply@openai.com>` to the commit message so GitHub
  attributes Codex as a co-author and repository contributor.
- Name new branches `YYYYMMDD-NN-category-description`, using the current
  Europe/London date, a two-digit sequence starting at `01` for that date, and
  lowercase kebab-case. Before creating a branch, inspect local and remote
  branches with the same date prefix and use the next unused sequence.
  Categories are `feature`, `fix`, `maintenance`, and `docs`. Keep `main`
  unchanged. Example: `20260629-01-feature-debug-timeline`.
- Keep it dependency-free vanilla JS. No bundler, no framework in extension
  pages: MV3's page CSP forbids `unsafe-eval`, so **AngularJS will not run in the
  popup** (its expression compiler uses the Function constructor). Content
  scripts may still use Service Portal's own Angular on the page.
- Do NOT create a top-level file or folder whose name starts with `_` — Chrome
  reserves those and will refuse to load the extension. (`CLAUDE.md`, `.claude/`,
  `.git/` are fine; Chrome ignores them.)
- Toggles re-apply themselves after a classic form re-renders, via a
  `MutationObserver` in `content.js` (see the TOGGLE PERSISTENCE block). Adding
  work there means respecting three things: the re-apply mutates the DOM, so it
  runs with the observer disconnected or it loops; re-renders arrive as bursts,
  so it is debounced; and both toggles are full teardown + rescan, so a cheap
  staleness check gates the rebuild. Workspace forms are deliberately excluded —
  `getWorkspaceFields()` walks every element in every shadow root.

## Roadmap
Background Script runner, update set switcher, impersonation, Table API record
search, GlideRecord snippet generator, per-environment favicon badge, and
toggle persistence for Workspace forms.
