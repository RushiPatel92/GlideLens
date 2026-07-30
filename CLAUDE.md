# GlideLens — Claude Code project notes

A Manifest V3 Chrome extension of developer utilities for ServiceNow. Plain JS,
zero runtime dependencies, zero build step.

## Run / debug loop
- Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → this folder.
- After editing, click the **reload** icon on the extension card. For
  content-script changes, also refresh the ServiceNow tab.
- There is no build or packaging step. Users install via GitHub's **Code →
  Download ZIP**, extract, and Load unpacked, so every committed file ships and
  Chrome ignores the ones it does not recognise. A new script or asset only has
  to be committed and referenced from `manifest.json` (or the page that loads
  it) — there is no allowlist to keep in sync.
- If the extension is ever submitted to the Chrome Web Store, that will need a
  packaging script that zips only the extension files. `package.sh` did this and
  was removed in 0.6.0 as unused; recover it from history (`git log --
  package.sh`) rather than writing a new one from scratch.

## Verifying Table API assumptions against a real instance
Column names and dot-walks in this codebase are easy to get wrong and fail
*silently* — a wrong column returns zero rows forever rather than erroring. Do
not guess them. There is a developer instance and a CLI to check against:

The tool is a separate private repo, `RushiPatel92/sn-pdi-tools` — a
dependency-free PowerShell CLI over the Table API (`schema`, `get`, and guarded
writes). Read its `AGENTS.md` first; it carries the commands and the rules. It
is cloned outside this repo, and deliberately not named here: if you cannot
find it, ask rather than guessing a path.
- **It must never be committed into this repo, or cloned inside it.** Every
  committed file here ships in the Download ZIP. It is a dev tool, not part of
  the extension, and nothing in `content.js` may depend on it.
- Call `pdi.ps1`, never `pdi.cmd`, for anything with a `-Query`: `^` is
  cmd.exe's escape character, so the batch wrapper corrupts encoded queries into
  ones that quietly match nothing.
- Credentials live outside both repos and a host allowlist gates every call. If
  it refuses a host, ask — do not widen the allowlist.

Verified this way so far (2026-07-27, all confirmed correct): the
`cat_item` vs `catalog_item` split, the `IO:` prefix on
`catalog_ui_policy_action.catalog_variable`, `super_class.name` dot-walking to a
plain string, the two-hop `sc_item_option.item_option_new.*` chain, and the
`resolveDefiningTable` walk.

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
`content.js` reads the Table API (`/api/now/table/...`) through `snGetMany`,
which hands the request to the service worker to run in the **MAIN world**,
where it can attach `X-UserToken` from `g_ck`. `snGet` is a one-row wrapper over
that same path.

Code Search uses the same rule through `SN_CODE_SEARCH_GET`, but resolves one
token-bearing frame per tab and sends every pooled request to that frame alone.
Do not route searches through `SN_TABLE_GET`: that handler fans out to every
frame and would multiply every source query on classic pages.

`SN_CODE_SEARCH_API_GET` is the same deal for the instance's own Code Search
endpoint (`/api/sn_codesearch/code_search/search`). It shares
`codeSearchFrameGet` — the frame resolution, the stale-frame retry and the
401-means-re-resolve rule — and differs only in the URL it builds.

**Do NOT fetch the Table API directly from the isolated world.** It is
same-origin with the instance, so the session cookie goes along — but the CSRF
token does not, and an instance that enforces the token on REST GETs answers
**401 to every call**. This is not hypothetical; it was observed on a real
instance, where it had been breaking dictionary-inheritance resolution for the
translation icons. The failure mode is nasty: callers treat a throw as "no data"
and fall back, so a read that never worked looks like an empty result rather
than an error. Cross-origin fetches would not work from a content script under
MV3 at all.

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
- `hidden_variables_ui.js` - isolated-world panel for "Show variable values" on
  Service Portal catalog items, with the hidden/visible filter. Loaded before
  `catalog_insight_ui.js`.
- `code_search.js` - lazily injected isolated-world engine: query parser,
  anchors, client-side verification, snippets, 14-source adapter registry,
  inheritance-aware probe, bounded fetch pool, redaction and orchestration.
- `code_search_ui.js` - lazily injected shadow-root Code Search results panel,
  grouped verified matches, loaded-result filtering and source-status drawer.
- `debug_timeline_main.js` - MAIN-world Debug Timeline recorder imported by
  the service worker and injected into every frame on demand.
