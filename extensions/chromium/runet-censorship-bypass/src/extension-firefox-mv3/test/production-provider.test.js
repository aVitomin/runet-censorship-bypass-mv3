'use strict';

const Assert = require('node:assert');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');
const Dataset = require('../../extension-mv3-common/provider-dataset');
const Routing = require('../../extension-mv3-common/routing-contract');
const DatasetStore = require('../background/dataset-store');
const ProductConfig = require('../background/product-config');
const ProviderLookup = require('../background/provider-lookup');
const Production = require('../background/production-provider');
const RoutingAdapter = require('../background/routing-adapter');
const Helpers = require('./dataset-test-helpers');

const sourceRoot = Path.resolve(__dirname, '..');
const artifactBytes = Fs.readFileSync(Path.join(
    sourceRoot,
    Production.ARTIFACT_PATH,
));
const envelopeBytes = Fs.readFileSync(Path.join(
    sourceRoot,
    Production.ENVELOPE_PATH,
));
const envelope = JSON.parse(envelopeBytes);

function sha256(bytes) {

  return Promise.resolve(
      Crypto.createHash('sha256').update(bytes).digest('hex'),
  );

}

function memoryStorage(values = {}) {

  const writes = [];
  return {
    values,
    writes,
    async get(keys) {

      return keys.reduce((result, key) => {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          result[key] = structuredClone(values[key]);
        }
        return result;
      }, {});

    },
    async set(update) {

      writes.push(structuredClone(update));
      Object.assign(values, structuredClone(update));

    },
  };

}

function readPackagedAsset(relativePath, maximumBytes) {

  const bytes = Fs.readFileSync(Path.join(sourceRoot, relativePath));
  Assert.ok(bytes.byteLength <= maximumBytes);
  return Promise.resolve(new Uint8Array(bytes));

}

