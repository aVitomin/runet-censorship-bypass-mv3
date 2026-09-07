'use strict';

const Assert = require('node:assert');
const Config = require('../background/product-config');
const OffState = require('../background/off-state');
const Routing = require('../../extension-mv3-common/routing-contract');
const Helpers = require('./dataset-test-helpers');

function sha256(bytes) {

  return Promise.resolve(Helpers.sha256(Buffer.from(bytes)));

}

function candidate(overrides = {}) {

  return Object.assign({
    authRef: null,
    failoverTimeoutSeconds: null,
    host: 'proxy.test',
    id: 'fixture-proxy',
    port: 8080,
    proxyDNS: false,
    type: 'HTTP',
  }, overrides);

}

function emptyGroups() {

  const group = () => ({own: [], localTor: [], torBrowser: [], warp: []});
  return {
    configured: group(),
    directReplacement: group(),
    onion: group(),
  };

}

function routingConfig(overrides = {}) {

  return Object.assign({
    candidateGroups: emptyGroups(),
    flags: {
      noDirect: false,
      ownProxiesOnlyForOwnSites: true,
      replaceDirectWithProxy: false,
      useProviderProxies: true,
    },
    providerCandidates: [candidate()],
    providerFallback: Routing.FALLBACKS.DIRECT,
    rules: {direct: [], proxy: [], whitelist: []},
  }, overrides);

}

function datasetIdentity() {

  const fixture = Helpers.artifact();
  return {
    providerKey: fixture.envelope.providerKey,
    datasetVersion: fixture.envelope.datasetVersion,
    artifactSha256: fixture.envelope.artifactSha256,
  };

}

async function productConfig(options = {}) {

  return Config.createProductConfig({
    configurationKey: options.configurationKey || 'synthetic-routing',
    configurationVersion: options.configurationVersion || '1',
    datasetIdentity: options.datasetIdentity || datasetIdentity(),
    providerKey: options.providerKey || Helpers.PROVIDER_KEY,
    routingConfig: options.routingConfig || routingConfig(),
    sha256,
  });

}

function credentialConfig(descriptor, entries = []) {

  return {
    schemaVersion: Config.SCHEMA_VERSION,
    routingDescriptor: descriptor,
    entries,
  };

}

function durableOn(config) {

  return OffState.canonicalOnState({
    floorIdentity: {
      proxyType: 'manual',
      http: '',
      httpProxyAll: false,
      ssl: '',
      socks: '127.0.0.1:55101',
      socksVersion: 5,
      proxyDNS: true,
      passthrough: '',
      autoConfigUrl: '',
    },
    providerKey: config.providerKey,
    datasetIdentity: config.datasetIdentity,
    routingDescriptor: config.routingDescriptor,
  });

}

function storage(values = {}, error = null) {

  return {
    async get(keys) {

      if (error) {
        throw error;
      }
      const result = {};
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          result[key] = structuredClone(values[key]);
        }
      }
      return result;

    },
  };

}

function recoveryFactory(values, options = {}) {

  return Config.createRecoveryFactory({
    storageArea: storage(values, options.storageError),
    createDatasetStore: options.createDatasetStore || (() => ({
      loadVerifications() {},
    })),
    sha256,
  });

}

function activationFactory(values, options = {}) {

  return Config.createActivationFactory({
    storageArea: storage(values, options.storageError),
    createDatasetStore: options.createDatasetStore || (() => ({
      loadVerifications() {},
    })),
    sha256,
  });

}

async function rejectsCode(operation, code) {

  await Assert.rejects(operation, (error) => error && error.code === code);

}

