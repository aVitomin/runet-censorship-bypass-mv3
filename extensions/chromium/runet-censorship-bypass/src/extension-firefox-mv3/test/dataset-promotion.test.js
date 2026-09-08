'use strict';

const Assert = require('node:assert');
const Config = require('../background/product-config');
const Promotion = require('../background/dataset-promotion');
const Store = require('../background/dataset-store');
const Helpers = require('./dataset-test-helpers');

function sha256(bytes) {

  return Promise.resolve(Helpers.sha256(Buffer.from(bytes)));

}

function routingConfig() {

  return {
    rules: {direct: [], proxy: [], whitelist: []},
    candidateGroups: {
      configured: {own: [], localTor: [], torBrowser: [], warp: []},
      onion: {own: [], localTor: [], torBrowser: [], warp: []},
      directReplacement: {own: [], localTor: [], torBrowser: [], warp: []},
    },
    flags: {
      noDirect: false,
      ownProxiesOnlyForOwnSites: true,
      replaceDirectWithProxy: false,
      useProviderProxies: true,
    },
    providerCandidates: [],
    providerFallback: 'DIRECT',
  };

}

function clone(value) {

  return value === undefined ? undefined : structuredClone(value);

}

function storage(initial = {}, options = {}) {

  const values = clone(initial);
  const writes = [];
  const removals = [];
  let setCalls = 0;
  return {
    values,
    writes,
    removals,
    area: {
      async get(keys) {

        const result = {};
        for (const key of keys) {
          if (Object.prototype.hasOwnProperty.call(values, key)) {
            result[key] = clone(values[key]);
          }
        }
        return result;

      },
      async set(update) {

        setCalls += 1;
        if (options.failSetCall === setCalls && !options.applyFailedSet) {
          throw new Error('synthetic storage failure');
        }
        Object.assign(values, clone(update));
        writes.push(clone(update));
        if (options.failSetCall === setCalls) {
          throw new Error('synthetic crash after storage write');
        }

      },
      async remove(key) {

        removals.push(key);
        if (options.failRemove === true) {
          throw new Error('synthetic remove failure');
        }
        delete values[key];

      },
    },
  };

}

function identity(item) {

  return {
    providerKey: item.envelope.providerKey,
    datasetVersion: item.envelope.datasetVersion,
    artifactSha256: item.envelope.artifactSha256,
  };

}

async function configFor(item) {

  return Config.createProductConfig({
    configurationKey: 'synthetic-production',
    configurationVersion: '1',
    datasetIdentity: identity(item),
    providerKey: item.envelope.providerKey,
    routingConfig: routingConfig(),
    sha256,
  });

}

async function system(options = {}) {

  const providerKey = options.providerKey || Helpers.PROVIDER_KEY;
  const oldArtifact = options.oldArtifact || Helpers.artifact({
    providerKey,
    datasetVersion: 'old-v1',
  });
  const nextArtifact = options.nextArtifact || Helpers.artifact({
    providerKey,
    datasetVersion: 'new-v2',
    payload: Helpers.payload([{
      width: 12,
      routeRef: 'PROVIDER_DIRECT',
      hosts: 'next.example',
    }]),
    trust: Helpers.Dataset.TRUST.REMOTE_AUTHENTICATED,
  });
  const backend = options.backend || Helpers.memoryBackend();
  const datasetStore = Store.createStore({backend, sha256});
  await datasetStore.commitPackagedBaseline(oldArtifact);
  if (options.stage !== false) {
    const staged = await datasetStore.stageAuthenticatedCandidate({
      envelope: nextArtifact.envelope,
      artifactBytes: nextArtifact.artifactBytes,
      sequence: options.sequence || 2,
    });
    Assert.strictEqual(staged.ok, true);
  }
  const oldConfig = await configFor(oldArtifact);
  const credentialSentinel = {
    schemaVersion: 1,
    routingDescriptor: oldConfig.routingDescriptor,
    entries: [],
  };
  const settingsSentinel = {
    schemaVersion: 1,
    revision: 7,
    routingDescriptor: oldConfig.routingDescriptor,
    settings: {sentinel: 'unchanged'},
  };
  const storageStore = options.storage || storage({
    [Config.CONFIG_STORAGE_KEY]: oldConfig,
    [Config.CREDENTIALS_STORAGE_KEY]: credentialSentinel,
    [Config.SETTINGS_COMMIT_STORAGE_KEY]: settingsSentinel,
  }, options.storageOptions);
  let activation = options.activation || {
    active: false,
    durableIntent: 'OFF',
    runtimeState: 'OFF',
  };
  const controller = Promotion.createController({
    storageArea: storageStore.area,
    datasetStore: options.datasetStore || datasetStore,
    sha256,
    activationSnapshot: () => activation,
    providerKey,
  });
  return {
    backend,
    controller,
    datasetStore,
    nextArtifact,
    oldArtifact,
    oldConfig,
    setActivation(value) {

      activation = value;

    },
    storage: storageStore,
    credentialSentinel,
    settingsSentinel,
  };

}

