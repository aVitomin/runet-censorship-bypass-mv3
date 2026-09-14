---
name: dependency-review
description: Review package.json or package-lock changes, new or updated dependencies, vendored third-party code, GitHub Action additions or updates, or dependency-manager configuration in this repository.
---

# Dependency review

Read root and scoped instructions, then identify the exact package, lockfile,
vendored-code, Action, or manager-config delta before installing anything. The
repository has one npm root; historical MV2 tooling must not be reconstructed.

## Decision path

1. Prefer platform or existing APIs. Explain why a new dependency is necessary;
   do not reimplement a mature security primitive merely to avoid a dependency.
2. Before installation, prove the registry identity, selected version, source
   repository correspondence, license, and publication time. A new direct
   version must be at least 168 hours old. A younger emergency version requires
   explicit user approval; the agent cannot approve its own exception.
3. Review maintainer/source ownership changes, advisories or malware reports,
   tarball contents and size, integrity/signatures, provenance, maintenance
   history, and transitive growth. Popularity and Scorecard are signals, not
   proof.
4. Inspect every newly introduced direct or transitive lifecycle script and
   record exactly why it is safe. Review the complete lock delta: resolved URLs,
   integrity, lifecycle flags, unexpected packages, and git/file/URL sources.
5. For Actions, verify the full SHA belongs to the official repository/version,
   inspect executable contents/dependencies, preserve least privilege, and keep
   checkout credentials disabled unless write access is explicitly required.
6. Review vendored code to the same identity, license, source-correspondence,
   executable-content, and update-provenance standard.

## Evidence

Run the applicable subset from the repository root:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
node .\scripts\verify-supply-chain.mjs
node --test .\scripts\verify-supply-chain.test.mjs
npm ci --prefix $Project
npm --prefix $Project run audit:prod
npm audit --prefix $Project
npm audit signatures --prefix $Project
```

Also run the canonical gate for each affected browser target. Record production
and full audit results separately, registry/provenance tool limitations, direct
versus transitive scope, and whether a dependency enters a shipped package.
Never use `npm audit fix --force`, install before identity review, or hide an
unexplained transitive/lifecycle change.

Return `APPROVE`, `REJECT`, or `NEEDS USER APPROVAL`, with concise evidence and
unresolved risks. Use the last result for a young-version exception, unusual
lifecycle code, or unresolved source/maintainer identity.
