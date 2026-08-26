import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTHORITATIVE_PACKAGE,
  MIN_VERSION_AGE_MS,
  QUARANTINED_PACKAGE,
  SupplyChainVerificationError,
  changedDirectSelections,
  inspectRepository,
  verifyPublicationAges,
} from './verify-supply-chain.mjs';

const integrity = `sha512-${Buffer.from('fixture-integrity').toString('base64')}`;

function packageDocuments({
  directSpecifier = '1.2.3',
  selectedVersion = '1.2.3',
  resolved = 'https://registry.npmjs.org/safe-package/-/safe-package-1.2.3.tgz',
  selectedIntegrity = integrity,
  extraPackages = {},
} = {}) {
  return {
    manifest: {
      name: 'fixture',
      version: '1.0.0',
      private: true,
      dependencies: {
        'safe-package': directSpecifier,
      },
    },
    lockfile: {
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 2,
      requires: true,
      packages: {
        '': {
          name: 'fixture',
          version: '1.0.0',
          dependencies: {
            'safe-package': directSpecifier,
          },
        },
        'node_modules/safe-package': {
          version: selectedVersion,
          resolved,
          integrity: selectedIntegrity,
        },
        'node_modules/fsevents': {
          version: '2.3.3',
          resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz',
          integrity,
          hasInstallScript: true,
          optional: true,
        },
        ...extraPackages,
      },
    },
  };
}

function writeJson(root, relativePath, value) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function fixtureRepository(authoritative = packageDocuments(), configure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rucb-supply-chain-'));
  writeJson(root, `${AUTHORITATIVE_PACKAGE}/package.json`, authoritative.manifest);
  writeJson(root, `${AUTHORITATIVE_PACKAGE}/package-lock.json`, authoritative.lockfile);
  writeJson(root, `${QUARANTINED_PACKAGE}/package.json`, {
    name: 'quarantined-options',
    version: '0.0.0',
    dependencies: { fsevents: '^1.0.0' },
  });
  writeJson(root, `${QUARANTINED_PACKAGE}/package-lock.json`, {
    name: 'quarantined-options',
    lockfileVersion: 1,
    dependencies: {
      fsevents: {
        version: '1.2.13',
        hasInstallScript: true,
      },
    },
  });
  configure?.(root);
  return root;
}

function withFixture(authoritative, assertion, configure) {
  const root = fixtureRepository(authoritative, configure);
  try {
    assertion(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function assertSupplyChainFailure(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof SupplyChainVerificationError);
    assert.match(error.message, pattern);
    return true;
  });
}

test('accepts official registry sources, integrity, the lifecycle baseline, and quarantine', () => {
  withFixture(packageDocuments(), (root) => {
    const summary = inspectRepository(root);
    assert.equal(summary.packageCount, 2);
    assert.deepEqual(summary.lifecyclePackages, ['fsevents@2.3.3']);
    assert.deepEqual(summary.quarantinedPackages, [QUARANTINED_PACKAGE]);
  });
});

test('an unchanged direct selection does not require an age lookup', () => {
  const current = packageDocuments();
  const base = structuredClone(current);
  base.manifest.dependencies['safe-package'] = '^1.2.3';
  base.lockfile.packages[''].dependencies['safe-package'] = '^1.2.3';
  assert.deepEqual(
    changedDirectSelections(current.manifest, current.lockfile, base.manifest, base.lockfile),
    [],
  );
});

for (const [label, resolved] of [
  ['git dependency', 'git+https://github.com/example/safe-package.git'],
  ['file dependency', 'file:../safe-package'],
  ['arbitrary tarball source', 'https://example.test/safe-package-1.2.3.tgz'],
]) {
  test(`rejects a ${label}`, () => {
    withFixture(packageDocuments({ resolved }), (root) => {
      assertSupplyChainFailure(() => inspectRepository(root), /registry source/u);
    });
  });
}

test('rejects missing integrity metadata', () => {
  withFixture(packageDocuments({ selectedIntegrity: null }), (root) => {
    assertSupplyChainFailure(() => inspectRepository(root), /valid integrity/u);
  });
});

test('rejects newly introduced lifecycle-install metadata', () => {
  withFixture(packageDocuments({
    extraPackages: {
      'node_modules/new-installer': {
        version: '4.5.6',
        resolved: 'https://registry.npmjs.org/new-installer/-/new-installer-4.5.6.tgz',
        integrity,
        hasInstallScript: true,
      },
    },
  }), (root) => {
    assertSupplyChainFailure(() => inspectRepository(root), /unexpected lifecycle-install metadata/u);
  });
});

test('rejects an unexpected package manifest and lockfile', () => {
  withFixture(packageDocuments(), (root) => {
    writeJson(root, 'unexpected/package.json', { name: 'unexpected', version: '1.0.0' });
    writeJson(root, 'unexpected/package-lock.json', {
      name: 'unexpected',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {},
    });
    assertSupplyChainFailure(() => inspectRepository(root), /unexpected package manifest or lockfile/u);
  });
});

test('accepts a selected version exactly 168 hours old', async () => {
  const reviewTime = new Date('2026-08-26T12:00:00Z');
  const publicationTime = new Date(reviewTime.getTime() - MIN_VERSION_AGE_MS).toISOString();
  const result = await verifyPublicationAges(
    [{ name: 'safe-package', version: '1.2.3', section: 'dependencies' }],
    { reviewTime, getPublicationTime: async () => publicationTime },
  );
  assert.equal(result[0].ageHours, 168);
});

test('rejects a selected version 167h59m59s old', async () => {
  const reviewTime = new Date('2026-08-26T12:00:00Z');
  const publicationTime = new Date(reviewTime.getTime() - MIN_VERSION_AGE_MS + 1_000).toISOString();
  await assert.rejects(
    verifyPublicationAges(
      [{ name: 'safe-package', version: '1.2.3', section: 'dependencies' }],
      { reviewTime, getPublicationTime: async () => publicationTime },
    ),
    (error) => {
      assert.ok(error instanceof SupplyChainVerificationError);
      assert.match(error.message, /168 full hours are required/u);
      return true;
    },
  );
});

test('fails closed on malformed publication metadata', async () => {
  await assert.rejects(
    verifyPublicationAges(
      [{ name: 'safe-package', version: '1.2.3', section: 'devDependencies' }],
      { reviewTime: new Date('2026-08-26T12:00:00Z'), getPublicationTime: async () => 'not-a-date' },
    ),
    (error) => {
      assert.ok(error instanceof SupplyChainVerificationError);
      assert.match(error.message, /publication timestamp is missing or malformed/u);
      return true;
    },
  );
});
