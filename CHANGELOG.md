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
- **Variable Values compares what is stored with what the form is holding,
  rather than listing what the form shows.** On a classic RITM or
  record-producer target it reads metadata-allowlisted stored values and the
  exact `variables.<name>` live values, capturing record identity and the page
  timezone with the form so a value can never be attributed to the wrong
  record, never fetching a secret, and comparing each multi-row set row by row.
  Reference and choice labels are not mistaken for differences, because the raw
  value is what is compared. Layout types -- Break, Label, Rich Text Label, the
  Container and Custom families and UI Page -- are dropped from the panel
  entirely rather than listed as variables with no value.
- **The comparison runs on Workspace records, one verified surface at a time.**
  Service Operations Workspace request items, and supplier cases and supplier
  tasks in Source-to-Pay Workspace. Route, record, form, read permission and
  each raw value's shape are all checked before anything is read, and every
  other Workspace experience and table is refused without any read at all. Each
  supported surface carries its own verified type list rather than inheriting
  another's, so a type proven against one component on one route is not assumed
  elsewhere. Partial and stored-only results say plainly what was not compared,
  and a stored-only panel is structurally incapable of claiming a comparison.
- **Multi-row variable sets are compared on Workspace too.** Every one of them
  used to read "No live multi-row value was available" -- a statement about a
  form that had never been asked, because the live read only ever ran for
  ordinary comparable variables. The set is now read as the single container
  value the form exposes, and its rows are compared structurally against the
  stored rows. A set that is *not* read now names the actual reason -- a
  surface that compares no sets, a column that could not be verified as safe,
  columns that were never enumerated, or a column type whose rendering inside a
  set has not been proven on that surface -- and the panel's "all N were
  checked" count is now exactly the set of rows a live read was requested for.
- **More variable types compare, each on its own evidence.** Yes/No, Lookup
  Select Box and Attachment on both Workspace surfaces, and Date/Time on the
  supplier ones. Yes/No is compared by boolean meaning rather than as a raw
  string, because storage has no single spelling for it -- `Yes`/`No` on one
  probed instance and `true`/`false` on another, which a raw comparison would
  have called a difference. Lookup Select Box is treated as a choice and not a
  reference: its stored value is the lookup table's own value column, which was
  free text in most sampled rows, so demanding a sys_id would have refused most
  real lookups. Attachment is a single attachment record, and a value of any
  other shape stays uncompared rather than being judged.

### Changed
- **A multi-row variable set is shown as a table, not as a JSON array.** The
  whole set arrived as one line of `[{"...":"..."},{...}]` in a narrow column,
  which is unreadable exactly when it matters -- a set with five columns and
  four rows. Each side now reports its row count and offers the rows on demand
  as a table: one line per row, one column per variable in the set, with a
  column only one side carries still shown. Where a comparison actually ran the
  two sides merge into one table and a changed cell reads `stored -> live`, so
  the row and column that moved are visible at a glance rather than by reading
  two JSON arrays against each other. Where no comparison ran the sides stay in
  separate labelled tables, because a merged cell would claim one had. A row
  present on one side only reads as an absent row rather than an empty one, and
  the copy output is deliberately unchanged: it still carries the whole array,
  which is what gets pasted into a script or a ticket.

### Fixed
- **A record opened as a sub-tab in Workspace is now supported.** Reported from
  a supplier task opened inside its case. A sub-tab nests its route inside the
  route of the tab that owns it, and the experience path used to swallow that
  whole trail, so it matched no supported surface and the panel refused while
  the form was plainly on screen. The identity is now the innermost record --
  the one the form is showing -- and the experience path stops at the first
  `record/`. Only a `sub/record/` segment moves the identity, the sub-record is
  allowlisted on its own `(experience path, table)` pair so a supported owner
  never vouches for an unsupported sub-record, and the live identity gate is
  unchanged and still has to agree before anything is read. Verified on a
  supplier task that stores 15 answers inside a case that stores 148: the panel
  compares the task's 15, not the owner's.
- **A multi-row set that was never read no longer says the form had nothing.**
  Two variables sharing a name are never read at all -- the form would resolve
  the name to whichever of them it chooses -- but a set in that position fell
  through to the wording used for a form that answered and had no value. The
  same sentence appeared for a set with no readable name and for one whose name
  collides with the form API prototype. Every one of those rows now says which
  of those things stopped the read, on the classic form as well as Workspace,
  and the check sits ahead of the one that describes an actual read.
