'use strict';

const Assert = require('node:assert');
const Store = require('../background/dataset-store');
const {
  Dataset,
  PROVIDER_KEY,
  artifact,
  memoryBackend,
  payload,
  sha256,
} = require('./dataset-test-helpers');

function makeStore(backend = memoryBackend()) {

  return {backend, store: Store.createStore({backend, sha256})};

}

describe('Firefox immutable provider dataset store', function() {

  const invalidArtifactCases = [
    {
      name: 'malformed JSON',
      create() {

        const bytes = Buffer.from('{', 'utf8');
        return artifact({
          artifactBytes: bytes,
          envelopeOverrides: {
            artifactByteCount: bytes.byteLength,
            artifactSha256: sha256(bytes),
          },
        });

      },
      code: 'MALFORMED_JSON',
    },
    {
      name: 'unsupported schema',
      create: () => artifact({envelopeOverrides: {schemaVersion: 2}}),
      code: 'UNSUPPORTED_SCHEMA_VERSION',
    },
    {
      name: 'rule-count mismatch',
      create: () => artifact({envelopeOverrides: {ruleCount: 2}}),
      code: 'RULE_COUNT_MISMATCH',
    },
  ];

  for (const testCase of invalidArtifactCases) {
    it(`keeps pointers unchanged for ${testCase.name}`, async function() {

      const {backend, store} = makeStore();
      const verification = await store.commitPackagedBaseline(
          testCase.create(),
      );

      Assert.strictEqual(verification.ok, false);
      Assert.strictEqual(verification.code, testCase.code);
      Assert.strictEqual(backend.commits.length, 0);

    });
  }

  it('stores and reloads a verified packaged baseline by exact SHA-256',
      async function() {

        const {backend, store} = makeStore();
        const baseline = artifact();
        const verification = await store.commitPackagedBaseline(baseline);
        const loaded = await store.loadVerifications(PROVIDER_KEY);

        Assert.strictEqual(verification.ok, true);
        Assert.strictEqual(backend.commits.length, 1);
        Assert.strictEqual(loaded.packagedBaseline.ok, true);
        Assert.strictEqual(
            loaded.packagedBaseline.dataset.identity.artifactSha256,
            baseline.envelope.artifactSha256,
        );
        Assert.strictEqual(loaded.active, null);

      });

  it('stops cold reconstruction after the first usable artifact',
      async function() {

        const backend = memoryBackend();
        const store = Store.createStore({backend, sha256});
        const active = artifact({
          datasetVersion: 'active',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        await store.activateCandidate(active);
        const pointers = backend.pointers.get(PROVIDER_KEY);
        pointers.previousLkgArtifactSha256 = 'b'.repeat(64);
        pointers.packagedBaselineArtifactSha256 = 'c'.repeat(64);
        backend.pointers.set(PROVIDER_KEY, pointers);
        const reads = [];
        const originalRead = backend.readArtifact;
        backend.readArtifact = async (artifactSha256) => {
          reads.push(artifactSha256);
          return originalRead.call(backend, artifactSha256);
        };
        const loaded = await store.loadVerifications(PROVIDER_KEY, {
          firstUsableOnly: true,
        });

        Assert.strictEqual(loaded.active.ok, true);
        Assert.strictEqual(loaded.previousLkg, null);
        Assert.strictEqual(loaded.packagedBaseline, null);
        Assert.deepStrictEqual(reads, [active.envelope.artifactSha256]);

      });

  it('does not move a pointer when packaged bytes fail verification',
      async function() {

        const {backend, store} = makeStore();
        const invalid = artifact({
          envelopeOverrides: {artifactSha256: '0'.repeat(64)},
        });
        const verification = await store.commitPackagedBaseline(invalid);

        Assert.strictEqual(verification.ok, false);
        Assert.strictEqual(verification.code, 'ARTIFACT_SHA256_MISMATCH');
        Assert.strictEqual(backend.commits.length, 0);

      });

  it('does not move a pointer on an exact byte-count mismatch',
      async function() {

        const {backend, store} = makeStore();
        const invalid = artifact({envelopeOverrides: {artifactByteCount: 1}});
        const verification = await store.commitPackagedBaseline(invalid);

        Assert.strictEqual(verification.ok, false);
        Assert.strictEqual(
            verification.code,
            'ARTIFACT_BYTE_COUNT_MISMATCH',
        );
        Assert.strictEqual(backend.commits.length, 0);

      });

  it('rejects a non-packaged trust label for the baseline pointer',
      async function() {

        const {backend, store} = makeStore();
        const verification = await store.commitPackagedBaseline(artifact({
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        }));

        Assert.strictEqual(verification.ok, false);
        Assert.strictEqual(
            verification.code,
            'PACKAGED_BASELINE_TRUST_REQUIRED',
        );
        Assert.strictEqual(backend.commits.length, 0);

      });

  it('atomically activates an authenticated candidate', async function() {

    const {backend, store} = makeStore();
    await store.commitPackagedBaseline(artifact());
    const candidate = artifact({
      datasetVersion: '2026.09.02-test.1',
      trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
    });
    const result = await store.activateCandidate(candidate);
    const loaded = await store.loadVerifications(PROVIDER_KEY);

    Assert.strictEqual(result.verification.ok, true);
    Assert.strictEqual(result.plan.kind, 'ACTIVATE_CANDIDATE');
    Assert.strictEqual(loaded.active.ok, true);
    Assert.strictEqual(
        loaded.pointers.activeArtifactSha256,
        candidate.envelope.artifactSha256,
    );
    Assert.strictEqual(backend.commits.length, 2);

  });

  it('rotates only a verified active artifact into previous LKG',
      async function() {

        const {store} = makeStore();
        const first = artifact({
          datasetVersion: '2026.09.02-test.1',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        const second = artifact({
          payload: payload([{
            width: 12,
            routeRef: 'PROVIDER_PROXY',
            hosts: 'next.example',
          }]),
          datasetVersion: '2026.09.03-test.1',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        await store.activateCandidate(first);
        await store.activateCandidate(second);
        const loaded = await store.loadVerifications(PROVIDER_KEY);

        Assert.strictEqual(loaded.active.dataset.identity.datasetVersion,
            '2026.09.03-test.1');
        Assert.strictEqual(loaded.previousLkg.dataset.identity.datasetVersion,
            '2026.09.02-test.1');

      });

  it('never activates an unauthenticated remote candidate', async function() {

    const {backend, store} = makeStore();
    const baseline = artifact();
    await store.commitPackagedBaseline(baseline);
    const before = structuredClone(backend.pointers.get(PROVIDER_KEY));
    const result = await store.activateCandidate(artifact({
      datasetVersion: '2026.09.02-test.1',
      trust: Dataset.TRUST.REMOTE_UNAUTHENTICATED,
    }));

    Assert.strictEqual(result.plan.kind, 'USE_PACKAGED_BASELINE');
    Assert.strictEqual(
        result.plan.candidateRejection,
        'UNAUTHENTICATED_REMOTE_CANDIDATE',
    );
    Assert.deepStrictEqual(backend.pointers.get(PROVIDER_KEY), before);
    Assert.strictEqual(backend.commits.length, 1);

  });

  it('reports a missing active artifact without converting it to a miss',
      async function() {

        const {backend, store} = makeStore();
        backend.pointers.set(PROVIDER_KEY, Object.assign(
            Store.emptyPointers(PROVIDER_KEY),
            {activeArtifactSha256: 'a'.repeat(64)},
        ));
        const loaded = await store.loadVerifications(PROVIDER_KEY);

        Assert.strictEqual(loaded.active.ok, false);
        Assert.strictEqual(loaded.active.code, 'ACTIVE_ARTIFACT_MISSING');

      });

  it('reports an unreadable active artifact and preserves fallback selection',
      async function() {

        const backend = memoryBackend();
        const baseline = artifact();
        const store = Store.createStore({backend, sha256});
        await store.commitPackagedBaseline(baseline);
        const pointers = backend.pointers.get(PROVIDER_KEY);
        pointers.activeArtifactSha256 = 'a'.repeat(64);
        backend.pointers.set(PROVIDER_KEY, pointers);
        const originalRead = backend.readArtifact;
        backend.readArtifact = async (artifactSha256) => {
          if (artifactSha256 === 'a'.repeat(64)) {
            throw new Error('injected unreadable artifact');
          }
          return originalRead.call(backend, artifactSha256);
        };
        const loaded = await store.loadVerifications(PROVIDER_KEY);

        Assert.strictEqual(loaded.active.code, 'ACTIVE_ARTIFACT_UNREADABLE');
        Assert.strictEqual(loaded.packagedBaseline.ok, true);

      });

  it('preserves usable fallback fields when one pointer is corrupt',
      async function() {

        const {backend, store} = makeStore();
        const baseline = artifact();
        await store.commitPackagedBaseline(baseline);
        const pointers = backend.pointers.get(PROVIDER_KEY);
        pointers.activeArtifactSha256 = 'not-a-sha';
        backend.pointers.set(PROVIDER_KEY, pointers);
        const loaded = await store.loadVerifications(PROVIDER_KEY);

        Assert.strictEqual(loaded.active.ok, false);
        Assert.strictEqual(
            loaded.active.code,
            'ACTIVE_ARTIFACT_POINTER_CORRUPT',
        );
        Assert.strictEqual(loaded.packagedBaseline.ok, true);

      });

  it('treats unknown pointer metadata as corruption', async function() {

    const {backend, store} = makeStore();
    const pointers = Store.emptyPointers(PROVIDER_KEY);
    pointers.extra = true;
    backend.pointers.set(PROVIDER_KEY, pointers);
    const loaded = await store.loadVerifications(PROVIDER_KEY);

    Assert.strictEqual(loaded.active.ok, false);
    Assert.strictEqual(
        loaded.packagedBaseline.code,
        'PACKAGED_BASELINE_ARTIFACT_POINTER_CORRUPT',
    );

  });

  it('rejects stored artifact metadata that crosses provider identity',
      async function() {

        const {backend, store} = makeStore();
        const baseline = artifact();
        await store.commitPackagedBaseline(baseline);
        const record = backend.artifacts.get(
            baseline.envelope.artifactSha256,
        );
        record.providerKey = 'different-provider';
        backend.artifacts.set(record.artifactSha256, record);
        const loaded = await store.loadVerifications(PROVIDER_KEY);

        Assert.strictEqual(loaded.packagedBaseline.ok, false);
        Assert.strictEqual(
            loaded.packagedBaseline.code,
            'PACKAGED_BASELINE_ARTIFACT_IDENTITY_MISMATCH',
        );

      });

  it('rejects stored bytes changed after pointer activation', async function() {

    const {backend, store} = makeStore();
    const baseline = artifact();
    await store.commitPackagedBaseline(baseline);
    const record = backend.artifacts.get(baseline.envelope.artifactSha256);
    record.artifactBytes[0] ^= 1;
    backend.artifacts.set(record.artifactSha256, record);
    const loaded = await store.loadVerifications(PROVIDER_KEY);

    Assert.strictEqual(loaded.packagedBaseline.ok, false);
    Assert.strictEqual(
        loaded.packagedBaseline.code,
        'ARTIFACT_SHA256_MISMATCH',
    );

  });

});
