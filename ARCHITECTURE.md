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

- The popup talks only to the service worker (`GET_TAB_FRAMES`); it sends
  nothing to content scripts.
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
so they must not use the fan-out `SN_TABLE_GET` path either. Impersonate reads
through that same route rather than adding a fourth: its reads have the same
bounded, repeated shape, which is why `record_search.js` is injected alongside
it.

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

## Impersonate

`impersonate.js` (a DOM-free engine exporting `globalThis.SNImpersonate`) and
`impersonate_ui.js` (the panel) are injected on first use through
`INJECT_IMPERSONATE`, after `record_search.js`, whose anchor extraction,
ranking, session tracker and Table API transport the engine reuses rather than
copying. `record_search_ui.js` is deliberately **not** injected: a generic
table picker and read-only record actions do not belong in a flow that changes
the session.

**This is the only write in the extension.** Everything else is a GET on the
token-bearing-frame path. What this changes is the operator's ServiceNow
session on the instance — not a record, and not something a reload undoes.

### The verified endpoint

```
POST /api/now/ui/impersonate/<user_name>
headers: Accept: application/json, Content-Type: application/json, X-UserToken: <g_ck>
no request body
→ 201 Created
{"result":{"user":"<original>","impersonatedUser":"<now>"}}
```

It is keyed by **`user_name`**, not by a sys_id, and needs no body at all. The
username is `encodeURIComponent`-ed because ServiceNow user IDs are commonly
email-shaped. `result.user` names the **true original** even when impersonating
a second user while already impersonating, so the way home survives chaining;
when there was no original it is the **string** `"null"`, which is never stored
and never POSTed. There is no "unimpersonate" endpoint: Stop is the same
operation aimed at the original account.

### Three routes, and none of them is a proxy

| Route | Takes | Returns |
| --- | --- | --- |
| `SN_IMPERSONATE_STATE` | nothing | `{ ok, isImpersonating, currentUserName, displayName, hasStopTarget, inconclusive }` |
| `SN_IMPERSONATE_START` | `{ userName }` | `{ ok, status, code, message }` |
| `SN_IMPERSONATE_STOP` | nothing | `{ ok, status, code, message }` |

No URL, method, table, query or body crosses that boundary. The worker builds
the one fixed same-origin URL itself, and **Stop carries no target**: the
destination is resolved from the worker's own state, keyed per origin in
`chrome.storage.session`, so content code cannot direct a "stop" at an
arbitrary account. `result.user` is extracted and kept inside the worker; the
panel learns only a `hasStopTarget` boolean.

Username validation exists to catch **bugs**, not to sanitise — encoding is
what makes the URL safe. It is deliberately not a character allowlist:
`[A-Za-z0-9._-]+` would reject email-shaped and non-Latin user IDs, both of
which ServiceNow issues routinely, and the failure would surface first on a
customer instance with international users. Non-empty, at most 40 characters
(the verified `max_length`), no control characters, never `"null"`, and passed
through byte for byte — this platform distinguishes identifiers differing only
by a trailing space.

### Fresh frame, exactly once, never retried

A mutation must **not** reuse the cached token-frame resolution that is safe
for repeated reads, and must not go through `codeSearchFrameGet`, whose 401
re-resolution and stale-frame recovery would send a second request. The frame
is discovered fresh per confirmed action and exactly one is targeted, so a
click is structurally incapable of producing two POSTs.

**Once `executeScript` begins, anything other than a response is
`indeterminate`** — a throw, a timeout, a worker teardown, a navigation, a lost
result, a page-side fetch that threw. Never retry: not on another frame, not on
401, not after cache eviction. The user is told the impersonation may have
started and to check the ServiceNow user menu. Only a **definite** success
reloads the tab; an indeterminate one must not, because the reload would
destroy the one place the ambiguity is explained.

### The two frames disagree about identity

`NOW.user.isImpersonating` is a real boolean and is present in **both** the top
window and `gsft_main`. The current **username** (`g_user.userName`) and the
`user.impersonation` preference are `gsft_main`-only. So
`SN_IMPERSONATE_STATE` discovers concrete frames, probes them in the MAIN world
(never `allFrames`), and chooses with the pure
`selectImpersonationStateFrame(outcomes)` — the same idiom as
`selectTranslationFormFrame` and `selectLfAssistantFrame`, so the rule is
unit-testable. A frame that returned identity wins; the top window's boolean is
the fallback and names nobody. A frame that **carries identity and never
answered is `inconclusive`, not "no Stop target"** — reading that silence as an
absence would strand someone inside an impersonated session with no offered way
back.

The way home has two sources and the **live platform state wins**: the
`user.impersonation` preference is fresher than anything we stored, because
another tool can re-impersonate between our write and our next read. Stored
state is cleared on a successful Stop and whenever a probe reports
`isImpersonating: false`, but **not** on an indeterminate Stop — we do not know
that it succeeded, and the next probe settles it.

**snUtils' detection must not be copied.** It regex-scrapes a `<script>` tag
and, on a miss, fires a **synchronous** XHR at a deliberate 404 and regexes the
response. Our reader runs in the page, where a blocking call freezes the tab.
The preference is read off the already-parsed DOM with no XHR fallback of any
kind.

