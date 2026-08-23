# Repository instructions

## Scope and source map

This fork keeps the legacy Runet Censorship Bypass extension while developing a Chromium Manifest V3 migration. The current primary target is `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3`.

- Extension tooling root: `extensions/chromium/runet-censorship-bypass`.
- MV3 runtime: `src/extension-chromium-mv3`; `background/service-worker.js` is the entry point and `pages/` is the MV3 UI.
- Instruction routing: before modifying files under `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3/background/`, read and follow its `AGENTS.md`; before modifying files under `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3/pages/`, read and follow its `AGENTS.md`. Do this even when Codex starts from the repository root.
- Shared inputs: selected icons, locales, and page libraries under `src/extension-common`. Gulp deliberately excludes the legacy common background scripts and page implementations from MV3.
- Legacy MV2: `src/extension-common` plus `src/extension-full` or `src/extension-mini`; beta also uses full sources with a separate template context.
- Build/version authority: `src/templates-data.js`, `gulpfile.js`, and the manifest templates. The repository intentionally has no root npm package: never run `npm install`, `npm ci`, or npm scripts at the repository root; scope every package command to the authoritative `extensions/chromium/runet-censorship-bypass` package.
- Generated/local-only context: any `node_modules`, `build`, `dist`, `coverage`, `.tmp`, browser profile, archive, log, or options-page `dist`. Do not broadly inspect vendored/minified Ace files.

