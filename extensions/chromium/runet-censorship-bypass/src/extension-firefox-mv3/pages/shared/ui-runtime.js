'use strict';
/* global globalThis, module */

(function publishFirefoxUiRuntime(root, factory) {

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxUi = api;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const CAPABILITY_KEYS = Object.freeze([
    'activationSupported',
    'apiVersion',
    'browser',
    'durableIntent',
    'manifestVersion',
    'privateWindowAccess',
    'providerDatasetAvailable',
    'providerDatasetImplemented',
    'recoveryFailureCode',
    'recoveryStatus',
    'routingImplemented',
    'runtimeModel',
    'runtimeState',
  ]);
  const RUNTIME_STATES = Object.freeze([
    'FAILED',
    'INITIALIZING',
    'OFF',
    'READY',
  ]);
  const DURABLE_INTENTS = Object.freeze(['OFF', 'ON']);
  const PRIVATE_ACCESS = Object.freeze(['DENIED', 'GRANTED', 'UNKNOWN']);
  const OPERATIONAL_KEYS = Object.freeze([
    'diagnostics', 'health', 'schemaVersion',
  ]);
  const HEALTH_KEYS = Object.freeze([
    'candidateType', 'checkedAt', 'code', 'status',
  ]);
  const HEALTH_STATUSES = Object.freeze([
    'ERROR', 'INCONCLUSIVE', 'OK', 'UNKNOWN',
  ]);
  const HEALTH_CODES = Object.freeze([
    'HEALTH_CHECK_FAILED',
    'HEALTH_CHECK_INTERRUPTED',
    'HEALTH_CHECK_SUPERSEDED',
    'HEALTH_CHECK_TIMEOUT',
    'HEALTH_NOT_ACTIVE',
    'HEALTH_PROXY_CANDIDATE_UNAVAILABLE',
    'HEALTH_PROXY_RULE_REQUIRED',
    'HEALTH_TARGET_REQUIRED',
  ]);
  const RECOVERY_STATUSES = Object.freeze([
    'ACTIVE',
    'BLOCKED_CONTROL_LOSS',
    'BLOCKED_PRIVATE_ACCESS',
    'FAILED',
    'INITIALIZING',
    'OFF',
    'OFF_RECONCILIATION_FAILED',
    'RECOVERED',
  ]);
  const DIAGNOSTIC_KEYS = Object.freeze([
    'browserName',
    'browserVersion',
    'configuredProxyCount',
    'controlLevel',
    'datasetAvailable',
    'datasetVersion',
    'durableIntent',
    'enabledProxyCount',
    'extensionVersion',
    'generatedAt',
    'notificationsAvailable',
    'privateWindowAccess',
    'proxyTypes',
    'recoveryFailureCode',
    'recoveryStatus',
    'runtimeState',
    'schemaVersion',
  ]);
  const CONTROL_LEVELS = Object.freeze([
    'controlled_by_other_extensions',
    'controlled_by_this_extension',
    'controllable_by_this_extension',
    'not_controllable',
    'unknown',
  ]);
  const SAFE_RPC_CODES = new Set([
    'ACTIVATION_ALREADY_ACTIVE',
    'ACTIVATION_FAILED',
    'BOOT_NOT_READY',
    'CREDENTIAL_CONFIG_DESCRIPTOR_MISMATCH',
    'CREDENTIAL_CONFIG_MALFORMED',
    'CREDENTIAL_CONFIG_VERSION_UNSUPPORTED',
    'DATASET_IDENTITY_MISMATCH',
    'DATASET_INITIALIZATION_FAILED',
    'DATASET_NOT_READY',
    'DATASET_STORE_UNAVAILABLE',
    'DURABLE_OFF_PERSIST_FAILED',
    'DURABLE_ON_PERSIST_FAILED',
    'DURABLE_STATE_UNAVAILABLE',
    'EPHEMERAL_CLEAR_FAILED',
    'INVALID_RPC_REQUEST',
    'NO_USABLE_PROVIDER_DATASET',
    'OPERATIONAL_STATE_UNAVAILABLE',
    'PRIVATE_ACCESS_CHECK_FAILED',
    'PRIVATE_ACCESS_REQUIRED',
    'PRODUCT_CONFIG_DATASET_MISMATCH',
    'PRODUCT_CONFIG_DESCRIPTOR_MISMATCH',
    'PRODUCT_CONFIG_HASH_MISMATCH',
    'PRODUCT_CONFIG_MALFORMED',
    'PRODUCT_CONFIG_MISSING',
    'PRODUCT_CONFIG_PROVIDER_MISMATCH',
    'PRODUCT_CONFIG_STORAGE_UNAVAILABLE',
    'PRODUCT_CONFIG_UPDATE_INCOMPLETE',
    'PRODUCT_CONFIG_VERSION_UNSUPPORTED',
    'PROXY_CLEAR_FAILED',
    'PROXY_OWNERSHIP_CONFIRMATION_FAILED',
    'PROXY_SET_FAILED',
    'RANDOM_GENERATOR_UNAVAILABLE',
    'RECOVERY_FACTORY_FAILED',
    'RECOVERY_FLOOR_MISMATCH',
    'RECOVERY_UNAVAILABLE',
    'REQUIRED_CREDENTIAL_MISSING',
    'ROUTING_CONFIG_TOO_LARGE',
    'SELECTED_DATASET_UNAVAILABLE',
    'SITE_PAGE_NOT_CONTROLLABLE',
    'SITE_PROXY_CANDIDATE_UNAVAILABLE',
    'SITE_REQUEST_MALFORMED',
    'SETTINGS_CREDENTIAL_AMBIGUOUS',
    'SETTINGS_CREDENTIAL_STALE',
    'SETTINGS_DATASET_BINDING_FAILED',
    'SETTINGS_MALFORMED',
    'SETTINGS_MUTATION_REQUIRES_OFF',
    'SETTINGS_REVISION_CONFLICT',
    'SETTINGS_STATE_UNAVAILABLE',
    'SETTINGS_STORAGE_FAILED',
    'SETTINGS_TRANSACTION_INCOMPLETE',
    'SETTINGS_VERSION_UNSUPPORTED',
    'STALE_REVISION',
    'UNKNOWN_RPC',
    'UI_VALIDATION_FAILED',
  ]);

  function hasExactKeys(value, expected) {

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]);

  }

  function safeErrorCode(value) {

    const candidate = typeof value === 'string' ? value :
      value && typeof value === 'object' ? value.code : null;
    return SAFE_RPC_CODES.has(candidate) ? candidate : 'UI_RPC_FAILED';

  }

  function rpcError(code) {

    const error = new Error('Firefox UI RPC failed.');
    error.code = safeErrorCode(code);
    return error;

  }

  function createRpc(browserApi) {

    if (!browserApi || !browserApi.runtime ||
        typeof browserApi.runtime.sendMessage !== 'function') {
      throw rpcError('UI_RPC_FAILED');
    }
    return Object.freeze({
      async call(message) {

        let response;
        try {
          response = await browserApi.runtime.sendMessage(message);
        } catch (_error) {
          throw rpcError('UI_RPC_FAILED');
        }
        if (!response || typeof response !== 'object' ||
            Array.isArray(response) || typeof response.ok !== 'boolean') {
          throw rpcError('UI_RPC_FAILED');
        }
        if (response.ok !== true) {
          const error = response.error;
          throw rpcError(error && error.code);
        }
        if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
          throw rpcError('UI_RPC_FAILED');
        }
        return response.result;

      },
    });

  }

  function validateCapabilities(value) {

    if (!hasExactKeys(value, CAPABILITY_KEYS) || value.apiVersion !== 2 ||
        value.browser !== 'FIREFOX' || value.manifestVersion !== 3 ||
        value.runtimeModel !== 'BACKGROUND_EVENT_PAGE' ||
        !RUNTIME_STATES.includes(value.runtimeState) ||
        !DURABLE_INTENTS.includes(value.durableIntent) ||
        !PRIVATE_ACCESS.includes(value.privateWindowAccess) ||
        typeof value.routingImplemented !== 'boolean' ||
        typeof value.activationSupported !== 'boolean' ||
        typeof value.providerDatasetImplemented !== 'boolean' ||
        typeof value.providerDatasetAvailable !== 'boolean' ||
        typeof value.recoveryStatus !== 'string' ||
        (value.recoveryFailureCode !== null &&
          typeof value.recoveryFailureCode !== 'string')) {
      throw rpcError('UI_RPC_FAILED');
    }
    return Object.freeze(Object.assign({}, value));

  }

  function validateHealth(value) {

    if (!hasExactKeys(value, HEALTH_KEYS) ||
        !HEALTH_STATUSES.includes(value.status) ||
        (value.code !== null && !HEALTH_CODES.includes(value.code)) ||
        (value.checkedAt !== null &&
          (!Number.isSafeInteger(value.checkedAt) || value.checkedAt < 1)) ||
        (value.candidateType !== null &&
          !['localTor', 'ownProxy', 'torBrowser', 'warp']
              .includes(value.candidateType))) {
      throw rpcError('UI_RPC_FAILED');
    }
    return Object.freeze(clone(value));

  }

  function validateOperationalStatus(value) {

    if (!hasExactKeys(value, OPERATIONAL_KEYS) || value.schemaVersion !== 1 ||
        !hasExactKeys(value.diagnostics, DIAGNOSTIC_KEYS)) {
      throw rpcError('UI_RPC_FAILED');
    }
    const diagnostic = value.diagnostics;
    if (diagnostic.schemaVersion !== 1 ||
        !Number.isSafeInteger(diagnostic.generatedAt) ||
        diagnostic.generatedAt < 1 ||
        typeof diagnostic.extensionVersion !== 'string' ||
        !diagnostic.extensionVersion ||
        typeof diagnostic.browserName !== 'string' ||
        (diagnostic.browserVersion !== null &&
          typeof diagnostic.browserVersion !== 'string') ||
        !RUNTIME_STATES.includes(diagnostic.runtimeState) ||
        !DURABLE_INTENTS.includes(diagnostic.durableIntent) ||
        !RECOVERY_STATUSES.includes(diagnostic.recoveryStatus) ||
        (diagnostic.recoveryFailureCode !== null &&
          typeof diagnostic.recoveryFailureCode !== 'string') ||
        !CONTROL_LEVELS.includes(diagnostic.controlLevel) ||
        typeof diagnostic.datasetAvailable !== 'boolean' ||
        (diagnostic.datasetVersion !== null &&
          typeof diagnostic.datasetVersion !== 'string') ||
        !Number.isSafeInteger(diagnostic.configuredProxyCount) ||
        diagnostic.configuredProxyCount < 0 ||
        !Number.isSafeInteger(diagnostic.enabledProxyCount) ||
        diagnostic.enabledProxyCount < 0 ||
        diagnostic.enabledProxyCount > diagnostic.configuredProxyCount ||
        !Array.isArray(diagnostic.proxyTypes) ||
        diagnostic.proxyTypes.some((type) =>
          !['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'].includes(type)) ||
        !PRIVATE_ACCESS.includes(diagnostic.privateWindowAccess) ||
        typeof diagnostic.notificationsAvailable !== 'boolean') {
      throw rpcError('UI_RPC_FAILED');
    }
    const copy = clone(value);
    copy.health = validateHealth(value.health);
    copy.diagnostics = Object.freeze(copy.diagnostics);
    return Object.freeze(copy);

  }

  function translate(browserApi, key, substitutions) {

    try {
      const i18n = browserApi && browserApi.i18n;
      const value = i18n && typeof i18n.getMessage === 'function' ?
        i18n.getMessage(key, substitutions) : '';
      return typeof value === 'string' && value ? value : key;
    } catch (_error) {
      return key;
    }

  }

  function clear(node) {

    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }

  }

  function append(parent, tagName, className = '') {

    const node = parent.ownerDocument.createElement(tagName);
    if (className) {
      node.className = className;
    }
    parent.appendChild(node);
    return node;

  }

  function appendText(parent, tagName, value, className = '') {

    const node = append(parent, tagName, className);
    node.textContent = value;
    return node;

  }

  function clone(value) {

    return JSON.parse(JSON.stringify(value));

  }

  return Object.freeze({
    CAPABILITY_KEYS,
    CONTROL_LEVELS,
    DIAGNOSTIC_KEYS,
    HEALTH_CODES,
    HEALTH_KEYS,
    HEALTH_STATUSES,
    OPERATIONAL_KEYS,
    RECOVERY_STATUSES,
    SAFE_RPC_CODES,
    append,
    appendText,
    clear,
    clone,
    createRpc,
    hasExactKeys,
    rpcError,
    safeErrorCode,
    translate,
    validateCapabilities,
    validateHealth,
    validateOperationalStatus,
  });

});
