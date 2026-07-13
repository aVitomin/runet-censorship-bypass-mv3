---
name: release-candidate
description: Prepare or audit a local Chromium MV3 release candidate for this repository, including version consistency, tests, MV3 and relevant MV2 builds, packaging, hashing, secret/private-URL checks, staged-output checks, and a release summary; do not trigger for ordinary development builds or when no release artifact is requested.
---

# Release candidate

Work from the repository root, set `$Project = '.\extensions\chromium\runet-censorship-bypass'`, and read `AGENTS.md`. Do not commit, publish, upload, clean user changes, overwrite an existing archive, or reveal matched secret/private URL values.

1. Inspect `git status --short`, staged paths, and the complete release-relevant diff. A normal RC requires a clean tree; package a dirty tree only when the user explicitly accepts its exact contents.
2. Run the existing deterministic checks and builds. MV2 must precede MV3 because `build:mv2` deletes all of `build`:

   ```powershell
   npm --prefix $Project test
   npm --prefix $Project run lint:mv3
   npm --prefix $Project run build:mv2
   npm --prefix $Project run build:mv3
   ```

3. Validate `$Project\build\extension-chromium-mv3\manifest.json`, derive a new archive name from its version, and package the contents of that build directory at archive root with PowerShell `Compress-Archive`. Confirm `manifest.json` is at archive root and calculate SHA-256 with `Get-FileHash`.
4. If the ignored legacy options bundle is unavailable, report that the MV2 result was copy/template sanity only; do not call it a functional legacy UI build. Rebuild that bundle with its existing nested lockfile when legacy/shared changes require it.
5. Scan staged paths, generated output, and the archive without printing matched values. Reject dependency, cache, profile, log, environment, key, coverage, nested build/dist, secret, credential, or private-URL material.
6. Return version/version-name, archive path relative to the project, SHA-256, commands and results, dirty-tree state, legacy-build scope, a concise change/security summary, and remaining browser QA. Browser QA includes load-unpacked startup/restart, provider refresh without auto-enable, Proxy/Auto/Direct, real Tor and authenticated proxy behavior, proxy errors/takeover, IndexedDB persistence, and upgraded-profile migration.
