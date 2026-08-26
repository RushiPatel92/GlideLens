# GlideLens architecture

GlideLens is a dependency-free Manifest V3 extension. ServiceNow's frame model
and Chrome's separated JavaScript worlds determine its runtime design.

## Frames and JavaScript worlds

ServiceNow classic UI usually hosts the application inside an iframe named
`gsft_main`, while the toolbar and shell occupy the top frame. The form DOM
lives in `gsft_main`.

A Chrome content script runs in an isolated world. It can inspect and modify the
DOM but cannot read page globals such as `g_form`, `g_user`, or `g_ck`. Code that
needs those globals is injected with `chrome.scripting.executeScript` using
`world: "MAIN"`; DOM-only behavior remains in isolated content scripts.

Content scripts and context discovery run across frames. Runtime code must use
the frame that actually supplies the required ServiceNow context, not assume the
top frame or broadcast expensive work indiscriminately.

## Message and REST flow

- Popup to content script uses `chrome.tabs.sendMessage`. Translation toggles
  are delivered to all frames and the frame containing the form does the work.
- Content scripts ask the service worker to open tabs with the `OPEN_URL`
  message because content scripts cannot call `chrome.tabs.create`.
- `content.js` Table API reads use `snGetMany`/`snGet`, which delegate to the
  service worker and a MAIN-world request so `X-UserToken` can come from `g_ck`.

Never fetch the Table API directly from an isolated content script. Although
the session cookie may accompany a same-origin request, the CSRF token does
not. Instances that enforce the token answer 401, and callers can mistakenly
turn that failure into an apparently empty result.

Code Search uses dedicated request routes:

- `SN_CODE_SEARCH_GET` sends Table API search requests through one resolved
  token-bearing frame per tab.
- `SN_CODE_SEARCH_API_GET` uses the same frame resolution, stale-frame retry,
  and 401 re-resolution behavior for ServiceNow's Code Search endpoint.

Do not route Code Search through a handler that fans requests out to every
frame; doing so multiplies every source query on classic pages.

Token-frame discovery also never injects with `allFrames`. Content scripts
announce their concrete eligible frame IDs, then the worker probes those frames
individually with a short timeout and caches the first one that exposes `g_ck`.
This prevents an uninjectionable helper frame from blocking every search read.

Record Search follows the same single-frame rule through
`SN_RECORD_SEARCH_GET`. Its metadata and result reads are bounded but repeated,
so they must not use the all-frame `SN_TABLE_GET` path either.

## Record Search

Record Search performs read-only Table API lookup against one verified table.
Its combobox sends query-safe contains needles, including a complete label
phrase and underscore-normalized technical-name form for clean multi-word
input. User-facing table labels are read from table-level `sys_documentation`
rows, with `sys_db_object.label` as an access fallback; technical names come
from `sys_db_object`. The label and technical-name queries receive separate
bounded 50-row candidate windows so one cannot crowd out the other. Results are
merged, verified, relevance-ranked, and the scrollable combobox returns at most
50; the feature never downloads the full table catalog.
A returned suggestion must also contain that anchor in its label or name, so an
ignored server condition cannot populate the combobox with unrelated tables.
A table parsed conservatively from the current URL can be offered initially,
but it still has to resolve through live metadata before use. Workspace opening
and workspace discovery are intentionally outside this feature.

Text search never guesses columns. It walks `sys_db_object.super_class`, reads
the hierarchy's bounded `sys_dictionary` rows, and exposes the confirmed text
fields in a selector. Known-table presets are preferences intersected with
those live rows, followed by confirmed generic display/summary fallbacks. At
most six fields can be selected. HTML/script types are excluded; value, body,
content, credential, and similar fields are never selected automatically. The
`sys_properties` preset explicitly excludes `value`.

Record Search reads time out instead of leaving the panel busy indefinitely.
The broad optional dictionary read has a shorter timeout and may degrade to the
separately verified display and preset fields rather than block table selection.

Only a query-safe anchor reaches the encoded query. Every returned row is then
checked for the user's complete case-insensitive term in the retrieved summary
values. Invalid or unexpected metadata field names are rejected rather than
sent to ServiceNow.

The server returns at most 50 candidate rows and the panel shows at most 20
verified results. Only `sys_id` and the selected summaries are retrieved; full
record contents are neither requested nor stored. Exact `sys_id` lookup can
fall back to `sys_id` alone when dictionary metadata is unreadable.

Verified record results sort by match quality (exact value, prefix, word-start,
then contains), followed by the first displayed field and `sys_id`. The results
status names this order so it is not mistaken for an instance-defined sort.

Result rows provide form opening plus Copy sys_id and Copy URL actions. The
panel can open only the verified result sys_ids as a normal platform list; it
does not replay the broader server prefilter or open a Workspace route.

Table metadata caches only in page memory. A newer search or a closed panel
invalidates older work so stale results cannot replace the current search.

## Translation icons

Classic labels can receive two translation actions:

- A globe opens `sys_documentation` for label, plural, and hint records. The
  defining table is resolved by following `sys_db_object.super_class` and
  checking `sys_dictionary`, so inherited fields target the right table.
