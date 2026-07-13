# Repository instructions

## Scope and source map

This fork keeps the legacy Runet Censorship Bypass extension while developing a Chromium Manifest V3 migration. The current primary target is `extensions/chromium/runet-censorship-bypass/src/extension-chromium-mv3`.

- Extension tooling root: `extensions/chromium/runet-censorship-bypass`.
- MV3 runtime: `src/extension-chromium-mv3`; `background/service-worker.js` is the entry point and `pages/` is the MV3 UI.
- Shared inputs: selected icons, locales, and page libraries under `src/extension-common`. Gulp deliberately excludes the legacy common background scripts and page implementations from MV3.
- Legacy MV2: `src/extension-common` plus `src/extension-full` or `src/extension-mini`; beta also uses full sources with a separate template context.
- Build/version authority: `src/templates-data.js`, `gulpfile.js`, and the manifest templates. The outer `package.json` is unrelated donation tooling; do not use it to build the extension.
- Generated/local-only context: any `node_modules`, `build`, `dist`, `coverage`, `.tmp`, browser profile, archive, log, or options-page `dist`. Do not broadly inspect vendored/minified Ace files.

From the repository root in PowerShell:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm --prefix $Project test
npm --prefix $Project run test:pac
npm --prefix $Project run build:mv2
npm --prefix $Project run verify:mv3
```

Use Windows PowerShell-compatible commands. Use `npm ci --prefix $Project` only when extension dependencies are missing. A functional legacy options bundle additionally needs `npm ci --prefix "$Project\src\extension-common\pages\options"` followed by `npm --prefix "$Project\src\extension-common\pages\options" run build`. `build:mv2` deletes the complete `build` directory, so always build MV2 before the final MV3 build. Whole-tree `npm run lint` has pre-existing legacy failures; use the focused `lint:mv3` check for MV3 work and report the legacy baseline rather than reformatting it.

## Security, routing, and persistence invariants

- Treat downloaded PAC as untrusted routing code. Extension runtime code may validate, hash, store, cook, and pass it to Chromium, but must not `eval` it or execute it with `Function`.
- New raw and cooked PAC bodies belong in IndexedDB artifacts; `mv3State` normally stores metadata and artifact references. Legacy inline PAC data is retained only when non-destructive artifact migration fails, then retried.
- Own-proxy passwords remain in local MV3 state only for authentication. Valid structured credentials must not enter cooked PAC, UI displays, logs, events, errors, diagnostics, migration summaries, or reports. Preserve an unchanged redacted UI placeholder without replacing the stored password. Treat custom provider URLs, especially query strings, as sensitive in logs and reports.
- Custom provider input URLs allow HTTPS and loopback HTTP, but fetch follows redirects and does not currently revalidate the final response URL. Keep that limitation explicit in security review and browser QA.
- Routing precedence is explicit `DIRECT`, explicit `PROXY`, whitelist miss, `.onion`, then provider policy. Plain patterns are exact-host; `*.example` matches the base and subdomains. Candidate order is configured own proxies, local Tor, Tor Browser, then WARP entries.
- An explicit Proxy PAC result must contain usable candidates only: no provider result and no unintended `DIRECT`; reject cooking when no candidate exists. This is a generated-PAC invariant, not a claim of browser-level fail-closed behavior: PAC is currently applied with `mandatory: false`, and empty/malformed proxy results can fall back direct.
- Safe defaults remain `usePacScriptProxies: true`, `ownProxiesOnlyForOwnSites: true`, `replaceDirectWithProxy: false`, and `noDirect: false`. Broad proxying and Direct replacement are explicit opt-ins. Disabling own-sites-only currently broadens the complete user candidate list, including Tor/WARP.
- Periodic refresh may update artifacts while proxy control is off, but must not enable proxy control. Reapply only when persisted applied-provider metadata matches and live Chromium state still shows this extension controlling a PAC.
- `mv3State` is persistent; operation locks, auth attempts, and debounce maps are service-worker memory. Restart-sensitive changes must reconstruct behavior from storage and alarms. Whole-state patching is not serialized, so avoid adding concurrent read/modify/write races.
- Legacy migration is audit-first, explicit, field-limited, conflict-aware, idempotent, and non-destructive. It must not delete MV2 data or apply proxy settings. Do not assume migrated `pacUpdatePeriodInMinutes` changes the active `periodicUpdate.intervalMinutes`; reconcile them deliberately if that behavior is changed.

## Change rules and required checks

- Keep changes focused; do not reformat legacy files, regenerate lockfiles unnecessarily, or modify production behavior as cleanup.
- PAC/routing/candidate changes: use `$pac-regression`, run `test:pac` and `test:mv3`, and add semantic cases when behavior changes.
- MV3 permissions, service worker, downloads, storage, auth, migration, external requests, or proxy errors: use `$mv3-security-review`, run `lint:mv3`, `test:mv3`, and `build:mv3`; identify real-browser QA.
- Shared/template/gulp/MV2 changes: run the full tests and `build:mv2`, then rebuild MV3. Report when the legacy options bundle could not be rebuilt.
- MV3 UI/localization changes: update both `en` and `ru`, build MV3, and manually check affected controls. Never render stored values with HTML injection sinks.
- Agent/docs-only changes: validate skill frontmatter/paths and run `git diff --check`; do not claim product checks were necessary if no runtime file changed.

Done means the relevant tests and builds actually ran, the complete diff was reviewed, generated/profile/secret material is neither staged nor packaged, unrelated changes remain intact, and browser-dependent gaps are named. Report files changed, commands with pass/fail, security/routing impact, remaining product issues, generated artifacts, and final `git status --short`. Never commit, push, publish, or upload unless separately authorized.
