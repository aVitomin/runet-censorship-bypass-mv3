# Chromium MV3 architecture and code-quality audit

Audit date: 2026-07-17

Audited revision: `f8f4735881154fd11d9f29ae0d4a70d355e60ccc`

Audit branch: `audit/mv3-code-quality`

## Executive conclusion

The implementation is generally well structured for a security-sensitive MV3
proxy extension. Its larger modules mostly reflect real coordination, routing,
persistence, migration, and browser-lifecycle responsibilities rather than
accidental abstraction debt. The recent public-suffix, action refresh,
Action-API error handling, serialized storage, PAC-reuse, batching, and
periodic-update work is justified and should not be reversed or reorganized
merely to reduce file size.

The final recommendation is **make one or more small targeted changes**. Four
problems have deterministic evidence and are worth fixing without a broad
refactor:

1. Structured own-proxy credentials cross the runtime RPC boundary.
2. Some read/derive/write operations remain outside the state queue and can
   lose concurrent updates.
3. PAC response timeout and size enforcement do not cover body consumption.
4. PAC application does not revalidate state after its asynchronous artifact
   read, so it can install an artifact made stale by a concurrent settings
   change.

No normal-use CPU or latency bottleneck was confirmed. Old content-addressed
PAC artifacts do grow without a retention policy, but destructive cleanup
should be deferred until a safe retention/recovery policy and real-browser
quota evidence exist.

## 1. Current architecture summary

### Runtime shape

`background/service-worker.js` synchronously imports the background modules,
constructs the toolbar refresh coordinator, registers Chrome listeners, and
starts two restart-recovery tasks: alarm reconciliation and live proxy/action
reconstruction. All other substantive work is on demand.

| Module | Actual responsibility and primary callers | Chrome APIs / durable storage / timing | Assessment |
| --- | --- | --- | --- |
| `background/service-worker.js` | RPC dispatch, provider mutations, popup pipelines, PAC orchestration, proxy apply/clear, health, auth-event persistence, and lifecycle listeners. Called by extension pages and Chrome events. | `runtime`, `action`, `tabs`, `alarms`, `proxy`, `notifications`, `webRequest`, `fetch`; delegates to `chrome.storage.local` and IndexedDB. Listener registration and recovery start at import; operations otherwise run on demand. | Necessarily complex. It is the behavior coordinator and is testable through the runtime harness. Splitting by line count would move coupling rather than reduce it. The confirmed mutation and apply races should be fixed locally. |
| `background/state.js` | Owns schema defaults, normalization, redaction helpers, inline-artifact migration, serialized reads/writes, bounded diagnostic events, and field wrappers. Used by almost every background path. | `chrome.storage.local` through `storage.js`; IndexedDB only during inline PAC migration. Initialization is inert except for an in-memory promise queue. | Centralization is appropriate. The queue correctly protects individual reads/writes, but it lacks a queue-owned read/derive/write primitive. |
| `background/pac-download.js` | Sequential provider fallback, source/final URL validation, HTTP metadata, textual PAC validation, size checking, and hashing. Called by manual and periodic pipelines. | `fetch`, `AbortController`, Web Crypto through `hash.js`; no direct persistence. Entirely on demand. | Sequential fallback and redirect revalidation are intentional security behavior. Body streaming is the one confirmed gap. |
| `background/pac-cook.js` | Normalizes modifiers, validates raw/cooked size, generates the wrapper, enforces routing precedence, strips credentials from candidates, and hashes modifier/output semantics. Called by the service worker and PAC tests. | Web Crypto through `hash.js`; no Chrome API or storage. On demand. | Routing-sensitive complexity is justified. It should remain a cohesive unit. |
| `background/pac-artifacts.js` | Content-addressed raw/cooked PAC storage and retrieval. Called by state migration and PAC download/cook/apply/clear paths. | IndexedDB `mv3PacArtifacts`; one cached open promise per worker. Lazy on first artifact access. | Correctly keeps PAC bodies out of normal state and startup/UI reads. It needs a future retention policy, not a storage rewrite. |
| `background/periodic-update.js` | Alarm reconciliation, due/retry calculation, in-worker run coalescing, durable run status, and bounded history. Called at worker startup, alarm delivery, settings RPCs, and manual refresh. | `chrome.alarms`, `mv3State`; no PAC body access. On demand except reconciliation requested by the service worker. | Restart-aware complexity is justified. Current unchanged-state write suppression is appropriate. |
| `background/action-status.js` | Derives icon/badge/title, consumes Action API errors, coalesces refreshes, rejects stale completions, tracks the active tab/window, and bounds presentation cache entries. | `action`, `tabs`, `windows`, `notifications`; worker-memory cache only. Coordinator listeners start at service-worker import. | Implemented well. The cache is bounded and disposable across restarts; persisting it would be wrong. |
| `background/site-scope.js` | Canonical host/rule normalization and public-suffix/private-suffix-aware site scope. Called by popup state/mutations, health paths, and tests. | Bundled `tldts`; no Chrome API or storage. On demand after library import. | The PSL dependency and legacy-wildcard handling solve demonstrated correctness problems. Simplifying to a label heuristic would regress behavior. |
| `background/proxy-auth.js` | Builds exact host/port credential maps, supplies credentials only for proxy challenges, bounds retries, and produces redacted summaries/events. Called by `onAuthRequired` and status RPC construction. | `webRequest` details supplied by the service worker; attempts live only in a TTL-cleaned worker-memory map. Credentials originate in local state. | Auth-specific parsing is justified. The auth path itself redacts events correctly; the separate general RPC state response does not. |
| `background/proxy-settings.js` | Summarizes live control, checks `runtime.lastError`, rechecks controllability immediately before set/clear, and applies non-mandatory inline PAC. | `chrome.proxy.settings`; no durable storage. On demand. | The repeated live reads are security checks, not an optimization target. |
| `pages/popup/index.js` | Queries the active tab once, loads one authoritative popup model, renders with DOM/text APIs, and sends compound apply operations. | `tabs.query` and internal runtime RPC. Runs only while the popup is open. | Appropriately small and page-local. Clear and health actions use a follow-up model RPC, but the path is user-driven and not a demonstrated bottleneck. |
| `pages/options/index.js` | Renders the complete settings/diagnostic/migration UI and wires mutation RPCs followed by authoritative refreshes. | Internal runtime RPC only; no durable storage. Runs only in the options tab. | Large but cohesive around one page model. Full rerender cost needs browser evidence before any component split. It uses safe `textContent`/DOM construction rather than HTML injection sinks. |
| `background/legacy-migration-*.js` and `offscreen/migration-audit.js` | Audit legacy storage, build redacted plans, and explicitly apply selected supported fields. | `chrome.storage.local`, offscreen document/localStorage, runtime messaging, and `mv3State`. Only user-triggered. | Intentionally isolated, field-limited, non-destructive, and high risk. The final commit needs an atomic state precondition, but migration should not otherwise be reorganized. |

