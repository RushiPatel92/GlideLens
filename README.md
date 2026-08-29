# GlideLens

A lens on ServiceNow forms, catalogs and code: code search, catalog debugging,
translation inheritance, form tracing. A Manifest V3 Chrome extension in plain
JavaScript, with zero runtime dependencies and zero build step.

[![Add to Chrome](https://img.shields.io/badge/Add_to_Chrome-1f9c92?style=for-the-badge)](https://chromewebstore.google.com/detail/glidelens/bgjopdljfdgoamplbodfdaacjbgiopck)&nbsp;&nbsp;&nbsp;[![Add to Edge](https://img.shields.io/badge/Add_to_Edge-1f9c92?style=for-the-badge)](https://microsoftedge.microsoft.com/addons/detail/glidelens/aoohpfoblgnnciiiplppjkjabhjgaghj)

Rather look before installing? The tour runs a real command palette and shows
every panel in place — this README stays the reference, the site is the
walkthrough.

[![See what it does](https://img.shields.io/badge/See_what_it_does-1f9c92?style=for-the-badge)](https://rushipatel92.github.io/GlideLens/)

## What it does

- Instance info at a glance in the toolbar popup.
- A `\` **command palette** on any ServiceNow tab for navigation, record
  helpers, and toggles — short labels with a description beside each one, both
  searchable, keyboard-driven, and with one command favouritable to the top.
- **Record Lens**: read-only record search by table, using verified summary
  fields or an exact `sys_id` without downloading whole records.
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
| `Alt`+double-click | Toggle the Variable Insight icons on a Service Portal catalog form |

If a shortcut does nothing, another browser feature may have claimed it — rebind
it at `chrome://extensions/shortcuts` (or `edge://extensions/shortcuts`).

The popup shows detected instance information. Almost all actions live in the
`\` command palette.

Every command has a short **label** and a one-line **description**, and typing
matches both — `Code Search` and `configuration` reach the same command, so you
do not have to remember which word the command was named after. A label match
ranks above a description match, so typing a command's name always selects that
command. Commands are grouped in a fixed order: Favorite, Tools, Record,
Catalog, Navigate, Dev Links; the group holding the best match leads.

| Key | In the palette |
| --- | --- |
| Typing | Filters on label, description, and each command's keywords; label matches rank first |
| `Up` / `Down` | Move the selection; the active command's description expands to two lines without the row changing height |
| `Enter` | Run the active command, or open its inline input if it needs an argument |
| `Tab` / `Shift+Tab` | Cycle the palette's own controls — focus stays inside the palette while it is open |
| `Esc` | Close the palette and return focus to wherever it was before you opened it (in an inline input, `Esc` returns to the command list) |

The `☆` button beside the active command **favourites** it. A favourited
command appears once at the top of the palette, in its own **Favorite** group,
whenever the search box is empty. Debug Timeline keeps its favourite through
Start and Stop — the two states share one stored key, so the favourite does not
vanish the moment you start recording. Only one command can be favourited at a
time; pressing the button again clears it.

Commands that open something — a record, a list, a Dev Link — open the new tab
**immediately to the right of the ServiceNow tab you ran the command from**, in
that tab's own window, rather than appending it to the end of whichever window
is currently active.

Some commands accept an argument in an inline input field; the field is labelled
with what it expects and is rebuilt each time, so a label or placeholder never
carries over from the command you looked at before.

### Command palette commands

The **Command** column is the label as it appears in the palette; the *italic*
line is the description shown beside it.

**Tools**

| Command | Description |
| --- | --- |
| Translations | *Show or hide field translation controls.* Per-label icons on classic forms: a globe for `sys_documentation` (label/plural/hint) and a languages glyph for `sys_translated_text` (per-record value translations). |
| Debug Timeline | *Start recording form activity, GlideAjax calls, and errors* — and, while it is recording, *Stop recording and view captured activity.* Records a single page's `g_form` calls, native field events, GlideAjax and JavaScript errors, then opens a filterable results panel. Each GlideAjax row expands to its Script Include, method, parameters and decoded response alongside the duration, so a call can be read without the Network tab; names that look like secrets are redacted. Best-effort; does not promise named Client Script / UI Policy attribution. |
| Code Search | *Search verified code and configuration…* Searches all 14 Table API sources for plain text or a `"quoted phrase"`, including Script Includes, Business Rules, Client Scripts, reference qualifiers, catalog variables, transform logic, record producers, UI Actions, Script Actions, and Scripted REST operations. Results are read-only and open the owning platform record. |
| Search Sources | *Refresh available Code Search sources.* Re-reads this instance's search-group configuration and field definitions instead of waiting for the weekly cache to expire. Reports what changed. |

#### Code Search

Open the palette, choose **Code Search**, and enter at least three letters,
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
seven days to show up in results. **Search Sources** re-reads both
immediately and says what moved: tables added, removed or re-tuned, the
index appearing or disappearing, or nothing at all.

Code search is read-only: it performs same-instance GETs and never
runs or edits what it finds. It does not support regular expressions. Searches
are capped at 50 records per source; refine the text or use `table:<name>` to
retry that source when it reports **Capped**.

**Record**

| Command | Description |
| --- | --- |
| sys_id | *Copy the current record sys_id.* Copies it to the clipboard. |
| Record Lens | *Search verified records across readable tables…* Find a table by label or technical name, choose live dictionary-verified fields, then search text or an exact `sys_id`. Copy result IDs/URLs, open a record, or open the verified set as a platform list. |
| Playbooks | *Open playbook executions for this record…* Opens Process Automation playbook executions for the current record. |
| Playbook Updates | *Open captured updates for this playbook activity.* Listed only on a playbook (process definition) page; opens the related `sys_update_xml` customer updates. |
| Customer Updates | *Open captured customer updates by sys_id…* Enter a record sys_id or ServiceNow URL to open its customer updates. |

#### Record Lens

Choose **Record Lens** and type part of a table label or technical name. The
bounded combobox scrolls up to 50 matching tables without loading the whole
table catalog: user-facing labels come from table-level `sys_documentation` rows
and technical names from `sys_db_object`, each with its own candidate window so
one cannot crowd out the other.

When the current URL safely identifies a table, GlideLens offers it as the
starting selection — including on a classic `*_list.do` list page, where the
`_list` suffix is stripped to give the underlying table. The candidate is still
resolved against live `sys_db_object` metadata before it can be used, so a table
that does not exist or cannot be read is never silently searched.

Table suggestions and result rows are fully keyboard-navigable: arrow keys,
`Home`/`End`, `Enter` to take the highlighted item, and `Esc` to dismiss.

The field control shows exactly which live dictionary-confirmed fields will be
searched. Known tables receive useful presets, intersected with the live
dictionary; other tables use safe display and summary fallbacks. Up to six can
be selected. Sensitive value/body fields are never selected automatically,
HTML/script types are excluded, and the System Properties preset never selects
`value`.

Text searches send a safe fragment to ServiceNow and verify the complete term
again in the returned summary values before showing a row. At most 20 results
are displayed. Only `sys_id` and the selected fields are retrieved; full record
contents and search history are not downloaded or stored. Results can open the
normal form, copy their `sys_id` or URL, or open the verified sys_ids together
as a normal platform list — the list contains only the results the panel
verified, not the wider set the server prefiltered. Workspace opening remains
future work.

Failures are reported by kind rather than as one generic error: invalid input,
access denied, unreadable schema, nothing matched, and transient/timed-out are
distinguished, so a table you cannot read does not look like a table with no
matching records.

**Catalog**

| Command | Description |
| --- | --- |
| Variable Prefill | *Copy catalog-variable values from another ticket…* Enter a RITM/SCTASK/REQ/task number (or submitted-record sys_id) to prefill portal catalog variables from that ticket. |
| Variable Values | *Inspect current catalog-variable values.* Read-only panel listing every variable on the current Service Portal catalog item with its best-effort value, including variable-set variables. Filter by hidden/visible; hidden covers Hidden-type, UI Policy/client-script, and not-rendered variables. |
| Catalog Logic | *Inspect catalog client scripts and UI policies.* Read-only panel listing the catalog client scripts and catalog UI policies bound to the current item or its variable sets — type (onLoad/onChange/…), watched variable, active state, and which views they run on. Group onChange scripts by the variable they watch, see a ⚠ hint on rows that won't fire while ordering the item (inactive, or RITM/Task views only), and open the whole set as a platform list. Click a row to open the record. Nothing here runs or edits the logic. |
| Variable Insight | *Show or hide per-variable insight icons.* A per-variable icon on a Service Portal catalog form. Clicking an icon opens the Catalog Logic panel scoped to that one variable — the onChange scripts watching it and the UI policy actions targeting it (hides / mandatory / read-only / sets value) — with **Show all** to clear the scope. Also bound to `Alt`+double-click on the form. |

**Navigate**

| Command | Description |
| --- | --- |
| Table List | *Open a list for a named table…* Enter a table name (e.g. `incident`) to open its list view (`<table>_list.do`). |
| New Record | *Open a new record form for a named table…* Enter a table name to open a new record form (`<table>.do?sys_id=-1`). |

**Dev Links** — one-click navigation to common developer destinations:
Background Scripts, Script Includes, Business Rules, Client Scripts, UI Actions,
System Logs, Update Sets, Scheduled Jobs, Fix Scripts, Sys Properties, REST
Explorer, and Flow Designer.

---

## Reporting a problem

Open an issue at
<https://github.com/RushiPatel92/GlideLens/issues>. Choosing **Bug report**
gives you a short form; its questions are the ones that would otherwise be
asked in reply, so filling them in usually saves a round trip. The one that
matters most is which kind of page you were on — classic form, classic list,
Next Experience workspace or Service Portal — because each nests its frames
differently and most faults turn out to belong to just one of them.

GlideLens sends no usage or error data anywhere, by design. Nothing reaches the
author unless someone types it into an issue, so a report really is the only
signal there is.

**Please redact before you post.** This tracker is public and permanently
indexed, and GlideLens is used inside real customer instances. Remove instance
names and URLs, company and customer names, record data and user names — from
the text, from screenshots, and from any console output you paste. Console
output in particular tends to carry the instance URL and record values.

If you are reporting that something looks out of date, check the version at
`chrome://extensions` or `edge://extensions` first: a copy loaded unpacked
never updates itself, and store copies update on the browser's own schedule
rather than the moment a release is published.

---

## For developers

- Load unpacked as above; after editing, click **reload** on the extension card,
  and refresh the ServiceNow tab for content-script changes.
- There is no build step for development. The GitHub **Code → Download ZIP**
  route described above ships every repo file (engineering docs, tests,
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

See [DEVELOPMENT.md](DEVELOPMENT.md) for local testing and packaging, and
[ARCHITECTURE.md](ARCHITECTURE.md) for the two JavaScript worlds, frames,
message flow, and feature invariants.

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