### Why the searching is shaped the way it is

`sys_user_has_role` is the **effective** membership table — direct grants, role
containment and group-derived grants alike. `sys_user.roles` is direct-only,
incomplete even at that, and substring-prone (`rolesLIKEitil` hits
`itil_admin`), so it is never read. `accumulated_roles` is unusable in two
different ways: querying it 403s the whole request, and requesting it as a
field is **silently omitted** — a third behaviour beyond the known
blank-versus-missing rule. `sys_user_role` has no `active` field, so no
active-role filter may be invented.

Eligibility is a **safety rule, not a filter**: ServiceNow documents that
impersonating an inactive or locked account can terminate the operator's own
session, so there is no "include unavailable users" toggle and an ineligible
account must never look selectable. `user_nameISNOTEMPTY` is doubly required
now that the endpoint is keyed by that field.

The clause list is `active=true^locked_out=false^user_nameISNOTEMPTY^web_service_access_only=false^ORweb_service_access_onlyISEMPTY`,
and that last term is not pedantry. **`web_service_access_only=false` alone is
wrong in the direction that hides almost everybody.** Measured on the PDI: 642
active users, but only 83 match `=false` — on more than 500 of them the field
is **empty**, not false, and `=false` does not match empty. Neither does
`!=true`, which returns the same 83. With the naive clause, a search for
`abel.tuter` — the canonical demo user — returned nothing at all, and a role
search reported 14 holders where there were 29.

**A read cannot reveal this.** `sysparm_display_value=all` renders the empty
field as the string `"false"`, so the row looks exactly like one that would
match; only a query tells the two apart. That is the blank-versus-omitted trap
in a third form, alongside the two `accumulated_roles` shows. `active` and
`locked_out` are *not* affected — neither is ever empty on this instance — so
the OR group is needed for this one field only.

Because `^OR` binds to the condition immediately before it, that OR group must
be the **last** thing in the query: anything appended after it falls inside the
OR and stops being required. So every builder emits
`<selector> ^ <attribute> ^ <eligibility>` in that order, and
`eligibilityClauses` throws if the OR-group clause is ever not last.

A typed identity term is anchored on its longest safe run, as Record Lens
does — except that an **email-shaped term anchors on its local part**. The
longest run of `t.okonkwo@example.com` is the domain, which every colleague
shares, so the unordered 50-row window would fill with other people and the
complete-term check would then find nobody; user IDs are routinely
email-shaped, so this is the ordinary case. Only the anchor moves: rows are
still verified against the complete term.

Four query orders, each the only correct one for its case: **user-first** when
text is present (text narrows before any cap, so a common role or a large group
cannot crowd out the match), **group-first** when a group is chosen without
text — a role and an attribute included — **role-first** for a role without a
group, and **attribute-first** for an attribute alone. The attribute is an
exact condition, never a `LIKE`, so the three-character minimum never applies
to it, and it enters the *candidate* read when text is present and the *user*
read otherwise — never as a post-filter after a cap, which would quietly shrink
a capped page.

A capped membership read means **opposite things** depending on whether it is
an intersection or the population, and the rules must not be reconciled into
one:

- **text + role, text + group**: the cap corrupts the *filter*. A candidate cut
  off by it is indistinguishable from one that genuinely lacks the membership,
  so that filter is reported **`unavailable`**, never as no-match.
- **role only, group-first**: the cap merely truncates the *list*. Every row
  returned is a genuine holder or member, so partial results are honest —
  shown with a narrowing message and **no claimed total**.

An intersection asks about known candidates, so its bound is
`max(100, 2 × candidates)`: exactly the old fixed 100 for the 50-row text
window, and room for a group's 100 members to hold a role twice over (a direct
and an inherited row) without the filter going unavailable.

Completeness and the displayed number come from different places. The `cap + 1`
probe answers only *"did I see every membership row?"*; the number shown is the
count of **deduplicated, eligibility- and attribute-filtered user rows**, never
a membership row count, because duplicate rows collapse and the `sys_user` read
then removes ineligible accounts. Role-only reads every collected id up to the
membership cap of **100**, not the 50-row text-candidate window — applying the
text window there would silently halve the population before counting. Duplicate
membership rows are normal (`itil`: 70 rows, 66 users); a **direct** row wins
over an inherited one. `granted_by` and `included_in_role` are empty on every
sampled row, so a badge may say *direct* or *inherited* but must **never** claim
"via group X".

### Groups

`sys_user_grmember` is `user` and `group` and nothing else — no state, no
inherited flag — and it is **direct** membership, which is what the platform's
own Group Members list shows. Rows are not members: one customer group had 230
rows with an **empty** `user`, and duplicate (user, group) rows occur, so rows
are validated and deduplicated before anything is counted. Group membership
carries no badge; every row that survives is a member by construction.

