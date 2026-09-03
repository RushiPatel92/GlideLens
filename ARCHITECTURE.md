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
  `openUrlTabOptions` derives the new tab's placement from `sender.tab` so the
  destination opens in the originating tab's window, at its index plus one, with
  it as `openerTabId`. Every one of those values is validated first: a missing
  `sender.tab`, a non-integer id or window, or a negative index falls back to
  Chrome's default placement rather than passing a guess to `tabs.create`.
- `content.js` Table API reads use `snGetMany`/`snGet`, which delegate to the
  service worker and a MAIN-world request so `X-UserToken` can come from `g_ck`.
  The content-script side awaits `sendMessage` with no timeout of its own, so a
  worker handler that never answers strands the caller — every worker read must
  therefore be time-bounded per frame.

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

No worker path injects with `allFrames`. `executeScript({ allFrames: true })`
does not fail on a frame it cannot inject into — it never settles at all, so a
`.catch()` is not a timeout and a handler awaiting it never reaches
`sendResponse`. One shared discovery replaced it: content scripts answer a
`DISCOVER_FRAME` broadcast with `FRAME_AVAILABLE`, the worker collects each
`sender.frameId`, and every injection then targets one concrete frame with its
own timeout. A frame that hangs costs its own result and nothing else.

Those ceilings exist only to turn "never settles" into "eventually errors", so
each is sized well above what its operation really takes: the 5s default suits a
synchronous DOM read, and a Table API read gets 30s because it waits on the
instance. Do not put a new caller on the default without checking what it waits
for — a ceiling near the expected duration trades the hang for a spurious
failure.

Prefill is bound by inactivity rather than by a runtime budget, with a
ten-minute backstop for a page that emits progress forever. It has no bounded
runtime, and `Promise.race` does not cancel `executeScript`: abandoning a fill
leaves it typing into the form while the caller believes nothing happened, and a
retry would overlap it. So the progress message the fill emits per variable is
the heartbeat, a stall is reported as "may still be running" rather than as an
empty result, and only one fill runs per tab — the lock held until the injection
settles, not until the answer is sent. Any future long-running mutation needs
the same treatment, not a bigger number.

A read that got no usable answer while some frame never answered is
**inconclusive**, not empty. A negative answer from one frame says nothing about
a frame that timed out: the shell can report "no form here" while the frame
holding the form never replies. Never let other frames' negative answers turn a
timeout into a conclusive no.

Caching a discovered frame list is **opt-in**, and only `SN_TABLE_GET` opts in:
one user action can issue a dozen reads and each discovery costs a fixed wait. A
cached list is a stale list, so anything one-shot, context-sensitive, or mutating
— Debug Timeline start, prefill, `sys_id`, the popup probe — must discover
fresh, or it acts on a frame list that predates the frame it needed. The cache is
dropped when a load starts in that tab. Token-frame resolution layers on top: it
probes the discovered frames individually and caches the first that exposes
`g_ck`.

Reads resolve `{ results, failures }`. A frame that timed out or threw is
recorded rather than dropped, because "no form on this page" and "no frame ever
answered" are different answers and callers have to tell them apart. Reads may
also pass an `accept` predicate to resolve at the first frame that answers;
without one, a hung sibling holds a successful read for the whole ceiling.

Record Lens follows the same single-frame rule through
`SN_RECORD_SEARCH_GET`. Its metadata and result reads are bounded but repeated,
so they must not use the fan-out `SN_TABLE_GET` path either.

## Command palette

