---
name: pac-regression
description: Review and test this repository's PAC routing semantics after changes to PAC generation or cooking, site rules, provider fallback, candidate selection or ordering, Direct/noDirect behavior, own-proxy scope, or related state; do not trigger for copy, styling, documentation, or unrelated build-only changes.
---

# PAC regression

Work from the repository root. Set `$Project = '.\extensions\chromium\runet-censorship-bypass'`, read `AGENTS.md` and `$Project\src\extension-chromium-mv3\background\AGENTS.md`, then inspect the complete relevant working-tree and staged diff. Read relevant untracked files because `git diff` cannot show them. Never print credential values or private provider URLs.

1. State the affected routing branch and expected result. Trace `background/pac-mods.js`, `pac-cook.js`, the relevant service-worker site-rule code, and changed callers only as needed.
2. Build a compact matrix covering exact host and `*.domain` base/subdomain scope; Auto/provider behavior; explicit Proxy; explicit Direct; zero, one, and multiple candidates; candidate order; `noDirect`; and the four safe defaults. Include conflicting-rule precedence when relevant.
3. Run from the root:

   ```powershell
   npm --prefix $Project run test:pac
   npm --prefix $Project run test:mv3
   ```

4. When semantics changed, add or update executable cases in `$Project\src\extension-chromium-mv3\test\pac-regression.js`. Assert evaluated `FindProxyForURL` results, not only generated string fragments.
5. Reject an explicit Proxy rule without a usable candidate. Verify explicit Proxy results preserve candidate order and contain neither `DIRECT` nor a provider-PAC fallback. Check that Auto removes the intended override and Direct remains explicit.
6. Report failures as `scope | mode | candidates | expected | actual`. Separate automated evidence from Chromium QA, especially `mandatory: false`, empty/malformed results, real proxy fallback, DNS/leak behavior, and popup domain-scope derivation.