- **The panel and the read agree on which rows were checked.** The request
  builders treated a name as duplicated when two definitions carried it; the
  panel also counted a name carried by two stored rows. A variable duplicated
  only in storage was therefore read and then not counted, so the panel checked
  something it never promised to check. Both now take the set of duplicate
  names from one place.
- **A changed cell in a multi-row table is one the comparison actually found.**
  The table compared the two strings itself, while the comparison folds `Yes`
  and `true` into one bucket for Yes/No and Checkbox columns -- so a supplier
  set could render a red changed cell underneath a green Match badge. The
  differing cells now travel with the row, computed once by the rules that
  produced the verdict, and a cell that is equal by comparison but different as
  text says so in its tooltip instead.
- **The live multi-row representation check requires the shape it claims, on
  both surfaces.** It verified that both sides were arrays of plain objects
  with matching keys, but said nothing about the cells: a number, a null or a
  nested object passed, and a nested object then stringified to
  `[object Object]` and reported a difference that meant nothing. Cells must now
  be strings, and every key must be one of that set's own columns, which is what
  ties the value to this variable set rather than to any array of objects. The
  classic form is held to the same requirement -- it previously accepted any
  JSON array -- because this is a precondition for comparing strings at all
  rather than a claim about any one component. A set whose columns were never
  resolved is refused outright; it used to skip the key check entirely, which
  was the one allow-by-default clause inside a deny-by-default rule.
- **A record whose rows live under a swapped variable set no longer reads as
  empty.** The multi-row read asked only for the sets the catalog item attaches
  today, so a record answered before the item changed looked exactly like a
  record with no rows -- and zero stored rows against a populated form is a
  difference the query invented. Such a set is now listed rather than compared.
- **Detached multi-row rows no longer truncate every set on the record.** The
  fix above first established them by reading every row under the record and
  filtering afterwards, which let rows that were never going to be read consume
  the read's row cap: past it, the whole read reported truncated and refused
  every multi-row set on that record. Their existence is only ever a yes/no, so
  it is now a separate bounded one-row probe and the read itself stays filtered
  to the sets the item attaches. A probe that cannot be answered refuses rather
  than assuming there are none -- and says the check could not be completed,
  rather than claiming the record holds rows that nothing established. A record
  whose rows are *all* detached says so instead of reading as simply empty,
  while a set whose every column was withheld still reports the withheld
  columns: it has stored rows, and saying none were found was wrong.
- **A failed answer read is final rather than retried behind the panel's
  back.** The request-item reader reads the record's answers once and
  reconciles the catalog definitions against them. When that read failed the
  definitions were reconciled against nothing, and the stored read then quietly
  tried again -- so a transient failure produced a panel showing stored values
  against definitions whose swapped variable set had never been repaired, with
  nothing on screen to say so.
- **An answer under an unidentifiable variable set never substitutes.** The
  reconciler refuses to let a multi-row set's child answer stand in for a plain
  variable, but the request-item reader only knew about the sets the item
  attaches -- and a swap is by definition a set it no longer attaches, so those
  answers reached the guard looking like ordinary variables. Their sets are now
  resolved first, exactly as the record-producer reader always did, which also
  fills in the set name such a row used to leave blank. A set that cannot be
  resolved leaves its answers alone.
- **A substituted definition keeps the flags it was read with.** It replaces
  the catalog definition wholesale but hardcoded "not a hidden type" and
  dropped the retired state, so a substituted Hidden variable was reported as
  absent from the form rather than as a type that has no on-screen value.
- **Request items reconcile a swapped variable set too.** The repair added for
  record-producer targets applies to the catalog item, not to the table holding
  the values, so a request item on a changed item was still reporting variables
  the record had plainly answered as unstored, and still emptying its Workspace
  panel. Both readers now run the same reconciliation, and a substituted
  definition is refused on the classic form when the form does not render its
  question -- otherwise the value read back belongs to the item's new variable
  of the same name.