A group outranks a role when both are chosen without text. It is the narrower
population — a median of 3 members across 12,359 groups on a customer
instance — and, unlike the role table, its read can carry **eligibility and
the attribute as dot-walks** through `user`
(`group=<id>^user.active=true^…^user.web_service_access_only=false^ORuser.web_service_access_onlyISEMPTY`,
both halves of the OR group walked, the group still last). That matters
because only 40–60% of a measured group's members were eligible: without the
dot-walk, half of a 100-row cap would be spent on people who can never appear.
The dot-walked set was verified identical to a direct `sys_user` eligibility
read on the PDI and on four customer groups of ~380 members each.

**The dot-walk is never trusted alone.** A misspelt dot-walked field is not an
error: the condition is **silently ignored** and the whole group comes back
unfiltered. So the `sys_user` read that follows applies eligibility and the
attribute again, and the client-side eligibility check runs after that. The
largest group measured had 41,580 members, so the group-first cap is routine
rather than exceptional, and is worded as the role-only cap is.

The picker searches **names only** and turns **each typed word into its own
AND-ed `LIKE`** — up to four, longest first, ignoring single characters —
where the role picker uses one anchor. The difference is
measured: on 14,549 groups the single longest word matched hundreds or
thousands — `Service` 713, `Approval` 4,279 — against 96 and 168 with every
word of the phrase, and a description match would crowd the named group out
of the 50-row window entirely. Rows are then verified per word rather than
against the complete term, so `Acme-EU-Service Desk` is found from
`Acme EU Service Desk`. There is **no `active` filter**: 2 of the measured
groups had `active` empty, which `active=true` hides — the
`web_service_access_only` trap again. Inactive groups are offered, labelled,
and ranked after active groups of the same match quality, because their
members are still members.

### The attribute filter is discovered, never named

The stock `sys_user.country` is a three-character code with a real choice list,
but a real instance is free to relabel it and keep the field a person calls
"Country" in a custom column pointing at `core_country` — a **Reference**, not
a choice-backed String. So the field list is read from the live `sys_user`
dictionary, labelled by its live `column_label`, and the value list dispatches
on type: `sys_choice` for a choice-backed string, the referenced table for a
reference. Nothing is named in code, and an empty or unreadable list disables
the control rather than falling back to a hardcoded list that would confidently
offer the wrong field.

`sys_choice` carries three defects that all have to be filtered: 1,387 rows
across six languages, 222 of the 232 English rows inactive, and one active row
whose label is a raw `javascript:gs.getMessage(...)` expression with the value
`NULL_OVERRIDE`. The read is language-scoped and active-only, and every row
passes the same `javascript:`-scheme refusal this codebase already applies to a
list link — the platform evaluates such a value instead of matching it, and
encoding the URL does not stop it.

### Panel

Record Lens's visual language, modal overlay and keyboard model, with one
difference: the panel has **no `innerHTML` at all**, not even for its static
shell. The values on screen are real people's names, titles and email
addresses read from an instance we do not control, so leaving no markup path is
one fewer thing a test has to prove is static.

**A row click never impersonates.** Only the labelled button enters a
confirmation, which repeats the identity in full, says the instance session
will change, and disables while in flight so a second click, Enter, rerender or
late callback cannot send a second request. Escape layers: an open menu, then
the confirmation, then the panel — and it is inert while a request is out,
since closing would hide the only place the outcome is reported. The header
and footer close buttons obey the same lock. **Stop** waits for a running
search like every other control, and supersedes any read still out, because
its outcome is reported only in the status line that a late search would
repaint. Entering a
confirmation supersedes reads already in flight, so one cannot land and repaint
over it. Changing the attribute **field** discards the selected **value**: a
value from the previous field would otherwise reach a query as a valid-looking
condition on the wrong column.

## Translation Lens

Translation Lens is a read-only coverage report. `translation_lens.js` (a
DOM-free engine exporting `globalThis.SNTranslationLens`) and
`translation_lens_ui.js` (the panel) are injected on first use through
`INJECT_TRANSLATION_LENS` and are not in `manifest.json`. The palette command
keeps the retired translation icons' favourite key, `toggle-translations`,
so a pinned command survived the replacement.

Context resolution runs in the top frame only, in a fixed order. A Workspace
record route is refused before any probe; on such a route the command shows
a palette notice with a link to the record's classic form, built only from a
validated table name and a 32-hex sys_id from the route. Nothing opens until
the link is clicked, and the click goes through the same-origin `OPEN_URL`
route. The classic form
renders its own view, so the audited field set is the classic form's; labels
and choices are per field and table, so every field both views share gets the
same answer. Otherwise `GET_FORM_TRANSLATION_CONTEXT` probes every concrete
frame in the MAIN world and accepts only a frame whose `sys_target` and
`sys_uniqueValue` markers agree with `g_form`; a new record is a distinct
`isNewRecord` state, never a coerced sys_id, and drops the per-record
aspects. A catalog item id from the URL or page is trusted only after its
`sc_cat_item` row is read and its class confirmed by walking `super_class`.
With both answers in hand: a corroborated item without a classic form is
Catalog mode (Service Portal catalog item); a classic form whose hierarchy
contains `sc_cat_item` is Catalog mode with the form's own fields in a
collapsed "Form fields" section; any other classic form is Form mode. A
fingerprint (surface, table, sys_id, frame) is captured with the first probe
and re-checked before results are committed; a changed page discards the run.
A classic form that carries a variable editor (a request item, a catalog
task, a case raised through a record producer) is still Form mode, and its
catalog variables are not checked there: the editor keeps a hidden
`variable_map` whose `<item id>` children are the question ids (its controls are
`ni.QS<id>`, not `IO:`), one bounded read resolves the owning item, and the
panel shows a
prominent notice saying how many variables were not checked with a link to
the item or producer definition form, where the catalog run does check them.

