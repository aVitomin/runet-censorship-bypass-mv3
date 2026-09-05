'use strict';

(function publishFirefoxProxyAuth(root, factory) {

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxProxyAuth = api;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const MAX_AUTH_ATTEMPTS_PER_REQUEST_CHALLENGER = 2;
  const MAX_AUTH_ATTEMPT_ENTRIES = 256;
  const CANCEL = Object.freeze({cancel: true});
  const STATES = Object.freeze({
    OFF: 'OFF',
    INITIALIZING: 'INITIALIZING',
    READY: 'READY',
    FAILED: 'FAILED',
  });

  function isRequestId(value) {

    return (typeof value === 'string' || typeof value === 'number') &&
      String(value).length > 0;

  }

  function validCredentials(value) {

    return Boolean(value) && typeof value === 'object' &&
      !Array.isArray(value) && typeof value.username === 'string' &&
      typeof value.password === 'string' &&
      !(value && typeof value.then === 'function');

  }

  function createHandler(options = {}) {

    const routingAdapter = options.routingAdapter;
    const resolveCredentials = options.resolveCredentials;
    let attempts = options.attempts || new Map();
    if (!routingAdapter ||
        typeof routingAdapter.currentRuntimeState !== 'function' ||
        typeof routingAdapter.authenticationForChallenge !== 'function' ||
        typeof routingAdapter.authorizeAuthenticationRetry !== 'function' ||
        typeof resolveCredentials !== 'function') {
      throw new TypeError('INVALID_FIREFOX_PROXY_AUTH_OPTIONS');
    }

    function resetAttempts() {

      attempts = new Map();

    }

    function clearAllAttempts() {

      resetAttempts();

    }

    function clearRequest(details) {

      const requestId = details && details.requestId;
      try {
        if (!isRequestId(requestId)) {
          return;
        }
        const prefix = `${String(requestId)}\u0000`;
        for (const key of attempts.keys()) {
          if (key.startsWith(prefix)) {
            attempts.delete(key);
          }
        }
      } catch (_error) {
        resetAttempts();
      }

    }

    function onAuthRequired(details) {

      try {
        const state = routingAdapter.currentRuntimeState();
        if (state === STATES.OFF) {
          return undefined;
        }
        if (state !== STATES.READY || !details ||
            details.isProxy !== true || !isRequestId(details.requestId)) {
          return CANCEL;
        }
        const authentication =
          routingAdapter.authenticationForChallenge(details);
        if (!authentication || typeof authentication.authRef !== 'string' ||
            typeof authentication.endpointKey !== 'string') {
          return CANCEL;
        }
        const attemptKey =
          `${String(details.requestId)}\u0000${authentication.endpointKey}`;
        const current = attempts.get(attemptKey);
        const count = current === undefined ? 0 : current;
        if (!Number.isSafeInteger(count) || count < 0 ||
            count >= MAX_AUTH_ATTEMPTS_PER_REQUEST_CHALLENGER) {
          return CANCEL;
        }
        const credentials = resolveCredentials(authentication.authRef);
        if (!validCredentials(credentials)) {
          return CANCEL;
        }
        if (!attempts.has(attemptKey) &&
            attempts.size >= MAX_AUTH_ATTEMPT_ENTRIES) {
          return CANCEL;
        }
        const response = {
          authCredentials: {
            username: credentials.username,
            password: credentials.password,
          },
        };
        attempts.set(attemptKey, count + 1);
        if (!routingAdapter.authorizeAuthenticationRetry(
            details,
            authentication.authRef,
        )) {
          if (count === 0) {
            attempts.delete(attemptKey);
          } else {
            attempts.set(attemptKey, count);
          }
          return CANCEL;
        }
        return response;
      } catch (_error) {
        return CANCEL;
      }

    }

    function attemptCount() {

      try {
        return attempts.size;
      } catch (_error) {
        resetAttempts();
        return 0;
      }

    }

    return Object.freeze({
      attemptCount,
      clearAllAttempts,
      onAuthRequired,
      onRequestTerminal: clearRequest,
    });

  }

  return Object.freeze({
    CANCEL,
    MAX_AUTH_ATTEMPTS_PER_REQUEST_CHALLENGER,
    MAX_AUTH_ATTEMPT_ENTRIES,
    createHandler,
    validCredentials,
  });

});
