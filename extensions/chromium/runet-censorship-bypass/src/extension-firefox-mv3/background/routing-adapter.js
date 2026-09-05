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
  const AUTH_REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
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

  function normalizeHost(value) {

    return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();

  }

  function normalizeProxyType(value) {

    const type = String(value || '').trim().toLowerCase();
    if (type === 'socks5') {
      return 'socks';
    }
    return Object.values(FIREFOX_TYPES).includes(type) ? type : null;

  }

  function validAuthRef(value) {

    return value === null ||
      (typeof value === 'string' && AUTH_REF_PATTERN.test(value));

  }

  function endpointKey(host, port) {

    const normalizedHost = normalizeHost(host);
    const normalizedPort = Number(port);
    return normalizedHost && Number.isSafeInteger(normalizedPort) &&
      normalizedPort >= 1 && normalizedPort <= 65535 ?
      `${normalizedHost}:${normalizedPort}` :
      null;

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
        !validAuthRef(candidate.authRef) ||
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

  function convertDecisionDetails(decision) {

    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      return null;
    }
    if (decision.kind === Routing.KINDS.DIRECT) {
      return {proxyResult: null, callbackBudget: 1, authCandidates: []};
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
    const authCandidates = [];
    const authRefsByEndpoint = new Map();
    for (const candidate of decision.candidates) {
      const proxyInfo = candidateToProxyInfo(candidate);
      const key = endpointKey(candidate && candidate.host, candidate && candidate.port);
      if (!proxyInfo || !key) {
        return null;
      }
      if (authRefsByEndpoint.has(key) &&
          authRefsByEndpoint.get(key) !== candidate.authRef) {
        return null;
      }
      authRefsByEndpoint.set(key, candidate.authRef);
      proxies.push(proxyInfo);
      authCandidates.push(Object.freeze({
        type: proxyInfo.type,
        host: normalizeHost(proxyInfo.host),
        port: proxyInfo.port,
        endpointKey: key,
        authRef: candidate.authRef,
      }));
    }
    // A trailing null terminates Firefox proxy fallback and does not produce
    // another webRequest callback, so it is intentionally outside the budget.
    proxies.push(null);
    const converted = {
      proxyResult: proxies,
      callbackBudget: proxies.length - 1,
      authCandidates: Object.freeze(authCandidates),
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

  function convertDecision(decision) {

    const converted = convertDecisionDetails(decision);
    if (!converted) {
      return null;
    }
    const result = {
      proxyResult: converted.proxyResult,
      callbackBudget: converted.callbackBudget,
    };
    if (converted.degradationCode) {
      result.degradationCode = converted.degradationCode;
    }
    return result;

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
    let requestAuthContexts = options.requestAuthContexts || new Map();

    function currentRuntimeState() {

      const runtimeState = runtimeStateForRequest();
      if (!Object.values(STATES).includes(runtimeState)) {
        throw new TypeError('INVALID_FIREFOX_RUNTIME_STATE');
      }
      return runtimeState;

    }

    function resetEphemeralState() {

      authorizations = new Map();
      requestAuthContexts = new Map();

    }

    function clearAllAuthorizations() {

      resetEphemeralState();

    }

    function clearAuthorization(requestId) {

      try {
        authorizations.delete(requestId);
        requestAuthContexts.delete(requestId);
      } catch (_error) {
        resetEphemeralState();
      }

    }

    function authorize(requestId, callbackBudget, authCandidates) {

      if (!isRequestId(requestId) ||
          !Number.isSafeInteger(callbackBudget) || callbackBudget < 1 ||
          callbackBudget > MAX_CALLBACK_BUDGET ||
          !Array.isArray(authCandidates)) {
        return false;
      }
      try {
        authorizations.delete(requestId);
        requestAuthContexts.delete(requestId);
        if (authorizations.size >= MAX_AUTHORIZATIONS ||
            requestAuthContexts.size >= MAX_AUTHORIZATIONS) {
          return false;
        }
        authorizations.set(requestId, callbackBudget);
        if (authCandidates.length) {
          requestAuthContexts.set(requestId, {
            candidates: authCandidates,
            selected: null,
          });
        }
        return authorizations.size <= MAX_AUTHORIZATIONS &&
          requestAuthContexts.size <= MAX_AUTHORIZATIONS;
      } catch (_error) {
        resetEphemeralState();
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
        const converted = convertDecisionDetails(decision);
        if (!converted || !authorize(
            requestId,
            converted.callbackBudget,
            converted.authCandidates,
        )) {
          clearAuthorization(requestId);
          return DEFAULT_ROUTE;
        }
        return converted.proxyResult;
      } catch (_error) {
        clearAuthorization(requestId);
        return DEFAULT_ROUTE;
      }

    }

    function observeSelectedProxy(details) {

      const requestId = details && details.requestId;
      const context = requestAuthContexts.get(requestId);
      if (!context) {
        return;
      }
      const proxyInfo = details && details.proxyInfo;
      const key = endpointKey(
          proxyInfo && proxyInfo.host,
          proxyInfo && proxyInfo.port,
      );
      const type = normalizeProxyType(proxyInfo && proxyInfo.type);
      context.selected = key && type ?
        context.candidates.find((candidate) =>
          candidate.endpointKey === key && candidate.type === type,
        ) || null :
        null;

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
        observeSelectedProxy(details);
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
        resetEphemeralState();
        return CANCEL;
      }

    }

    function authenticationForChallenge(details) {

      try {
        if (currentRuntimeState() !== STATES.READY ||
            !details || details.isProxy !== true ||
            !isRequestId(details.requestId)) {
          return null;
        }
        const context = requestAuthContexts.get(details.requestId);
        const selected = context && context.selected;
        const challenger = details.challenger;
        const key = endpointKey(
            challenger && challenger.host,
            challenger && challenger.port,
        );
        if (!selected || !Array.isArray(context.candidates) ||
            !context.candidates.includes(selected) ||
            !validAuthRef(selected.authRef) || selected.authRef === null ||
            typeof selected.endpointKey !== 'string' ||
            key !== selected.endpointKey) {
          return null;
        }
        return Object.freeze({
          authRef: selected.authRef,
          endpointKey: selected.endpointKey,
        });
      } catch (_error) {
        resetEphemeralState();
        return null;
      }

    }

    function authorizeAuthenticationRetry(details, expectedAuthRef) {

      try {
        const authentication = authenticationForChallenge(details);
        if (!authentication || authentication.authRef !== expectedAuthRef) {
          return false;
        }
        const current = authorizations.get(details.requestId);
        const remaining = current === undefined ? 0 : current;
        if (!Number.isSafeInteger(remaining) || remaining < 0 ||
            remaining >= MAX_CALLBACK_BUDGET) {
          resetEphemeralState();
          return false;
        }
        authorizations.set(details.requestId, remaining + 1);
        return true;
      } catch (_error) {
        resetEphemeralState();
        return false;
      }

    }

    function onRequestTerminal(details) {

      clearAuthorization(details && details.requestId);

    }

    function authorizationCount() {

      try {
        return authorizations.size;
      } catch (_error) {
        resetEphemeralState();
        return 0;
      }

    }

    function authContextCount() {

      try {
        return requestAuthContexts.size;
      } catch (_error) {
        resetEphemeralState();
        return 0;
      }

    }

    const api = {
      authenticationForChallenge,
      authorizeAuthenticationRetry,
      authorizationCount,
      authContextCount,
      clearAllAuthorizations,
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
    validAuthRef,
  });

});