Store routing follows the dictionary type, which is the fact the old icons got
wrong. Labels live in `sys_documentation` on the defining table, resolved by
walking `super_class`. Choices live in `sys_choice`. `translated_field`
values live in `sys_translated`, keyed by the source string and not by
record; `translated_text` and `translated_html` values live in
`sys_translated_text`, keyed by document. A field of any other type gets no
value row at all, and an empty Field Values section carries a note saying so
rather than a list of Not applicable rows. Catalog question text, choices and
set titles are string-keyed in `sys_translated` under their defining table.
`getMessage` keys are scanned from the surface's client scripts and UI
policies and checked in `sys_ui_message`. For every string-keyed text, a row
found in the record-keyed store instead is reported as stranded, never
counted.

The **Hardcoded text** group is the complement of that scan, over the same
script bodies and so at no extra read: the message scan asks whether a
requested key is translated, this one asks whether a translation was ever
requested. A finding is not a coverage row and carries no per-language
states — hardcoded text has no store row, so there is no language in which it
is Missing and none in which it could be created — and the section is
excluded from the headline denominator by name in both `summarizeResult` and
the panel, not by happening to hold no rows. Three shapes are reported: a
string literal in an argument that carries user-visible text, a literal
reached by following one local assignment when the whole argument is a bare
identifier, and a literal under a text-shaped property name (`label`,
`title`, `helpText` and the like, matched as a whole word or a camelCase tail
so `context` and `headers` are not text, and read whether the key is bare or
quoted). The third exists because a hand-rolled translation table reaches its
call site through dynamic hops no text scan can follow, while the object
literal holding the words sits in the same script.

The filters are what keep it honest, and each answers a measured false
positive. Argument indexes are exact rather than at-or-after, since
`showFieldMsg`'s third argument is the message type. Only literals at the
argument's own bracket depth count, so a nested call's arguments stay that
call's business and a field name read by `getLabelOf` is not reported as
English. A literal with no two letters is concatenation glue rather than
text, measured in any script and not only in Latin, because an instance whose
base language is not English hardcodes its own language and that is the same
defect. Text arriving from a server response is deliberately not attributed
to the script, which holds no text to fix. The `getMessage` exclusion is
deliberately broader than `extractMessageKeys`' own pattern and accepts any
receiver: extraction must be strict because a key it invents gets queried,
while exclusion must be generous because every call it fails to recognise
becomes a false claim that text was never translated.

All of it is a text scan over a masked copy of the source — comments, regex
literals and string bodies blanked, offsets preserved — never an evaluation,
so a traced finding names the identifier it followed. Regex literals are
lexed rather than ignored because one ordinary regex silently deletes every
later finding in its script: `/\/*$/` opens a block comment that masks the
rest of the file, and a regex holding a backtick opens a template literal
that swallows it. Line numbers come from a binary search over a newline index
built once per script, and literals are indexed by offset, because the
obvious per-finding walk turns a large hand-rolled table — the very shape
this scan is built for — into a frozen tab.

Cost is a correctness concern here, not a nicety, because the engine is
injected into the page and not into the worker: every millisecond the scan
spends is a millisecond that tab is frozen. So the scan is `async` and
sliced — it hands the thread back every few milliseconds — and it stops at a
budget, reporting how many scripts it did not reach rather than letting
silence read as a clean surface. Its patterns are written so that no two
unbounded quantifiers sit next to each other. That is not hypothetical: the
receiver and its dot were once `\s*\.?\s*`, comments are masked to spaces,
and a real 2 KB script that had been commented out took **44 seconds** on one
regex because the engine tried every way to split the run of spaces.
Commenting a script out is ordinary, so that shape has a regression test with
a time assertion and a second test that pins the pattern rule at the source.
The panel draws the list a page at a time with the whole list in hand, so a
long report costs nodes only as a reader asks for them, and "show all" is
remembered as a decision rather than as a count.