- A languages action opens `sys_translated_text` for record-value translations.
  It is shown only for dictionary types that can contain translated values:
  `translated`, `translated_text`, `translated_html`, and `translated_field`.

The translatable-field set is fetched once per table hierarchy and cached for
the page lifetime. Resolve it away from the synchronous toggle path. A failed
lookup should leave a potentially useful icon visible rather than claiming the
field cannot be translated.

The old field-name badge UI is intentionally retired because snUtils covers it.
Its dormant implementation and `TOGGLE_FIELD_NAMES` handler remain in
`content.js`; do not relist the feature without an explicit request.

## Catalog and Service Portal behavior

Variable insight icons open Catalog Insight scoped to an individual variable's
onChange client scripts and UI policy actions. The variable name and definition
sys_id exist only in Service Portal's Angular field model, so a MAIN-world
helper stamps `data-snh-var*` attributes and the isolated-world content script
anchors icons to those attributes.

Restamping is Service Portal-specific and occurs only for unstamped variables.
Do not reuse the classic toggle-persistence observer. Per-variable attribution
is valid for onChange scripts and matching UI policy actions; onLoad/onSubmit
scripts and variable-less policies remain form-level behavior.

Catalog prefill waits for observable GlideAjax work rather than matching known
variable names. `fillPortalVariables` temporarily wraps `getXML`,
`getXMLAnswer`, and `getXMLWait`, waits until nothing is outstanding and no
request has started or finished for 150 ms, and caps the wait at 2 seconds.

Keep these invariants:

- Install and remove the page-prototype wrappers around the complete fill in a
  `finally` block.
- Pass calls without callbacks through uncounted because their completion is
  not observable.
- Preserve the per-type delay floor (25/150/400 ms), which gives onChange code
  time to start asynchronous work.
- Never reintroduce variable-name matching. If necessary, tune the settle
  window or learn timing from retries without retaining customer vocabulary.

## Debug Timeline

Debug Timeline is a best-effort, single-page interaction recorder for public
`g_form` calls, native field events, GlideAjax timing, and JavaScript errors. It
does not promise named Client Script or UI Policy attribution.

MAIN-world patches must be reversible. Traces stay capped and redact fields or
parameters whose names indicate secrets. GlideAjax is patched at `getXML`,
`getXMLWait`, and `getXMLAnswer`; the last may return a plain answer string and
does not reliably delegate to `getXML`.

When delegation does occur, the per-instance `glideAjaxOwnedElsewhere` flag
keeps the inner call silent so one request is not recorded twice. Frame
discovery uses announced concrete frame IDs because injecting into every frame
can hang on `about:blank` helper frames.

## Code Search

Code Search performs read-only searches across a registry of Table API source
adapters and, where installed, ServiceNow's own Code Search endpoint. It accepts
a case-insensitive substring, one quoted phrase, and `table:` scope for targeted
retries. Regex is intentionally refused because a literal server prefilter
cannot soundly cover optional or alternative matches.

Only a query-safe anchor enters the encoded server query. Every returned field
must be verified against the original term before rendering: ServiceNow can
silently ignore an invalid queried field and return unrelated rows.

The source capability probe follows `sys_db_object.super_class` because fields
exposed by child tables may be defined on parents. Probe failure means unknown,
not absent. Parent adapters can declare an exact class to avoid duplicate child
rows. All instance text is rendered as text, never instance-provided HTML, and
sensitive-named hits are redacted.

Requests use one token-bearing frame, concurrency four, a 20-second source
timeout, and a 50-row per-source cap. The engine and UI are injected lazily and
remain absent from `manifest.json`.

### Instance Code Search endpoint

Several defensive rules are required:

- Send `table` scope only for tables in the discovered coverage map. The
  endpoint can ignore unsupported table scope and return an unscoped search.
  Validate the concrete record types returned.
- Treat 500 raw hits as saturation. The endpoint has no reliable truncation
  flag, and one record type can consume the cap, so retry covered tables through
  the bounded pool.
- `lineMatches` contains context lines. Produce snippets only from lines that
  contain the term, use its plain `context`, and never render pre-escaped HTML.
- File hits under their concrete class because the endpoint follows table
  inheritance and can return child records under a parent record type.

Capability probes and coverage maps cache per origin for seven days. The
"Recheck what code search can reach" command refreshes both and reports a diff
against valid cached data. A failed refresh is not a change and must not destroy
the previous usable map.

Coverage is tracked per `table.field` from `sn_codesearch_table`. Skip a Table
API adapter only when the endpoint searched that table without saturation and
covers every field the adapter reads. An `additional_filter` means partial
coverage, so retain the adapter. Never assume completeness from the endpoint's
presence alone.

## DOM persistence

Classic-form toggles reapply after rerenders through the toggle-persistence
`MutationObserver` in `content.js`. Disconnect it while reapplication mutates
the DOM, debounce rerender bursts, and gate full teardown/rescan with a cheap
staleness check.

Workspace forms remain intentionally excluded. Their fields require walking
elements through nested shadow roots and are a separate roadmap item.
