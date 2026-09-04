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
  const SCHEMA_VERSION = 2;
  const OFF = 'OFF';
  const MIN_FLOOR_PORT = 49152;
  const MAX_FLOOR_PORT = 65535;
  const STATE_KEYS = Object.freeze([
    'schemaVersion',
    'intent',
    'floorIdentity',
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

  function canonicalState(floorIdentity = null) {

    const floor = floorIdentity === null ? null :
      canonicalizeFloorIdentity(floorIdentity);
    if (floorIdentity !== null && !floor) {
      throw new TypeError('INVALID_FIREFOX_FLOOR_IDENTITY');
    }
    return {schemaVersion: SCHEMA_VERSION, intent: OFF, floorIdentity: floor};

  }

  function isCanonicalState(value) {

    return Boolean(
        hasExactKeys(value, STATE_KEYS) &&
        value.schemaVersion === SCHEMA_VERSION &&
        value.intent === OFF &&
        (value.floorIdentity === null ||
          canonicalizeFloorIdentity(value.floorIdentity) !== null),
    );

  }

  function normalizeDurableState(value) {

    if (isCanonicalState(value)) {
      return canonicalState(value.floorIdentity);
    }
    return canonicalState();

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
    const state = canonicalState(floorIdentity);
    await storageArea.set({[STORAGE_KEY]: state});
    return state;

  }

  return Object.freeze({
    FLOOR_KEYS,
    MAX_FLOOR_PORT,
    MIN_FLOOR_PORT,
    OFF,
    SCHEMA_VERSION,
    STORAGE_KEY,
    canonicalState,
    canonicalizeFloorIdentity,
    initialize,
    isCanonicalState,
    normalizeDurableState,
    writeOffState,
  });

});
