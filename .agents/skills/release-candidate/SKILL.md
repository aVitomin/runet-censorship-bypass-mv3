---
name: release-candidate
description: Prepare or audit a dual-browser Chromium MV3 and Firefox MV3 release candidate, trusted-main artifacts, version consistency, reproducibility, packaging, signing boundaries, and release QA; do not trigger for ordinary development builds.
---

# Dual-browser release preflight

Read root instructions and `docs/development/RELEASE_PROCESS.md`. Local archives
are preflight evidence, never canonical public artifacts. Public Chromium and
Firefox releases use exact artifacts from successful trusted-main CI for the
validated `main` SHA. A manual dispatch is trusted only on exact `main`, with
the complete workflow green and canonical artifacts present.

Do not commit, publish, upload, sign, overwrite an archive, clean user changes,
or reveal matched secret/private URL values without explicit authorization.

## Preflight

1. Require a clean tree and record exact SHA. Review the release-relevant diff,
   version authority, Chromium/Firefox manifest versions, Gecko ID, and current
   release metadata. Historical MV2 is not a target.
2. Run docs, supply-chain verifier/tests, registry signatures, production audit,
   and the canonical full maintained `verify`. Confirm dependency/Action/vendor
   changes received `$dependency-review`.
3. Run `release:chromium` and `release:firefox`. These create deterministic
   Chromium ZIP/checksum and Firefox unsigned XPI/checksum/reviewer-source ZIP.
   Confirm a second clean build is byte-identical, manifests are at archive
   roots, package allowlists pass, and reported SHA-256 values match.
4. Scan staged paths, package trees, and archives without printing matched
   values. Reject dependencies, caches, profiles, logs, environment files,
   private keys, credentials, private URLs, tests, source maps, and nested output.
5. Run current pinned Mozilla addons-linter against the exact XPI. Signing and
   AMO submission remain external; no signing credential belongs in repository
   or CI.
6. Verify the trusted-main run uploaded both canonical artifact sets. PR artifact
   upload stays disabled. Confirm tag/version consistency before any publication.

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
node .\scripts\verify-docs.mjs
node .\scripts\verify-supply-chain.mjs
node --test .\scripts\verify-supply-chain.test.mjs
npm --prefix $Project run audit:prod
npm audit signatures --prefix $Project
npm --prefix $Project run verify
npm --prefix $Project run release:chromium
npm --prefix $Project run release:firefox
```

## QA and report

Use exact packaged candidates in disposable profiles. Cover supported Chromium
browsers and Firefox 154+, including install/clean OFF, UI, Auto/Proxy/Direct,
auth, provider data, Apply/Clear, restart recovery, ownership/control loss, and
private-window behavior as applicable. Distinguish tested browsers from expected
compatibility and record protected-origin contacts and credential leaks.

Return exact version/SHA, artifact names/sizes/checksums, deterministic rebuild
result, source archive and addons-linter result, trusted-run identity, package
counts, security/audit results, browser QA, AMO/signing boundary, and remaining
blockers. Label every local artifact as non-public preflight output.
