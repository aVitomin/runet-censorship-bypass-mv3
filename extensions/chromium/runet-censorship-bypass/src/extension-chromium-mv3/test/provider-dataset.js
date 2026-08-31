'use strict';


const Chai = require('chai');
const Crypto = require('crypto');
const Fs = require('fs');
const Mocha = require('mocha');
const Path = require('path');
const Dataset = require('../../extension-mv3-common/provider-dataset');
const DatasetState = require(
    '../../extension-mv3-common/provider-dataset-state',
);
const PROVIDER_KEY = 'synthetic-provider';

function sha256(bytes) {

  return Crypto.createHash('sha256').update(bytes).digest('hex');

}

function validPayload() {

  return {
    format: Dataset.PAYLOAD_FORMAT,
    buckets: [
      {
        key: 'a',
        rules: [
          {host: 'alpha.example', routeRef: 'PROVIDER_PROXY'},
          {host: 'amber.example', routeRef: 'PROVIDER_DIRECT'},
        ],
      },
      {
        key: 'b',
        rules: [
          {host: 'beta.example', routeRef: 'PROVIDER_PROXY'},
        ],
      },
    ],
  };

}

function countRules(payload) {

  if (!payload || !Array.isArray(payload.buckets)) {
    return 1;
  }
  return payload.buckets.reduce((total, bucket) =>
    total + (Array.isArray(bucket.rules) ? bucket.rules.length : 0), 0);

}

function encodePayload(payload) {

  return Buffer.from(JSON.stringify(payload), 'utf8');

}

function createArtifact({
  payload = validPayload(),
  artifactBytes = null,
  envelopeOverrides = {},
  trust = Dataset.TRUST.PACKAGED_TRUSTED,
} = {}) {

  const bytes = artifactBytes || encodePayload(payload);
  const envelope = Object.assign({
    schemaVersion: Dataset.SCHEMA_VERSION,
    providerKey: PROVIDER_KEY,
    datasetVersion: '2026.09.01-test.1',
    generatedAt: '2026-09-01T00:00:00.000Z',
    sourceRevisions: [{
      sourceId: 'synthetic-source',
      revision: 'fixture-revision-1',
    }],
    ruleCount: countRules(payload),
    artifactByteCount: bytes.byteLength,
    artifactSha256: sha256(bytes),
    routeTableVersion: Dataset.ROUTE_TABLE_VERSION,
  }, envelopeOverrides);
  return {envelope, artifactBytes: bytes, trust};

}

async function verify(artifact) {

  return Dataset.verifyProviderDataset(Object.assign({}, artifact, {sha256}));

}

function mutatePayload(mutator) {

  const payload = validPayload();
  mutator(payload);
  return payload;

}

function versionedArtifact(datasetVersion, trust) {

  return createArtifact({
    trust,
    envelopeOverrides: {datasetVersion},
  });

}

function selectedRef(verification) {

  return {
    providerKey: verification.dataset.identity.providerKey,
    datasetVersion: verification.dataset.identity.datasetVersion,
    artifactSha256: verification.dataset.identity.artifactSha256,
    trust: verification.trust,
  };

}

