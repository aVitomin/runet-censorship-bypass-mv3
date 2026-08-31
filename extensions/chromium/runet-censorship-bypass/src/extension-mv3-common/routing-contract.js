'use strict';

(function publishRoutingContract(root, factory) {

  const routingContract = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = routingContract;
    return;
  }
  root.mv3RoutingContract = routingContract;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const KINDS = Object.freeze({
    DIRECT: 'DIRECT',
    PROXY: 'PROXY',
    FAIL_CLOSED: 'FAIL_CLOSED',
  });
  const FALLBACKS = Object.freeze({
    DIRECT: 'DIRECT',
    FAIL_CLOSED: 'FAIL_CLOSED',
  });
  const SOURCES = Object.freeze({
    EXPLICIT_DIRECT: 'EXPLICIT_DIRECT',
    EXPLICIT_PROXY: 'EXPLICIT_PROXY',
    WHITELIST_MISS: 'WHITELIST_MISS',
    ONION: 'ONION',
    PROVIDER_DEFAULT: 'PROVIDER_DEFAULT',
    ROUTING_INPUT: 'ROUTING_INPUT',
  });
  const CANDIDATE_TYPES = Object.freeze([
    'HTTP',
    'HTTPS',
    'SOCKS4',
    'SOCKS5',
  ]);
  const CANDIDATE_GROUP_ORDER = Object.freeze([
    'own',
    'localTor',
    'torBrowser',
    'warp',
  ]);
  const FORBIDDEN_CREDENTIAL_KEYS = Object.freeze([
    'credentials',
    'password',
    'username',
  ]);

  function contractError(code, message) {

    const error = new TypeError(message);
    error.code = code;
    return error;

  }

  function fail(source, code) {

    return {
      kind: KINDS.FAIL_CLOSED,
      source,
      code,
    };

  }

  function normalizeHost(value) {

    let host = String(value || '').trim().toLowerCase();
    while (host.endsWith('.')) {
      host = host.slice(0, -1);
    }
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    if (!host) {
      throw contractError('INVALID_HOSTNAME', 'A hostname is required.');
    }
    return host;

  }

  function normalizePattern(value) {

    let pattern = String(value || '').trim().toLowerCase();
    while (pattern.endsWith('.')) {
      pattern = pattern.slice(0, -1);
    }
    if (pattern.startsWith('[') && pattern.endsWith(']')) {
      pattern = pattern.slice(1, -1);
    }
    return pattern;

  }

  function hostMatchesPattern(host, patternValue) {

    const pattern = normalizePattern(patternValue);
    if (!pattern) {
      return false;
    }
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(2);
      return Boolean(suffix) &&
        (host === suffix || host.endsWith(`.${suffix}`));
    }
    if (pattern.startsWith('*')) {
      const suffix = normalizePattern(pattern.slice(1));
      return Boolean(suffix) && host.endsWith(suffix);
    }
    return host === pattern;

  }

  function enabledPatternMatches(host, entries) {

    if (!Array.isArray(entries)) {
      return false;
    }
    return entries.some((entry) => {
      if (typeof entry === 'string') {
        return hostMatchesPattern(host, entry);
      }
      return Boolean(
          entry &&
          entry.enabled !== false &&
          hostMatchesPattern(host, entry.pattern),
      );
    });

  }

  function normalizeCandidate(candidate) {

    if (!candidate || typeof candidate !== 'object' ||
        Array.isArray(candidate)) {
      throw contractError(
          'INVALID_PROXY_CANDIDATE',
          'A proxy candidate must be an object.',
      );
    }
    if (FORBIDDEN_CREDENTIAL_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(candidate, key))) {
      throw contractError(
          'CREDENTIAL_VALUE_FORBIDDEN',
          'Credential values are not routing-decision fields.',
      );
    }
    const id = String(candidate.id || '').trim();
    const type = String(candidate.type || '').trim().toUpperCase();
    const host = String(candidate.host || '').trim().toLowerCase();
    const port = Number(candidate.port);
    if (!id) {
      throw contractError('INVALID_CANDIDATE_ID', 'Candidate id is required.');
    }
    if (!CANDIDATE_TYPES.includes(type)) {
      throw contractError(
          'INVALID_CANDIDATE_TYPE',
          'Candidate type is not supported.',
      );
    }
    if (!host) {
      throw contractError(
          'INVALID_CANDIDATE_HOST',
          'Candidate host is required.',
      );
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw contractError(
          'INVALID_CANDIDATE_PORT',
          'Candidate port is invalid.',
      );
    }
    let authRef = null;
    if (candidate.authRef !== undefined && candidate.authRef !== null) {
      authRef = String(candidate.authRef).trim();
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(authRef)) {
        throw contractError(
            'INVALID_AUTH_REF',
            'authRef must be an opaque identifier.',
        );
      }
    }
    let failoverTimeoutSeconds = null;
    if (candidate.failoverTimeoutSeconds !== undefined &&
        candidate.failoverTimeoutSeconds !== null) {
      failoverTimeoutSeconds = Number(candidate.failoverTimeoutSeconds);
      if (!Number.isInteger(failoverTimeoutSeconds) ||
          failoverTimeoutSeconds < 1) {
        throw contractError(
            'INVALID_FAILOVER_TIMEOUT',
            'Failover timeout must be a positive integer.',
        );
      }
    }
    return {
      id,
      type,
      host,
      port,
      proxyDNS: candidate.proxyDNS === true,
      authRef,
      failoverTimeoutSeconds,
    };

  }

  function orderCandidateGroups(groups) {

    const source = groups && typeof groups === 'object' ? groups : {};
    const ordered = [];
    CANDIDATE_GROUP_ORDER.forEach((groupName) => {
      const candidates = source[groupName] || [];
      if (!Array.isArray(candidates)) {
        throw contractError(
            'INVALID_CANDIDATE_GROUP',
            `Candidate group ${groupName} must be an array.`,
        );
      }
      candidates.forEach((candidate) => {
        ordered.push(normalizeCandidate(candidate));
      });
    });
    return ordered;

  }

  function normalizeProviderSource(value) {

    const source = String(value || SOURCES.PROVIDER_DEFAULT).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(source)) {
      throw contractError(
          'INVALID_PROVIDER_SOURCE',
          'Provider source must be a stable identifier.',
      );
    }
    return source;

  }

  function normalizeProvider(provider) {

    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw contractError(
          'MISSING_PROVIDER_RESULT',
          'Provider/default routing requires an explicit result.',
      );
    }
    const source = provider;
    const kind = String(source.kind || '').toUpperCase();
    const providerSource = normalizeProviderSource(source.source);
    if (kind === KINDS.FAIL_CLOSED) {
      return {
        kind,
        source: providerSource,
        code: String(source.code || 'PROVIDER_FAILURE'),
      };
    }
    if (kind === KINDS.DIRECT || kind === 'EMPTY') {
      if (Array.isArray(source.candidates) && source.candidates.length) {
        throw contractError(
            'INVALID_PROVIDER_RESULT',
            'A Direct or empty provider result cannot contain candidates.',
        );
      }
      return {
        kind,
        source: providerSource,
        candidates: [],
        fallback: FALLBACKS.DIRECT,
      };
    }
    if (kind !== KINDS.PROXY) {
      throw contractError(
          'INVALID_PROVIDER_RESULT',
          'Provider result kind is not supported.',
      );
    }
    if (!Array.isArray(source.candidates) || !source.candidates.length) {
      throw contractError(
          'INVALID_PROVIDER_RESULT',
          'A Proxy provider result requires candidates.',
      );
    }
    const candidates = source.candidates.map(normalizeCandidate);
    const fallback = source.fallback;
    if (!Object.values(FALLBACKS).includes(fallback)) {
      throw contractError(
          'INVALID_PROVIDER_FALLBACK',
          'Provider fallback is not supported.',
      );
    }
    return {
      kind,
      source: providerSource,
      candidates,
      fallback,
    };

  }

  function decideRouteUnchecked(input) {

    const source = input && typeof input === 'object' ? input : {};
    const host = normalizeHost(source.hostname);
    const rules = source.rules && typeof source.rules === 'object' ?
      source.rules :
      {};
    const candidateGroups = source.candidateGroups &&
      typeof source.candidateGroups === 'object' ?
      source.candidateGroups :
      {};
    const flags = source.flags && typeof source.flags === 'object' ?
      source.flags :
      {};

    if (enabledPatternMatches(host, rules.direct)) {
      return {kind: KINDS.DIRECT, source: SOURCES.EXPLICIT_DIRECT};
    }
    if (enabledPatternMatches(host, rules.proxy)) {
      const candidates = orderCandidateGroups(candidateGroups.configured);
      if (!candidates.length) {
        return fail(SOURCES.EXPLICIT_PROXY, 'PROXY_RULE_NO_CANDIDATE');
      }
      return {
        kind: KINDS.PROXY,
        source: SOURCES.EXPLICIT_PROXY,
        candidates,
        fallback: FALLBACKS.FAIL_CLOSED,
      };
    }
    if (Array.isArray(rules.whitelist) && rules.whitelist.length &&
        !enabledPatternMatches(host, rules.whitelist)) {
      return {kind: KINDS.DIRECT, source: SOURCES.WHITELIST_MISS};
    }
    if (host.endsWith('.onion')) {
      const candidates = orderCandidateGroups(candidateGroups.onion);
      if (candidates.length) {
        return {
          kind: KINDS.PROXY,
          source: SOURCES.ONION,
          candidates,
          fallback: FALLBACKS.FAIL_CLOSED,
        };
      }
    }

    const provider = normalizeProvider(source.provider);
    if (provider.kind === KINDS.FAIL_CLOSED) {
      return fail(provider.source, provider.code);
    }
    const ownProxiesOnlyForOwnSites =
      flags.ownProxiesOnlyForOwnSites !== false;
    const useProviderProxies = flags.useProviderProxies !== false;
    let candidates = ownProxiesOnlyForOwnSites ?
      [] :
      orderCandidateGroups(candidateGroups.configured);
    let fallback = FALLBACKS.DIRECT;
    if (useProviderProxies && provider.kind === KINDS.PROXY) {
      candidates = candidates.concat(provider.candidates);
      fallback = provider.fallback;
    }
    if (fallback === FALLBACKS.DIRECT &&
        flags.replaceDirectWithProxy === true) {
      const replacements = orderCandidateGroups(
          candidateGroups.directReplacement,
      );
      if (replacements.length) {
        candidates = candidates.concat(replacements);
        fallback = FALLBACKS.FAIL_CLOSED;
      }
    }
    if (fallback === FALLBACKS.DIRECT && flags.noDirect === true) {
      fallback = FALLBACKS.FAIL_CLOSED;
    }
    if (candidates.length) {
      return {
        kind: KINDS.PROXY,
        source: provider.source,
        candidates,
        fallback,
      };
    }
    if (fallback === FALLBACKS.DIRECT) {
      return {kind: KINDS.DIRECT, source: provider.source};
    }
    return fail(provider.source, 'NO_VALID_ROUTE');

  }

  function decideRoute(input) {

    try {
      return decideRouteUnchecked(input);
    } catch (error) {
      return fail(
          SOURCES.ROUTING_INPUT,
          error && error.code ? error.code : 'ROUTING_CONTRACT_FAILURE',
      );
    }

  }

  return Object.freeze({
    CANDIDATE_GROUP_ORDER,
    CANDIDATE_TYPES,
    FALLBACKS,
    KINDS,
    SOURCES,
    decideRoute,
  });

});
