---
name: pac-regression
description: Review and test this repository's PAC routing semantics when a task changes or audits PAC generation/cooking, site-rule matching or precedence, provider fallback, proxy candidate selection/order, Direct/noDirect behavior, or own-proxy scope; do not trigger for copy, styling, documentation, state changes unrelated to routing, or build-only work.
---

# PAC regression

Work from the repository root. Set `$Project = '.\extensions\chromium\runet-censorship-bypass'`, read `AGENTS.md` and `$Project\src\extension-chromium-mv3\background\AGENTS.md`, then inspect the complete relevant working-tree and staged diff. Read relevant untracked files because `git diff` cannot show them. Never print credential values or private provider URLs.

1. State the affected routing branch and expected result. Trace `background/pac-mods.js`, `pac-cook.js`, the relevant service-worker site-rule code, and changed callers only as needed.
2. Build a compact matrix for the affected semantics and adjacent invariants. Include exact-host and `*.domain` base/subdomain scope; Auto, Proxy, and Direct; candidate counts and order; `noDirect`; safe defaults; and conflicting-rule precedence only where the change can affect them.
3. Run from the root:

   ```powershell
   npm --prefix $Project run test:pac
   npm --prefix $Project run test:mv3
   ```

4. When semantics changed, add or update executable cases in `$Project\src\extension-chromium-mv3\test\pac-regression.js`. Assert evaluated `FindProxyForURL` results, not only generated string fragments.
5. Reject an explicit Proxy rule without a usable candidate. Verify explicit Proxy results preserve candidate order and contain neither `DIRECT` nor a provider-PAC fallback. Check that Auto removes the intended override and Direct remains explicit.
6. Report failures as `scope | mode | candidates | expected | actual`. Separate automated evidence from Chromium QA, especially `mandatory: false`, empty/malformed results, real proxy fallback, DNS/leak behavior, and popup domain-scope derivation.
