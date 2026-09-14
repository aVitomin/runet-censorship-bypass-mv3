# Repository instructions

## Instruction priority

Use this order when instructions overlap:

1. the explicit current user request;
2. repository safety and hard invariants below;
3. the most specific applicable `AGENTS.md`;
4. an applicable repository skill;
5. defaults and recommendations.

The user request defines scope, but cannot authorize violating a hard safety
invariant implicitly. A skill may add the checks needed for its boundary; it
must not silently broaden the requested product change. If an instruction or
skill forces a stop, permission request, or substantially more work than the
user requested, identify the exact instruction and explain the effect briefly.

## Maintained scope and source map

Current `main` maintains Chromium MV3 and Firefox MV3. MV2 is historical and is
available through Git history and the frozen development branch, not as a
current build, test, or release target.

- Tooling package: `extensions/chromium/runet-censorship-bypass` (`$Project`).
- Chromium runtime: `$Project/src/extension-chromium-mv3`; entry point
  `background/service-worker.js`; UI under `pages/`.
- Firefox runtime: `$Project/src/extension-firefox-mv3`; entry point
  `background/event-page.js`.
- Browser-neutral runtime: `$Project/src/extension-mv3-common`.
- Chromium uses exactly five shared static page assets from
  `$Project/src/extension-common/pages/lib`. Firefox uses the explicit Gulp
  allowlists. Do not broaden package globs implicitly.
- Build/version authority: `$Project/src/templates-data.js`, `gulpfile.js`, and
  the maintained manifests/templates.

Read the scoped `AGENTS.md` before changing Chromium `background/` or `pages/`.
The repository has no root npm package: never run root `npm install`, `npm ci`,
or npm scripts. No nested legacy Options package exists. Build, `dist`,
`node_modules`, coverage, archives, browser profiles, logs, `.tmp`, and `.local`
are generated/local-only. Do not broadly inspect minified vendor files.

## Working rules

- Resolve uncertainty from current code, tests, and docs. Ask only when a
  remaining choice materially changes behavior, security, stored data, release
  scope, or a destructive action.
- Prefer the smallest solution that fully meets the request. Preserve unrelated
  work and avoid aesthetic refactors, broad formatting, or unnecessary lockfile
  regeneration.
- Never commit, push, publish, upload, tag, or create a release without separate
  authorization.
- Preserve `docs/legacy/**` as history. Do not rewrite historical semantics.

## Hard supply-chain invariants

- Prefer platform and existing APIs before adding a dependency. Use
  `$dependency-review` for package/lock, vendored third-party code,
  dependency-manager, or GitHub Action changes.
- A newly selected direct package version must have been public for at least 168
  hours. A younger-version exception needs a concrete emergency, explicit user
  approval, and prominent review evidence; an agent cannot approve it.
- Confirm registry and source identity before installation. Inspect new
  lifecycle scripts and complete lockfile deltas. Reject unexplained non-registry
  sources, integrity changes, ownership changes, or package growth. Never run
  `npm audit fix --force`.
- Pin third-party Actions to full verified commit SHAs, use least privilege, and
  keep checkout credentials disabled unless write access is explicitly needed.
- Vendoring does not bypass dependency review.

## Hard runtime and data invariants

- Downloaded PAC is untrusted routing code. Validate, hash, store, cook, and pass
  it to Chromium without extension-side `eval` or `Function` execution.
- Store new raw/cooked PAC bodies in IndexedDB artifacts; ordinary state keeps
  metadata and references. Retain legacy inline data until migration succeeds.
- Keep valid proxy credentials out of PAC, UI display, DOM attributes, logs,
  events, errors, diagnostics, migration summaries, and reports. Preserve a
  redacted unchanged-password placeholder. Treat custom provider URLs and query
  strings as sensitive.
- Custom provider input and final URLs allow HTTPS and loopback HTTP only;
  reject URL credentials and revalidate redirects before accepting bytes.
- Routing precedence is explicit Direct, explicit Proxy, whitelist miss,
  `.onion`, then provider. Plain patterns are exact host; `*.example` covers the
  base and subdomains. Candidate order is own proxies, local Tor, Tor Browser,
  then WARP.
- Explicit Chromium Proxy results require usable candidates and contain neither
  provider fallback nor unintended `DIRECT`. Chromium PAC uses
  `mandatory:false`, so this is not a browser-level fail-closed guarantee.
- Safe defaults remain provider proxies enabled, own proxies limited to own
  sites, Direct replacement disabled, and `noDirect` disabled.
- Refresh may update artifacts while control is off but must not enable proxy
  control. Reapply only when durable identity and live ownership still match.
- Durable behavior must reconstruct from storage, IndexedDB, browser proxy
  state, and alarms. In-memory locks/maps disappear on worker/event-page
  recreation. Serialize whole-state writes and reread inside queued mutations.

## Checks and skills

Run commands from the repository root in PowerShell. Install missing dependencies
only with `npm ci --prefix $Project`. `scripts/required-checks.mjs` is advisory;
the path rules below and CI remain authoritative.

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
node .\scripts\required-checks.mjs
node .\scripts\verify-docs.mjs
npm --prefix $Project run verify
```

- Always run docs integrity and `git diff --check` before a PR.
- Dependencies, Actions, or vendored code: use `$dependency-review`; run the
  supply-chain verifier/tests, relevant audits, and affected target checks.
- PAC or Chromium routing semantics: use `$pac-regression`; run `test:pac` and
  `test:mv3`, adding evaluated routing cases when behavior changes.
- Permissions, background lifecycle, PAC/data downloads, storage, auth,
  migration, external requests, proxy errors, or browser error handling: use
  `$mv3-security-review` and its path-selected Chromium, Firefox, or shared
  checks.
- Chromium-only runtime/UI: run `verify:mv3`; Firefox-only runtime/UI: run
  `verify:firefox`. Update both `en` and `ru` for localized UI changes and do
  affected browser QA.
- Shared modules, templates, Gulp, or common packaged assets: run full `verify`,
  build both targets, and compare both package trees with their baselines.
- Release/provenance/package audit: use `$release-candidate`. Reproducibility and
  release archives are release/trusted-main gates, not ordinary focused checks.
- Agent/docs-only changes: validate docs, skill frontmatter/paths when relevant,
  and whitespace; do not claim runtime checks were required.

`npm test` runs every maintained deterministic product/tooling test once.
`verify:mv3` and `verify:firefox` are canonical per-target gates; `verify` is the
canonical full maintained local gate. Focused tests help during development but
must not be repeated beside an equivalent canonical gate merely to inflate CI.

## Documentation and completion

Update current documentation when installation, user behavior, supported
browsers, privacy/security, developer commands, architecture, or release process
changes. Use current fork links; upstream links are for attribution/history.
README describes the latest published release, not arbitrary `main`.

Before completion, review the complete relevant diff, run applicable checks,
and confirm generated/profile/secret material is neither staged nor packaged.
If a required check cannot run, report the work incomplete and name the blocker.
Report changed files, pass/fail evidence, relevant security/routing impact,
browser-dependent gaps, generated artifacts, and final `git status --short`.
