'use strict';

const Assert = require('node:assert');
const Activation = require('../background/activation-controller');
const DatasetStore = require('../background/dataset-store');
const OffState = require('../background/off-state');
const ProxyAuth = require('../background/proxy-auth');
const ProxyControl = require('../background/proxy-control');
const Routing = require('../../extension-mv3-common/routing-contract');
const RoutingAdapter = require('../background/routing-adapter');
const Helpers = require('./dataset-test-helpers');

function floor(port = 55031) {

  return {
    proxyType: 'manual',
    http: '',
    httpProxyAll: false,
    ssl: '',
    socks: `127.0.0.1:${port}`,
    socksVersion: 5,
    proxyDNS: true,
    passthrough: '',
    autoConfigUrl: '',
  };

}

function datasetIdentity(artifact = Helpers.artifact()) {

  return {
    providerKey: artifact.envelope.providerKey,
    datasetVersion: artifact.envelope.datasetVersion,
    artifactSha256: artifact.envelope.artifactSha256,
  };

}

function routingDescriptor() {

  return {
    schemaVersion: OffState.ROUTING_DESCRIPTOR_SCHEMA_VERSION,
    configurationKey: 'synthetic-routing',
    configurationVersion: '1',
    configurationSha256: 'b'.repeat(64),
  };

}

function onState(identity = floor(), artifact = Helpers.artifact()) {

  return OffState.canonicalOnState({
    floorIdentity: identity,
    providerKey: artifact.envelope.providerKey,
    datasetIdentity: datasetIdentity(artifact),
    routingDescriptor: routingDescriptor(),
  });

}

function candidate(overrides = {}) {

  return Object.assign({
    id: 'synthetic-proxy',
    type: 'HTTP',
    host: '127.0.0.1',
    port: 18080,
    proxyDNS: false,
    authRef: null,
    failoverTimeoutSeconds: null,
  }, overrides);

}

function baseInputForRequest(proxyCandidate = candidate()) {

  return (details) => ({
    hostname: new URL(details.url).hostname,
    rules: {},
    candidateGroups: {},
    flags: {},
    providerCandidates: [proxyCandidate],
    providerFallback: Routing.FALLBACKS.DIRECT,
  });

}

async function verifiedStore(artifact = Helpers.artifact()) {

  const store = DatasetStore.createStore({
    backend: Helpers.memoryBackend(),
    sha256: async (bytes) => Helpers.sha256(Buffer.from(bytes)),
  });
  Assert.strictEqual((await store.commitPackagedBaseline(artifact)).ok, true);
  return store;

}

function prepared(store, artifact = Helpers.artifact(), overrides = {}) {

  return Object.assign({
    datasetIdentity: datasetIdentity(artifact),
    datasetStore: store,
    providerKey: artifact.envelope.providerKey,
    resolveCredentials: () => null,
    routingBaseInputForRequest: baseInputForRequest(),
    routingDescriptor: routingDescriptor(),
  }, overrides);

}

function memoryStorage(initialState, events = [], options = {}) {

  const values = initialState === undefined ? {} : {
    [OffState.STORAGE_KEY]: structuredClone(initialState),
  };
  return {
    values,
    async get(key) {

      events.push('storage-get');
      if (options.getError) {
        throw options.getError;
      }
      return Object.prototype.hasOwnProperty.call(values, key) ?
        {[key]: structuredClone(values[key])} : {};

    },
    async set(update) {

      const next = update[OffState.STORAGE_KEY];
      events.push(`storage-set-${next && next.intent || 'unknown'}`);
      if (options.failOnIntent === (next && next.intent) ||
          (typeof options.shouldFailSet === 'function' &&
            options.shouldFailSet(next))) {
        throw new Error('synthetic storage write failure');
      }
      Object.assign(values, structuredClone(update));
      if (typeof options.afterSet === 'function') {
        options.afterSet(next);
      }

    },
  };

}