### Durable versus worker-memory state

- `mv3State` is the normalized durable control plane.
- Raw and cooked PAC bodies are IndexedDB artifacts referenced by metadata.
- Chrome's live proxy state is re-read rather than inferred from persisted
  metadata.
- Alarms reconstruct periodic behavior after restart.
- PAC-operation promises, the periodic lock, auth attempts, toolbar request
  tokens/caches, and error debounce entries are intentionally worker memory.
- The service worker registers all important listeners synchronously before its
  asynchronous recovery work.

### Security and routing boundaries verified

- The manifest has the existing proxy/alarm/storage/notification/offscreen/
  webRequest/active-tab permissions and existing `<all_urls>` host access. The
  current branch does not expand either. `<all_urls>` supports arbitrary proxy
  authentication and proxy-error observation.
- No production MV3 code uses `eval`, `Function`, dynamic script injection, or
  an HTML injection sink. Downloaded PAC remains text until passed to Chromium.
- Custom sources accept HTTPS and loopback HTTP, reject URL credentials, and
  revalidate a followed response URL before accepting its body.
- Auth challenges must be proxy challenges for an exact configured host/port;
  retry count is bounded; auth events and status summaries omit passwords.
- An explicit Proxy rule is rejected without a usable candidate. With
  candidates, it contains neither provider fallback nor `DIRECT`.
- `mandatory: false` remains the actual Chromium policy. Therefore generated
  explicit branches are strict, but browser-level behavior is not described as
  fully fail-closed.

### Compact PAC regression matrix

This is current behavior, not a proposal.

| Scope / mode | Candidates and policy | Expected result |
| --- | --- | --- |
| Plain `host.example` | Any | Matches that host only. |
| `*.example` | Any | Matches the base host and subdomains. |
| Auto | Four safe defaults | Preserves the provider's exact result; provider proxies stay enabled, own candidates remain own-site-only, Direct replacement is off, and `noDirect` is off. |
| Explicit Proxy | Zero usable candidates | Cooking is rejected with `PROXY_RULE_NO_CANDIDATE`. |
| Explicit Proxy | One candidate | Returns only that candidate. |
| Explicit Proxy | Multiple candidates | Preserves configured own proxies, local Tor, Tor Browser, then WARP entries; contains no `DIRECT` or provider fallback. |
| Explicit Direct and Proxy conflict | Any | Explicit Direct wins. |
| Whitelist miss | Any | Returns `DIRECT` after explicit Direct/Proxy checks and before onion/provider policy. |
| `.onion` | Enabled local Tor/Tor Browser | Uses eligible onion candidates after explicit/whitelist handling. |
| Auto with `noDirect` | Provider result | Removes `DIRECT`; an empty/malformed result remains browser QA because application is non-mandatory. |
| Direct replacement | Explicit opt-in | Replaces provider `DIRECT` entries only and preserves provider proxy candidate order. |

The 26-case PAC suite evaluates `FindProxyForURL` results for these branches; it
does not merely inspect generated strings.

## 2. Current performance baseline

### Method and notation

`test/runtime-performance-harness.js` runs the real background modules and
service worker in a fresh VM with deterministic Chrome/storage/IndexedDB fakes.
The audit reran all harness assertions and also printed nonzero counters for the
required scenarios.