When required by the change rules below, run these commands from the repository root in PowerShell:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm --prefix $Project test
npm --prefix $Project run test:pac
npm --prefix $Project run build:mv2
npm --prefix $Project run verify:mv3
```

Use Windows PowerShell-compatible commands. Use `npm ci --prefix $Project` only when extension dependencies are missing. A functional legacy options bundle additionally needs `npm ci --prefix "$Project\src\extension-common\pages\options"` followed by `npm --prefix "$Project\src\extension-common\pages\options" run build`. `build:mv2` deletes the complete `build` directory, so always build MV2 before the final MV3 build. Whole-tree `npm run lint` has pre-existing legacy failures; use the focused `lint:mv3` check for MV3 work and report the legacy baseline rather than reformatting it.

## Coding approach

- Resolve uncertainty from code, tests, and current documentation. Ask for clarification only when remaining ambiguity would materially affect behavior, security, stored data, release scope, or a destructive action; otherwise make a reasonable low-risk assumption and surface it only when it affects the approach or result.
- For non-trivial work, use observable success criteria to guide implementation and verification. State them only when they help align scope or explain the evidence.
- Prefer the simplest solution that fully meets the requirement and fits the existing architecture. Add features, configuration, flexibility, or abstractions only for a demonstrated requirement or design need.
- Make focused changes and preserve unrelated behavior and user work. Do not reformat legacy files, regenerate lockfiles unnecessarily, or alter production behavior as cleanup.

## Documentation and release ownership

- Treat `README.md` and current docs as product artifacts. Before completing a PR, determine whether the change affects installation, user-visible behavior, supported browsers, security/privacy behavior, developer commands, architecture, or the release process. If it does, update the relevant current documentation in the same PR; do not change docs merely because an internal implementation detail changed.
- Current fork links use `aVitomin/runet-censorship-bypass-mv3`. Use `anticensority/runet-censorship-bypass` only for attribution/history or an explicitly reused upstream resource. Prefer relative links for files in this repository, never commit local filesystem paths, and never point current installation instructions at upstream MV2 release assets.
- Before every PR is considered complete, run `node ./scripts/verify-docs.mjs`. The existing `Verify MV3` workflow must keep the same documentation-integrity gate.
- For every public beta/release: publish or identify the exact release artifact; verify tag target and asset metadata; update the README current-release block and `docs/release-current.json`; verify ZIP/checksum links and SHA-256; run docs integrity; and confirm that old releases are not described as current. Ordinary unreleased tooling commits do not require a README version change: README follows the latest published release, not arbitrary `main`.
- Preserve `docs/legacy/**` as history. Do not rewrite old upstream URLs merely to make them look current, but keep historical status notices and structural relative links valid.

## Security, routing, and persistence invariants

- Treat downloaded PAC as untrusted routing code. Extension runtime code may validate, hash, store, cook, and pass it to Chromium, but must not `eval` it or execute it with `Function`.
- New raw and cooked PAC bodies belong in IndexedDB artifacts; `mv3State` normally stores metadata and artifact references. Legacy inline PAC data is retained only when non-destructive artifact migration fails, then retried.
- Own-proxy passwords remain in local MV3 state only for authentication. Valid structured credentials must not enter cooked PAC, UI displays, logs, events, errors, diagnostics, migration summaries, or reports. Preserve an unchanged redacted UI placeholder without replacing the stored password. Treat custom provider URLs, especially query strings, as sensitive in logs and reports.
- Custom provider input and final response URLs allow HTTPS and loopback HTTP. Reject credentials and revalidate followed redirects before accepting a PAC body. Treat custom URL query strings as sensitive in security review and browser QA.
- Routing precedence is explicit `DIRECT`, explicit `PROXY`, whitelist miss, `.onion`, then provider policy. Plain patterns are exact-host; `*.example` matches the base and subdomains. Candidate order is configured own proxies, local Tor, Tor Browser, then WARP entries.
- An explicit Proxy PAC result must contain usable candidates only: no provider result and no unintended `DIRECT`; reject cooking when no candidate exists. This is a generated-PAC invariant, not a claim of browser-level fail-closed behavior: PAC is currently applied with `mandatory: false`, and empty/malformed proxy results can fall back direct.
- Safe defaults remain `usePacScriptProxies: true`, `ownProxiesOnlyForOwnSites: true`, `replaceDirectWithProxy: false`, and `noDirect: false`. Broad proxying and Direct replacement are explicit opt-ins. Disabling own-sites-only currently broadens the complete user candidate list, including Tor/WARP.
- Periodic refresh may update artifacts while proxy control is off, but must not enable proxy control. Reapply only when persisted applied-provider metadata matches and live Chromium state still shows this extension controlling a PAC.
- `mv3State` is persistent; operation locks, auth attempts, debounce maps, and the state-operation queue are service-worker memory. State reads and whole-state writes are serialized within an active worker, and each queued mutation rereads storage instead of retaining a state snapshot. Restart-sensitive changes must reconstruct behavior from storage and alarms, and derived same-field updates must not span separate read and write calls when concurrent callers can intervene.
- Legacy migration is audit-first, explicit, field-limited, conflict-aware, idempotent, and non-destructive. It must not delete MV2 data or apply proxy settings. Do not assume migrated `pacUpdatePeriodInMinutes` changes the active `periodicUpdate.intervalMinutes`; reconcile them deliberately if that behavior is changed.

## Change rules and required checks

- PAC/routing/candidate changes: use `$pac-regression`, run `test:pac` and `test:mv3`, and add semantic cases when behavior changes.
- MV3 permissions, service worker, downloads, storage, auth, migration, external requests, or proxy errors: use `$mv3-security-review`, run `lint:mv3`, `test:mv3`, and `build:mv3`; identify real-browser QA.
- Shared/template/gulp/MV2 changes: run the full tests and `build:mv2`, then rebuild MV3. Report when the legacy options bundle could not be rebuilt.
- MV3 UI/localization changes: update both `en` and `ru`, build MV3, and manually check affected controls. Never render stored values with HTML injection sinks.
- Agent/docs-only changes: run `node ./scripts/verify-docs.mjs`, validate skill frontmatter/paths when relevant, and run `git diff --check`; do not claim product checks were necessary if no runtime file changed.

Before calling work complete, review the complete relevant diff and run the checks required above. If a required check cannot run, report the work as incomplete and explain why. Confirm that generated/profile/secret material is neither staged nor packaged, preserve unrelated changes, and name browser-dependent gaps. Report changed files and checks with pass/fail results; mention security/routing impact, unresolved product issues, generated artifacts, and browser QA only when relevant. Include final `git status --short`. Never commit, push, publish, or upload unless separately authorized.