function createSystem(options = {}) {

  const events = options.events || [];
  const access = options.access || {allowed: true};
  const storageArea = options.storageArea || memoryStorage(
      options.durableState === undefined ?
        OffState.canonicalOffState() : options.durableState,
      events,
  );
  const previousSettings = options.previousSettings || {
    levelOfControl: 'controllable_by_this_extension',
    value: {proxyType: 'none'},
  };
  let liveSettings = options.liveSettings || previousSettings;
  const proxyCalls = {clear: 0, get: 0, set: 0};
  let floorGenerations = 0;
  const proxySettings = {
    async clear() {

      events.push('proxy-clear');
      proxyCalls.clear += 1;
      if (options.clearError) {
        throw options.clearError;
      }
      liveSettings = previousSettings;

    },
    async get() {

      events.push('proxy-get');
      proxyCalls.get += 1;
      if (options.getError) {
        throw options.getError;
      }
      return structuredClone(liveSettings);

    },
    async set(update) {

      events.push('proxy-set');
      proxyCalls.set += 1;
      if (options.setError) {
        throw options.setError;
      }
      liveSettings = options.afterSet || {
        levelOfControl: 'controlled_by_this_extension',
        value: structuredClone(update.value),
      };

    },
  };
  let controller = null;
  const routingAdapter = RoutingAdapter.createAdapter({
    runtimeStateForRequest: () => controller ?
      controller.currentRuntimeState() : RoutingAdapter.STATES.INITIALIZING,
    routingInputForRequest: (details) =>
      controller.routingInputForRequest(details),
  });
  const proxyAuth = ProxyAuth.createHandler({
    routingAdapter,
    resolveCredentials: (authRef) => controller ?
      controller.resolveCredentials(authRef) : null,
  });
  const proxyControl = ProxyControl.createController({
    proxySettings,
    storageArea,
    generateHighPortCandidate() {

      floorGenerations += 1;
      return options.generateHighPortCandidate ?
        options.generateHighPortCandidate() : 55031;

    },
    async isPrivateAccessAllowed() {

      events.push('private-access');
      return access.allowed;

    },
    clearEphemeralState() {

      events.push('control-ephemeral-clear');
      routingAdapter.clearAllAuthorizations();
      proxyAuth.clearAllAttempts();

    },
  });
  controller = Activation.createController({
    proxyControl,
    routingAdapter,
    proxyAuth,
    storageArea,
    recoveryFactory: options.recoveryFactory,
    afterFloorAcquired: options.afterFloorAcquired,
    afterDurableOnPersisted: options.afterDurableOnPersisted,
  });
  return {
    access,
    controller,
    events,
    get floorGenerations() {

      return floorGenerations;

    },
    get liveSettings() {

      return liveSettings;

    },
    setLiveSettings(value) {

      liveSettings = structuredClone(value);

    },
    proxyAuth,
    proxyCalls,
    proxyControl,
    routingAdapter,
    storageArea,
  };

}

function recovery(store, overrides = {}) {

  return Object.assign({
    datasetStore: store,
    resolveCredentials: () => null,
    routingBaseInputForRequest: baseInputForRequest(),
    routingDescriptor: routingDescriptor(),
  }, overrides);

}

