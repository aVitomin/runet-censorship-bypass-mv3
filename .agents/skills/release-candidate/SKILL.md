---
name: release-candidate
description: Prepare or audit a local Chromium MV3 release preflight for this repository, including version consistency, tests, MV3 and relevant MV2 builds, local packaging, hashing, secret/private-URL checks, staged-output checks, and a release summary; do not trigger for ordinary development builds or when no release artifact is requested.
---

# Local release preflight

This workflow produces a local preflight artifact only. Its locally built and packaged archive is not the canonical public release artifact and must not be published as one. Every public beta or release must follow `docs/development/RELEASE_PROCESS.md` and use the exact artifact from successful trusted-main CI for the validated `main` commit. Normally that is the push-to-main run. If GitHub creates no push run, do not rewrite or synthesize a commit: manually dispatch `Verify MV3` on `main` and accept it only when the event is `workflow_dispatch`, the ref is `refs/heads/main`, its head SHA equals current `origin/main`, the complete normal job succeeds, and that run uploads the canonical artifact.

Work from the repository root, set `$Project = '.\extensions\chromium\runet-censorship-bypass'`, and read `AGENTS.md`. Do not commit, publish, upload, clean user changes, overwrite an existing archive, or reveal matched secret/private URL values.

1. Inspect `git status --short`, staged paths, and the complete release-relevant diff. A normal RC requires a clean tree; package a dirty tree only when the user explicitly accepts its exact contents.
2. Check the release supply chain. Run the production audit and `npm audit signatures`; record tool limitations rather than weakening the check. Confirm that package/lock, vendored-code, dependency-manager, and GitHub Action changes received `$dependency-review`. Inspect newly introduced lifecycle scripts, reject unexpected non-registry dependency sources, and confirm source/package correspondence for vendored runtime dependencies where applicable.

   ```powershell
   node .\scripts\verify-supply-chain.mjs
   node --test .\scripts\verify-supply-chain.test.mjs
   npm --prefix $Project run audit:prod
   npm audit signatures --prefix $Project
   ```

3. Run the existing deterministic checks and builds. MV2 must precede MV3 because `build:mv2` deletes all of `build`:

   ```powershell
   npm --prefix $Project test
   npm --prefix $Project run lint:mv3
   npm --prefix $Project run build:mv2
   npm --prefix $Project run build:mv3
   ```

4. Validate `$Project\build\extension-chromium-mv3\manifest.json`, derive a new local archive name from its version, and package the contents of that build directory at archive root with PowerShell `Compress-Archive`. Confirm `manifest.json` is at archive root and calculate SHA-256 with `Get-FileHash`.
5. Treat the legacy Options toolchain under `$Project\src\extension-common\pages\options` as security-quarantined. Do not install or build it merely to obtain a functional legacy UI bundle. Report that functional build as unavailable/quarantined and state the MV2 copy/template scope actually checked. Any future need to run it requires a dedicated remediation task after `$dependency-review`.
6. Scan staged paths, generated output, and the archive without printing matched values. Reject dependency, cache, profile, log, environment, key, coverage, nested build/dist, secret, credential, or private-URL material.
7. Return version/version-name, local preflight archive path relative to the project, SHA-256, commands and results, dirty-tree state, legacy-build scope, supply-chain checks, a concise change/security summary, and remaining browser QA. Label the archive as local preflight output, not a public release source. Browser QA includes load-unpacked startup/restart, provider refresh without auto-enable, Proxy/Auto/Direct, real Tor and authenticated proxy behavior, proxy errors/takeover, IndexedDB persistence, and upgraded-profile migration.