`G/S` = storage gets/sets; `IO/R/W/TX` = IndexedDB opens/reads/writes/
transactions; `TQ/TG/A` = tab queries/tab gets/Action API calls; `D/C/H` = PAC
downloads/cooks/hashes; `PR/PW` = proxy reads/writes; `AG/AC/AX` = alarm
gets/creates/clears. Counts are operations, not milliseconds.

| Scenario | Current deterministic operation count | Assessment |
| --- | --- | --- |
| Service-worker import/startup | G/S 2/1; TQ/TG/A 1/0/4; D/C/H 0/0/1; PR/PW 1/0; AG/AC/AX 1/1/0; IDB 0 | Required live proxy reconstruction, one persisted fresh control snapshot, active-tab reconstruction, and alarm repair. |
| Popup opening | Page: TQ 1 and RPC 1. Background: G/S 1/0; H 1; Action/IDB/proxy/alarm 0 | Already bounded. PAC bodies are not loaded. |
| Full settings opening | RPC 1; G/S 1/0; H 1; AG 2; Action/IDB/proxy/tab 0 | Reuses one state snapshot and one staleness hash. Two alarm reads expose authoritative scheduler status. |
| Active-tab activation | G/S 1/0; TG/A 1/4; H 1; durable writes 0 | Event-driven and bounded. Four calls initialize the new tab's presentation. |
| Active-tab URL completion | G/S 1/0; A 1; H 1; TQ/TG 0; durable writes 0 | Only the changed presentation field is written. Background-tab updates are ignored. |
| Site mode Auto -> Proxy | RPC 1; G/S 3/1; TG/A 1/3; H 2 | PAC mods plus health reset are one state write. |
| Site mode Proxy -> Direct | RPC 1; G/S 3/1; TG/A 1/1; H 2 | Same batching; cached unchanged action fields are skipped. |
| Site mode Direct -> Auto | RPC 1; G/S 3/1; TG/A 1/3; H 2 | Same batching. |
| Changed PAC refresh | RPC 1; G/S 25/13; IO/R/W/TX 1/2/2/4; TG 1; D/C/H 1/1/7; PR/PW 4/1; AG/AC/AX 1/1/1 | Full download, cook, durable status, artifact, live-control, apply, scheduler, and action pipeline. No individual count is a demonstrated normal-use bottleneck. |
| Identical HTTP 200 PAC refresh | RPC 1; G/S 18/7; IO/R/W/TX 1/2/0/2; TG 1; D/C/H 1/0/5; PR/PW 1/0; AG/AC/AX 1/1/1 | Correct fast path: verifies both artifacts, does not rewrite, recook, or reapply. Remaining writes are durable attempt/success/scheduler history. |
| Worker restart with valid artifacts | Same as service-worker import/startup; IDB 0 | A fresh worker reconstructs from state plus live Chrome control without loading PAC bodies. |
| Missing cooked-artifact recovery during refresh | G/S 8/4; IO/R/W/TX 1/3/1/4; D/C/H 1/1/4; proxy writes 0 | Verifies the missing cooked object, reads durable raw PAC, rebuilds one cooked artifact, and does not apply when `applyIfSafe` is false. |

An actual browser `runtime.onStartup` event delivered after top-level import adds
G/S 2/0, TG 1, H 1, and AG/AC 1/1 in the fake. The Action cache suppresses
duplicate presentation writes. This once-per-browser-session duplication is not
large enough to justify changing the always-required top-level wake recovery.

### Performance conclusions

- The recent reuse/batching changes are real improvements. Identical PAC
  refresh avoids two artifact writes, cooking, two hashes, three proxy reads,
  and the proxy write compared with the changed path.
- Startup, popup, settings, and active-tab work is bounded and does not touch
  PAC artifacts.
- The changed refresh's repeated proxy reads straddle security boundaries,
  including an immediate check inside `applyPacScript`; removing them is not
  justified.
- A full settings DOM render, bundled PSL parse cost, service-worker parse time,
  Chromium PAC installation, and page paint cannot be judged by Node operation
  counters. No wall-clock claim is made.

## 3. Confirmed problems

### P1. Structured proxy credentials cross runtime RPC

- **Classification:** confirmed security issue.
- **Locations:** `background/state.js:447-477`,
  `background/service-worker.js:257-278`,
  `background/service-worker.js:289-308`,
  `background/service-worker.js:776-788`,
  `pages/options/index.js:168-173`, and
  `pages/options/index.js:2398-2417`.
- **Evidence:** `sanitizeRpcValue` removes PAC bodies and credential-bearing URL
  authority, but it does not recognize structured `username` or `password`
  properties. `getState`, `getPacMods`, and several mutation results include
  `state.pacMods`. The options page receives the real structures, displays the
  username, and substitutes `***` for the password only while constructing the
  input.
- **Deterministic reproduction:** sanitizing a nested own-proxy object returned
  `structuredUsernameCrossesRpc: true` and
  `structuredPasswordCrossesRpc: true`. The probe printed booleans only.
- **Impact:** the password exists in extension-page RPC memory and the actual
  username is rendered. This violates the repository credential boundary even
  though the page is internal and the password input itself shows a placeholder.
- **Likelihood:** certain whenever full settings or a raw PAC-mods RPC is used
  with configured credentials.
- **Benefit of change:** restores the intended least-exposure boundary and
  makes every RPC response safe by construction.