- **A producer-backed classic record no longer calls every variable hidden.**
  Its catalog variables are not fields `g_form` manages, so `isVisible` answered
  false for all of them and the element the reader measures is a zero-size
  wrapper -- and the panel reported "Hidden by policy/script" for every variable
  on a form that was showing them. Those rows now read "Visibility unknown",
  which is what the page actually supports; the values and their comparison,
  which are the point of the panel, are unchanged. Those rows carry an explicit
  unknown visibility state, so the header counts them and the filter offers
  them: without it they inherited the summary's default and were counted and
  filtered as *visible* while their own badge said otherwise, and the count and
  filter themselves were Workspace-only, which would have dropped 76 of 79 rows
  out of the summary with no mention. Request items still report
  what the form says, because their variables are real fields and surfacing a
  hidden one is the feature's own point.
- **A hidden Checkbox on a supplier record compares instead of reporting no
  live value.** The Workspace component settles a checkbox that a UI policy
  hides into a real JavaScript boolean rather than a string, and the reader
  accepted only strings -- so the panel said the live value was unavailable
  while the form held it all along. Measured over 50 seconds on a supplier case,
  the hidden checkbox read as a boolean throughout while another checkbox on the
  same record read as a string throughout. A real boolean is now normalised to
  `true`/`false`, and only for a variable whose own comparison is boolean on a
  surface where that representation was measured; a number, a null or an object
  is still refused. Service Operations Workspace is deliberately excluded,
  because no request item exposes a boolean-typed variable to prove it with.
- **A multi-row column whose name could not be read is withheld, not dropped.**
  Dropping it left the row one key short, where it would compare as empty
  against a live side that had it.

- **A date inside a multi-row set is no longer reported as a difference that
  does not exist.** A Date/Time read as an ordinary variable comes back as raw
  canonical UTC, and the comparison converts the stored value to meet it.
  Inside a multi-row set it does not: the whole set arrives as one value with
  the date cell already formatted to the user's date format and shifted into
  the session timezone. One measured cell read `21-04-2026 07:13:37` where
  storage held `2026-04-21 14:13:37`, and the panel called that record changed
  when nothing about it had been touched. This was shipped classic behaviour,
  not only a Workspace one. Converting the cell back was rejected as a fix,
  because the set is compared as a whole and a format that failed to parse
  would quietly become a difference again -- so a set holding a date or
  date/time column is listed with its stored rows, uncompared, on every
  surface, and the row names the column responsible.
- **Variables whose catalog item has since swapped a variable set now show
  their values.** A catalog item's attached variable sets change over time, so
  a record answered before such a change holds its answers against the old
  questions while the item now defines new ones carrying exactly the same
  names. The panel enumerated the item and asked storage for values under ids
  this record had never used: the classic panel reported five variables as
  never answered when their values were sitting in storage all along, and the
  Workspace panel refused to render at all, because the live read asked the
  form for an id the form does not have. The item is still authoritative about
  which variables exist; the record's own answers are now authoritative about
  which question each of its values belongs to, and a row resolved that way
  says so. It stays deliberately narrow -- a genuine duplicate name still goes
  to the duplicate-name guard, two definitions or two answers sharing a name
  resolve nothing, and multi-row parents are never substituted.

## [0.13.0] - 2026-08-29

### Added
- **The popup now prints which GlideLens version you are running.** It was
  shown nowhere in the interface, so the only way to find it was the browser
  extensions page -- and the popup already had a row labelled `Version`
  holding the ServiceNow build, which is the number people reported instead.
  That row is now labelled `ServiceNow`, and the extension version sits in the
  popup footer. It renders on a non-ServiceNow tab too, which is where someone
  checking what they have installed is most likely to look.

### Security
- **`OPEN_URL` now validates where it is being sent, and fails closed.** A content script cannot
  open a tab, so it asks the service worker to; the worker passed the URL
  straight to `chrome.tabs.create` without looking at it. Every real caller
  builds `location.origin + path`, so the destination is now held to the
  sender's own ServiceNow origin, must be `https:`, must be a
  `*.service-now.com` host, and is rebuilt from its parsed form rather than
  forwarded as the string that arrived. `javascript:`, `data:`, `file:`,
  lookalike hosts such as `evil-service-now.com`, and other instances are all
  refused — as are embedded credentials, which `URL.origin` quietly drops (so an
  origin check alone passes) while `toString()` keeps them, and a message with
  no recognisable ServiceNow sender, which no genuine caller ever sends.
- **Code Search and Record Search results moved into closed shadow roots.**
  Every other GlideLens panel already used one. While those two were open, page
  script could read and rewrite Table API results after they were rendered.
