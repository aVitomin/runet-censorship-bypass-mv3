# Repository instructions

## Scope and source map

This fork maintains Chromium Manifest V3 and Firefox Manifest V3 targets. Legacy MV2 is historical and is available through repository history and the frozen development branch, not as a build target on current `main`.

- Extension tooling root: `extensions/chromium/runet-censorship-bypass`.
- Chromium MV3 runtime: `src/extension-chromium-mv3`; `background/service-worker.js` is the entry point and `pages/` is the Chromium MV3 UI.
- Firefox MV3 runtime: `src/extension-firefox-mv3`; `background/event-page.js` is the non-persistent Firefox background entry point. Browser-neutral contracts live in `src/extension-mv3-common`.
- Instruction routing: before modifying files under `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3/background/`, read and follow its `AGENTS.md`; before modifying files under `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3/pages/`, read and follow its `AGENTS.md`. Do this even when Codex starts from the repository root.
- Shared inputs: Chromium MV3 copies exactly five static page-library assets under `src/extension-common/pages/lib`; Firefox MV3 uses the explicit common-module allowlist in `gulpfile.js`. Do not broaden either package glob implicitly.
- Build/version authority: `src/templates-data.js`, `gulpfile.js`, and the maintained MV3 manifests/templates. The repository intentionally has no root npm package: never run `npm install`, `npm ci`, or npm scripts at the repository root; scope every package command to the authoritative `extensions/chromium/runet-censorship-bypass` package.
- Generated/local-only context: any `node_modules`, `build`, `dist`, `coverage`, `.tmp`, browser profile, archive, log, or options-page `dist`. Do not broadly inspect vendored/minified Ace files.

When required by the change rules below, run these commands from the repository root in PowerShell:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
node .\scripts\verify-supply-chain.mjs
node --test .\scripts\verify-supply-chain.test.mjs
npm --prefix $Project test
npm --prefix $Project run test:pac
npm --prefix $Project run verify:mv3
npm --prefix $Project run verify:firefox
```

Use Windows PowerShell-compatible commands. Use `npm ci --prefix $Project` only when extension dependencies are missing. No nested legacy Options package exists. Ordinary work must not reconstruct, install, build, test, or release MV2; use repository history or the frozen development branch for historical investigation. Chromium and Firefox builds clean only their own output roots and may run independently. Use the focused `lint:mv3` and `lint:firefox` checks.

## Coding approach

- Resolve uncertainty from code, tests, and current documentation. Ask for clarification only when remaining ambiguity would materially affect behavior, security, stored data, release scope, or a destructive action; otherwise make a reasonable low-risk assumption and surface it only when it affects the approach or result.
- For non-trivial work, use observable success criteria to guide implementation and verification. State them only when they help align scope or explain the evidence.
- Prefer the simplest solution that fully meets the requirement and fits the existing architecture. Add features, configuration, flexibility, or abstractions only for a demonstrated requirement or design need.
- Make focused changes and preserve unrelated behavior and user work. Do not reformat legacy files, regenerate lockfiles unnecessarily, or alter production behavior as cleanup.

## Dependency, Actions, and supply-chain policy

- Adding a dependency is not the default solution. Check browser/WebExtension APIs, Node APIs, and existing dependencies first. Prefer a small auditable local implementation for simple functionality when it avoids a large dependency tree, but do not reimplement mature security-sensitive primitives merely to avoid a legitimate established dependency.
- A package version must have been publicly available for at least 7 full days (168 hours), measured from its registry publication timestamp to review time, before it may be newly added or selected by an update. This applies to direct production and development dependencies; do not reduce it to 24, 48, or 72 hours or an unspecified few days. An exception requires a concrete security or compatibility emergency, explicit user approval, and a prominent PR record of the package/version, publication age, reason, and additional review. An AI agent cannot approve its own exception.
- Before adding a new direct dependency, use `$dependency-review` and verify its exact registry identity and selected version, publication date, public source repository and source/package correspondence, compatible license, maintenance history, observable maintainers/owners, advisories or malware reports, package/tarball contents, lifecycle scripts, transitive delta, registry integrity/signature, available provenance/attestation, and unexplained dependency or package-size growth. Downloads, stars, repository activity, OpenSSF Scorecard, and similar metrics are signals only, never proof of safety; there is no `npm reviews` requirement.
- Re-review a previously accepted package when there is evidence of an unexpected maintainer or repository-ownership change, source-repository change, dormant-project release, new lifecycle script, dramatic package-size or unusual transitive growth, public-source/package mismatch, or unusual registry, source, or integrity change.
- Manually inspect exactly what every newly introduced direct or transitive `preinstall`, `install`, or `postinstall` script executes. The dependency review must record why the script is needed and safe; never dismiss it as normal package behavior.
- Commit package locks, use `npm ci` for deterministic installation and CI, and review lockfile deltas for the versions actually installed. Reject unexplained registry/source or integrity changes and require explicit review for git, file, or arbitrary-URL dependencies. Never run `npm audit fix --force` automatically. Prefer exact direct version pins because this project has no library-consumer semver flexibility requirement; convert existing ranges only in a separately reviewed change.
- Pin third-party GitHub Actions to full immutable commit SHAs, verify each SHA belongs to the intended official repository/version, declare explicit least-privilege workflow permissions, and set `persist-credentials: false` unless a task explicitly requires write credentials. Review new or changed third-party Actions like dependencies.
- An AI/Codex agent must not propose or install a package merely because it remembers the name, finds it convenient, sees it in generated output, or thinks the name looks right. It must first prove that the package exists, its registry and source-repository identities are correct, the requested version exists, and the same age, trust, and security policy was applied. This guards against hallucinated, dependency-confusion, and slopsquatted package names.
- Apply the same trust and security review to new vendored runtime libraries or code. Copying a minified library into the repository does not bypass dependency review.

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

- Dependency manifests, lockfiles, vendored third-party libraries, dependency-manager configuration, or GitHub Action additions/updates: use `$dependency-review`, run `node .\scripts\verify-supply-chain.mjs` and its focused Node test, and run the applicable audit/build/test gates. If the change also crosses an MV3 security boundary, use `$mv3-security-review` as well.
- PAC/routing/candidate changes: use `$pac-regression`, run `test:pac` and `test:mv3`, and add semantic cases when behavior changes.
- MV3 permissions, service worker, downloads, storage, auth, migration, external requests, or proxy errors: use `$mv3-security-review`, run `lint:mv3`, `test:mv3`, and `build:mv3`; identify real-browser QA.
- Shared/template/Gulp changes: run the full maintained tests, build both MV3 targets, and compare both package trees against their trusted baselines. Historical MV2 code is not a verification target on current `main`.
- MV3 UI/localization changes: update both `en` and `ru`, build MV3, and manually check affected controls. Never render stored values with HTML injection sinks.
- Release preparation, provenance, packaging, or audit work: use `$release-candidate`.
- Agent/docs-only changes: run `node ./scripts/verify-docs.mjs`, validate skill frontmatter/paths when relevant, and run `git diff --check`; do not claim product checks were necessary if no runtime file changed.

Before calling work complete, review the complete relevant diff and run the checks required above. If a required check cannot run, report the work as incomplete and explain why. Confirm that generated/profile/secret material is neither staged nor packaged, preserve unrelated changes, and name browser-dependent gaps. Report changed files and checks with pass/fail results; mention security/routing impact, unresolved product issues, generated artifacts, and browser QA only when relevant. Include final `git status --short`. Never commit, push, publish, or upload unless separately authorized.
