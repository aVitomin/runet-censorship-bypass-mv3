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
  let messageListener;
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
  };
  const context = Vm.createContext({
    browser,
    crypto: {randomUUID: () => options.bootId || 'test-boot'},
  });
  Vm.runInContext(offStateSource, context, {filename: 'off-state.js'});
  Vm.runInContext(eventPageSource, context, {filename: 'event-page.js'});
  return {
    context,
    events,
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
      scripts: ['background/off-state.js', 'background/event-page.js'],
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

  it('requests storage and no routing or broad host permissions', function() {

    Assert.deepStrictEqual(manifest.permissions, ['storage']);
    Assert.strictEqual('host_permissions' in manifest, false);
    const serialized = JSON.stringify(manifest);
    for (const forbidden of [
      'proxy',
      'webRequest',
      'webRequestBlocking',
      '<all_urls>',
    ]) {
      Assert.strictEqual(serialized.includes(`"${forbidden}"`), false);
    }

  });

  it('normalizes every missing or malformed durable value to OFF', function() {

    for (const value of [
      undefined,
      null,
      'OFF',
      {schemaVersion: 1, intent: 'ON'},
      {schemaVersion: 2, intent: 'OFF'},
      {schemaVersion: 1, intent: 'OFF', extra: true},
    ]) {
      Assert.deepStrictEqual(OffState.normalizeDurableState(value), {
        schemaVersion: 1,
        intent: 'OFF',
      });
    }

  });

  it('persists canonical OFF when durable state is missing', async function() {

    const storage = makeStorage();
    const state = await OffState.initialize(storage.area);

    Assert.deepStrictEqual(state, {schemaVersion: 1, intent: 'OFF'});
    Assert.deepStrictEqual(storage.writes, [{
      [OffState.STORAGE_KEY]: {schemaVersion: 1, intent: 'OFF'},
    }]);

  });

  it('overwrites a non-OFF durable value', async function() {

    const storage = makeStorage({schemaVersion: 1, intent: 'ON'});
    await OffState.initialize(storage.area);

    Assert.deepStrictEqual(
        JSON.parse(JSON.stringify(storage.values[OffState.STORAGE_KEY])), {
          schemaVersion: 1,
          intent: 'OFF',
        });

  });

  it('does not rewrite canonical durable OFF', async function() {

    const storage = makeStorage({schemaVersion: 1, intent: 'OFF'});
    await OffState.initialize(storage.area);

    Assert.deepStrictEqual(storage.writes, []);

  });

  it('registers the RPC listener before asynchronous state reading', async function() {

    const eventPage = startEventPage();
    await eventPage.ready();

    Assert.deepStrictEqual(eventPage.events.slice(0, 2), [
      'listener-registered',
      'storage-get',
    ]);

  });

  it('reports stable OFF-only capabilities', async function() {

    const eventPage = startEventPage({privateWindowAccess: true});
    const response = await eventPage.send({type: 'firefox.capabilities.get'});

    Assert.deepStrictEqual(response, {
      ok: true,
      result: {
        apiVersion: 1,
        browser: 'FIREFOX',
        manifestVersion: 3,
        runtimeModel: 'BACKGROUND_EVENT_PAGE',
        runtimeState: 'OFF',
        durableIntent: 'OFF',
        privateWindowAccess: 'GRANTED',
        routingImplemented: false,
        activationSupported: false,
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
          schemaVersion: 1,
          intent: 'OFF',
        });

  });

  it('contains no network-control, remote-fetch, or Chromium-state path', function() {

    const runtimeSource = `${offStateSource}\n${eventPageSource}`;
    for (const forbidden of [
      'browser.proxy',
      'proxy.settings',
      'webRequest',
      'XMLHttpRequest',
      'fetch(',
      'extension-chromium-mv3',
      'provider-dataset',
    ]) {
      Assert.strictEqual(runtimeSource.includes(forbidden), false, forbidden);
    }

  });

});