- **Regression risk:** medium. A naive outbound redaction would cause a later
  save to replace the real stored password with the placeholder. Preservation
  must happen in the background against the current queued state, including
  username/password edits, clearing, reordering, and duplicate endpoints.
- **Browser QA:** create, edit, preserve, change, and clear credentials; reopen
  settings; save unrelated PAC fields; authenticate through a real proxy; check
  DevTools/runtime responses and diagnostics for absence of clear credentials.
- **Recommendation:** **fix now** with background-owned placeholder merge and
  outbound structured redaction. Do not move authentication secrets out of
  local state or place them in cooked PAC.

### P2. Read/derive/write state operations can still lose updates

- **Classification:** confirmed race/lifecycle issue.
- **Locations:** queue implementation at `background/state.js:1202-1331`;
  auth event append at `background/state.js:1626-1654`; periodic event append at
  `background/state.js:1717-1729`; popup PAC-mod derivation at
  `background/service-worker.js:1094-1127`; custom-provider array derivation at
  `background/service-worker.js:126-208`; migration commit at
  `background/legacy-migration-apply.js:298-330`.
- **Evidence:** each individual `loadState` and `saveStatePatch` is queued, but a
  caller that awaits `loadState`, derives a replacement for the same field, and
  later enqueues a write does not hold the queue between those steps. Two callers
  can therefore read the same base value and the second replacement wins.
- **Deterministic reproductions:** two concurrent `recordProxyAuthEvent` calls
  submitted two provided events but retained one event and a provided count of
  one. Two concurrent popup changes for different hosts submitted two rules but
  retained only the second rule.
- **Impact:** concurrent proxy challenges can undercount/drop diagnostic
  events; concurrent popup/settings operations can silently discard a site
  rule; custom-provider and fill-missing migration decisions have the same
  structural risk.
- **Likelihood:** proxy-auth event concurrency is realistic during parallel
  requests. Two settings surfaces are less common but supported by multiple
  browser windows/options tabs. Migration overlap is rare.
- **Benefit of change:** prevents user-visible lost settings and makes the
  serialization guarantee match its documented scope.
- **Regression risk:** medium-high because PAC mods, provider selection,
  histories, health reset, and migration conflict behavior are state-sensitive.
  The queue itself should remain; the minimum useful addition is a queue-owned
  atomic transformer that rereads, derives, normalizes, and writes once.
- **Browser QA:** simultaneous popups in separate windows, popup plus options,
  parallel authenticated requests, periodic completion while settings change,
  and migration while another options tab mutates state; terminate/restart the
  worker after committed operations.
- **Recommendation:** **fix now**, narrowly migrating known derived same-field
  operations. Do not introduce a restart-persistent in-memory state cache.

### P3. PAC body timeout and size limit do not cover body consumption

- **Classification:** confirmed security issue and resource-bounding defect.
- **Locations:** `background/pac-download.js:65-84` and
  `background/pac-download.js:213-258`.
- **Evidence:** `fetchWithTimeout` clears its abort timer as soon as `fetch`
  resolves, which normally occurs after response headers. `response.text()` is
  called later, after the timer is gone. If `Content-Length` is absent or false,
  the 16 MiB limit is checked only after the complete body has been buffered.
- **Deterministic reproduction:** an instrumented response reported
  `bodyReadAfterTimeoutCleared: true` while the download still succeeded.
- **Impact:** an untrusted or compromised PAC endpoint can stream slowly without
  the intended 30-second bound or make the worker buffer substantially more
  than the advertised maximum before rejection. The main risk is extension
  worker memory/availability, not extension-side code execution.
- **Likelihood:** low for healthy built-in providers, plausible for a custom
  provider or a compromised endpoint.
- **Benefit of change:** enforces the documented time/size boundary during the
  actual untrusted-data transfer.
- **Regression risk:** medium. Streaming UTF-8 decoding, abort behavior, 304
  handling, data URLs, redirects, and fallback order must remain correct.
- **Browser QA:** loopback server cases for slow headers, slow body, missing or
  false `Content-Length`, exactly-at-limit and over-limit multi-byte bodies,
  abort, redirect rejection, fallback, and service-worker termination.
- **Recommendation:** **fix now** with a bounded streamed reader and one abort
  lifetime covering fetch plus body, retaining a carefully bounded fallback if
  a response body stream is unavailable.

### P4. A concurrent settings change can make an artifact stale during apply

- **Classification:** confirmed race/lifecycle and routing-correctness issue.
- **Locations:** `background/service-worker.js:2674-2780`, especially the
  staleness decision at `2704-2719`, state/control writes at `2721-2753`,
  artifact read at `2755-2766`, and proxy set at `2767-2769`.
- **Evidence:** the provider/raw/modifier consistency check happens before
  several awaits and the IndexedDB artifact read. No state snapshot is reread
  after the artifact resolves. `proxy-settings.js` rechecks live Chrome control
  just before set, but it cannot detect a changed `mv3State` PAC configuration.
- **Deterministic reproduction:** the harness blocked the cooked-artifact read,
  changed PAC modifiers, then released the read. The operation reported
  `applied`, performed one proxy write, and the final modifier hash differed
  from the applied artifact metadata.
