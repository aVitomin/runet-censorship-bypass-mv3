---
name: pac-regression
description: Review and test this repository's PAC routing semantics when a task changes or audits PAC generation/cooking, site-rule matching or precedence, provider fallback, proxy candidate selection/order, Direct/noDirect behavior, or own-proxy scope; do not trigger for copy, styling, documentation, state changes unrelated to routing, or build-only work.
---

# PAC regression

PAC execution is Chromium-specific. Read root and Chromium background
instructions, inspect the complete relevant diff (including relevant untracked
files), and never print credentials or private provider URLs.

1. Identify the affected routing branch and expected observable result. Trace
   only the needed callers through `pac-mods.js`, `pac-cook.js`, site scope, and
   the service worker.
2. Test affected and adjacent semantics: exact host and `*.domain`, Auto/Proxy/
   Direct, candidate order, `noDirect`, safe defaults, and precedence where
   relevant.
3. Run `test:pac` and `test:mv3`. Add executable cases to
   `test/pac-regression.js` when semantics change; assert evaluated
   `FindProxyForURL`, not string fragments.
4. Explicit Proxy requires a usable ordered candidate list with no provider
   fallback or unintended `DIRECT`. Auto removes its override; Direct remains
   explicit.

If browser-neutral routing changed, also run Firefox/shared tests and describe
Firefox declarative behavior separately; never imply Firefox executes PAC.
Report failures as `scope | mode | candidates | expected | actual`. Separate
deterministic evidence from Chromium browser QA for `mandatory:false`, malformed
results, real failover, DNS/leaks, and UI scope derivation.
