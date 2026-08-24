# GlideLens

A lens on ServiceNow forms, catalogs and code: code search, catalog debugging,
translation inheritance, form tracing. A Manifest V3 Chrome extension in plain
JavaScript, with zero runtime dependencies and zero build step.

[![Add to Chrome](https://img.shields.io/badge/Add_to_Chrome-1f9c92?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/glidelens/bgjopdljfdgoamplbodfdaacjbgiopck)&nbsp;&nbsp;&nbsp;[![Add to Edge](https://img.shields.io/badge/Add_to_Edge-1f9c92?style=for-the-badge&logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/glidelens/aoohpfoblgnnciiiplppjkjabhjgaghj)

Rather look before installing? The tour runs a real command palette and shows
every panel in place — this README stays the reference, the site is the
walkthrough.

[![See what it does](https://img.shields.io/badge/See_what_it_does-1b1d22?style=for-the-badge&logo=readthedocs&logoColor=31d4c4)](https://rushipatel92.github.io/GlideLens/)

## What it does

- Instance info at a glance in the toolbar popup.
- A `\` **command palette** on any ServiceNow tab for navigation, record
  helpers, and toggles.
- Read-only **code search** across everyday scripts and configuration source
  the platform's own code search commonly misses.
- **Translation icons** on classic form labels, resolving inherited fields.
- A best-effort **Debug Timeline** recorder for `g_form` calls, field events,
  GlideAjax and JavaScript errors — GlideAjax rows show the Script Include,
  method, parameters and decoded response, so you don't go digging in the
  Network tab.

---

## Install

**[Add GlideLens to Chrome](https://chromewebstore.google.com/detail/glidelens/bgjopdljfdgoamplbodfdaacjbgiopck)** ·
**[Add GlideLens to Edge](https://microsoftedge.microsoft.com/addons/detail/glidelens/aoohpfoblgnnciiiplppjkjabhjgaghj)**

That is the whole install. Your browser keeps it up to date on its own, so
there is nothing to re-download when a new version ships. It is the same
package on both stores — Edge is Chromium-based and runs the extension
unchanged.

**Chrome 111 or newer** (Edge 111 or newer), released March 2023. The panels
colour themselves with CSS `color-mix()`, which nothing older understands — on
an earlier build the panels open but parts of them are unreadable rather than
merely plain. The manifest declares this floor, so the browser refuses to
install rather than leaving you to discover it.

Once it is installed, click the puzzle-piece **Extensions** icon in the toolbar
and pin **GlideLens** so its icon stays visible. Then open any ServiceNow tab
and press `\`.

## Install from the repository zip instead

You do not need this if you installed from the store. It is here for running the
code you can read — a fork, an unreleased `main`, or an environment where the
Chrome Web Store is blocked. You load the extension "unpacked" from a folder on
your PC, and you update it by hand.

### 1. Download the zip

1. Open the repository page: <https://github.com/RushiPatel92/GlideLens>
2. Click the green **Code** button near the top of the file list.
3. Choose **Download ZIP**. Your browser saves something like
   `GlideLens-main.zip` to your Downloads folder.

   Direct link:
   <https://github.com/RushiPatel92/GlideLens/archive/refs/heads/main.zip>

### 2. Extract it to a permanent location

Your browser loads the extension **from the folder, not the zip**, and it
re-reads that folder every time the browser starts. So put it somewhere stable
that you won't delete or move — **do not leave it in Downloads or a temp
folder.**

A good home on Windows is a dedicated folder in your user profile, for example:

```
C:\Users\<you>\BrowserExtensions\GlideLens
```

To extract:

1. Right-click the downloaded `.zip` → **Extract All…**
2. Set the destination to your permanent folder (e.g.
   `C:\Users\<you>\BrowserExtensions\`) and extract.
3. Open the extracted folder. GitHub zips wrap everything in an inner folder
   (e.g. `GlideLens-main`). Make sure you can see
   **`manifest.json`** directly inside the folder you plan to load — that file
   must sit at the top level of the folder you point the browser at.

> Tip: if the folder you extracted contains a single sub-folder and that
> sub-folder holds `manifest.json`, load the sub-folder.

### 3. Load it in your browser

1. Go to `chrome://extensions` (on Edge: `edge://extensions`) by pasting it into
   the address bar.
2. Turn on **Developer mode** — top-right in Chrome, bottom-left in Edge.
3. Click **Load unpacked**.
4. Browse to the folder that contains `manifest.json` and click **Select
   Folder**.
5. "GlideLens" now appears as a card in your extensions list.

### 4. Pin it (optional but recommended)

Click the puzzle-piece **Extensions** icon in the toolbar, then the pin next to
**GlideLens** so its icon stays visible.

### Updating an unpacked copy

The store copy updates itself; this one does not.

1. Download and extract the new zip **into the same folder**, replacing the old
   files (or extract fresh and re-point the browser at the new folder).
2. Go to `chrome://extensions` (or `edge://extensions`) and click the **reload**
   (↻) icon on the GlideLens card.
3. Refresh any open ServiceNow tab so the updated content script loads.

The version shown on the extension card matches the one in
[`manifest.json`](manifest.json); [CHANGELOG.md](CHANGELOG.md) lists what
changed in each release.

### Troubleshooting

- **"Manifest file is missing or unreadable"** — you pointed the browser at the
  wrong folder. Select the folder that directly contains `manifest.json`.
- **Icon/popup does nothing on a page** — the extension only activates on
  `*.service-now.com` URLs. Open a ServiceNow instance first.
- **Toggles or badges disappeared after the form changed** — on classic forms
  they re-apply themselves within a moment. On Workspace forms they don't yet;
  run the toggle again.

---

## Using the extension

### Keyboard shortcuts

| Shortcut | What it does |
| --- | --- |
| `Ctrl+Shift+K` (`Cmd+Shift+K` on Mac) | Open the toolbar popup |
| `\` (backslash) | Open the command palette on the current ServiceNow tab |
| `Alt`+double-click | Toggle variable insight icons on a Service Portal catalog form |

If a shortcut does nothing, another browser feature may have claimed it — rebind
it at `chrome://extensions/shortcuts` (or `edge://extensions/shortcuts`).

The popup shows detected instance information. Almost all actions live in the
`\` command palette — start typing to filter, use arrow keys and `Enter` to run,
and `Esc` to close. Some commands accept an argument in an inline input field.

### Command palette commands

**Tools**

| Command | Description |
| --- | --- |
| Toggle translation icons | Show/hide per-label icons: a globe for `sys_documentation` (label/plural/hint) and a languages glyph for `sys_translated_text` (per-record value translations). |
| Start / Stop debug timeline | Record a single page's `g_form` calls, native field events, GlideAjax and JavaScript errors, then view a filterable results panel. Each GlideAjax row expands to its Script Include, method, parameters and decoded response alongside the duration, so a call can be read without the Network tab; names that look like secrets are redacted. Best-effort; does not promise named Client Script / UI Policy attribution. |
| Search code… | Search all 14 Table API sources for plain text or a `"quoted phrase"`, including Script Includes, Business Rules, Client Scripts, reference qualifiers, catalog variables, transform logic, record producers, UI Actions, Script Actions, and Scripted REST operations. Results are read-only and open the owning platform record. |
| Recheck what code search can reach | Re-read this instance's search-group configuration and field definitions instead of waiting for the weekly cache to expire. Reports what changed. |

#### Code search

Open the palette, choose **Search code…**, and enter at least three letters,
digits, or underscores from the text you want to find. Matching is
case-insensitive. Examples:

```text
GlideRecord
"current.assignment_group"
table:sys_dictionary AutoResolutionRefQualifier
```

An ordinary search always covers every supported source. Use `table:<name>`
only to retry one concrete ServiceNow table after a broad search reports that
source as capped or slow. A table-scoped results panel displays the scope
prominently so it cannot be mistaken for a complete search.

Where the instance has ServiceNow's own Code Search available, that index is
used first and the Table API sources fill in what it does not reach — which is
most of the reason this feature exists. Its search groups are configured per
field, so, for example, UI Action **conditions** are indexed nowhere and are
found only by the fallback. Nothing needs configuring for this: the extension
reads the instance's existing search groups, and searches work the same way on
an instance without the index, only slower.

The results panel groups verified matches by source and shows the matching
field, line-numbered snippets, and a link to each record or the matching set as
a platform list. Its **Source status** drawer distinguishes no matches from
access denied, unavailable, timed out, or capped sources, says when the
instance's own index was not consulted, and marks any source it stood in for as
skipped — so a partial search does not look complete. A filter box narrows the
results already loaded.

What the instance can search is read once and cached for a week, so adding a
table to a search group — or a new field appearing — would otherwise take up to
seven days to show up in results. **Recheck what code search can reach** re-reads
both immediately and says what moved: tables added, removed or re-tuned, the
index appearing or disappearing, or nothing at all.

Code search is read-only: it performs same-instance GETs and never
runs or edits what it finds. It does not support regular expressions. Searches
are capped at 50 records per source; refine the text or use `table:<name>` to
retry that source when it reports **Capped**.

**Record**

| Command | Description |
| --- | --- |
| Copy sys_id | Copy the current record's `sys_id` to the clipboard. |
| Open playbook executions | Open Process Automation playbook executions for the current record. |
| Open current playbook customer updates | On a playbook (process definition) page, open the related `sys_update_xml` customer updates. |
| Open customer updates by sys_id… | Enter a record sys_id or ServiceNow URL to open its customer updates. |

**Catalog**

| Command | Description |
| --- | --- |
| Prefill variables from ticket… | Enter a RITM/SCTASK/REQ/task number (or submitted-record sys_id) to prefill portal catalog variables from that ticket. |
| Show variable values | Read-only panel listing every variable on the current Service Portal catalog item with its best-effort value, including variable-set variables. Filter by hidden/visible; hidden covers Hidden-type, UI Policy/client-script, and not-rendered variables. |
| What affects this catalog item | Read-only panel listing the catalog client scripts and catalog UI policies bound to the current item or its variable sets — type (onLoad/onChange/…), watched variable, active state, and which views they run on. Group onChange scripts by the variable they watch, see a ⚠ hint on rows that won't fire while ordering the item (inactive, or RITM/Task views only), and open the whole set as a platform list. Click a row to open the record. Nothing here runs or edits the logic. |
| Toggle variable insight icons | Show/hide a per-variable icon on a Service Portal catalog form. Clicking an icon opens the panel above scoped to that one variable — the onChange scripts watching it and the UI policy actions targeting it (hides / mandatory / read-only / sets value) — with **Show all** to clear the scope. Also bound to `Alt`+double-click on the form. |

**Navigate**

| Command | Description |
| --- | --- |
| Open table list… | Enter a table name (e.g. `incident`) to open its list view (`<table>_list.do`). |
| Open new record… | Enter a table name to open a new record form (`<table>.do?sys_id=-1`). |

**Dev Links** — one-click navigation to common developer destinations:
Background Scripts, Script Includes, Business Rules, Client Scripts, UI Actions,
System Logs, Update Sets, Scheduled Jobs, Fix Scripts, Sys Properties, REST
Explorer, and Flow Designer.

---

## For developers

- Load unpacked as above; after editing, click **reload** on the extension card,
  and refresh the ServiceNow tab for content-script changes.
- There is no build step for development. The GitHub **Code → Download ZIP**
  route described above ships every repo file (`README.md`, `CLAUDE.md`,
  `.github/`); Chrome ignores the ones it does not recognise.
- A store-ready artifact is a different thing and *is* built: `node package.mjs`
  writes `dist/glidelens-<version>.zip` from an explicit allowlist, so none of
  those extra files ride along. Its guards are derived from the source — adding
  a file Chrome has to load means adding it to `SHIP`, and the build fails
  loudly if you forget.
- The landing page is one hand-written file, [`docs/index.html`](docs/index.html),
  published by GitHub Pages from `main` → `/docs` at
  <https://rushipatel92.github.io/GlideLens/>. No generator, no build, same design
  tokens as [`popup.css`](popup.css). Screenshots and clips belong on GitHub's
  attachment CDN rather than committed here, so the install download stays small.

See [CLAUDE.md](CLAUDE.md) for architecture notes (the two JS worlds, frames,
and message flow).

---

## Privacy

There is no GlideLens server, no account and no telemetry. Everything the
extension reads is processed in your browser and goes no further than the
ServiceNow instance it came from — it can only reach `*.service-now.com`, so it
could not contact a third party if it tried. Three small things are cached in
local extension storage: your pinned palette command, and two per-instance maps
of what code search can reach.

Full detail, including what a Debug Timeline trace can contain and the one place
the extension writes anything: <https://rushipatel92.github.io/GlideLens/privacy.html>.

---

## Licence

MIT — see [LICENSE](LICENSE). GlideLens is a personal, non-commercial project:
it is free, there is nothing to buy, and there is no company behind it.

---

GlideLens is an independent project. It is not affiliated with, endorsed by, or
sponsored by ServiceNow, Inc. "ServiceNow" and related marks are trademarks of
ServiceNow, Inc.
