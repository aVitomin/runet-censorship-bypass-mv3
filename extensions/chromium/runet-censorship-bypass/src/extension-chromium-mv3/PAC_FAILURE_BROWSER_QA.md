# PAC failure and extension-bypass QA

This procedure checks whether a request covered by an explicit Proxy rule can
bypass the extension when PAC evaluation or every configured proxy fails. Run
every case in current Chrome and Brave on Windows. A no-leak result means the
request uses the authorized test proxy's distinct egress or fails; a response
using the baseline non-extension egress is an extension-bypass leak.

Clearing this extension's proxy settings restores Chromium's system proxy
behavior. The baseline may therefore be a system proxy or VPN egress, not the
computer's direct public IP. Do not call an observation a real-IP leak unless
the test network's direct ISP egress is independently known.

## Evidence boundary

### Proven by repository tests

`test:pac` executes the generated `FindProxyForURL` in Node and proves these
extension behaviors:

- exact-host Proxy rules return only the configured candidates, in configured
  order, without provider output or `DIRECT`;
- the explicit Proxy branch runs before empty, invalid, or throwing provider
  result paths;
- an empty provider result becomes `DIRECT` under the current safe defaults,
  an invalid result remains `INVALID`, and a provider runtime exception
  remains an exception in the generated function;
- a top-level initialization exception prevents the appended wrapper from
  installing, while syntactically invalid non-empty PAC text passes the
  extension's text checks and fails when parsed by the Node VM; and
- a WARP `proxyString` of `INVALID` currently reaches an explicit Proxy result.
  This is a candidate-validation gap, not a supported configuration.

`test:mv3` also proves that proxy application rejects blank PAC data but passes
non-empty PAC text to `chrome.proxy.settings.set` with `mandatory: false`. These
tests do not run Chromium's PAC resolver, make browser network requests, prove
DNS or egress behavior, or establish Chrome/Brave parity.

### Supported by upstream Chromium documentation and source

- Chrome documents that `PacScript.mandatory` defaults to false and that true
  prevents an invalid PAC from falling back to a direct connection.
- Chrome documents `chrome.proxy.onProxyError`: a fatal error aborts the
  transaction, while a non-fatal error uses a direct connection.
- Chromium documents ordered, stateful proxy-list fallback and caching of bad
  proxy candidates.
- Chromium's current proxy-resolution source sends non-mandatory PAC runtime
  errors to `DIRECT` and maps mandatory failures to
  `ERR_MANDATORY_PROXY_CONFIGURATION_FAILED`.

References:

- [Chrome `proxy.PacScript.mandatory` and `onProxyError`](https://developer.chrome.com/docs/extensions/reference/api/proxy)
- [Chromium proxy-list fallback](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md#Evaluating-proxy-lists-_proxy-fallback_)
- [Chromium PAC initialization and runtime failure handling](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/proxy_resolution/configured_proxy_resolution_service.cc)

### Still requires real Chrome and Brave

Upstream evidence does not prove the behavior of a particular Chrome or Brave
build with this generated PAC. Real-browser QA is required for PAC parse and
initialization failures, thrown exceptions, empty or malformed result lists,
exhausted candidate lists without `DIRECT`, actual DNS/egress behavior, NetLog
events, bad-proxy caching, and Chrome/Brave differences.

## Isolated Windows setup

Build the extension and launch each browser with a unique disposable profile:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm --prefix $Project run build:mv3
$Extension = (Resolve-Path "$Project\build\extension-chromium-mv3").Path
$Profile = Join-Path $env:TEMP ("rucb-pac-failure-" + [guid]::NewGuid().ToString('N'))
$Browser = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path -LiteralPath $Browser)) {
  throw "Set `$Browser to the installed Chrome executable."
}
Write-Host "Disposable profile: $Profile"
& $Browser --user-data-dir=$Profile --no-first-run --disable-sync
```

For Brave, start again with a new `$Profile` and set `$Browser` to its actual
executable, commonly
`$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe`. Record
`(Get-Item -LiteralPath $Browser).VersionInfo.ProductVersion` and the printed
profile path. Do not use a normal browser profile.

In the fresh profile, open `chrome://extensions`, enable Developer mode, choose
Load unpacked, and select `$Extension`. Verify that this is the only
user-installed extension. Loading it explicitly through the UI avoids relying
on command-line unpacked-extension behavior that may differ between branded
Chromium browsers.

Use only an authorized test proxy; do not route normal browsing or credentials
through a public proxy. Use a trusted HTTPS IP-echo URL and capture only this
isolated test traffic. NetLogs and profiles can contain URLs, IP addresses, and
other sensitive data: keep them outside the repository, do not enable raw-byte
capture, and do not commit or share them without review.

In the extension's full settings, choose Clear proxy settings and confirm that
the extension no longer controls a PAC. Visit the echo URL and record the
baseline non-extension egress. If this must measure the real public IP, first
use a controlled test network where system-proxy and VPN behavior is known; do
not disable protections on a normal browsing environment merely for this QA.

Confirm that the local ports used as unavailable candidates are closed. Choose
different ports if either command returns `True`:

