---
name: mv3-security-review
description: Perform a focused MV3 security review after changes to permissions, host permissions, the service worker, PAC download/validation/cooking/storage/application, proxy authentication or credentials, migration, IndexedDB or persistent state, external requests, or browser error handling; do not trigger for isolated prose, styling, or tests that cannot affect these boundaries.
---

# MV3 security review

Read root instructions and only the scoped `AGENTS.md` for paths actually
affected. Review the complete relevant diff plus enough callers to prove the
boundary. Never print secrets, credential-bearing strings, full custom provider
URLs, browsing data, or profile contents.

If package/lock, vendored code, dependency configuration, or an Action changed,
also use `$dependency-review`; do not repeat its generic supply-chain analysis.

## Select the browser scope

- Chromium runtime only: review Chromium semantics and run `verify:mv3`.
- Firefox runtime only: review Firefox semantics and run `verify:firefox`.
- Browser-neutral runtime, shared packaged input, manifest template, or Gulp:
  review both targets, run full `verify`, and compare both packages.
- Documentation/tests with no executable or security-boundary effect: do not run
  this skill ceremonially.

An isolated Firefox change does not require Chromium execution unless it changes
a shared input. PAC execution is Chromium-specific; Firefox declarative dataset
and fail-closed routing require their own tests.

## Review applicable boundaries

1. Permission/host-access or CSP expansion and remote script execution.
2. PAC/dataset trust: untrusted bytes stay data; exact hashing, signature/trust
   assignment, schema/size limits, and package provenance occur before use.
3. Fetch URL, credentials, redirects/final origin, streaming bounds, deadlines,
   referrer policy, fallback, and disabled-by-default network paths.
4. Credential flow to proxy auth and redaction from PAC/datasets, UI, DOM,
   storage metadata, RPC, errors, health, notifications, and diagnostics.
5. IndexedDB/storage atomicity, pointer/journal consistency, concurrent writes,
   restart/alarm reconstruction, and safe destructive cleanup.
6. Direct/fail-open paths, callback authorization, live proxy ownership, control
   loss, private access, proxy/listener errors, and Clear behavior.
7. Packaged-code allowlists, runtime/source correspondence, inactive production
   paths, and unreferenced executable code.

Use `test:pac` in addition to the selected gate only when Chromium PAC semantics
changed. Add real-browser QA when platform behavior matters: proxy/auth,
ownership, lifecycle/recovery, permissions, IndexedDB, alarms, or browser-level
fallback.

Report findings first by severity with repository-relative locations. Then list
verified invariants, checks, package impact, and unresolved browser QA. Do not
call Chromium PAC browser-level fail-closed while it uses `mandatory:false`.