A finding whose call names its field plainly is attached to that field's own
row as `evidence.scriptOverrides`, by `attachScriptOverrides` at the end of
`summarizeResult`. This exists for the one case the score cannot see: a field
translated correctly in every language which a script overwrites with a fixed
string at runtime, so the row reads 100% and the form is still English. It is
evidence and never a state — whether the line runs depends on a condition
nothing here evaluates — so it moves no count, and the headline instead
refuses to settle: while findings exist the score renders flagged rather than
plain, with the count beside it and the reason in its `aria-label`. That
count is a `chip-alert`, not one of the `chip-warn` advisories, and it is
appended directly after the score rather than with them. The distinction is
the point rather than decoration: the advisories qualify a row or two, this
one says the number itself is not the whole truth about the surface, and in
the amber family at the end of the same row it read as the smallest of the
four. It is a button, so the claim leads somewhere — it expands the
**Hardcoded text** group and moves focus to its head. Three
rules keep the attachment honest. A finding only lands on the half it came
from, because a catalog variable and an `sc_cat_item` column routinely share
a name and the script's table is what tells them apart. A message row is
never a target, because its element is a `getMessage` key and a key spelled
like a field is still a key. And only `setLabelOf` and `addOption` claim to
replace what a row measures; `showFieldMsg`, `setValue` and `addDecoration`
put their own text on a field without touching what is stored, and are worded
that way. A literal that is also a
`getMessage` key in the same script is flagged. The copied report carries
counts and this file's own fixed API names; the source text, the property
name, the record name and the sys_id stay on screen. The reverse check is not made for `translated_text` and
`translated_html`: their values are long text that is rarely expressible as
a query key.

Every element, aspect and language cell has one state. Direct and Same as
source count as covered; Fallback is shown beside the count but not in it;
Missing, Blank and Partial are gaps; Conflict is flagged; Unverified,
Unavailable and Not applicable are excluded from the denominator and named.
Blank is decidable only where the content column is read
(`sys_documentation`, `sys_choice`, `sys_translated`); `sys_translated_text`
and `sys_ui_message` are queried with their content non-empty, so a blank
row there reads as Missing. A key the query language cannot express, a
choice value or dependent value included, is Unverified rather than a
counted gap.
Absent data is never coverage: a denied, timed-out or truncated read stays
Unavailable and never becomes Missing. Messages keep their own denominator and
never move the main score. The language picker is a per-session display
filter, not stored anywhere: it rescopes the section scores while the
all-language score stays drawn beside them, so narrowing a selection cannot
hide a gap.

Reads go through `SN_TRANSLATION_GET`, which delegates to the single
token-bearing-frame path Record Lens uses rather than `SN_TABLE_GET` into
every frame. Identifiers are validated before any query; a value containing
`^`, a newline or more than 255 characters is refused and its row is
Unverified; encoded queries are chunked under 6000 characters; the content
columns of `sys_translated_text` and `sys_ui_message` are never requested.
Each read has a 30 s ceiling and the panel 60 s; past that the remaining
sections are Unavailable. The panel mounts before the first read and fills
section by section; a result whose fingerprint no longer matches the open
panel is discarded rather than rendered, and a page that stops being the
record the run started on discards what was drawn and cancels the rest.
Every link is same-origin through `OPEN_URL`; a Missing chip opens a
prefilled new record, a Blank chip opens the existing rows for that language
so no duplicate is created; nothing is written.
The copied report carries states and keys but no translated text, record
value, sys_id, hostname or URL.

The translation icons and the field-name badges are both gone from
`content.js`, along with the Workspace field walker and the toggle
persistence observer they needed; snUtils covers field names. One line of
orphan cleanup at content-script init removes icon elements left in tabs that
were open across the update; delete it in the release after the one that
removed the icons. Do not relist either feature without an explicit request.

## Translation Assistant

Translation Assistant hands a catalog item's untranslated text to the user's
own AI tool and fills the reply back into ServiceNow's Localization Framework
comparison page. `translation_assistant.js` (a DOM-free engine exporting
`globalThis.SNTranslationAssistant`) and `translation_assistant_ui.js` (the
panel) are injected on first use through `INJECT_TRANSLATION_ASSISTANT` and
are not in `manifest.json`; the worker loads the same engine for the write.
The command is listed when the decoded tab URL names the
`sn_lf_comparison_ui` page, which is a claim; whether the page is really
there and really in ad-hoc mode is settled by a MAIN-world probe when the
command runs, because the page usually lives inside `gsft_main` and the
palette's frame only sees it as a `nav_to` parameter.

**Read.** `GET_LF_ASSISTANT_CONTEXT` probes every concrete frame and accepts
the one whose page-owned Angular scope reports the comparison UI in ad-hoc
mode, reading three editability states rather than inferring them:
read-only mode, a translation request in progress, and the lock on each
field. The context is a flattened copy of the page's own content array,
which the engine turns into a draft. A row's identity is its
`additionalParameters` (type, table, sysId, name); the platform's element id
is `groupName: label` with an ordinal suffix on collision, so it moves when
variables are renamed and is only ever an address. A row's *destination* is
not its identity: `translated_field` values are stored in `sys_translated`
keyed by source string, so two records sharing one source text share one
stored translation, and destination groups are the unit of every decision —
all or nothing. Exclusions are named, never silent: a script message that
looks like a key, a message key too long to store, a field with no record id,
an unsupported type, an empty source (for rich text, markup with no words),
rich text whose markup is left to a person, a locked field, rich text whose
editor is not ready, a text shared with a locked field, and an uncertain
destination. Locked means only that a translation exists, and the panel never
repeats the platform's "verified".
The draft is held in `storage.session`, capped at five, before it is offered,
because the MV3 worker can be torn down between the download and the reply.
Language names are read from `sys_language` through a query built only from
id-shaped codes, and used only when the rows give exactly one; otherwise the
codes stay.