const REJECTION_CASES = Object.freeze([
  {
    name: 'unknown schema version',
    create() {
      return createArtifact({envelopeOverrides: {schemaVersion: 2}});
    },
    code: 'UNSUPPORTED_SCHEMA_VERSION',
  },
  {
    name: 'missing required envelope field',
    create() {
      const artifact = createArtifact();
      delete artifact.envelope.providerKey;
      return artifact;
    },
    code: 'MISSING_REQUIRED_FIELD',
  },
  {
    name: 'unknown PAC envelope field',
    create() {
      return createArtifact({envelopeOverrides: {pacScript: 'not allowed'}});
    },
    code: 'UNKNOWN_FIELD',
  },
  {
    name: 'invalid provider identifier',
    create() {
      return createArtifact({envelopeOverrides: {providerKey: 'Bad Provider'}});
    },
    code: 'INVALID_PROVIDER_KEY',
  },
  {
    name: 'invalid dataset identifier',
    create() {
      return createArtifact({envelopeOverrides: {datasetVersion: 'bad version'}});
    },
    code: 'INVALID_DATASET_VERSION',
  },
  {
    name: 'invalid generated timestamp',
    create() {
      return createArtifact({
        envelopeOverrides: {generatedAt: '2026-09-01'},
      });
    },
    code: 'INVALID_GENERATED_TIMESTAMP',
  },
  {
    name: 'invalid SHA-256 format',
    create() {
      return createArtifact({envelopeOverrides: {artifactSha256: 'abc'}});
    },
    code: 'INVALID_ARTIFACT_SHA256',
  },
  {
    name: 'declared byte-count mismatch',
    create() {
      const artifact = createArtifact();
      artifact.envelope.artifactByteCount += 1;
      return artifact;
    },
    code: 'ARTIFACT_BYTE_COUNT_MISMATCH',
  },
  {
    name: 'exact-byte SHA-256 mismatch',
    create() {
      return createArtifact({
        envelopeOverrides: {artifactSha256: '0'.repeat(64)},
      });
    },
    code: 'ARTIFACT_SHA256_MISMATCH',
  },
  {
    name: 'declared rule-count mismatch',
    create() {
      const artifact = createArtifact();
      artifact.envelope.ruleCount += 1;
      return artifact;
    },
    code: 'RULE_COUNT_MISMATCH',
  },
  {
    name: 'malformed JSON bytes',
    create() {
      return createArtifact({artifactBytes: Buffer.from('{', 'utf8')});
    },
    code: 'MALFORMED_JSON',
  },
  {
    name: 'malformed top-level object',
    create() {
      return createArtifact({payload: []});
    },
    code: 'INVALID_FIELD_TYPE',
  },
  {
    name: 'invalid host syntax',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets[0].rules[0].host = 'Alpha_example';
        }),
      });
    },
    code: 'INVALID_HOST',
  },
  {
    name: 'duplicate host rule',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets[0].rules[1].host = 'alpha.example';
        }),
      });
    },
    code: 'DUPLICATE_RULE',
  },
  {
    name: 'unsorted buckets',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets.reverse();
        }),
      });
    },
    code: 'UNSORTED_BUCKETS',
  },
  {
    name: 'unsorted rules',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets[0].rules.reverse();
        }),
      });
    },
    code: 'UNSORTED_RULES',
  },
  {
    name: 'invalid route reference',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets[0].rules[0].routeRef = 'DYNAMIC_CALLBACK';
        }),
      });
    },
    code: 'INVALID_ROUTE_REFERENCE',
  },
  {
    name: 'excessive declared rule count',
    create() {
      return createArtifact({
        envelopeOverrides: {ruleCount: Dataset.LIMITS.MAX_RULES + 1},
      });
    },
    code: 'TOO_MANY_RULES',
  },
  {
    name: 'oversized artifact',
    create() {
      return createArtifact({
        envelopeOverrides: {
          artifactByteCount: Dataset.LIMITS.MAX_ARTIFACT_BYTES + 1,
        },
      });
    },
    code: 'ARTIFACT_TOO_LARGE',
  },
  {
    name: 'malformed bucket structure',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets[0].rules = [];
        }),
      });
    },
    code: 'MALFORMED_BUCKET_STRUCTURE',
  },
  {
    name: 'unsupported source-revision data type',
    create() {
      return createArtifact({
        envelopeOverrides: {sourceRevisions: 'not-an-array'},
      });
    },
    code: 'INVALID_SOURCE_REVISIONS',
  },
  {
    name: 'callback field inside a rule',
    create() {
      return createArtifact({
        payload: mutatePayload((payload) => {
          payload.buckets[0].rules[0].callback = 'not allowed';
        }),
      });
    },
    code: 'UNKNOWN_FIELD',
  },
  {
    name: 'unknown route-table version',
    create() {
      return createArtifact({envelopeOverrides: {routeTableVersion: 2}});
    },
    code: 'UNSUPPORTED_ROUTE_TABLE_VERSION',
  },
]);

