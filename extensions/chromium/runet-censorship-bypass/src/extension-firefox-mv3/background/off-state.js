'use strict';

(function publishFirefoxOffState(root, factory) {

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxOffState = api;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const STORAGE_KEY = 'firefoxMv3InertState';
  const SCHEMA_VERSION = 3;
  const ROUTING_DESCRIPTOR_SCHEMA_VERSION = 1;
  const OFF = 'OFF';
  const ON = 'ON';
  const MIN_FLOOR_PORT = 49152;
  const MAX_FLOOR_PORT = 65535;
  const OFF_STATE_KEYS = Object.freeze([
    'schemaVersion',
    'intent',
    'floorIdentity',
  ]);
  const ON_STATE_KEYS = Object.freeze([
    'schemaVersion',
    'intent',
    'floorIdentity',
    'providerKey',
    'datasetIdentity',
    'routingDescriptor',
  ]);
  const FLOOR_KEYS = Object.freeze([
    'proxyType',
    'http',
    'httpProxyAll',
    'ssl',
    'socks',
    'socksVersion',
    'proxyDNS',
    'passthrough',
    'autoConfigUrl',
  ]);
  const DATASET_IDENTITY_KEYS = Object.freeze([
    'providerKey',
    'datasetVersion',
    'artifactSha256',
  ]);
  const ROUTING_DESCRIPTOR_KEYS = Object.freeze([
    'schemaVersion',
    'configurationKey',
    'configurationVersion',
    'configurationSha256',
  ]);
  const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
  const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,127})$/;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;

  function hasExactKeys(value, keys) {

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length &&
      actual.every((key, index) => key === expected[index]);

  }

  function canonicalizeFloorIdentity(value) {

    if (!hasExactKeys(value, FLOOR_KEYS) ||
        value.proxyType !== 'manual' ||
        value.http !== '' || value.httpProxyAll !== false ||
        value.ssl !== '' || value.socksVersion !== 5 ||
        value.proxyDNS !== true || value.passthrough !== '' ||
        value.autoConfigUrl !== '' || typeof value.socks !== 'string') {
      return null;
    }
    const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value.socks);
    const port = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(port) || port < MIN_FLOOR_PORT ||
        port > MAX_FLOOR_PORT) {
      return null;
    }
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

  function canonicalizeDatasetIdentity(value) {

    if (!hasExactKeys(value, DATASET_IDENTITY_KEYS) ||
        typeof value.providerKey !== 'string' ||
        !IDENTIFIER_PATTERN.test(value.providerKey) ||
        typeof value.datasetVersion !== 'string' ||
        !VERSION_PATTERN.test(value.datasetVersion) ||
        typeof value.artifactSha256 !== 'string' ||
        !SHA256_PATTERN.test(value.artifactSha256)) {
      return null;
    }
    return {
      providerKey: value.providerKey,
      datasetVersion: value.datasetVersion,
      artifactSha256: value.artifactSha256,
    };

  }

  function canonicalizeRoutingDescriptor(value) {

    if (!hasExactKeys(value, ROUTING_DESCRIPTOR_KEYS) ||
        value.schemaVersion !== ROUTING_DESCRIPTOR_SCHEMA_VERSION ||
        typeof value.configurationKey !== 'string' ||
        !IDENTIFIER_PATTERN.test(value.configurationKey) ||
        typeof value.configurationVersion !== 'string' ||
        !VERSION_PATTERN.test(value.configurationVersion) ||
        typeof value.configurationSha256 !== 'string' ||
        !SHA256_PATTERN.test(value.configurationSha256)) {
      return null;
    }
    return {
      schemaVersion: ROUTING_DESCRIPTOR_SCHEMA_VERSION,
      configurationKey: value.configurationKey,
      configurationVersion: value.configurationVersion,
      configurationSha256: value.configurationSha256,
    };

  }

  function canonicalOffState(floorIdentity = null) {

    const floor = floorIdentity === null ? null :
      canonicalizeFloorIdentity(floorIdentity);
    if (floorIdentity !== null && !floor) {
      throw new TypeError('INVALID_FIREFOX_FLOOR_IDENTITY');
    }
    return {schemaVersion: SCHEMA_VERSION, intent: OFF, floorIdentity: floor};

  }

  function canonicalOnState(value) {

    const floorIdentity = canonicalizeFloorIdentity(
        value && value.floorIdentity,
    );
    const datasetIdentity = canonicalizeDatasetIdentity(
        value && value.datasetIdentity,
    );
    const routingDescriptor = canonicalizeRoutingDescriptor(
        value && value.routingDescriptor,
    );
    const providerKey = value && value.providerKey;
    if (!floorIdentity || !datasetIdentity || !routingDescriptor ||
        typeof providerKey !== 'string' ||
        !IDENTIFIER_PATTERN.test(providerKey) ||
        providerKey !== datasetIdentity.providerKey) {
      throw new TypeError('INVALID_FIREFOX_ON_STATE');
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      intent: ON,
      floorIdentity,
      providerKey,
      datasetIdentity,
      routingDescriptor,
    };

  }

  function canonicalState(floorIdentity = null) {

    return canonicalOffState(floorIdentity);

  }

  function isCanonicalOffState(value) {

    return Boolean(
        hasExactKeys(value, OFF_STATE_KEYS) &&
        value.schemaVersion === SCHEMA_VERSION && value.intent === OFF &&
        (value.floorIdentity === null ||
          canonicalizeFloorIdentity(value.floorIdentity) !== null),
    );

  }

  function isCanonicalOnState(value) {

    if (!hasExactKeys(value, ON_STATE_KEYS) ||
        value.schemaVersion !== SCHEMA_VERSION || value.intent !== ON) {
      return false;
    }
    try {
      canonicalOnState(value);
      return true;
    } catch (_error) {
      return false;
    }

  }

  function isCanonicalState(value) {

    return isCanonicalOffState(value) || isCanonicalOnState(value);

  }

  function cleanupFloorFromMalformedState(value) {

    try {
      return canonicalizeFloorIdentity(value && value.floorIdentity);
    } catch (_error) {
      return null;
    }

  }

  function normalizeDurableState(value) {

    if (isCanonicalOffState(value)) {
      return canonicalOffState(value.floorIdentity);
    }
    if (isCanonicalOnState(value)) {
      return canonicalOnState(value);
    }
    if (hasExactKeys(value, OFF_STATE_KEYS) &&
        value.schemaVersion === 2 && value.intent === OFF) {
      const oldFloor = value.floorIdentity === null ? null :
        canonicalizeFloorIdentity(value.floorIdentity);
      return canonicalOffState(oldFloor);
    }
    if (value && typeof value === 'object' && !Array.isArray(value) &&
        value.schemaVersion === 1 && value.intent === OFF) {
      return canonicalOffState();
    }
    return canonicalOffState(cleanupFloorFromMalformedState(value));

  }

  function requireStorage(storageArea) {

    if (!storageArea || typeof storageArea.get !== 'function' ||
        typeof storageArea.set !== 'function') {
      throw new TypeError('FIREFOX_STORAGE_UNAVAILABLE');
    }

  }

  async function initialize(storageArea) {

    requireStorage(storageArea);
    const stored = await storageArea.get(STORAGE_KEY);
    const current = stored && stored[STORAGE_KEY];
    const normalized = normalizeDurableState(current);
    if (!isCanonicalState(current)) {
      await storageArea.set({[STORAGE_KEY]: normalized});
    }
    return normalized;

  }

  async function writeOffState(storageArea, floorIdentity) {

    requireStorage(storageArea);
    const state = canonicalOffState(floorIdentity);
    await storageArea.set({[STORAGE_KEY]: state});
    return state;

  }

  async function writeOnState(storageArea, value) {

    requireStorage(storageArea);
    const state = canonicalOnState(value);
    await storageArea.set({[STORAGE_KEY]: state});
    return state;

  }

  return Object.freeze({
    DATASET_IDENTITY_KEYS,
    FLOOR_KEYS,
    MAX_FLOOR_PORT,
    MIN_FLOOR_PORT,
    OFF,
    OFF_STATE_KEYS,
    ON,
    ON_STATE_KEYS,
    ROUTING_DESCRIPTOR_KEYS,
    ROUTING_DESCRIPTOR_SCHEMA_VERSION,
    SCHEMA_VERSION,
    STORAGE_KEY,
    canonicalOffState,
    canonicalOnState,
    canonicalState,
    canonicalizeDatasetIdentity,
    canonicalizeFloorIdentity,
    canonicalizeRoutingDescriptor,
    initialize,
    isCanonicalOffState,
    isCanonicalOnState,
    isCanonicalState,
    normalizeDurableState,
    writeOffState,
    writeOnState,
  });

});
