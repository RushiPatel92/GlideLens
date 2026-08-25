# GlideLens project instructions

GlideLens is a Manifest V3 Chrome extension of developer utilities for
ServiceNow. It uses dependency-free vanilla JavaScript and has no development
build step.

## Read the relevant project documentation

Before changing code, use these task-specific references:

- Read `ARCHITECTURE.md` when changing frames, message flow, REST access,
  content-script behavior, Code Search, Debug Timeline, catalog features,
  translations, or the public demo panels.
- Read `DEVELOPMENT.md` for the run/debug loop, tests, packaging, adding files,
  and verifying ServiceNow Table API assumptions.
- Read `RELEASING.md` only when the user explicitly asks to publish or release.
- Use `README.md` as the source of truth for the public feature description and
  installation instructions.

## Non-negotiable repository rules

### Client confidentiality

Client confidentiality is absolute. Never write a real client or customer
name, tenant or instance name, hostname, company-specific identifier, account
name, internal URL, or other identifying customer detail anywhere in this
repository's work.

This applies even to gitignored or local notes and includes files, plans,
branches, commits, tags, pull requests, issues, release notes, store
submissions, screenshots, logs, traces, fixtures, and test data. Information
seen in a browser, tool output, pasted trace, or user message remains
confidential even when the user does not repeat that instruction.

Use anonymous descriptions such as "customer instance", "test instance", or
"framed classic form" and synthetic data such as `example.service-now.com`.
Before every push, pull request, issue, release, or other shared artifact, scan
the staged diff, published commits, branch name, and accompanying text for
identifiers. If an identifier might be customer-specific, omit or anonymise it.

### Local changes versus publishing

Building is not deploying. Never push, open a pull request, merge, or tag
without an explicit, separate instruction to do so. "Build this", "implement
this", "go ahead", and "fix it" authorize local work only. The user tests the
real extension before anything is shared.

When the user explicitly asks to deploy, publish, or "commit and push" a
feature branch, follow the complete workflow in `RELEASING.md`. A branch push
alone is not completion unless the user explicitly asks to push the branch
only.

Never delete a branch from GitHub or another Git remote. Remote branches remain
intact after merges and during cleanup. Local branch cleanup is allowed when
requested.

The repository owner has given standing approval to use GitHub's admin bypass
when needed to merge an explicitly authorized pull request. This does not
replace publication authorization and never authorizes bypassing failed
validation.

### Git conventions

- When an agent materially contributes to a commit, add:
  `Co-authored-by: Codex <noreply@openai.com>`.
- Name new branches `YYYYMMDD-NN-category-description`, using the current
  Europe/London date and the next unused two-digit sequence for that date.
- Valid categories are `feature`, `fix`, `maintenance`, and `docs`.
- Inspect local and remote branches with the same date prefix before choosing
  the sequence. Keep `main` unchanged while developing.

### Technical constraints

- Keep the extension dependency-free vanilla JavaScript. Do not introduce a
  bundler or framework into extension pages.
- Manifest V3 page CSP forbids `unsafe-eval`; AngularJS cannot run in the popup.
  Content scripts may use Service Portal's existing page-owned Angular.
- Do not create a top-level file or directory whose name begins with `_`.
  Chrome reserves those names and refuses to load the extension.
- Do not guess ServiceNow table columns or dot-walks. Follow the live-instance
  verification procedure in `DEVELOPMENT.md`.

## Product direction

Focus on gaps left by snUtils: catalog and Service Portal debugging,
translation and dictionary inheritance, code search, and form introspection.
Do not propose an update-set switcher, impersonation, or per-environment
favicon/instance badges; snUtils already covers them.

Current roadmap candidates are a Background Script runner, Table API record
search, a GlideRecord snippet generator, and toggle persistence for Workspace
forms.