Mocha.describe('declarative provider dataset', function() {

  Mocha.it('verifies a valid packaged dataset', async function() {

    const result = await verify(createArtifact());

    Chai.expect(result).to.include({
      ok: true,
      status: 'VERIFIED',
      trust: Dataset.TRUST.PACKAGED_TRUSTED,
      activationEligible: true,
    });
    Chai.expect(result.dataset.envelope).to.include({
      schemaVersion: 1,
      routeTableVersion: 1,
      ruleCount: 3,
    });
    Chai.expect(result.dataset.payload).to.deep.equal(validPayload());

  });

  Mocha.it('verifies an authenticated remote update as eligible',
      async function() {

        const result = await verify(createArtifact({
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
          envelopeOverrides: {datasetVersion: '2026.09.02-update.1'},
        }));

        Chai.expect(result).to.include({
          ok: true,
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
          activationEligible: true,
        });

      });

  Mocha.it('verifies but never activates an unauthenticated candidate',
      async function() {

        const result = await verify(createArtifact({
          trust: Dataset.TRUST.REMOTE_UNAUTHENTICATED,
        }));

        Chai.expect(result).to.include({
          ok: true,
          trust: Dataset.TRUST.REMOTE_UNAUTHENTICATED,
          activationEligible: false,
        });

      });

  Mocha.it('allows inert provenance text without treating it as code',
      async function() {

        const revision = 'function marker() { return "metadata only"; }';
        const result = await verify(createArtifact({
          envelopeOverrides: {
            sourceRevisions: [{sourceId: 'source', revision}],
          },
        }));

        Chai.expect(result.ok).to.equal(true);
        Chai.expect(result.dataset.envelope.sourceRevisions[0].revision)
            .to.equal(revision);

      });

  Mocha.it('hashes exact payload bytes rather than reserialized JSON',
      async function() {

        const payload = validPayload();
        const compactBytes = encodePayload(payload);
        const prettyBytes = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
        const artifact = createArtifact({
          payload,
          artifactBytes: prettyBytes,
          envelopeOverrides: {artifactSha256: sha256(compactBytes)},
        });
        const result = await verify(artifact);

        Chai.expect(result).to.deep.equal({
          ok: false,
          status: 'REJECTED',
          code: 'ARTIFACT_SHA256_MISMATCH',
        });

      });

  Mocha.it('isolates parsed bytes from a mutating hash implementation',
      async function() {

        const artifact = createArtifact();
        const result = await Dataset.verifyProviderDataset(Object.assign(
            {},
            artifact,
            {
              sha256(bytes) {
                const digest = sha256(bytes);
                bytes.fill(0);
                return digest;
              },
            },
        ));

        Chai.expect(result.ok).to.equal(true);
        Chai.expect(result.dataset.payload).to.deep.equal(validPayload());

      });

  REJECTION_CASES.forEach((testCase) => {
    Mocha.it(`rejects ${testCase.name}`, async function() {

      const result = await verify(testCase.create());

      Chai.expect(result).to.deep.equal({
        ok: false,
        status: 'REJECTED',
        code: testCase.code,
      });

    });
  });

  Mocha.it('contains no browser, storage, Node, or execution dependency',
      function() {

        const commonDirectory = Path.resolve(
            __dirname,
            '..',
            '..',
            'extension-mv3-common',
        );
        const sources = [
          'provider-dataset.js',
          'provider-dataset-state.js',
        ].map((filename) => Fs.readFileSync(
            Path.join(commonDirectory, filename),
            'utf8',
        )).join('\n');

        Chai.expect(sources).not.to.match(/\b(?:chrome|browser)\s*\./);
        Chai.expect(sources).not.to.match(
            /\b(?:indexedDB|localStorage|sessionStorage)\b/,
        );
        Chai.expect(sources).not.to.match(/\brequire\s*\(/);
        Chai.expect(sources).not.to.match(
            /\b(?:eval|Function)\s*\(/,
        );

      });

});

Mocha.describe('provider dataset activation model', function() {

  let active;
  let authenticatedCandidate;
  let lkg;
  let packaged;
  let unauthenticatedCandidate;

  Mocha.before(async function() {

    active = await verify(versionedArtifact(
        'active.1',
        Dataset.TRUST.REMOTE_AUTHENTICATED,
    ));
    authenticatedCandidate = await verify(versionedArtifact(
        'candidate.2',
        Dataset.TRUST.REMOTE_AUTHENTICATED,
    ));
    lkg = await verify(versionedArtifact(
        'lkg.1',
        Dataset.TRUST.REMOTE_AUTHENTICATED,
    ));
    packaged = await verify(versionedArtifact(
        'packaged.1',
        Dataset.TRUST.PACKAGED_TRUSTED,
    ));
    unauthenticatedCandidate = await verify(versionedArtifact(
        'candidate.unauthenticated',
        Dataset.TRUST.REMOTE_UNAUTHENTICATED,
    ));

  });

  Mocha.it('makes an authenticated candidate eligible for atomic activation',
      function() {

        const plan = DatasetState.planDatasetActivation({
          protectionIntended: true,
          providerKey: PROVIDER_KEY,
          active,
          previousLkg: lkg,
          packagedBaseline: packaged,
          candidate: authenticatedCandidate,
        });

        Chai.expect(plan).to.deep.equal({
          kind: DatasetState.ACTIONS.ACTIVATE_CANDIDATE,
          selected: selectedRef(authenticatedCandidate),
          previousLkg: selectedRef(active),
        });

      });

  Mocha.it('keeps active data for an unauthenticated candidate', function() {

    const plan = DatasetState.planDatasetActivation({
      protectionIntended: true,
      providerKey: PROVIDER_KEY,
      active,
      previousLkg: lkg,
      packagedBaseline: packaged,
      candidate: unauthenticatedCandidate,
    });

    Chai.expect(plan).to.deep.equal({
      kind: DatasetState.ACTIONS.KEEP_ACTIVE,
      selected: selectedRef(active),
      previousLkg: selectedRef(lkg),
      candidateRejection: 'UNAUTHENTICATED_REMOTE_CANDIDATE',
    });

  });

  Mocha.it('keeps active data when a candidate hash is invalid', async function() {

    const invalidCandidate = await verify(createArtifact({
      trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
      envelopeOverrides: {artifactSha256: '0'.repeat(64)},
    }));
    const plan = DatasetState.planDatasetActivation({
      protectionIntended: true,
      providerKey: PROVIDER_KEY,
      active,
      previousLkg: lkg,
      packagedBaseline: packaged,
      candidate: invalidCandidate,
    });

    Chai.expect(plan).to.deep.equal({
      kind: DatasetState.ACTIONS.KEEP_ACTIVE,
      selected: selectedRef(active),
      previousLkg: selectedRef(lkg),
      candidateRejection: 'ARTIFACT_SHA256_MISMATCH',
    });

  });

  Mocha.it('keeps active data when external freshness policy rejects a candidate',
      function() {

        const staleCandidate = Object.assign({}, authenticatedCandidate, {
          usable: false,
          code: 'STALE_DATASET',
        });
        const plan = DatasetState.planDatasetActivation({
          protectionIntended: true,
          providerKey: PROVIDER_KEY,
          active,
          previousLkg: lkg,
          packagedBaseline: packaged,
          candidate: staleCandidate,
        });

        Chai.expect(plan).to.deep.equal({
          kind: DatasetState.ACTIONS.KEEP_ACTIVE,
          selected: selectedRef(active),
          previousLkg: selectedRef(lkg),
          candidateRejection: 'STALE_DATASET',
        });

      });

  Mocha.it('falls back from corrupt active data to previous LKG', function() {

    const plan = DatasetState.planDatasetActivation({
      protectionIntended: true,
      providerKey: PROVIDER_KEY,
      active: {ok: false, code: 'UNREADABLE_ACTIVE'},
      previousLkg: lkg,
      packagedBaseline: packaged,
    });

    Chai.expect(plan).to.deep.equal({
      kind: DatasetState.ACTIONS.USE_PREVIOUS_LKG,
      selected: selectedRef(lkg),
      candidateRejection: null,
    });

  });

  Mocha.it('falls back from corrupt active and LKG to packaged baseline',
      function() {

        const plan = DatasetState.planDatasetActivation({
          protectionIntended: true,
          providerKey: PROVIDER_KEY,
          active: {ok: false, code: 'UNREADABLE_ACTIVE'},
          previousLkg: {ok: false, code: 'UNREADABLE_LKG'},
          packagedBaseline: packaged,
        });

        Chai.expect(plan).to.deep.equal({
          kind: DatasetState.ACTIONS.USE_PACKAGED_BASELINE,
          selected: selectedRef(packaged),
          candidateRejection: null,
        });

      });

  Mocha.it('does not authorize malformed local verification state', function() {

    const malformedActive = {
      ok: true,
      status: 'VERIFIED',
      activationEligible: true,
      trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
      dataset: {identity: {}},
    };
    const plan = DatasetState.planDatasetActivation({
      protectionIntended: true,
      providerKey: PROVIDER_KEY,
      active: malformedActive,
      previousLkg: {ok: false, code: 'UNREADABLE_LKG'},
      packagedBaseline: packaged,
    });

    Chai.expect(plan).to.deep.equal({
      kind: DatasetState.ACTIONS.USE_PACKAGED_BASELINE,
      selected: selectedRef(packaged),
      candidateRejection: null,
    });

  });

  Mocha.it('keeps active data for a different-provider candidate',
      async function() {

        const otherProviderCandidate = await verify(createArtifact({
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
          envelopeOverrides: {providerKey: 'other-provider'},
        }));
        const plan = DatasetState.planDatasetActivation({
          protectionIntended: true,
          providerKey: PROVIDER_KEY,
          active,
          previousLkg: lkg,
          packagedBaseline: packaged,
          candidate: otherProviderCandidate,
        });

        Chai.expect(plan).to.deep.equal({
          kind: DatasetState.ACTIONS.KEEP_ACTIVE,
          selected: selectedRef(active),
          previousLkg: selectedRef(lkg),
          candidateRejection: 'PROVIDER_KEY_MISMATCH',
        });

      });

  Mocha.it('fails closed when protection has no usable dataset', function() {

    const plan = DatasetState.planDatasetActivation({
      protectionIntended: true,
      providerKey: PROVIDER_KEY,
      active: {ok: false, code: 'UNREADABLE_ACTIVE'},
      previousLkg: {ok: false, code: 'UNREADABLE_LKG'},
      packagedBaseline: {ok: false, code: 'UNREADABLE_PACKAGED'},
    });

    Chai.expect(plan).to.deep.equal({
      kind: DatasetState.ACTIONS.FAIL_CLOSED,
      code: 'NO_USABLE_PROVIDER_DATASET',
      candidateRejection: null,
    });
    Chai.expect(JSON.stringify(plan)).not.to.include('DIRECT');

  });

  Mocha.it('does not activate or fall back while protection is off', function() {

    const plan = DatasetState.planDatasetActivation({
      protectionIntended: false,
      providerKey: PROVIDER_KEY,
      active,
      previousLkg: lkg,
      packagedBaseline: packaged,
      candidate: authenticatedCandidate,
    });

    Chai.expect(plan).to.deep.equal({kind: DatasetState.ACTIONS.OFF});

  });

});
