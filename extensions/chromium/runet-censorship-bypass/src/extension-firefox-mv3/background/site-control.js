'use strict';
/* global require */

(function publishFirefoxSiteControl(root, factory) {

  const tldtsApi = typeof module === 'object' && module.exports ?
    require('tldts') : root.tldts;
  const api = factory(tldtsApi);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxSiteControl = api;

})(typeof globalThis === 'object' ? globalThis : this, function(Tldts) {

  const SCHEMA_VERSION = 1;
  const MODES = Object.freeze(['AUTO', 'PROXY', 'DIRECT']);
  const SCOPES = Object.freeze(['HOST', 'DOMAIN']);
  const DOMAIN_OPTIONS = Object.freeze({
    allowPrivateDomains: true,
    extractHostname: false,
  });
  const ERRORS = Object.freeze({
    INVALID_SITE_CONTROL_DEPENDENCIES: 'INVALID_SITE_CONTROL_DEPENDENCIES',
    SITE_PAGE_NOT_CONTROLLABLE: 'SITE_PAGE_NOT_CONTROLLABLE',
    SITE_PROXY_CANDIDATE_UNAVAILABLE: 'SITE_PROXY_CANDIDATE_UNAVAILABLE',
    SITE_REQUEST_MALFORMED: 'SITE_REQUEST_MALFORMED',
  });

  function siteError(code) {

    const error = new TypeError(code);
    error.code = code;
    return error;

  }

  function clone(value) {

    return JSON.parse(JSON.stringify(value));

  }

  function normalizeHost(value) {

    let host = String(value || '').trim().toLowerCase();
    while (host.endsWith('.')) {
      host = host.slice(0, -1);
    }
    if (host.startsWith('[') && host.endsWith(']')) {
      host = host.slice(1, -1);
    }
    return host;

  }

  function normalizePattern(value) {

    const pattern = String(value || '').trim().toLowerCase();
    if (pattern.startsWith('*.')) {
      return `*.${normalizeHost(pattern.slice(2))}`;
    }
    return normalizeHost(pattern);

  }

  function targetFromUrl(value) {

    if (typeof value !== 'string' || value.length > 8192) {
      return Object.freeze({
        controllable: false,
        host: '',
        reasonCode: 'UNSUPPORTED_PAGE',
      });
    }
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) ||
          !parsed.hostname || parsed.username || parsed.password) {
        throw new TypeError('UNSUPPORTED_PAGE');
      }
      return Object.freeze({
        controllable: true,
        host: normalizeHost(parsed.hostname),
        reasonCode: null,
      });
    } catch (_error) {
      return Object.freeze({
        controllable: false,
        host: '',
        reasonCode: 'UNSUPPORTED_PAGE',
      });
    }

  }

  function patternsForHost(host) {

    const exact = normalizeHost(host);
    const domain = exact && Tldts && typeof Tldts.getDomain === 'function' ?
      Tldts.getDomain(exact, DOMAIN_OPTIONS) || '' : '';
    const wildcard = domain ? `*.${domain}` : exact;
    return Object.freeze({
      exact,
      wildcard,
      wildcardAvailable: Boolean(domain),
    });

  }

  function includesPattern(entries, pattern) {

    return Array.isArray(entries) && entries.some((entry) =>
      normalizePattern(entry) === pattern);

  }

  function routeForSettings(settings, patterns) {

    const rules = settings && settings.rules || {};
    if (includesPattern(rules.direct, patterns.exact)) {
      return {mode: 'DIRECT', scope: 'HOST', pattern: patterns.exact};
    }
    if (patterns.wildcardAvailable &&
        includesPattern(rules.direct, patterns.wildcard)) {
      return {mode: 'DIRECT', scope: 'DOMAIN', pattern: patterns.wildcard};
    }
    if (includesPattern(rules.proxy, patterns.exact)) {
      return {mode: 'PROXY', scope: 'HOST', pattern: patterns.exact};
    }
    if (patterns.wildcardAvailable &&
        includesPattern(rules.proxy, patterns.wildcard)) {
      return {mode: 'PROXY', scope: 'DOMAIN', pattern: patterns.wildcard};
    }
    return {
      mode: 'AUTO',
      scope: patterns.wildcardAvailable ? 'DOMAIN' : 'HOST',
      pattern: patterns.wildcardAvailable ?
        patterns.wildcard : patterns.exact,
    };

  }

  function proxyCandidateCount(settings) {

    let count = Array.isArray(settings.ownProxies) ?
      settings.ownProxies.filter((candidate) => candidate.enabled === true)
          .length : 0;
    if (settings.localTor && settings.localTor.useForProxyRules === true) {
      count += 1;
    }
    if (settings.torBrowser && settings.torBrowser.useForProxyRules === true) {
      count += 1;
    }
    if (settings.warp && settings.warp.useForProxyRules === true &&
        Array.isArray(settings.warp.candidates)) {
      count += settings.warp.candidates.length;
    }
    return count;

  }

  function publicState(target, current) {

    const patterns = patternsForHost(target.host);
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      revision: current.revision,
      target,
      route: Object.freeze(routeForSettings(current.settings, patterns)),
      patterns,
      proxyCandidateAvailable: proxyCandidateCount(current.settings) > 0,
    });

  }

  function withoutManagedPatterns(entries, patterns) {

    const managed = new Set([patterns.exact, patterns.wildcard]);
    return entries.filter((entry) => !managed.has(normalizePattern(entry)));

  }

  function applyRoute(settings, patterns, mode, scope) {

    const next = clone(settings);
    next.rules.direct = withoutManagedPatterns(next.rules.direct, patterns);
    next.rules.proxy = withoutManagedPatterns(next.rules.proxy, patterns);
    if (mode !== 'AUTO') {
      const pattern = scope === 'DOMAIN' && patterns.wildcardAvailable ?
        patterns.wildcard : patterns.exact;
      next.rules[mode === 'PROXY' ? 'proxy' : 'direct'].push(pattern);
    }
    return next;

  }

  function createController(options = {}) {

    const settingsController = options.settingsController;
    if (!settingsController || typeof settingsController.get !== 'function' ||
        typeof settingsController.replace !== 'function' ||
        !Tldts || typeof Tldts.getDomain !== 'function') {
      throw siteError(ERRORS.INVALID_SITE_CONTROL_DEPENDENCIES);
    }
    let queue = Promise.resolve();

    function enqueue(operation) {

      const result = queue.then(operation, operation);
      queue = result.catch(() => undefined);
      return result;

    }

    async function getUnchecked(tabUrl) {

      const target = targetFromUrl(tabUrl);
      const current = await settingsController.get();
      if (!target.controllable) {
        return Object.freeze({
          schemaVersion: SCHEMA_VERSION,
          revision: current.revision,
          target,
          route: null,
          patterns: null,
          proxyCandidateAvailable: proxyCandidateCount(current.settings) > 0,
        });
      }
      return publicState(target, current);

    }

    async function replaceUnchecked(request) {

      if (!request || typeof request !== 'object' ||
          !Number.isSafeInteger(request.expectedRevision) ||
          request.expectedRevision < 0 || !MODES.includes(request.mode) ||
          !SCOPES.includes(request.scope)) {
        throw siteError(ERRORS.SITE_REQUEST_MALFORMED);
      }
      const target = targetFromUrl(request.tabUrl);
      if (!target.controllable) {
        throw siteError(ERRORS.SITE_PAGE_NOT_CONTROLLABLE);
      }
      const current = await settingsController.get();
      if (current.revision !== request.expectedRevision) {
        const error = new TypeError('SETTINGS_REVISION_CONFLICT');
        error.code = 'SETTINGS_REVISION_CONFLICT';
        throw error;
      }
      if (request.mode === 'PROXY' &&
          proxyCandidateCount(current.settings) === 0) {
        throw siteError(ERRORS.SITE_PROXY_CANDIDATE_UNAVAILABLE);
      }
      const patterns = patternsForHost(target.host);
      const next = applyRoute(
          current.settings, patterns, request.mode, request.scope,
      );
      const replaced = await settingsController.replace(
          current.revision, next,
      );
      return publicState(target, replaced);

    }

    return Object.freeze({
      get: (tabUrl) => enqueue(() => getUnchecked(tabUrl)),
      replace: (request) => enqueue(() => replaceUnchecked(request)),
    });

  }

  return Object.freeze({
    ERRORS,
    MODES,
    SCHEMA_VERSION,
    SCOPES,
    applyRoute,
    createController,
    patternsForHost,
    proxyCandidateCount,
    routeForSettings,
    targetFromUrl,
  });

});
