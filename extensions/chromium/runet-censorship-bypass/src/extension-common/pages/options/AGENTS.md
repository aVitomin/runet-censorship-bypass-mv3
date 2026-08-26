# SECURITY QUARANTINE

These instructions apply to the legacy Options source and toolchain in this directory. A security audit on 2026-08-26 found its obsolete dependency tree had 37 advisories, including 11 Critical, and obsolete dependencies with install scripts.

- Do not run `npm install`, `npm ci`, or package builds here during ordinary development, and do not add this toolchain to normal CI.
- Do not reuse this implementation or toolchain for Firefox support.
- Do not attempt remediation with `npm audit fix --force`.
- Any dedicated remediation must use `$dependency-review` and explicitly review the complete dependency/toolchain delta before installation.
- Preserve these legacy sources and their history unless the remediation task explicitly decides otherwise.
