'use strict';

const Assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');
const Vm = require('node:vm');
const OffState = require('../background/off-state');

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

        return key in values ? {[key]: values[key]} : {};

      },
      async set(update) {

        writes.push(update);
        Object.assign(values, update);

      },
    },
  };

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
        async clear() {

          proxySettingsCalls.clear += 1;
          events.push('proxy-settings-clear');
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
          liveProxySettings = {
            levelOfControl: 'controlled_by_this_extension',
            value: update.value,
          };

        },
      },
    },
    storage: {
      local: {
        async get(key) {

          events.push('storage-get');
          return storage.area.get(key);

        },
        async set(update) {

          events.push('storage-set');
          return storage.area.set(update);

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
    crypto: {randomUUID: () => options.bootId || 'test-boot'},
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
  Vm.runInContext(activationControllerSource, context, {
    filename: 'activation-controller.js',
  });
  Vm.runInContext(eventPageSource, context, {filename: 'event-page.js'});
  return {
    context,
    events,
    networkListeners,
    proxySettingsCalls,
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

describe('Firefox MV3 inert skeleton', function() {

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
        'background/provider-lookup.js',
        'background/dataset-runtime.js',
        'background/routing-adapter.js',
        'background/proxy-auth.js',
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

        Assert.deepStrictEqual(eventPage.events.slice(0, 7), [
          'proxy-listener-registered',
          'guard-listener-registered',
          'auth-listener-registered',
          'completed-listener-registered',
          'error-listener-registered',
          'listener-registered',
          'storage-get',
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

  it('reports stable OFF-only capabilities', async function() {

    const eventPage = startEventPage({privateWindowAccess: true});
    const response = await eventPage.send({type: 'firefox.capabilities.get'});

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
        activationSupported: false,
        providerDatasetImplemented: true,
        providerDatasetAvailable: false,
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

  it('does not recover durable ON without a production recovery factory',
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
            'RECOVERY_UNAVAILABLE',
        );
        Assert.strictEqual(eventPage.proxySettingsCalls.set, 0);
        Assert.strictEqual(eventPage.proxySettingsCalls.clear, 0);

      });

  it('rejects activation without changing OFF state', async function() {

    const eventPage = startEventPage();
    const activation = await eventPage.send({type: 'firefox.activation.apply'});
    const capabilities = await eventPage.send({type: 'firefox.capabilities.get'});

    Assert.deepStrictEqual(activation, {
      ok: false,
      error: {code: 'ACTIVATION_NOT_IMPLEMENTED'},
    });
    Assert.strictEqual(capabilities.result.runtimeState, 'OFF');
    Assert.strictEqual(capabilities.result.durableIntent, 'OFF');

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

  it('contains no production activation call or remote execution path',
      function() {

        const runtimeSource = [
          offStateSource,
          proxyControlSource,
          datasetStoreSource,
          providerLookupSource,
          datasetRuntimeSource,
          routingAdapterSource,
          proxyAuthSource,
          activationControllerSource,
          eventPageSource,
        ].join('\n');
        for (const forbidden of [
          'XMLHttpRequest',
          'fetch(',
          'extension-chromium-mv3',
          'eval(',
          'Function(',
        ]) {
          Assert.strictEqual(runtimeSource.includes(forbidden), false, forbidden);
        }
        Assert.strictEqual(
            eventPageSource.includes('acquirePrevalidatedFloor('),
            false,
        );
        Assert.strictEqual(eventPageSource.includes('activatePrepared('), false);
        Assert.strictEqual(eventPageSource.includes('recoveryFactory:'), false);
        Assert.strictEqual(eventPageSource.includes('proxy.settings.set'), false);

      });

});