- `popup.js` / `popup.html` / `popup.css` — popup UI: instance info, quick table
  open, dev links, copy sys_id, toggles.
- `background.js` — service worker: keyboard command, `OPEN_URL`, lazy Code
  Search injection, and token-bearing Table API handlers.
- `docs/index.html` — the public landing page, served by GitHub Pages from
  `main` → `/docs` at `glidelens.consultnowit.com` (`docs/CNAME`). One
  hand-written file, no generator and no build, reusing the `popup.css` tokens
  so the page and the product match. Not part of the extension; Chrome ignores
  it. Media belongs on GitHub's attachment CDN (drop a file into an issue
  comment, copy the `user-attachments` URL) rather than in the repo, so the
  install ZIP stays small.

  Three things to keep true. The site root **is** `docs/`, so assets must live
  inside it (hence `docs/icon32.png`, not `../icons/`). The hero palette's
  command list mirrors the real one in `content.js`. And the four live demos
  reproduce real panels: code search (`code_search_ui.js`), catalog insight
  (`catalog_insight_ui.js`), variable values (`hidden_variables_ui.js`) and
  Debug Timeline (`debug_timeline_ui.js`). Fidelity goes down to the details —
  `groupKeyOf` (only an onChange client script with a variable gets its own
  group; onLoad, onSubmit and all UI policies share "Not variable-specific"),
  the catalog search haystack (which includes `conditions`), `BUCKET_LABELS`,
  and `CATEGORY_LABELS`. **A demo that lies is worse than no demo**: change a
  panel and change its demo in the same commit. The first two got this wrong on
  the first pass by being written from memory instead of read from the source —
  read the source.

  The three features that inject into ServiceNow's own DOM — field-name badges,
  translation icons, variable insight icons — are deliberately NOT recreated.
  Faking the platform's form chrome for an audience that knows exactly what it
  looks like reads as sloppy; those slots want real screenshots.

  The demos are `dm-` prefixed throughout because the page already owns `.row`,
  `.tag`, `.count` and `.search`, and because `.feature-body p` caps prose at
  `62ch` — panel `<p>` elements have to opt out of it.
- `tests/` - developer-only Node tests. They ship harmlessly in the repository
  ZIP and Chrome ignores them; run Code Search tests by file path with
  `node --test tests/code_search.test.js tests/code_search_api.test.js
  tests/code_search_ui.test.js` (not `node --test tests/` on Node 24). The
  second file covers Tier 1: the coverage map, the ignored-`&table=` guard, cap
  saturation, and the adapter merge. The third covers the panel's counting —
  hits are per `table.sysId.FIELD`, so matches and records are different
  numbers and both are printed. `tests/debug_timeline.test.js` covers the
  GlideAjax recording; it loads the MAIN-world recorder by wrapping it in a
  `Function` whose parameters are the browser globals it uses, so it runs with
  no DOM.

## Feature notes
- **Translation icons** add two icons per label:
  - Globe → `sys_documentation` (label/plural/hint, per `table.field`). The
    defining table is resolved by walking `sys_db_object.super_class` and
    checking `sys_dictionary`, so inherited fields resolve correctly.
  - "Languages" glyph → `sys_translated_text` (per-record VALUE translations),
    filtered by `documentkey=<record sys_id>^fieldname=<field>` when a record is
    open, else `tablename^fieldname`. Rendered **only** for fields whose
    dictionary type is translatable (`translated`, `translated_text`,
    `translated_html`, `translated_field`); nothing else can ever have a row
    there. The set comes from one `sys_dictionary` query per table hierarchy,
    cached for the page's life and resolved OFF the synchronous toggle path, so
    value icons land a beat after the globes and `toggleTranslationIcons` keeps
    returning its count immediately. A failed lookup shows the icon rather than
    hiding a working one. Checked against a live instance: `task`, `incident`,
    `sc_req_item` and `change_request` have zero translatable fields between
    them, which is why the icon correctly never appears on those forms.
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
  GlideAjax is patched at three entry points — `getXML`, `getXMLWait` and
  `getXMLAnswer`. All three are needed: `getXMLAnswer` was missing until
  0.9.x and those calls recorded as nothing at all, because it does not
  reliably delegate to `getXML`. It also hands its callback the answer as a
  plain **string** rather than an XMLHttpRequest. On builds where it *does*
  delegate, a per-instance flag (`glideAjaxOwnedElsewhere`) keeps the inner
  `getXML` silent so one request is not recorded twice — only one of those two
  shapes is observable on any given instance, so both stay covered by tests.
