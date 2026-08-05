# PAC apply freshness browser QA

Use the completed unpacked MV3 build in current Chrome and Brave with service
worker and options-page DevTools open. Use only synthetic settings and an
authorized loopback PAC/proxy. Do not change the Windows system proxy.

For each case, watch the extension activity or a breakpoint immediately before
`chrome.proxy.settings.set`. Confirm that obsolete PAC text never reaches that
call, the final durable provider/cache/apply metadata describes the newest
operation, and no URL, PAC body, credential, or internal fingerprint appears in
page-visible errors or logs.

- Pause provider A during download, select provider B, then resume A. Only B may
  be applied.
- Pause an A apply after artifact loading, change a PAC modifier, then resume.
  A must finish as stale and make no proxy-settings write.
- Pause at the same boundary and clear proxy settings. Clear must win and remain
  the final browser state.
- Start a newer refresh while an older apply is paused, then finish them in both
  orders. The newer cooked PAC must be the only final applied value.
- Pause an old `settings.set` callback, request a newer apply and then a clear in
  separate runs, and release the old callback. It must not record old success;
  the newer operation must remain final.
- Let another test extension take proxy control at the final boundary. The PAC
  write must be rejected with no silent success.
- Repeat takeover while `settings.set` is pending. The post-callback live-control
  check must report lost control rather than an applied state, and a later apply
  must work after control is released.
- Repeat with only language and notification changes. The otherwise-current PAC
  must still apply.
- Terminate the worker, reopen the extension, and apply from valid durable
  artifacts. Freshness and proxy-control checks must reconstruct normally.

Record browser/version, operation order, proxy-settings set/clear calls, final
control level, final apply status, and console errors. Automated tests cover the
deterministic scheduling; this checklist confirms Chrome/Brave API behavior and
service-worker lifecycle integration. Chromium does not provide an atomic
compare-and-set for proxy ownership: a native ownership change can still occur
after the final live read and before Chromium processes `settings.set`. Record
that narrow browser boundary without claiming atomic takeover prevention.
