# MV3 RPC credential browser QA

Use an unpacked MV3 build and a dedicated test proxy account. Never record the
test password in screenshots, logs, issue text, or this checklist.

## Automated Chrome Stable 407 coverage

After `build:mv3`, the repository browser smoke uses installed Google Chrome
Stable and local dynamic loopback infrastructure only:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
$env:CHROME_BIN = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm --prefix $Project run test:browser:mv3
```

The smoke configures own-proxy credentials through production RPC and proves
from the actual HTTP proxy receivers:

- an unauthenticated request, real Basic `407` challenge, expected authenticated
  retry, deterministic success, and no direct-origin hit;
- a different, previously unused proxy and credential after a full Chrome
  restart with the same disposable profile;
- an origin `401` receives neither `Authorization` nor `Proxy-Authorization`,
  while RUCB records the non-proxy challenge as ignored;
- mismatched host/port and passwordless proxy challengers receive no credential
  from another configured endpoint and do not fall back to the origin;
- wrong credentials produce bounded retries, the current `retry_limit` status,
  no successful response, and no direct-origin hit; and
- canary passwords and reusable Basic tokens remain absent from applied PAC,
  RPC responses, popup/options DOM and password inputs, auth diagnostics,
  extension console output, receiver logs, and test-visible errors.

Receiver evidence stores only safe classifications such as `none`, `expected`,
`known-wrong`, or `unexpected`; it never records a raw password or authorization
header. Usernames remain intentionally editable in the options/RPC model and
are not treated as password leaks.

This automated case covers plain HTTP requests through an HTTP proxy. HTTPS
destination `CONNECT` and TLS-to-proxy (`HTTPS` PAC scheme) remain separate
follow-up coverage. The retry counter is worker memory: a full browser restart
before a new proxy request is covered, but forced worker termination in the
middle of one active `407` sequence is not.

## Settings and persistence

- Configure one authenticated own proxy, close the settings page, then reopen
  both the popup and full settings.
- Confirm the settings page shows the configured username and a redacted
  password placeholder, never the stored password. Confirm the popup shows only
  candidate availability/counts.
- Save notification, language, site-rule, Tor/WARP, and other unrelated
  settings. Reopen settings and confirm the authenticated proxy remains usable.
- Change only the proxy username while leaving the redacted password placeholder
  untouched. Confirm the stored password is preserved.
- With the placeholder untouched, change the proxy type, host, or port and
  confirm the save is rejected. Enter a replacement password and confirm the
  endpoint change then succeeds.
- Replace the password, reopen settings, and confirm only the placeholder is
  displayed and the replacement authenticates.
- Clear both credential fields, save, and confirm the proxy no longer supplies
  authentication credentials.
- Add and remove proxy rows, including two rows that share an endpoint, and
  confirm a redacted password is never transferred to the wrong row.
- Reorder distinct authenticated rows and confirm each password follows its
  original row. Attempt to reorder credential-bearing duplicate rows and
  confirm the save is rejected without changing either credential.
- Leave settings open, replace the password from a second settings page, then
  save an unrelated PAC-modifier change from the older page. Confirm the stale
  save is rejected and the newer password remains active.
- Leave a current settings page open, restart the service worker, and save an
  unrelated PAC-modifier change. Confirm the current reference remains valid.
- Enter a replacement or empty password and confirm the page sends explicit
  password intent without preservation metadata. Confirm a request containing
  both forms is rejected.

## Authentication

- The automated smoke covers a real plain-HTTP `webRequest.onAuthRequired`
  proxy challenge, non-proxy `401`, unmatched host/port, passwordless and retry-
  limit cases.
- For a manual cross-check, trigger the same flow with an authorized test proxy
  and confirm the configured credentials authenticate without appearing in
  DevTools, screenshots, or exported diagnostics.
- Restart or suspend the service worker, retry authentication, and confirm the
  durable credential still works without first opening an extension page. A
  full Chrome restart before a previously unused proxy is automated; natural
  suspension and forced mid-challenge termination remain manual/follow-up
  boundaries.

## DevTools inspection

- Inspect service-worker and popup/settings DevTools while opening pages and
  performing each save above.
- Inspect runtime message responses for `getState`, `getPacMods`, `setPacMods`,
  `normalizePacMods`, and `validatePacMods`. Confirm no response contains a
  password field, credential-bearing proxy URL/string, or reusable secret.
- Confirm the full-settings proxy model contains only the editable username,
  `hasCredentials`, `hasPassword`, a durable-state revision, and non-secret
  preservation metadata bound to revision, source index, type, host, port, and
  username.
- Confirm PAC status and diagnostic responses do not expose a PAC-modifier hash
  derived from authentication data.
- Trigger validation and operation errors and confirm messages/details contain
  neither credentials nor unsanitized credential-bearing URLs.
- Inspect proxy-auth status, health, migration, notifications, console output,
  and extension activity records for credential leakage.