The palette is mounted only in the top frame, inside a closed shadow root. Every
frame listens for a bare `\`; sub-frames route the trigger up through the
service worker rather than mounting a second palette.

`buildCommands()` returns the command list for the current page, so
state-dependent entries (Debug Timeline Start versus Stop, playbook-only
commands) are decided per open. It ends in `validatePaletteCommands`, which
throws on a command missing an id, label, or description, on an `input` command
without an explicit `inputLabel`, and on any duplicate visible label
(case-insensitively). Two commands that can appear together must be
distinguishable by label alone; a description may not be the only thing telling
them apart.

Presentation rules that must survive future commands:

- **Labels are one or two words; the description carries the action.** Both are
  searched, along with the legacy `keywords` array, so renaming a command does
  not strand the term people already type.
- **A label match outranks a description match.** Because descriptions and
  keywords are searched too, a command's own complete label can also match some
  *other* command through that command's description — "Variable Values" matches
  Variable Prefill, whose description reads "Copy catalog-variable values from
  another ticket". `paletteMatchTier` therefore scores exact label, label prefix,
  label substring, then everything else, and `orderPaletteCommands` sorts by it.
  Without this, ordering was declaration order alone and Enter ran the wrong
  command. `tests/command_palette.test.js` asserts every built-in command ranks
  first for its own label; keep that passing when adding commands.
- **Grouping is declared, not adjacency-based.** `PALETTE_GROUP_ORDER` ranks
  Favorite, Tools, Record, Catalog, Navigate, Dev Links, and
  `orderPaletteCommands` sorts by that rank with a stable index tiebreak. The
  command array itself returns to Tools after Catalog, so rendering group
  headers as the array is walked repeats headers and breaks under filtering.
  Do not reintroduce that. Relevance ranks whole groups rather than individual
  rows across groups, for the same reason: the group holding the best match
  leads, but its members stay together.
- **A favourite is a logical key, not a command id.** `paletteFavoriteKey`
  prefers `cmd.favoriteKey`, so Debug Timeline's Start and Stop commands share
  one key and the favourite survives recording state changes.
  `normalizePaletteFavoriteKey` migrates an already-stored `start-debug-timeline`
  or `stop-debug-timeline` value on load and rewrites it. Give any future
  stateful command the same treatment.
- **The favourite appears once.** `preparePaletteCommands` clones the favourite
  into the `Favorite` group and filters the original out of the rest, and only
  while the query is empty.

Accessibility invariants:

- `#results` is the `listbox`; the search input is the `combobox` and points at
  the active option with `aria-activedescendant`, so arrow navigation is
  announced without moving DOM focus.
- Options carry stable ids from `paletteOptionId` and take their accessible name
  from their label and description elements via `aria-labelledby`.
- **Nothing interactive goes inside an option.** The favourite control is a
  single `<button>` positioned against whichever row is active, and the active
  command's shortcut hint lives in the footer. A button nested in a
  `role="option"` is not a valid listbox.
- Group labels are wrapped in a `role="group"` element referenced by
  `aria-labelledby` rather than being emitted as bare rows in the listbox.
- `trapPaletteFocus` keeps Tab and Shift+Tab inside the palette, and
  `closePalette` restores `palettePreviousFocus`. Escape closes from anywhere in
  the dialog; inside an inline argument row it returns to the command list
  instead.
- `.cmd` has a fixed height and only the active row's description expands, to a
  clamped two lines. Moving the selection must not resize rows, or the list
  jumps under the pointer during arrow navigation.

The inline argument row is rebuilt for each command rather than reused, so a
label or placeholder cannot survive from the previously selected command.

## Record Lens

Record Lens is the palette label and panel heading for the Record Search
feature; `record_search.js` and `record_search_ui.js` keep their file names.

It performs read-only Table API lookup against one verified table.
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

`recordContextFromText` is that URL parser, and it is shared with sys_id
lookup. It tries each of up to three decoded variants of the text, matches a
Workspace `/now/…/record/<table>/<sys_id>` route first, then a classic
`/<table>.do` route. A classic route ending in `_list` has that suffix stripped,
because `<table>_list.do` is the list view of `<table>`, not a table named
`<table>_list` — without that, the one page that names its table unambiguously
preselected a table that resolves to nothing. Keep the parser conservative: it
only ever produces a candidate, and `sys_db_object` still decides whether that
candidate is real and readable.