describe('Firefox production recovery configuration', function() {

  it('builds a deterministic descriptor over canonical routing bytes',
      async function() {

        const first = await productConfig();
        const second = await productConfig({
          routingConfig: {
            rules: {whitelist: [], proxy: [], direct: []},
            providerFallback: Routing.FALLBACKS.DIRECT,
            providerCandidates: [candidate()],
            flags: {
              useProviderProxies: true,
              replaceDirectWithProxy: false,
              ownProxiesOnlyForOwnSites: true,
              noDirect: false,
            },
            candidateGroups: emptyGroups(),
          },
        });

        Assert.strictEqual(
            first.routingDescriptor.configurationSha256,
            second.routingDescriptor.configurationSha256,
        );
        Assert.strictEqual(
            first.routingDescriptor.configurationSha256,
            Helpers.sha256(Config.routingConfigBytes(first.routingConfig)),
        );

      });

  it('preserves every browser-neutral routing input field', async function() {

    const config = routingConfig({
      rules: {
        direct: ['direct.example'],
        proxy: ['*.proxy.example'],
        whitelist: ['allowed.example'],
      },
      flags: {
        noDirect: true,
        ownProxiesOnlyForOwnSites: false,
        replaceDirectWithProxy: true,
        useProviderProxies: false,
      },
    });
    config.candidateGroups.configured.own.push(candidate());
    config.candidateGroups.onion.localTor.push(candidate({
      id: 'tor',
      host: '127.0.0.1',
      port: 9050,
      proxyDNS: true,
      type: 'SOCKS5',
    }));
    config.candidateGroups.directReplacement.warp.push(candidate({
      id: 'warp',
      host: 'warp.test',
      port: 8443,
      type: 'HTTPS',
    }));
    const persisted = await productConfig({routingConfig: config});

    Assert.deepStrictEqual(persisted.routingConfig, config);
    Assert.strictEqual(Object.isFrozen(persisted.routingConfig), true);

  });

  it('rejects malformed, future, and unknown product schemas', async function() {

    const valid = await productConfig();
    for (const value of [
      null,
      Object.assign({}, valid, {schemaVersion: 2}),
      Object.assign({}, valid, {extra: true}),
      Object.assign({}, valid, {routingConfig: {}}),
    ]) {
      Assert.throws(
          () => Config.canonicalProductConfig(value),
          (error) => error && [
            Config.ERRORS.PRODUCT_CONFIG_MALFORMED,
            Config.ERRORS.PRODUCT_CONFIG_VERSION_UNSUPPORTED,
          ].includes(error.code),
      );
    }

  });

  it('rejects duplicate, unsafe, or excessive routing fields', function() {

    for (const value of [
      routingConfig({rules: {
        direct: ['same.example', 'same.example'], proxy: [], whitelist: [],
      }}),
      routingConfig({rules: {
        direct: ['https://unsafe.example'], proxy: [], whitelist: [],
      }}),
      routingConfig({providerCandidates: [candidate({host: 'UPPER.test'})]}),
      routingConfig({providerCandidates: [candidate({password: 'forbidden'})]}),
    ]) {
      Assert.throws(() => Config.canonicalRoutingConfig(value));
    }

    Assert.throws(() => Config.canonicalRoutingConfig(routingConfig({
      providerCandidates: Array.from(
          {length: Config.MAX_CANDIDATES + 1},
          (_, index) => candidate({id: `candidate-${index}`})),
    })), (error) => error.code === Config.ERRORS.ROUTING_CONFIG_TOO_LARGE);

  });

  it('rejects conflicting authRefs for one proxy endpoint', function() {

    Assert.throws(() => Config.canonicalRoutingConfig(routingConfig({
      providerCandidates: [
        candidate({id: 'first', authRef: 'first-auth'}),
        candidate({id: 'second', authRef: 'second-auth'}),
      ],
    })), (error) => error.code === Config.ERRORS.PRODUCT_CONFIG_MALFORMED);

  });

  it('verifies the persisted routing hash before recovery', async function() {

    const config = await productConfig();
    const modified = structuredClone(config);
    modified.routingConfig.flags.noDirect = true;

    await rejectsCode(
        () => Config.verifyProductConfig(modified, sha256),
        Config.ERRORS.PRODUCT_CONFIG_HASH_MISMATCH,
    );

  });

  it('keeps credentials in a separate descriptor-bound schema',
      async function() {

        const config = await productConfig({
          routingConfig: routingConfig({providerCandidates: [candidate({
            authRef: 'fixture-auth',
          })]}),
        });
        const credentials = Config.canonicalCredentialConfig(
            credentialConfig(config.routingDescriptor, [{
              authRef: 'fixture-auth',
              username: 'synthetic-user',
              password: 'synthetic-password',
            }]),
        );

        Assert.strictEqual(JSON.stringify(config).includes('password'), false);
        Assert.strictEqual(
            JSON.stringify(durableOn(config)).includes('password'),
            false,
        );
        Assert.strictEqual(credentials.entries[0].authRef, 'fixture-auth');

      });

  it('rejects malformed, future, duplicate, and oversized credentials',
      async function() {

        const descriptor = (await productConfig()).routingDescriptor;
        for (const value of [
          null,
          Object.assign(credentialConfig(descriptor), {schemaVersion: 2}),
          Object.assign(credentialConfig(descriptor), {extra: true}),
          credentialConfig(descriptor, [
            {authRef: 'same', username: 'one', password: 'one'},
            {authRef: 'same', username: 'two', password: 'two'},
          ]),
          credentialConfig(descriptor, [{
            authRef: 'long',
            username: 'x'.repeat(4097),
            password: '',
          }]),
        ]) {
          Assert.throws(
              () => Config.canonicalCredentialConfig(value),
              (error) => error && [
                Config.ERRORS.CREDENTIAL_CONFIG_MALFORMED,
                Config.ERRORS.CREDENTIAL_CONFIG_VERSION_UNSUPPORTED,
              ].includes(error.code),
          );
        }

      });

  it('recovers exact routing config and synchronous in-memory credentials',
      async function() {

        const config = await productConfig({
          routingConfig: routingConfig({providerCandidates: [candidate({
            authRef: 'fixture-auth',
          })]}),
        });
        const values = {
          [Config.CONFIG_STORAGE_KEY]: config,
          [Config.CREDENTIALS_STORAGE_KEY]: credentialConfig(
              config.routingDescriptor,
              [{
                authRef: 'fixture-auth',
                username: 'synthetic-user',
                password: 'synthetic-password',
              }],
          ),
        };
        const recovered = await recoveryFactory(values)(durableOn(config));

        Assert.deepStrictEqual(
            recovered.routingBaseInputForRequest({url: 'http://ignored.test'}),
            config.routingConfig,
        );
        Assert.deepStrictEqual(recovered.resolveCredentials('fixture-auth'), {
          username: 'synthetic-user',
          password: 'synthetic-password',
        });
        Assert.strictEqual(recovered.resolveCredentials('unknown'), null);
        Assert.strictEqual(
            Object.prototype.toString.call(recovered.resolveCredentials),
            '[object Function]',
        );

      });

  it('prepares the exact immutable production activation contract',
      async function() {

        const config = await productConfig({
          routingConfig: routingConfig({providerCandidates: [candidate({
            authRef: 'fixture-auth',
          })]}),
        });
        const values = {
          [Config.CONFIG_STORAGE_KEY]: structuredClone(config),
          [Config.CREDENTIALS_STORAGE_KEY]: credentialConfig(
              config.routingDescriptor,
              [{
                authRef: 'fixture-auth',
                username: 'synthetic-user',
                password: 'synthetic-password',
              }],
          ),
        };
        const prepared = await activationFactory(values)();

        Assert.deepStrictEqual(Object.keys(prepared).sort(), [
          'datasetIdentity',
          'datasetStore',
          'providerKey',
          'resolveCredentials',
          'routingBaseInputForRequest',
          'routingDescriptor',
        ]);
        Assert.deepStrictEqual(prepared.datasetIdentity, config.datasetIdentity);
        Assert.deepStrictEqual(
            prepared.routingBaseInputForRequest({url: 'http://ignored.test'}),
            config.routingConfig,
        );
        Assert.deepStrictEqual(prepared.resolveCredentials('fixture-auth'), {
          username: 'synthetic-user',
          password: 'synthetic-password',
        });
        Assert.strictEqual(Object.isFrozen(prepared), true);
        Assert.strictEqual(JSON.stringify(prepared).includes('password'), false);

      });

  it('binds one Apply attempt to one immutable storage snapshot',
      async function() {

        const config = await productConfig({
          routingConfig: routingConfig({providerCandidates: [candidate({
            authRef: 'fixture-auth',
          })]}),
        });
        const values = {
          [Config.CONFIG_STORAGE_KEY]: structuredClone(config),
          [Config.CREDENTIALS_STORAGE_KEY]: credentialConfig(
              config.routingDescriptor,
              [{
                authRef: 'fixture-auth',
                username: 'before',
                password: 'before-secret',
              }],
          ),
        };
        const prepared = await activationFactory(values)();
        values[Config.CONFIG_STORAGE_KEY].routingConfig.flags.noDirect = true;
        values[Config.CREDENTIALS_STORAGE_KEY].entries[0].username = 'after';
        values[Config.CREDENTIALS_STORAGE_KEY].entries[0].password =
          'after-secret';

        Assert.strictEqual(
            prepared.routingBaseInputForRequest({}).flags.noDirect,
            false,
        );
        Assert.deepStrictEqual(prepared.resolveCredentials('fixture-auth'), {
          username: 'before',
          password: 'before-secret',
        });

      });

  it('uses the same strict parser for activation and recovery failures',
      async function() {

        const valid = await productConfig();
        const cases = [
          [{}, Config.ERRORS.PRODUCT_CONFIG_MISSING],
          [{[Config.CONFIG_STORAGE_KEY]: Object.assign({}, valid, {
            schemaVersion: 2,
          })}, Config.ERRORS.PRODUCT_CONFIG_VERSION_UNSUPPORTED],
          [{[Config.CONFIG_STORAGE_KEY]: Object.assign({}, valid, {
            routingConfig: Object.assign({}, valid.routingConfig, {
              extra: true,
            }),
          })}, Config.ERRORS.PRODUCT_CONFIG_MALFORMED],
        ];
        for (const [values, code] of cases) {
          await rejectsCode(() => activationFactory(values)(), code);
          await rejectsCode(
              () => recoveryFactory(values)(durableOn(valid)),
              code,
          );
        }

      });

  it('recovers without credential storage when no candidate needs auth',
      async function() {

        const config = await productConfig();
        const recovered = await recoveryFactory({
          [Config.CONFIG_STORAGE_KEY]: config,
        })(durableOn(config));

        Assert.strictEqual(recovered.resolveCredentials('anything'), null);

      });

  it('rejects every exact durable binding mismatch', async function() {

    const config = await productConfig();
    const values = {[Config.CONFIG_STORAGE_KEY]: config};
    const state = durableOn(config);
    const cases = [
      [
        Object.assign({}, state, {providerKey: 'different-provider'}),
        Config.ERRORS.PRODUCT_CONFIG_PROVIDER_MISMATCH,
      ],
      [
        Object.assign({}, state, {datasetIdentity: Object.assign(
            {},
            state.datasetIdentity,
            {artifactSha256: 'f'.repeat(64)},
        )}),
        Config.ERRORS.PRODUCT_CONFIG_DATASET_MISMATCH,
      ],
      [
        Object.assign({}, state, {routingDescriptor: Object.assign(
            {},
            state.routingDescriptor,
            {configurationSha256: 'e'.repeat(64)},
        )}),
        Config.ERRORS.PRODUCT_CONFIG_DESCRIPTOR_MISMATCH,
      ],
    ];
    for (const [changed, code] of cases) {
      await rejectsCode(() => recoveryFactory(values)(changed), code);
    }

  });

  it('rejects missing or unreadable product storage', async function() {

    const state = durableOn(await productConfig());
    await rejectsCode(
        () => recoveryFactory({})(state),
        Config.ERRORS.PRODUCT_CONFIG_MISSING,
    );
    await rejectsCode(
        () => recoveryFactory({}, {
          storageError: new Error('synthetic storage failure'),
        })(state),
        Config.ERRORS.PRODUCT_CONFIG_STORAGE_UNAVAILABLE,
    );

  });

  it('requires all and only configured authRef credentials', async function() {

    const config = await productConfig({
      routingConfig: routingConfig({providerCandidates: [candidate({
        authRef: 'required-auth',
      })]}),
    });
    const state = durableOn(config);
    for (const entries of [
      [],
      [{authRef: 'extra-auth', username: 'unused', password: 'unused'}],
    ]) {
      await rejectsCode(() => recoveryFactory({
        [Config.CONFIG_STORAGE_KEY]: config,
        [Config.CREDENTIALS_STORAGE_KEY]: credentialConfig(
            config.routingDescriptor,
            entries,
        ),
      })(state), Config.ERRORS.REQUIRED_CREDENTIAL_MISSING);
    }

  });

  it('rejects credential descriptors from another routing configuration',
      async function() {

        const config = await productConfig({
          routingConfig: routingConfig({providerCandidates: [candidate({
            authRef: 'required-auth',
          })]}),
        });
        const descriptor = Object.assign({}, config.routingDescriptor, {
          configurationSha256: 'c'.repeat(64),
        });
        await rejectsCode(() => recoveryFactory({
          [Config.CONFIG_STORAGE_KEY]: config,
          [Config.CREDENTIALS_STORAGE_KEY]: credentialConfig(descriptor, [{
            authRef: 'required-auth',
            username: 'synthetic',
            password: 'synthetic',
          }]),
        })(durableOn(config)),
        Config.ERRORS.CREDENTIAL_CONFIG_DESCRIPTOR_MISMATCH);

      });

  it('rejects unavailable or malformed dataset-store construction',
      async function() {

        const config = await productConfig();
        for (const createDatasetStore of [
          () => null,
          () => ({}),
          () => {
            throw new Error('synthetic dataset store failure');
          },
        ]) {
          await rejectsCode(() => recoveryFactory({
            [Config.CONFIG_STORAGE_KEY]: config,
          }, {createDatasetStore})(durableOn(config)),
          Config.ERRORS.DATASET_STORE_UNAVAILABLE);
        }

      });

  it('contains no browser, network, executable-data, or logging dependency',
      function() {

        const source = require('node:fs').readFileSync(
            require.resolve('../background/product-config'),
            'utf8',
        );
        for (const forbidden of [
          'browser.',
          'chrome.',
          'fetch(',
          'XMLHttpRequest',
          'eval(',
          'Function(',
          'console.',
        ]) {
          Assert.strictEqual(source.includes(forbidden), false, forbidden);
        }

      });

});
