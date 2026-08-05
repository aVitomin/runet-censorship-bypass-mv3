# Chromium extension tooling

This directory contains the current Chromium MV3 source, tests, and build
tooling, plus legacy sources retained for compatibility.

Canonical instructions are maintained at repository level:

- [Product README](../../../README.md)
- [Development setup](../../../docs/development/DEVELOPMENT.md)
- [Architecture](../../../docs/development/ARCHITECTURE.md)
- [Testing](../../../docs/development/TESTING.md)
- [Release process](../../../docs/development/RELEASE_PROCESS.md)

The primary runtime is `src/extension-chromium-mv3`; its build output is
`build/extension-chromium-mv3`. Do not use the unrelated repository-root npm
package to build this extension.