describe('Firefox production provider baseline', function() {

  it('verifies the exact packaged 662819-rule artifact', async function() {

    const verification = await Dataset.verifyProviderDataset({
      envelope,
      artifactBytes,
      sha256,
      trust: Dataset.TRUST.PACKAGED_TRUSTED,
    });

    Assert.strictEqual(verification.ok, true);
    Assert.strictEqual(envelope.ruleCount, Production.RULE_COUNT);
    Assert.strictEqual(artifactBytes.byteLength, Production.ARTIFACT_BYTE_COUNT);
    Assert.strictEqual(envelope.artifactSha256, Production.ARTIFACT_SHA256);
    Assert.strictEqual(verification.dataset.payload.buckets.length, 80);

  });

  it('matches a representative real-domain corpus with suffix semantics',
      async function() {

        const verification = await Dataset.verifyProviderDataset({
          envelope,
          artifactBytes,
          sha256,
          trust: Dataset.TRUST.PACKAGED_TRUSTED,
        });
        const lookup = ProviderLookup.buildLookup(verification);
        for (const hostname of [
          'rutracker.org',
          'subdomain.rutracker.org',
          'linkedin.com',
          'facebook.com',
          'x.com',
          'nnmclub.to',
          'meduza.io',
        ]) {
          Assert.strictEqual(
              lookup.lookup(hostname).kind,
              ProviderLookup.KINDS.PROVIDER_PROXY,
              hostname,
          );
        }
        Assert.strictEqual(
            lookup.lookup('example.com').kind,
            ProviderLookup.KINDS.MISS,
        );

      });

  it('maps the audited Anticensority proxy chain exactly', function() {

    const config = Production.createProductionRoutingConfig();
    Assert.deepStrictEqual(
        config.providerCandidates.map((item) =>
          `${item.type} ${item.host}:${item.port}`),
        [
          'HTTPS localhost:18611',
          'HTTP localhost:18613',
          'SOCKS5 localhost:18615',
          'SOCKS4 localhost:18617',
          'SOCKS4 localhost:18619',
          'SOCKS5 localhost:9150',
          'SOCKS5 localhost:9050',
        ],
    );
    Assert.strictEqual(Production.GENERIC_SOCKS_MAPPING, 'SOCKS4');
    Assert.strictEqual(config.providerFallback, Routing.FALLBACKS.DIRECT);

  });

  it('preserves safe defaults and product Tor ordering', function() {

    const config = Production.createProductionRoutingConfig();
    Assert.deepStrictEqual(config.flags, {
      noDirect: false,
      ownProxiesOnlyForOwnSites: true,
      replaceDirectWithProxy: false,
      useProviderProxies: true,
    });
    const onion = Routing.decideRoute(Object.assign({}, config, {
      hostname: 'service.onion',
      provider: {kind: Routing.KINDS.DIRECT},
    }));
    Assert.strictEqual(onion.kind, Routing.KINDS.PROXY);
    Assert.deepStrictEqual(
        onion.candidates.map((item) => item.port),
        [9050, 9150],
    );
    Assert.strictEqual(onion.fallback, Routing.FALLBACKS.FAIL_CLOSED);

  });

  it('keeps provider miss Direct and provider match proxy-plus-Direct',
      function() {

        const config = Production.createProductionRoutingConfig();
        const miss = Routing.decideRoute(Object.assign({}, config, {
          hostname: 'example.com',
          provider: {kind: Routing.KINDS.DIRECT},
        }));
        const match = Routing.decideRoute(Object.assign({}, config, {
          hostname: 'rutracker.org',
          provider: {
            kind: Routing.KINDS.PROXY,
            candidates: config.providerCandidates,
            fallback: config.providerFallback,
          },
        }));
        Assert.strictEqual(miss.kind, Routing.KINDS.DIRECT);
        Assert.strictEqual(match.kind, Routing.KINDS.PROXY);
        Assert.strictEqual(match.candidates.length, 7);
        Assert.strictEqual(match.fallback, Routing.FALLBACKS.DIRECT);
        Assert.deepStrictEqual(RoutingAdapter.convertDecision(miss), {
          proxyResult: null,
          callbackBudget: 1,
        });
        const firefoxMatch = RoutingAdapter.convertDecision(match);
        Assert.strictEqual(firefoxMatch.callbackBudget, 7);
        Assert.strictEqual(firefoxMatch.proxyResult.length, 8);
        Assert.strictEqual(firefoxMatch.proxyResult.at(-1), null);
        Assert.strictEqual(
            firefoxMatch.degradationCode,
            'PROXY_DIRECT_FALLBACK_STRIPPED',
        );

      });

  it('installs the verified baseline and default config once', async function() {

    const backend = Helpers.memoryBackend();
    const store = DatasetStore.createStore({backend, sha256});
    const storage = memoryStorage();
    let reads = 0;
    const create = () => Production.createBootstrap({
      storageArea: storage,
      datasetStore: store,
      sha256,
      readPackagedAsset(relativePath, maximumBytes) {

        reads += 1;
        return readPackagedAsset(relativePath, maximumBytes);

      },
    });
    const first = await create().initialize();
    Assert.strictEqual(first.status, 'INSTALLED');
    Assert.strictEqual(first.datasetAvailable, true);
    Assert.strictEqual(reads, 2);
    const config = await ProductConfig.verifyProductConfig(
        storage.values[ProductConfig.CONFIG_STORAGE_KEY],
        sha256,
    );
    Assert.strictEqual(config.config.providerKey, Production.PROVIDER_KEY);
    const loaded = await store.loadVerifications(Production.PROVIDER_KEY);
    Assert.strictEqual(loaded.packagedBaseline.ok, true);

    const second = await create().initialize();
    Assert.strictEqual(second.status, 'ALREADY_INSTALLED');
    Assert.strictEqual(reads, 2);

  });

  it('never overwrites an existing product configuration', async function() {

    const backend = Helpers.memoryBackend();
    const store = DatasetStore.createStore({backend, sha256});
    const existing = {intentionally: 'preserved'};
    const storage = memoryStorage({
      [ProductConfig.CONFIG_STORAGE_KEY]: existing,
    });
    const result = await Production.createBootstrap({
      storageArea: storage,
      datasetStore: store,
      sha256,
      readPackagedAsset,
    }).initialize();
    Assert.strictEqual(result.status, 'BASELINE_INSTALLED_CONFIG_PRESERVED');
    Assert.deepStrictEqual(
        storage.values[ProductConfig.CONFIG_STORAGE_KEY],
        existing,
    );

  });

  it('repairs a missing stored baseline instead of trusting its marker',
      async function() {

        const firstBackend = Helpers.memoryBackend();
        const storage = memoryStorage();
        await Production.createBootstrap({
          storageArea: storage,
          datasetStore: DatasetStore.createStore({
            backend: firstBackend,
            sha256,
          }),
          sha256,
          readPackagedAsset,
        }).initialize();
        let reads = 0;
        const emptyStore = DatasetStore.createStore({
          backend: Helpers.memoryBackend(),
          sha256,
        });
        const repaired = await Production.createBootstrap({
          storageArea: storage,
          datasetStore: emptyStore,
          sha256,
          readPackagedAsset(relativePath, maximumBytes) {

            reads += 1;
            return readPackagedAsset(relativePath, maximumBytes);

          },
        }).initialize();
        Assert.strictEqual(repaired.ok, true);
        Assert.strictEqual(repaired.status,
            'BASELINE_INSTALLED_CONFIG_PRESERVED');
        Assert.strictEqual(reads, 2);
        const stored = await emptyStore.loadVerifications(
            Production.PROVIDER_KEY,
        );
        Assert.strictEqual(stored.packagedBaseline.ok, true);

      });

  it('rejects changed packaged bytes without persisting readiness',
      async function() {

        const backend = Helpers.memoryBackend();
        const store = DatasetStore.createStore({backend, sha256});
        const storage = memoryStorage();
        const result = await Production.createBootstrap({
          storageArea: storage,
          datasetStore: store,
          sha256,
          readPackagedAsset(relativePath, maximumBytes) {

            if (relativePath === Production.ARTIFACT_PATH) {
              const changed = new Uint8Array(artifactBytes);
              changed[0] ^= 1;
              return Promise.resolve(changed);
            }
            return readPackagedAsset(relativePath, maximumBytes);

          },
        }).initialize();
        Assert.strictEqual(result.ok, false);
        Assert.strictEqual(result.code, 'ARTIFACT_SHA256_MISMATCH');
        Assert.strictEqual(
            Production.BOOTSTRAP_STORAGE_KEY in storage.values,
            false,
        );

      });

  it('ships no enabled remote update trust configuration', function() {

    Assert.deepStrictEqual(Production.UPDATE_TRUST_CONFIGURATION, {
      enabled: false,
      manifestUrl: null,
      trustedPublicKeys: {},
    });

  });

});
