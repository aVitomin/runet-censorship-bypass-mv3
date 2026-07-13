# MV3 Legacy Migration Audit Notes

Phase 9A is audit-only. It reads legacy data, builds a sanitized plan, and
stores only a small summary in `mv3State.legacyMigration`.

Phase 10 keeps the same non-destructive migration model but maps safe PAC
kitchen settings into the richer MV3 `pacMods` schema used by the options UI
and PAC cooker.

## Legacy Sources

- `chrome.storage.local.antiCensorRu`
  - Source: `src/extension-common/37-sync-pac-script-with-pac-provider-api.tmpl.js`
  - Holds `_currentPacProviderKey`, `_pacUpdatePeriodInMinutes`,
    `lastPacUpdateStamp`, `_currentPacProviderLastModified`, `version`, and
    legacy provider metadata.
- `chrome.storage.local.ifConsentGiven`
  - Source: `37-sync-pac-script-with-pac-provider-api.tmpl.js`
  - MV2 consent page state. Phase 9A does not map it to MV3.
- `chrome.storage.local.firefox-only-pac-data`
  - Source: `src/extension-common/15-firefox-proxy-settings.js`
  - Firefox-only PAC text cache. It must not be copied into `mv3State`.
- extension localStorage key `pac-kitchen-mods`
  - Source: `src/extension-common/35-pac-kitchen-api.js`
  - Holds legacy PAC kitchen modifiers.
- extension localStorage key `pac-kitchen-if-incontinence`
  - Source: `35-pac-kitchen-api.js`
  - Legacy pending PAC recook flag. Phase 9A does not replay it.
- extension localStorage key `ip-to-host`
  - Source: `src/extension-full/20-ip-to-host-api.js`
  - Derived IP-to-host cache. It should be rebuilt, not migrated.
- extension localStorage key `handlers-if-on-pac-error`
- extension localStorage key `handlers-if-on-ext-error`
- extension localStorage key `handlers-if-on-no-control`
  - Source: `src/extension-common/11-error-handlers-api.js`
  - Legacy notification preferences.
- extension localStorage key `err-to-exc-if-coll`
  - Source: `src/extension-full/83-last-errors.js`
  - Debug collection UI state. Phase 9A does not migrate it.
- extension localStorage key `ui-proxy-string-raw`
  - Source: `src/extension-common/pages/options/src/components/ProxyEditor.js`
  - Proxy editor draft fallback. It is not authoritative.

## Proposed Mappings

- `antiCensorRu._currentPacProviderKey` -> `mv3State.currentPacProviderKey`
  if the key exists in the MV3 provider list.
- `antiCensorRu._pacUpdatePeriodInMinutes` ->
  `mv3State.pacUpdatePeriodInMinutes`.
- `antiCensorRu.lastPacUpdateStamp` -> `mv3State.lastPacUpdateStamp`.
- `pac-kitchen-mods.customProxyStringRaw` -> structured
  `mv3State.pacMods.ownProxies`; credentials are preserved only in MV3 state
  when the user explicitly applies PAC modifiers, and are redacted in plans.
- `pac-kitchen-mods.ifUseLocalTor` -> Tor Browser preset in
  `mv3State.pacMods.torBrowser`; if both Tor presets are present in old data,
  normalization deterministically keeps Tor Browser enabled.
- `pac-kitchen-mods.ifUseLocalWarp` -> `mv3State.pacMods.warp.enabled` with
  the legacy local WARP proxy candidates.
- `pac-kitchen-mods.whitelist` -> structured `mv3State.pacMods.whitelist`
  only when whitelist mode was enabled.
- `pac-kitchen-mods.exceptions` false entries -> DIRECT rules in
  `mv3State.pacMods.exceptions`.
- `pac-kitchen-mods.exceptions` true entries -> PROXY rules in
  `mv3State.pacMods.exceptions`; Phase 10 can route these through configured
  own/Tor/WARP proxy candidates.
- `pac-kitchen-mods.ifProxyOrDie` -> `mv3State.pacMods.noDirect`.
- `pac-kitchen-mods.ifUsePacScriptProxies` ->
  `mv3State.pacMods.usePacScriptProxies`.
- `pac-kitchen-mods.ifUseOwnProxiesOnlyForOwnSites` ->
  `mv3State.pacMods.ownProxiesOnlyForOwnSites`.
- `handlers-if-on-*` -> `mv3State.notificationPrefs`.

## Not Migrated

- PAC raw/cooked text and Firefox PAC text caches.
- Old provider metadata. MV3 uses static provider metadata.
- IP-to-host derived cache.
- Last network error buffers and error-to-exception UI state.
- Proxy editor drafts unless a later phase explicitly confirms fallback usage.
- Legacy PAC kitchen options without exact MV3 equivalents:
  `ifProxyHttpsUrlsOnly`, `ifUseSecureProxiesOnly`, `ifProhibitDns`,
  `ifProxyMoreDomains`, and `replaceDirectWith`.

## Phase 10 Parity Notes

- Restored now: local Tor daemon and Tor Browser presets, WARP/custom proxy
  candidates, own proxy rows with credential stripping in generated PAC, DIRECT
  replacement candidates, no-direct removal, whitelist allowlist behavior, and
  simple DIRECT/PROXY host rules.
- Intentionally not restored yet: DNS monkey-patching, HTTPS-only URL gating,
  secure-provider-proxy filtering, replacing DIRECT with an arbitrary raw PAC
  string, and full MV2 domain-weight edge cases beyond deterministic host
  pattern matching.
- Unsafe/unclear MV2 behavior not ported: runtime API monkey-patching and any
  execution of PAC text inside extension JavaScript.

## Phase 10.5 Stabilization Notes

- Schema 10 normalization accepts legacy simplified `useTor` and `useWarp`
  flags even when an older stored `pacMods` object also contains disabled
  structured defaults.
- Legacy string `ownProxies` values are normalized into structured proxy rows
  and credentials remain available only for MV3 proxy authentication.
- Migration apply updates selected MV3 settings only; users may need to cook
  PAC again and explicitly apply proxy settings afterward.
- Release-candidate scope keeps DNS monkey-patching, HTTPS-only URL gating,
  arbitrary raw `replaceDirectWith` PAC strings, blocking `webRequest`
  permission, DNR, and PAC runtime execution out of MV3.
