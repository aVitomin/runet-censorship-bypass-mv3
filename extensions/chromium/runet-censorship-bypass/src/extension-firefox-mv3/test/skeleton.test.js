'use strict';

const Assert = require('node:assert');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');
const Vm = require('node:vm');
const DatasetStore = require('../background/dataset-store');
const OffState = require('../background/off-state');
const ProductConfig = require('../background/product-config');
const ProductionProvider = require('../background/production-provider');
const Routing = require('../../extension-mv3-common/routing-contract');
const Helpers = require('./dataset-test-helpers');

const sourceRoot = Path.resolve(__dirname, '..');
const manifest = JSON.parse(Fs.readFileSync(
    Path.join(sourceRoot, 'manifest.json'),
    'utf8',
));
const offStateSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'off-state.js'),
    'utf8',
);
const proxyControlSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'proxy-control.js'),
    'utf8',
);
const routingContractSource = Fs.readFileSync(
    Path.resolve(sourceRoot, '..', 'extension-mv3-common', 'routing-contract.js'),
    'utf8',
);
const providerDatasetSource = Fs.readFileSync(
    Path.resolve(sourceRoot, '..', 'extension-mv3-common', 'provider-dataset.js'),
    'utf8',
);
const providerDatasetStateSource = Fs.readFileSync(
    Path.resolve(
        sourceRoot,
        '..',
        'extension-mv3-common',
        'provider-dataset-state.js',
    ),
    'utf8',
);
const datasetStoreSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'dataset-store.js'),
    'utf8',
);
const providerUpdaterSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'provider-updater.js'),
    'utf8',
);
const providerLookupSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'provider-lookup.js'),
    'utf8',
);
const datasetRuntimeSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'dataset-runtime.js'),
    'utf8',
);
const routingAdapterSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'routing-adapter.js'),
    'utf8',
);
const proxyAuthSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'proxy-auth.js'),
    'utf8',
);
const productConfigSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'product-config.js'),
    'utf8',
);
const productionProviderSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'production-provider.js'),
    'utf8',
);
const settingsControlSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'settings-control.js'),
    'utf8',
);
const activationControllerSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'activation-controller.js'),
    'utf8',
);
const eventPageSource = Fs.readFileSync(
    Path.join(sourceRoot, 'background', 'event-page.js'),
    'utf8',
);

function makeStorage(initialValue) {

  const values = initialValue === undefined ? {} : {
    [OffState.STORAGE_KEY]: initialValue,
  };
  const writes = [];
  return {
    values,
    writes,
    area: {
      async get(key) {

        const keys = Array.isArray(key) ? key : [key];
        return keys.reduce((result, item) => {
          if (item in values) {
            result[item] = values[item];
          }
          return result;
        }, {});

      },
      async set(update) {

        writes.push(update);
        Object.assign(values, update);

      },
      async remove(key) {

        delete values[key];

      },
    },
  };

}

async function preparedActivation() {

  const artifact = Helpers.artifact();
  const store = DatasetStore.createStore({
    backend: Helpers.memoryBackend(),
    sha256: async (bytes) => Helpers.sha256(Buffer.from(bytes)),
  });
  const committed = await store.commitPackagedBaseline(artifact);
  Assert.strictEqual(committed.ok, true);
  return Object.freeze({
    datasetIdentity: Object.freeze({
      providerKey: artifact.envelope.providerKey,
      datasetVersion: artifact.envelope.datasetVersion,
      artifactSha256: artifact.envelope.artifactSha256,
    }),
    datasetStore: store,
    providerKey: artifact.envelope.providerKey,
    resolveCredentials: () => null,
    routingBaseInputForRequest: () => ({
      hostname: 'beta.example',
      rules: {},
      candidateGroups: {},
      flags: {},
      providerCandidates: [{
        id: 'synthetic-proxy',
        type: 'HTTP',
        host: '127.0.0.1',
        port: 18080,
        proxyDNS: false,
        authRef: null,
        failoverTimeoutSeconds: null,
      }],
      providerFallback: Routing.FALLBACKS.DIRECT,
    }),
    routingDescriptor: Object.freeze({
      schemaVersion: 1,
      configurationKey: 'synthetic-routing',
      configurationVersion: '1',
      configurationSha256: 'a'.repeat(64),
    }),
  });

}

