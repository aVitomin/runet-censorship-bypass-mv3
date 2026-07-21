# Action status browser QA

This is repository-only QA documentation and is not part of the extension package.

Run `npm --prefix .\extensions\chromium\runet-censorship-bypass run build:mv3`,
then load `extensions/chromium/runet-censorship-bypass/build/extension-chromium-mv3`
as an unpacked extension in current Brave and Chrome builds.

- Open two HTTP(S) sites with different Auto, Proxy, and Direct rules. Switch tabs and windows; confirm the icon, badge, title, popup host, and selected mode follow the focused tab immediately.
- Change the active URL, use back/forward, reload, and complete a redirect. Confirm the final URL wins and a background-tab navigation does not alter the visible action.
- Rapidly switch tabs while reloading them, then close or replace the active tab. Confirm the final active tab remains displayed after activity settles.
- Change a current-site rule in the popup and apply it. Confirm Auto, Proxy, and Direct appear immediately without closing and reopening the popup.
- Download, cook, apply, refresh, clear, and recook PAC data from the popup and options page. Confirm the PAC and applied statuses, colored/grayscale icon, badge, and title agree.
- Take over proxy settings with another extension or policy, then release control. Confirm the action and a newly opened popup reflect live control without a tab switch.
- From the browser's extensions page, inspect and stop the extension service worker. Then activate a tab and reopen the popup; confirm the active site and live proxy-control status are reconstructed.
- Keep the service-worker DevTools console open while applying and clearing PAC. Confirm there is no `Unchecked runtime.lastError`, especially from `action.setIcon`, and that icon, badge, and title updates continue after a failed Action API call.
- Repeat the checks in both UI languages. Confirm no notification, title, popup field, error, or console entry exposes proxy credentials or a full private custom-provider URL.

Chromium still applies PAC with `mandatory: false`; these checks do not establish browser-level fail-closed behavior for malformed PAC or unusable proxy results.
