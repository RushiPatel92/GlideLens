# SN Dev Helper

A Manifest V3 Chrome extension of developer utilities for ServiceNow, in the
spirit of snUtils. Plain JavaScript, zero runtime dependencies, zero build step.

> Proof of concept, coded entirely with the help of AI.

## What it does

- Instance info at a glance in the toolbar popup.
- A `\` **command palette** on any ServiceNow tab for navigation, record
  helpers, and toggles.
- Read-only **code search** across everyday scripts and configuration source
  the platform's own code search commonly misses.
- Technical **field-name badges** and **translation icons** on classic forms.
- A best-effort **Debug Timeline** recorder for `g_form` calls, field events,
  GlideAjax timing, and JavaScript errors.

---

## Install from the repository zip

The extension is not on the Chrome Web Store — you load it "unpacked" from a
folder on your PC. This is a one-time setup; after that you just reload it when
there's a new version.

> **Microsoft Edge works too.** Edge is Chromium-based and runs this extension
> unchanged. Follow the same steps below, but use `edge://extensions` wherever
> they say `chrome://extensions`.

### 1. Download the zip

1. Open the repository page: <https://github.com/RushiPatel92/sndevhelper>
2. Click the green **Code** button near the top of the file list.
3. Choose **Download ZIP**. Your browser saves something like
   `sndevhelper-main.zip` to your Downloads folder.

   Direct link:
   <https://github.com/RushiPatel92/sndevhelper/archive/refs/heads/main.zip>

### 2. Extract it to a permanent location

Your browser loads the extension **from the folder, not the zip**, and it
re-reads that folder every time the browser starts. So put it somewhere stable
that you won't delete or move — **do not leave it in Downloads or a temp
folder.**

A good home on Windows is a dedicated folder in your user profile, for example:

```
C:\Users\<you>\BrowserExtensions\SnDevHelper
```

To extract:

1. Right-click the downloaded `.zip` → **Extract All…**
2. Set the destination to your permanent folder (e.g.
   `C:\Users\<you>\BrowserExtensions\`) and extract.
3. Open the extracted folder. GitHub zips wrap everything in an inner folder
   (e.g. `sndevhelper-main`). Make sure you can see
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
5. "SN Dev Helper" now appears as a card in your extensions list.

### 4. Pin it (optional but recommended)

Click the puzzle-piece **Extensions** icon in the toolbar, then the pin next to
**SN Dev Helper** so its icon stays visible.

### Updating to a newer version

1. Download and extract the new zip **into the same folder**, replacing the old
   files (or extract fresh and re-point the browser at the new folder).
2. Go to `chrome://extensions` (or `edge://extensions`) and click the **reload**
   (↻) icon on the SN Dev Helper card.
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
| `Alt+Shift+F` | Toggle technical field names on the current form |
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
| Toggle field names | Show/hide technical field names (`label.<table>.<field>`) as badges next to form labels. Also bound to `Alt+Shift+F`. |
| Toggle translation icons | Show/hide per-label icons: a globe for `sys_documentation` (label/plural/hint) and a languages glyph for `sys_translated_text` (per-record value translations). |
| Start / Stop debug timeline | Record a single page's `g_form` calls, native field events, GlideAjax timing, and JavaScript errors, then view a filterable results panel. Best-effort; does not promise named Client Script / UI Policy attribution. |
| Search code… | Search 14 Table API sources for plain text or a `"quoted phrase"`, including Script Includes, Business Rules, Client Scripts, reference qualifiers, catalog variables, transform logic, record producers, UI Actions, Script Actions, and Scripted REST operations. Optional `table:` and `kind:` filters narrow the sources before searching. Results are read-only and open the owning platform record. |

#### Code search

Open the palette, choose **Search code…**, and enter at least three letters,
digits, or underscores from the text you want to find. Matching is
case-insensitive. Examples:

```text
GlideRecord
"current.assignment_group"
table:sys_dictionary AutoResolutionRefQualifier
kind:transform "ignore = true"
```

The results panel groups verified matches by source and shows the matching
field, line-numbered snippets, and a link to each record or the matching set as
a platform list. Its **Source status** drawer distinguishes no matches from
access denied, unavailable, timed out, or capped sources, so a partial search
does not look complete. A filter box narrows the results already loaded.

Code search is read-only: it performs same-instance Table API GETs and never
runs or edits what it finds. It does not support regular expressions. Searches
are capped at 50 records per source; refine the text or add a `table:`/`kind:`
filter when a source reports **Capped**.

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
| Copy portal variable debug info | Copy diagnostic details about the current portal record's variables/fields. |

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
- There is no build step and nothing to package. Distribution is the GitHub
  **Code → Download ZIP** route described above; the extension is not on the
  Chrome Web Store, so extra repo files (`README.md`, `CLAUDE.md`, `.github/`)
  simply ride along and Chrome ignores them.

See [CLAUDE.md](CLAUDE.md) for architecture notes (the two JS worlds, frames,
and message flow).
