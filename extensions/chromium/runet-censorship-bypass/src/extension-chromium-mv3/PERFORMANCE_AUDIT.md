# Chromium MV3 performance audit

## Method

The primary evidence is deterministic operation counting in
`test/runtime-performance-harness.js`. It runs the real MV3 modules and service
worker with callback-compatible Chrome API, storage, alarm, tab, proxy, and
IndexedDB artifact fakes. The harness counts storage gets/sets/removes,
IndexedDB opens/reads/writes/transactions, RPCs, tab queries/gets, action calls,
PAC downloads/cooks/hashes, proxy reads/writes/clears, and alarm operations.

Counts below use a selected provider, a valid raw and cooked artifact, an
already-applied PAC, and one active HTTP tab. PAC refresh rows include the full
manual periodic-update RPC, scheduler bookkeeping, and final action refresh.
`G/S` means storage gets/sets; `IDB R/W` means IndexedDB reads/writes; `T/A`
means tab lookups/action API calls; `C/H` means PAC cooks/hash operations; and
`PR/PW` means proxy settings reads/writes. A dash means zero or unchanged.

## Baseline and result

| Scenario | Before | After | Result |
| --- | --- | --- | --- |
| Cold worker startup | G/S 3/2; T/A 1/4; H 1; PR 1; alarms get/create 1/1 | G/S 2/1; other counts unchanged | Avoided an unchanged periodic-state rewrite; live proxy state and action are still reconstructed. |
| Warm worker RPC | RPC 1; G/S 1/0 | unchanged | No module reinitialization or durable write. |
| Popup opening | RPC 1; tab query 1; G/S 1/0; H 1; A 0 | unchanged | Already optimal; opening the popup does not rewrite toolbar state. |
| Full settings opening | RPC 1; G/S 2/0; H 2; alarm gets 2 | RPC 1; G/S 1/0; H 1; alarm gets 2 | Reuses the initial state and staleness calculation inside `getState`. |
| Active-tab switch | G/S 1/0; T/A 1/4; H 1 | unchanged | Event driven, one state snapshot, no durable write. |
| Active-tab URL completion | G/S 1/0; T/A 0/1; H 1 | unchanged | Only the changed title is written. |
| Current site Auto to Proxy | RPC 1; G/S 5/2; T/A 1/3; H 2 | RPC 1; G/S 3/1; T/A 1/3; H 2 | PAC modifiers and health reset are one serialized state mutation. |
| Current site Proxy to Direct | RPC 1; G/S 5/2; T/A 1/1; H 2 | RPC 1; G/S 3/1; T/A 1/1; H 2 | Same batching; routing result is unchanged. |
| Current site Direct to Auto | RPC 1; G/S 5/2; T/A 1/3; H 2 | RPC 1; G/S 3/1; T/A 1/3; H 2 | Same batching; the override is removed normally. |
| PAC refresh, changed content | RPC 1; G/S 29/16; IDB R/W 2/2; C/H 1/9; PR/PW 4/1; tab gets 2 | RPC 1; G/S 25/13; IDB R/W 2/2; C/H 1/7; PR/PW 4/1; tab gets 1 | Complete download, cook, persistence, live-control checks, and apply remain. Writes are batched and the duplicate final action refresh is removed. |
| PAC refresh, identical HTTP 200 content | RPC 1; G/S 29/16; IDB R/W 2/2; C/H 1/9; PR/PW 4/1; tab gets 2 | RPC 1; G/S 18/7; IDB R/W 2/0; C/H 0/5; PR/PW 1/0; tab gets 1 | Existing raw and cooked artifacts are verified, no artifact is rewritten, no cook runs, and unchanged PAC is not reapplied. |
| PAC metadata/artifact clear | RPC 2; G/S 6/2; IDB R/W 0/2; T/A 2/6; H 1 | unchanged | Both durable artifacts and both metadata records are deliberately removed. |
| External proxy-control change | G/S 5/2; T/A 1/4; H 1; PR/PW 1/0 | unchanged | Live state is persisted, health is reset, and the active action is refreshed. |
| Worker restart with valid PAC | same as cold startup | G/S 2/1; IDB 0; T/A 1/4; H 1; PR 1 | Worker memory starts empty; durable state plus live Chrome proxy state reconstruct the presentation without reading PAC bodies. |