Text search never guesses columns. It walks `sys_db_object.super_class`, reads
the hierarchy's bounded `sys_dictionary` rows, and exposes the confirmed text
fields in a selector. Known-table presets are preferences intersected with
those live rows, followed by confirmed generic display/summary fallbacks. At
most six fields can be selected. HTML/script types are excluded; value, body,
content, credential, and similar fields are never selected automatically. The
`sys_properties` preset explicitly excludes `value`.

Record Lens reads time out instead of leaving the panel busy indefinitely.
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

Variable Values is context-sensitive. It parses any top-frame Workspace record
route before probing classic frames. On ordinary classic pages, a frame
qualifies only when `sys_target` and `sys_uniqueValue` agree with
`g_form.getTableName()` / `getUniqueValue()`. On a Workspace route, that
intra-frame marker is not enough: the classic frame must also name the exact
record in the top-frame route. A mismatched embedded classic form is ignored,
even when it answers first. When no matching classic frame exists, failures in
unrelated child frames are retained as diagnostics but do not suppress the
independently gated Workspace path. Before a final classic value read on a
Workspace shell, the route and expected identity are checked again.

Classic live reads use exact `variables.<name>` field names. If every safe
namespaced read is empty while a safe plain-name support probe is non-empty, the
whole catalog-variable live source is unavailable; plain values are never used
as fallback values because they may belong to record fields. Date/Time uses
`g_tz` captured in the same final MAIN-world snapshot as the live value, not a
separate `sys_user` or instance-property lookup. RITMs read
`sc_item_option_mtom` / `sc_item_option`; other classic records qualify only
when `question_answer` contains rows matching both the probed table and sys_id.
A moved record or route aborts the comparison.

Supported Workspace records use a dedicated frame-0 MAIN-world snapshot; the
reader never fans out across discovered frames. Support is allowlisted by the
`(experience path, table)` **pair**, never by either half alone: today that is
`sow` with `sc_req_item`, and `psm/workspace` with `sn_slm_case` or
`sn_slm_task`. Segment count is not the rule — `sow` is one segment and
`psm/workspace` is two — so `psm/workspace` with `sc_req_item`, `sow` with a
supplier table, a path prefix such as `psm`, and any other experience are all
refused with the truthful unsupported message. The pair also chooses the stored
reader: an RITM route reads `sc_item_option` through its catalog item, and a
supplier route reads the record's own `question_answer` rows, which is what
both supplier tables actually store — a supplier task owns its answers rather
than reading a parent's. A supplier route with no matching answer rows says so
instead of presenting an empty panel.

That allowlist exists twice, in `content.js` and again inside the MAIN-world
snapshot function, because an injected function cannot close over extension
scope and the service worker re-derives the route itself rather than trusting
the message. A test asserts the two copies are identical; a silent drift would
either start a read the snapshot then refuses, or let the snapshot answer for a
surface the router never verified. Catalog forms
are filtered by `sourceTable`/`sourceId` and corroborating composed-ancestor
record identity before geometry is considered. One collapsed current form is
valid; rectangle is used only to break same-record stale duplicates. A visible
side panel for another record is ignored. With no qualifying catalog form, the
stored-only path requires one unambiguous visible page-owned record identity;
the URL alone never establishes identity. That state is labelled stored-only
only after the stored read completes; a failed or truncated stored read reports
that neither side was available and never claims to be showing stored values.

Workspace live reads are exact pulls from `sn-catalog-form.fields` by
`variables.<name>`, followed by question and record identity checks. Question
id and exact entry name are mandatory. The entry-level
`referringTable`/`referringRecordId` pair is optional on some field types; when
both are absent the already-verified parent form remains authoritative, while a
half-pair or any supplied mismatch refuses the complete snapshot. The request
list is independently allowlisted and excludes secrets, sensitive names,
duplicates, prototype collisions, malformed definitions, and unverified types
before MAIN-world injection. Within a requested entry, `canRead === true` is
required before either `value` or `displayValue` is touched. The layer-1 type
allowlist is **per surface**, keyed by the same pair, because per-type evidence
never transfers between surfaces: every type was proven against one component
on one route, and a surface with no map of its own compares nothing rather than
inheriting another's. SOW RITMs support types 1, 2, 5, 6, 7, 8, 9, 10, 18, 21,
26, 31, 33 and 34; the supplier surfaces support 1, 2, 5, 6, 7, 8, 10, 18, 21,
26, 33 and 34, each with a runtime shape validator. Types 9 and 31 stay absent
on the supplier surfaces because no probed supplier record stores one, so there
is no evidence to allowlist from. Other types remain listed but uncompared.

