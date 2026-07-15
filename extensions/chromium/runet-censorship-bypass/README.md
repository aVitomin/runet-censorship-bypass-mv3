# Runet Censorship Bypass

This repository is a fork and Chromium Manifest V3 migration of
[anticensority/runet-censorship-bypass](https://github.com/anticensority/runet-censorship-bypass).
The original project and its copyright remain with the upstream authors.

Current Chromium release-candidate version: `0.0.2.00`.

MV3 migration: `@aVitomin with Codex`.

## Build the Chromium extension

Install the pinned dependencies and build the MV3 extension:

```text
npm ci
npm run build:mv3
```

The unpacked extension is written to:

```text
build/extension-chromium-mv3
```

The legacy MV2 sanity build remains available:

```text
node ./node_modules/gulp/bin/gulp.js buildAll
```

The version source in `src/templates-data.js` is shared, so the current MV2
build outputs also use version `0.0.2.00`.

## Load in Brave or Chrome

1. Open `brave://extensions` or `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Select `build/extension-chromium-mv3`.

The toolbar popup is the daily-use interface. Full settings contain proxy
configuration, advanced PAC rules, diagnostics, and explicit legacy migration.

## Package a release candidate

From PowerShell:

```powershell
New-Item -ItemType Directory -Force .\dist | Out-Null
Compress-Archive -Path .\build\extension-chromium-mv3\* `
  -DestinationPath .\dist\runet-censorship-bypass-mv3-rc.zip -Force
Get-FileHash .\dist\runet-censorship-bypass-mv3-rc.zip -Algorithm SHA256
```

Generated `build/`, `dist/`, temporary browser profiles, and dependency folders
are intentionally not committed.

## What works

- PAC provider selection, manual updates, cooking, and IndexedDB artifact storage.
- Built-in and user-defined PAC providers with editable custom URL fallback lists.
- Current-site Auto, Proxy, and Direct modes with exact-host or domain/subdomain scope.
- Explicit proxy apply and clear.
- Local Tor service, Tor Browser, WARP/custom proxy, and structured own proxies.
- Proxy authentication for configured own proxies.
- Automatic refresh of the selected PAC provider every 12 hours.
- Proxy connectivity status, manual routed checks, and a red `E` toolbar badge
  for browser-reported proxy failures.
- English and Russian UI with an in-app language selector.
- Explicit, non-destructive legacy MV2 migration under Maintenance.

## Custom PAC providers

Open **Full settings** and find **PAC providers**. Built-in providers are
read-only. Under **Add custom provider**, enter a name and one or more PAC URLs,
one per line. Custom providers can be selected in both full settings and the
toolbar popup, and can be edited, disabled, or deleted later.

Custom PAC URLs must use HTTPS. `http://localhost` and `http://127.0.0.1` are
also accepted for local testing. The extension downloads, validates, stores,
cooks, and applies custom PAC through the same pipeline used for built-in
providers. New PAC bodies remain in IndexedDB artifacts and are not stored
inline in `mv3State` or executed by extension JavaScript. If migration of an
older inline PAC body to IndexedDB fails, the legacy value is retained for a
later retry but omitted from RPC and diagnostic results.

Only add PAC URLs from sources you trust. A PAC file controls browser proxy
routing when you explicitly cook and apply it.

## Routing behavior

- **Auto** removes the current-site override and follows the selected PAC provider;
  with safe defaults, non-empty provider Proxy results are preserved unchanged.
- Provider `DIRECT` results remain `DIRECT` by default.
- Enabling Tor, WARP, or an own proxy only makes it available to explicit Proxy
  rules by default; it does not proxy every site.
- **Proxy** routes a matching user rule through enabled proxy candidates.
- **Direct** forces a matching user rule to bypass the proxy.
- Broad own-proxy use, DIRECT replacement, and no-DIRECT behavior are advanced,
  explicit opt-ins; Proxy and Direct rules override provider behavior.

The safe defaults are:

```text
usePacScriptProxies: true
ownProxiesOnlyForOwnSites: true
replaceDirectWithProxy: false
noDirect: false
```

## Automatic updates and proxy health

The selected PAC provider is checked by an hourly browser alarm and refreshed
when 12 hours have elapsed since its last successful update. The extension
downloads, validates, stores, and cooks the refreshed PAC automatically. If the
extension already controls an applied PAC, the new cooked PAC is reapplied. If
proxy settings are cleared or in system mode, the cache is refreshed without
turning proxying on.

For an explicit **Proxy** site rule, the popup can run a lightweight request to
that site's origin. Any HTTP response establishes browser connectivity; a
generic request failure is reported as inconclusive. Chromium's proxy-specific
request errors are the authoritative failure signal and produce a localized
message, a rate-limited notification, and a red `E` toolbar badge.

Browser extensions cannot directly raw-TCP probe Tor ports. Tor checks therefore
use routed browser requests and Chromium proxy errors. A local Tor service or
Tor Browser must already be running.

## Security and privacy

- New raw and cooked PAC text is stored as IndexedDB artifacts, not inline in
  `mv3State`. A legacy inline value is retained only when non-destructive
  artifact migration fails, and RPC responses still omit the PAC body.
- Extension JavaScript does not execute downloaded PAC text.
- Proxy credentials are stripped from generated PAC and redacted in UI, events,
  logs, and migration summaries. Credentials retained in MV3 settings are used only
  for proxy authentication.
- Legacy migration does not delete old MV2 data or apply proxy settings automatically.
- Custom provider URLs remain editable in full settings, but PAC diagnostics
  hide custom source URLs. Built-in diagnostic URLs omit credentials, queries,
  and fragments. PAC bodies remain in IndexedDB artifact storage.
- Proxy-health state stores only sanitized hostnames/origins, proxy error codes,
  and credential-free candidate summaries.
- The broad `<all_urls>` host permission supports proxy authentication challenges;
  provider-specific hosts support PAC downloads.

## Known limitations

- External authenticated proxy and HTTPS CONNECT QA is pending.
- Real Tor traffic requires a running local Tor service or an open Tor Browser and
  still needs environment-specific QA.
- DNS monkey-patching and arbitrary raw `replaceDirectWith` PAC strings are not
  restored for safety.
- Full weighted MV2 exception edge cases have only partial parity.
- The MV3 extension does not request blocking `webRequest`, does not use a DNR
  replacement for PAC routing, and does not execute PAC text in extension JavaScript.

See [the MV3 RC notes](src/extension-chromium-mv3/RELEASE_CANDIDATE_NOTES.md)
and [legacy migration notes](src/extension-chromium-mv3/background/legacy-migration-notes.md)
for detailed scope and upgrade behavior. Legacy MV2 reviewer notes remain in
`src/extension-common/FOR_REVIEWERS.md`.
