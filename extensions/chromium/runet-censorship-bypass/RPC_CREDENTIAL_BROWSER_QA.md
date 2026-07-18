# MV3 RPC credential browser QA

Use an unpacked MV3 build and a dedicated test proxy account. Never record the
test password in screenshots, logs, issue text, or this checklist.

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

- Trigger a real `webRequest.onAuthRequired` proxy challenge and confirm the
  configured credentials authenticate successfully.
- Confirm non-proxy challenges, an unmatched host/port, and retry-limit cases do
  not receive credentials.
- Restart or suspend the service worker, retry authentication, and confirm the
  durable credential still works without first opening an extension page.

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
