# Firefox production provider dataset

The Firefox MV3 target packages one declarative Anticensority hostname baseline.
It contains no PAC program and no executable provider content. A clean install
verifies and stores the baseline plus its default routing configuration, then
remains `OFF` until the explicit Apply RPC is invoked.

## Pinned source and deterministic generation

The packaged snapshot was generated from:

- `anticensority/generated-pac-scripts`, branch `master`, commit
  `0448d748585ce0ed31434097d83b2b18236acbfb`;
- `anticensority.pac`, 11,642,139 bytes, SHA-256
  `47334452e4075e1be3e20dca842a9ee62f694ae5404dfc3c154b3de8215ba4f5`;
- `anticensority/pac-script-generator`, branch `golang`, commit
  `869aad85dce20ace9d44d3a9d694b6ac84baea6a`.

The source chain also references `zapret-info/z-i` commit
`9133e4327bbcf9adc1cba24360f50e50a6b4d11c`, SourceForge `zapret-info/code`
SVN revision `r47371`, `ValdikSS/antizapret` commit
`482d68035b3b8461bc404f64ad0c02b8e8b88d1b`, and the live Rublacklist registry
API described by the upstream generator. The generated PAC commit and exact PAC
hash are the reproducibility boundary because the historical API response is
not independently versioned.

Run the checked-in generator from the repository root with the immutable raw
GitHub URL, the two expected commits, and the expected PAC SHA-256. The tool
allows only HTTPS without credentials, bounds redirects and bytes, decodes
strict UTF-8, validates the known proxy policy, parses only the static `inputs`
JSON literal, and never evaluates PAC JavaScript. It rejects non-empty IP/CIDR
tables because `HOST_BUCKETS_V1` represents hostname suffix rules only.

The resulting packaged artifact has:

- dataset version `2025.11.11-0448d748`;
- 662,819 `PROVIDER_PROXY` rules in 80 fixed-width buckets;
- 11,642,895 exact artifact bytes;
- SHA-256
  `4a779826cf70ad5a524f4483bb6aa7a5f5bca19626b32ad8b2597f1a403c0795`.

Two generations from the same pinned PAC produce identical artifact and
envelope bytes. Its 80 fixed-width host strings are byte-for-byte identical to
the previously audited 11,639,379-byte experimental `HOSTNAMES` representation;
the production artifact is larger only because every bucket now carries the
strict `width` and `routeRef` schema fields. The generator can also produce the
updater's strict manifest
and, when given an explicitly selected disposable Ed25519 private key, its
detached signature. No private key, production update URL, or production public
key is committed. Remote updates remain disabled; the updater accepts trust
anchors only through its existing injected pinned-key interface.

## Routing policy

The default provider chain preserves the PAC order:

1. HTTPS `localhost:18611`
2. HTTP `localhost:18613`
3. SOCKS5 `localhost:18615`
4. SOCKS4 `localhost:18617`
5. generic PAC SOCKS `localhost:18619`, represented as SOCKS4
6. SOCKS5 Tor Browser `localhost:9150`
7. SOCKS5 local Tor `localhost:9050`

Firefox 154.0.1 wire-level tests showed that PAC `SOCKS` negotiates SOCKS4,
whereas Firefox `ProxyInfo` type `socks` negotiates SOCKS5 even with
`proxyDNS:false`. The production adapter therefore uses `SOCKS4` for the legacy
generic token.

Provider matches retain the complete ordered chain. Chromium's terminal Direct
fallback is intentionally stripped by the Firefox adapter, so exhaustion fails
closed. Provider misses and explicit Direct still use Firefox's true top-level
`null` Direct primitive. Onion routing uses the shared product order of local
Tor and then Tor Browser. Own-proxy and WARP groups remain part of the common
routing configuration schema but are disabled in this initial default config.

## Bootstrap and trust boundary

`PACKAGED_TRUSTED` is assigned only while reading the fixed extension-package
artifact. Exact bytes pass the common dataset verifier before the IndexedDB
packaged-baseline pointer is committed. Only after that commit does bootstrap
write the default product configuration and a small readiness marker. Existing
product configuration is never overwritten. Apply and durable recovery still
reverify the exact stored artifact before publishing `READY`.

The bootstrap performs no external request: its only reads use
`browser.runtime.getURL()` for fixed package paths. It does not set proxy
settings or activate routing. Remote update configuration remains disabled and
contains neither a URL nor a trust key.