The changed-PAC baseline is the original branch behavior measured with the same
harness before production edits. The full-RPC baseline adds the unchanged
periodic scheduler and action-refresh bookkeeping to the directly measured
original core-pipeline count (18 gets, 12 sets, two artifact reads, two artifact
writes, one cook, seven hashes, four proxy reads, and one proxy write).

## Confirmed bottlenecks and changes

- `getState` loaded state again through periodic status and computed cooked-PAC
  staleness twice. It now supplies the loaded snapshot to periodic status and
  shares one staleness result with the proxy summary.
- PAC download success stored cache, status, and timestamp through three
  separate whole-state writes. They now use one queued patch. Cooked cache and
  cook success use one queued patch as well.
- Site-rule mutations wrote PAC modifiers, reset health, and reloaded state as
  separate operations. `savePacMods` keeps validation and the serialized queue
  while committing both fields once and returning the committed snapshot.
- A 200 response whose body hash matched the cached raw PAC still overwrote the
  content-addressed raw artifact, recooked and overwrote the cooked artifact,
  and automatically reapplied the same PAC. The pipeline now verifies the raw
  body and cooked artifact metadata before taking an unchanged fast path.
- Manual periodic refresh requested the same final action refresh twice. The
  RPC now relies on the refresh already performed by the periodic operation.
- Startup alarm reconciliation rewrote an already-correct `scheduled` state.
  It now skips only when both status and next-run timestamp are unchanged.

## Intentionally unchanged

- Startup still performs one live `chrome.proxy.settings.get`, persists its
  fresh `checkedAt` result, queries the active tab, and writes the initial four
  action presentation fields. Those are required after service-worker restart.
- Identical refresh still downloads and hashes the response, verifies both
  durable artifacts with two IndexedDB reads, updates successful-download and
  periodic timestamps, and checks live proxy control before deciding not to
  reapply. This avoids trusting stale memory or metadata.
- Changed automatic apply retains all repeated live-control and staleness checks
  at the security boundary. It still uses `mandatory: false`.
- Popup and settings pages keep one authoritative initialization RPC. Settings
  mutations still request a fresh complete snapshot after the mutation because
  alarm, proxy, and periodic metadata may change concurrently.
- Action status retains its bounded worker-memory presentation cache and stale
  request tokens. No PAC, routing, or storage state is cached across restarts.
- No wall-clock pass/fail benchmark was added; browser process scheduling would
  make it less deterministic than the operation counters.

## Investigated without a confirmed bottleneck

- The artifact module already retains one IndexedDB open promise per worker;
  it does not reopen the database for every transaction. PAC bodies are not read
  during startup, popup opening, settings opening, or action refresh.
- Popup initialization already performs one active-tab query, one background
  RPC, one state read, and no action write. Full settings already performs one
  page-level RPC and registers handlers only on newly rendered DOM nodes.
- Provider fallback attempts remain sequential because URL order and validation
  are routing/security behavior. No download validation or fallback was changed.
- The state queue intentionally rereads durable storage for each mutation. No
  broad or restart-persistent state cache was introduced.
- Changed PAC application still performs repeated live-control validation. The
  checks straddle artifact loading and `chrome.proxy.settings.set`, so removing
  them was not justified by the operation counts.
- Service-worker module parsing, bundled PSL parsing, DOM layout/paint, and
  Chromium PAC installation cost need browser tracing; Node counters cannot
  establish a production bottleneck in those areas.

## Remaining real-browser measurements

In both Brave and Chrome, use the unpacked MV3 build and record three or more
DevTools Performance/Service Worker runs for cold startup, popup first paint,
full settings first paint, tab-switch and navigation bursts, changed and
identical PAC refresh, external proxy takeover, and worker termination/restart.
Report medians after one warm-up run. Also verify alarm timing, IndexedDB
artifact recovery after forced worker termination, real proxy authentication,
PAC parse/runtime fallback, DNS/direct-leak behavior, and that identical refresh
does not emit a second `chrome.proxy.settings.set` in the extension activity log.
