'use strict';

const Assert = require('node:assert');
const Crypto = require('node:crypto');
const Config = require('../background/product-config');
const Production = require('../background/production-provider');
const Settings = require('../background/settings-control');

function sha256(bytes) {

  return Promise.resolve(Crypto.createHash('sha256').update(bytes).digest('hex'));

}

function storage(initial = {}, options = {}) {

  const values = structuredClone(initial);
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
            result[key] = structuredClone(values[key]);
          }
        }
        return result;

      },
      async set(update) {

        setCalls += 1;
        writes.push(structuredClone(update));
        if (options.failSetCall === setCalls) {
          if (typeof options.partialSet === 'function') {
            options.partialSet(values, update);
          }
          throw new Error('synthetic storage interruption');
        }
        Object.assign(values, structuredClone(update));

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

async function initialStorage(options = {}) {

  const config = await Production.createProductionProductConfig(sha256);
  return storage({[Config.CONFIG_STORAGE_KEY]: config}, options);

}

function activation(state = {}) {

  return Object.assign({
    active: false,
    durableIntent: 'OFF',
    runtimeState: 'OFF',
  }, state);

}

function controller(store, state = activation()) {

  return Settings.createController({
    storageArea: store.area,
    sha256,
    activationSnapshot: () => state,
    datasetIdentityAvailable: () => true,
  });

}

function ownProxy(overrides = {}) {

  return Object.assign({
    id: 'primary',
    enabled: true,
    type: 'HTTPS',
    host: 'proxy.example',
    port: 8443,
    proxyDNS: false,
    failoverTimeoutSeconds: null,
    useAsDirectReplacement: false,
    credentials: {mode: 'NONE'},
  }, overrides);

}

async function rejectsCode(operation, code) {

  await Assert.rejects(operation, (error) => error && error.code === code);

}

describe('Firefox production settings control plane', function() {

  it('maps defaults exactly to the packaged production routing config', function() {

    const settings = Settings.createDefaultSettings();
    const built = Settings.buildRoutingSnapshot(settings);

    Assert.deepStrictEqual(
        built.routingConfig,
        Production.createProductionRoutingConfig(),
    );
    Assert.deepStrictEqual(settings.flags, {
      noDirect: false,
      ownProxiesOnlyForOwnSites: true,
      replaceDirectWithProxy: false,
      useProviderProxies: true,
    });

  });

  it('reads revision zero without exposing internal product identity', async function() {

    const store = await initialStorage();
    const result = await controller(store).get();

    Assert.strictEqual(result.revision, 0);
    Assert.strictEqual(result.settings.schemaVersion, 1);
    for (const forbidden of [
      'artifactSha256', 'authRef', 'configurationSha256', 'datasetIdentity',
      'floorIdentity', 'providerKey',
    ]) {
      Assert.strictEqual(JSON.stringify(result).includes(forbidden), false);
    }

  });

  it('preserves every routing flag and exact rule list', async function() {

    const store = await initialStorage();
    const api = controller(store);
    const settings = Settings.createDefaultSettings();
    settings.flags = {
      noDirect: true,
      ownProxiesOnlyForOwnSites: false,
      replaceDirectWithProxy: true,
      useProviderProxies: false,
    };
    settings.rules = {
      direct: ['direct.example'],
      proxy: ['*.proxy.example'],
      whitelist: ['allowed.example'],
    };
    const replaced = await api.replace(0, settings);

    Assert.deepStrictEqual(replaced.settings.flags, settings.flags);
    Assert.deepStrictEqual(replaced.settings.rules, settings.rules);
    Assert.strictEqual(replaced.revision, 1);

  });

  it('normalizes user host and wildcard input before persistence', function() {

    const settings = Settings.createDefaultSettings();
    settings.rules.direct = ['  *.Example.COM.  '];
    settings.ownProxies = [ownProxy({host: ' Proxy.Example '})];
    const canonical = Settings.canonicalSettings(settings);

    Assert.deepStrictEqual(canonical.rules.direct, ['*.example.com']);
    Assert.strictEqual(canonical.ownProxies[0].host, 'proxy.example');

  });

  it('preserves own, Tor, Tor Browser, and WARP candidate ordering', function() {

    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [
      ownProxy({id: 'own-a', host: 'a.example'}),
      ownProxy({id: 'own-b', host: 'b.example'}),
    ];
    settings.localTor.useForProxyRules = true;
    settings.torBrowser.useForProxyRules = true;
    settings.warp.useForProxyRules = true;
    const configured = Settings.buildRoutingSnapshot(settings)
        .routingConfig.candidateGroups.configured;

    Assert.deepStrictEqual(
        configured.own.map((item) => item.id),
        ['own-a', 'own-b'],
    );
    Assert.deepStrictEqual(
        configured.localTor.map((item) => item.id),
        ['anticensority-local-tor'],
    );
    Assert.deepStrictEqual(
        configured.torBrowser.map((item) => item.id),
        ['anticensority-tor-browser'],
    );
    Assert.deepStrictEqual(
        configured.warp.map((item) => item.id),
        ['firefox-warp-socks5', 'firefox-warp-https'],
    );

  });

  it('keeps onion and Direct-replacement scopes explicit', function() {

    const settings = Settings.createDefaultSettings();
    settings.localTor.useForOnion = false;
    settings.localTor.useAsDirectReplacement = true;
    settings.torBrowser.useForOnion = true;
    settings.warp.useAsDirectReplacement = true;
    settings.ownProxies = [ownProxy({useAsDirectReplacement: true})];
    const groups = Settings.buildRoutingSnapshot(settings)
        .routingConfig.candidateGroups;

    Assert.deepStrictEqual(groups.onion.localTor, []);
    Assert.strictEqual(groups.onion.torBrowser.length, 1);
    Assert.strictEqual(groups.directReplacement.own.length, 1);
    Assert.strictEqual(groups.directReplacement.localTor.length, 1);
    Assert.strictEqual(groups.directReplacement.warp.length, 2);

  });

  it('derives authRef internally and stores credentials separately', async function() {

    const store = await initialStorage();
    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [ownProxy({
      credentials: {
        mode: 'SET',
        username: 'fixture-user',
        password: 'synthetic-password',
      },
    })];
    const result = await controller(store).replace(0, settings);
    const config = store.values[Config.CONFIG_STORAGE_KEY];
    const credentials = store.values[Config.CREDENTIALS_STORAGE_KEY];

    Assert.deepStrictEqual(result.settings.ownProxies[0].credentials, {
      mode: 'KEEP', username: 'fixture-user',
    });
    Assert.strictEqual(
        config.routingConfig.candidateGroups.configured.own[0].authRef,
        'own.primary',
    );
    Assert.deepStrictEqual(credentials.entries, [{
      authRef: 'own.primary',
      username: 'fixture-user',
      password: 'synthetic-password',
    }]);
    Assert.strictEqual(JSON.stringify(config).includes('synthetic-password'), false);
    Assert.strictEqual(JSON.stringify(result).includes('synthetic-password'), false);

  });

  it('round-trips a redacted credential only for the same exact proxy', async function() {

    const store = await initialStorage();
    const api = controller(store);
    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [ownProxy({credentials: {
      mode: 'SET', username: 'fixture-user', password: 'fixture-secret',
    }})];
    const first = await api.replace(0, settings);
    first.settings.flags.noDirect = true;
    const second = await api.replace(1, first.settings);

    Assert.strictEqual(second.revision, 2);
    Assert.strictEqual(
        store.values[Config.CREDENTIALS_STORAGE_KEY].entries[0].password,
        'fixture-secret',
    );

  });

  it('rejects stale credential preservation after endpoint change', async function() {

    const store = await initialStorage();
    const api = controller(store);
    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [ownProxy({credentials: {
      mode: 'SET', username: 'fixture-user', password: 'fixture-secret',
    }})];
    const current = await api.replace(0, settings);
    current.settings.ownProxies[0].port = 9443;

    await rejectsCode(
        api.replace(1, current.settings),
        Settings.ERRORS.SETTINGS_CREDENTIAL_STALE,
    );

  });

  it('does not persist an unreachable credential for a disabled proxy', function() {

    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [ownProxy({
      enabled: false,
      credentials: {mode: 'SET', username: 'user', password: 'secret'},
    })];
    Assert.throws(
        () => Settings.buildRoutingSnapshot(
            Settings.canonicalSettings(settings),
        ),
        (error) => error.code ===
          Settings.ERRORS.SETTINGS_CREDENTIAL_AMBIGUOUS,
    );

  });

  it('removes credentials only through an explicit NONE intent', async function() {

    const store = await initialStorage();
    const api = controller(store);
    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [ownProxy({credentials: {
      mode: 'SET', username: 'fixture-user', password: 'fixture-secret',
    }})];
    const current = await api.replace(0, settings);
    current.settings.ownProxies[0].credentials = {mode: 'NONE'};
    await api.replace(1, current.settings);

    Assert.deepStrictEqual(
        store.values[Config.CREDENTIALS_STORAGE_KEY].entries,
        [],
    );
    Assert.strictEqual(
        store.values[Config.CONFIG_STORAGE_KEY]
            .routingConfig.candidateGroups.configured.own[0].authRef,
        null,
    );

  });

  it('rejects unknown, malformed, future, and unsafe rule input', function() {

    const defaults = Settings.createDefaultSettings();
    const cases = [
      Object.assign({}, defaults, {extra: true}),
      Object.assign({}, defaults, {schemaVersion: 2}),
      Object.assign({}, defaults, {rules: {
        direct: ['HTTPS://unsafe.example'], proxy: [], whitelist: [],
      }}),
      Object.assign({}, defaults, {rules: {
        direct: ['same.example', 'same.example'], proxy: [], whitelist: [],
      }}),
    ];
    for (const value of cases) {
      Assert.throws(
          () => Settings.buildRoutingSnapshot(
              Settings.canonicalSettings(value),
          ),
      );
    }

  });

  it('rejects duplicate identifiers and ambiguous proxy endpoints', function() {

    const duplicateId = Settings.createDefaultSettings();
    duplicateId.ownProxies = [ownProxy(), ownProxy({host: 'other.example'})];
    Assert.throws(() => Settings.canonicalSettings(duplicateId));

    const duplicateEndpoint = Settings.createDefaultSettings();
    duplicateEndpoint.ownProxies = [
      ownProxy({id: 'a'}), ownProxy({id: 'b'}),
    ];
    Assert.throws(() => Settings.buildRoutingSnapshot(
        Settings.canonicalSettings(duplicateEndpoint),
    ), (error) => error.code === Settings.ERRORS.SETTINGS_CREDENTIAL_AMBIGUOUS);

  });

  it('rejects password-like unknown fields outside the credential record', function() {

    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [Object.assign(ownProxy(), {
      password: 'must-not-be-accepted',
    })];
    Assert.throws(() => Settings.canonicalSettings(settings));

  });

  it('enforces optimistic revision checks across serialized writes', async function() {

    const store = await initialStorage();
    const api = controller(store);
    const first = Settings.createDefaultSettings();
    const second = Settings.createDefaultSettings();
    first.flags.noDirect = true;
    second.flags.replaceDirectWithProxy = true;
    const results = await Promise.allSettled([
      api.replace(0, first),
      api.replace(0, second),
    ]);

    Assert.strictEqual(results.filter((item) => item.status === 'fulfilled').length, 1);
    Assert.strictEqual(results.find((item) => item.status === 'rejected')
        .reason.code, Settings.ERRORS.SETTINGS_REVISION_CONFLICT);

  });

  it('rejects writes in ACTIVE, INITIALIZING, or recovery-blocked states', async function() {

    for (const state of [
      activation({active: true, durableIntent: 'ON', runtimeState: 'READY'}),
      activation({runtimeState: 'INITIALIZING'}),
      activation({durableIntent: 'ON', runtimeState: 'FAILED'}),
    ]) {
      const store = await initialStorage();
      await rejectsCode(
          controller(store, state).replace(0, Settings.createDefaultSettings()),
          Settings.ERRORS.SETTINGS_MUTATION_REQUIRES_OFF,
      );
      Assert.strictEqual(store.writes.length, 0);
    }

  });

  it('writes a mutation marker before one descriptor-bound record set', async function() {

    const store = await initialStorage();
    await controller(store).replace(0, Settings.createDefaultSettings());

    Assert.strictEqual(store.writes.length, 2);
    Assert.deepStrictEqual(store.writes[0], {
      [Config.SETTINGS_TRANSACTION_STORAGE_KEY]: {
        schemaVersion: 1, status: 'WRITING',
      },
    });
    Assert.deepStrictEqual(Object.keys(store.writes[1]).sort(), [
      Config.CONFIG_STORAGE_KEY,
      Config.CREDENTIALS_STORAGE_KEY,
      Config.SETTINGS_COMMIT_STORAGE_KEY,
    ].sort());
    Assert.strictEqual(store.removals.length, 1);

  });

  it('blocks activation when a settings write is interrupted', async function() {

    const store = await initialStorage({
      failSetCall: 2,
      partialSet(values, update) {

        values[Config.CONFIG_STORAGE_KEY] = structuredClone(
            update[Config.CONFIG_STORAGE_KEY],
        );
        values[Config.SETTINGS_COMMIT_STORAGE_KEY] = structuredClone(
            update[Config.SETTINGS_COMMIT_STORAGE_KEY],
        );

      },
    });
    await rejectsCode(
        controller(store).replace(0, Settings.createDefaultSettings()),
        Settings.ERRORS.SETTINGS_STORAGE_FAILED,
    );
    Assert.strictEqual(
        Config.SETTINGS_TRANSACTION_STORAGE_KEY in store.values,
        true,
    );
    Assert.strictEqual(
        Config.CREDENTIALS_STORAGE_KEY in store.values,
        false,
    );
    const factory = Config.createActivationFactory({
      storageArea: store.area,
      createDatasetStore: () => ({loadVerifications() {}}),
      sha256,
    });
    await Assert.rejects(factory(), (error) =>
      error.code === Config.ERRORS.PRODUCT_CONFIG_UPDATE_INCOMPLETE);

  });

  it('clears a completed crash marker only after all descriptors match', async function() {

    const store = await initialStorage({failRemove: true});
    await rejectsCode(
        controller(store).replace(0, Settings.createDefaultSettings()),
        Settings.ERRORS.SETTINGS_STORAGE_FAILED,
    );
    Assert.strictEqual(
        Config.SETTINGS_TRANSACTION_STORAGE_KEY in store.values,
        true,
    );
    const resumed = storage(store.values);
    const result = await controller(resumed).get();

    Assert.strictEqual(result.revision, 1);
    Assert.strictEqual(
        Config.SETTINGS_TRANSACTION_STORAGE_KEY in resumed.values,
        false,
    );

  });

  it('never pairs a committed settings record with old credentials', async function() {

    const store = await initialStorage();
    const api = controller(store);
    const settings = Settings.createDefaultSettings();
    settings.ownProxies = [ownProxy({credentials: {
      mode: 'SET', username: 'fixture-user', password: 'fixture-secret',
    }})];
    await api.replace(0, settings);
    store.values[Config.CREDENTIALS_STORAGE_KEY].routingDescriptor = {
      schemaVersion: 1,
      configurationKey: 'old',
      configurationVersion: 'old',
      configurationSha256: '0'.repeat(64),
    };

    await rejectsCode(api.get(), Settings.ERRORS.SETTINGS_STATE_UNAVAILABLE);
    const factory = Config.createActivationFactory({
      storageArea: store.area,
      createDatasetStore: () => ({loadVerifications() {}}),
      sha256,
    });
    await Assert.rejects(factory(), (error) =>
      error.code === Config.ERRORS.CREDENTIAL_CONFIG_DESCRIPTOR_MISMATCH);

  });

  it('survives controller recreation with the exact sanitized settings', async function() {

    const store = await initialStorage();
    const settings = Settings.createDefaultSettings();
    settings.rules.proxy = ['*.proxy.example'];
    settings.ownProxies = [ownProxy()];
    await controller(store).replace(0, settings);
    const recreated = await controller(store).get();

    Assert.strictEqual(recreated.revision, 1);
    Assert.deepStrictEqual(recreated.settings.rules.proxy, ['*.proxy.example']);
    Assert.strictEqual(recreated.settings.ownProxies[0].id, 'primary');

  });

  it('preserves an internally promoted dataset identity across settings writes',
      async function() {

        const store = await initialStorage();
        const promotedIdentity = {
          providerKey: Production.PROVIDER_KEY,
          datasetVersion: 'authenticated-v2',
          artifactSha256: 'b'.repeat(64),
        };
        store.values[Config.CONFIG_STORAGE_KEY].datasetIdentity =
          promotedIdentity;
        const api = controller(store);
        const current = await api.get();
        current.settings.flags.noDirect = true;
        await api.replace(current.revision, current.settings);

        Assert.deepStrictEqual(
            store.values[Config.CONFIG_STORAGE_KEY].datasetIdentity,
            promotedIdentity,
        );

      });

  it('rejects a config whose exact dataset identity is not installed',
      async function() {

        const store = await initialStorage();
        const api = Settings.createController({
          storageArea: store.area,
          sha256,
          activationSnapshot: () => activation(),
          datasetIdentityAvailable: () => false,
        });
        await rejectsCode(
            api.get(),
            Settings.ERRORS.SETTINGS_DATASET_BINDING_FAILED,
        );

      });

  it('has no browser, network, logging, or dataset mutation dependency', function() {

    const source = require('node:fs').readFileSync(
        require.resolve('../background/settings-control'),
        'utf8',
    );
    for (const forbidden of [
      'browser.', 'chrome.', 'fetch(', 'console.', 'promoteStaged',
      'commitPackagedBaseline', 'proxy.settings',
    ]) {
      Assert.strictEqual(source.includes(forbidden), false, forbidden);
    }

  });

});