**Script messages** are the `getMessage` keys the page scans from the item's
client scripts, UI policies and producer script. The platform's save routes
any field whose `additionalParameters` has no `type` property to
`sys_ui_message`, written on the key and language alone — the key is
`additionalParameters.key` when the page set one, which it does only when the
source language gives the key different text, and the source text
otherwise. A message has no record, so its identity is its exact key plus
which appearance of that key it is on the page; every appearance of a key is
one destination, and it is always instance-wide. The destination folds
capitalisation, which is measured on that column; a key differing only by an
accent or a trailing space, which fold on `sys_translated` but are unmeasured
here, is refused together with its twin rather than merged. When the source
language has no row for a key, the page offers the key itself as the text,
so a source with no spaces and a dot or underscore between two letters or
digits is excluded as looking like a key rather than sent to a model; that
is a shape test, and the panel says "looks like". Only a parameters object
without its own `type` is a message: the platform would also save a field
with no parameters object at all as one, but no page builds that shape, so
it is refused with the fields that have no record id. `sys_ui_message.key`
holds 255 and `message` 8000, read from the configured instance's
dictionary. The save updates the first row matching key and language
whatever its application scope, so a key stored twice in one language is a
limitation this feature does not yet detect.

**Export.** One JSON file carrying its own instruction block, a schema
version, an export id, the language pair as codes, and one row per
destination group with the source text and the placeholders it holds. The
copy route emits the identical string. The panel says plainly that the file
holds the item's text and leaves the browser when uploaded; GlideLens itself
never contacts an AI service. Both steps are one view, in this order: the
tally, the export controls, the reply box, then the notes. Every list in the
panel is closed until asked for and bounded when open — a real item put 157
rows in the instance-wide list alone, and a note placed between the two steps
is a note the user scrolls past to reach the second one.

**Fill.** There is no preview step: the comparison page is the preview,
since nothing is saved until Publish and a reload discards every fill. The
panel sends the reply text with the user's choices to `APPLY_LF_ASSISTANT`,
and the worker does everything under a per-tab lock: parse the reply
(through fences and prose, refused past 5 MB or 2000 rows), find the draft
by export id, read the page again, refuse unless it is editable, re-evaluate
every row against the live page, and merge. A row is filled only when its
source text still hashes the same, its field is unlocked, its translation
fits the destination column (255 for `translated_field`, 8000 for a script
message), every member of its destination group is in the draft, and the
field still holds what the draft saw — or the user chose Overwrite against
the exact values shown. A placeholder mismatch waits for Fill anyway; a
blank, or a reply of only white space, never clears or fills an existing
translation. When a field that was not in the draft has joined a group, the
row is refused, and named for the lock if any member of the group is locked.
The merge writes `translatedValue` and no other key, because the platform's
deserialiser moves unknown keys into `additionalParameters` and posts them
on Publish. The write is one
`executeScript` into the frame this fill's own read selected, running
`writeLfAssistantContent` in the MAIN world: it re-checks the page states,
refuses unless it is on the document the read came from (the reader records
`performance.timeOrigin`, which a reload changes, plus the artifact and
language pair it saw, so a replacement page holding identical content — the
item reopened for another language — is refused rather than filled),
compares the live model with the base the merge was built from as content
(Chrome returns injection values with keys sorted, and Angular leaves
`$$hashKey` on the model, so a text compare refused an untouched page),
fires the page's own `updateDocumentContent` event only if they match, then
reads each filled field back by position and record identity — for a script
message, which has no record, by position and the key it is stored under.
What comes back is a count of fields that hold their value, the rows and
fields that did not, or "unconfirmed" when the read-back itself failed after
the event fired — never a count of what was attempted. The lock is released
when the injection settles, on navigation, or on tab close; a fill still
awaiting a read when a navigation releases the lock refuses rather than
injecting into the new page. A fill that does not settle in 10 s is reported as
indeterminate and keeps its lock. The panel reports what was not filled and
why, and keeps a per-run history of every field its fills wrote — by record
identity, grouped by destination for display, with the old text and whether
the page confirmed the write — through later clicks and refusals, since
clearing a box would publish a deletion. An unconfirmed write is shown as
attempted, never as a replacement that happened.