- **Code Search** is a read-only, Table-API search across 14 source adapters:
  dictionary and override logic, catalog variables, transform maps/entries/
  scripts, record producers, UI Actions, Script Includes, Business Rules,
  Client Scripts, catalog client scripts, Script Actions, and Scripted REST
  operations. It supports a case-insensitive substring, one `"quoted phrase"`,
  and a `table:` escape hatch for targeted retries; normal searches cover every
  tier-1 source, and the UI announces table scope prominently. Regex is
  deliberately refused because a literal server prefilter cannot soundly cover
  alternation or optional matches.
  Only a query-safe anchor reaches the encoded query, and every returned field
  is verified against the original term before rendering. This is mandatory:
  a live instance confirmed that an invalid field in `sysparm_query` is silently
  dropped and can return every table row. The registry probe therefore walks
  `sys_db_object.super_class`, because catalog-variable and catalog-client-
  script fields are defined on parent tables even though the Table API exposes
  them on the children. Probe results are cached per origin for seven days; a
  failed probe means unknown, not absent. Parent-table adapters may declare an
  `exactClass`; `sys_script_client` does this because its Table API response
  includes `catalog_script_client` child rows that the child adapter also
  returns. `sys_class_name` is requested, filtered server-side to protect the
  row cap, and verified client-side before rendering. Requests use
  `SN_CODE_SEARCH_GET` through one token-bearing frame, concurrency 4, a
  20-second source timeout, and a 50-row per-source cap. The engine and UI are
  lazily injected on first use and remain absent from `manifest.json`; all
  instance text is rendered without instance-provided HTML, and sensitive-named
  hits are redacted.

  **Tier 1 — the instance's own index.** Where the Code Search plugin is
  present, `runApiSearch` queries `/api/sn_codesearch/code_search/search` first
  and the adapters fill the gaps. Four measured behaviours shape that code and
  none of them are guesses (write-ups in `plans/`, gitignored):
  - **`&table=` is silently IGNORED for any table not configured in a search
    group** — including a nonsense name — and the endpoint answers with a full
    unscoped search that is indistinguishable from a scoped one. Send it only
    for tables in the coverage map, and re-check the record types that come
    back. This is the Table API's silent-drop trap in a new place.
  - **A global 500-hit cap**, not raisable by `limit`/`sysparm_limit`/`max`, with
    no truncation flag. One record type can consume all 500 slots (measured:
    499 of 500), so saturation triggers a per-table retry through the same pool.
    Saturation is detected as `rawHits >= 500` because nothing else announces it.
  - **`lineMatches` carries ±1 lines of context**, so only lines that really
    contain the term become snippets. Use `context`, never `escaped` — a
    pre-escaped field invites `innerHTML`.
  - **Inheritance is followed**: the `sys_script_client` record type returns
    `catalog_script_client` rows. Hits are filed under their concrete
    `className` so the dedupe key collides with the adapter that also returns
    them.
  Both the probe and the coverage map cache per origin for seven days, so the
  palette command **"Recheck what code search can reach"** forces both
  (`refreshCapabilities`) and reports the diff against what was cached. Name it
  after the symptom — missing hits — not after the caches; and never report a
  failed read as a change, because neither loader caches a failure and the old
  map survives it.
  Coverage is mapped per `table.field` from `sn_codesearch_table` (cached per
  origin for seven days) and an adapter is skipped only when Tier 1 searched its
  table, did not saturate, and covers every field it reads. Neither config table
  has an `active` column; `additional_filter` means partial coverage, so keep
  the adapter. Matching is literal case-insensitive substring, the same as R1 —
  but that is the `extended_matching` setting on this instance's groups, so Tier
  1 is never assumed complete.

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
Background Script runner, Table API record search, GlideRecord snippet
generator, and toggle persistence for Workspace forms.

**Out of scope — do not propose these.** The update set switcher,
impersonation, and the per-environment favicon/instance badge are already
covered well by snUtils. This extension is not trying to replace snUtils, so
rebuilding what it already does is wasted effort. Aim at the gaps snUtils
leaves — catalog/Service Portal debugging, translation and dictionary
inheritance, form introspection — rather than at parity features. When
suggesting what to build next, leave these off the list entirely.
