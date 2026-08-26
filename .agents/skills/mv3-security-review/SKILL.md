---
name: mv3-security-review
description: Perform a focused MV3 security review after changes to permissions, host permissions, the service worker, PAC download/validation/cooking/storage/application, proxy authentication or credentials, migration, IndexedDB or persistent state, external requests, or browser error handling; do not trigger for isolated prose, styling, or tests that cannot affect these boundaries.
---

# MV3 security review

Work from the repository root. Set `$Project = '.\extensions\chromium\runet-censorship-bypass'` and read `AGENTS.md` plus `$Project\src\extension-chromium-mv3\background\AGENTS.md`. Review the complete relevant diff and enough callers to prove impact. Do not echo secrets, credential-bearing strings, full custom provider URLs, or browser-profile data; cite their locations and redact values.

If the change also touches a package manifest or lock, vendored third-party code, dependency-manager configuration, or a GitHub Action, use `$dependency-review` as well. Where dependency changes intersect runtime security, review newly introduced lifecycle scripts and non-registry sources plus the code that actually enters service-worker or page execution; do not duplicate the general dependency review here.

Review the affected boundary and any plausible adjacent effects. Use the following order for applicable items; do not add ceremonial `N/A` sections for unrelated categories:

1. Permission or host-access expansion in `manifest.tmpl.json`, including whether `<all_urls>` use grew.
2. CSP/script execution and the PAC trust boundary: downloaded PAC stays data until Chromium receives it; flag dynamic extension execution. Distinguish proving that extension code does not evaluate remote code from proving Chrome or Firefox store remote-code-policy compliance.
3. URL scheme, redirect/final-URL, size, fallback, credential mode, referrer policy, and external-request validation for PAC and other fetches.
4. Credential path from structured state to `onAuthRequired`; generated PAC, UI, event, error, log, diagnostic, health, and migration redaction.
5. IndexedDB artifacts versus `mv3State`, service-worker restart recovery, alarm reconstruction, concurrent whole-state writes, and destructive cleanup. When content scripts or externally reachable contexts are introduced, verify `storage.local` and `storage.session` access levels.
6. Routing fail-open/fail-closed effects, `DIRECT` or direct-IP leak paths, live proxy-control checks, proxy-error coverage, and custom-provider disable/delete behavior.
7. Migration confirmation, field selection, idempotence, old-data retention, proxy-apply side effects, and active refresh-interval mapping.
8. Packaged-code allowlists, unreferenced executable code, and source correspondence for vendored runtime code where relevant.

Run:

```powershell
npm --prefix $Project run lint:mv3
npm --prefix $Project run test:mv3
npm --prefix $Project run build:mv3
```

Return concrete findings first, ordered by severity, with repository-relative file and line references. Then list verified invariants, checks run, and real-browser QA still required. Do not label generated PAC fully fail-closed while Chromium uses `mandatory: false` or malformed/empty results remain possible.