**Rich text** (`translated_html`, drawn by the page as a TinyMCE editor: an
item's description and a variable's rich text or instructions) is never
written through `updateDocumentContent`. The page copies model text into an
editor only when that editor starts, and the event reuses every row — the
page's rows are `ng-repeat` lists tracked by `$$hashKey`, which the merged
array keeps — so a model write leaves the visible editor on the old text
while Publish sends the new. The writer calls `editor.setContent` instead,
after the event: the page's own `SetContent` handler moves the model and the
hidden textarea to `editor.getContent()`, so the editor, the textarea and
what Publish sends agree (measured on the configured instance with TinyMCE
6.8.4, including that a write after the event lands in the model object the
event installed). An editor is found by reference — the one whose textarea's
row scope holds that very field object — never by its ordinal DOM id; the
reader reports each rich field's editor as ready only when exactly one is
bound, started and editable, and the writer re-finds it after the event and
requires a field object the event replaced, the same editor, an unlocked
field, and an editor showing exactly what the model holds (the page syncs on
key-up, toolbar commands and `setContent`, so a difference is an edit it has
not recorded). The replacement check is what keeps the two halves from
diverging: finding the planned-against object still in place means the page
has not run its digest, so a write would land in an object about to be thrown
away and then be swapped out behind an editor still showing the translation.
It applies only when the event fired. A fill with no plain rows fires nothing,
replaces no object and demands no replacement, which is also the way out of a
refusal: a mixed fill stopped by this check reports those fields as not ready,
and filling again finds the plain rows already unchanged, so the second fill
is rich-only and writes straight into the object each editor is bound to.
After writing, the words must match what was written, the editor's
serialisation must fit 65000 characters, and the model, the textarea and the
editor must agree; otherwise the writer puts back what the editor showed,
which re-sets exactly, and reports which of those three failed — each asks
something different of the user — or reports the field as uncertain, with a
reload advised, if the put-back cannot be confirmed.

A reply is untrusted HTML, and `setContent` parses it in a same-origin frame.
So the draft names rich rows `format: "html"` and tells the model to change
only the words between tags, and the fill never writes a reply's markup: one
strict scanner cuts source and reply into tags and text, the reply's tags
must match the source's one for one (name, then attribute names and values
in order, quoting and case aside), and what is written is the source's own
tag bytes with the reply's text between them. Text holds no `<`, and HTML
opens a tag only at `<`, so a model cannot add or change an element, an
attribute or a link. The scanner refuses what it does not fully read —
comments, declarations, a stray `<`, attributes not parted by white space, a
quoted value holding `<` or `>` — so it and a browser agree on every tag
boundary; a reply that fails is blocked with no override, naming the first
tag that differs. A source holding a script, style, form, embedded frame,
event handler or non-web URL is left to a person. The panel shows rich values
as words through that same scanner rather than a pattern over angle brackets,
which would read a `>` inside a quoted value as the end of a tag and put the
rest of it on screen dressed as words; a source the scanner refuses is shown
as written instead. TinyMCE rewrites markup (`<b>` to `<strong>`, a non-breaking space
raw, line breaks between blocks), so rich text is compared by its words: a
reply that reads the same as the page is unchanged, and one with tags but no
words is blank, because `<p></p>` would publish as an empty-looking
translation rather than a deletion. The drafted baseline and the live value
are both the editor's serialisation, so "changed since the draft" stays an
exact compare. A field whose kind changed between plain and rich since the
draft is refused.

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

A record opened as a **sub-tab** nests its route inside the route of the tab
that owns it:
`/now/<experience>/record/<owner>/<owner id>/params/.../sub/record/<table>/<id>`.
The identity is the innermost record, because that is the one the form is
showing, and the experience path is read up to the *first* `record/` so it stays
the experience (`psm/workspace`) rather than swallowing the whole trail. Only a
`sub/record/<table>/<id>` segment moves the identity; any other trailing path
leaves the tab's own record in place. The owning record is deliberately not
constrained — it takes part in neither half of the read, since the stored side
queries the sub-record's own table and the live side is pinned to the
sub-record's form and every corroborating ancestor. The sub-record is
allowlisted on its own `(experience path, table)` pair like any other route: a
supported owner never vouches for an unsupported sub-record.

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
required before either `value` or `displayValue` is touched.

A value must be a string, with one measured exception. On the supplier
surfaces a Checkbox that a UI policy hides settles into a real JavaScript
`true`/`false` rather than a string, and stays that way: measured over 50
seconds on a supplier case, the hidden checkbox read `boolean` throughout while
a second checkbox on the same record read `string` throughout. Refusing it
reported the live value as unavailable when the form held it all along —
classic is unaffected because `g_form.getValue()` always returns a string. So a
real boolean is accepted and normalised to `"true"`/`"false"`, which leaves one
representation for the comparison and its validators. The allowance is decided
by the content script and travels on the request as `booleanKind`, exactly as
`dateKind` does, because it is a per-surface, per-policy judgement the snapshot
must not make: only a variable whose own comparison mode is boolean, and only on
a surface in `WORKSPACE_BOOLEAN_VALUE_SURFACES`. SOW is deliberately absent —
no request item on either verified instance exposes a boolean-typed variable at
all, so nothing proves its component behaves the same. A number, a null or a
truthy object is still refused everywhere. The layer-1 type
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
A record-producer-backed classic form makes **no visibility claim at all**.
Its catalog variables are not fields `g_form` manages: measured on one such
record, `getFieldNames` is undefined, `isVisible` answered false for all 115
variables, and the element the reader measures by question id is an `<item>`
wrapper that is `display:inline` and always 0x0. Both sources therefore reported
every variable as hidden by a UI policy while the form was plainly showing them.
Those rows are bucketed `visibility-unknown` and labelled "Visibility unknown";
values and their comparison are untouched, which is what the panel is for.