- **Debug Timeline no longer keeps a non-JSON response body at all.** An answer
  that parsed as JSON had its sensitive-looking keys masked; one that did not
  parse was stored verbatim, so a processor replying with XML, HTML or a plain
  `name=value` body could put a token straight into a trace. Rather than try to
  scrub arbitrary text, the body is not retained: the status, shape and size are
  recorded, and DevTools still has the payload in full for anyone who needs it.
  A response too large to parse cheaply is not parsed at all. ServiceNow's own
  session token (`sysparm_ck`, `g_ck`) is also named explicitly in the
  sensitive-key list, since it matches none of the generic words.
- **Recorded frame URLs keep the page, not the payload.** `location.href` was
  stored whole, and ServiceNow hides record context in three different places:
  `sysparm_query` and `sys_id` in the query string, `/record/<table>/<sys_id>`
  in a Workspace path, and an entire encoded URL inside one segment of a Polaris
  wrapper route. All three are stripped, and the result is bounded in every
  dimension — segments, segment length, retained parameters, total length —
  because this string is copied into as many as 1,000 events. The trace reports
  how many parameters were removed.
- **Copying a trace now takes two clicks.** The first arms the button and says
  what the trace contains; the second copies. Copying is the moment a recording
  stops being local, and it usually ends up in a ticket.
- **Both instance caches are pruned, one writer at a time.** Code Search's
  probe and coverage entries are keyed by instance origin and were only ever written — expiry made them
  stale, nothing removed them — so a consultant who touches many instances grew
  local storage without bound. Expired entries and instances beyond a cap are
  now dropped on write, and the whole write-and-prune sequence is serialised in
  the service worker. It has to be the worker: the search engine is injected
  into every ServiceNow tab, so a queue inside it would order one tab against
  itself while local storage is shared by the whole extension — two tabs could
  still interleave and delete each other's freshly written entries.

### Changed
- Each injection carries a ceiling sized for what it actually does, rather than
  one blanket value: 5s for a synchronous DOM read or patch, 30s for a Table API
  read that waits on the instance. The ceilings exist to turn "never settles"
  into "eventually errors", so a ceiling near the expected duration would only
  trade the hang for a spurious failure.
- **Prefill is bound by inactivity rather than by a runtime budget**, with a
  ten-minute safety backstop. It has no bounded runtime: each variable can cost
  a 400ms settle delay plus a GlideAjax wait of up to 2s across up to three
  passes, so twenty repeatedly-changed variables can honestly run for minutes.
  And `Promise.race` does not cancel `executeScript` — a runtime ceiling would
  abandon a fill still typing into the form while telling the caller no form was
  found, so a retry would overlap the first fill. The fill already emits a
  progress message per variable; each refreshes the deadline, and a stall
  reports that the fill **may still be running** rather than that nothing
  happened. The backstop only catches a page that emits progress forever.
- Only one prefill runs per tab. The palette leaves its input open, so a second
  Enter could previously start a fill racing the first on the same variables.
  The lock is held until the injection itself settles, not until the answer is
  sent, so an abandoned fill still blocks a retry until the page is reloaded.
- Reads that get no usable answer while some frame never answered now report
  that as inconclusive rather than empty. A negative answer from one frame says
  nothing about a frame that timed out — the shell can report "no form here"
  while the frame actually holding the form never replies — so `sys_id`,
  prefill, variable mapping and hidden-variable inspection all distinguish the
  two.
- Reads report which frames failed. Every timeout and rejection used to collapse
  to an empty result, so "no form on this page" and "no frame ever answered"
  were indistinguishable; reads now resolve `{ results, failures }` and callers
  surface the difference.
- Reads can stop at the first frame that answers. Waiting for every frame made a
  read cost the slowest one, so a single hung sibling would hold a successful
  200ms Table API read for the full 30s ceiling.
- Debug Timeline and search frame discovery were near-identical copies; they are
  now one shared implementation with one `DISCOVER_FRAME`/`FRAME_AVAILABLE`
  message pair instead of two. Caching the discovered frame list is opt-in and
  used only by `SN_TABLE_GET`, where a burst of repeated reads should not pay
  the discovery wait each time. A cached list is a stale list — a frame created
  after it was taken is invisible until it expires — so one-shot,
  context-sensitive, and mutating operations (Debug Timeline start, prefill,
  `sys_id`, the popup probe) always discover fresh. The cache is also dropped
  as soon as a load starts in that tab, and a discovery already in flight when
  that happens can no longer write its pre-navigation frame list back.
