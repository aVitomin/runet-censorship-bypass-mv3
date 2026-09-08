# Firefox release candidate build

Firefox MV3 follows the repository release train. Its manifest version is the
same `0.0.<storeVersion>` derived from `src/templates-data.js` for Chromium;
the current candidate is `0.0.3.0`. A future public release updates the shared
release version through the normal release process rather than creating an
independent Firefox-only version.

The immutable Firefox Gecko ID is
`{adf5f697-1149-42a2-92eb-c163cb9a4146}`. It is a newly generated UUIDv4 for
this Firefox MV3 product and is not a legacy AMO identity. Do not change it in
later releases.

## Reproducible local build

Use Node.js 22 and a clean checkout. From the repository root:

```powershell
$Project = '.\extensions\chromium\runet-censorship-bypass'
npm ci --prefix $Project
node .\scripts\verify-docs.mjs
node .\scripts\verify-supply-chain.mjs
npm --prefix $Project run verify:firefox
npm --prefix $Project run release:firefox
```

`release:firefox` performs two independent Firefox builds, runs the exact
package allowlist/integrity verifier after each build, and compares both
release sets byte for byte. It refuses a dirty tracked tree and refuses to
overwrite an existing release output. It then writes:

- `dist/firefox-release/runet-censorship-bypass-firefox-0.0.3.0.xpi` — unsigned
  release candidate with `manifest.json` at archive root;
- the matching `.xpi.sha256` file;
- `runet-censorship-bypass-firefox-0.0.3.0-source.zip` — all tracked source
  files needed for review and reproduction, under one versioned root;
- the matching source-archive `.sha256` file.

Both archives use sorted entries, fixed ZIP timestamps, fixed file modes and
the stored ZIP method. No generated profile, dependency directory, log,
credential, signing key or local file is included. The source archive includes
the exact `package-lock.json`; dependencies are restored only through npm.
The large provider table is named `anticensority-hosts-v1.data` so Mozilla's
source-code linter does not parse a declarative 11.6 MiB artifact as source.
Its bytes are JSON-compatible, human-reviewable and verified against the
committed byte count and SHA-256 before the extension constructs an index.

The unsigned XPI is a local/reviewer artifact, not a public release. Install it
temporarily in Firefox 154.0.1 through `about:debugging`, Marionette, or a pinned
`web-ext` development command. Normal end-user installation requires Mozilla
signing, which is intentionally outside this build and this PR.

## Mozilla validation

The release candidate is audited with the exact Mozilla `addons-linter`
version recorded in the PR. For this candidate the command is:

```powershell
npx --yes --ignore-scripts addons-linter@10.10.0 `
  "$Project\dist\firefox-release\runet-censorship-bypass-firefox-0.0.3.0.xpi"
```

This command is an explicit release audit tool invocation; it is not a project
dependency and does not change `package.json` or `package-lock.json`.

Trusted-main CI builds the same deterministic release set for the exact main
SHA. Pull requests run the build and reproducibility check but upload no
artifacts. Only a successful trusted-main push or an explicitly dispatched
workflow on exact `main` uploads the unpacked Firefox package, unsigned XPI,
checksums and reviewer source archive. AMO submission and signing remain manual
future release actions.