function startEventPage(options = {}) {

  const events = [];
  const storage = options.storage || makeStorage();
  const proxySettingsCalls = {clear: 0, get: 0, set: 0};
  let liveProxySettings = options.liveProxySettings || {
    levelOfControl: 'controllable_by_this_extension',
    value: {proxyType: 'none'},
  };
  let messageListener;
  const networkListeners = {};
  let proxySettingsChangeListener;
  const browser = {
    extension: {
      async isAllowedIncognitoAccess() {

        events.push('private-access');
        return Boolean(options.privateWindowAccess);

      },
    },
    runtime: {
      getManifest() {

        return manifest;

      },
      onMessage: {
        addListener(listener) {

          events.push('listener-registered');
          messageListener = listener;

        },
      },
    },
    proxy: {
      onRequest: {
        addListener(listener, filter) {

          events.push('proxy-listener-registered');
          networkListeners.proxy = {filter, listener};

        },
      },
      settings: {
        onChange: {
          addListener(listener) {

            events.push('proxy-settings-change-listener-registered');
            proxySettingsChangeListener = listener;

          },
        },
        async clear() {

          proxySettingsCalls.clear += 1;
          events.push('proxy-settings-clear');
          if (options.proxyClearWait) {
            await options.proxyClearWait;
          }
          liveProxySettings = options.afterClearProxySettings || {
            levelOfControl: 'controllable_by_this_extension',
            value: {proxyType: 'none'},
          };

        },
        async get() {

          proxySettingsCalls.get += 1;
          events.push('proxy-settings-get');
          return liveProxySettings;

        },
        async set(update) {

          proxySettingsCalls.set += 1;
          events.push('proxy-settings-set');
          if (options.proxySetError) {
            throw options.proxySetError;
          }
          liveProxySettings = options.afterSetProxySettings || {
            levelOfControl: 'controlled_by_this_extension',
            value: update.value,
          };

        },
      },
    },
    storage: {
      local: {
        async get(key) {

          events.push(Array.isArray(key) ?
            'product-config-storage-get' : 'storage-get');
          return storage.area.get(key);

        },
        async set(update) {

          events.push('storage-set');
          return storage.area.set(update);

        },
        async remove(key) {

          events.push('storage-remove');
          return storage.area.remove(key);

        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener(listener, filter, extraInfoSpec) {

          events.push('guard-listener-registered');
          networkListeners.before = {extraInfoSpec, filter, listener};

        },
      },
      onAuthRequired: {
        addListener(listener, filter, extraInfoSpec) {

          events.push('auth-listener-registered');
          networkListeners.auth = {extraInfoSpec, filter, listener};

        },
      },
      onCompleted: {
        addListener(listener, filter) {

          events.push('completed-listener-registered');
          networkListeners.completed = {filter, listener};

        },
      },
      onErrorOccurred: {
        addListener(listener, filter) {

          events.push('error-listener-registered');
          networkListeners.error = {filter, listener};

        },
      },
    },
  };
  const context = Vm.createContext({
    browser,
    TextDecoder,
    TextEncoder,
    indexedDB: {
      open() {

        throw new Error('TEST_INDEXED_DB_MUST_NOT_OPEN');

      },
    },
    crypto: {
      subtle: Crypto.webcrypto.subtle,
      randomUUID: () => options.bootId || 'test-boot',
      getRandomValues(words) {

        if (options.randomError) {
          throw options.randomError;
        }
        words[0] = options.randomWord === undefined ? 4096 :
          options.randomWord;
        return words;

      },
    },
  });
  Vm.runInContext(routingContractSource, context, {
    filename: 'routing-contract.js',
  });
  Vm.runInContext(providerDatasetSource, context, {
    filename: 'provider-dataset.js',
  });
  Vm.runInContext(providerDatasetStateSource, context, {
    filename: 'provider-dataset-state.js',
  });
  Vm.runInContext(offStateSource, context, {filename: 'off-state.js'});
  Vm.runInContext(proxyControlSource, context, {filename: 'proxy-control.js'});
  Vm.runInContext(datasetStoreSource, context, {filename: 'dataset-store.js'});
  Vm.runInContext(providerUpdaterSource, context, {
    filename: 'provider-updater.js',
  });
  Vm.runInContext(providerLookupSource, context, {
    filename: 'provider-lookup.js',
  });
  Vm.runInContext(datasetRuntimeSource, context, {
    filename: 'dataset-runtime.js',
  });
  Vm.runInContext(routingAdapterSource, context, {
    filename: 'routing-adapter.js',
  });
  Vm.runInContext(proxyAuthSource, context, {filename: 'proxy-auth.js'});
  Vm.runInContext(productConfigSource, context, {filename: 'product-config.js'});
  Vm.runInContext(productionProviderSource, context, {
    filename: 'production-provider.js',
  });
  Vm.runInContext(settingsControlSource, context, {
    filename: 'settings-control.js',
  });
  context.rucbFirefoxProductionProvider = Object.freeze(Object.assign(
      {},
      context.rucbFirefoxProductionProvider,
      {
        createBootstrap: () => ({
          async initialize() {

            return {
              ok: options.providerBootstrapError ? false : true,
              status: options.providerBootstrapError ? 'FAILED' :
                'ALREADY_INSTALLED',
              code: options.providerBootstrapError || undefined,
              datasetAvailable: !options.providerBootstrapError,
              productConfigAvailable: !options.providerBootstrapError,
            };

          },
        }),
      },
  ));
  if (options.activationFactory) {
    context.rucbFirefoxProductConfig = Object.freeze(Object.assign(
        {},
        context.rucbFirefoxProductConfig,
        {createActivationFactory: () => options.activationFactory},
    ));
  }
  Vm.runInContext(activationControllerSource, context, {
    filename: 'activation-controller.js',
  });
  Vm.runInContext(eventPageSource, context, {filename: 'event-page.js'});
  return {
    context,
    events,
    networkListeners,
    proxySettingsCalls,
    proxySettingsChange(change) {

      Assert.strictEqual(typeof proxySettingsChangeListener, 'function');
      return proxySettingsChangeListener(change);

    },
    storage,
    async ready() {

      return context.rucbFirefoxSkeletonRuntime.whenReady();

    },
    send(message) {

      Assert.strictEqual(typeof messageListener, 'function');
      return Promise.resolve(messageListener(message)).then((value) =>
        JSON.parse(JSON.stringify(value)));

    },
  };

}

describe('Firefox MV3 production control package', function() {

  it('uses the Firefox MV3 event-page manifest model', function() {

    Assert.strictEqual(manifest.manifest_version, 3);
    Assert.deepStrictEqual(manifest.background, {
      scripts: [
        'background/common/routing-contract.js',
        'background/common/provider-dataset.js',
        'background/common/provider-dataset-state.js',
        'background/off-state.js',
        'background/proxy-control.js',
        'background/dataset-store.js',
        'background/provider-updater.js',
        'background/provider-lookup.js',
        'background/dataset-runtime.js',
        'background/routing-adapter.js',
        'background/proxy-auth.js',
        'background/product-config.js',
        'background/production-provider.js',
        'background/settings-control.js',
        'background/activation-controller.js',
        'background/event-page.js',
      ],
      persistent: false,
    });
    Assert.strictEqual(manifest.incognito, 'spanning');
    Assert.strictEqual('service_worker' in manifest.background, false);
    Assert.strictEqual(
        manifest.browser_specific_settings.gecko.id,
        'firefox-mv3-skeleton@runet-censorship-bypass.invalid',
    );
    Assert.strictEqual(
        manifest.browser_specific_settings.gecko.strict_min_version,
        '154.0',
    );

  });

  it('requests only the routing-adapter permissions and full routing scope',
      function() {

        Assert.deepStrictEqual(manifest.permissions, [
          'storage',
          'proxy',
          'webRequest',
          'webRequestBlocking',
        ]);
        Assert.deepStrictEqual(manifest.host_permissions, ['<all_urls>']);

      });

  it('normalizes every missing or malformed durable value to OFF', function() {

    for (const value of [
      undefined,
      null,
      'OFF',
      {schemaVersion: 1, intent: 'ON'},
      {schemaVersion: 2, intent: 'OFF'},
      {schemaVersion: 2, intent: 'OFF', floorIdentity: {invalid: true}},
      {schemaVersion: 2, intent: 'OFF', floorIdentity: null, extra: true},
      {schemaVersion: 1, intent: 'OFF', extra: true},
    ]) {
      Assert.deepStrictEqual(OffState.normalizeDurableState(value), {
        schemaVersion: 3,
        intent: 'OFF',
        floorIdentity: null,
      });
    }

  });

  it('persists canonical OFF when durable state is missing', async function() {

    const storage = makeStorage();
    const state = await OffState.initialize(storage.area);

    Assert.deepStrictEqual(state, {
      schemaVersion: 3,
      intent: 'OFF',
      floorIdentity: null,
    });
    Assert.deepStrictEqual(storage.writes, [{
      [OffState.STORAGE_KEY]: {
        schemaVersion: 3,
        intent: 'OFF',
        floorIdentity: null,
      },
    }]);

  });

  it('overwrites a non-OFF durable value', async function() {

    const storage = makeStorage({schemaVersion: 1, intent: 'ON'});
    await OffState.initialize(storage.area);

    Assert.deepStrictEqual(
        JSON.parse(JSON.stringify(storage.values[OffState.STORAGE_KEY])), {
          schemaVersion: 3,
          intent: 'OFF',
          floorIdentity: null,
        });

  });

  it('migrates schema v1 OFF to schema v3 OFF', async function() {

    const storage = makeStorage({schemaVersion: 1, intent: 'OFF'});
    await OffState.initialize(storage.area);

    Assert.deepStrictEqual(storage.writes, [{
      [OffState.STORAGE_KEY]: {
        schemaVersion: 3,
        intent: 'OFF',
        floorIdentity: null,
      },
    }]);

  });

  it('migrates schema v2 OFF and preserves its exact cleanup floor',
      async function() {

        const cleanupFloor = {
          proxyType: 'manual',
          http: '',
          httpProxyAll: false,
          ssl: '',
          socks: '127.0.0.1:55001',
          socksVersion: 5,
          proxyDNS: true,
          passthrough: '',
          autoConfigUrl: '',
        };
        const storage = makeStorage({
          schemaVersion: 2,
          intent: 'OFF',
          floorIdentity: cleanupFloor,
        });
        await OffState.initialize(storage.area);

        Assert.deepStrictEqual(storage.writes, [{
          [OffState.STORAGE_KEY]: {
            schemaVersion: 3,
            intent: 'OFF',
            floorIdentity: cleanupFloor,
          },
        }]);

      });

  it('does not rewrite canonical schema v3 durable OFF', async function() {

    const storage = makeStorage({
      schemaVersion: 3,
      intent: 'OFF',
      floorIdentity: null,
    });
    await OffState.initialize(storage.area);

    Assert.deepStrictEqual(storage.writes, []);

  });

  it('registers every network listener synchronously before state reading',
      async function() {

        const eventPage = startEventPage();
        await eventPage.ready();

        Assert.deepStrictEqual(eventPage.events.slice(0, 8), [
          'proxy-listener-registered',
          'proxy-settings-change-listener-registered',
          'guard-listener-registered',
          'auth-listener-registered',
          'completed-listener-registered',
          'error-listener-registered',
          'listener-registered',
          'product-config-storage-get',
        ]);
        Assert.deepStrictEqual(
            JSON.parse(JSON.stringify(
                eventPage.networkListeners.before.extraInfoSpec,
            )),
            ['blocking'],
        );
        Assert.deepStrictEqual(
            JSON.parse(JSON.stringify(
                eventPage.networkListeners.auth.extraInfoSpec,
            )),
            ['blocking'],
        );

      });

  it('keeps startup fail closed, then leaves traffic inert while OFF',
      async function() {

        const eventPage = startEventPage();

        Assert.deepStrictEqual(
            JSON.parse(JSON.stringify(
                eventPage.networkListeners.before.listener({
                  requestId: 'initializing',
                }),
            )),
            {cancel: true},
        );
        await eventPage.ready();

        Assert.strictEqual(
            eventPage.networkListeners.proxy.listener({requestId: 'off'}),
            undefined,
        );
        Assert.deepStrictEqual(
            JSON.parse(JSON.stringify(
                eventPage.networkListeners.before.listener({requestId: 'off'}),
            )),
            {cancel: false},
        );
        Assert.strictEqual(
            eventPage.networkListeners.auth.listener({
              requestId: 'off',
              isProxy: true,
              challenger: {host: 'proxy.test', port: 8080},
            }),
            undefined,
        );

      });

  it('reports the verified packaged provider baseline as available',
      async function() {

        const eventPage = startEventPage({privateWindowAccess: true});
        const response = await eventPage.send({
          type: 'firefox.capabilities.get',
        });

        Assert.deepStrictEqual(response, {
          ok: true,
          result: {
            apiVersion: 2,
            browser: 'FIREFOX',
            manifestVersion: 3,
            runtimeModel: 'BACKGROUND_EVENT_PAGE',
            runtimeState: 'OFF',
            durableIntent: 'OFF',
            recoveryStatus: 'OFF',
            recoveryFailureCode: null,
            privateWindowAccess: 'GRANTED',
            routingImplemented: true,
            activationSupported: true,
            providerDatasetImplemented: true,
            providerDatasetAvailable: true,
          },
        });
        Assert.strictEqual('bootId' in response.result, false);

      });

  it('keeps private-window access informational', async function() {

    const eventPage = startEventPage({privateWindowAccess: false});
    const response = await eventPage.send({type: 'firefox.capabilities.get'});

    Assert.strictEqual(response.result.privateWindowAccess, 'DENIED');
    Assert.strictEqual(response.result.runtimeState, 'OFF');
    Assert.strictEqual(response.result.durableIntent, 'OFF');

  });

  it('uses production recovery and fails closed without product config',
      async function() {

        const floorIdentity = {
          proxyType: 'manual',
          http: '',
          httpProxyAll: false,
          ssl: '',
          socks: '127.0.0.1:55001',
          socksVersion: 5,
          proxyDNS: true,
          passthrough: '',
          autoConfigUrl: '',
        };
        const durableOn = OffState.canonicalOnState({
          floorIdentity,
          providerKey: 'synthetic-provider',
          datasetIdentity: {
            providerKey: 'synthetic-provider',
            datasetVersion: 'synthetic.1',
            artifactSha256: 'a'.repeat(64),
          },
          routingDescriptor: {
            schemaVersion: 1,
            configurationKey: 'synthetic-routing',
            configurationVersion: '1',
            configurationSha256: 'b'.repeat(64),
          },
        });
        const eventPage = startEventPage({
          storage: makeStorage(durableOn),
          privateWindowAccess: true,
          liveProxySettings: {
            levelOfControl: 'controlled_by_this_extension',
            value: floorIdentity,
          },
        });
        await eventPage.ready();
        const response = await eventPage.send({
          type: 'firefox.capabilities.get',
        });

        Assert.strictEqual(response.result.durableIntent, 'ON');
        Assert.strictEqual(response.result.runtimeState, 'FAILED');
        Assert.strictEqual(response.result.recoveryStatus, 'FAILED');
        Assert.strictEqual(
            response.result.recoveryFailureCode,
            'PRODUCT_CONFIG_MISSING',
        );
        Assert.strictEqual(eventPage.proxySettingsCalls.set, 0);
        Assert.strictEqual(eventPage.proxySettingsCalls.clear, 0);
        Assert.strictEqual(
            eventPage.events.filter((event) =>
              event === 'product-config-storage-get').length,
            2,
        );

      });

  it('fails production Apply safely when product config is absent',
      async function() {

        const eventPage = startEventPage();
        const activation = await eventPage.send({
          type: 'firefox.activation.apply',
        });
        const capabilities = await eventPage.send({
          type: 'firefox.capabilities.get',
        });

        Assert.deepStrictEqual(activation, {
          ok: false,
          error: {code: 'PRODUCT_CONFIG_MISSING'},
        });
        Assert.strictEqual(capabilities.result.runtimeState, 'OFF');
        Assert.strictEqual(capabilities.result.durableIntent, 'OFF');
        Assert.strictEqual(
            eventPage.events.includes('product-config-storage-get'),
            true,
        );

      });

  it('activates only through the exact no-input production Apply RPC',
      async function() {

        const prepared = await preparedActivation();
        let factoryCalls = 0;
        const eventPage = startEventPage({
          privateWindowAccess: true,
          activationFactory: async () => {

            factoryCalls += 1;
            return prepared;

          },
        });
        const invalid = await eventPage.send({
          type: 'firefox.activation.apply',
          providerKey: prepared.providerKey,
        });
        Assert.deepStrictEqual(invalid, {
          ok: false,
          error: {code: 'INVALID_RPC_REQUEST'},
        });
        Assert.strictEqual(factoryCalls, 0);
        Assert.strictEqual(eventPage.proxySettingsCalls.set, 0);

        const activated = await eventPage.send({
          type: 'firefox.activation.apply',
        });
        Assert.deepStrictEqual(activated, {
          ok: true,
          result: {intent: 'ON', status: 'ACTIVE'},
        });
        Assert.strictEqual(factoryCalls, 1);
        Assert.strictEqual(eventPage.proxySettingsCalls.set, 1);
        Assert.strictEqual(
            eventPage.storage.values[OffState.STORAGE_KEY].intent,
            'ON',
        );
        Assert.strictEqual(
            eventPage.storage.values[OffState.STORAGE_KEY].floorIdentity.socks,
            '127.0.0.1:53248',
        );
        const capabilities = await eventPage.send({
          type: 'firefox.capabilities.get',
        });
        Assert.strictEqual(capabilities.result.activationSupported, true);
        Assert.strictEqual(capabilities.result.providerDatasetAvailable, true);
        Assert.strictEqual(capabilities.result.runtimeState, 'READY');

      });

  it('serializes simultaneous production Apply calls into one activation',
      async function() {

        const prepared = await preparedActivation();
        let factoryCalls = 0;
        const eventPage = startEventPage({
          privateWindowAccess: true,
          activationFactory: async () => {

            factoryCalls += 1;
            return prepared;

          },
        });
        const results = await Promise.all([
          eventPage.send({type: 'firefox.activation.apply'}),
          eventPage.send({type: 'firefox.activation.apply'}),
        ]);

        Assert.strictEqual(results.filter((result) => result.ok).length, 1);
        Assert.deepStrictEqual(
            results.find((result) => !result.ok),
            {ok: false, error: {code: 'ACTIVATION_ALREADY_ACTIVE'}},
        );
        Assert.strictEqual(factoryCalls, 1);
        Assert.strictEqual(eventPage.proxySettingsCalls.set, 1);

      });

  it('orders Clear after an in-progress production Apply', async function() {

    const prepared = await preparedActivation();
    let releasePreparation;
    const preparationWait = new Promise((resolve) => {

      releasePreparation = resolve;

    });
    let factoryStarted;
    const factoryStart = new Promise((resolve) => {

      factoryStarted = resolve;

    });
    const eventPage = startEventPage({
      privateWindowAccess: true,
      activationFactory: async () => {

        factoryStarted();
        await preparationWait;
        return prepared;

      },
    });
    const applying = eventPage.send({type: 'firefox.activation.apply'});
    await factoryStart;
    const clearing = eventPage.send({type: 'firefox.activation.clear'});
    releasePreparation();

    Assert.strictEqual((await applying).ok, true);
    Assert.deepStrictEqual(await clearing, {
      ok: true,
      result: {intent: 'OFF', status: 'CLEARED'},
    });
    Assert.strictEqual(eventPage.proxySettingsCalls.set, 1);
    Assert.strictEqual(eventPage.proxySettingsCalls.clear, 1);
    Assert.strictEqual(
        (await eventPage.send({type: 'firefox.capabilities.get'}))
            .result.runtimeState,
        'OFF',
    );

  });

  it('orders production Apply after an in-progress Clear', async function() {

    const prepared = await preparedActivation();
    let releaseClear;
    const clearWait = new Promise((resolve) => {

      releaseClear = resolve;

    });
    const eventPage = startEventPage({
      privateWindowAccess: true,
      activationFactory: async () => prepared,
      proxyClearWait: clearWait,
    });
    Assert.strictEqual((await eventPage.send({
      type: 'firefox.activation.apply',
    })).ok, true);
    const clearing = eventPage.send({type: 'firefox.activation.clear'});
    while (eventPage.proxySettingsCalls.clear === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const applying = eventPage.send({type: 'firefox.activation.apply'});
    releaseClear();

    Assert.strictEqual((await clearing).ok, true);
    Assert.strictEqual((await applying).ok, true);
    Assert.strictEqual(eventPage.proxySettingsCalls.set, 2);
    Assert.strictEqual(eventPage.proxySettingsCalls.clear, 1);
    Assert.strictEqual(
        (await eventPage.send({type: 'firefox.capabilities.get'}))
            .result.runtimeState,
        'READY',
    );

  });

  it('returns only allowlisted non-secret Apply preparation errors',
      async function() {

        for (const [factoryError, expectedCode] of [
          [Object.assign(new Error('not stored'), {
            code: 'PRODUCT_CONFIG_MISSING',
          }), 'PRODUCT_CONFIG_MISSING'],
          [Object.assign(new Error('future'), {
            code: 'PRODUCT_CONFIG_VERSION_UNSUPPORTED',
          }), 'PRODUCT_CONFIG_VERSION_UNSUPPORTED'],
          [new Error('secret raw failure'), 'ACTIVATION_FAILED'],
        ]) {
          const eventPage = startEventPage({
            activationFactory: async () => {

              throw factoryError;

            },
          });
          const result = await eventPage.send({
            type: 'firefox.activation.apply',
          });
          Assert.deepStrictEqual(result, {
            ok: false,
            error: {code: expectedCode},
          });
          Assert.strictEqual(
              JSON.stringify(result).includes('secret raw failure'),
              false,
          );
        }

      });

  it('exposes strict redacted production settings RPCs', async function() {

    const productConfig = await ProductionProvider.createProductionProductConfig(
        async (bytes) => Helpers.sha256(Buffer.from(bytes)),
    );
    const storage = makeStorage();
    storage.values[ProductConfig.CONFIG_STORAGE_KEY] = productConfig;
    const eventPage = startEventPage({storage});
    await eventPage.ready();
    const invalidGet = await eventPage.send({
      type: 'firefox.settings.get',
      extra: true,
    });
    Assert.deepStrictEqual(invalidGet, {
      ok: false, error: {code: 'INVALID_RPC_REQUEST'},
    });
    const current = await eventPage.send({type: 'firefox.settings.get'});
    Assert.strictEqual(current.ok, true);
    Assert.strictEqual(current.result.revision, 0);
    current.result.settings.ownProxies = [{
      id: 'fixture-authenticated',
      enabled: true,
      type: 'HTTP',
      host: '127.0.0.1',
      port: 18080,
      proxyDNS: false,
      failoverTimeoutSeconds: null,
      useAsDirectReplacement: false,
      credentials: {
        mode: 'SET',
        username: 'fixture-user',
        password: 'fixture-password',
      },
    }];
    const replaced = await eventPage.send({
      type: 'firefox.settings.replace',
      expectedRevision: 0,
      settings: current.result.settings,
    });

    Assert.strictEqual(replaced.ok, true);
    Assert.strictEqual(replaced.result.revision, 1);
    Assert.deepStrictEqual(
        replaced.result.settings.ownProxies[0].credentials,
        {mode: 'KEEP', username: 'fixture-user'},
    );
    Assert.strictEqual(JSON.stringify(replaced).includes('fixture-password'), false);
    Assert.strictEqual(
        JSON.stringify(storage.values[ProductConfig.CONFIG_STORAGE_KEY])
            .includes('fixture-password'),
        false,
    );
    Assert.strictEqual(
        storage.values[ProductConfig.CREDENTIALS_STORAGE_KEY]
            .entries[0].password,
        'fixture-password',
    );

  });

  it('serializes settings writes and rejects stale revisions', async function() {

    const productConfig = await ProductionProvider.createProductionProductConfig(
        async (bytes) => Helpers.sha256(Buffer.from(bytes)),
    );
    const storage = makeStorage();
    storage.values[ProductConfig.CONFIG_STORAGE_KEY] = productConfig;
    const eventPage = startEventPage({storage});
    const current = await eventPage.send({type: 'firefox.settings.get'});
    const first = JSON.parse(JSON.stringify(current.result.settings));
    const second = JSON.parse(JSON.stringify(current.result.settings));
    first.flags.noDirect = true;
    second.flags.replaceDirectWithProxy = true;
    const results = await Promise.all([
      eventPage.send({
        type: 'firefox.settings.replace',
        expectedRevision: 0,
        settings: first,
      }),
      eventPage.send({
        type: 'firefox.settings.replace',
        expectedRevision: 0,
        settings: second,
      }),
    ]);

    Assert.strictEqual(results.filter((result) => result.ok).length, 1);
    Assert.deepStrictEqual(
        results.find((result) => !result.ok),
        {ok: false, error: {code: 'SETTINGS_REVISION_CONFLICT'}},
    );

  });

  it('rejects settings mutation while production routing is active',
      async function() {

        const productConfig = await ProductionProvider.createProductionProductConfig(
            async (bytes) => Helpers.sha256(Buffer.from(bytes)),
        );
        const storage = makeStorage();
        storage.values[ProductConfig.CONFIG_STORAGE_KEY] = productConfig;
        const prepared = await preparedActivation();
        const eventPage = startEventPage({
          storage,
          privateWindowAccess: true,
          activationFactory: async () => prepared,
        });
        const current = await eventPage.send({type: 'firefox.settings.get'});
        Assert.strictEqual((await eventPage.send({
          type: 'firefox.activation.apply',
        })).ok, true);
        const result = await eventPage.send({
          type: 'firefox.settings.replace',
          expectedRevision: current.result.revision,
          settings: current.result.settings,
        });

        Assert.deepStrictEqual(result, {
          ok: false,
          error: {code: 'SETTINGS_MUTATION_REQUIRES_OFF'},
        });

      });

  it('supports Clear then settings replace then a new explicit Apply',
      async function() {

        const productConfig = await ProductionProvider.createProductionProductConfig(
            async (bytes) => Helpers.sha256(Buffer.from(bytes)),
        );
        const storage = makeStorage();
        storage.values[ProductConfig.CONFIG_STORAGE_KEY] = productConfig;
        const prepared = await preparedActivation();
        const eventPage = startEventPage({
          storage,
          privateWindowAccess: true,
          activationFactory: async () => prepared,
        });
        Assert.strictEqual((await eventPage.send({
          type: 'firefox.activation.apply',
        })).ok, true);
        Assert.strictEqual((await eventPage.send({
          type: 'firefox.activation.clear',
        })).ok, true);
        const current = await eventPage.send({type: 'firefox.settings.get'});
        current.result.settings.flags.noDirect = true;
        Assert.strictEqual((await eventPage.send({
          type: 'firefox.settings.replace',
          expectedRevision: current.result.revision,
          settings: current.result.settings,
        })).ok, true);
        Assert.strictEqual((await eventPage.send({
          type: 'firefox.activation.apply',
        })).ok, true);
        Assert.strictEqual(eventPage.proxySettingsCalls.set, 2);
        Assert.strictEqual(eventPage.proxySettingsCalls.clear, 1);

      });

  it('reloads committed settings after genuine event-page recreation',
      async function() {

        const productConfig = await ProductionProvider.createProductionProductConfig(
            async (bytes) => Helpers.sha256(Buffer.from(bytes)),
        );
        const storage = makeStorage();
        storage.values[ProductConfig.CONFIG_STORAGE_KEY] = productConfig;
        const first = startEventPage({storage, bootId: 'settings-boot-one'});
        const current = await first.send({type: 'firefox.settings.get'});
        current.result.settings.rules.direct = ['direct.example'];
        Assert.strictEqual((await first.send({
          type: 'firefox.settings.replace',
          expectedRevision: 0,
          settings: current.result.settings,
        })).ok, true);
        const second = startEventPage({storage, bootId: 'settings-boot-two'});
        const restored = await second.send({type: 'firefox.settings.get'});

        Assert.strictEqual(restored.result.revision, 1);
        Assert.deepStrictEqual(
            restored.result.settings.rules.direct,
            ['direct.example'],
        );
        Assert.notStrictEqual(
            first.context.rucbFirefoxSkeletonRuntime.bootId,
            second.context.rucbFirefoxSkeletonRuntime.bootId,
        );

      });

  it('maps production floor prerequisites and failures without activation',
      async function() {

        const prepared = await preparedActivation();
        const cases = [
          [
            {privateWindowAccess: false},
            'PRIVATE_ACCESS_REQUIRED',
          ],
          [
            {
              privateWindowAccess: true,
              randomError: new Error('synthetic random failure'),
            },
            'FLOOR_GENERATION_FAILED',
          ],
          [
            {
              privateWindowAccess: true,
              proxySetError: new Error('synthetic proxy write failure'),
            },
            'ACTIVATION_ROLLBACK_FAILED',
          ],
          [
            {
              privateWindowAccess: true,
              afterSetProxySettings: {
                levelOfControl: 'controlled_by_other_extensions',
                value: {proxyType: 'none'},
              },
            },
            'ACTIVATION_ROLLBACK_FAILED',
          ],
        ];
        for (const [options, code] of cases) {
          const eventPage = startEventPage(Object.assign({}, options, {
            activationFactory: async () => prepared,
          }));
          const result = await eventPage.send({
            type: 'firefox.activation.apply',
          });
          Assert.strictEqual(result.ok, false);
          Assert.strictEqual(result.error.code, code);
          Assert.strictEqual(
              (await eventPage.send({type: 'firefox.capabilities.get'}))
                  .result.providerDatasetAvailable,
              true,
          );
        }

      });

  it('exposes exact-match Clear but never acquisition through RPC', async function() {

    const eventPage = startEventPage();
    const cleared = await eventPage.send({type: 'firefox.activation.clear'});

    Assert.deepStrictEqual(cleared, {
      ok: true,
      result: {intent: 'OFF', status: 'ALREADY_CLEAR'},
    });
    Assert.strictEqual(eventPage.proxySettingsCalls.set, 0);
    Assert.strictEqual(eventPage.proxySettingsCalls.clear, 0);

  });

  it('recreates an event page with a fresh boot and the same OFF intent', async function() {

    const storage = makeStorage();
    const first = startEventPage({storage, bootId: 'boot-one'});
    await first.ready();
    const second = startEventPage({storage, bootId: 'boot-two'});
    await second.ready();
    const capabilities = await second.send({type: 'firefox.capabilities.get'});

    Assert.strictEqual(first.context.rucbFirefoxSkeletonRuntime.bootId, 'boot-one');
    Assert.strictEqual(second.context.rucbFirefoxSkeletonRuntime.bootId, 'boot-two');
    Assert.strictEqual(capabilities.result.runtimeState, 'OFF');
    Assert.deepStrictEqual(
        JSON.parse(JSON.stringify(storage.values[OffState.STORAGE_KEY])), {
          schemaVersion: 3,
          intent: 'OFF',
          floorIdentity: null,
        });

  });

  it('contains no remote execution or caller-controlled activation input',
      function() {

        const runtimeSource = [
          offStateSource,
          proxyControlSource,
          datasetStoreSource,
          providerUpdaterSource,
          providerLookupSource,
          datasetRuntimeSource,
          routingAdapterSource,
          proxyAuthSource,
          productConfigSource,
          productionProviderSource,
          activationControllerSource,
        ].join('\n');
        for (const forbidden of [
          'XMLHttpRequest',
          'extension-chromium-mv3',
          'eval(',
          'Function(',
        ]) {
          Assert.strictEqual(runtimeSource.includes(forbidden), false, forbidden);
        }
        Assert.strictEqual(
            eventPageSource.includes('root.fetch(packagedUrl'),
            true,
        );
        Assert.strictEqual(eventPageSource.includes('http://'), false);
        Assert.strictEqual(eventPageSource.includes('https://'), false);
        Assert.strictEqual(
            eventPageSource.includes('acquireRandomFloor('),
            false,
        );
        Assert.strictEqual(eventPageSource.includes('activatePrepared('), true);
        Assert.strictEqual(
            eventPageSource.includes('createActivationFactory('),
            true,
        );
        Assert.strictEqual(eventPageSource.includes('fetchAndStage'), false);
        Assert.strictEqual(eventPageSource.includes('promoteStaged'), false);
        Assert.strictEqual(eventPageSource.includes('recoveryFactory,'), true);
        Assert.strictEqual(eventPageSource.includes('proxy.settings.set'), false);

      });

});
