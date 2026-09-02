'use strict';
/* global require */

(function publishFirefoxRoutingAdapter(root, factory) {

  const routingContract = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/routing-contract') :
    root.mv3RoutingContract;
  const api = factory(routingContract);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxRoutingAdapter = api;

})(typeof globalThis === 'object' ? globalThis : this, function(Routing) {

  const STATES = Object.freeze({
    OFF: 'OFF',
    INITIALIZING: 'INITIALIZING',
    READY: 'READY',
    FAILED: 'FAILED',
  });
  const MAX_AUTHORIZATIONS = 256;
  const MAX_CALLBACK_BUDGET = 256;
  const ALLOW = Object.freeze({cancel: false});
  const CANCEL = Object.freeze({cancel: true});
  const DEFAULT_ROUTE = Object.freeze({type: 'direct'});
  const DEGRADATION_CODES = Object.freeze({
    PROXY_DIRECT_FALLBACK_STRIPPED: 'PROXY_DIRECT_FALLBACK_STRIPPED',
  });
  const FIREFOX_TYPES = Object.freeze({
    HTTP: 'http',
    HTTPS: 'https',
    SOCKS4: 'socks4',
    SOCKS5: 'socks',
  });

  function isRequestId(value) {

    return (typeof value === 'string' || typeof value === 'number') &&
      String(value).length > 0;

  }

  function validCandidateHost(value) {

    return typeof value === 'string' && value.length > 0 &&
      !Array.from(value).some((character) => character.charCodeAt(0) <= 32) &&
      !/[/\\?#@]/.test(value);

  }

  function candidateToProxyInfo(candidate) {

    if (!candidate || typeof candidate !== 'object' ||
        Array.isArray(candidate) ||
        ['credentials', 'password', 'username'].some((key) =>
          Object.prototype.hasOwnProperty.call(candidate, key)) ||
        !Object.prototype.hasOwnProperty.call(FIREFOX_TYPES, candidate.type) ||
        !validCandidateHost(candidate.host) ||
        !Number.isSafeInteger(candidate.port) ||
        candidate.port < 1 || candidate.port > 65535 ||
        typeof candidate.proxyDNS !== 'boolean' ||
        candidate.authRef !== null ||
        typeof candidate.id !== 'string' || !candidate.id) {
      return null;
    }
    if (candidate.failoverTimeoutSeconds !== null &&
        (!Number.isSafeInteger(candidate.failoverTimeoutSeconds) ||
        candidate.failoverTimeoutSeconds < 1)) {
      return null;
    }
    const proxyInfo = {
      type: FIREFOX_TYPES[candidate.type],
      host: candidate.host,
      port: candidate.port,
    };
    if (candidate.type === 'SOCKS4' || candidate.type === 'SOCKS5') {
      proxyInfo.proxyDNS = candidate.proxyDNS;
    }
    if (candidate.failoverTimeoutSeconds !== null) {
      proxyInfo.failoverTimeout = candidate.failoverTimeoutSeconds;
    }
    return proxyInfo;

  }

  function convertDecision(decision) {

    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      return null;
    }
    if (decision.kind === Routing.KINDS.DIRECT) {
      // Firefox treats only top-level null as true Direct. A ProxyInfo Direct
      // continues through browser/global proxy settings.
      return {proxyResult: null, callbackBudget: 1};
    }
    if (decision.kind === Routing.KINDS.FAIL_CLOSED) {
      return null;
    }
    if (decision.kind !== Routing.KINDS.PROXY ||
        !Array.isArray(decision.candidates) ||
        decision.candidates.length < 1 ||
        decision.candidates.length > MAX_CALLBACK_BUDGET ||
        !Object.values(Routing.FALLBACKS).includes(decision.fallback)) {
      return null;
    }
    const proxies = [];
    for (const candidate of decision.candidates) {
      const proxyInfo = candidateToProxyInfo(candidate);
      if (!proxyInfo) {
        return null;
      }
      proxies.push(proxyInfo);
    }
    // A trailing null terminates Firefox proxy fallback and does not produce
    // another webRequest callback, so it is intentionally outside the budget.
    proxies.push(null);
    const converted = {
      proxyResult: proxies,
      callbackBudget: proxies.length - 1,
    };
    if (decision.fallback === Routing.FALLBACKS.DIRECT) {
      // Firefox arrays cannot express a true terminal Direct route. Preserve
      // every validated proxy candidate but deliberately fail closed after
      // exhaustion, and keep the availability degradation observable to the
      // pure conversion caller without mutable global diagnostics.
      converted.degradationCode =
        DEGRADATION_CODES.PROXY_DIRECT_FALLBACK_STRIPPED;
    }
    return converted;

  }

  function createAdapter(options = {}) {

    const initialState = options.initialState || STATES.OFF;
    if (!Object.values(STATES).includes(initialState)) {
      throw new TypeError('INVALID_FIREFOX_RUNTIME_STATE');
    }
    const runtimeStateForRequest = options.runtimeStateForRequest ||
      (() => initialState);
    const decideRoute = options.decideRoute || Routing.decideRoute;
    const routingInputForRequest = options.routingInputForRequest;
    let authorizations = options.authorizations || new Map();

    function currentRuntimeState() {

      const runtimeState = runtimeStateForRequest();
      if (!Object.values(STATES).includes(runtimeState)) {
        throw new TypeError('INVALID_FIREFOX_RUNTIME_STATE');
      }
      return runtimeState;

    }

    function resetAuthorizations() {

      authorizations = new Map();

    }

    function clearAuthorization(requestId) {

      try {
        authorizations.delete(requestId);
      } catch (_error) {
        resetAuthorizations();
      }

    }

    function authorize(requestId, callbackBudget) {

      if (!isRequestId(requestId) ||
          !Number.isSafeInteger(callbackBudget) || callbackBudget < 1 ||
          callbackBudget > MAX_CALLBACK_BUDGET) {
        return false;
      }
      try {
        authorizations.delete(requestId);
        if (authorizations.size >= MAX_AUTHORIZATIONS) {
          return false;
        }
        authorizations.set(requestId, callbackBudget);
        return authorizations.size <= MAX_AUTHORIZATIONS;
      } catch (_error) {
        resetAuthorizations();
        return false;
      }

    }

    function onProxyRequest(details) {

      const requestId = details && details.requestId;
      try {
        const runtimeState = currentRuntimeState();
        if (runtimeState === STATES.OFF) {
          return undefined;
        }
        clearAuthorization(requestId);
        if (runtimeState !== STATES.READY ||
            typeof routingInputForRequest !== 'function') {
          return DEFAULT_ROUTE;
        }
        const decision = decideRoute(routingInputForRequest(details));
        const converted = convertDecision(decision);
        if (!converted || !authorize(requestId, converted.callbackBudget)) {
          clearAuthorization(requestId);
          return DEFAULT_ROUTE;
        }
        return converted.proxyResult;
      } catch (_error) {
        clearAuthorization(requestId);
        return DEFAULT_ROUTE;
      }

    }

    function onBeforeRequest(details) {

      try {
        const runtimeState = currentRuntimeState();
        if (runtimeState === STATES.OFF) {
          return ALLOW;
        }
        if (runtimeState !== STATES.READY) {
          return CANCEL;
        }
        const requestId = details.requestId;
        const remaining = authorizations.get(requestId);
        if (!Number.isSafeInteger(remaining) || remaining < 1 ||
            remaining > MAX_CALLBACK_BUDGET) {
          authorizations.delete(requestId);
          return CANCEL;
        }
        if (remaining === 1) {
          authorizations.delete(requestId);
        } else {
          authorizations.set(requestId, remaining - 1);
        }
        return ALLOW;
      } catch (_error) {
        resetAuthorizations();
        return CANCEL;
      }

    }

    function onRequestTerminal(details) {

      clearAuthorization(details && details.requestId);

    }

    function authorizationCount() {

      try {
        return authorizations.size;
      } catch (_error) {
        resetAuthorizations();
        return 0;
      }

    }

    const api = {
      authorizationCount,
      currentRuntimeState,
      onBeforeRequest,
      onProxyRequest,
      onRequestTerminal,
    };
    Object.defineProperty(api, 'runtimeState', {
      enumerable: true,
      get: currentRuntimeState,
    });
    return Object.freeze(api);

  }

  return Object.freeze({
    ALLOW,
    CANCEL,
    DEGRADATION_CODES,
    MAX_AUTHORIZATIONS,
    MAX_CALLBACK_BUDGET,
    STATES,
    candidateToProxyInfo,
    convertDecision,
    createAdapter,
  });

});