- Reads now reach only frames that actually host a content script. The manifest
  sets `all_frames` without `match_about_blank`, so that means real
  `service-now.com` frames and not `about:blank` helper frames. Excluding those
  is the point — they are what hangs — but it does narrow coverage: a page that
  put real form content in an `about:blank` frame would now be missed rather
  than read. No ServiceNow page is known to do so, and the shipped Debug Timeline
  fix has made the same trade since 0.11.1.
- **Two palette descriptions dropped a trailing ellipsis.** The convention
  reserves `…` for a command that needs further input before it can act. Record
  Lens and Playbooks act immediately, so theirs were misleading; the Playbooks
  prompt that appears when no record is in context keeps its ellipsis, because
  there it is true. Mirrored in the README and the landing page.

### Removed
- **A dead `#toast` element left in the popup** when actions moved to the
  command palette. Nothing had referenced it since.

### Fixed
- **The content-script message listener stopped claiming replies it never
  sends.** It returned `true` unconditionally, which tells Chrome to hold the
  message channel open for an asynchronous response; the branches that answer
  do so synchronously, and the two that answered nothing at all left the
  sender's promise unsettled until Chrome tore the port down. Every branch now
  answers and the listener returns `false`.
- **Reads can no longer hang forever on a helper frame.** `executeScript({
  allFrames: true })` does not fail on a frame it cannot inject into — it never
  settles, so a `.catch()` never runs and a handler awaiting it never calls
  `sendResponse`. Content scripts await those replies without a timeout, so the
  feature simply stopped with no error to show. This was already fixed for Debug
  Timeline's Stop in 0.11.1; the same trap still sat under every Table API read
  (`SN_TABLE_GET`, and so Catalog Logic, Variable Values, Translations and
  Variable Insight), `sys_id` extraction, and all four portal prefill routes.
  Every one of them now discovers concrete frames from content-script
  announcements and injects into each frame individually with its own timeout,
  so a frame that hangs costs its own result and nothing else.
- **The popup could silently drop the form and user details it exists to
  show.** Its probe was time-boxed rather than fixed, so whenever the all-frames
  injection hung it resolved empty; the popup then fell back to `{ found: true }`
  and rendered only the instance and build information, with nothing to say the
  page probe had failed. It now asks the worker for the discovered frame list
  and probes those frames. Latent rather than observed: see the reproduction
  note below.

Reproduction note: `allFrames: true` was measured still pending at 20 seconds
on a classic form on 2026-08-24, and that hang is what the 0.11.1 Debug Timeline
"Stop does nothing" fix addressed. A sweep on 2026-08-28 — four page types
(classic form, classic list, Next Experience shell, portal catalog item) by five
injection delays — did not reproduce it: every call resolved. The hang is
therefore conditional on frame state rather than on page shape. These changes
remove a real but intermittent unbounded failure mode; they are not expected to
change day-to-day behaviour, and the browser checks pass identically before and
after.

## [0.12.0] - 2026-08-27

### Added
- **Record Lens** — the palette's record finder, renamed from "Search records…"
  and given the panel heading to match. A bounded, keyboard-accessible combobox
  finds a table by user-facing label or technical name without downloading the
  table catalog, and the panel shows exactly which live dictionary-confirmed
  fields it will search rather than guessing a column and silently returning an
  unfiltered read.
- **Verified field selection in Record Lens.** Known tables get presets, but a
  preset is intersected with the table hierarchy's live `sys_dictionary` rows
  before it is offered, so a field that does not exist on this instance is never
  queried. At most six fields can be selected, HTML and script types are
  excluded, value/body/content/credential-style fields are never selected
  automatically, and the System Properties preset explicitly excludes `value`.
- **Result actions.** Every verified result can copy its `sys_id` or its record
  URL, and the verified set can be opened together as a normal platform list —
  the list replays only the sys_ids that survived client-side verification, not
  the broader server prefilter, so what opens is what the panel showed.
