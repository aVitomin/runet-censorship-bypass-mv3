---
name: dependency-review
description: Review package.json or package-lock changes, new or updated dependencies, vendored third-party code, GitHub Action additions or updates, or dependency-manager configuration in this repository.
---

# Dependency review

Work from the repository root, read `AGENTS.md` and any scoped `AGENTS.md`, and establish the exact dependency, vendored-code, Action, or configuration delta before installing anything. Obey the legacy Options quarantine; do not install that package unless the user explicitly scopes a dedicated remediation task.

1. Prefer browser/WebExtension APIs, Node APIs, and existing dependencies when they satisfy the requirement. State why a proposed dependency is preferable to platform, existing, or small auditable local code; do not locally reimplement complex security-sensitive primitives merely to avoid a mature dependency.
2. Confirm the exact registry/package and source-repository identities and that the selected version exists before installation. Require the selected production or development dependency version to have been publicly available for at least 7 full days (168 hours), measured from registry publication to review. A younger version requires a concrete security or compatibility emergency, explicit user approval, and a prominent record of its version, age, reason, and extra review; an AI agent cannot approve the exception.
3. Verify the selected version's publication metadata, license compatibility, public source/package correspondence, maintenance history, current maintainers or owners and their observable changes, advisories or malware reports, package/tarball contents, registry integrity/signature, and available provenance or attestations. Treat downloads, stars, activity, and Scorecard results as signals only, never proof.
4. Inspect exactly what every newly introduced direct or transitive `preinstall`, `install`, or `postinstall` script executes. Record why it is needed and safe. Review transitive dependency and package-size growth for unexplained additions.
5. Review the complete lockfile delta, including selected versions, resolved URLs, integrity hashes, source changes, lifecycle-script flags, and unexpected packages. Reject unexplained changes and explicitly review git, file, arbitrary-URL, or other non-registry sources. Prefer exact direct version pins.
6. For a new or changed third-party GitHub Action, verify the full commit SHA belongs to the intended official repository/version, inspect its source and dependencies, require explicit least-privilege permissions, and keep `persist-credentials: false` unless write credentials are explicitly required.
7. Run or evaluate the applicable deterministic install, audit, signature, build, and test commands from the authoritative package directory. For the Chromium package use:

   ```powershell
   $Project = '.\extensions\chromium\runet-censorship-bypass'
   node .\scripts\verify-supply-chain.mjs
   node --test .\scripts\verify-supply-chain.test.mjs
   npm ci --prefix $Project
   npm --prefix $Project run audit:prod
   npm audit --prefix $Project
   npm audit signatures --prefix $Project
   ```

   Record registry-signature and provenance results plus any CLI limitation. Run the relevant repository builds and tests for the affected scope.
8. Review vendored third-party runtime code to the same standard, including origin, license, version, source correspondence, executable contents, and update provenance. Copying minified code does not bypass review.

Never run `npm audit fix --force`, install a package before confirming its identity, judge safety only from popularity or Scorecard signals, or hide transitive and lifecycle-script changes.

Return exactly one decision with the evidence and unresolved risks: `APPROVE`, `REJECT`, or `NEEDS USER APPROVAL`. Use `NEEDS USER APPROVAL` for a less-than-7-day emergency exception, a material unresolved trust issue, an unusual lifecycle script, or source/maintainer identity ambiguity that cannot be resolved safely.