- **Impact:** the UI can save a new Direct/Proxy/candidate policy while an older
  cooked PAC is installed afterward. State subsequently reports the cache as
  stale, but traffic uses the old policy until another cook/apply.
- **Likelihood:** low but realistic when periodic/manual apply overlaps a
  settings action or two settings surfaces operate concurrently.
- **Benefit of change:** ensures only an artifact current at the point of apply
  crosses the Chromium proxy boundary.
- **Regression risk:** high because this is the apply boundary. The guard must
  compare provider, raw hash, cooked hash, modifier hash, and artifact identity
  without weakening external-takeover checks. A stale result should abort, not
  silently force or recook under the wrong operation.
- **Browser QA:** block/delay IndexedDB reads while changing site mode,
  provider, candidates, and cache; test external takeover in the same window;
  verify no stale `chrome.proxy.settings.set` occurs and UI status recovers.
- **Recommendation:** **fix now** with a final state-generation/hash precondition
  after artifact validation and immediately before `applyPacScript`.

### P5. Superseded content-addressed artifacts have no retention policy

- **Classification:** meaningful maintainability/storage-growth problem; not a
  confirmed latency bottleneck.
- **Locations:** hash-derived keys at `background/pac-artifacts.js:23-25`, puts
  at `180-212` and `272-304`, changed-refresh puts at
  `background/service-worker.js:2963-2975` and `3215-3227`, and current-only
  manual deletes at `background/service-worker.js:2608-2654`.
- **Evidence:** every new raw hash and cooked hash creates a distinct record.
  Successful replacement updates metadata but never deletes a superseded
  record. The changed-refresh baseline performs two artifact writes and zero
  deletes. Clearing cache deletes only the currently referenced hash. Repository
  search found no production caller that enumerates/prunes old records.
- **Reproducible scenario:** run changed-content refreshes with distinct PAC
  hashes. Each success adds one raw and one cooked content-addressed record; only
  the newest pair is referenced by `mv3State`.
- **Impact:** IndexedDB usage grows with provider changes and modifier recooks;
  quota pressure or confusing leftover sensitive custom-source data is possible
  over long installations.
- **Likelihood:** high that hashes change over time; unknown time-to-impact
  because real PAC sizes/change frequency/quota usage were not measured here.
- **Benefit of change:** bounded storage and predictable cleanup.
- **Regression risk:** high. Premature deletion can break restart recovery,
  inline migration, a concurrent apply/read, or rollback/diagnosis.
- **Browser QA:** inventory records/quota over repeated refreshes; interrupt
  before and after metadata commit; restart; custom-provider disable/delete;
  manual clear; IndexedDB failure; current-artifact recovery.
- **Recommendation:** **defer** production cleanup. First define whether to keep
  current plus previous, make pruning post-commit and race-safe, and collect
  browser storage evidence. The problem is real, but deleting now is not worth
  the recovery risk.

### P6. Tests miss the four confirmed boundaries

- **Classification:** test weakness.
- **Locations:** `test/module-invariants.js:122-177`,
  `test/state-write-serialization.js:90-313`,
  `test/pac-download-security.js:1-497`, and
  `test/runtime-performance.js:100-356`.
- **Evidence:** RPC sanitation tests cover PAC bodies and credentials embedded
  in URL authority, not structured credential fields. State tests cover queued
  patches to different fields, not concurrent read/derive/write of the same
  field. Download tests do not exercise a slow/oversized streamed body. Runtime
  tests exercise stale cooking but not state changes during apply.
- **Impact:** all 98 MV3 tests pass while the deterministic probes above still
  reproduce the problems.
- **Likelihood:** certain until the missing boundary cases are added; the test
  suite currently cannot detect regressions or fixes at those boundaries.
- **Benefit of change:** makes each targeted production fix reproducible and
  prevents the same failure mode from returning without relying on brittle
  source-shape assertions.
- **Regression risk:** low for the tests themselves. Fake streams, blocked
  IndexedDB reads, and concurrency barriers must be deterministic rather than
  timing-based.
- **Browser QA:** the automated cases reduce risk but cannot replace the real-
  browser credential, streaming, IndexedDB, and overlapping-operation scenarios
  listed for P1-P4.
- **Recommendation:** add boundary tests with each targeted fix. Do not replace
  the observable PAC matrix or the operation-count suite with implementation-
  only tests.

## 4. Investigated concerns that were not confirmed

- **Large service worker and settings files:** responsibilities are broad but
  related. No defect was attributable to line count, and moving functions would
  not reduce Chrome/state/PAC coupling.
- **Startup cost:** one live proxy read/write snapshot, one state read for the
  action, one active-tab query, one hash, and alarm reconciliation are required
  after arbitrary worker wake. No PAC body or IndexedDB transaction occurs.
- **PSL import/parse cost:** Node counters cannot measure Chromium startup parse
  time. The library solves public/private suffix correctness, so no change is
  justified without browser traces showing a material regression.
- **Repeated active-tab queries:** popup performs one page query. Background
  startup performs one query; later active-tab changes use event IDs/`tabs.get`.
  Background-tab URL updates do not trigger work.
