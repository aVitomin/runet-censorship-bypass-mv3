'use strict';

const Assert = require('node:assert');
const Crypto = require('node:crypto');
const Updater = require('../background/provider-updater');
const Store = require('../background/dataset-store');
const {
  Dataset,
  PROVIDER_KEY,
  artifact,
  memoryBackend,
  payload,
  sha256,
} = require('./dataset-test-helpers');

const MANIFEST_URL = 'https://updates.example/releases/manifest.json';
const SIGNATURE_URL = `${MANIFEST_URL}.sig`;
const ARTIFACT_URL = 'https://updates.example/releases/v2.json';
const KEY_ID = 'synthetic-key-1';

function updateArtifact(version, host = 'next.example') {

  return artifact({
    datasetVersion: version,
    payload: payload([{
      width: host.length,
      routeRef: 'PROVIDER_PROXY',
      hosts: host,
    }]),
    trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
  });

}

function stream(bytes, chunkSize = bytes.byteLength || 1) {

  let offset = 0;
  return {
    getReader() {

      return {
        async cancel() {},
        async read() {

          if (offset >= bytes.byteLength) {
            return {done: true};
          }
          const end = Math.min(bytes.byteLength, offset + chunkSize);
          const value = bytes.slice(offset, end);
          offset = end;
          return {done: false, value};

        },
      };

    },
  };

}

function response(url, bytes, options = {}) {

  const headers = new Map(Object.entries(options.headers || {}).map(
      ([key, value]) => [key.toLowerCase(), String(value)],
  ));
  return {
    status: options.status === undefined ? 200 : options.status,
    redirected: options.redirected === true,
    url: options.reportedUrl === undefined ? url : options.reportedUrl,
    headers: {get: (name) => headers.get(name.toLowerCase()) || null},
    body: stream(bytes || new Uint8Array(), options.chunkSize),
  };

}

function fakeNetwork(routes) {

  const calls = [];
  return {
    calls,
    async fetch(url, options) {

      calls.push({url, options});
      const route = routes.get(url);
      if (typeof route === 'function') {
        return route(url, options);
      }
      if (!route) {
        throw new Error('unexpected synthetic URL');
      }
      return response(url, route.bytes, route);

    },
  };

}

function pointersSnapshot(backend) {

  return structuredClone(backend.pointers.get(PROVIDER_KEY));

}

