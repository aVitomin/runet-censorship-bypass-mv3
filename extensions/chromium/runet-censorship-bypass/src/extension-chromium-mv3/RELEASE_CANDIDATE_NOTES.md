# MV3 Release Candidate Notes

MV3 migration: @aVitomin with Codex

## Working in MV3

- PAC download from the static MV3 provider list.
- PAC cooking with deterministic Phase 10 modifiers.
- Explicit proxy apply and clear through `chrome.proxy.settings`.
- Proxy authentication for configured structured own proxies.
- Automatic PAC refresh every 12 hours through an hourly browser-alarm
  watchdog, with bounded 15/30/60/120/180-minute retries.
- Automatic refresh downloads and cooks while proxy settings are cleared, but
  reapplies only when this extension already controls an applied PAC.
- IndexedDB storage for new raw and cooked PAC artifacts. Legacy inline PAC is
  retained only when non-destructive artifact migration fails, then retried;
  PAC bodies and previews are omitted from RPC and diagnostic results.
- Local Tor daemon and Tor Browser proxy presets.
- Structured own proxies with credential stripping in generated PAC.
- WARP/custom local proxy candidates.
- Whitelist plus DIRECT/PROXY exception rules.
- DIRECT replacement with configured proxy candidates.
- No-direct behavior that removes DIRECT fallbacks.
- Compact toolbar popup is the daily-use MV3 control panel.
- Toolbar popup supports PAC provider selection and one-click PAC update.
- Toolbar popup provides current-site modes: Proxy, Auto/PAC decides, and
  Direct.
- Toolbar popup provides quick Local Tor, Tor Browser, WARP/custom proxy, and
  configured own proxy toggles.
- Toolbar popup Apply changes saves the quick settings, downloads PAC when
  needed, cooks PAC, and applies proxy settings from one explicit user action.
- Toolbar icon badge and title now summarize proxy/site/PAC status.
- Toolbar popup supports current-host rules and domain/subdomain rules for the
  current site.
- The default current-site rule scope is domain/subdomains, while exact-host
  scope remains available.
- Toolbar popup has a Clear proxy action for quickly returning browser proxy
  mode to system settings without deleting PAC caches or rules.
- Local Tor daemon and Tor Browser presets are mutually exclusive in the popup,
  full settings, and PAC modifier normalization.
- MV2-like PAC proxy switches are restored: provider PAC proxies can be
  enabled/disabled, and own proxies can be limited to user-created site rules.
- Auto/PAC decides removes the current-site custom rule and follows the
  selected PAC provider. Enabling Tor, WARP, or own proxies does not proxy
  every site by default.
- Tor, WARP, and own proxies are used for explicit Proxy site rules by
  default. Broad own-proxy prepending and DIRECT replacement remain advanced
  opt-in behavior.
- Toolbar popup help text was shortened and moved mostly to concise labels and
  tooltips.
- User-facing extension name, popup, options page, and toolbar title no longer
  include MV3 branding; MV3 wording is kept for technical notes and credits.
- Version is `0.0.2.00`.
- A UI language selector was added: Auto/browser language, Russian, or English.
- English/Russian localization now covers the popup and normal user-facing
  settings. Deep debug/raw technical diagnostics may still appear in English.
- MV2 migration is kept available under Maintenance and is collapsed by
  default so fresh installs do not see upgrade-only controls in daily use.
- Minimal active notifications are shown for key PAC/proxy failures when the
  corresponding notification preference allows them.
- Full settings remain available from the popup and the Chromium extension
  options entry.
- Options page uses a simplified default layout with quick actions first.
- Site rules can be added from the main options page without editing JSON.
- Advanced and debug controls are collapsed by default.
- Explicit, non-destructive legacy MV2 migration audit/apply for safe fields.
- Custom PAC provider management in full settings: add, edit, enable/disable,
  delete, and select trusted HTTPS or localhost test PAC URLs.
- Enabled custom providers appear in the popup selector and use the same
  download, IndexedDB artifact, cooking, apply, and periodic-update pipeline as
  built-in providers.
- Built-in providers remain read-only. Deleting or disabling the selected custom
  provider clears the selection without deleting cached PAC artifacts or rules.
- PAC diagnostics hide custom-provider source URLs and remove credentials,
  queries, and fragments from built-in source URLs. Full custom URLs are
  rendered only by the full-settings provider management controls.
- Proxy-specific Chromium request failures update localized proxy-health state,
  show a rate-limited notification, and take badge precedence as a red `E`.
- Explicit Proxy rules support an active origin request from the popup or full
  settings. Any HTTP response counts as connectivity; failures without a
  Chromium proxy error remain inconclusive.

## Default Routing Semantics

- `usePacScriptProxies` defaults to `true`.
- `ownProxiesOnlyForOwnSites` defaults to `true`.
- `replaceDirectWithProxy` defaults to `false`.
- `noDirect` defaults to `false`.
- Auto mode removes exact-host and derived wildcard overrides for the current
  site, then follows the selected provider PAC.
- A provider `DIRECT` result remains `DIRECT` by default even when Tor, WARP,
  or own proxies are enabled.
- Explicit Proxy rules use enabled user proxy candidates; explicit Direct rules
  return `DIRECT`.
- Generated explicit Proxy branches contain enabled user candidates only: their
  PAC result has no `DIRECT` or provider-PAC fallback, and applying a Proxy rule
  without an enabled candidate is rejected. This generated-result invariant is
  not universal browser fail-closed behavior: PAC is applied with
  `mandatory: false`, and PAC failure or an empty/malformed result may fall back
  to a direct connection.
- Cooked artifacts from builds before the explicit-Proxy safety fix are marked
  stale automatically and must be recooked; the cached raw PAC is retained.
- Clear proxy returns Chromium to system proxy settings without deleting PAC
  artifacts, provider selection, site rules, or legacy data.

## Known Limitations

- External authenticated proxy and HTTPS CONNECT QA is still pending.
- Real Tor traffic requires Tor to be installed and running locally; environment
  QA is still required when Tor is unavailable.
- Browser extensions cannot raw-TCP probe Tor ports or prove the PAC route used
  by an arbitrary request. Health checks rely on explicit site rules, routed
  browser requests, and Chromium proxy-specific errors.
- Remaining MV2 PAC kitchen gaps are listed in the collapsed About/Limitations
  section instead of normal quick-start warnings.
- Not restored for safety: DNS monkey-patching / DNS leak PAC overrides and
  arbitrary raw `replaceDirectWith` PAC strings.
- Custom PAC input URLs require HTTPS (with loopback HTTP allowed), but a final
  URL reached through redirects is not revalidated.
- Not restored for RC scope: secure-provider-proxy filtering.
- Partial parity: full weighted exception edge cases.
- MV3 does not use the blocking `webRequest` permission.
- MV3 does not add a Declarative Net Request replacement for PAC behavior.
- Extension JavaScript does not execute PAC text at runtime.
- Old MV2 storage is not deleted by MV3 audit or migration apply.

## Upgrade Notes

- Legacy migration is explicit and non-destructive.
- Old MV2 storage keys are not deleted by audit or apply.
- Users may need to cook PAC again and explicitly apply proxy settings after
  migration.
- Passwords are preserved only where required for proxy authentication and are
  redacted in the UI, events, logs, generated PAC, and migration summaries.
