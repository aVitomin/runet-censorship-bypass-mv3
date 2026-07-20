# PAC download bounds browser QA

Use a completed unpacked MV3 build in current Chrome and Brave. Keep service-worker
DevTools open. Use only a controlled loopback HTTP server; do not change the
Windows system proxy and do not put credentials, private URLs, or repository
files in any response.

1. Configure a custom loopback PAC URL whose headers arrive immediately and
   whose valid body never finishes. Confirm the operation reports the sanitized
   timeout after 30 seconds, the request is closed, and no PAC artifact or proxy
   application is recorded.
2. Repeat with one valid chunk followed by a pause longer than 30 seconds.
   Confirm the same result and that a later normal refresh succeeds.
3. Serve chunked valid PAC data just over 16 MiB without `Content-Length`, then
   with a falsely small length. Confirm both stop at the byte boundary and do
   not replace the last valid cached PAC.
4. Serve a declared length over 16 MiB. Confirm rejection occurs before the
   body is transferred. Then serve bodies exactly at and one byte above the
   limit and confirm only the exact-limit body is accepted.
5. Split a multi-byte UTF-8 character across response chunks in an otherwise
   valid PAC. Confirm it downloads, persists, cooks, and applies normally. Then
   serve malformed continuation bytes and an incomplete sequence at EOF;
   confirm both return a sanitized UTF-8 error and preserve existing artifacts.
6. Return `304 Not Modified` for a request with a provider-, URL-, hash-, and
   artifact-matched cache, then without that cache identity. Confirm only the
   matched request is accepted as not modified and missing artifacts cannot be
   cooked or applied.
7. Put a stalled, malformed-UTF-8, or oversized URL before a valid URL in one
   provider. Confirm
   ordered fallback reaches the valid URL and the error/popup surfaces expose
   no PAC text, URL query or fragment, or response details.
8. During a stalled download, terminate and restart the service worker. Confirm
   no partial artifact appears, the previous applied PAC remains represented
   correctly, and a new valid refresh works.

For each rejection, inspect the service-worker console, extension storage,
IndexedDB artifacts, proxy settings/activity, and popup/options status. Record
browser versions and whether stream cancellation visibly closes the loopback
connection. Automated tests establish byte and callback behavior; this checklist
is the remaining real-browser lifecycle confirmation.