- **Duplicate settings/popup RPCs:** initialization is one authoritative RPC.
  Some user actions fetch a complete model afterward because proxy, alarm,
  health, and periodic state can change concurrently. These rare extra reads are
  not a realistic performance target.
- **Repeated model normalization/construction:** popup and options construct
  small normalized models on user demand. No measured hot loop or excessive
  durable/API operation resulted.
- **Identical refresh counts:** the path still downloads/hashes, verifies two
  artifacts, persists success history, and checks live control. Those operations
  protect against stale memory, missing artifacts, and external takeover.
- **Changed refresh proxy reads:** checks occur before automatic apply, inside
  apply orchestration, immediately inside `applyPacScript`, and after set. They
  are intentionally placed around asynchronous trust boundaries.
- **Provider fallback parallelism:** sequential order is observable provider and
  security behavior. Parallel fetch would waste bandwidth and complicate final-
  URL validation/cancellation.
- **Action cache growth/staleness:** the cache is per Action API, capped at 256
  tab entries, cleared on tab removal/replacement, guarded by stale-request
  tokens, and discarded on worker restart.
- **Listener duplication:** the coordinator has a `started` guard and a service
  worker instance registers listeners once. Fresh workers necessarily register
  fresh listeners.
- **Unhandled Chrome callback errors on core paths:** storage, proxy settings,
  Action API calls, tab resolution, notifications, PAC operations, and listener
  fire-and-forget promises either consume `runtime.lastError` or catch
  rejections. `openOptionsPage` and notification-clear calls could be made more
  defensive, but no user-visible failure was demonstrated and they are not core
  routing paths.
- **IndexedDB repeated opens:** `pac-artifacts.js` caches one open promise per
  worker. A rejected/closed connection is retried only after worker restart; this
  is a low-frequency recovery limitation, not a confirmed normal-use issue.
- **Worker restart assumptions:** the tested valid-artifact restart reads no PAC
  body and reconstructs from durable state/live proxy state. Forced interruption
  during a transaction, alarm delivery, or auth challenge still requires real
  Chromium QA.
- **Malformed PAC/candidate behavior:** the extension deliberately does not
  execute or fully parse downloaded PAC. Empty/malformed browser results and
  non-mandatory fallback remain explicit browser-QA gaps, not refactoring
  opportunities.

## 5. Areas already implemented well and not worth changing

- State writes reread durable storage and serialize individual operations; the
  recent fix correctly prevents unrelated whole-state patches from clobbering
  each other.
- Site scope uses the public suffix list with private domains and handles legacy
  unsafe two-label wildcards without reintroducing them.
- The toolbar coordinator handles tab/window lifecycle, burst coalescing, stale
  completion, bounded caching, restart reconstruction, and Action API failures.
- Action failure handling caches only successfully applied presentation fields,
  allowing a failed icon update to retry without repeating successful calls.
- Raw/cooked PAC bodies live in IndexedDB, not routine state/RPC summaries.
- Identical-PAC reuse verifies both durable artifacts and metadata before
  skipping cook/apply; it does not trust only a hash in memory.
- Download fallback order and source/final URL validation are explicit and
  tested.
- PAC hashes include a cooking-semantics version so a routing safety change
  invalidates older cooked artifacts.
- Popup site-mode/candidate changes batch PAC modifiers and health reset into
  one durable write and one action refresh.
- `getState` reuses its initial snapshot and staleness hash across periodic and
  proxy summaries.
- Periodic scheduling avoids rewriting unchanged status/next-run values and
  does not enable proxy control merely because a refresh succeeds.
- Popup/options render stored values with DOM/text APIs. Custom source URLs are
  sanitized for diagnostics, and auth diagnostic summaries are redacted.
- PAC tests assert evaluated routing behavior, including exact/wildcard scope,
  safe defaults, candidate order, conflicting precedence, Direct policy, and
  missing candidates.

## 6. High-risk areas that should remain untouched

- **Candidate order and Direct/Proxy precedence:** configuration order and the
  explicit Direct -> explicit Proxy -> whitelist -> onion -> provider sequence
  are routing behavior. Generic list helpers or sorting would be dangerous.
- **Provider PAC preservation:** Auto must preserve provider results under safe
  defaults. Do not prepend candidates or synthesize Direct except under the
  explicit existing policies.
- **Public-suffix scope:** do not replace `tldts` with last-two-label logic or
  split scope calculation across UI/background implementations.
- **Redirect validation:** source and final URL checks must remain separate and
  fallback must remain sequential. Query-bearing custom URLs must not enter
  logs/reports.
- **Serialized state operations:** keep the queue and durable reread. Add an
  atomic transformer for demonstrated races; do not introduce a broad state
  snapshot cache that becomes stale across worker restarts.
- **Artifact validation and identical reuse:** retain raw content comparison,
  cooked provider/raw/modifier/hash checks, and recovery on missing artifacts.
- **External takeover checks:** do not remove live `chrome.proxy.settings.get`
  calls merely to lower counters.
- **Credentials/authentication:** keep credentials only in local state and the
  exact host/port auth path. Fix RPC exposure without serializing credentials
  into PAC, events, errors, or diagnostics.
- **Migration:** remain audit-first, selected-field-only, idempotent,
  non-destructive, and free of proxy-apply side effects. Do not implicitly map
  migrated `pacUpdatePeriodInMinutes` onto the active scheduler interval.