Yes/No (1) has no single stored spelling. One probed instance stored
`Yes`/`No` and another `true`/`false`, and a single instance stored both —
the spelling follows whichever write path produced the value, not the
platform — which is why it is compared by boolean meaning rather than as a
raw string. Lookup Select
Box (18) is validated as a choice pair, not a reference: its raw value is the
lookup table's own value column, which was free text in 256 of 293 stored rows
on the configured instance, a sys_id in 28 and comma-bearing text in 9, so
requiring a sys_id would have refused most real lookups. Attachment (33) is
validated as a sys_id, which is what every observed stored and live value was.
Both were re-proven on a second instance through a catalog fixture the
platform itself ordered: the lookup read back its raw stored value in both
shapes it takes — a free-text label and a sys_id — each against a display
label, and the attachment read back its attachment sys_id against the file
name. For Select Box (5), the
raw string `value` is compared and a string `displayValue` is required only to
validate the observed pair shape; the display label is never substituted for
the raw choice value. Checkbox (7) compares by boolean meaning through its own
`boolean-pair` validator. Both instances exposed `value` and `displayValue` as
equal strings matching storage, so a rendered label disagreeing with the raw
value is refused as unverified. Because a checkbox has a known value domain, an
agreeing pair is additionally required to be a recognised boolean or empty: an
unrecognised representation stays uncompared rather than falling through to a
raw string comparison that could report a difference between identical states.

Native stored values are metadata-first and default-deny. The
`sc_item_option_mtom` read never requests a value column; a second, batched
`sc_item_option` read requests values only for explicitly allowlisted variable
types whose definition and stored metadata agree. Secret, unknown, structural,
and MRVS values never enter that request. Empty values, missing stored rows,
duplicates, failures, and row-cap truncation remain distinct states, and the
stored side distinguishes "read and absent" from "never read" — only a lookup
that actually ran may report a variable as not stored. Scalar
types compare raw strings; Yes/No and Checkbox recognise `true`/`1`/`yes` and
`false`/`0`/`no` as equivalent while keeping empty distinct; List Collector
compares de-duplicated, non-empty comma-separated membership. Lookup Select Box
and Lookup Multiple Choice are scalars despite the second one's name: both were
verified live to store one raw value — whichever field `lookup_value` names, so
a label as readily as a sys_id — and never a comma-separated list, so set
membership would be the wrong comparison. Attachment is a scalar too: it stores
the attachment's sys_id, so a replaced or cleared attachment reads as a
difference. Multiple Choice, Wide Single Line Text, IP Address and Requested
For are scalars on the same evidence. Date display text is normalised through
the page's `getDateFromFormat` and captured user format. The helper verifies the
wall-clock components survive the parse/local-getter round trip and refuses
browser-local DST gaps or overlaps. Date/Time additionally proves that the raw
layer-1 UTC value converts through same-snapshot `g_tz` to the normalised display
wall clock before comparing raw-to-raw with storage. A missing format, parser,
zone, malformed shape, or failed representation proof leaves the row
uncompared. The browser timezone is never a fallback. Duration stays denied because its stored side is a
`1970-01-01`-based internal value the form never echoes back, and HTML stays
denied because either side may re-encode it; comparing either raw would turn
a correct "not compared" into a false "differs".
Every structural variable type is excluded from the panel altogether, on the
native, producer, and portal paths: Break, Rich Text Label, Label, Container
Start, Container End, Container Split, Custom, Custom with Label and UI Page.
A layout divider, instructional HTML, a caption, a container boundary and an
embedded widget have no value on either side, so none of them is listed. Their
structural policy entries are kept so an unfiltered row would still never be
fetched. Type names are matched alongside the numbers because types 14 and 17
read "Custom" and "Custom with Label" on current releases and "Macro" and
"Macro with Label" on older ones.
Inactive variable definitions are
still enumerated — an old record can hold stored data for a since-retired
variable — but a row is listed only when something is stored for it, and then
says so; a retired variable with nothing stored is dropped rather than reported
as not stored, which read as a fault on a field that is not on the form at all.
Prototype-collision names are not comparable. Neither is a duplicated name, and
no duplicate is read at all: `g_form` resolves a shared name to whichever
definition it chooses, so reading the ordinary twin of a masked variable could
surface the masked value in a row not marked secret. A duplicate that shares its
name with a secret is treated as secret itself, so the probe never touches the
name.
Record-producer targets apply the same rule to `question_answer`: the first read
requests answer/question metadata without `value`, and the second requests
`sys_id,value` only for allowlisted answer ids. No matching rows means the
extension does not claim an arbitrary classic record is producer-backed.
Variable-set metadata is resolved before that second read, so MRVS child-answer
ids are excluded and each MRVS renders as one parent row.

