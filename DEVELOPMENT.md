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

### Step 3 is not optional, and skipping it looks like a broken change

Refreshing the ServiceNow tab re-reads every content script from disk, so a
`content.js` edit appears without touching the extension card. The **service
worker does not work that way**: Chrome keeps running the `background.js` it
registered earlier until the extension is reloaded. A change to the worker
therefore has no effect while its content-script half plainly works — which is
indistinguishable from the change itself being wrong.

Reload the card whenever `background.js` changes. If a fix seems not to work
and only the worker's half is missing, suspect this before suspecting the fix.

Loading the repository root unpacked is otherwise fully supported and has been
verified end to end against two instances and two record surfaces, matching the
same results the packaged artifact produces. Use an extraction of
`dist/*.zip` for release validation — there the point is to test the artifact
people install, which excludes tests, docs and plans — not because the
repository directory behaves differently.

## Tests and validation

Run all Node tests explicitly so behavior does not depend on Node's directory
discovery rules:

```powershell
node --test tests/code_search.test.js tests/code_search_api.test.js tests/code_search_ui.test.js tests/frame_discovery.test.js tests/search_transport_frames.test.js tests/record_search.test.js tests/record_search_ui.test.js tests/command_palette.test.js tests/content_context.test.js tests/open_url.test.js tests/debug_timeline.test.js tests/debug_timeline_frames.test.js tests/prefill_settle.test.js tests/prefill_impersonation.test.js tests/prefill_cross_instance.test.js tests/variable_values_native.test.js tests/translation_lens.test.js tests/translation_lens_ui.test.js tests/translation_lens_integration.test.js tests/translation_assistant.test.js tests/translation_assistant_ui.test.js tests/translation_assistant_integration.test.js tests/impersonate.test.js tests/impersonate_ui.test.js tests/impersonate_integration.test.js
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
  search cancellation. Starred tables: favourites merged into the table menu
  first, once, in stored order, with the active option kept by name; a
  remembered field confirmed only by its own row in the bounded candidate read,
  reported absent when that read has no row and unverifiable when its window
  was full; remembered fields in the cache key, so a search verifies against
  the same read. And the worker's own block, loaded from `background.js`: the
  key comes from the sender and a message naming an origin is refused, every
  bad shape is refused rather than coerced, two interleaved stars both survive,
  the cap is checked against stored state, a list never writes, unstarring the
  last table removes the key, and the instance ceiling drops the instance
  changed longest ago; filter field names are stored and validated, never
  anything shaped like a value. Value filters, against a double of the
  instance: field discovery (references with a table, string and integer
  choice fields, `"none"` is no choice list, the nearest definition decides,
  sensitive excluded, a full window reported, a timeout an error); the
  display column through every step of the verified order and the override
  hint; reference values by display column, the type-ahead past 300, a pasted
  sys_id, and a blank display column as an access error; choices from the
  concrete table, through a redirect, in the instance language with the
  English fallback, de-duplicated when dependent; the value refusals; the
  builder's binding, three-filter cap, one-per-field rule and order
  assertion; and the search itself — filter-only order kept and named, filter
  plus text, a row dropped when any one filter differs, and a blank read-back
  reported as access. Import set staging tables are tagged and listed last.
  Typing the exact technical name keeps one first, even when it is labelled
  with its own name. A full staging window is checked again by name for the
  candidates on screen. A failed staging read loses only the tags. The
  hierarchy flag carries through to a sys_id search's result. Search and Show:
  - Field discovery lists text and reference fields as searchable and the
    shown-only types as listable. Unsafe types and the legacy `numeric` are
    never listed.
  - A table with no display or familiar text field defaults to its first four
    references.
  - Columns are verified in order, any listed field qualifies, a shown-only
    field can never be searched, and remembered columns are confirmed by name
    and key the cache.
  - A search reads its columns, matches a reference by name, appends a match
    in an unshown field, and ranks by the searched fields. A searched reference
    blank on every row, with nothing verified, is an access answer; blank on
    some rows, or beside a verified row, it is not.
  - The worker stores columns in order, keeps them across a star that omits
    them, and refuses bad lists with a "column" prefix.
- `record_search_ui.test.js` — the Record Lens panel under `node:vm`, on a DOM
  shim with a minimal parser for the panel's own static template and a
  selector matcher that throws on anything it does not support. Starred tables
  open as real options before anything is typed, on every path that opens the
  menu on an empty box; while a lookup runs only matching favourites are
  selectable and, with none, Enter selects nothing; live results arrive behind
  the favourites with the active option kept. The star is its own cell outside
  the clipping summary, enabled only once the table is verified, with a
  constant name and `aria-pressed`; the cap refusal; a failed favourite
  unstarred from where it fails without losing focus; remembered fields
  applied, saved only for a starred table, named when gone, and never saved
  after they could not be verified. Value filters: rows appear only for a
  verified table, at most three, each picker with ids never reused; a field
  used in one row is not offered in another and a value waits for its field;
  picking a field opens its values; a search sends only complete rows and
  names the rest; nothing is searched with neither text nor a complete filter;
  Escape closes a filter menu before the panel; every picker is busy during a
  search; an access error and a capped list are shown as such; a table change
  removes the rows; a starred table restores its filter fields with empty
  values, names one that is gone, and never saves over ones it could not
  verify. The Table and Text ✕ buttons: shown only with text. During a search
  the Table ✕ is inert and the Text ✕ stays live. The Table ✕ drops the
  selection, its filters and a lookup it overtook, then shows the starred
  tables. Copy confirmation is on the pressed
  button and restores its label, and a blocked copy says so there too.
  Searching as the question changes: a table change clears the results, and
  text already typed searches the new table unless its ready line warns. A
  typing pause and a field change search, while an unchanged question does
  not. A short term withdraws the answer neutrally, and an emptied one returns
  to ready. A value pick or clear, a field clear and a row removal search. One
  search runs at a time, and only the latest waiting question is asked, with
  the outdated answer never shown. Focus returns to the picker without
  reopening its list, and to the text box when the search replaced the control
  that had it. A starred table under typed text is searched only after its
  filter rows are restored, and not at all when a filter field is gone; it
  still saves afterwards. A filter-field clear leaves the status line to the
  search it starts. The shim drops focus from a detached node and will not
  focus one, as Chrome does. Search and Show:
  - Show starts as what is searched, keeps the order ticked with a position
    badge, and asks again after the pause, even with an answer on screen.
  - The last column cannot be unticked, and Show is capped at six.
  - Both pickers are busy during a search.
  - A starred table's columns come back in order and are saved on change. A gone
    column is named, and unverifiable ones are never saved over.
  - A match in an unshown field is marked.
  - Opening one picker closes the other, and Escape or an outside click closes
    both.
  - Opening sorts ticked rows into Selected (columns in shown order, where that
    differs from list order). A row pressed while open stays put.
  - The find box takes focus on opening and matches label or technical name,
    trimmed and in any case. Its headings and no-match note follow what is
    visible, Enter in it never submits, and reopening empties it.
  - Escape in a picker hands focus back to its button.
- `command_palette.test.js` — the pure palette model: label/description
  matching, relevance ranking (every built-in command must rank first for its
  own exact label, and groups must stay contiguous),
  the accepted unique built-in labels, declared group order, the
  single-appearance favourite, the stable Debug Timeline favourite key across
  Start/Stop, rejection of duplicate labels and implicit input labels, and
  source assertions for the listbox, `aria-activedescendant`, focus trap, and
  shared panel headings. Also that every `*_ui.js` panel, found by glob rather
  than listed, carries the shared GlideLens teal and pink tokens and stops the
  page's inherited styles with `:host{all:initial}`, which no host rule undoes
  with `inherit`, `unset` or `revert` — there is no build step to share CSS, so
  the copies are compared instead.
- `content_context.test.js` — conservative table and sys_id detection from page
  URLs, including the classic `*_list.do` suffix strip, classic record routes,
  encoded URLs, and the complete Workspace experience path. Workspace support is
  asserted as an `(experience path, table)` pair rather than a segment count:
  each supported pair resolves to its stored reader, and every half-match — the
  right table on the wrong experience, the right experience with the wrong
  table, a path prefix, a reversed or extended path — is refused. A record
  opened as a **sub-tab** nests its route inside the tab owner's, and the
  assertions pin that the innermost record wins, that the experience path stops
  at the first `record/` instead of swallowing the trail, that only a
  `sub/record/` segment moves the identity, that deeper nesting still resolves
  to the record on screen, and that the sub-record is allowlisted on its own
  pair — a supported owner never vouches for an unsupported sub-record.
- `open_url.test.js` — `OPEN_URL` tab placement beside the originating tab, and
  the fallback to Chrome's default placement when tab context is missing or
  invalid.
- `debug_timeline.test.js` — reversible MAIN-world recording, including all
  GlideAjax entry points.
- `debug_timeline_frames.test.js` — discovery and injection across concrete
  frames without hanging on helper frames.
- `prefill_settle.test.js` — installation and removal of GlideAjax settle
  tracking around catalog-variable prefill.
- `prefill_impersonation.test.js` — Prefill while impersonating. The worker's
  real impersonation block against a simulated server: a confirmed switch reads
  as you and puts the same impersonation back with one request per switch, the
  original account never reaches content code, the server's answer about who
  the session is beats the page's stale one, the dialog fallback, a refused
  switch back that is never re-sent, concurrent or stray BEGIN/END messages
  that send nothing, and the routes reading one checked field. The command
  against a simulated instance: the switch is offered only for a 403, a hidden
  ticket, answers whose questions are all unreadable, or a partial refusal
  while impersonating — never for a timeout, a server error, a few deleted
  questions, or `question_answer`'s refusal on a request item whose own
  answers were read —
  nothing switches before the click, the order is switch, read, switch back,
  fill, a second run during the switch is refused, late progress cannot
  replace a run's last message, and every failure fills nothing — including a
  failed switch back with the palette closed. On a minimal fake DOM: clicking
  either confirmation button returns focus to the input, and Esc there closes
  the palette once a run's last message is showing. `frame_discovery.test.js` adds
  that no fill starts while a switch holds the tab.
- `prefill_cross_instance.test.js` — Prefill from another instance. Parsing:
  a link names its own instance and wins over Read from, a link's sys_id is
  taken from Workspace, classic, `nav_to` and portal routes, and a non-SN,
  `http:` or credentialed link is refused; a ticket not found here is never
  looked for elsewhere, and two records with one number are refused. The
  worker's real routes against simulated tabs: origin and sender validation,
  the incognito rule, origins only in the Read from list, skipped discarded
  and token-less tabs, active-then-recent ordering with at most three tries,
  frame 0 only, `undefined` as no receiver, a failed send before the first
  heartbeat trying the next tab and after it not, the progress relay, the
  inactivity bound and ceiling, the reply allowlist (multi-row sets pass, a
  wrong type refuses, unknown fields drop, oversized replies refuse), one
  read per tab, the switch refusal, and the impersonation read only after an
  access answer. The shared reader: `expectedOrigin` and `requireToken` refuse
  before any fetch, a non-JSON body is a failure, a thrown fetch still throws,
  and `SN_TABLE_GET` prefers this instance's failure over another origin's.
  The export: a token and this origin on every read, a heartbeat before the
  first read, no Prefill state touched, its listener removed on failure, and
  answering only the extension from the top frame. The preparation: found,
  missing, refused and tableless references, chunking at 100, list subsets,
  lookups, attachments and multi-row cells. The run: counts that add up to the
  number read, neutral notes, no value or sys_id in any message, every
  refusal's wording, and no session switch offered or made. On a minimal fake
  DOM: Read from under the input, the hint in both states, a pasted link moving
  the select, Tab and Shift+Tab through the trap, Esc and Enter on the select,
  and finished lines drawn as text by kind.
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
  prototype collisions, portal masked-type behavior, copy safety, that a
  producer-backed classic record makes no visibility claim while a request item
  still does, and native
  panel accessibility/source invariants. Workspace coverage includes frame-0
  transport, identity-before-geometry form selection, collapsed/stale forms,
  exact safe state-map pulls, `canRead` non-access, that a
  boolean-valued entry is read only where the surface and the variable's own
  comparison mode both allow it and never for a number or an object, its per-surface type policy
  and the proof that no surface inherits another's proven types,
  that both worlds gate on the identical surface allowlist and an unlisted
  surface is refused before any read,
  that the MAIN-world snapshot resolves a sub-tab route to the sub-record and
  refuses an unlisted sub-record table, and that both worlds carry the same
  sub-tab rule — neither may keep a greedy experience group, because the
  snapshot re-derives the route itself and a fix applied to one world alone
  would have the content script ask for a record the other refuses to describe,
  producer-backed Workspace records and the definition-completeness field each
  stored reader actually sets, multi-row sets on Workspace — that a proven
  surface requests and compares one, that an unproven surface says it was
  listed rather than implying the form was asked, how the panel renders a set's
  rows as a table — the merged stored/live grid only where a verdict says a
  comparison ran, separate labelled tables where it did not, an absent row
  distinguished from an empty cell, and the copy output still carrying the whole
  array — that the `mrvs-pair`
  representation check refuses every way the value/display pair can fail, that
  the panel's candidate count is exactly the set of rows a live read was
  requested for — including a name duplicated only in storage, which both the
  request builders and the panel must treat identically — that a set which was
  never asked for says why rather than describing the form's state, that the
  live representation check requires string cells belonging to the set's own
  columns — on the classic path too, where a nested-object cell used to reach
  the comparison, and with no escape hatch for a set whose columns were never
  resolved — that a record holding rows under a set the item no longer attaches
  refuses instead of reporting a difference, that the detached rows behind that
  refusal are found by a bounded limit-one probe so they cannot consume the
  metadata read's row cap and truncate every set on the record, that a probe
  which fails refuses rather than assuming there are none while reporting itself
  as unknown rather than claiming rows it never saw, that a set whose every
  column was withheld says so rather than reporting no rows found, that a record
  whose rows are all detached says so instead of reading as simply empty, that a
  substituted definition is
  refused on the classic form when the form does not render its question, that
  the request item reconciles a swapped set exactly as a producer record does,
  that a failed answer preload is final rather than retried into a panel whose
  definitions were never reconciled, that an answer under a variable set the
  reader cannot identify never substitutes, and that a substituted definition
  keeps the hidden-type and inactive flags it was read with, and that a date column inside a set blocks the live read on
  every path including the classic one, reconciling a catalog-item definition
  against the record's own answer when a swapped variable set leaves two
  questions sharing a name — including every ambiguous case it must refuse —
  Select Box raw-value/display-label separation, malformed representation
  rejection, end-to-end Checkbox boolean comparison refusing both a disagreeing
  and an unrecognised pair, tri-state visibility, verdict-derived panel
  completeness, and structurally honest stored-only copy.

- `translation_lens.test.js` — the Translation Lens engine: storage routing by
  dictionary type, chunked query construction and the values it refuses,
  hierarchy walking with a cycle guard, language/base/fallback resolution, the
  per-language state model, string-key matching pinned to the measured
  platform behaviour (capitalisation on `sys_translated` and
  `sys_ui_message`, plus the 68 measured letter folds and the trailing space
  on `sys_translated`, each covering, each measured-distinct letter not, and
  anything only a wider suspect key matches Unverified rather than counted),
  exact matching everywhere else, near-duplicate, capitalisation-variant and
  spelling-variant detection,
  `getMessage` extraction, link and report construction, and that an empty
  translated-field source is Not applicable rather than Unverified. The section
  summaries are pinned both ways: a scoped summary re-counts the same rows over
  only the languages asked for, applies the identical excluded-state rule,
  never rewrites the row it counted, and treats an empty selection as a
  selection rather than as every language.
- `translation_lens_ui.test.js` — the panel. A late call from a superseded run
  must never paint; progressive sections accumulate and are then replaced
  rather than stacked; absent data never reads as coverage. Also the language
  picker, which rescopes the score while the all-language score stays drawn
  beside it so that narrowing a selection cannot hide a gap, and the round trip
  back again, because the scope is memoised for the duration of a paint. Minor
  rows fold away without changing what was counted, each section carries its
  own score over the same selection as the headline, and the report carries no
  value, URL, hostname or sys_id. Most cases run the panel with no engine
  loaded, which is what exercises its local fallbacks; two load both files into
  one sandbox to pin the contract between them.
- `translation_lens_integration.test.js` — the runtime boundary: the
  six-method UI contract `content.js` depends on, the worker routes, the
  packaging allowlist, and source assertions for behaviour the engine
  deliberately does not export.
- `translation_assistant.test.js` — the Translation Assistant engine: which
  rows are eligible (lock state, not "has no translation"), the destination
  grouping that makes a shared `sys_translated` row all-or-nothing, the JSON
  envelope and its instruction block, reply parsing through fences and prose,
  every per-row verdict, the overrides bound to a reviewed value, the budgets,
  the merge invariant that writes `translatedValue` and introduces no other
  key, and the bounded draft store that survives a worker teardown. A reload
  on its own refuses nothing — the regression guard for a fingerprint that
  must hold no frame handle. Also the language names: the `sys_language` query
  is built only from ids shaped like one, so page text naming `javascript:` or
  carrying a caret or comma never reaches it, and a name is used only when the
  rows give exactly one — otherwise the draft shows the page's codes. And what
  the fill reads back: every merged field is addressed by position and by
  record, and each row says whether publishing it changes the translation
  instance-wide. And rich text: the strict tag scanner reads ordinary markup
  and refuses what a browser could read differently — a comment, a stray `<`,
  `<p/onclick=…>`, a quoted value holding `>` — and stays fast on input built
  to make it slow; a rich field is exported with `format: "html"` and a
  prompt stating the rule only when its editor is reported ready; a source
  with no words, a script, a form, an event handler or a script URL (entity-
  encoded included) is excluded by name; a reply is written as the source's
  own tag bytes around its words, and one that adds, drops, moves or changes a
  tag, attribute or link is blocked with no override; tags with no words are
  blank; unchanged is judged by words, since the page holds the editor's
  serialisation; the limit is measured on what is written; and the merge
  leaves rich text out of the array, keeps `$$hashKey`, and lists it for the
  editor writer.
- `translation_assistant_ui.test.js` — the panel, loaded under `node:vm`
  against the same small DOM shim the Translation Lens panel uses. Drafts are
  built by the real engine rather than written as literals, because the
  defects worth pinning here only appear when two fields share one
  destination: the tally is counted in fields and reconciles against the
  exclusion buckets, the deduplicated row count is stated rather than
  substituted for it, and the instance-wide warning follows the destination's
  storage model, not how many fields on this item happen to share it. Also the
  house style: the shared palette, the footer every panel carries, exactly one
  pink primary route with the copy route drawn as a link, and the language pair
  in the subtitle's mono accent. And feedback on the control that was pressed —
  a copy or download flashes its own outcome and reverts, under fake timers —
  plus the shared-translation list: each row named, each linked to the fields
  that use its text through a same-origin URL built only from the page's own
  table and column, and to the sys_translated row a publish would write for the
  target language. Both follow Translation Lens's rules for what a filter can
  carry — no link for a caret, a line break, an unsafe table or language — and
  one more: no link for a text naming a `javascript:` expression, which the
  server would run rather than match, and the row says why. And the counts
  that open into a list — already translated, and the two rich-text buckets,
  each naming its reason — closed by default,
  each field shown with its current translation (rich text as plain words in
  whichever bucket it sits, and in every report row and replaced translation,
  read through the fill's own scanner rather than a pattern over angle
  brackets, which would take a `>` inside a quoted attribute for the end of a
  tag and put the rest of that tag on screen dressed as words — a source the
  scanner refuses is shown as written instead, never stripped into something
  that only looks like words; every other type literally, angle brackets and
  all) and linked to its store:
  `sys_translated` for shared text, `sys_translated_text` by sys_id for
  per-record fields. Every entry is built from the same parts however long its
  text — the text, its translation, then one line holding where it lives and
  its link — and the stylesheet the panel injects keeps each text to one line,
  cut at a whole word, with the whole of it on hover.

  Then the reply coming back. There is no preview before the fill — the
  comparison page is the preview — so the report is what these pin, against
  evaluations the real engine produced: Fill sends the pasted text and reports
  the fields filled; an empty box sends nothing; a placeholder mismatch is not
  filled until Fill anyway resends the same reply with that row; a field changed
  on the page offers Overwrite bound to the value it shows; a replaced
  translation shows its old text, because clearing the box would delete it; a
  partial landing names what did not take; a refusal keeps the reply in the box
  and shows how it starts; a timeout says the fill may still be running. A
  reply whose tags are not the source's is blocked with nothing to choose past
  it, and names the first tag that differs: the two texts read alike, so a
  reason that only says the tags differ leaves nothing to act on. Every reason
  the page-side writer gives for a rich-text field it did not fill reaches the
  report as its own sentence, including the three separate ways a write can
  fail to hold, and only the one that leaves the page uncertain advises a
  reload. A
  second press while a fill runs sends nothing, an answer for a replaced panel
  is not drawn, and choosing a file loads it into the box without filling.
  Each report entry is built from the same parts — the field, its text, a
  labelled pair of values, then one verdict line holding the reason and its
  button. And the panel's per-run history: the old text of a replaced
  translation and the shared-translation warning survive the next click and a
  refusal; a shared row that half landed names the field that missed and
  keeps the old text of the one that did; a fill the page could not confirm
  keeps every attempted row's old text, labelled as attempted rather than
  filled, and that uncertainty survives a refused click. The history is
  kept by field and grouped by destination: a reply from another draft that
  reuses a row number keeps its own old text, a member of a shared row that
  lands only on a later fill joins, and shared translations are counted by
  destination, not by field. And Overwrite from a per-field display binds
  every field to the value shown for it, an empty one included.
- `translation_assistant_integration.test.js` — the runtime boundary: the
  four-method panel contract `content.js` depends on, the command listed from
  the decoded URL but acting only on a probed scope, the MAIN-world read that
  names why a frame is not the comparison page, the three independent
  editability states it reads rather than infers, the draft held in
  `storage.session` before it is ever offered, both output routes emitting the
  one serialised string, the panel's link guard run against a same-origin link
  and three it must refuse, and the packaging allowlist. Also the shape of the
  one write: the page's own `updateDocumentContent` event, fired only by the
  worker's MAIN-world writer into the one frame that fill's own fresh read
  selected, never by the panel or the content script; the fill lock released
  by a navigation or a closed tab; nothing persisting a frame handle; and no
  user-facing string calling a locked field verified.

  The second half of the file executes the worker's draft store and the
  content script's runner rather than reading them, against storage and
  messaging shims: concurrent saves both survive, a dismissed run writes
  nothing to a store that outlives it, a slow first run never opens over the
  panel a later run owns, the draft is not offered until the store accepts it,
  and a frame that never answered is not reported as the wrong page. The
  language-name read runs through the same shims: its names reach the prompt
  and subtitle, a refused read still yields a draft in codes, a run dismissed
  during it saves nothing, and codes that are not id-shaped send no read.

  The fill route runs too, against a real engine, a faked page read and a
  faked `executeScript`: every passing row is written and a placeholder
  mismatch held back until asked for; rows the fill does not touch survive the
  array replacement byte for byte; a fill that never settles is reported as
  indeterminate and a retry is refused — before the page is even read — until
  the injection settles, which is the case a timeout followed by a clean read
  must not unlock; every page precondition (read-only, a request in flight or
  unknowable, another item or language, a changed element count, no page)
  refuses before anything is written and releases the lock; a reply from a
  draft this browser no longer has refuses before the page is read; and the
  count reported is what landed. The page-side writer runs against a faked
  Angular scope: it fires once and counts only fields holding the value on
  their own record, refuses when the page moved since the read and names where,
  refuses on any page state it cannot confirm — including the accessor that
  throws when `additionalInfo` is undefined — and does not refuse an untouched
  page whose snapshot came back through Chrome with its keys reordered, the
  defect the live check found. The faked scope keeps the original and the
  bound copy apart, and typing lands only in the bound one, so a writer that
  read the original would fail the refusal test rather than pass it. Also
  from the Codex round on the fill: a navigation that releases the lock while
  a fill is still awaiting its read stops that fill, and only the next one
  injects; a shared row that half landed comes back by field, not only by
  row; and a fill whose read-back threw after the event fired comes back
  unconfirmed with its rows, never as a count of zero. From the round after:
  the writer refuses a replacement page holding the same content — a
  reloaded document, another target language from the URL or the scope,
  another item — and writes the page the read came from, identified the same
  way; the reader records the document's time origin and the fill hands the
  writer that identity; and a stale fill leaving does not release a newer
  fill's lock that is still held. Rich text runs against faked TinyMCE
  editors wired the way the page wires them — bound through the textarea's
  row scope, with a `SetContent` handler that moves the model and the
  textarea — and rebound to the new objects when the event reuses a row: the
  write lands after the event in the model the event installed, never in the
  object it replaced; a page that has taken the event but not yet rebuilt its
  rows — the fake defers that digest — leaves the field alone rather than
  writing into an object about to be thrown away and swapped out behind an
  editor still showing the translation; rich text alone fires no event; an
  editor holding an edit the page has not recorded, an editor dropped with its
  row, a locked field, a read-only or unstarted editor, two editors on one
  field and another record are never written; a write that does not hold is
  put back and reports which check it failed — the editor changed its words,
  it came out over the limit once serialised, or the model did not follow,
  each asking something different of the user — and one that cannot be put
  back comes back uncertain. The worker hands rich text to the writer apart
  from the merged array, and a fill whose every rich field was refused is a
  report keeping only the reasons it knows. The reader and the writer each
  hold a copy of the test for an editor bound to a field, so those two blocks
  are compared as source and cannot drift apart. Those blocks are lifted
  from their real files by the same anchors the source assertions use, so
  moving one fails loudly instead of testing nothing.

- `impersonate.test.js` — the Impersonate engine under `node:vm`, with
  `record_search.js` loaded first as the worker injects it. The query
  boundary (a three-character user anchor, a two-character role anchor, the
  sys_id path that bypasses both, and a hostile term becoming at most one
  `[A-Za-z0-9_]` run); the fixed table allowlist, which the suite caught as
  incomplete — the hierarchy walk reads `sys_db_object` through this
  transport, so omitting it had silently pinned `sys_user`'s hierarchy to
  itself. Eligibility as a safety rule, re-checked client-side after the
  server was asked for it. The four query orders and which one each input
  combination takes, with the attribute entering the *candidate* read when
  text is present and the *user* read otherwise — never as a post-filter after
  a cap. The two opposite capped-membership rules: in text+role and
  text+group the cap corrupts the filter, so that filter is `unavailable`; in
  role-only and group-first it truncates the list, so partial results are
  honest and no total is claimed. Group-first's member read dot-walks every
  eligibility term through `user`, both halves of the OR group included and
  still last, with the attribute before it; and because a misspelt dot-walk is
  silently ignored rather than refused, one fixture answers that read
  unfiltered — duplicates, an empty user, an inactive, a locked and a
  web-service-only member, and a row for another group — and the list and
  count must still come out right. Group suggestions AND every typed word,
  verify each word rather than the complete term, carry no `active` filter,
  treat an empty `active` as active, and rank inactive groups after active
  ones. An email-shaped term anchors on its local part while rows are still
  verified against the whole term, and an attribute condition is refused for
  any column the filter does not offer, credential-adjacent ones included. The displayed total counted after dedupe, eligibility
  **and** the attribute, pinned by a fixture where a membership count, a
  deduplicated count and the honest count are three different numbers. The
  attribute filter dispatching on dictionary type — a choice-backed string
  reads `sys_choice`, a reference reads its referenced table — with the
  `javascript:` refusal, the `NULL_OVERRIDE` sentinel, language scoping and
  the inactive rows all exercised by one fixture carrying every defect the
  live table has; fields labelled from the live `column_label`, against a
  dictionary where the stock field is relabelled and a custom one carries the
  familiar label; and the discovered list left untruncated, since capping it
  would hide exactly that custom field.

- `impersonate_ui.test.js` — the panel under `node:vm` against the same small
  DOM shim its siblings use. The panel has no markup path at all, not even a
  static shell, so the shim needs no parser and hostile names, emails and
  titles cannot be passing because markup was interpolated somewhere it
  ignored. A row click and a row Enter never impersonate; only the labelled
  button confirms. Double submission is impossible — a second click, Enter,
  Escape, a rerender underneath and a late callback are all refused while a
  request is out, and the lock survives a success; so are the header and
  footer close buttons. Stop waits for a running search and supersedes it, so
  a late result cannot repaint Stop's outcome. An indeterminate outcome
  says so and offers no retry; a definite refusal releases the lock. Escape
  layers: menu, then confirmation, then panel. Two staleness rules the suite
  found unimplemented: `showResults` now records what it drew, so cancelling
  a confirmation restores it, and entering a confirmation supersedes reads
  already in flight, so one cannot repaint over it. Stop absent with an
  explanation when no original is recoverable, and present when a frame was
  merely unreadable.

- `impersonate_integration.test.js` — the runtime boundary. The worker's
  impersonation block is evaluated on its own against a `chrome` stub, so the
  storage rules, frame selection and no-retry invariant are executed rather
  than grepped for. Exactly three routes, and the only field any of them
  reads off a message is `userName`. The response crossing back to content
  code carries no identity while the worker still holds `result.user`
  privately; the string `"null"` is never stored or POSTed; Stop carries no
  target and is keyed per origin. Stored state clears on a successful Stop
  and on any `isImpersonating: false` reading, survives an indeterminate one,
  and the live preference wins over it. Frame selection prefers identity,
  falls back to the top window's boolean, and treats a hung identity-bearing
  frame as `inconclusive` rather than "no Stop target". One confirmation
  causes one `executeScript` and one `fetch`, with no retry after a
  rejection, a timeout, a missing result or a 401 — and the mutation resolves
  its frame fresh rather than through the caching read path. Email-shaped and
  non-ASCII user IDs pass validation and arrive byte for byte; an invalid one
  is refused before frame discovery. Mutation-transport assertions live here
  rather than in `search_transport_frames.test.js`, so read-retry semantics
  can never be applied to the write path by accident.

Impersonate additionally has an end-to-end browser check, because the POST is
the one thing no Node suite and no Table API client can exercise. It lives with
the rest of the browser tooling rather than in this repo, impersonates a stock
demo user once on a PDI, and restores in a `finally`:

```powershell
node ..\tooling\probe-impersonate.mjs
```

It covers the palette entry, the panel wiring, the MAIN-world state probe, the
confirmation step doing nothing until confirmed, the session actually changing,
the reload on a definite success, and Stop returning to the original account.
Verified 25/25 on 2026-09-22 and again on 2026-09-23.

A second, read-only probe covers the search paths the Table API cannot show
through the real transport — an email-shaped term, the group picker, a group's
exact eligible total with no cap (which holds only if the dot-walked
eligibility reached the server), group plus role, and a reference field's
value list:

```powershell
node ..\tooling\probe-impersonate-groups.mjs
```

Verified on 2026-09-23. `--values-only` re-runs just the value-list step; its
field picker loads a full list on focus, so the probe waits for the typed
filter before choosing an option.

The Debug Timeline and prefill tests run page-owned code with browser-global
fakes. They do not replace testing timing and rendered behavior on a real
instance.

Before packaging, run the source-derived guards without writing an artifact:

```powershell
node package.mjs --check
```

## Store artifact packaging

Building an artifact is a **release step, not a development step**. Use
`node package.mjs --check` above while developing, and load the repository root
unpacked to test a change: the artifact is named from `manifest.json`, which
carries the last released version for the whole of development, so a build run
now lands on `dist/glidelens-<already released>.zip` — the name the stores are
serving, different bytes, on top of the real artifact.

`package.mjs` refuses to do that. When the tag `v<version>` already exists it
prints what to do instead and exits 1. `--force` overrides it, for the one case
that is legitimate: rebuilding a released artifact from its own tag, which is
also how a `dist/` entry is recovered if it was overwritten.

```powershell
node package.mjs           # release build; refuses if v<version> is tagged
node package.mjs --force   # rebuild a released artifact from its tag
```

It writes `dist/glidelens-<version>.zip` and prints its SHA-256. Builds from the
same working copy are deterministic on one platform — a rebuild of `0.12.0` from
its tag reproduced the SHA-256 recorded at submission. Line-ending differences
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
`super_class.name` dot-walking to a string (also as a query condition:
`super_class.name=sys_import_set_row` returns only staging tables), the two-hop
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
- `translation_lens.js`, `translation_lens_ui.js` — lazily injected Translation
  Lens coverage engine and read-only report panel.
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
Change a panel and its demonstration in the same change. Give each demo its
own id prefix: `getElementById` returns the first match in the document, so an
id shared between two demos only works by accident of article order.

Variable Insight icons modify ServiceNow's own form chrome and should use real
screenshots rather than a fabricated platform form; a panel such as
Translation Lens is demonstrated with a `dm-` mock built from its real
state constants, which the demo comment names. Keep demo
CSS names under the `dm-` prefix to avoid collisions with landing-page styles.

Media belongs on GitHub's attachment CDN rather than in the repository so the
repository install stays small.
