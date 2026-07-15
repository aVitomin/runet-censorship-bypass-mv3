# MV3 background instructions

These files form one service-worker runtime. Preserve the top-level `importScripts` dependency order and register lifecycle, alarm, proxy, auth, error, and message listeners synchronously. In-memory promises/maps disappear on worker suspension; durable behavior must come from `mv3State`, IndexedDB artifacts, Chromium proxy state, and alarms.

- Keep downloaded PAC as text. Validate/hash/store/cook it without extension-side execution. Apply only a current cooked artifact whose provider, raw hash, modifier hash, and live proxy-control checks agree.
- Store new PAC bodies in `mv3PacArtifacts`; keep only summaries/references in normal state and RPC results. Do not delete legacy inline data unless its artifact write succeeded.
- Normalize settings through the module APIs. Avoid new whole-state read/modify/write races; `saveStatePatch` is not transactionally serialized.
- Generated explicit Proxy branches require at least one usable candidate and contain no provider or `DIRECT` fallback. Do not overstate browser fail-closed behavior while PAC application is non-mandatory or candidate text can be malformed.
- Never serialize valid own-proxy username/password fields into PAC. Auth challenges must be proxy challenges for an exact host/port, bounded by retry limits. Persist only redacted auth/health/migration events.
- Sanitize request URLs before state, notifications, or logs. Treat custom URL query strings as sensitive. Validate custom input URLs before fetch and revalidate the final URL after followed redirects before accepting a PAC body. Permission, redirect, provider fallback, and error-listener changes require security review.
- Automatic refresh may download/cook while disabled, but may reapply only after both persisted metadata and live Chromium control confirm the same active PAC.
- Migration remains an explicit audit and selected-field apply. It neither clears legacy storage nor invokes proxy application.

Run `test:pac` for routing changes; run `lint:mv3`, `test:mv3`, and `build:mv3` for any background change. Add browser QA for PAC parse/runtime fallback, real proxies/auth, external takeover, worker interruption, alarms, IndexedDB, or offscreen migration.
