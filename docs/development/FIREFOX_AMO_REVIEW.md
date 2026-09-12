# Firefox AMO reviewer notes

## Purpose and permissions

Runet Censorship Bypass routes user-selected and locally classified requests
through configured censorship-bypass proxies. A clean installation stays OFF;
proxy control changes only after the user presses **Enable**, and **Disable**
releases the extension-owned setting and restores Firefox's underlying proxy
configuration.

- `proxy` is required to install and exact-match release the global fail-closed
  proxy floor and to return per-request Firefox `ProxyInfo` routes.
- `webRequest` and `webRequestBlocking` implement the synchronous request-ID
  authorization guard and the bounded proxy-authentication challenge handler.
- `<all_urls>` is required because the guard and proxy decision must cover every
  normal and private-window network request while protection is active. A
  narrower host set would create an unguarded routing gap.
- `storage` keeps strict product configuration, durable OFF/ON recovery
  metadata, credential records and exact local dataset pointers.
- `incognito: "spanning"` and explicit private-window access are required by
  the fail-closed architecture. Activation is refused when private access is
  denied; revocation leaves the global floor blocking private traffic until
  the user clears protection.

The extension contains no content scripts and injects no code into web pages.
Its CSP permits only extension-local scripts and forbids objects.
The popup reads the active tab only to derive a normalized HTTP(S) hostname;
the background site RPC never returns the full URL, path or query.

## Data collection declaration

Firefox's built-in data collection declaration is:

```json
{
  "required": ["authenticationInfo", "browsingActivity"]
}
```

`none` would not accurately describe a proxy product. When protection is
enabled, the selected proxy necessarily receives the destination host (and an
HTTP proxy may receive the request target), which is browsing activity. When a
user configures an authenticated proxy, the username/password are sent only to
that exact request-authorized proxy challenger. These transmissions are the
primary routing function and are enabled only by the user's Apply action.

The extension sends no analytics, telemetry, crash reports, advertising IDs,
search feed, remote configuration or background update requests. Routing
configuration, dataset lookups and durable metadata stay local. Passwords stay
in `browser.storage.local`, are loaded only into an in-memory synchronous
resolver for a verified active session, and never appear in UI reads, logs,
RPC results, errors, diagnostics, dataset metadata or routing descriptors.

This declaration follows Mozilla's current built-in consent taxonomy and the
policy definition of data transmitted outside the add-on or local browser:

- <https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/>
- <https://extensionworkshop.com/documentation/publish/add-on-policies/>

## Code and data trust boundary

There is no remote executable code. The packaged provider input is a local
declarative `HOST_BUCKETS_V1` JSON-compatible `.data` artifact. The data suffix
keeps Mozilla's source-code scanner from treating the 11.6 MiB immutable table
as JavaScript/JSON source; it does not change or obscure the content. Its exact
bytes, size, SHA-256, rule count and strict schema are verified before index
construction. Provider PAC/JavaScript is not packaged or evaluated.

The only vendored parser used by the Firefox background is the same pinned
`tldts` dependency already present in the maintained lockfile. Its minified UMD
build and upstream license are both packaged solely to derive the exact
public-suffix-aware domain scope shown by the current-site popup; it performs no
network access and does not participate in provider data execution.

An authenticated-update implementation is present for future use, but the
production package contains no update URL, public key, alarm, startup fetch or
RPC that invokes it. It cannot perform a production network update in this
release candidate.

## Fail-closed model

Activation first verifies the exact local dataset and immutable routing
snapshot, then installs a canonical random-loopback SOCKS5 floor, confirms
exact `controlled_by_this_extension` ownership, commits durable ON and only
then publishes the READY session. During initialization, failures, control
loss and private-access loss, protected requests do not become Direct.

The floor uses a cryptographically random port in `49152-65535` on `127.0.0.1`
with `proxyDNS: true`. Assurance identifier
`RANDOM_LOOPBACK_UNVERIFIED_V1` explicitly records the residual: WebExtension
APIs cannot reserve or prove the port unoccupied, and a local SOCKS service on
that exact endpoint can defeat the floor. Malicious local software is outside
the product threat model; no native helper is used.

Firefox top-level `null` is used only for an intentionally authorized Direct
decision. Proxy chains end with a Firefox fallback terminator and a callback
budget equal only to validated proxy candidates. Chromium's terminal Direct
fallback is intentionally stripped on Firefox: successful proxy/failover
behavior is preserved, while exhaustion fails closed.

## Reproduce and test

Build instructions and archive layout are in
[`FIREFOX_RELEASE_BUILD.md`](FIREFOX_RELEASE_BUILD.md). The short path is:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm ci --prefix $Project
npm --prefix $Project run verify:firefox
npm --prefix $Project run release:firefox
```

Basic functional review in Firefox 154.0.1:

1. Temporarily install the generated unsigned XPI and grant private-window
   access. Confirm popup state is OFF and existing manual proxy behavior is
   unchanged.
2. Open Settings, save an explicit Direct rule and an explicit Proxy rule, and
   optionally add clearly disposable proxy credentials.
3. Press Enable. Confirm the popup reports ACTIVE only after READY; exercise an
   explicit Direct request, an explicit Proxy request and a provider match.
4. Close the event page long enough for genuine recreation and confirm the
   popup reports RECOVERED and routing/authentication still use the exact
   durable dataset/configuration.
5. Press Disable and confirm the prior Firefox proxy configuration is restored.
6. Revoke private access or transfer proxy control while active. Confirm the
   runtime withdraws the session, stays fail-closed and can be safely cleared.

All reviewer tests should use disposable local origins/proxies and synthetic
credentials. No real credential is required for review.
