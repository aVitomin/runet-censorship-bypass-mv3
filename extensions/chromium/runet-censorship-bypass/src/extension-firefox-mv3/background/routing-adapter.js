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
  const DIRECT = Object.freeze({type: 'direct'});
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
      return {proxyResult: DIRECT, callbackBudget: 1};
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
    if (decision.fallback === Routing.FALLBACKS.DIRECT) {
      if (proxies.length === MAX_CALLBACK_BUDGET) {
        return null;
      }
      proxies.push(DIRECT);
      return {proxyResult: proxies, callbackBudget: proxies.length};
    }
    proxies.push(null);
    return {
      proxyResult: proxies,
      callbackBudget: proxies.length - 1,
    };

  }

  function createAdapter(options = {}) {

    const runtimeState = options.initialState || STATES.OFF;
    if (!Object.values(STATES).includes(runtimeState)) {
      throw new TypeError('INVALID_FIREFOX_RUNTIME_STATE');
    }
    const decideRoute = options.decideRoute || Routing.decideRoute;
    const routingInputForRequest = options.routingInputForRequest;
    let authorizations = options.authorizations || new Map();

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

      if (runtimeState === STATES.OFF) {
        return undefined;
      }
      const requestId = details && details.requestId;
      clearAuthorization(requestId);
      if (runtimeState !== STATES.READY ||
          typeof routingInputForRequest !== 'function') {
        return DIRECT;
      }
      try {
        const decision = decideRoute(routingInputForRequest(details));
        const converted = convertDecision(decision);
        if (!converted ||
            !authorize(requestId, converted.callbackBudget)) {
          clearAuthorization(requestId);
          return DIRECT;
        }
        return converted.proxyResult;
      } catch (_error) {
        clearAuthorization(requestId);
        return DIRECT;
      }

    }

    function onBeforeRequest(details) {

      try {
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

    return Object.freeze({
      authorizationCount,
      onBeforeRequest,
      onProxyRequest,
      onRequestTerminal,
      runtimeState,
    });

  }

  return Object.freeze({
    ALLOW,
    CANCEL,
    MAX_AUTHORIZATIONS,
    MAX_CALLBACK_BUDGET,
    STATES,
    candidateToProxyInfo,
    convertDecision,
    createAdapter,
  });

});
