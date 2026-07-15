'use strict';

/* global mv3PacMods, tldts */

(function(exports) {

  const DOMAIN_OPTIONS = Object.freeze({
    allowPrivateDomains: true,
    extractHostname: false,
  });

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

  function normalizeRulePattern(value) {

    const pattern = String(value || '').trim().toLowerCase();
    if (pattern.startsWith('*.')) {
      return `*.${normalizeHost(pattern.slice(2))}`;
    }
    return normalizeHost(pattern);

  }

  function getRegistrableDomain(host) {

    const normalizedHost = normalizeHost(host);
    if (!normalizedHost) {
      return '';
    }
    return tldts.getDomain(normalizedHost, DOMAIN_OPTIONS) || '';

  }

  function getLegacyWildcardPattern(host, wildcardPattern) {

    const labels = normalizeHost(host).split('.').filter(Boolean);
    if (labels.length < 2) {
      return '';
    }
    const legacyPattern = `*.${labels.slice(-2).join('.')}`;
    return legacyPattern === wildcardPattern ? '' : legacyPattern;

  }

  function getSitePatterns(host) {

    const exactPattern = normalizeHost(host);
    const registrableDomain = getRegistrableDomain(exactPattern);
    const wildcardPattern = registrableDomain ?
      `*.${registrableDomain}` :
      exactPattern;
    return {
      exactPattern,
      wildcardPattern,
      wildcardAvailable: Boolean(registrableDomain),
      registrableDomain,
      legacyWildcardPattern: getLegacyWildcardPattern(
          exactPattern,
          wildcardPattern,
      ),
      domainResolution: 'public-suffix-list',
    };

  }

  function findEnabledRuleByPattern(rules, pattern) {

    return rules.find((item) =>
      item &&
      item.enabled !== false &&
      normalizeRulePattern(item.pattern) === pattern,
    );

  }

  function getHostRuleState(pacMods, host) {

    const normalized = mv3PacMods.normalizePacMods(pacMods);
    const patterns = getSitePatterns(host);
    const exactPattern = patterns.exactPattern;
    const wildcardPattern = patterns.wildcardPattern;
    let rule = findEnabledRuleByPattern(
        normalized.exceptions,
        exactPattern,
    );
    let scope = 'host';
    let legacy = false;
    if (!rule && patterns.wildcardAvailable) {
      rule = findEnabledRuleByPattern(
          normalized.exceptions,
          wildcardPattern,
      );
      scope = 'domain';
    }
    if (!rule && patterns.legacyWildcardPattern) {
      rule = findEnabledRuleByPattern(
          normalized.exceptions,
          patterns.legacyWildcardPattern,
      );
      scope = patterns.wildcardAvailable ? 'domain' : 'host';
      legacy = Boolean(rule);
    }
    if (!rule) {
      return {
        mode: 'auto',
        scope: patterns.wildcardAvailable ? 'domain' : 'host',
        pattern: patterns.wildcardAvailable ? wildcardPattern : exactPattern,
        legacy: false,
      };
    }
    return {
      mode: rule.action === 'PROXY' ? 'proxy' : 'direct',
      scope,
      pattern: normalizeRulePattern(rule.pattern),
      legacy,
    };

  }

  function setHostMode(pacMods, host, mode, scope) {

    const normalized = mv3PacMods.normalizePacMods(pacMods);
    const patterns = getSitePatterns(host);
    const selectedPattern =
      scope === 'domain' && patterns.wildcardAvailable ?
        patterns.wildcardPattern :
        patterns.exactPattern;
    const managedPatterns = [
      patterns.exactPattern,
      patterns.wildcardPattern,
      patterns.legacyWildcardPattern,
    ].filter(Boolean);
    const rules = normalized.exceptions.filter((rule) =>
      !managedPatterns.includes(normalizeRulePattern(rule.pattern)),
    );
    if (mode !== 'auto') {
      rules.push({
        pattern: selectedPattern,
        action: mode === 'proxy' ? 'PROXY' : 'DIRECT',
        enabled: true,
        note: '',
      });
    }
    return Object.assign({}, normalized, {exceptions: rules});

  }

  function selfTest() {

    const coUk = getSitePatterns('a.b.example.co.uk');
    const github = getSitePatterns('user.github.io');
    const ipv4 = getSitePatterns('192.0.2.1');
    const ipv6 = getSitePatterns('[2001:db8::1]');
    return {
      standardDomainUsesRegistrableDomain:
        getSitePatterns('sub.example.com').wildcardPattern ===
          '*.example.com',
      multiLabelSuffixUsesRegistrableDomain:
        coUk.wildcardPattern === '*.example.co.uk',
      unsafeLegacyWildcardIsIdentified:
        coUk.legacyWildcardPattern === '*.co.uk',
      privateSuffixIsRespected:
        github.wildcardPattern === '*.user.github.io',
      localhostHasNoDomainScope:
        getSitePatterns('localhost').wildcardAvailable === false,
      ipv4HasNoDomainScope: ipv4.wildcardAvailable === false,
      ipv6HasNoDomainScope:
        ipv6.exactPattern === '2001:db8::1' &&
        ipv6.wildcardAvailable === false,
      trailingDotIsRemoved:
        getSitePatterns('Sub.Example.Com.').exactPattern ===
          'sub.example.com',
    };

  }

  exports.mv3SiteScope = Object.freeze({
    getHostRuleState,
    getRegistrableDomain,
    getSitePatterns,
    normalizeHost,
    normalizeRulePattern,
    selfTest,
    setHostMode,
  });

})(self);
