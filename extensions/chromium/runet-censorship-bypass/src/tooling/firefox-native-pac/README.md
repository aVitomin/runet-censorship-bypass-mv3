# Firefox native PAC feasibility gate

This test-only fixture answers whether Firefox can receive a dynamically
generated PAC through the public `proxy.settings` WebExtension API as a
`data:` URL and then route requests through Firefox's native PAC engine. It is
not a production Firefox extension or build target.

Run from the extension tooling root with an installed Firefox executable:

```powershell
$env:FIREFOX_BIN = 'C:\Program Files\Mozilla Firefox\firefox.exe'
npm run test:firefox:native-pac
```

The harness uses disposable profiles and local HTTP, HTTPS, SOCKS, and origin
fixtures. It tests private-access denial/grant, percent and base64 transport,
dynamic replacement, realistic PAC sizes, native helper functions, ownership,
Direct over a pre-existing manual proxy, candidate behavior, error handling,
event-page idleness, extension reload, and clear/restoration. It reports PAC
hashes and lengths, never PAC bodies or data URLs.

Temporary unsigned extensions do not provide valid signed-extension restart
evidence on Firefox Stable. Full browser-restart recovery therefore remains a
mandatory later test using the production Firefox package and signed XPI.

## Result recorded 2026-08-26

Firefox Stable 154.0.1 accepted and natively executed small percent-encoded
and base64 PAC data URLs. Observable local traffic proved dynamic replacement,
ordered HTTP proxy failover, HTTP/HTTPS/SOCKS/SOCKS5 routing, `DIRECT` over a
pre-existing manual proxy, ownership and clear/restoration, private-access
denial and grant, routing after a 35-second event-page idle period, and routing
after an extension reload with a new background boot ID.

The transport is not viable for the current provider PAC size:

| raw PAC | percent data URL | base64 data URL | Firefox result |
| ---: | ---: | ---: | --- |
| 607 bytes | 1,010 bytes | 872 bytes | Set and routed |
| 1,048,576 bytes | 1,405,731 bytes | 1,398,164 bytes | `set()` rejected |
| 8,388,608 bytes | 11,244,499 bytes | 11,184,872 bytes | `set()` rejected |
| 12,163,482 bytes (11.6 MiB) | 16,304,435 bytes | 16,218,036 bytes | `set()` rejected |
| 16,776,192 bytes | 22,487,429 bytes | 22,368,316 bytes | `set()` rejected |

For the deterministic provider-like fixture, the largest accepted raw sizes
were 781,312 bytes (percent, 1,047,485-byte URL) and 785,408 bytes (base64,
1,047,272-byte URL). The next 1 KiB cases were rejected. This observed boundary
is consistent with a roughly 1 MiB stored URL limit; it is not an API guarantee.

Firefox accepted invalid, missing-`FindProxyForURL`, and malformed-encoding PAC
URLs at the settings API boundary, then routed the observed request directly
without emitting `proxy.onError` to the fixture. A production design would need
to account for that native fail-open behavior independently of the transport
limit.

The resulting gate decision is `FIREFOX NATIVE PAC NOT FEASIBLE`. The command
therefore exits nonzero after writing its sanitized report. Firefox 128.0 was
downloaded from Mozilla and verified against Mozilla's SHA-512 list, but its
WebDriver BiDi implementation does not support `webExtension.install`; the same
automated fixture could not be installed there without adding different test
tooling. No Firefox 128 result is claimed.