A multi-row variable set stores nothing on its own question row, so it gets a
third read of its own against `sc_multi_row_question_answer`, keyed by
`parent_id` (the RITM for a RITM target, the record itself for a
producer-backed one) and the set. It follows the same two phases: cell and
column identity first with no value column, then `sys_id,value` only for cells
whose own column type is allowlisted, so a masked column inside a set stays
unread. `row_index` is what groups cells into rows, so a set where any cell
lacks a usable one is withheld and not compared: read order is not a
substitute, and keying on it would split one real row into a fabricated
single-column row per cell and then report those as row-count differences.
Cells are grouped by `row_index` into the same array-of-objects shape
`g_form.getValue()` returns, and compared structurally — row order matters, key
order does not, an absent key equals an empty one, and each column uses its own
comparison mode. A set with any withheld column is listed with those column
names and not compared, rather than reported as a difference. When the read
returns no rows at all for the record, the set is reported unstored and left
uncompared. The live MRVS JSON is an all-columns read, so it is requested only
when the complete set definition proves every child column positively safe and
comparable and the stored metadata reveals no withheld column. Otherwise the
set stays listed but `g_form.getValue()` is never called for it; this prevents a
masked or sensitive child from crossing the MAIN-world boundary inside the
parent JSON.

A Date or Date/Time **column inside a set** blocks the live read on every path,
classic included. The same type read as a standalone variable comes back as raw
canonical UTC and the comparison converts storage into the form's timezone to
meet it; inside a set it does not. The whole set arrives as one value with the
date cell already formatted to the user's date format and shifted into the
session timezone: one measured cell read `21-04-2026 07:13:37` where storage
held `2026-04-21 14:13:37`, and the classic panel reported that record as
differing when nothing about it had changed. Converting back was rejected, though not
because it cannot be done — the standalone path already parses a displayed date
with the page's own parser and fails closed when it cannot. The reason is that
a set is compared as a whole: every date cell would have to normalise, each
cell's type is known only from the set's column definitions, and any cell that
failed would have to refuse the whole set anyway. The set is therefore listed
with its stored rows and never compared, and the row says which column caused
it.

Workspace reads the same set through the catalog form rather than `g_form`. It
is exposed as one container entry under `variables.<set internal name>`, keyed
by the variable set's own sys_id — which is exactly the question id the parent
row already carries, so the entry identity gate needs no special case. Its raw
value is the JSON row array and its `displayValue` is the same array with
display labels substituted, and the `mrvs-pair` validator requires both to
parse as arrays of plain objects of equal length with identical column names
row for row before the raw array is compared. Every cell must be a string and
every key must be one of the set's own columns: that is what ties the array to
this variable set rather than to any array of objects, and it keeps a number,
a null or a nested object — which would stringify to `[object Object]` and
report a meaningless difference — out of the comparison. On top of the rules above, each
Workspace surface carries its **own** allowlist of the column types it has seen
the container render raw — `5`, `6` and `8` on SOW; `1`, `2`, `5`, `6`, `7`,
`8` and `33` on the supplier surfaces — because the type allowlist a surface
proves for standalone variables says nothing about what that container does
with the same type. SOW's shorter list is not an oversight: the records that
would widen it render no catalog form on that route at all, so their container
values cannot be read to prove anything. A set holding any other column type is listed and never
read, and the row names the type rather than implying the form was asked and
had nothing.

