'use strict';

const Assert = require('node:assert');
const Routing = require('../../extension-mv3-common/routing-contract');
const Adapter = require('../background/routing-adapter');
const Runtime = require('../background/dataset-runtime');
const Store = require('../background/dataset-store');
const {
  Dataset,
  PROVIDER_KEY,
  artifact,
  memoryBackend,
  payload,
  sha256,
} = require('./dataset-test-helpers');

function candidate(id, port = 8080) {

  return {
    id,
    type: 'HTTP',
    host: '127.0.0.1',
    port,
    proxyDNS: false,
    authRef: null,
    failoverTimeoutSeconds: null,
  };

}

function routingPayload() {

  return payload([
    {
      width: 10,
      routeRef: 'PROVIDER_DIRECT',
      hosts: 'alpha.test',
    },
    {
      width: 10,
      routeRef: 'PROVIDER_PROXY',
      hosts: 'proxy.test',
    },
  ]);

}

function createStoredRuntime(options = {}) {

  const backend = options.backend || memoryBackend();
  const store = Store.createStore({backend, sha256});
  const runtime = Runtime.createRuntime({
    protectionIntended: options.protectionIntended !== false,
    providerKey: options.providerKey || PROVIDER_KEY,
    store,
    buildLookup: options.buildLookup,
    baseInputForRequest: options.baseInputForRequest || (() => ({
      providerCandidates: [candidate('provider')],
    })),
  });
  return {backend, runtime, store};

}

function adapterForRuntime(runtime) {

  return Adapter.createAdapter({
    runtimeStateForRequest: runtime.getState,
    routingInputForRequest: runtime.routingInputForRequest,
  });

}