async function rejectsCode(operation, code) {

  await Assert.rejects(operation, (error) => error && error.code === code);

}

describe('Firefox crash-safe authenticated dataset promotion', function() {

  it('installs only the exact verified authenticated staged candidate', async function() {

    const value = await system();
    const result = await value.controller.install();
    const loaded = await value.datasetStore.loadVerifications(
        Helpers.PROVIDER_KEY,
    );

    Assert.deepStrictEqual(result, {ok: true, status: 'INSTALLED'});
    Assert.strictEqual(loaded.active.dataset.identity.artifactSha256,
        value.nextArtifact.envelope.artifactSha256);
    Assert.strictEqual(loaded.previousLkg.dataset.identity.artifactSha256,
        value.oldArtifact.envelope.artifactSha256);
    Assert.strictEqual(
        value.storage.values[Config.CONFIG_STORAGE_KEY].datasetIdentity
            .artifactSha256,
        value.nextArtifact.envelope.artifactSha256,
    );
    Assert.deepStrictEqual(
        value.storage.values[Config.CREDENTIALS_STORAGE_KEY],
        value.credentialSentinel,
    );
    Assert.deepStrictEqual(
        value.storage.values[Config.SETTINGS_COMMIT_STORAGE_KEY],
        value.settingsSentinel,
    );
    Assert.strictEqual(
        Config.DATASET_PROMOTION_STORAGE_KEY in value.storage.values,
        false,
    );

  });

  for (const runtimeState of ['INITIALIZING', 'READY', 'FAILED']) {
    it(`rejects ${runtimeState} without touching pointers or proxy state`, async function() {

      const value = await system({
        activation: {
          active: runtimeState === 'READY',
          durableIntent: runtimeState === 'READY' ? 'ON' : 'OFF',
          runtimeState,
        },
      });
      await rejectsCode(
          value.controller.install(),
          Promotion.ERRORS.OFF_REQUIRED,
      );
      Assert.strictEqual(value.backend.commits.length, 2);
      Assert.strictEqual(value.storage.writes.length, 0);

    });
  }

  it('rejects an empty staged pointer', async function() {

    const value = await system({stage: false});
    await rejectsCode(
        value.controller.install(),
        Promotion.ERRORS.NO_STAGED_CANDIDATE,
    );

  });

  it('rejects a corrupt staged artifact without changing configuration', async function() {

    const value = await system();
    value.backend.artifacts.get(value.nextArtifact.envelope.artifactSha256)
        .artifactBytes[0] ^= 1;
    await rejectsCode(
        value.controller.install(),
        Promotion.ERRORS.NO_STAGED_CANDIDATE,
    );
    Assert.deepStrictEqual(
        value.storage.values[Config.CONFIG_STORAGE_KEY],
        value.oldConfig,
    );

  });

  it('rejects provider disagreement before journaling', async function() {

    const value = await system();
    const mismatched = Promotion.createController({
      storageArea: value.storage.area,
      datasetStore: value.datasetStore,
      sha256,
      activationSnapshot: () => ({
        active: false, durableIntent: 'OFF', runtimeState: 'OFF',
      }),
      providerKey: 'another-provider',
    });
    await rejectsCode(
        mismatched.install(),
        Promotion.ERRORS.PROVIDER_MISMATCH,
    );

  });

  it('rejects interrupted settings state before journaling', async function() {

    const value = await system();
    value.storage.values[Config.SETTINGS_TRANSACTION_STORAGE_KEY] = {
      schemaVersion: 1, status: 'WRITING',
    };
    await rejectsCode(
        value.controller.install(),
        Promotion.ERRORS.CONFIGURATION_INVALID,
    );

  });

  it('rejects a missing current pointer selection', async function() {

    const value = await system();
    value.storage.values[Config.CONFIG_STORAGE_KEY] = await configFor(
        Helpers.artifact({datasetVersion: 'missing-old'}),
    );
    await rejectsCode(
        value.controller.install(),
        Promotion.ERRORS.DATASET_STORE_FAILED,
    );

  });

  it('changes neither pointers nor config when the journal write fails',
      async function() {

        const value = await system({
          storageOptions: {failSetCall: 1, applyFailedSet: false},
        });
        await rejectsCode(
            value.controller.install(),
            Promotion.ERRORS.STORAGE_FAILED,
        );
        const loaded = await value.datasetStore.loadVerifications(
            Helpers.PROVIDER_KEY,
        );
        Assert.strictEqual(loaded.active, null);
        Assert.deepStrictEqual(
            value.storage.values[Config.CONFIG_STORAGE_KEY],
            value.oldConfig,
        );

      });

  it('rolls back the journal after an IndexedDB pointer failure',
      async function() {

        const backend = Helpers.memoryBackend();
        const commit = backend.commit;
        backend.commit = async (artifact, pointers) => {

          if (backend.commits.length === 2) {
            throw new Error('synthetic IndexedDB abort');
          }
          return commit(artifact, pointers);

        };
        const value = await system({backend});
        await rejectsCode(
            value.controller.install(),
            Promotion.ERRORS.DATASET_STORE_FAILED,
        );
        Assert.strictEqual(
            Config.DATASET_PROMOTION_STORAGE_KEY in value.storage.values,
            false,
        );
        Assert.deepStrictEqual(
            value.storage.values[Config.CONFIG_STORAGE_KEY],
            value.oldConfig,
        );

      });

  it('rolls forward if the first post-pointer config write is interrupted',
      async function() {

        const value = await system({
          storageOptions: {failSetCall: 2, applyFailedSet: false},
        });
        Assert.deepStrictEqual(await value.controller.install(), {
          ok: true, status: 'INSTALLED',
        });
        Assert.strictEqual(
            value.storage.values[Config.CONFIG_STORAGE_KEY]
                .datasetIdentity.artifactSha256,
            value.nextArtifact.envelope.artifactSha256,
        );
        Assert.strictEqual(
            Config.DATASET_PROMOTION_STORAGE_KEY in value.storage.values,
            false,
        );

      });

  it('rejects unauthenticated or stale staged metadata before journaling',
      async function() {

        const value = await system();
        for (const staged of [
          {
            ok: true,
            status: 'STAGED',
            sequence: 2,
            pointers: {},
            verification: {ok: true, trust: 'UNAUTHENTICATED_REMOTE'},
          },
          {
            ok: true,
            status: 'STAGED',
            sequence: 2,
            pointers: {
              highestAuthenticatedSequence: 3,
              highestAuthenticatedArtifactSha256:
                value.nextArtifact.envelope.artifactSha256,
            },
            verification: {
              ok: true,
              trust: Helpers.Dataset.TRUST.REMOTE_AUTHENTICATED,
              dataset: {identity: identity(value.nextArtifact)},
            },
          },
        ]) {
          const fakeStore = {
            loadStaged: async () => staged,
            loadVerifications: value.datasetStore.loadVerifications,
            promoteStagedExact: async () => {
              throw new Error('must not promote');
            },
          };
          const api = Promotion.createController({
            storageArea: value.storage.area,
            datasetStore: fakeStore,
            sha256,
            activationSnapshot: () => ({
              active: false, durableIntent: 'OFF', runtimeState: 'OFF',
            }),
            providerKey: Helpers.PROVIDER_KEY,
          });
          await rejectsCode(
              api.install(),
              staged.verification.trust === 'UNAUTHENTICATED_REMOTE' ?
                Promotion.ERRORS.NO_STAGED_CANDIDATE :
                Promotion.ERRORS.SEQUENCE_INVALID,
          );
        }

      });

  it('rolls back a journal written before pointer promotion', async function() {

    const crashedStorage = storage({}, {
      failSetCall: 1,
      applyFailedSet: true,
    });
    const first = await system({storage: crashedStorage});
    crashedStorage.values[Config.CONFIG_STORAGE_KEY] = first.oldConfig;
    await rejectsCode(first.controller.install(), Promotion.ERRORS.STORAGE_FAILED);
    Assert.strictEqual(
        Config.DATASET_PROMOTION_STORAGE_KEY in crashedStorage.values,
        true,
    );
    const restarted = Promotion.createController({
      storageArea: crashedStorage.area,
      datasetStore: first.datasetStore,
      sha256,
      activationSnapshot: () => ({
        active: false, durableIntent: 'OFF', runtimeState: 'OFF',
      }),
      providerKey: Helpers.PROVIDER_KEY,
    });
    Assert.deepStrictEqual(await restarted.initialize(), {
      ok: true, status: 'ROLLED_BACK',
    });
    Assert.strictEqual(
        Config.DATASET_PROMOTION_STORAGE_KEY in crashedStorage.values,
        false,
    );

  });

  it('rolls forward from promoted pointers and old config after a crash', async function() {

    const completed = await system();
    await completed.controller.install();
    const journal = completed.storage.writes[0][
        Config.DATASET_PROMOTION_STORAGE_KEY
    ];
    const crashStorage = storage({
      [Config.CONFIG_STORAGE_KEY]: journal.oldConfig,
      [Config.DATASET_PROMOTION_STORAGE_KEY]: journal,
    });
    const restarted = Promotion.createController({
      storageArea: crashStorage.area,
      datasetStore: completed.datasetStore,
      sha256,
      activationSnapshot: () => ({
        active: false, durableIntent: 'OFF', runtimeState: 'OFF',
      }),
      providerKey: Helpers.PROVIDER_KEY,
    });
    Assert.deepStrictEqual(await restarted.initialize(), {
      ok: true, status: 'ROLLED_FORWARD',
    });
    Assert.deepStrictEqual(
        crashStorage.values[Config.CONFIG_STORAGE_KEY],
        journal.newConfig,
    );

  });

  it('finishes a crash after the new config write by removing only the journal', async function() {

    const completed = await system();
    await completed.controller.install();
    const journal = completed.storage.writes[0][
        Config.DATASET_PROMOTION_STORAGE_KEY
    ];
    const crashStorage = storage({
      [Config.CONFIG_STORAGE_KEY]: journal.newConfig,
      [Config.DATASET_PROMOTION_STORAGE_KEY]: journal,
    });
    const restarted = Promotion.createController({
      storageArea: crashStorage.area,
      datasetStore: completed.datasetStore,
      sha256,
      activationSnapshot: () => ({
        active: false, durableIntent: 'OFF', runtimeState: 'OFF',
      }),
      providerKey: Helpers.PROVIDER_KEY,
    });
    Assert.strictEqual((await restarted.initialize()).status, 'ROLLED_FORWARD');
    Assert.strictEqual(crashStorage.writes.length, 0);

  });

  it('leaves a strict recovery marker when journal removal fails', async function() {

    const value = await system({
      storageOptions: {failRemove: true},
    });
    await rejectsCode(
        value.controller.install(),
        Promotion.ERRORS.RECOVERY_REQUIRED,
    );
    Assert.strictEqual(
        Config.DATASET_PROMOTION_STORAGE_KEY in value.storage.values,
        true,
    );

  });

  it('serializes duplicate install requests and never promotes twice', async function() {

    const value = await system();
    const [first, second] = await Promise.allSettled([
      value.controller.install(),
      value.controller.install(),
    ]);
    Assert.strictEqual(first.status, 'fulfilled');
    Assert.strictEqual(second.status, 'rejected');
    Assert.strictEqual(second.reason.code,
        Promotion.ERRORS.NO_STAGED_CANDIDATE);
    Assert.strictEqual(value.backend.commits.length, 3);

  });

  it('blocks product activation while a journal exists', async function() {

    const value = await system();
    await value.controller.install();
    const journal = value.storage.writes[0][
        Config.DATASET_PROMOTION_STORAGE_KEY
    ];
    value.storage.values[Config.DATASET_PROMOTION_STORAGE_KEY] = journal;
    const loader = Config.createActivationFactory({
      storageArea: value.storage.area,
      createDatasetStore: () => value.datasetStore,
      sha256,
    });
    await rejectsCode(loader(), Config.ERRORS.PRODUCT_CONFIG_UPDATE_INCOMPLETE);

  });

  it('rejects malformed journals without guessing old or new state', async function() {

    const value = await system();
    value.storage.values[Config.DATASET_PROMOTION_STORAGE_KEY] = {
      schemaVersion: 99,
    };
    const result = await value.controller.initialize();
    Assert.deepStrictEqual(result, {
      ok: false,
      status: 'RECOVERY_REQUIRED',
      code: Promotion.ERRORS.RECOVERY_REQUIRED,
    });

  });

});
