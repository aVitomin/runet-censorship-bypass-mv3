'use strict';

const Assert = require('node:assert');
const Activation = require('../background/activation-controller');
const DatasetRuntime = require('../background/dataset-runtime');
const DatasetStore = require('../background/dataset-store');
const ProxyAuth = require('../background/proxy-auth');
const ProxyControl = require('../background/proxy-control');
const Routing = require('../../extension-mv3-common/routing-contract');
const RoutingAdapter = require('../background/routing-adapter');
const Helpers = require('./dataset-test-helpers');

function floor(port = 55011) {

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

async function verifiedStore(options = {}) {

  const backend = Helpers.memoryBackend();
  const store = DatasetStore.createStore({
    backend,
    sha256: async (bytes) => Helpers.sha256(Buffer.from(bytes)),
  });
  if (options.empty !== true) {
    const committed = await store.commitPackagedBaseline(Helpers.artifact(
        options.artifactOptions,
    ));
    Assert.strictEqual(committed.ok, true);
  }
  return store;

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

function prepared(datasetStore, overrides = {}) {

  return Object.assign({
    datasetStore,
    floorIdentity: floor(),
    portPrevalidated: true,
    providerKey: Helpers.PROVIDER_KEY,
    resolveCredentials: () => null,
    routingBaseInputForRequest: baseInputForRequest(),
  }, overrides);

}

function createHarness(options = {}) {

  const events = [];
  const floorControl = options.proxyControl || {
    async acquirePrevalidatedFloor(request) {

      events.push(['floor-acquire', request]);
      return options.acquireResult || {
        ok: true,
        status: ProxyControl.RESULTS.ACQUIRED,
      };

    },
    async clearFloor() {

      events.push(['floor-clear']);
      return options.clearResult || {
        ok: true,
        status: ProxyControl.RESULTS.CLEARED,
      };

    },
  };
  let controller = null;
  const routingAdapter = RoutingAdapter.createAdapter({
    runtimeStateForRequest: () => controller ?
      controller.currentRuntimeState() : RoutingAdapter.STATES.OFF,
    routingInputForRequest: (details) =>
      controller.routingInputForRequest(details),
  });
  const proxyAuth = ProxyAuth.createHandler({
    routingAdapter,
    resolveCredentials: (authRef) => controller ?
      controller.resolveCredentials(authRef) : null,
  });
  controller = Activation.createController({
    proxyControl: floorControl,
    routingAdapter,
    proxyAuth,
    createDatasetRuntime: options.createDatasetRuntime,
    afterFloorAcquired: options.afterFloorAcquired,
  });
  return {controller, events, floorControl, proxyAuth, routingAdapter};

}

describe('Firefox inert activation transaction', function() {

  it('accepts only the exact prevalidated prepared contract', async function() {

    const store = await verifiedStore();
    const valid = prepared(store);

    Assert.ok(Activation.validatePreparedActivation(valid));
    for (const invalid of [
      null,
      Object.assign({}, valid, {extra: true}),
      Object.assign({}, valid, {portPrevalidated: false}),
      Object.assign({}, valid, {floorIdentity: floor(1)}),
      Object.assign({}, valid, {providerKey: 'INVALID'}),
      Object.assign({}, valid, {datasetStore: {}}),
      Object.assign({}, valid, {routingBaseInputForRequest: null}),
      Object.assign({}, valid, {resolveCredentials: null}),
      Object.assign({}, valid, {routingBaseInputForRequest: async () => ({})}),
      Object.assign({}, valid, {resolveCredentials: async () => null}),
      new Proxy({}, {
        ownKeys() {

          throw new Error('synthetic prepared-state failure');

        },
      }),
    ]) {
      Assert.strictEqual(Activation.validatePreparedActivation(invalid), null);
    }

  });

  it('rejects invalid prepared input before acquiring the floor', async function() {

    const harness = createHarness();
    const result = await harness.controller.activatePrepared({});

    Assert.deepStrictEqual(result, {
      ok: false,
      error: {code: Activation.ERRORS.INVALID_PREPARED_ACTIVATION},
    });
    Assert.deepStrictEqual(harness.events, []);
    Assert.deepStrictEqual(harness.controller.snapshot(), {
      runtimeState: DatasetRuntime.STATES.OFF,
      active: false,
    });

  });

  it('initializes a verified dataset before floor acquisition and publication',
      async function() {

        const order = [];
        const store = await verifiedStore();
        const wrappedStore = {
          async loadVerifications(...args) {

            order.push('dataset-load');
            const result = await store.loadVerifications(...args);
            order.push('dataset-ready');
            return result;

          },
        };
        const harness = createHarness({
          proxyControl: {
            async acquirePrevalidatedFloor() {

              order.push('floor-acquire');
              return {ok: true, status: ProxyControl.RESULTS.ACQUIRED};

            },
            async clearFloor() {

              order.push('floor-clear');
              return {ok: true, status: ProxyControl.RESULTS.CLEARED};

            },
          },
          afterFloorAcquired() {

            order.push('floor-confirmed');

          },
        });

        Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');
        const result = await harness.controller.activatePrepared(
            prepared(wrappedStore),
        );

        Assert.strictEqual(result.ok, true);
        Assert.strictEqual(result.status, Activation.RESULTS.ACTIVE);
        Assert.deepStrictEqual(order, [
          'dataset-load',
          'dataset-ready',
          'floor-acquire',
          'floor-confirmed',
        ]);
        Assert.deepStrictEqual(harness.controller.snapshot(), {
          runtimeState: DatasetRuntime.STATES.READY,
          active: true,
        });

      });

  it('routes through the published verified provider session', async function() {

    const store = await verifiedStore();
    const harness = createHarness();
    await harness.controller.activatePrepared(prepared(store));

    Assert.deepStrictEqual(harness.routingAdapter.onProxyRequest({
      requestId: 'provider-proxy',
      url: 'http://beta.example/path',
    }), [
      {type: 'http', host: '127.0.0.1', port: 18080},
      null,
    ]);
    Assert.deepStrictEqual(harness.routingAdapter.onBeforeRequest({
      requestId: 'provider-proxy',
      proxyInfo: {type: 'http', host: '127.0.0.1', port: 18080},
    }), {cancel: false});

  });

  it('does not acquire a floor when the dataset is missing', async function() {

    const store = await verifiedStore({empty: true});
    const harness = createHarness();
    const result = await harness.controller.activatePrepared(prepared(store));

    Assert.strictEqual(result.ok, false);
    Assert.strictEqual(result.error.code, 'NO_USABLE_PROVIDER_DATASET');
    Assert.deepStrictEqual(harness.events, []);
    Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');

  });

  it('does not acquire a floor when dataset initialization throws', async function() {

    const harness = createHarness();
    const result = await harness.controller.activatePrepared(prepared({
      async loadVerifications() {

        throw new Error('synthetic unreadable store');

      },
    }));

    Assert.strictEqual(result.ok, false);
    Assert.strictEqual(result.error.code, 'DATASET_INITIALIZATION_FAILED');
    Assert.deepStrictEqual(harness.events, []);

  });

  it('propagates private-access and floor acquisition failures without a session',
      async function() {

        const store = await verifiedStore();
        for (const code of [
          ProxyControl.ERRORS.PRIVATE_ACCESS_REQUIRED,
          ProxyControl.ERRORS.PROXY_SET_FAILED,
          ProxyControl.ERRORS.OWNERSHIP_MISMATCH,
        ]) {
          const harness = createHarness({
            acquireResult: {ok: false, error: {code}},
          });
          const result = await harness.controller.activatePrepared(
              prepared(store),
          );

          Assert.deepStrictEqual(result, {ok: false, error: {code}});
          Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');
          Assert.strictEqual(harness.routingAdapter.authorizationCount(), 0);
        }

      });

  it('keeps listeners OFF while paused after the floor is acquired', async function() {

    const store = await verifiedStore();
    let releasePause;
    let reportFloor;
    const floorReached = new Promise((resolve) => {
      reportFloor = resolve;
    });
    const harness = createHarness({
      afterFloorAcquired() {

        reportFloor();
        return new Promise((resolve) => {
          releasePause = resolve;
        });

      },
    });
    const activation = harness.controller.activatePrepared(prepared(store));
    await floorReached;

    Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');
    Assert.strictEqual(
        harness.routingAdapter.onProxyRequest({requestId: 'paused'}),
        undefined,
    );
    Assert.deepStrictEqual(
        harness.routingAdapter.onBeforeRequest({requestId: 'paused'}),
        {cancel: false},
    );

    releasePause();
    Assert.strictEqual((await activation).ok, true);
    Assert.strictEqual(harness.controller.currentRuntimeState(), 'READY');

  });

  it('rolls back an interruption after floor acquisition without publication',
      async function() {

        const store = await verifiedStore();
        const harness = createHarness({
          afterFloorAcquired() {

            throw new Error('synthetic interruption');

          },
        });
        const result = await harness.controller.activatePrepared(prepared(store));

        Assert.strictEqual(result.ok, false);
        Assert.strictEqual(
            result.error.code,
            Activation.ERRORS.ACTIVATION_INTERRUPTED,
        );
        Assert.strictEqual(result.rollback.ok, true);
        Assert.deepStrictEqual(
            harness.events.map(([name]) => name),
            ['floor-acquire', 'floor-clear'],
        );
        Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');

      });

  it('reports a retained fail-closed floor when rollback cannot clear it',
      async function() {

        const store = await verifiedStore();
        const harness = createHarness({
          clearResult: {
            ok: false,
            error: {code: ProxyControl.ERRORS.PROXY_CLEAR_FAILED},
          },
          afterFloorAcquired() {

            throw new Error('synthetic interruption');

          },
        });
        const result = await harness.controller.activatePrepared(prepared(store));

        Assert.deepStrictEqual(result, {
          ok: false,
          error: {code: Activation.ERRORS.ACTIVATION_ROLLBACK_FAILED},
          cause: {code: Activation.ERRORS.ACTIVATION_INTERRUPTED},
          floorRetained: true,
        });
        Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');

      });

  it('withdraws the session and clears ephemerals before releasing the floor',
      async function() {

        const store = await verifiedStore();
        const holder = {};
        const observations = [];
        const control = {
          async acquirePrevalidatedFloor() {

            return {ok: true, status: ProxyControl.RESULTS.ACQUIRED};

          },
          async clearFloor() {

            observations.push(holder.harness.controller.currentRuntimeState());
            observations.push(
                holder.harness.routingAdapter.authorizationCount(),
            );
            observations.push(holder.harness.proxyAuth.attemptCount());
            return {ok: true, status: ProxyControl.RESULTS.CLEARED};

          },
        };
        const harness = createHarness({proxyControl: control});
        holder.harness = harness;
        await harness.controller.activatePrepared(prepared(store));
        harness.routingAdapter.onProxyRequest({
          requestId: 'stale',
          url: 'http://beta.example/',
        });
        Assert.strictEqual(harness.routingAdapter.authorizationCount(), 1);

        const result = await harness.controller.clear();

        Assert.deepStrictEqual(result, {
          ok: true,
          status: ProxyControl.RESULTS.CLEARED,
        });
        Assert.deepStrictEqual(observations, ['OFF', 0, 0]);
        Assert.strictEqual(harness.routingAdapter.authorizationCount(), 0);
        Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');

      });

  it('stays OFF with a retained floor when Clear fails', async function() {

    const store = await verifiedStore();
    const harness = createHarness({
      clearResult: {
        ok: false,
        error: {code: ProxyControl.ERRORS.PROXY_CLEAR_FAILED},
      },
    });
    await harness.controller.activatePrepared(prepared(store));

    const result = await harness.controller.clear();

    Assert.deepStrictEqual(result, {
      ok: false,
      error: {code: ProxyControl.ERRORS.PROXY_CLEAR_FAILED},
      floorRetained: true,
    });
    Assert.strictEqual(harness.controller.currentRuntimeState(), 'OFF');
    Assert.strictEqual(harness.routingAdapter.authorizationCount(), 0);

  });

  it('attempts both ephemeral cleanups when one cleanup operation fails',
      async function() {

        let authClears = 0;
        let floorClears = 0;
        const controller = Activation.createController({
          proxyControl: {
            async acquirePrevalidatedFloor() {

              return {ok: true, status: ProxyControl.RESULTS.ACQUIRED};

            },
            async clearFloor() {

              floorClears += 1;
              return {ok: true, status: ProxyControl.RESULTS.ALREADY_CLEAR};

            },
          },
          routingAdapter: {
            clearAllAuthorizations() {

              throw new Error('synthetic routing cleanup failure');

            },
          },
          proxyAuth: {
            clearAllAttempts() {

              authClears += 1;

            },
          },
        });

        Assert.deepStrictEqual(await controller.clear(), {
          ok: false,
          error: {code: Activation.ERRORS.EPHEMERAL_CLEAR_FAILED},
        });
        Assert.strictEqual(authClears, 1);
        Assert.strictEqual(floorClears, 1);
        Assert.strictEqual(controller.currentRuntimeState(), 'OFF');

      });

  it('binds credentials to only the exact active session and request',
      async function() {

        const store = await verifiedStore();
        const authenticated = candidate({authRef: 'synthetic-auth'});
        const harness = createHarness();
        await harness.controller.activatePrepared(prepared(store, {
          routingBaseInputForRequest: baseInputForRequest(authenticated),
          resolveCredentials(authRef) {

            return authRef === 'synthetic-auth' ? {
              username: 'fixture-user',
              password: 'fixture-password',
            } : null;

          },
        }));
        const details = {
          requestId: 'auth-request',
          url: 'http://beta.example/',
        };
        harness.routingAdapter.onProxyRequest(details);
        harness.routingAdapter.onBeforeRequest({
          requestId: details.requestId,
          proxyInfo: {type: 'http', host: '127.0.0.1', port: 18080},
        });

        const response = harness.proxyAuth.onAuthRequired({
          requestId: details.requestId,
          isProxy: true,
          challenger: {host: '127.0.0.1', port: 18080},
        });

        Assert.deepStrictEqual(response, {
          authCredentials: {
            username: 'fixture-user',
            password: 'fixture-password',
          },
        });
        Assert.deepStrictEqual(harness.routingAdapter.onBeforeRequest({
          requestId: details.requestId,
          proxyInfo: {type: 'http', host: '127.0.0.1', port: 18080},
        }), {cancel: false});
        await harness.controller.clear();
        Assert.strictEqual(
            harness.controller.resolveCredentials('synthetic-auth'),
            null,
        );

      });

  it('fails closed when a synchronous-shaped resolver returns async state',
      async function() {

        const store = await verifiedStore();
        const authenticated = candidate({authRef: 'synthetic-auth'});
        const harness = createHarness();
        await harness.controller.activatePrepared(prepared(store, {
          routingBaseInputForRequest: baseInputForRequest(authenticated),
          resolveCredentials: () => Promise.resolve({
            username: 'fixture-user',
            password: 'fixture-password',
          }),
        }));
        harness.routingAdapter.onProxyRequest({
          requestId: 'async-auth',
          url: 'http://beta.example/',
        });
        harness.routingAdapter.onBeforeRequest({
          requestId: 'async-auth',
          proxyInfo: {type: 'http', host: '127.0.0.1', port: 18080},
        });

        Assert.deepStrictEqual(harness.proxyAuth.onAuthRequired({
          requestId: 'async-auth',
          isProxy: true,
          challenger: {host: '127.0.0.1', port: 18080},
        }), {cancel: true});

      });

  it('refuses a second activation and never replaces an active session',
      async function() {

        const store = await verifiedStore();
        const harness = createHarness();
        Assert.strictEqual(
            (await harness.controller.activatePrepared(prepared(store))).ok,
            true,
        );

        Assert.deepStrictEqual(
            await harness.controller.activatePrepared(prepared(store)),
            {
              ok: false,
              error: {code: Activation.ERRORS.ACTIVATION_ALREADY_ACTIVE},
            },
        );
        Assert.strictEqual(
            harness.events.filter(([name]) => name === 'floor-acquire').length,
            1,
        );

      });

  it('starts a recreated controller OFF with no authorization or auth state',
      async function() {

        const store = await verifiedStore();
        const first = createHarness();
        await first.controller.activatePrepared(prepared(store));
        first.routingAdapter.onProxyRequest({
          requestId: 'old-request',
          url: 'http://beta.example/',
        });
        const recreated = createHarness();

        Assert.strictEqual(recreated.controller.currentRuntimeState(), 'OFF');
        Assert.strictEqual(recreated.routingAdapter.authorizationCount(), 0);
        Assert.strictEqual(recreated.routingAdapter.authContextCount(), 0);
        Assert.strictEqual(recreated.proxyAuth.attemptCount(), 0);
        Assert.strictEqual(
            recreated.routingAdapter.onProxyRequest({requestId: 'old-request'}),
            undefined,
        );

      });

});