describe('Firefox declarative dataset runtime', function() {

  it('does not read dataset storage while durable protection is OFF',
      async function() {

        let reads = 0;
        const runtime = Runtime.createRuntime({
          protectionIntended: false,
          providerKey: PROVIDER_KEY,
          store: {
            async loadVerifications() {

              reads += 1;
              throw new Error('must not run');

            },
          },
        });

        Assert.strictEqual(runtime.getState(), 'OFF');
        Assert.deepStrictEqual(await runtime.initialize(), {
          state: 'OFF',
          failureCode: null,
          selected: null,
        });
        Assert.strictEqual(reads, 0);

      });

  it('moves INITIALIZING to READY only after baseline verification and indexing',
      async function() {

        const {runtime, store} = createStoredRuntime();
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));

        Assert.strictEqual(runtime.getState(), 'INITIALIZING');
        const initialized = await runtime.initialize();

        Assert.strictEqual(initialized.state, 'READY');
        Assert.strictEqual(initialized.selected.source, 'USE_PACKAGED_BASELINE');
        Assert.strictEqual(runtime.getState(), 'READY');

      });

  it('keeps a cold request canceled while artifact loading is pending',
      async function() {

        let release;
        const pending = new Promise((resolve) => {
          release = resolve;
        });
        const runtime = Runtime.createRuntime({
          protectionIntended: true,
          providerKey: PROVIDER_KEY,
          store: {loadVerifications: () => pending},
        });
        const adapter = adapterForRuntime(runtime);
        const initialization = runtime.initialize();

        Assert.strictEqual(runtime.getState(), 'INITIALIZING');
        Assert.deepStrictEqual(adapter.onProxyRequest({requestId: 'cold'}), {
          type: 'direct',
        });
        Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'cold'}), {
          cancel: true,
        });
        release({active: null, previousLkg: null, packagedBaseline: null});
        Assert.strictEqual((await initialization).state, 'FAILED');

      });

  it('fails closed for a provider Proxy decision with Direct fallback',
      async function() {

        const {runtime, store} = createStoredRuntime();
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const adapter = adapterForRuntime(runtime);

        Assert.deepStrictEqual(adapter.onProxyRequest({
          requestId: 'provider-proxy',
          url: 'http://proxy.test/path',
        }), {type: 'direct'});
        Assert.strictEqual(adapter.authorizationCount(), 0);
        Assert.deepStrictEqual(
            adapter.onBeforeRequest({requestId: 'provider-proxy'}),
            {cancel: true},
        );

      });

  it('routes provider Direct and legitimate provider miss explicitly',
      async function() {

        const {runtime, store} = createStoredRuntime();
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const adapter = adapterForRuntime(runtime);

        for (const [requestId, url] of [
          ['provider-direct', 'http://alpha.test/'],
          ['provider-miss', 'http://ordinary.test/'],
        ]) {
          Assert.strictEqual(adapter.onProxyRequest({requestId, url}), null);
          Assert.deepStrictEqual(adapter.onBeforeRequest({requestId}), {
            cancel: false,
          });
        }

      });

  it('preserves explicit Direct and Proxy precedence over provider data',
      async function() {

        const {runtime, store} = createStoredRuntime({
          baseInputForRequest(details) {

            return {
              rules: {
                direct: ['direct.override'],
                proxy: ['proxy.test'],
              },
              candidateGroups: {
                configured: {own: [candidate('explicit', 8181)]},
              },
              providerCandidates: [candidate('provider')],
              hostname: new URL(details.url).hostname,
            };

          },
        });
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const adapter = adapterForRuntime(runtime);

        Assert.strictEqual(adapter.onProxyRequest({
          requestId: 'direct-rule',
          url: 'http://direct.override/',
        }), null);
        Assert.deepStrictEqual(adapter.onProxyRequest({
          requestId: 'proxy-rule',
          url: 'http://proxy.test/',
        }), [
          {type: 'http', host: '127.0.0.1', port: 8181},
          null,
        ]);

      });

  it('preserves onion routing before provider policy', async function() {

    const {runtime, store} = createStoredRuntime({
      baseInputForRequest: () => ({
        candidateGroups: {onion: {localTor: [candidate('tor', 9050)]}},
        providerCandidates: [candidate('provider')],
      }),
    });
    await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
    await runtime.initialize();
    const decision = Routing.decideRoute(runtime.routingInputForRequest({
      url: 'http://hidden.onion/',
    }));

    Assert.strictEqual(decision.source, Routing.SOURCES.ONION);
    Assert.strictEqual(decision.fallback, Routing.FALLBACKS.FAIL_CLOSED);

  });

  it('applies noDirect only to provider/default Direct behavior',
      async function() {

        const {runtime, store} = createStoredRuntime({
          baseInputForRequest: () => ({
            flags: {noDirect: true},
            providerCandidates: [candidate('provider')],
          }),
        });
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const decision = Routing.decideRoute(runtime.routingInputForRequest({
          url: 'http://ordinary.test/',
        }));

        Assert.strictEqual(decision.kind, Routing.KINDS.FAIL_CLOSED);

      });

  it('applies replaceDirectWithProxy through the shared routing core',
      async function() {

        const {runtime, store} = createStoredRuntime({
          baseInputForRequest: () => ({
            flags: {replaceDirectWithProxy: true},
            candidateGroups: {
              directReplacement: {warp: [candidate('replacement', 40000)]},
            },
            providerCandidates: [candidate('provider')],
          }),
        });
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const decision = Routing.decideRoute(runtime.routingInputForRequest({
          url: 'http://alpha.test/',
        }));

        Assert.strictEqual(decision.kind, Routing.KINDS.PROXY);
        Assert.strictEqual(decision.candidates[0].id, 'replacement');
        Assert.strictEqual(decision.fallback, Routing.FALLBACKS.FAIL_CLOSED);

      });

  it('broadens configured candidates only when own-sites-only is false',
      async function() {

        for (const expectedCount of [1, 2]) {
          const broad = expectedCount === 2;
          const {runtime, store} = createStoredRuntime({
            baseInputForRequest: () => ({
              flags: {ownProxiesOnlyForOwnSites: !broad},
              candidateGroups: {
                configured: {own: [candidate('own', 8181)]},
              },
              providerCandidates: [candidate('provider')],
            }),
          });
          await store.commitPackagedBaseline(artifact({
            payload: routingPayload(),
          }));
          await runtime.initialize();
          const decision = Routing.decideRoute(runtime.routingInputForRequest({
            url: 'http://proxy.test/',
          }));
          Assert.strictEqual(decision.candidates.length, expectedCount);
        }

      });

  it('falls back from corrupt active bytes to a verified previous LKG',
      async function() {

        const {backend, runtime, store} = createStoredRuntime();
        const previous = artifact({
          payload: payload([{
            width: 13,
            routeRef: 'PROVIDER_PROXY',
            hosts: 'previous.test',
          }]),
          datasetVersion: 'previous',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        const active = artifact({
          payload: routingPayload(),
          datasetVersion: 'active',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        await store.activateCandidate(previous);
        await store.activateCandidate(active);
        backend.artifacts.get(active.envelope.artifactSha256)
            .artifactBytes[0] ^= 1;

        const initialized = await runtime.initialize();

        Assert.strictEqual(initialized.state, 'READY');
        Assert.strictEqual(initialized.selected.datasetVersion, 'previous');
        Assert.strictEqual(initialized.selected.source, 'USE_PREVIOUS_LKG');

      });

  it('falls back from corrupt active and LKG to packaged baseline',
      async function() {

        const {backend, runtime, store} = createStoredRuntime();
        const baseline = artifact({
          payload: payload([{
            width: 13,
            routeRef: 'PROVIDER_PROXY',
            hosts: 'baseline.test',
          }]),
          datasetVersion: 'baseline',
        });
        const previous = artifact({
          payload: payload([{
            width: 13,
            routeRef: 'PROVIDER_PROXY',
            hosts: 'previous.test',
          }]),
          datasetVersion: 'previous',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        const active = artifact({
          payload: payload([{
            width: 12,
            routeRef: 'PROVIDER_PROXY',
            hosts: 'current.test',
          }]),
          datasetVersion: 'active',
          trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
        });
        await store.commitPackagedBaseline(baseline);
        await store.activateCandidate(previous);
        await store.activateCandidate(active);
        backend.artifacts.get(active.envelope.artifactSha256)
            .artifactBytes[0] ^= 1;
        backend.artifacts.get(previous.envelope.artifactSha256)
            .artifactBytes[0] ^= 1;

        const initialized = await runtime.initialize();

        Assert.strictEqual(initialized.state, 'READY');
        Assert.strictEqual(initialized.selected.datasetVersion, 'baseline');
        Assert.strictEqual(
            initialized.selected.source,
            'USE_PACKAGED_BASELINE',
        );

      });

  it('enters FAILED when no verified artifact is usable', async function() {

    const {runtime} = createStoredRuntime();
    const adapter = adapterForRuntime(runtime);
    const initialized = await runtime.initialize();

    Assert.deepStrictEqual(initialized, {
      state: 'FAILED',
      failureCode: 'NO_USABLE_PROVIDER_DATASET',
      selected: null,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'failed'}), {
      cancel: true,
    });

  });

  it('enters FAILED when index construction throws', async function() {

    const {runtime, store} = createStoredRuntime({
      buildLookup() {

        throw new Error('injected index failure');

      },
    });
    await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
    const initialized = await runtime.initialize();

    Assert.strictEqual(initialized.state, 'FAILED');
    Assert.strictEqual(
        initialized.failureCode,
        'DATASET_INITIALIZATION_FAILED',
    );

  });

  it('maps a lookup exception to provider FAIL_CLOSED, never MISS',
      async function() {

        const {runtime, store} = createStoredRuntime({
          buildLookup: () => ({
            lookup() {

              throw new Error('injected lookup failure');

            },
          }),
        });
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const decision = Routing.decideRoute(runtime.routingInputForRequest({
          url: 'http://ordinary.test/',
        }));

        Assert.deepStrictEqual(decision, {
          kind: 'FAIL_CLOSED',
          source: 'PROVIDER_DATASET',
          code: 'PROVIDER_LOOKUP_FAILED',
        });

      });

  it('maps an unexpected lookup marker to FAIL_CLOSED, never Direct',
      async function() {

        const {runtime, store} = createStoredRuntime({
          buildLookup: () => ({lookup: () => ({kind: 'UNKNOWN'})}),
        });
        await store.commitPackagedBaseline(artifact({payload: routingPayload()}));
        await runtime.initialize();
        const decision = Routing.decideRoute(runtime.routingInputForRequest({
          url: 'http://ordinary.test/',
        }));

        Assert.strictEqual(decision.kind, Routing.KINDS.FAIL_CLOSED);
        Assert.strictEqual(decision.code, 'INVALID_PROVIDER_LOOKUP_RESULT');

      });

  it('starts recreated runtime and authorization state from empty memory',
      async function() {

        const backend = memoryBackend();
        const first = createStoredRuntime({backend});
        await first.store.commitPackagedBaseline(artifact({
          payload: routingPayload(),
        }));
        await first.runtime.initialize();
        const firstAdapter = adapterForRuntime(first.runtime);
        firstAdapter.onProxyRequest({
          requestId: 'old-request',
          url: 'http://alpha.test/',
        });

        const recreated = createStoredRuntime({backend});
        const recreatedAdapter = adapterForRuntime(recreated.runtime);

        Assert.strictEqual(recreated.runtime.getState(), 'INITIALIZING');
        Assert.strictEqual(recreatedAdapter.authorizationCount(), 0);
        Assert.deepStrictEqual(
            recreatedAdapter.onBeforeRequest({requestId: 'old-request'}),
            {cancel: true},
        );
        Assert.strictEqual((await recreated.runtime.initialize()).state, 'READY');

      });

});