The record kind decides this, because it is a structural fact rather than a
guess about the page. An aggregate "nothing on this form looked visible" test
was tried first and is wrong: on that very record one multi-row parent did
measure visible, which silently disarmed it — and a multi-row row shows its own
bucket, so the disarming row was invisible in the result. Request items keep
reporting what the form says, since their variables really are fields and
surfacing a hidden one is the feature's own point.

Record-producer targets apply the same rule to `question_answer`: the first read
requests answer/question metadata without `value`, and the second requests
`sys_id,value` only for allowlisted answer ids. No matching rows means the
extension does not claim an arbitrary classic record is producer-backed.
Variable-set metadata is resolved before that second read, so MRVS child-answer
ids are excluded and each MRVS renders as one parent row.

A multi-row variable set stores nothing on its own question row, so it gets a
third read of its own against `sc_multi_row_question_answer`, keyed by
`parent_id` (the RITM for a RITM target, the record itself for a
producer-backed one). It follows the same two phases: cell and
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
row for row before the raw array is compared.

Underneath that pair check sits a requirement that holds on **every** surface,
the classic one included: each row is a plain object, every cell is a string,
and every key is one of the set's own columns. That is what ties the array to
this variable set rather than to any array of objects, and it keeps a number, a
null or a nested object — which would stringify to `[object Object]` and report
a meaningless difference — out of the comparison. It is representation-agnostic
— a precondition for comparing strings at all rather than a claim about any one
component — so applying it on both surfaces transfers no per-surface evidence,
while the value/display pair check stays specific to the Workspace container.
The classic path previously accepted any JSON array. A set with no resolved
column names refuses everything, and nothing reaches that state today because a
live read is only requested for a set whose columns were all named and
allowlisted; the earlier "no columns known, so skip the key check" clause was
the one allow-by-default hole in a deny-by-default validator.

On top of the rules above, each
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
same function. That single read is authoritative: a **failed** one is final
rather than retried, because the definitions have already been reconciled
against the zero answers it returned, and a retry that succeeded would show
stored values against definitions the swap was never repaired on. A
**truncated** one skips reconciliation entirely, since "exactly one answer
shares this name" is not a claim a partial answer list can support — which is
what the producer reader already did by returning early.

An answer's own variable set is resolved before it may substitute anything. The
swap is by definition a set the item no longer attaches, so that set is absent
from the item-derived map and its multi-row nature is unknowable from the item
alone; the request-item reader therefore reads metadata for the answer sets its
map is missing, exactly as the producer reader always did for every set its
answers name. A set that cannot be resolved leaves its answers unsubstitutable
rather than assumed ordinary, because a multi-row child answer must never
replace a plain variable. Resolving it also supplies the set title a
substituted row would otherwise leave blank. A substituted definition replaces
the catalog one wholesale, so it carries the hidden-type and inactive flags
computed from the answer's own type and `active` — hardcoding them put a
substituted Hidden variable in the absent bucket. A substituted definition then has to be corroborated against the
form. Workspace does that through the entry identity gate, which refuses when
the form's entry id disagrees. The classic reader resolves `variables.<name>`,
which cannot tell the two questions apart, so a substituted row whose question
id is not rendered on the form is listed rather than compared — otherwise the
value read back belongs to the item's new variable of the same name, and
comparing it against this record's older answer compares two different
variables.

A record whose rows live under a set the item no longer attaches must not be
indistinguishable from a record with no rows, or the panel compares zero stored
rows against a populated form — a difference manufactured by the query. That is
established by a **bounded existence probe**, `parent_id=<id>^variable_setNOT
IN<enumerated ids>` at a limit of one row, while the metadata read itself stays
filtered to the enumerated sets. The signal is tri-state — present, absent or
unknown — never which sets or how many.

Widening the metadata read instead and filtering afterwards was the obvious
shape and the wrong one: detached cells then counted toward the row cap, so a
record holding enough of them truncated the read and refused **every** set on
it, over rows that were never going to be read. A probe that cannot be answered refuses exactly as a
positive one does, but reports itself as unknown and says so in its own words:
claiming the record holds rows under a dropped set would assert something about
storage that no read established. A set with no stored rows on a record holding
detached rows is listed rather than compared, and because the read is filtered,
a record whose rows are *all* detached now reads as empty — so both detached
reasons are checked ahead of the plain "nothing stored" one.

They sit *behind* the withheld and index-incomplete reasons, though.
`assembleNativeMrvsSets` creates a set's entry before the withheld
early-return, so a set whose every column was withheld has an entry with zero
rows; judged on "no rows" alone it would report that none were found, when rows
were found and withheld. Both of those branches require the set entry to exist,
so the all-detached record — which has no entry at all — still reaches the
detached reason. `NOT IN` was verified live rather than assumed: on a
record holding 44 rows across two sets, `IN` the first returned 26, `NOT IN` the
first returned 18, `NOT IN` both returned 0, and `NOT IN` an unrelated id
returned all 44, so the condition is applied rather than silently ignored.

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
