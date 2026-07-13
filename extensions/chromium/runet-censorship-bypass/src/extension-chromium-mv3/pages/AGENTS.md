# MV3 page instructions

MV3 pages communicate through `pages/shared/rpc-client.js`; do not reach into background globals or add remote scripts. Build DOM with text nodes/`textContent` and existing helpers, not HTML injection sinks.

- Background state may contain structured proxy credentials. Display a password only as `***`, restore the original value when that placeholder is saved unchanged, and keep credentials out of DOM attributes, errors, diagnostics, and logs. Treat full custom provider URLs as sensitive.
- Keep popup and options routing language aligned: Auto removes the applicable override, Proxy requires a candidate, and Direct is explicit. Exact-host and domain/subdomain controls need both forms tested; the current two-label domain heuristic is not public-suffix safe.
- Migration UI stays collapsed/explicit, requires field selection and confirmation, and must not imply that it applied browser proxy settings.
- Add every normal user-facing string to both `_locales/en/messages.json` and `_locales/ru/messages.json`. Preserve keys and placeholder shapes.
- MV3 owns these pages; the legacy Inferno options app under `extension-common/pages/options` is separate.

After changes, run `lint:mv3`, `test:mv3`, and `build:mv3`, then inspect the affected page in Chromium. Manually verify secret masking, keyboard/form behavior, both languages, and any routing action.
