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
  const SCHEMA_VERSION = 1;
  const OFF = 'OFF';

  function canonicalState() {

    return {schemaVersion: SCHEMA_VERSION, intent: OFF};

  }

  function isCanonicalState(value) {

    return Boolean(
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 2 &&
        value.schemaVersion === SCHEMA_VERSION &&
        value.intent === OFF,
    );

  }

  function normalizeDurableState(_value) {

    return canonicalState();

  }

  async function initialize(storageArea) {

    if (!storageArea || typeof storageArea.get !== 'function' ||
        typeof storageArea.set !== 'function') {
      throw new TypeError('FIREFOX_STORAGE_UNAVAILABLE');
    }
    const stored = await storageArea.get(STORAGE_KEY);
    const current = stored && stored[STORAGE_KEY];
    const normalized = normalizeDurableState(current);
    if (!isCanonicalState(current)) {
      await storageArea.set({[STORAGE_KEY]: normalized});
    }
    return normalized;

  }

  return Object.freeze({
    OFF,
    SCHEMA_VERSION,
    STORAGE_KEY,
    initialize,
    isCanonicalState,
    normalizeDurableState,
  });

});
