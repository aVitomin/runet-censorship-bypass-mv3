# Pre-0.0.4 repository audit

Audit baseline: `19be543b1dff9082daec66a556992e287514b9cf` (post-PR #71).
The maintained product is Chromium MV3 plus Firefox MV3. This audit changes no
routing, activation, provider-data, updater, UI, or release behavior. In
particular, Firefox production provider updates remain disabled because no real
manifest URL, key ID, or Ed25519 public key is configured.

## Repository inventory

The baseline contained 234 tracked files. The complete maintained tree was
classified by authoritative root rather than by filename age:

| Class | Files | Baseline bytes | Purpose/evidence |
| --- | ---: | ---: | --- |
| Chromium production runtime | 63 | 778,740 | Service worker, imported modules, pages, locales, icons, manifest template. Import/page and package integrity tests cover reachability. |
| Firefox production runtime | 30 | 12,069,230 | Event page, control/data modules, pages/locales, manifest and packaged provider baseline. Every non-test Firefox source file is present in the explicit package allowlist. |
| Browser-neutral runtime | 3 | 29,456 | Routing contract and dataset verifier/state shared with Firefox and tested against Chromium semantics. |
| Shared packaged assets | 5 | 222,371 | The exact `extension-common/pages/lib` files copied into Chromium; no legacy tree remains. |
| Build/release tooling | 13 | 339,598 | Gulp, cleanup, version data, package/lock, deterministic release and provider-generation scripts. |
| Deterministic/browser tests | 51 | 1,065,028 | Chromium, Firefox and tooling suites plus browser-only smokes/helpers. |
| CI and issue/PR metadata | 5 | 12,354 | One maintained workflow and repository templates. CodeQL uses GitHub Default Setup. |
| Agent instructions/skills | 7 | 30,411 | Three `AGENTS.md` files and four repository skills. |
| Current developer docs | 19 | 158,517 | Architecture, testing, release, security reviews and QA procedures. |
| User/public docs | 8 | 103,200 | README, installation, guide, privacy/security and support entry points. |
| Historical docs | 15 | 855,042 | `docs/legacy/**`; intentionally retained and excluded from maintained-code conclusions. |
| Reference/metadata | 15 | varies | Git/editor settings, licenses, release metadata, README screenshots, maintainer map and provider generator entry point. All have current references or policy purpose. |

Generated `build`, `dist`, `node_modules`, `.local`, browser profiles and logs are
not tracked. No machine-local path was found in current tracked documentation.
Historical MV2 was not inspected as maintained product code.

### Package boundary

- Chromium: 70 files, 1,128,572 bytes. The build copies the Chromium runtime,
  exactly five shared assets and pinned `tldts`; icon/source/forbidden-file
  checks run inside `build:mv3`.
- Firefox: 67 files, 12,241,574 bytes. The explicit allowlist accounts for every
  non-test Firefox source plus three common modules, `tldts`, and reused action
  icons. The exact-file/source-byte verifier runs inside `build:firefox`.
- No test, fixture, profile, source map, PAC source, credential or updater trust
  secret enters either package.

## Issues found and resolved

1. The PR workflow ran PAC tests three times, the rest of Chromium tests twice,
   Firefox tests twice, and both builds four times. It also performed
   deterministic release rebuilds on every PR.
2. `verify`, focused commands and CI were documented as if their repetition were
   independent assurance, even when they invoked identical assertions.
3. Release reproducibility belonged to ordinary PR verification instead of the
   trusted-main/release boundary.
4. The release skill described only Chromium packaging. The MV3 security skill
   always required Chromium checks, including isolated Firefox changes.
5. Root instructions repeated most dependency and security skill procedures and
   lacked an explicit instruction-priority/debugging rule.
6. Gulp evaluated tracked manifest templates through `new Function`, even though
   the only supported syntax is named scalar substitution. This required the
   otherwise unused direct dependencies `through2` and `plugin-error`.
7. Gulp/build cleanup exposed three dead remnants: unused `firefoxSrc`, unused
   `buildMv3`, and an always-undefined `cleanBuild` export.
8. No deterministic path-to-checks helper existed, so small prompts had to repeat
   repository-specific command selection.
9. Current developer docs still said PR CI ran aggregate verification and
   release reproducibility after the same focused suites/builds.

The template renderer is now a small strict transform using Node's built-in
`Transform`. It accepts named scalar placeholders, rejects unknown/expression
syntax, preserves the historical LF output, and has focused tests. Removing two
direct packages removes ten lockfile package entries and changes no runtime byte.

## Verification DAG before

Local Windows measurements are warm-worktree wall times; they show shape, not a
cross-machine benchmark.

| Command | Work performed | Duplicated by | Seconds | Purpose |
| --- | --- | --- | ---: | --- |
| `npm test` | Chromium 428 + Firefox 375 + tooling 14 | focused target tests in old CI | 11.12 | all deterministic suites |
| `test:pac` | 26 PAC cases | `test:mv3`, `npm test` | 0.68 | focused routing feedback |
| `test:mv3` | Chromium 428, including PAC | `npm test` | 7.29 | Chromium contracts/integration |
| `test:firefox` | Firefox 375 | `npm test` | 4.34 | Firefox contracts/integration |
| `lint:mv3` | Chromium source lint | target/aggregate wrappers | 7.44 | static correctness |
| `lint:firefox` | Firefox source lint | target/aggregate wrappers | 2.27 | static correctness |
| `build:mv3` | build + icons + package integrity | aggregate and release rebuilds | 4.83 | Chromium package proof |
| `build:firefox` | build + exact package allowlist | aggregate and release rebuilds | 1.05 | Firefox package proof |
| `verify:mv3` | Chromium lint/test/build | same individual old-CI steps | 11.86 | Chromium canonical candidate |
| `verify:firefox` | Firefox lint/test/build | same individual old-CI steps | 8.31 | Firefox canonical candidate |
| `verify` | all tests + both lint/build | nearly every preceding old-CI step | 18.97 | full local gate |
| `release:*` | two clean target builds + deterministic archives | ordinary build/aggregate | CI: 1–2 each | reproducibility/package output |
| Chrome smoke | packaged browser/API behavior | not duplicated | CI: 15 | real Chromium gate |
| Firefox lifecycle smoke | genuine 65-second idle recreation | not in normal CI | >65 | release/browser lifecycle QA |
| docs/supply-chain | dependency-free policy plus focused tests | not duplicated | <1 local | repository policy |

PR #71's `Verify MV3` job took 66 seconds (13:44:17–13:45:23 UTC).
Its deterministic test execution was 1,646 assertions for 817 unique package
tests: 829 executions were repetitions. Including 15 root policy/parser tests,
the repository had 832 unique deterministic assertions.

The old PR path performed four Chromium and four Firefox builds: explicit build,
aggregate build and two release reproducibility builds for each target.

## Verification DAG after

The command meanings are now explicit:

| Gate | Contents | Normal use |
| --- | --- | --- |
| `test:pac` | PAC subset only | fast routing iteration |
| `test:tooling` / `verify:tooling` | build/release/provider tools, with tooling lint | tooling/policy changes |
| `verify:mv3` | Chromium lint + 428 tests + one verified build | Chromium-only final gate |
| `verify:firefox` | Firefox lint + 375 tests + one verified build | Firefox-only final gate |
| `verify` | one aggregate lint, one aggregate test process, two verified builds | shared or full local final gate |
| `release:chromium` / `release:firefox` | deterministic double-build archives | release/trusted-main only |
| root policy commands | docs, supply chain and helper tests | every PR as applicable |

The strict renderer adds four tooling assertions; `required-checks` adds five
policy assertions. The after model has 821 package tests and 20 root policy
tests: 841 unique assertions, each executed once in CI. Semantic coverage grows
by nine while 829 duplicate executions disappear. A focused command remains
available but is not run beside a canonical superset in CI.

The optimized aggregate lint/test invocation completed locally in 18.55 seconds
versus 18.97 seconds before, despite the nine added assertions and newly covered
tooling lint. Target-focused commands remain independently usable.

`scripts/required-checks.mjs` reports an auditable advisory plan from changed
paths. It selects skills and target checks but cannot weaken CI or repository
rules. Five tests cover docs-only, Firefox-only security, shared routing,
dependency/workflow and release changes.

## CI before and after

Before: one serial 25-minute-budget job mixed policy, both browsers, Chrome
smoke, aggregate repetition, release rebuilds and uploads. Failures were slower
to localize, and ordinary PRs paid eight total target builds.

After:

- `Policy and supply chain`: docs, policy tests, static verifier, dependency
  review, deterministic install, registry signatures, production audit and
  tooling gate.
- `Chromium MV3`: one canonical target gate and Chrome Stable smoke.
- `Firefox MV3`: one canonical target gate.
- `Trusted-main release artifacts`: after all three succeed, exact-main only;
  runs deterministic Chromium/Firefox release packaging and uploads archives.
- final `Verify MV3`: stable required-check name that requires every applicable
  job, including release artifacts on trusted main.

The three PR jobs run in parallel. PR build count falls from eight to two;
release reproducibility falls from four release builds to zero on PRs and remains
two per target on trusted main. Package integrity remains part of both PR target
builds. CodeQL Default Setup and the pinned dependency-review gate are unchanged.
All Actions remain full-SHA pinned, permissions remain `contents: read`, and
checkout keeps `persist-credentials:false`.

The first branch run provides an honest wall-clock sample rather than an assumed
speedup: policy and Firefox each completed in 14 seconds, Chromium completed in
71 seconds, and the final conclusion completed in 4 seconds. End-to-end workflow
time was 78 seconds versus PR #71's 66 seconds. That sample's Chrome smoke took
34 seconds versus 15 on the baseline run, while one parallel `setup-node` took
14 seconds versus 2 on the baseline; the Chromium deterministic target gate
itself took 8 seconds. Thus repeated deterministic work and four PR release
builds are demonstrably gone, but one noisy run does not prove a wall-clock
improvement. Normalizing only those two observed runner/browser variances gives
a 47-second critical path; future runs should be measured rather than promising
that estimate. A second branch run with ordinary runner/browser timing completed
the maintained workflow in 34 seconds: policy 18 seconds, Firefox 13, Chromium
28 (11-second target verification plus 8-second Chrome smoke), and the final
conclusion 2. This is the observed after value used for the audit; the first
outlier remains recorded above rather than discarded. CodeQL Default Setup also
remained green; its JavaScript analysis execution was 64 seconds versus 73 on
the baseline, independent of the maintained-workflow critical path.

Counting executable verification/action gates (excluding checkout/setup,
dependency-review itself and skipped artifact uploads), the ordinary PR path
falls from 21 commands to 16. The package script surface grows from 16 to 20:
the four additions are intentional named aggregate/tooling gates (`lint`,
`lint:tooling`, `test:tooling`, `verify:tooling`), not additional CI
executions.

## Agent instruction architecture

Priority is now explicit: current user scope, hard invariants, scoped
instructions, applicable skill, defaults. If a repository instruction causes a
stop, permission request or material scope expansion, the agent names it.

Root `AGENTS.md` moved procedure detail to skills and keeps scope/map, hard
supply-chain/runtime invariants, check selection and completion contract. Scoped
Chromium background/page instructions remain because they express local runtime
and credential/UI constraints not duplicated by the root map.

| Metric | Before | After |
| --- | ---: | ---: |
| all `AGENTS.md` bytes | 17,498 | 11,449 |
| root `AGENTS.md` bytes | 13,927 | 7,878 |
| skill count | 4 | 4 |
| total `SKILL.md` bytes | 12,913 | 10,691 |

## Skill audit

| Skill | Result |
| --- | --- |
| `dependency-review` | Preserves 168-hour rule, identity/source/tarball/lifecycle/lock/Action/vendor review and decision contract; removes repeated root prose. |
| `mv3-security-review` | Selects Chromium, Firefox, shared or both from the affected boundary. Firefox-only work no longer runs Chromium ceremonially; shared work still requires both. |
| `pac-regression` | Remains Chromium-PAC-specific. Shared routing changes add Firefox/shared tests without claiming Firefox executes PAC. |
| `release-candidate` | Now covers Chromium ZIP, Firefox unsigned XPI/source, shared versioning, trusted-main artifacts, AMO/signing boundary and dual-browser QA. |

Skills use a short trigger/decision section followed by detailed checks only when
invoked. No new skill was justified.

## Test-quality findings

- Baseline test source: 25 Chromium files (638,165 bytes), 24 Firefox files
  (416,622 bytes), two tooling files (10,241 bytes). Browser harnesses and
  package verifiers are deliberately colocated with their target but are guarded
  from ordinary execution.
- Among 754 literal test titles, the only meaningful duplicate title is the
  packaged-baseline fallback. One test covers browser-neutral state selection;
  the other covers Firefox runtime integration, so neither was removed.
- Deterministic suites complete in seconds. No dominant arbitrary sleep occurs
  there. The 65-second Firefox lifecycle wait is the platform's genuine idle
  destruction boundary and remains browser/release QA instead of normal PR CI.
- Chrome smoke is high-value browser/API evidence and remains in the Chromium PR
  gate. Cross-browser visual QA and full Firefox lifecycle/private-control QA
  remain release/manual gates; running them for every small edit would add cost
  without duplicating deterministic assertions.
- Large Chromium UI/service-worker tests and Firefox runtime tests are sizeable,
  but splitting them now would be file churn with no behavior or runtime gain.
  Split only when ownership or change frequency makes a boundary clear.

## Architecture sanity findings

- Chromium PAC execution/control and Firefox declarative fail-closed
  routing/control are intentionally browser-specific and should not be forced
  behind one abstraction.
- Routing contract and provider dataset verification are already shared at the
  correct boundary; there is no second Firefox validator.
- Firefox's store, promotion journal, activation, product config and updater
  modules look layered because IndexedDB and `storage.local` are separate crash
  boundaries. Their focused tests demonstrate distinct responsibilities; no
  pre-release merge is justified.
- Chromium legacy migration code remains reachable user-facing upgrade handling,
  even though MV2 source/build tooling is historical. It is not dead code.
- The authenticated Firefox updater is dormant but intentional. It has no URL,
  key ID, public key, timer fetch or hidden activation source; deleting it would
  undo reviewed release preparation rather than remove accidental code.
- All Firefox production files are allowlisted and all extra package files map to
  common modules, pinned vendor bytes or shared icons. No omitted runtime source
  or unreferenced packaged executable was found.
- The only proven dead build API was the three removed declarations/exports.
  Broader runtime refactoring was deliberately rejected.

## Dependency and supply-chain result

`plugin-error` and `through2` were direct build-only dependencies used solely by
the old template transform. Replacing them with `node:stream` removes two direct
dependencies and ten lock entries without selecting any new version:

| Metric | Before | After |
| --- | ---: | ---: |
| direct dependencies | 11 | 9 |
| production-section direct dependencies | 4 | 2 |
| lockfile package entries | 316 | 306 |

The static verifier reports 305 dependency records after excluding the lockfile
root record. All 304 installed registry packages had verified signatures; 28
also exposed verified attestations. Production audit found zero vulnerabilities.
Full audit reports two low-severity, dev-only `diff`/Mocha findings; remediation
requires the breaking Mocha 12 line, so it is isolated post-0.0.4 tooling work.
Neither `diff` nor Mocha enters an extension package. No newly selected version
or lifecycle script was introduced.

No Action reference changed. Existing checkout, setup-node, dependency-review and
upload-artifact SHAs remain pinned. Production and full audit results are part of
the final verification record below.

## Developer-documentation consistency

`DEVELOPMENT`, `TESTING`, `RELEASE_PROCESS`, `CONTRIBUTING` and the Firefox
release-build notes now describe target gates, one aggregate local gate, parallel
CI, and trusted-main-only reproducibility. Public README/product copy was not
rewritten. Current docs retain MV2 only where it describes history or the live
Chromium migration feature.

## Deliberate non-changes and remaining risks

- No product runtime, manifest permission, routing setting, dataset, UI, version,
  update endpoint or trust key changed.
- Chromium PAC still uses `mandatory:false`; generated strict routing is not a
  browser-level fail-closed guarantee.
- Firefox's random loopback floor retains its documented local-process collision
  assumption.
- Firefox updater trust configuration is intentionally absent. Remote production
  updates remain disabled until a separately reviewed fixed HTTPS endpoint,
  stable key ID and Ed25519 public key exist.
- AMO signing/submission and final cross-browser release QA remain release work.
- Firefox's >65-second genuine lifecycle smoke remains a release/local browser
  gate because the normal Linux PR runner is not a pinned Firefox 154 QA image.

Post-0.0.4 recommendations: configure and review updater trust only when external
release values exist; periodically measure the parallel CI; split giant tests
only around demonstrated ownership boundaries; consider extracting the shared
deterministic ZIP primitive from its historically Firefox-named module in a
separate tooling-only cleanup.

## Final verification record

Local full verification completed in 18.55 seconds after the redesign (18.97
seconds before). Remote after-duration is recorded after the branch workflow is
available. Required local evidence:

- docs verifier and 20 root policy/helper tests;
- static supply-chain verifier, registry signatures, production and full audit;
- `verify:tooling`, `verify:mv3`, `verify:firefox`, and aggregate `verify`;
- PAC 26, Chromium 428, Firefox 375, tooling 18;
- Chromium 70/70 and Firefox 67/67 package trees with zero byte differences;
- Chrome Stable smoke and release-only Firefox lifecycle smoke when the pinned
  local browser is available;
- deterministic Chromium and Firefox release packaging;
- Chromium release ZIP 1,137,540 bytes
  (`706de23c2f7476ef1a27c389d29d438495ffced416d2a58c1d4793361ca33bc8`);
- Firefox unsigned XPI 12,250,378 bytes
  (`6152e2455de2060f6a05c3fb7cacee7a15a27abc184e5b5214c5a4b1f0fdbad6`)
  and reviewer source ZIP 16,059,608 bytes
  (`c5ac0134fdcaeee82835a893ec03f14c63964842411f256b3745dda8b27189c7`);
- Mozilla `addons-linter@10.10.0`: zero errors, warnings and notices;
- Code Scanning 0, Dependabot 0, `git diff --check`, and a clean committed tree.

Local browser evidence passed with Chrome 153.0.8010.37 and Firefox 154.0.1.
Chrome covered packaged PAC routing, authenticated proxy transports, worker
restart and external ownership. Firefox produced a new boot ID after genuine
idle destruction, remained durable OFF and preserved the pre-existing manual
proxy across all four network markers.
