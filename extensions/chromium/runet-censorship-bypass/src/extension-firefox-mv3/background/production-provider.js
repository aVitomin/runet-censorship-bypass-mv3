'use strict';
/* global require */

(function publishFirefoxProductionProvider(root, factory) {

  const dataset = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/provider-dataset') :
    root.mv3ProviderDataset;
  const routing = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/routing-contract') :
    root.mv3RoutingContract;
  const productConfig = typeof module === 'object' && module.exports ?
    require('./product-config') : root.rucbFirefoxProductConfig;
  const api = factory(dataset, routing, productConfig);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxProductionProvider = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(Dataset, Routing, ProductConfig) {

      const PROVIDER_KEY = 'anticensority';
      const DATASET_VERSION = '2025.11.11-0448d748';
      const ARTIFACT_SHA256 =
        '4a779826cf70ad5a524f4483bb6aa7a5f5bca19626b32ad8b2597f1a403c0795';
      const ARTIFACT_BYTE_COUNT = 11642895;
      const RULE_COUNT = 662819;
      const ARTIFACT_PATH = 'provider/anticensority-hosts-v1.data';
      const ENVELOPE_PATH =
        'provider/anticensority-hosts-v1.envelope.json';
      const BOOTSTRAP_STORAGE_KEY = 'firefoxMv3ProductionProviderBootstrap';
      const BOOTSTRAP_SCHEMA_VERSION = 1;
      const CONFIGURATION_KEY = 'anticensority-default';
      const CONFIGURATION_VERSION = '2025.11.11-0448d748';
      const GENERIC_SOCKS_MAPPING = 'SOCKS4';
      const UPDATE_TRUST_CONFIGURATION = Object.freeze({
        enabled: false,
        manifestUrl: null,
        trustedPublicKeys: Object.freeze({}),
      });
      const BOOTSTRAP_FIELDS = Object.freeze([
        'artifactSha256',
        'providerKey',
        'schemaVersion',
      ]);

      function providerError(code) {

        const error = new TypeError(code);
        error.code = code;
        return error;

      }

      function candidate(id, type, port, proxyDNS) {

        return {
          id,
          type,
          host: 'localhost',
          port,
          proxyDNS,
          authRef: null,
          failoverTimeoutSeconds: null,
        };

      }

      function emptyCandidateGroup() {

        return {own: [], localTor: [], torBrowser: [], warp: []};

      }

      function createProductionRoutingConfig() {

        const localTor = candidate(
            'anticensority-local-tor',
            'SOCKS5',
            9050,
            true,
        );
        const torBrowser = candidate(
            'anticensority-tor-browser',
            'SOCKS5',
            9150,
            true,
        );
        return {
          candidateGroups: {
            configured: emptyCandidateGroup(),
            directReplacement: emptyCandidateGroup(),
            onion: {
              own: [],
              localTor: [localTor],
              torBrowser: [torBrowser],
              warp: [],
            },
          },
          flags: {
            noDirect: false,
            ownProxiesOnlyForOwnSites: true,
            replaceDirectWithProxy: false,
            useProviderProxies: true,
          },
          providerCandidates: [
            candidate('anticensority-https', 'HTTPS', 18611, false),
            candidate('anticensority-http', 'HTTP', 18613, false),
            candidate('anticensority-socks5', 'SOCKS5', 18615, true),
            candidate('anticensority-socks4', 'SOCKS4', 18617, false),
            candidate(
                'anticensority-generic-socks',
                GENERIC_SOCKS_MAPPING,
                18619,
                false,
            ),
            torBrowser,
            localTor,
          ],
          providerFallback: Routing.FALLBACKS.DIRECT,
          rules: {direct: [], proxy: [], whitelist: []},
        };

      }

      function datasetIdentity() {

        return Object.freeze({
          providerKey: PROVIDER_KEY,
          datasetVersion: DATASET_VERSION,
          artifactSha256: ARTIFACT_SHA256,
        });

      }

      async function createProductionProductConfig(sha256) {

        return ProductConfig.createProductConfig({
          configurationKey: CONFIGURATION_KEY,
          configurationVersion: CONFIGURATION_VERSION,
          datasetIdentity: datasetIdentity(),
          providerKey: PROVIDER_KEY,
          routingConfig: createProductionRoutingConfig(),
          sha256,
        });

      }

      function parseEnvelope(bytes) {

        if (!(bytes instanceof Uint8Array) || !bytes.byteLength ||
            bytes.byteLength > 64 * 1024) {
          throw providerError('PACKAGED_ENVELOPE_INVALID');
        }
        let value;
        try {
          const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
          value = JSON.parse(text);
        } catch (_error) {
          throw providerError('PACKAGED_ENVELOPE_INVALID');
        }
        if (!value || value.providerKey !== PROVIDER_KEY ||
            value.datasetVersion !== DATASET_VERSION ||
            value.artifactSha256 !== ARTIFACT_SHA256 ||
            value.artifactByteCount !== ARTIFACT_BYTE_COUNT ||
            value.ruleCount !== RULE_COUNT) {
          throw providerError('PACKAGED_ENVELOPE_IDENTITY_MISMATCH');
        }
        return value;

      }

      function validBootstrapMarker(value) {

        return Boolean(value) && typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.keys(value).length === BOOTSTRAP_FIELDS.length &&
          Object.keys(value).every((key) => BOOTSTRAP_FIELDS.includes(key)) &&
          value.schemaVersion === BOOTSTRAP_SCHEMA_VERSION &&
          value.providerKey === PROVIDER_KEY &&
          value.artifactSha256 === ARTIFACT_SHA256;

      }

      function createBootstrap(options = {}) {

        const storageArea = options.storageArea;
        const datasetStore = options.datasetStore;
        const sha256 = options.sha256;
        const readPackagedAsset = options.readPackagedAsset;
        if (!storageArea || typeof storageArea.get !== 'function' ||
            typeof storageArea.set !== 'function' || !datasetStore ||
            typeof datasetStore.commitPackagedBaseline !== 'function' ||
            typeof datasetStore.loadVerifications !== 'function' ||
            typeof sha256 !== 'function' ||
            typeof readPackagedAsset !== 'function') {
          throw providerError('INVALID_PROVIDER_BOOTSTRAP_DEPENDENCIES');
        }
        let initialization = null;

        async function initializeUnchecked() {

          const expectedConfig = await createProductionProductConfig(sha256);
          let stored;
          try {
            stored = await storageArea.get([
              BOOTSTRAP_STORAGE_KEY,
              ProductConfig.CONFIG_STORAGE_KEY,
            ]);
          } catch (_error) {
            throw providerError('PROVIDER_BOOTSTRAP_STORAGE_UNAVAILABLE');
          }
          if (validBootstrapMarker(stored[BOOTSTRAP_STORAGE_KEY])) {
            const verified = await datasetStore.loadVerifications(PROVIDER_KEY);
            const baseline = verified && verified.packagedBaseline;
            if (baseline && baseline.ok === true && baseline.dataset &&
                baseline.dataset.identity.artifactSha256 === ARTIFACT_SHA256 &&
                baseline.dataset.identity.datasetVersion === DATASET_VERSION &&
                baseline.trust === Dataset.TRUST.PACKAGED_TRUSTED) {
              return Object.freeze({
                ok: true,
                status: 'ALREADY_INSTALLED',
                datasetAvailable: true,
                productConfigAvailable: Object.prototype.hasOwnProperty.call(
                    stored,
                    ProductConfig.CONFIG_STORAGE_KEY,
                ),
              });
            }
          }
          const [artifactBytes, envelopeBytes] = await Promise.all([
            readPackagedAsset(ARTIFACT_PATH, ARTIFACT_BYTE_COUNT),
            readPackagedAsset(ENVELOPE_PATH, 64 * 1024),
          ]);
          const envelope = parseEnvelope(envelopeBytes);
          const committed = await datasetStore.commitPackagedBaseline({
            envelope,
            artifactBytes,
            trust: Dataset.TRUST.PACKAGED_TRUSTED,
          });
          if (!committed || committed.ok !== true ||
              committed.dataset.identity.artifactSha256 !== ARTIFACT_SHA256) {
            throw providerError(committed && committed.code ?
              committed.code : 'PACKAGED_BASELINE_INSTALL_FAILED');
          }
          const update = {
            [BOOTSTRAP_STORAGE_KEY]: {
              schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
              providerKey: PROVIDER_KEY,
              artifactSha256: ARTIFACT_SHA256,
            },
          };
          const hasProductConfig = Object.prototype.hasOwnProperty.call(
              stored,
              ProductConfig.CONFIG_STORAGE_KEY,
          );
          if (!hasProductConfig) {
            update[ProductConfig.CONFIG_STORAGE_KEY] = expectedConfig;
          }
          await storageArea.set(update);
          return Object.freeze({
            ok: true,
            status: hasProductConfig ?
              'BASELINE_INSTALLED_CONFIG_PRESERVED' : 'INSTALLED',
            datasetAvailable: true,
            productConfigAvailable: true,
          });

        }

        function initialize() {

          if (!initialization) {
            initialization = initializeUnchecked().catch((error) =>
              Object.freeze({
                ok: false,
                status: 'FAILED',
                code: error && error.code ?
                  error.code : 'PROVIDER_BOOTSTRAP_FAILED',
                datasetAvailable: false,
                productConfigAvailable: false,
              }));
          }
          return initialization;

        }

        return Object.freeze({initialize});

      }

      return Object.freeze({
        ARTIFACT_BYTE_COUNT,
        ARTIFACT_PATH,
        ARTIFACT_SHA256,
        BOOTSTRAP_STORAGE_KEY,
        CONFIGURATION_KEY,
        CONFIGURATION_VERSION,
        DATASET_VERSION,
        ENVELOPE_PATH,
        GENERIC_SOCKS_MAPPING,
        PROVIDER_KEY,
        RULE_COUNT,
        UPDATE_TRUST_CONFIGURATION,
        createBootstrap,
        createProductionProductConfig,
        createProductionRoutingConfig,
        datasetIdentity,
      });

    });