The panel never prints a set as its JSON array. Each side reports its row count
and offers the rows as a table: one line per row, one column per variable in the
set, with a column only one side carries still shown. The stored and live sides
merge into a single table, where a changed cell reads `stored → live`, only
where a verdict says a comparison actually ran. The cells it marks are the ones
the comparison itself reported, carried on the row: the panel may not re-derive
them by comparing the two strings, because a Yes/No or Checkbox column folds
`Yes` and `true` into one bucket, and a raw string compare would paint a
changed cell inside a set badged Match. a set that was listed rather
than compared keeps its sides in separate labelled tables, so the rendering
cannot imply a comparison that never happened. A row missing from one side reads
as an absent row rather than an empty one. The copy output is deliberately not
changed by any of this and still carries the whole JSON array, which is what
someone pastes into a script. When answered direct
questions expose one unique `question.cat_item`, the same catalog-item reader
enumerates unanswered direct and attached-set definitions; an absent or
ambiguous relationship remains answers-only instead of guessing through shared
variable-set attachments.

That enumerated list is then reconciled against the record's own answers,
because the two can legitimately disagree. A catalog item's attached variable
sets change over time, and a record answered before such a change holds answers
against the old question rows while the item now defines new ones carrying the
same names — observed live as an item attaching a 2024 variable set while a
2025 case answered, and the form still bound, a different set's questions of
exactly those names. The item is authoritative about which variables exist; the
record's answers are authoritative about which question each of its own values
belongs to. So where exactly one unanswered catalog definition and exactly one
answer share a name, the answer's question id, type and variable set replace
the catalog definition's, and the row says the definition came from the record's
own answer. A catalog definition whose own id is answered is left alone, so a
genuine duplicate name still reaches the duplicate-name guard rather than being
resolved silently; two definitions or two answers sharing a name resolve
nothing; multi-row parents are keyed by variable set and never substituted.
Without this, storage held nothing under the enumerated id — so the row claimed
the record had never answered a variable it plainly had — and on Workspace the
live read asked the form for an id the form does not have, which refuses the
whole snapshot and empties the panel.

Both stored readers reconcile, because the swap is a property of the catalog
item rather than of the table holding the values: the request-item reader reads
its own `sc_item_option` rows before its definitions are settled and feeds the
same function. A substituted definition then has to be corroborated against the
form. Workspace does that through the entry identity gate, which refuses when
the form's entry id disagrees. The classic reader resolves `variables.<name>`,
which cannot tell the two questions apart, so a substituted row whose question
id is not rendered on the form is listed rather than compared — otherwise the
value read back belongs to the item's new variable of the same name, and
comparing it against this record's older answer compares two different
variables.

The multi-row stored read is deliberately **not** filtered to the enumerated
set ids for the same reason. Filtered, a record whose rows live under a set the
item no longer attaches is indistinguishable from a record with no rows, and
the panel compares zero stored rows against a populated form — a difference
manufactured by the query. Unfiltered, those rows are seen but never read (no
value request is made for them), and a set with no rows on a record that holds
detached rows is listed rather than compared.

The Service Portal path remains live-only. Masked type `25` is treated as a
secret and listed redacted. Numeric type `18` is not treated as Hidden; only an
explicit Hidden type label may supply that bucket, avoiding the verified Lookup
Select Box misclassification.

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
discovery uses the shared announced frame IDs because injecting into every
frame can hang on `about:blank` helper frames.

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
