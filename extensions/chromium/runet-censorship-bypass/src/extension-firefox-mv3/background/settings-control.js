'use strict';
/* global require */

(function publishFirefoxSettingsControl(root, factory) {

  const productConfig = typeof module === 'object' && module.exports ?
    require('./product-config') : root.rucbFirefoxProductConfig;
  const productionProvider = typeof module === 'object' && module.exports ?
    require('./production-provider') : root.rucbFirefoxProductionProvider;
  const routing = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/routing-contract') :
    root.mv3RoutingContract;
  const api = factory(productConfig, productionProvider, routing);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxSettingsControl = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(ProductConfig, ProductionProvider, Routing) {

      const SCHEMA_VERSION = 1;
      const COMMIT_SCHEMA_VERSION = 1;
      const MUTATION_SCHEMA_VERSION = 1;
      const MAX_PUBLIC_PROXIES = 128;
      const MAX_IDENTIFIER_LENGTH = 96;
      const SETTINGS_KEYS = Object.freeze([
        'flags',
        'localTor',
        'ownProxies',
        'rules',
        'schemaVersion',
        'torBrowser',
        'warp',
      ]);
      const RULE_KEYS = Object.freeze(['direct', 'proxy', 'whitelist']);
      const FLAG_KEYS = Object.freeze([
        'noDirect',
        'ownProxiesOnlyForOwnSites',
        'replaceDirectWithProxy',
        'useProviderProxies',
      ]);
      const OWN_PROXY_KEYS = Object.freeze([
        'credentials',
        'enabled',
        'failoverTimeoutSeconds',
        'host',
        'id',
        'port',
        'proxyDNS',
        'type',
        'useAsDirectReplacement',
      ]);
      const SCOPED_PROXY_KEYS = Object.freeze([
        'failoverTimeoutSeconds',
        'host',
        'port',
        'proxyDNS',
        'type',
        'useAsDirectReplacement',
        'useForOnion',
        'useForProxyRules',
      ]);
      const WARP_KEYS = Object.freeze([
        'candidates',
        'useAsDirectReplacement',
        'useForProxyRules',
      ]);
      const WARP_CANDIDATE_KEYS = Object.freeze([
        'failoverTimeoutSeconds',
        'host',
        'id',
        'port',
        'proxyDNS',
        'type',
      ]);
      const COMMIT_KEYS = Object.freeze([
        'revision',
        'routingDescriptor',
        'schemaVersion',
        'settings',
      ]);
      const MUTATION_KEYS = Object.freeze([
        'schemaVersion',
        'status',
      ]);
      const ID_PATTERN = /^[A-Za-z0-9._:-]{1,96}$/;
      const ERRORS = Object.freeze({
        INVALID_SETTINGS_DEPENDENCIES: 'INVALID_SETTINGS_DEPENDENCIES',
        SETTINGS_CREDENTIAL_AMBIGUOUS: 'SETTINGS_CREDENTIAL_AMBIGUOUS',
        SETTINGS_CREDENTIAL_STALE: 'SETTINGS_CREDENTIAL_STALE',
        SETTINGS_DATASET_BINDING_FAILED: 'SETTINGS_DATASET_BINDING_FAILED',
        SETTINGS_MALFORMED: 'SETTINGS_MALFORMED',
        SETTINGS_MUTATION_REQUIRES_OFF: 'SETTINGS_MUTATION_REQUIRES_OFF',
        SETTINGS_REVISION_CONFLICT: 'SETTINGS_REVISION_CONFLICT',
        SETTINGS_STATE_UNAVAILABLE: 'SETTINGS_STATE_UNAVAILABLE',
        SETTINGS_STORAGE_FAILED: 'SETTINGS_STORAGE_FAILED',
        SETTINGS_TRANSACTION_INCOMPLETE: 'SETTINGS_TRANSACTION_INCOMPLETE',
        SETTINGS_VERSION_UNSUPPORTED: 'SETTINGS_VERSION_UNSUPPORTED',
      });

      function settingsError(code) {

        const error = new TypeError(code);
        error.code = code;
        return error;

      }

      function hasExactKeys(value, expected) {

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false;
        }
        const actual = Object.keys(value).sort();
        const wanted = [...expected].sort();
        return actual.length === wanted.length &&
          actual.every((key, index) => key === wanted[index]);

      }

      function clone(value) {

        return JSON.parse(JSON.stringify(value));

      }

      function sameDescriptor(left, right) {

        return Boolean(left && right &&
          left.schemaVersion === right.schemaVersion &&
          left.configurationKey === right.configurationKey &&
          left.configurationVersion === right.configurationVersion &&
          left.configurationSha256 === right.configurationSha256);

      }

      function canonicalPattern(value, storedOnly) {

        if (typeof value !== 'string') {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        let pattern = value.trim().toLowerCase();
        while (pattern.endsWith('.')) {
          pattern = pattern.slice(0, -1);
        }
        if (!pattern || (storedOnly && pattern !== value)) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return pattern;

      }

      function canonicalRules(value, storedOnly) {

        if (!hasExactKeys(value, RULE_KEYS)) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        const result = {};
        for (const key of RULE_KEYS) {
          if (!Array.isArray(value[key])) {
            throw settingsError(ERRORS.SETTINGS_MALFORMED);
          }
          result[key] = value[key].map((pattern) =>
            canonicalPattern(pattern, storedOnly));
        }
        return result;

      }

      function canonicalFlags(value) {

        if (!hasExactKeys(value, FLAG_KEYS) ||
            FLAG_KEYS.some((key) => typeof value[key] !== 'boolean')) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return {
          noDirect: value.noDirect,
          ownProxiesOnlyForOwnSites: value.ownProxiesOnlyForOwnSites,
          replaceDirectWithProxy: value.replaceDirectWithProxy,
          useProviderProxies: value.useProviderProxies,
        };

      }

      function canonicalProxyFields(value, keys, storedOnly) {

        if (!hasExactKeys(value, keys) || typeof value.host !== 'string' ||
            typeof value.type !== 'string' ||
            !Routing.CANDIDATE_TYPES.includes(value.type) ||
            !Number.isSafeInteger(value.port) || value.port < 1 ||
            value.port > 65535 || typeof value.proxyDNS !== 'boolean' ||
            (value.failoverTimeoutSeconds !== null &&
              (!Number.isSafeInteger(value.failoverTimeoutSeconds) ||
               value.failoverTimeoutSeconds < 1))) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        const host = value.host.trim().toLowerCase();
        if (!host || (storedOnly && host !== value.host)) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return {
          type: value.type,
          host,
          port: value.port,
          proxyDNS: value.proxyDNS,
          failoverTimeoutSeconds: value.failoverTimeoutSeconds,
        };

      }

      function canonicalCredentials(value, storedOnly) {

        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            typeof value.mode !== 'string') {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        if (value.mode === 'NONE' && hasExactKeys(value, ['mode'])) {
          return {mode: 'NONE'};
        }
        if (value.mode === 'KEEP' &&
            hasExactKeys(value, ['mode', 'username']) &&
            typeof value.username === 'string') {
          return {mode: 'KEEP', username: value.username};
        }
        if (!storedOnly && value.mode === 'SET' &&
            hasExactKeys(value, ['mode', 'password', 'username']) &&
            typeof value.username === 'string' &&
            typeof value.password === 'string') {
          return {
            mode: 'SET',
            username: value.username,
            password: value.password,
          };
        }
        throw settingsError(ERRORS.SETTINGS_MALFORMED);

      }

      function canonicalOwnProxy(value, storedOnly) {

        const fields = canonicalProxyFields(value, OWN_PROXY_KEYS, storedOnly);
        if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id) ||
            typeof value.enabled !== 'boolean' ||
            typeof value.useAsDirectReplacement !== 'boolean') {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return Object.assign({
          id: value.id,
          enabled: value.enabled,
        }, fields, {
          useAsDirectReplacement: value.useAsDirectReplacement,
          credentials: canonicalCredentials(value.credentials, storedOnly),
        });

      }

      function canonicalScopedProxy(value, storedOnly) {

        const fields = canonicalProxyFields(value, SCOPED_PROXY_KEYS, storedOnly);
        for (const key of [
          'useAsDirectReplacement',
          'useForOnion',
          'useForProxyRules',
        ]) {
          if (typeof value[key] !== 'boolean') {
            throw settingsError(ERRORS.SETTINGS_MALFORMED);
          }
        }
        return Object.assign(fields, {
          useAsDirectReplacement: value.useAsDirectReplacement,
          useForOnion: value.useForOnion,
          useForProxyRules: value.useForProxyRules,
        });

      }

      function canonicalWarp(value, storedOnly) {

        if (!hasExactKeys(value, WARP_KEYS) ||
            !Array.isArray(value.candidates) ||
            typeof value.useAsDirectReplacement !== 'boolean' ||
            typeof value.useForProxyRules !== 'boolean') {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return {
          candidates: value.candidates.map((candidate) => {
            const fields = canonicalProxyFields(
                candidate,
                WARP_CANDIDATE_KEYS,
                storedOnly,
            );
            if (typeof candidate.id !== 'string' ||
                !ID_PATTERN.test(candidate.id)) {
              throw settingsError(ERRORS.SETTINGS_MALFORMED);
            }
            return Object.assign({id: candidate.id}, fields);
          }),
          useAsDirectReplacement: value.useAsDirectReplacement,
          useForProxyRules: value.useForProxyRules,
        };

      }

      function canonicalSettings(value, storedOnly = false) {

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        if (value.schemaVersion !== SCHEMA_VERSION) {
          throw settingsError(Number.isSafeInteger(value.schemaVersion) ?
            ERRORS.SETTINGS_VERSION_UNSUPPORTED : ERRORS.SETTINGS_MALFORMED);
        }
        if (!hasExactKeys(value, SETTINGS_KEYS) ||
            !Array.isArray(value.ownProxies) ||
            value.ownProxies.length > MAX_PUBLIC_PROXIES) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        const ownProxies = value.ownProxies.map((proxy) =>
          canonicalOwnProxy(proxy, storedOnly));
        const localTor = canonicalScopedProxy(value.localTor, storedOnly);
        const torBrowser = canonicalScopedProxy(value.torBrowser, storedOnly);
        const warp = canonicalWarp(value.warp, storedOnly);
        if (ownProxies.length + warp.candidates.length > MAX_PUBLIC_PROXIES) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        const identifiers = ownProxies.map((proxy) => proxy.id)
            .concat(warp.candidates.map((candidate) => candidate.id));
        if (new Set(identifiers).size !== identifiers.length) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return Object.freeze({
          schemaVersion: SCHEMA_VERSION,
          rules: canonicalRules(value.rules, storedOnly),
          ownProxies,
          localTor,
          torBrowser,
          warp,
          flags: canonicalFlags(value.flags),
        });

      }

      function publicCandidate(id, value, authRef = null) {

        return {
          id,
          type: value.type,
          host: value.host,
          port: value.port,
          proxyDNS: value.proxyDNS,
          authRef,
          failoverTimeoutSeconds: value.failoverTimeoutSeconds,
        };

      }

      function emptyGroup() {

        return {own: [], localTor: [], torBrowser: [], warp: []};

      }

      function endpointKey(candidate) {

        return `${candidate.type}\n${candidate.host.toLowerCase()}\n${candidate.port}`;

      }

      function buildRoutingSnapshot(settings, current = null) {

        const base = ProductionProvider.createProductionRoutingConfig();
        const configured = emptyGroup();
        const directReplacement = emptyGroup();
        const onion = emptyGroup();
        const credentialEntries = [];
        const sanitizedOwn = [];
        const currentById = new Map();
        if (current) {
          current.settings.ownProxies.forEach((proxy) =>
            currentById.set(proxy.id, proxy));
        }
        const currentCredentials = current ? current.credentials : new Map();
        const definitions = [];

        for (const proxy of settings.ownProxies) {
          if (!proxy.enabled && proxy.credentials.mode !== 'NONE') {
            throw settingsError(ERRORS.SETTINGS_CREDENTIAL_AMBIGUOUS);
          }
          let authRef = null;
          let storedCredentials = {mode: 'NONE'};
          if (proxy.credentials.mode !== 'NONE') {
            authRef = `own.${proxy.id}`;
            const username = proxy.credentials.username;
            let password;
            if (proxy.credentials.mode === 'SET') {
              password = proxy.credentials.password;
            } else {
              const previous = currentById.get(proxy.id);
              const previousCredentials = currentCredentials.get(authRef);
              if (!previous || !previousCredentials ||
                  previous.type !== proxy.type ||
                  previous.host !== proxy.host ||
                  previous.port !== proxy.port ||
                  previous.credentials.mode !== 'KEEP' ||
                  previous.credentials.username !== username ||
                  previousCredentials.username !== username) {
                throw settingsError(ERRORS.SETTINGS_CREDENTIAL_STALE);
              }
              password = previousCredentials.password;
            }
            credentialEntries.push({authRef, username, password});
            storedCredentials = {mode: 'KEEP', username};
          }
          const candidate = publicCandidate(proxy.id, proxy, authRef);
          definitions.push(candidate);
          if (proxy.enabled) {
            configured.own.push(candidate);
          }
          if (proxy.enabled && proxy.useAsDirectReplacement) {
            directReplacement.own.push(candidate);
          }
          sanitizedOwn.push(Object.assign({}, proxy, {
            credentials: storedCredentials,
          }));
        }

        const scoped = [
          ['localTor', 'anticensority-local-tor', settings.localTor],
          ['torBrowser', 'anticensority-tor-browser', settings.torBrowser],
        ];
        for (const [groupName, id, value] of scoped) {
          const candidate = publicCandidate(id, value);
          definitions.push(candidate);
          if (value.useForProxyRules) {
            configured[groupName].push(candidate);
          }
          if (value.useAsDirectReplacement) {
            directReplacement[groupName].push(candidate);
          }
          if (value.useForOnion) {
            onion[groupName].push(candidate);
          }
        }
        for (const value of settings.warp.candidates) {
          const candidate = publicCandidate(value.id, value);
          definitions.push(candidate);
          if (settings.warp.useForProxyRules) {
            configured.warp.push(candidate);
          }
          if (settings.warp.useAsDirectReplacement) {
            directReplacement.warp.push(candidate);
          }
        }
        const allDefinitions = definitions.concat(base.providerCandidates);
        const endpoints = new Map();
        for (const candidate of allDefinitions) {
          const endpoint = endpointKey(candidate);
          if (endpoints.has(endpoint)) {
            const previous = endpoints.get(endpoint);
            const duplicatesAllowed = candidate.authRef === null &&
              previous.authRef === null && previous.id === candidate.id &&
              ['anticensority-local-tor', 'anticensority-tor-browser']
                  .includes(candidate.id);
            if (!duplicatesAllowed) {
              throw settingsError(ERRORS.SETTINGS_CREDENTIAL_AMBIGUOUS);
            }
          }
          endpoints.set(endpoint, candidate);
        }
        const sanitizedSettings = Object.assign({}, settings, {
          ownProxies: sanitizedOwn,
        });
        const routingConfig = {
          candidateGroups: {configured, directReplacement, onion},
          flags: settings.flags,
          providerCandidates: base.providerCandidates,
          providerFallback: base.providerFallback,
          rules: settings.rules,
        };
        let canonicalRoutingConfig;
        try {
          canonicalRoutingConfig = ProductConfig.canonicalRoutingConfig(
              routingConfig,
          ).value;
        } catch (_error) {
          throw settingsError(ERRORS.SETTINGS_MALFORMED);
        }
        return Object.freeze({
          credentials: credentialEntries,
          routingConfig: canonicalRoutingConfig,
          settings: canonicalSettings(sanitizedSettings, true),
        });

      }

      function createDefaultSettings() {

        return clone(canonicalSettings({
          schemaVersion: SCHEMA_VERSION,
          rules: {direct: [], proxy: [], whitelist: []},
          ownProxies: [],
          localTor: {
            type: 'SOCKS5',
            host: 'localhost',
            port: 9050,
            proxyDNS: true,
            failoverTimeoutSeconds: null,
            useForProxyRules: false,
            useForOnion: true,
            useAsDirectReplacement: false,
          },
          torBrowser: {
            type: 'SOCKS5',
            host: 'localhost',
            port: 9150,
            proxyDNS: true,
            failoverTimeoutSeconds: null,
            useForProxyRules: false,
            useForOnion: true,
            useAsDirectReplacement: false,
          },
          warp: {
            candidates: [
              {
                id: 'firefox-warp-socks5',
                type: 'SOCKS5',
                host: '127.0.0.1',
                port: 40000,
                proxyDNS: true,
                failoverTimeoutSeconds: null,
              },
              {
                id: 'firefox-warp-https',
                type: 'HTTPS',
                host: '127.0.0.1',
                port: 40000,
                proxyDNS: false,
                failoverTimeoutSeconds: null,
              },
            ],
            useForProxyRules: false,
            useAsDirectReplacement: false,
          },
          flags: {
            useProviderProxies: true,
            ownProxiesOnlyForOwnSites: true,
            replaceDirectWithProxy: false,
            noDirect: false,
          },
        }, true));

      }

      function canonicalCommit(value) {

        if (!hasExactKeys(value, COMMIT_KEYS) ||
            value.schemaVersion !== COMMIT_SCHEMA_VERSION ||
            !Number.isSafeInteger(value.revision) || value.revision < 1) {
          throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
        }
        const settings = canonicalSettings(value.settings, true);
        return Object.freeze({
          schemaVersion: COMMIT_SCHEMA_VERSION,
          revision: value.revision,
          routingDescriptor: value.routingDescriptor,
          settings,
        });

      }

      function validMutation(value) {

        return hasExactKeys(value, MUTATION_KEYS) &&
          value.schemaVersion === MUTATION_SCHEMA_VERSION &&
          value.status === 'WRITING';

      }

      function createController(options = {}) {

        const storageArea = options.storageArea;
        const sha256 = options.sha256;
        const activationSnapshot = options.activationSnapshot;
        const datasetIdentityAvailable = options.datasetIdentityAvailable;
        if (!storageArea || typeof storageArea.get !== 'function' ||
            typeof storageArea.set !== 'function' ||
            typeof storageArea.remove !== 'function' ||
            typeof sha256 !== 'function' ||
            typeof activationSnapshot !== 'function' ||
            typeof datasetIdentityAvailable !== 'function') {
          throw settingsError(ERRORS.INVALID_SETTINGS_DEPENDENCIES);
        }
        let queue = Promise.resolve();

        function enqueue(operation) {

          const result = queue.then(operation, operation);
          queue = result.catch(() => undefined);
          return result;

        }

        async function readStored() {

          try {
            return await storageArea.get([
              ProductConfig.CONFIG_STORAGE_KEY,
              ProductConfig.CREDENTIALS_STORAGE_KEY,
              ProductConfig.SETTINGS_COMMIT_STORAGE_KEY,
              ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY,
              ProductConfig.DATASET_PROMOTION_STORAGE_KEY,
            ]);
          } catch (_error) {
            throw settingsError(ERRORS.SETTINGS_STORAGE_FAILED);
          }

        }

        function credentialsMap(value, descriptor) {

          if (value === undefined) {
            return new Map();
          }
          let canonical;
          try {
            canonical = ProductConfig.canonicalCredentialConfig(value);
          } catch (_error) {
            throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
          }
          if (!sameDescriptor(canonical.routingDescriptor, descriptor)) {
            throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
          }
          return new Map(canonical.entries.map((entry) => [entry.authRef, entry]));

        }

        async function currentSnapshot(options = {}) {

          const stored = await readStored();
          const mutation = stored[ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY];
          const promotion = stored[ProductConfig.DATASET_PROMOTION_STORAGE_KEY];
          const rawCommit = stored[ProductConfig.SETTINGS_COMMIT_STORAGE_KEY];
          if (mutation !== undefined || promotion !== undefined) {
            if (promotion !== undefined) {
              throw settingsError(ERRORS.SETTINGS_TRANSACTION_INCOMPLETE);
            }
            if (!validMutation(mutation) || rawCommit === undefined) {
              if (!options.allowIncomplete) {
                throw settingsError(ERRORS.SETTINGS_TRANSACTION_INCOMPLETE);
              }
              return {incomplete: true, stored};
            }
          }
          const rawConfig = stored[ProductConfig.CONFIG_STORAGE_KEY];
          if (rawConfig === undefined) {
            throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
          }
          let verified;
          try {
            verified = await ProductConfig.verifyProductConfig(rawConfig, sha256);
          } catch (_error) {
            throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
          }
          const config = verified.config;
          if (config.providerKey !== ProductionProvider.PROVIDER_KEY ||
              config.datasetIdentity.providerKey !==
                ProductionProvider.PROVIDER_KEY) {
            throw settingsError(ERRORS.SETTINGS_DATASET_BINDING_FAILED);
          }
          let datasetAvailable;
          try {
            datasetAvailable = await datasetIdentityAvailable(
                config.datasetIdentity,
            );
          } catch (_error) {
            datasetAvailable = false;
          }
          if (datasetAvailable !== true) {
            throw settingsError(ERRORS.SETTINGS_DATASET_BINDING_FAILED);
          }
          const credentials = credentialsMap(
              stored[ProductConfig.CREDENTIALS_STORAGE_KEY],
              config.routingDescriptor,
          );
          let commit;
          if (rawCommit === undefined) {
            const expected = await ProductionProvider.createProductionProductConfig(
                sha256,
            );
            if (!sameDescriptor(config.routingDescriptor,
                expected.routingDescriptor)) {
              throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
            }
            commit = {
              schemaVersion: COMMIT_SCHEMA_VERSION,
              revision: 0,
              routingDescriptor: config.routingDescriptor,
              settings: createDefaultSettings(),
            };
            if (credentials.size !== 0) {
              throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
            }
          } else {
            commit = canonicalCommit(rawCommit);
            if (!sameDescriptor(commit.routingDescriptor,
                config.routingDescriptor)) {
              throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
            }
            const rebuilt = buildRoutingSnapshot(commit.settings, {
              settings: commit.settings,
              credentials,
            });
            const expected = await ProductConfig.createProductConfig({
              configurationKey: ProductionProvider.CONFIGURATION_KEY,
              configurationVersion: `settings-${commit.revision}`,
              datasetIdentity: config.datasetIdentity,
              providerKey: ProductionProvider.PROVIDER_KEY,
              routingConfig: rebuilt.routingConfig,
              sha256,
            });
            if (!sameDescriptor(expected.routingDescriptor,
                config.routingDescriptor)) {
              throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
            }
            if (rebuilt.credentials.length !== credentials.size ||
                rebuilt.credentials.some((entry) =>
                  !credentials.has(entry.authRef))) {
              throw settingsError(ERRORS.SETTINGS_STATE_UNAVAILABLE);
            }
          }
          if (mutation !== undefined) {
            try {
              await storageArea.remove(
                  ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY,
              );
            } catch (_error) {
              throw settingsError(ERRORS.SETTINGS_TRANSACTION_INCOMPLETE);
            }
          }
          return {commit, config, credentials, stored};

        }

        async function getUnchecked() {

          const current = await currentSnapshot();
          return Object.freeze({
            revision: current.commit.revision,
            settings: clone(current.commit.settings),
          });

        }

        async function replaceUnchecked(expectedRevision, proposed) {

          const activation = activationSnapshot();
          if (!activation || activation.durableIntent !== 'OFF' ||
              activation.runtimeState !== 'OFF' || activation.active === true) {
            throw settingsError(ERRORS.SETTINGS_MUTATION_REQUIRES_OFF);
          }
          const settings = canonicalSettings(proposed, false);
          const current = await currentSnapshot();
          if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
              current.commit.revision !== expectedRevision) {
            throw settingsError(ERRORS.SETTINGS_REVISION_CONFLICT);
          }
          const nextRevision = expectedRevision + 1;
          const built = buildRoutingSnapshot(settings, {
            settings: current.commit.settings,
            credentials: current.credentials,
          });
          const config = await ProductConfig.createProductConfig({
            configurationKey: ProductionProvider.CONFIGURATION_KEY,
            configurationVersion: `settings-${nextRevision}`,
            datasetIdentity: current.config.datasetIdentity,
            providerKey: ProductionProvider.PROVIDER_KEY,
            routingConfig: built.routingConfig,
            sha256,
          });
          const credentialConfig = ProductConfig.canonicalCredentialConfig({
            schemaVersion: ProductConfig.SCHEMA_VERSION,
            routingDescriptor: config.routingDescriptor,
            entries: built.credentials,
          });
          const commit = {
            schemaVersion: COMMIT_SCHEMA_VERSION,
            revision: nextRevision,
            routingDescriptor: config.routingDescriptor,
            settings: built.settings,
          };
          try {
            await storageArea.set({
              [ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY]: {
                schemaVersion: MUTATION_SCHEMA_VERSION,
                status: 'WRITING',
              },
            });
            await storageArea.set({
              [ProductConfig.CONFIG_STORAGE_KEY]: config,
              [ProductConfig.CREDENTIALS_STORAGE_KEY]: credentialConfig,
              [ProductConfig.SETTINGS_COMMIT_STORAGE_KEY]: commit,
            });
            await storageArea.remove(
                ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY,
            );
          } catch (_error) {
            throw settingsError(ERRORS.SETTINGS_STORAGE_FAILED);
          }
          return Object.freeze({
            revision: nextRevision,
            settings: clone(built.settings),
          });

        }

        return Object.freeze({
          initialize: () => enqueue(async () => {

            try {
              await currentSnapshot({allowIncomplete: true});
              return Object.freeze({ok: true});
            } catch (error) {
              return Object.freeze({
                ok: false,
                code: error && error.code ? error.code :
                  ERRORS.SETTINGS_STATE_UNAVAILABLE,
              });
            }

          }),
          get: () => enqueue(getUnchecked),
          replace: (expectedRevision, settings) =>
            enqueue(() => replaceUnchecked(expectedRevision, settings)),
        });

      }

      return Object.freeze({
        COMMIT_SCHEMA_VERSION,
        ERRORS,
        MAX_IDENTIFIER_LENGTH,
        MAX_PUBLIC_PROXIES,
        MUTATION_SCHEMA_VERSION,
        SCHEMA_VERSION,
        buildRoutingSnapshot,
        canonicalSettings,
        createController,
        createDefaultSettings,
      });

    });