- **Worker recovery:** do not depend on action caches, locks, or debounce maps
  surviving suspension.
- **`mandatory: false`:** changing this is a product/routing policy decision,
  not a code-quality refactor. It requires dedicated browser leak/fallback QA.

## 7. Refactoring and targeted-change candidates ranked by benefit/risk

| Rank | Candidate | Concrete problem and practical benefit | Smaller change / behavior at risk / tests | Decision |
| --- | --- | --- | --- | --- |
| 1 | Redact structured credentials at RPC and preserve placeholders in background | Removes certain secret exposure on every full-settings load while retaining auth functionality. | Use a credential-aware background PAC-mod save rather than redesigning storage/auth. Risk: editing, clearing, reordering, duplicate endpoints. Tests: nested RPC redaction, unchanged placeholder preservation, explicit change/clear, PAC credential stripping, auth exact match. | Fix now. |
| 2 | Revalidate state immediately before PAC apply | Prevents an observed stale artifact from crossing the proxy boundary. | Add a final provider/raw/cooked/modifier/artifact precondition; retain all live-control reads. Tests: blocked artifact read plus modifier/provider/cache changes, external takeover, changed/identical performance counts, PAC suite. | Fix now. |
| 3 | Bound PAC body streaming with one timeout lifetime | Makes the advertised 16 MiB/30-second boundary real for untrusted bodies. | Isolate a streamed UTF-8 reader in `pac-download.js`; do not alter provider fallback. Tests: stream limits/timeouts/redirect/fallback/data URL. | Fix now. |
| 4 | Add queue-owned atomic state transformer and migrate derived writers | Prevents observed lost rules/events and stale migration/provider decisions. | Add one small state primitive and migrate only demonstrated read/derive/write sites. Risk: normalization, event order, health reset, migration conflicts. Tests: concurrent same-field operations, write failure/recovery, restart, performance counts. | Fix now, after the credential boundary so its merge semantics are reused. |
| 5 | PAC artifact retention/pruning | Bounds confirmed record growth. | No safe deletion-only patch is yet established. Risk includes deleting the only recoverable artifact during an interrupted metadata transition. Tests require real IndexedDB interruption/restart/quota cases. | Defer pending policy and browser evidence. |
| 6 | Split service worker/options into smaller files | Main benefit would be line distribution; no measured coupling, correctness, testability, or performance problem is solved. Import order and synchronous listeners would gain risk. | Moving functions is not a smaller behavioral improvement. | Reject. |

### Recommended change 1

- **Proposed branch:** `security/mv3-rpc-credential-redaction`
- **Exact goal:** ensure no valid structured own-proxy username/password appears
  in runtime RPC results; preserve an unchanged redacted placeholder by merging
  edits against the current queued local state in the background.
- **Files affected:** `background/state.js`, `background/service-worker.js`,
  `pages/options/index.js` only if the client contract must be simplified,
  `test/module-invariants.js`, and a focused state/RPC test.
- **Expected benefit:** restores a documented secret boundary on a certain path.
- **Expected production diff:** approximately 60-140 lines.
- **Risk:** medium.
- **Tests:** `lint:mv3`, `test:mv3`, `test:pac`, credential redaction/preservation,
  PAC-without-credentials, auth exact host/port, migration redaction, MV3 build.
- **Browser QA:** real credential create/edit/preserve/clear/auth plus DevTools RPC
  and diagnostic inspection.
- **Why now:** exposure occurs on every credential-bearing full-settings load and
  has a clear bounded fix.

### Recommended change 2

- **Proposed branch:** `fix/mv3-pac-apply-freshness`
- **Exact goal:** abort apply if provider, raw PAC, cooked PAC, modifier hash, or
  artifact identity changed while the artifact was being loaded.
- **Files affected:** `background/service-worker.js`,
  `test/runtime-performance-harness.js`, `test/runtime-performance.js`, and a
  focused lifecycle test if kept separate.
- **Expected benefit:** prevents an older routing policy from overwriting a
  concurrently saved policy.
- **Expected production diff:** approximately 40-80 lines.
- **Risk:** high but localized to a high-risk boundary.
- **Tests:** `test:pac`, `test:mv3`, `lint:mv3`, changed/identical counts,
  blocked-read stale cases, external takeover, MV3 build.
- **Browser QA:** delayed IndexedDB plus settings/provider/candidate changes,
  proxy activity log, takeover, worker interruption.
- **Why now:** a deterministic race performs a real proxy write with stale
  modifier metadata.

### Recommended change 3

- **Proposed branch:** `security/mv3-bounded-pac-download`
- **Exact goal:** keep the abort timer active through body consumption and stop
  reading once decoded/received bytes exceed the PAC limit.
- **Files affected:** `background/pac-download.js` and
  `test/pac-download-security.js`.
- **Expected benefit:** bounds worker time and memory for untrusted PAC bodies.
- **Expected production diff:** approximately 60-120 lines.
- **Risk:** medium.
- **Tests:** all redirect/fallback tests plus streamed slow/large/multi-byte/data
  URL/304/abort cases; `test:pac`, `test:mv3`, `lint:mv3`, MV3 build.
