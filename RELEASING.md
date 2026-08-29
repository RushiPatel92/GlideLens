# Releasing GlideLens

Read this document only after the user explicitly authorizes publishing. Local
implementation or packaging does not authorize a push, pull request, merge,
tag, or store submission.

GlideLens ships the same artifact to both the Chrome Web Store and Microsoft
Edge Add-ons:

- Chrome: <https://chromewebstore.google.com/detail/glidelens/bgjopdljfdgoamplbodfdaacjbgiopck>
- Edge: <https://microsoftedge.microsoft.com/addons/detail/glidelens/aoohpfoblgnnciiiplppjkjabhjgaghj>

## Release preparation

1. Confirm the release scope and explicit publication authorization.
2. Bump `version` in `manifest.json` and update `CHANGELOG.md`.
3. Run the full test command in `DEVELOPMENT.md`.
4. Run `node package.mjs --check`.
5. Run `node package.mjs` and retain the printed SHA-256.
6. Extract `dist/glidelens-<version>.zip` into a temporary directory, load that
   directory unpacked in Chrome, and exercise it on a real instance. Test the
   artifact rather than the working tree.
7. Inspect the archive contents and scan all release text for confidential or
   customer-identifying information.

## GitHub publication workflow

When the user asks to deploy, publish, or "commit and push" a feature branch:

1. Validate and commit the feature branch.
2. Push it without deleting the remote branch.
3. Open a pull request to `main`.
4. Wait for validation, then merge and verify the pull request.
5. Fetch, switch to local `main`, and fast-forward it.
6. Tag the release on `main`, then push the tag. See "Tagging" below.

A branch push alone is complete only when the user explicitly requests "push
branch only" or asks not to merge. Remote feature branches must remain intact.
Admin bypass is permitted only for an explicitly authorized merge and never to
bypass failed validation.

When an agent materially contributed, include the official commit trailer:

```text
Co-authored-by: Codex <noreply@openai.com>
```

## Tagging

Every released version gets an annotated tag named `v<version>`, placed on the
merge commit that brought the release into `main` -- not on the feature
branch's version-bump commit:

```text
git tag -a v<version>
git push origin v<version>
```

The message is a summary line, then prose explaining what changed and why.
Run `git tag -l --format='%(contents)' v0.11.1` to see the house style.

A tag is what makes a shipped version recoverable later. `git diff
v0.11.0..v0.11.1` answers "what changed between these two releases" in one
command, and a store reviewer question can be answered against the exact code
that shipped. A tag is also what a GitHub Release is built on, though pushing
one does not publish a Release by itself -- that is a separate step, and this
project has not been using it. Skipping a tag leaves a
permanent hole: 0.11.0 and 0.11.1 shipped untagged because this document had no
tagging step, and both had to be backfilled on 2026-08-28.

Pushing a tag is publication. It needs the same explicit authorization as a
push or a merge, and a pushed tag is not to be deleted or moved.

## Store submission

Upload the exact same ZIP to both stores. A release is not complete when only
one listing has been updated.

Keep these listing constraints in mind:

- Edge derives its short description from the manifest `description`; Chrome's
  listing text is independent. Do not make them match accidentally by changing
  the manifest.
- Keep the reviewer developer instance and dedicated reviewer account usable
  throughout both review windows. **Leave the account active afterwards, and do
  not rotate its password.** That is a settled decision, not an oversight: the
  instance is a throwaway developer instance, and the same account is what the
  Playwright harnesses sign in with, so the churn buys nothing. Do not
  reintroduce a deactivation or rotation step here, and do not raise either as a
  suggestion.
- Store forms and limits change. Use the current private notes in the ignored
  `plans/` directory for submission answers, permission wording, reviewer notes,
  screenshots, and any credentials. Never commit those credentials.

After submission, record the version, artifact hash, and status for both stores
without copying credentials or customer details into a committed artifact.