describe('Firefox authenticated provider update pipeline', function() {

  let keyPair;
  let publicKeyBytes;

  before(async function() {

    keyPair = await Crypto.webcrypto.subtle.generateKey(
        {name: 'Ed25519'},
        true,
        ['sign', 'verify'],
    );
    publicKeyBytes = new Uint8Array(await Crypto.webcrypto.subtle.exportKey(
        'raw',
        keyPair.publicKey,
    ));

  });

  async function bundle(options = {}) {

    const candidate = options.candidate || updateArtifact(
        '2026.09.06-test.2',
    );
    const manifest = Object.assign({
      schemaVersion: Updater.MANIFEST_SCHEMA_VERSION,
      providerKey: PROVIDER_KEY,
      sequence: options.sequence || 2,
      keyId: options.keyId || KEY_ID,
      artifactPath: 'v2.json',
      envelope: candidate.envelope,
    }, options.manifestOverrides);
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const signatureBytes = new Uint8Array(await Crypto.webcrypto.subtle.sign(
        {name: 'Ed25519'},
        options.privateKey || keyPair.privateKey,
        manifestBytes,
    ));
    return {candidate, manifest, manifestBytes, signatureBytes};

  }

  async function setup(options = {}) {

    const backend = options.backend || memoryBackend();
    const store = Store.createStore({backend, sha256});
    if (options.seed !== false) {
      await store.activateCandidate(updateArtifact(
          '2026.09.06-test.0',
          'zero.example',
      ));
      await store.activateCandidate(updateArtifact(
          '2026.09.06-test.1',
          'beta.example',
      ));
    }
    const signed = options.signed || await bundle(options);
    const routes = options.routes || new Map([
      [MANIFEST_URL, {bytes: signed.manifestBytes}],
      [SIGNATURE_URL, {bytes: signed.signatureBytes}],
      [ARTIFACT_URL, {bytes: signed.candidate.artifactBytes, chunkSize: 7}],
    ]);
    const network = fakeNetwork(routes);
    const updater = Updater.createUpdater({
      AbortController,
      cryptoSubtle: Crypto.webcrypto.subtle,
      deadlineMs: options.deadlineMs || 1000,
      fetchImpl: network.fetch,
      sha256,
      store,
      trustedPublicKeys: options.trustedPublicKeys ||
        new Map([[KEY_ID, publicKeyBytes]]),
    });
    return {backend, network, signed, store, updater};

  }

  async function fetchAndStage(context, input = {}) {

    return context.updater.fetchAndStage(Object.assign({
      manifestUrl: MANIFEST_URL,
      providerKey: PROVIDER_KEY,
    }, input));

  }

  it('verifies exact signed bytes and stages without changing active or LKG',
      async function() {

        const context = await setup();
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context);
        const after = pointersSnapshot(context.backend);

        Assert.strictEqual(result.ok, true);
        Assert.strictEqual(result.status, 'STAGED');
        Assert.strictEqual(after.activeArtifactSha256,
            before.activeArtifactSha256);
        Assert.strictEqual(after.previousLkgArtifactSha256,
            before.previousLkgArtifactSha256);
        Assert.strictEqual(after.stagedArtifactSha256,
            context.signed.candidate.envelope.artifactSha256);
        Assert.strictEqual(after.highestAuthenticatedSequence, 2);
        Assert.strictEqual(
            context.signed.manifest.trust,
            undefined,
        );
        Assert.deepStrictEqual(context.network.calls.map((call) => call.url), [
          MANIFEST_URL,
          SIGNATURE_URL,
          ARTIFACT_URL,
        ]);
        context.network.calls.forEach((call) => {
          Assert.strictEqual(call.options.redirect, 'manual');
          Assert.strictEqual(call.options.credentials, 'omit');
          Assert.strictEqual(call.options.referrerPolicy, 'no-referrer');
        });

      });

  it('promotes staged data atomically and rotates active into LKG',
      async function() {

        const context = await setup();
        const before = pointersSnapshot(context.backend);
        await fetchAndStage(context);
        const result = await context.store.promoteStaged(PROVIDER_KEY);
        const after = pointersSnapshot(context.backend);

        Assert.strictEqual(result.status, 'PROMOTED');
        Assert.strictEqual(after.activeArtifactSha256,
            context.signed.candidate.envelope.artifactSha256);
        Assert.strictEqual(after.previousLkgArtifactSha256,
            before.activeArtifactSha256);
        Assert.strictEqual(after.stagedArtifactSha256, null);
        Assert.strictEqual(after.stagedSequence, null);
        Assert.strictEqual(after.highestAuthenticatedSequence, 2);
        Assert.strictEqual(
            context.backend.commits.at(-1).artifactSha256,
            null,
        );

      });

  it('migrates v1 pointers without losing active, LKG, or baseline',
      function() {

        const legacy = {
          schemaVersion: 1,
          providerKey: PROVIDER_KEY,
          activeArtifactSha256: 'a'.repeat(64),
          previousLkgArtifactSha256: 'b'.repeat(64),
          packagedBaselineArtifactSha256: 'c'.repeat(64),
        };
        const normalized = Store.normalizePointers(legacy, PROVIDER_KEY);

        Assert.strictEqual(normalized.migratedFromSchemaVersion, 1);
        Assert.deepStrictEqual(normalized.pointers, {
          schemaVersion: 2,
          providerKey: PROVIDER_KEY,
          activeArtifactSha256: 'a'.repeat(64),
          previousLkgArtifactSha256: 'b'.repeat(64),
          packagedBaselineArtifactSha256: 'c'.repeat(64),
          stagedArtifactSha256: null,
          stagedSequence: null,
          highestAuthenticatedSequence: null,
          highestAuthenticatedArtifactSha256: null,
        });

      });

  async function rejectedWithoutPointerChanges(mutator, expectedCode) {

    const context = await setup();
    const before = pointersSnapshot(context.backend);
    await mutator(context);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.ok, false);
    Assert.strictEqual(result.code, expectedCode);
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  }

  it('rejects a bad detached signature', async function() {

    await rejectedWithoutPointerChanges((context) => {
      context.signed.signatureBytes.fill(0);
    }, 'INVALID_UPDATE_SIGNATURE');

  });

  it('rejects an unknown keyId without trusting manifest content',
      async function() {

        const signed = await bundle({keyId: 'unknown-key'});
        const context = await setup({signed});
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context);

        Assert.strictEqual(result.code, 'UNKNOWN_UPDATE_KEY_ID');
        Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

      });

  it('rejects any manifest-byte modification after signing', async function() {

    const signed = await bundle();
    signed.manifestBytes = new TextEncoder().encode(
        `${new TextDecoder().decode(signed.manifestBytes)} `,
    );
    const context = await setup({signed});
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'INVALID_UPDATE_SIGNATURE');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  it('rejects a modified artifact', async function() {

    await rejectedWithoutPointerChanges((context) => {
      context.signed.candidate.artifactBytes[0] ^= 1;
    }, 'ARTIFACT_SHA256_MISMATCH');

  });

  it('rejects a signed wrong artifact byte count', async function() {

    const base = updateArtifact('wrong-count', 'count.example');
    const signed = await bundle({candidate: base, manifestOverrides: {
      envelope: Object.assign({}, base.envelope, {
        artifactByteCount: base.envelope.artifactByteCount + 1,
      }),
    }});
    const context = await setup({signed});
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'ARTIFACT_BYTE_COUNT_MISMATCH');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  it('rejects provider identity mismatch at the signed manifest boundary',
      async function() {

        const signed = await bundle({manifestOverrides: {
          providerKey: 'different-provider',
        }});
        const context = await setup({signed});
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context);

        Assert.strictEqual(result.code, 'UPDATE_PROVIDER_KEY_MISMATCH');
        Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

      });

  it('rejects signed envelope/provider disagreement', async function() {

    const candidate = updateArtifact('wrong-provider', 'wrong.example');
    const signed = await bundle({candidate, manifestOverrides: {
      envelope: Object.assign({}, candidate.envelope, {
        providerKey: 'different-provider',
      }),
    }});
    const context = await setup({signed});
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'UPDATE_ENVELOPE_PROVIDER_MISMATCH');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  it('rejects a signed dataset with an unsupported schema', async function() {

    const candidate = updateArtifact('bad-schema', 'schema.example');
    const signed = await bundle({candidate, manifestOverrides: {
      envelope: Object.assign({}, candidate.envelope, {schemaVersion: 2}),
    }});
    const context = await setup({signed});
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'UNSUPPORTED_SCHEMA_VERSION');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  it('rejects oversized streamed artifacts before storage', async function() {

    const context = await setup();
    context.signed.candidate.artifactBytes = new Uint8Array(1);
    const route = new Map([
      [MANIFEST_URL, {bytes: context.signed.manifestBytes}],
      [SIGNATURE_URL, {bytes: context.signed.signatureBytes}],
      [ARTIFACT_URL, {
        bytes: new Uint8Array(1),
        headers: {'content-length': Dataset.LIMITS.MAX_ARTIFACT_BYTES + 1},
      }],
    ]);
    context.network = fakeNetwork(route);
    context.updater = Updater.createUpdater({
      AbortController,
      cryptoSubtle: Crypto.webcrypto.subtle,
      fetchImpl: context.network.fetch,
      sha256,
      store: context.store,
      trustedPublicKeys: new Map([[KEY_ID, publicKeyBytes]]),
    });
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'ARTIFACT_TOO_LARGE');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  for (const [name, location] of [
    ['HTTP', 'http://updates.example/elsewhere'],
    ['cross-origin', 'https://other.example/elsewhere'],
  ]) {
    it(`rejects a ${name} redirect`, async function() {

      const context = await setup();
      const routes = new Map([
        [MANIFEST_URL, {
          status: 302,
          headers: {location},
          bytes: new Uint8Array(),
        }],
      ]);
      context.network = fakeNetwork(routes);
      context.updater = Updater.createUpdater({
        AbortController,
        cryptoSubtle: Crypto.webcrypto.subtle,
        fetchImpl: context.network.fetch,
        sha256,
        store: context.store,
        trustedPublicKeys: new Map([[KEY_ID, publicKeyBytes]]),
      });
      const before = pointersSnapshot(context.backend);
      const result = await fetchAndStage(context);

      Assert.strictEqual(result.code, 'UNSAFE_UPDATE_REDIRECT');
      Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

    });
  }

  it('rejects more than three same-origin redirects', async function() {

    const context = await setup();
    const routes = new Map();
    let current = MANIFEST_URL;
    for (let index = 1; index <= 4; index += 1) {
      const next = `https://updates.example/releases/redirect-${index}.json`;
      routes.set(current, {
        status: 302,
        headers: {location: next},
        bytes: new Uint8Array(),
      });
      current = next;
    }
    context.network = fakeNetwork(routes);
    context.updater = Updater.createUpdater({
      AbortController,
      cryptoSubtle: Crypto.webcrypto.subtle,
      fetchImpl: context.network.fetch,
      sha256,
      store: context.store,
      trustedPublicKeys: new Map([[KEY_ID, publicKeyBytes]]),
    });
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'TOO_MANY_UPDATE_REDIRECTS');
    Assert.strictEqual(context.network.calls.length, 4);
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  it('rejects manifest URLs containing credentials before fetching',
      async function() {

        const context = await setup();
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context, {
          manifestUrl: 'https://user:secret@updates.example/manifest.json',
        });

        Assert.strictEqual(result.code, 'UNSAFE_MANIFEST_URL');
        Assert.strictEqual(context.network.calls.length, 0);
        Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

      });

  it('rejects malformed UTF-8 manifest bytes before any trust assignment',
      async function() {

        const context = await setup();
        const routes = new Map([
          [MANIFEST_URL, {bytes: new Uint8Array([0xc3, 0x28])}],
        ]);
        context.network = fakeNetwork(routes);
        context.updater = Updater.createUpdater({
          AbortController,
          cryptoSubtle: Crypto.webcrypto.subtle,
          fetchImpl: context.network.fetch,
          sha256,
          store: context.store,
          trustedPublicKeys: new Map([[KEY_ID, publicKeyBytes]]),
        });
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context);

        Assert.strictEqual(result.code, 'INVALID_MANIFEST_UTF8');
        Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

      });

  it('aborts and rejects a request at the configured deadline',
      async function() {

        const context = await setup({deadlineMs: 5});
        context.updater = Updater.createUpdater({
          AbortController,
          cryptoSubtle: Crypto.webcrypto.subtle,
          deadlineMs: 5,
          fetchImpl: () => new Promise(() => {}),
          sha256,
          store: context.store,
          trustedPublicKeys: new Map([[KEY_ID, publicKeyBytes]]),
        });
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context);

        Assert.strictEqual(result.code, 'UPDATE_TIMEOUT');
        Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

      });

  it('rejects lower authenticated sequence without replacing staged data',
      async function() {

        const context = await setup();
        const higher = updateArtifact('higher', 'higher.example');
        await context.store.stageAuthenticatedCandidate({
          envelope: higher.envelope,
          artifactBytes: higher.artifactBytes,
          sequence: 5,
        });
        const before = pointersSnapshot(context.backend);
        const result = await fetchAndStage(context);

        Assert.strictEqual(result.code, 'ROLLBACK_REJECTED');
        Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

      });

  it('treats the same sequence and artifact as idempotent', async function() {

    const context = await setup();
    const first = await fetchAndStage(context);
    const commitCount = context.backend.commits.length;
    const second = await fetchAndStage(context);

    Assert.strictEqual(first.status, 'STAGED');
    Assert.strictEqual(second.status, 'UNCHANGED');
    Assert.strictEqual(context.backend.commits.length, commitCount);

  });

  it('rejects the same sequence with a different artifact', async function() {

    const context = await setup();
    const other = updateArtifact('other', 'other.example');
    await context.store.stageAuthenticatedCandidate({
      envelope: other.envelope,
      artifactBytes: other.artifactBytes,
      sequence: 2,
    });
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'SEQUENCE_CONFLICT');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

  it('serializes concurrent pointer mutations against rollback races',
      async function() {

        const backend = memoryBackend();
        const originalCommit = backend.commit;
        backend.commit = async (nextArtifact, nextPointers) => {
          if (nextPointers.highestAuthenticatedSequence === 2) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return originalCommit(nextArtifact, nextPointers);
        };
        const store = Store.createStore({backend, sha256});
        const sequenceTwo = updateArtifact('sequence-two', 'two.example');
        const sequenceThree = updateArtifact(
            'sequence-three',
            'three.example',
        );
        const [first, second] = await Promise.all([
          store.stageAuthenticatedCandidate({
            envelope: sequenceTwo.envelope,
            artifactBytes: sequenceTwo.artifactBytes,
            sequence: 2,
          }),
          store.stageAuthenticatedCandidate({
            envelope: sequenceThree.envelope,
            artifactBytes: sequenceThree.artifactBytes,
            sequence: 3,
          }),
        ]);
        const pointers = pointersSnapshot(backend);

        Assert.strictEqual(first.status, 'STAGED');
        Assert.strictEqual(second.status, 'STAGED');
        Assert.strictEqual(pointers.highestAuthenticatedSequence, 3);
        Assert.strictEqual(
            pointers.stagedArtifactSha256,
            sequenceThree.envelope.artifactSha256,
        );

      });

  it('does not advance pointers when the atomic store commit fails',
      async function() {

        const backend = memoryBackend();
        const context = await setup({backend});
        const before = pointersSnapshot(backend);
        const originalCommit = backend.commit;
        backend.commit = async () => {
          const error = new Error('synthetic write failure');
          error.code = 'INDEXED_DB_COMMIT_ABORTED';
          throw error;
        };
        const result = await fetchAndStage(context);

        Assert.strictEqual(result.code, 'INDEXED_DB_COMMIT_ABORTED');
        Assert.deepStrictEqual(pointersSnapshot(backend), before);
        backend.commit = originalCommit;

      });

  it('rejects remote trust claims as unknown manifest fields', async function() {

    const signed = await bundle({manifestOverrides: {
      trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
    }});
    const context = await setup({signed});
    const before = pointersSnapshot(context.backend);
    const result = await fetchAndStage(context);

    Assert.strictEqual(result.code, 'INVALID_UPDATE_MANIFEST');
    Assert.deepStrictEqual(pointersSnapshot(context.backend), before);

  });

});