- **Browser QA:** controlled loopback HTTP server and worker termination during
  body read.
- **Why now:** current timeout/limit demonstrably does not cover the resource it
  claims to bound.

### Recommended change 4

- **Proposed branch:** `fix/mv3-atomic-derived-state`
- **Exact goal:** add one queue-owned read/derive/normalize/write primitive and
  use it for auth/periodic event append, popup site mutations, custom-provider
  registry mutations, and migration commit preconditions.
- **Files affected:** `background/state.js`, `background/service-worker.js`,
  `background/legacy-migration-apply.js`, `test/state-write-serialization.js`,
  and targeted runtime/migration tests.
- **Expected benefit:** prevents silent lost settings and diagnostic events.
- **Expected production diff:** approximately 120-240 lines.
- **Risk:** medium-high.
- **Tests:** concurrent same-field/different-field operations, write failures,
  queue continuation, PAC-mod normalization/health batching, custom-provider
  collisions, auth events, periodic events, migration conflicts/idempotence,
  runtime operation counts, `test:pac`, `test:mv3`, `lint:mv3`, MV3 build.
- **Browser QA:** multiple settings surfaces, parallel auth requests, periodic
  completion overlap, migration overlap, worker restart after commit.
- **Why now:** two independent deterministic reproductions lose one of two
  valid operations; this is the remaining gap in the recent serialization work.

## 8. Candidates rejected as unnecessary

- Splitting `service-worker.js` or `options/index.js` solely for size.
- Converting modules to classes or dependency-injection layers used by one
  caller.
- Caching the complete normalized state or PAC model across worker wakes.
- Persisting action presentation state.
- Parallelizing provider fallback downloads.
- Removing live proxy-control reads from changed/identical apply decisions.
- Skipping durable success/history writes on identical refresh.
- Combining popup and options renderers or their small DOM helper functions.
- Replacing full settings refresh after mutations with optimistic local state
  without a demonstrated page performance problem.
- Removing public-suffix support to reduce import/parse work.
- Abstracting superficially similar proxy parsing in PAC normalization, auth,
  migration, and the credential editor. Those copies have different acceptance
  and redaction semantics.
- Removing exact operation-count assertions. They are intentionally coupled to
  API/storage work and complement observable behavior tests; update them only
  when a reviewed behavior-preserving count change is intended.
- Optimizing the extra once-per-browser-session `onStartup` reconciliation.
- Deleting currently unreferenced artifact helpers
  (`getLatestRawPacArtifact`, `getLatestCookedPacArtifact`, and
  `clearPacArtifacts`). Full-tree search found no caller outside their export,
  but they have no runtime cost and may support the retention/recovery design.
- Deleting placeholder-page RPC support: generated MV3 consent/debug/
  exceptions/troubleshoot HTML files reference the shared placeholder script.
- Refactoring MV2 code that looks parallel to MV3. Gulp deliberately separates
  the runtimes, and this audit found no MV3 runtime import of legacy background
  code.

## 9. Testing quality and browser gaps

### Strengths

- PAC regression evaluates observable routing results and preserves the current
  matrix, including provider behavior and malformed-result characterization.
- Action tests cover active/background tabs, stale completions, event bursts,
  successor tabs, focus, icon failure retry, listener count, and cache bound.
- State tests cover different-field concurrency, queue order, failed writes,
  continuation, reset ordering, and fresh-worker reload.
- Download tests cover source/final URL validation, redirect downgrade,
  credential rejection, fallback order, data PAC, and sanitized errors.
- Runtime counters execute real production modules/service-worker logic rather
  than a reimplementation.

### Limitations

- Exact operation counts are intentionally sensitive to API/storage work; they
  should not be used as evidence of wall-clock speed.
- Popup/options initialization tests stop after the first request. They prove
  call counts, not full DOM construction, locale loading, layout, or paint.
- A “worker restart” is a fresh VM seeded with representative durable data. It
  does not interrupt and resume the same real IndexedDB transaction/alarm/auth
  request.
- Chrome fakes do not establish PAC parse/runtime fallback, real proxy failover,
  DNS/direct leaks, `mandatory: false` behavior, extension activity-log writes,
  browser quota, or service-worker suspension timing.
- The four confirmed gaps need dedicated tests described with their proposed
  branches.

Real-browser QA should use unpacked MV3 builds in Chrome and Brave, at least
three measured runs after warm-up for startup, popup first paint, full settings
first paint, tab/navigation bursts, changed/identical refresh, and restart. It
must separately exercise auth, external takeover, slow/oversized custom PAC,
IndexedDB interruption/recovery, stale apply, alarm recovery, PAC parse/runtime
failure, and DNS/direct-leak behavior.

## 10. Recommended next action

Do not perform a broad architecture refactor. Create the four targeted branches
above, preferably in this order:

1. RPC credential redaction/preservation.
2. PAC apply freshness guard.
3. Bounded PAC body streaming.
4. Atomic derived state mutations.

Each branch should stay independently reviewable and preserve the PAC routing
matrix. After those fixes and their browser QA, collect real IndexedDB inventory
and quota data before deciding whether artifact pruning is worth its recovery
risk. Apart from these evidence-backed boundaries, leave the current
implementation unchanged.