```powershell
Test-NetConnection 127.0.0.1 -Port 9 -InformationLevel Quiet
Test-NetConnection 127.0.0.1 -Port 65000 -InformationLevel Quiet
```

To serve controlled provider PACs, run the following in a second PowerShell
window. It binds only to loopback:

```powershell
$env:PAC_BODY = 'function FindProxyForURL(url, host) { return "DIRECT"; }'
node -e 'require("http").createServer((q,r)=>{r.writeHead(200,{"Content-Type":"application/x-ns-proxy-autoconfig"});r.end(process.env.PAC_BODY||"")}).listen(8765,"127.0.0.1")'
```

In full settings, add and select a custom provider whose only PAC URL is
`http://127.0.0.1:8765/proxy.pac`. Under Local proxy presets, disable Tor, Tor
Browser, and WARP; add the required enabled own-proxy entries with no
credentials; and save. Add an exact-host Proxy rule for the echo hostname. Keep
`ownProxiesOnlyForOwnSites: true`, `replaceDirectWithProxy: false`, and
`noDirect: false` unless a case says otherwise. Choose Download PAC, Cook PAC,
and Apply proxy, then confirm that the extension controls a non-mandatory PAC.
The loopback server does not redirect. Redirect handling remains separate
security QA because custom-provider fetches follow redirects without currently
revalidating the final response URL.

After changing `$env:PAC_BODY`, stop the Node server with Ctrl+C, set the new
value in that same PowerShell window, restart the server, then repeat Download
PAC, Cook PAC, and Apply proxy. Start a fresh `chrome://net-export/` capture
immediately before the first navigation in each case.

## Cases

| Case | Setup | Chrome/Brave observation required |
| --- | --- | --- |
| One unavailable proxy | Valid provider PAC; one enabled own proxy, `HTTPS 127.0.0.1:9`, after confirming the port is closed | The exact-host navigation fails and never returns the baseline egress. |
| All candidates fail | Valid provider PAC; two confirmed-closed own-proxy endpoints in configured order | On the first navigation, NetLog shows the candidates attempted in order; navigation fails without baseline egress. |
| Provider returns empty | Set PAC body to `function FindProxyForURL(){return "";}`; retain the exact-host Proxy rule and closed candidate | The explicit host still resolves to the configured candidate and fails without baseline egress. |
| Provider returns invalid | Set PAC body to `function FindProxyForURL(){return "INVALID";}`; retain the exact-host Proxy rule and closed candidate | The explicit host still resolves to the configured candidate and fails without baseline egress. |
| Provider throws | Set PAC body to `function FindProxyForURL(){throw new Error("qa");}`; retain the exact-host Proxy rule and closed candidate | The explicit host short-circuits the provider and fails on its candidate. An Auto host is expected by upstream source to use non-mandatory direct fallback; record whether it returns the baseline egress. |
| PAC initialization throws | Set PAC body to `throw new Error("qa"); function FindProxyForURL(){return "DIRECT";}` | The wrapper cannot initialize. Upstream behavior predicts non-mandatory direct fallback; record whether the echo response uses the baseline egress. |
| PAC syntax error | Set PAC body to `function FindProxyForURL(){return "DIRECT";} )` | Upstream behavior predicts non-mandatory direct fallback; record whether the echo response uses the baseline egress. |
| Invalid explicit candidate | Disable every other candidate; enable WARP with `proxyString: "INVALID"`; retain the exact-host Proxy rule | Record whether Chromium rejects the request or silently uses baseline egress after discarding the malformed result. This is the known extension validation gap, not a supported configuration. |

For each case record browser name/version, extension version, PAC apply status,
effective proxy control, page result/error, observed egress IP, and relevant
NetLog proxy-resolution events. Bad-proxy state can change attempt order. Use
the first navigation from a fresh profile for strict ordering evidence, or use
new confirmed-closed endpoints and record the cached state. Do not infer a
route merely from a `webRequest` error: a successful direct fallback may not
produce a request error for the extension.

The current MV3 worker monitors `webRequest.onErrorOccurred` but does not
register `chrome.proxy.onProxyError`. Use the page result and NetLog rather than
assuming the extension UI reports PAC parse or runtime fallback.

## `mandatory: true` assessment

The current build hard-codes `mandatory: false`; this section describes a
future, separate experiment and is not executable through the current UI. Do
not modify this QA worktree merely to run it.

Upstream documentation and source indicate that `mandatory: true` prevents
direct fallback for invalid PAC and runtime resolver failures, including syntax
errors and thrown exceptions. It does not add extension-side validation, change
ordered candidate exhaustion, or establish how an accepted empty/malformed
return string becomes a proxy list. Keep those as real-browser cases.

The recovery cost is broad network failure for requests that require PAC
resolution while the PAC is broken. Remote automatic PAC refresh may also be
blocked by the same mandatory configuration, leaving a local Clear proxy action
as an important recovery path. Loopback provider fetches are a separate case.
Recovery can fail when the extension no longer controls proxy settings, its
service worker cannot respond, or policy/another extension takes control.
Before changing production, test an offline clear path, startup after a
persisted bad PAC, remote and loopback update recovery,
`chrome.proxy.onProxyError` fatal reporting, and external-control takeover.