describe('Firefox durable activation recovery', function() {

  it('accepts only strict serializable schema v3 ON state', function() {

    const state = onState();
    Assert.strictEqual(OffState.isCanonicalOnState(state), true);
    Assert.deepStrictEqual(Object.keys(state).sort(), [
      'datasetIdentity',
      'floorIdentity',
      'intent',
      'providerKey',
      'routingDescriptor',
      'schemaVersion',
    ]);
    const serialized = JSON.stringify(state);
    for (const forbidden of [
      'password',
      'username',
      'requestId',
      'authRef',
      'function',
    ]) {
      Assert.strictEqual(serialized.includes(forbidden), false, forbidden);
    }

  });

  it('normalizes malformed and future ON safely to OFF cleanup state', function() {

    for (const invalid of [
      Object.assign({}, onState(), {schemaVersion: 4}),
      Object.assign({}, onState(), {extra: true}),
      Object.assign({}, onState(), {providerKey: 'other-provider'}),
      Object.assign({}, onState(), {
        datasetIdentity: Object.assign({}, datasetIdentity(), {
          artifactSha256: 'invalid',
        }),
      }),
      Object.assign({}, onState(), {
        routingDescriptor: Object.assign({}, routingDescriptor(), {
          credentials: true,
        }),
      }),
    ]) {
      Assert.deepStrictEqual(OffState.normalizeDurableState(invalid),
          OffState.canonicalOffState(floor()));
    }

  });

  it('persists ON only after exact dataset READY and exact floor ownership',
      async function() {

        const events = [];
        const store = await verifiedStore();
        const wrapped = {
          async loadVerifications(...args) {

            events.push('dataset-load');
            return store.loadVerifications(...args);

          },
        };
        const system = createSystem({events});
        await system.controller.initializeFromDurable();
        events.length = 0;

        const result = await system.controller.activatePrepared(
            prepared(wrapped),
        );

        Assert.strictEqual(result.status, Activation.RESULTS.ACTIVE);
        Assert.ok(events.indexOf('dataset-load') < events.indexOf('proxy-set'));
        Assert.ok(events.indexOf('proxy-get') <
          events.indexOf('storage-set-ON'));
        Assert.strictEqual(
            system.storageArea.values[OffState.STORAGE_KEY].intent,
            OffState.ON,
        );
        Assert.deepStrictEqual(
            system.storageArea.values[OffState.STORAGE_KEY].floorIdentity,
            floor(),
        );
        Assert.strictEqual(system.floorGenerations, 1);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'READY');

      });

  it('rolls back the floor when durable ON persistence fails', async function() {

    const events = [];
    const storageArea = memoryStorage(OffState.canonicalOffState(), events, {
      failOnIntent: OffState.ON,
    });
    const store = await verifiedStore();
    const system = createSystem({events, storageArea});
    await system.controller.initializeFromDurable();

    const result = await system.controller.activatePrepared(prepared(store));

    Assert.strictEqual(result.error.code,
        Activation.ERRORS.DURABLE_ON_PERSIST_FAILED);
    Assert.strictEqual(result.rollback.ok, true);
    Assert.strictEqual(system.proxyCalls.set, 1);
    Assert.strictEqual(system.proxyCalls.clear, 1);
    Assert.deepStrictEqual(storageArea.values[OffState.STORAGE_KEY],
        OffState.canonicalOffState());

  });

  it('retains fail-closed cleanup after floor set or confirmation failure',
      async function() {

        const store = await verifiedStore();
        for (const scenario of [
          {
            options: {setError: new Error('synthetic set failure')},
            cause: ProxyControl.ERRORS.PROXY_SET_FAILED,
          },
          {
            options: {
              afterSet: {
                levelOfControl: 'controlled_by_this_extension',
                value: {proxyType: 'none'},
              },
            },
            cause: ProxyControl.ERRORS.OWNERSHIP_MISMATCH,
          },
        ]) {
          const system = createSystem(scenario.options);
          await system.controller.initializeFromDurable();

          const result = await system.controller.activatePrepared(
              prepared(store),
          );

          Assert.strictEqual(result.error.code,
              Activation.ERRORS.ACTIVATION_ROLLBACK_FAILED);
          Assert.strictEqual(result.cause.code, scenario.cause);
          Assert.strictEqual(result.floorRetained, true);
          Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
          Assert.strictEqual(system.controller.snapshot().active, false);
          Assert.deepStrictEqual(
              system.storageArea.values[OffState.STORAGE_KEY],
              OffState.canonicalOffState(floor()),
          );
          Assert.strictEqual(system.proxyCalls.set, 1);
          Assert.strictEqual(system.proxyCalls.clear, 0);
        }

      });

  it('keeps listener behavior fail closed until durable OFF is known',
      async function() {

        let releaseRead;
        let reportRead;
        const readStarted = new Promise((resolve) => {
          reportRead = resolve;
        });
        let readCount = 0;
        const storageArea = {
          get() {

            readCount += 1;
            if (readCount > 1) {
              return Promise.resolve({
                [OffState.STORAGE_KEY]: OffState.canonicalOffState(),
              });
            }
            return new Promise((resolve) => {
              releaseRead = () => resolve({
                [OffState.STORAGE_KEY]: OffState.canonicalOffState(),
              });
              reportRead();
            });

          },
          async set() {},
        };
        const system = createSystem({storageArea});
        const boot = system.controller.initializeFromDurable();
        await readStarted;

        Assert.strictEqual(system.controller.currentRuntimeState(),
            'INITIALIZING');
        Assert.deepStrictEqual(system.routingAdapter.onBeforeRequest({
          requestId: 'cold-request',
        }), {cancel: true});
        releaseRead();
        await boot;
        Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');

      });

  it('recovers exact ON state without re-setting its floor', async function() {

    const artifact = Helpers.artifact();
    const store = await verifiedStore(artifact);
    const state = onState(floor(), artifact);
    const system = createSystem({
      durableState: state,
      liveSettings: {
        levelOfControl: 'controlled_by_this_extension',
        value: floor(),
      },
      recoveryFactory: async (descriptor) => {

        Assert.deepStrictEqual(descriptor, state);
        return recovery(store);

      },
    });

    const result = await system.controller.initializeFromDurable();

    Assert.strictEqual(result.status, Activation.RESULTS.RECOVERED);
    Assert.strictEqual(system.proxyCalls.set, 0);
    Assert.strictEqual(system.floorGenerations, 0);
    Assert.strictEqual(system.controller.currentRuntimeState(), 'READY');
    Assert.strictEqual(system.controller.snapshot().recoveryStatus,
        Activation.RECOVERY_STATUS.RECOVERED);

  });

  it('transitions lost or mismatched floor ownership to durable OFF',
      async function() {

        const store = await verifiedStore();
        const system = createSystem({
          durableState: onState(),
          liveSettings: {
            levelOfControl: 'controlled_by_this_extension',
            value: floor(55032),
          },
          recoveryFactory: () => recovery(store),
        });

        const result = await system.controller.initializeFromDurable();

        Assert.strictEqual(result.error.code,
            Activation.ERRORS.RECOVERY_FLOOR_MISMATCH);
        Assert.strictEqual(result.transitionedToOff, true);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');
        Assert.deepStrictEqual(
            system.storageArea.values[OffState.STORAGE_KEY],
            OffState.canonicalOffState(floor()),
        );
        Assert.strictEqual(system.proxyCalls.set, 0);
        Assert.strictEqual(system.proxyCalls.clear, 0);

      });

  it('keeps exact floor and ON blocked when private access is denied',
      async function() {

        const store = await verifiedStore();
        const system = createSystem({
          access: {allowed: false},
          durableState: onState(),
          liveSettings: {
            levelOfControl: 'controlled_by_this_extension',
            value: floor(),
          },
          recoveryFactory: () => recovery(store),
        });

        const result = await system.controller.initializeFromDurable();

        Assert.strictEqual(result.error.code,
            Activation.RECOVERY_STATUS.BLOCKED_PRIVATE_ACCESS);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
        Assert.strictEqual(system.controller.snapshot().durableIntent, 'ON');
        Assert.strictEqual(system.proxyCalls.set, 0);
        Assert.strictEqual(system.proxyCalls.clear, 0);

      });

  it('keeps ON fail closed when recovery factory is missing or fails',
      async function() {

        for (const recoveryFactory of [
          undefined,
          () => {

            throw new Error('synthetic recovery failure');

          },
          () => ({}),
        ]) {
          const system = createSystem({
            durableState: onState(),
            liveSettings: {
              levelOfControl: 'controlled_by_this_extension',
              value: floor(),
            },
            recoveryFactory,
          });
          const result = await system.controller.initializeFromDurable();

          Assert.strictEqual(result.ok, false);
          Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
          Assert.strictEqual(system.controller.snapshot().durableIntent, 'ON');
          Assert.strictEqual(system.proxyCalls.set, 0);
          Assert.strictEqual(system.proxyCalls.clear, 0);
        }

      });

  it('preserves only stable production recovery failure codes',
      async function() {

        for (const [factoryCode, expectedCode] of [
          ['PRODUCT_CONFIG_MISSING', 'PRODUCT_CONFIG_MISSING'],
          ['REQUIRED_CREDENTIAL_MISSING', 'REQUIRED_CREDENTIAL_MISSING'],
          ['secret-value-must-not-escape', 'RECOVERY_FACTORY_FAILED'],
        ]) {
          const system = createSystem({
            durableState: onState(),
            liveSettings: {
              levelOfControl: 'controlled_by_this_extension',
              value: floor(),
            },
            recoveryFactory() {

              const error = new Error('sanitized recovery failure');
              error.code = factoryCode;
              throw error;

            },
          });
          const result = await system.controller.initializeFromDurable();

          Assert.strictEqual(result.ok, false);
          Assert.strictEqual(result.error.code, expectedCode);
          Assert.strictEqual(system.controller.snapshot().failureCode,
              expectedCode);
          Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
        }

      });

  it('rejects missing or silently different recovery datasets', async function() {

    const missing = DatasetStore.createStore({
      backend: Helpers.memoryBackend(),
      sha256: async (bytes) => Helpers.sha256(Buffer.from(bytes)),
    });
    const differentArtifact = Helpers.artifact({datasetVersion: 'different.1'});
    const different = await verifiedStore(differentArtifact);
    for (const store of [missing, different]) {
      const system = createSystem({
        durableState: onState(),
        liveSettings: {
          levelOfControl: 'controlled_by_this_extension',
          value: floor(),
        },
        recoveryFactory: () => recovery(store),
      });
      const result = await system.controller.initializeFromDurable();

      Assert.strictEqual(result.ok, false);
      Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
      Assert.strictEqual(system.controller.snapshot().durableIntent, 'ON');
      Assert.strictEqual(system.proxyCalls.clear, 0);
    }

  });

  it('rejects a recovery factory for a different routing descriptor',
      async function() {

        const store = await verifiedStore();
        const system = createSystem({
          durableState: onState(),
          liveSettings: {
            levelOfControl: 'controlled_by_this_extension',
            value: floor(),
          },
          recoveryFactory: () => recovery(store, {
            routingDescriptor: Object.assign({}, routingDescriptor(), {
              configurationSha256: 'c'.repeat(64),
            }),
          }),
        });

        const result = await system.controller.initializeFromDurable();

        Assert.strictEqual(result.error.code,
            Activation.ERRORS.ROUTING_DESCRIPTOR_MISMATCH);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
        Assert.strictEqual(system.controller.snapshot().durableIntent, 'ON');
        Assert.strictEqual(system.proxyCalls.set, 0);
        Assert.strictEqual(system.proxyCalls.clear, 0);

      });

  it('reconciles a crash after floor acquisition but before ON persistence',
      async function() {

        const storageArea = memoryStorage(OffState.canonicalOffState());
        const acquiring = createSystem({storageArea});
        const acquired = await acquiring.proxyControl.acquireRandomFloor();
        Assert.strictEqual(acquired.ok, true);
        const recreated = createSystem({
          storageArea,
          liveSettings: acquiring.liveSettings,
        });

        const result = await recreated.controller.initializeFromDurable();

        Assert.strictEqual(result.status, Activation.RESULTS.OFF);
        Assert.strictEqual(recreated.proxyCalls.set, 0);
        Assert.strictEqual(recreated.proxyCalls.clear, 1);
        Assert.deepStrictEqual(storageArea.values[OffState.STORAGE_KEY],
            OffState.canonicalOffState());

      });

  it('recovers a crash after ON persistence but before session publication',
      async function() {

        const artifact = Helpers.artifact();
        const store = await verifiedStore(artifact);
        const storageArea = memoryStorage(OffState.canonicalOffState());
        let reportPersisted;
        const persisted = new Promise((resolve) => {
          reportPersisted = resolve;
        });
        const first = createSystem({
          storageArea,
          afterDurableOnPersisted() {

            reportPersisted();
            return new Promise(() => {});

          },
        });
        await first.controller.initializeFromDurable();
        first.controller.activatePrepared(prepared(store));
        await persisted;
        Assert.strictEqual(
            storageArea.values[OffState.STORAGE_KEY].intent,
            OffState.ON,
        );
        const recreated = createSystem({
          storageArea,
          liveSettings: first.liveSettings,
          recoveryFactory: () => recovery(store),
        });

        const result = await recreated.controller.initializeFromDurable();

        Assert.strictEqual(result.status, Activation.RESULTS.RECOVERED);
        Assert.strictEqual(recreated.proxyCalls.set, 0);
        Assert.strictEqual(recreated.controller.currentRuntimeState(), 'READY');

      });

  it('persists OFF before hiding the session and releasing the floor',
      async function() {

        const store = await verifiedStore();
        const holder = {};
        const observations = [];
        const storageArea = memoryStorage(OffState.canonicalOffState(), [], {
          afterSet(next) {

            if (next.intent === OffState.OFF && holder.system &&
                holder.system.controller.currentRuntimeState() === 'READY') {
              observations.push('off-persisted-while-ready');
            }

          },
        });
        const system = createSystem({storageArea});
        holder.system = system;
        await system.controller.initializeFromDurable();
        await system.controller.activatePrepared(prepared(store));

        const result = await system.controller.clear();

        Assert.strictEqual(result.ok, true);
        Assert.deepStrictEqual(observations, ['off-persisted-while-ready']);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');
        Assert.strictEqual(system.routingAdapter.authorizationCount(), 0);
        Assert.deepStrictEqual(storageArea.values[OffState.STORAGE_KEY],
            OffState.canonicalOffState());

      });

  it('retains durable OFF cleanup identity when Clear cannot release floor',
      async function() {

        const store = await verifiedStore();
        const system = createSystem({
          clearError: new Error('synthetic clear failure'),
        });
        await system.controller.initializeFromDurable();
        await system.controller.activatePrepared(prepared(store));

        const result = await system.controller.clear();

        Assert.strictEqual(result.error.code,
            ProxyControl.ERRORS.PROXY_CLEAR_FAILED);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');
        Assert.strictEqual(system.controller.snapshot().durableIntent, 'OFF');
        Assert.deepStrictEqual(
            system.storageArea.values[OffState.STORAGE_KEY].floorIdentity,
            floor(),
        );
        Assert.strictEqual(system.routingAdapter.authorizationCount(), 0);

      });

  it('retries blocked recovery after regrant without a second floor',
      async function() {

        const store = await verifiedStore();
        const access = {allowed: false};
        const system = createSystem({
          access,
          durableState: onState(),
          liveSettings: {
            levelOfControl: 'controlled_by_this_extension',
            value: floor(),
          },
          recoveryFactory: () => recovery(store),
        });
        await system.controller.initializeFromDurable();
        access.allowed = true;

        const recovered = await system.controller.initializeFromDurable();
        const repeated = await system.controller.initializeFromDurable();

        Assert.strictEqual(recovered.status, Activation.RESULTS.RECOVERED);
        Assert.strictEqual(repeated.status, Activation.RECOVERY_STATUS.RECOVERED);
        Assert.strictEqual(system.proxyCalls.set, 0);
        Assert.strictEqual(system.proxyCalls.clear, 0);

      });

  it('keeps unreadable durable state fail closed instead of assuming OFF',
      async function() {

        const system = createSystem({
          storageArea: memoryStorage(undefined, [], {
            getError: new Error('synthetic read failure'),
          }),
        });

        const result = await system.controller.initializeFromDurable();

        Assert.strictEqual(result.error.code,
            Activation.ERRORS.DURABLE_STATE_UNAVAILABLE);
        Assert.strictEqual(system.controller.currentRuntimeState(), 'FAILED');
        Assert.deepStrictEqual(system.routingAdapter.onBeforeRequest({
          requestId: 'unknown-durable-intent',
        }), {cancel: true});

      });

  it('restored session preserves routing, auth, and request isolation',
      async function() {

        const store = await verifiedStore();
        const authenticated = candidate({authRef: 'synthetic-auth'});
        const system = createSystem({
          durableState: onState(),
          liveSettings: {
            levelOfControl: 'controlled_by_this_extension',
            value: floor(),
          },
          recoveryFactory: () => recovery(store, {
            routingBaseInputForRequest: baseInputForRequest(authenticated),
            resolveCredentials: (authRef) => authRef === 'synthetic-auth' ? {
              username: 'fixture-user',
              password: 'fixture-password',
            } : null,
          }),
        });
        await system.controller.initializeFromDurable();
        const first = {requestId: 'first', url: 'http://beta.example/'};
        const second = {requestId: 'second', url: 'http://beta.example/'};

        system.routingAdapter.onProxyRequest(first);
        system.routingAdapter.onProxyRequest(second);
        system.routingAdapter.onBeforeRequest({
          requestId: first.requestId,
          proxyInfo: {type: 'http', host: '127.0.0.1', port: 18080},
        });
        const response = system.proxyAuth.onAuthRequired({
          requestId: first.requestId,
          isProxy: true,
          challenger: {host: '127.0.0.1', port: 18080},
        });

        Assert.deepStrictEqual(response, {
          authCredentials: {
            username: 'fixture-user',
            password: 'fixture-password',
          },
        });
        Assert.strictEqual(system.routingAdapter.authorizationCount(), 2);
        system.routingAdapter.onRequestTerminal(first);
        Assert.strictEqual(system.routingAdapter.authorizationCount(), 1);

      });

  describe('active proxy control loss', function() {

    async function activeSystem(options = {}) {

      const store = await verifiedStore();
      const system = createSystem(options);
      await system.controller.initializeFromDurable();
      const activated = await system.controller.activatePrepared(prepared(
          store,
          undefined,
          options.preparedOverrides,
      ));
      Assert.strictEqual(activated.ok, true);
      return system;

    }

    function ownedFloorChange(identity = floor()) {

      return {
        levelOfControl: 'controlled_by_this_extension',
        value: identity,
      };

    }

    function externalChange() {

      return {
        levelOfControl: 'controlled_by_other_extensions',
        value: {
          proxyType: 'manual',
          http: '127.0.0.1:58080',
        },
      };

    }

    it('keeps READY only for the exact extension-owned floor',
        async function() {

          const system = await activeSystem();

          const observed = system.controller.handleProxySettingsChange(
              ownedFloorChange(),
          );

          Assert.deepStrictEqual(observed, {
            ok: true,
            status: Activation.RESULTS.CONTROL_RETAINED,
          });
          Assert.strictEqual(system.controller.snapshot().active, true);
          Assert.strictEqual(system.controller.currentRuntimeState(), 'READY');

        });

    it('withdraws synchronously and clears route/auth state before persistence',
        async function() {

          const authenticated = candidate({authRef: 'fixture-auth'});
          const system = await activeSystem({
            preparedOverrides: {
              resolveCredentials: () => ({
                username: 'fixture-user',
                password: 'fixture-password',
              }),
              routingBaseInputForRequest: baseInputForRequest(authenticated),
            },
          });
          const request = {
            requestId: 'active-control-loss',
            url: 'http://beta.example/',
          };
          system.routingAdapter.onProxyRequest(request);
          system.routingAdapter.onBeforeRequest({
            requestId: request.requestId,
            proxyInfo: {type: 'http', host: '127.0.0.1', port: 18080},
          });
          system.proxyAuth.onAuthRequired({
            requestId: request.requestId,
            isProxy: true,
            challenger: {host: '127.0.0.1', port: 18080},
          });
          Assert.ok(system.routingAdapter.authorizationCount() > 0);
          Assert.strictEqual(system.proxyAuth.attemptCount(), 1);

          const loss = system.controller.handleProxySettingsChange(
              externalChange(),
          );

          Assert.strictEqual(loss.error.code, Activation.ERRORS.CONTROL_LOSS);
          Assert.deepStrictEqual(system.controller.snapshot(), {
            runtimeState: 'FAILED',
            active: false,
            durableIntent: 'ON',
            recoveryStatus: Activation.RECOVERY_STATUS.BLOCKED_CONTROL_LOSS,
            failureCode: Activation.ERRORS.CONTROL_LOSS,
          });
          Assert.strictEqual(system.routingAdapter.authorizationCount(), 0);
          Assert.strictEqual(system.proxyAuth.attemptCount(), 0);
          Assert.deepStrictEqual(system.routingAdapter.onBeforeRequest({
            requestId: 'after-observed-loss',
          }), {cancel: true});
          await loss.reconciliation;
          Assert.deepStrictEqual(
              system.storageArea.values[OffState.STORAGE_KEY],
              OffState.canonicalOffState(floor()),
          );
          Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');

        });

    it('never clears or overwrites the external controller setting',
        async function() {

          const system = await activeSystem();
          const callsBefore = {
            clear: system.proxyCalls.clear,
            get: system.proxyCalls.get,
            set: system.proxyCalls.set,
          };
          system.setLiveSettings(externalChange());

          const loss = system.controller.handleProxySettingsChange(
              externalChange(),
          );
          await loss.reconciliation;
          system.controller.handleProxySettingsChange(externalChange());

          Assert.strictEqual(system.proxyCalls.set, callsBefore.set);
          Assert.strictEqual(system.proxyCalls.clear, callsBefore.clear);
          Assert.deepStrictEqual(system.liveSettings, externalChange());

        });

    it('treats malformed or throwing change details as control loss',
        async function() {

          for (const change of [
            null,
            {levelOfControl: 'controlled_by_this_extension', value: null},
            new Proxy({}, {
              get() {

                throw new Error('synthetic malformed change');

              },
            }),
          ]) {
            const system = await activeSystem();
            const loss = system.controller.handleProxySettingsChange(change);

            Assert.strictEqual(loss.error.code, Activation.ERRORS.CONTROL_LOSS);
            Assert.strictEqual(system.controller.snapshot().active, false);
            Assert.strictEqual(system.controller.currentRuntimeState(),
                'FAILED');
            await loss.reconciliation;
          }

        });

    it('remains BLOCKED when durable OFF persistence fails', async function() {

      let failOff = false;
      const storageArea = memoryStorage(
          OffState.canonicalOffState(),
          [],
          {shouldFailSet: (state) => failOff && state.intent === OffState.OFF},
      );
      const system = await activeSystem({storageArea});
      failOff = true;

      const loss = system.controller.handleProxySettingsChange(
          externalChange(),
      );
      const persisted = await loss.reconciliation;

      Assert.strictEqual(persisted.error.code,
          Activation.ERRORS.DURABLE_OFF_PERSIST_FAILED);
      Assert.deepStrictEqual(system.controller.snapshot(), {
        runtimeState: 'FAILED',
        active: false,
        durableIntent: 'ON',
        recoveryStatus: Activation.RECOVERY_STATUS.BLOCKED_CONTROL_LOSS,
        failureCode: Activation.ERRORS.DURABLE_OFF_PERSIST_FAILED,
      });

    });

    it('exact-clears a resurfaced old floor once and never resumes READY',
        async function() {

          const system = await activeSystem();
          system.setLiveSettings(externalChange());
          const loss = system.controller.handleProxySettingsChange(
              externalChange(),
          );
          await loss.reconciliation;
          const clearsBefore = system.proxyCalls.clear;
          system.setLiveSettings(ownedFloorChange());

          const first = system.controller.handleProxySettingsChange(
              ownedFloorChange(),
          );
          const repeated = system.controller.handleProxySettingsChange(
              ownedFloorChange(),
          );
          await Promise.all([first.reconciliation, repeated.reconciliation]);

          Assert.strictEqual(system.proxyCalls.clear, clearsBefore + 1);
          Assert.deepStrictEqual(system.storageArea.values[OffState.STORAGE_KEY],
              OffState.canonicalOffState());
          Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');
          Assert.strictEqual(system.controller.snapshot().active, false);

        });

    it('leaves unrelated resurfaced settings untouched', async function() {

      const system = createSystem({
        durableState: OffState.canonicalOffState(floor()),
        liveSettings: externalChange(),
      });
      await system.controller.initializeFromDurable();
      const clearsBefore = system.proxyCalls.clear;

      system.controller.handleProxySettingsChange(externalChange());

      Assert.strictEqual(system.proxyCalls.clear, clearsBefore);
      Assert.deepStrictEqual(system.liveSettings, externalChange());
      Assert.strictEqual(system.controller.currentRuntimeState(), 'OFF');

    });

    it('recreation after loss stays OFF and never reacquires the floor',
        async function() {

          const original = await activeSystem();
          original.setLiveSettings(externalChange());
          const loss = original.controller.handleProxySettingsChange(
              externalChange(),
          );
          await loss.reconciliation;
          const recreated = createSystem({
            storageArea: original.storageArea,
            liveSettings: externalChange(),
          });

          const initialized = await recreated.controller.initializeFromDurable();

          Assert.strictEqual(initialized.ok, false);
          Assert.strictEqual(recreated.controller.currentRuntimeState(), 'OFF');
          Assert.strictEqual(recreated.controller.snapshot().active, false);
          Assert.deepStrictEqual(
              recreated.storageArea.values[OffState.STORAGE_KEY],
              OffState.canonicalOffState(floor()),
          );
          Assert.strictEqual(recreated.proxyCalls.set, 0);
          Assert.strictEqual(recreated.proxyCalls.clear, 0);

        });

    it('retains cleanup identity when ON recovery sees a policy mismatch',
        async function() {

          const system = createSystem({
            durableState: onState(),
            liveSettings: {
              levelOfControl: 'controlled_by_policy',
              value: {proxyType: 'none'},
            },
          });

          const result = await system.controller.initializeFromDurable();

          Assert.strictEqual(result.error.code,
              Activation.ERRORS.RECOVERY_FLOOR_MISMATCH);
          Assert.deepStrictEqual(
              system.storageArea.values[OffState.STORAGE_KEY],
              OffState.canonicalOffState(floor()),
          );
          Assert.strictEqual(system.proxyCalls.set, 0);
          Assert.strictEqual(system.proxyCalls.clear, 0);

        });

  });

});