- **Action descriptions in the command palette.** Every command now carries a
  compact one- or two-word label and a separate description of what it does, and
  both are searchable. "Code Search" and "Search verified code and
  configuration…" find the same command, so a command no longer has to be
  remembered by the exact phrasing of its name. Matches are ranked, so a label
  match always beats a description or keyword match: typing a command's exact
  name selects that command even when another command's description happens to
  contain the same words. The group holding the best match leads, and groups
  still render once each.
- **A favourite command that survives state changes.** Debug Timeline is two
  commands — Start and Stop — depending on whether it is recording. Favouriting
  it used to save whichever one happened to be on screen, so the favourite
  disappeared from the top of the palette the moment recording started or
  stopped. Stateful commands now share a stable logical key, and an already
  saved start/stop ID migrates to it on load.

### Changed
- **The palette's command labels are compact and unique.** Every visible label
  is one or two words, and the palette refuses duplicates outright whenever it
  builds its command list: two commands that can appear together may not rely
  on their descriptions to tell them apart. Panel headings moved with them, so the palette and the panel it
  opens now use one name — Record Lens, Code Search, Catalog Logic, Variable
  Values, Debug Timeline.
- **Groups render once, in a declared order.** Grouping was adjacency-based over
  the command array, which returns to Tools after Catalog — so the Tools header
  appeared twice, and filtering could repeat groups further. Order is now
  explicit (Favorite, Tools, Record, Catalog, Navigate, Dev Links) and each group
  is emitted once, with its members keeping their declared order inside it.
- **The favourite control is beside the active command, not inside the option.**
  A button nested inside a `role="option"` is not a valid listbox, and neither is
  a shortcut chip. Favouriting is now a single button positioned against
  whichever row is active, and the active command's shortcut hint moved to the
  palette footer.
- **GlideLens-opened tabs land beside the tab that opened them.** Opening a
  record, a list, or a Dev Link appended the new tab to the end of whichever
  window happened to be active. Destinations now open immediately after the
  originating ServiceNow tab, in that tab's own window, with it set as the
  opener — so the result of a command stays next to the page the command was run
  from. A message without usable tab context falls back to Chrome's normal
  placement rather than guessing.
- **Record Lens errors distinguish validation, access, schema, no-match, and
  transient failures**, so an unreadable table no longer looks the same as a
  search that genuinely found nothing.
- **The landing page gained a working Record Lens demo**, alongside the existing
  Code Search, Catalog Logic, Variable Values and Debug Timeline ones. It runs
  the real interaction on fabricated data — pick a table by label or technical
  name, open the field picker, search, and get verified rows back — and it
  copies the engine's own preset and sensitive-field rules rather than
  approximating them, so `sys_properties.value` shows as "manual only" and stays
  unselected. The page's palette, panel headings and command descriptions were
  brought back into step with the extension at the same time.

### Fixed
- **Arrow keys, Home/End, Enter and Escape work throughout Record Lens.** Table
  suggestions and result rows are both fully keyboard-navigable.
- **The palette is a valid, announced listbox.** Options have stable IDs, the
  focused search input points at the active one with `aria-activedescendant`, and
  each option's accessible name is composed from its label and description — so
  arrow navigation is announced rather than silently moving a highlight. Group
  labels carry valid group semantics.
- **Focus is trapped while the palette is open and restored when it closes.**
  Tab and Shift+Tab cycle the palette's own controls instead of walking off into
  the ServiceNow page behind it, and Escape returns focus to whatever held it
  before the palette opened.
- **The active row no longer resizes the list.** The active command's description
  expands to two lines; rows keep a fixed height, so moving the selection does
  not make the list or the viewport jump under the cursor.
- **Record Lens preselects the right table on classic list pages.** A
  `*_list.do` route was read as a table literally named `<table>_list`, which
  resolves to nothing, so the one page where the table is least ambiguous
  preselected nothing at all. The `_list` suffix is now stripped from classic
  routes before the candidate is offered — and, as before, the candidate is still
  resolved through live `sys_db_object` metadata before it can be used.

## [0.11.1] - 2026-08-23

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

[0.13.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.13.0
[0.12.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.12.0
[0.11.1]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.11.1
[0.11.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.11.0
[0.10.1]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.10.1
[0.10.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.10.0
[0.9.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.9.0
[0.8.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.8.0
[0.7.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.7.0
[0.6.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.6.0
[0.5.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.5.0
[0.4.0]: https://github.com/RushiPatel92/GlideLens/releases/tag/v0.4.0
