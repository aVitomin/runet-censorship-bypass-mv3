'use strict';

/* global mv3Hash, mv3PacMods */

(function(exports) {

  // IndexedDB artifact storage supports provider PACs larger than storage.local.
  const MAX_PAC_BYTES = 16 * 1024 * 1024;
  const PAC_COOK_SEMANTICS_VERSION = 2;
  const COOK_START = '\n\n//%#@@@@@@ MV3_PAC_COOK_START @@@@@@#%';
  const COOK_END = '//%#@@@@@@ MV3_PAC_COOK_END @@@@@@#%';

  function createError(code, message, details) {

    return {
      code,
      message,
      details: details === undefined ? null : details,
    };

  }

  function createFailure(providerKey, sourceRawPacSha256, error, warnings = []) {

    return {
      ok: false,
      status: 'error',
      providerKey,
      sourceRawPacSha256,
      error,
      warnings,
    };

  }

  function stableStringify(value) {

    if (Array.isArray(value)) {
      return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${stableStringify(value[key])}`,
      ).join(',')}}`;
    }
    return JSON.stringify(value);

  }

  async function hashPacMods(pacMods) {

    // Include wrapper semantics so safety fixes invalidate older cooked PACs.
    return mv3Hash.sha256Hex(stableStringify({
      pacCookSemanticsVersion: PAC_COOK_SEMANTICS_VERSION,
      pacMods: normalizePacMods(pacMods),
    }));

  }

  function normalizePacMods(pacMods) {

    return mv3PacMods.normalizePacMods(pacMods);

  }

  function getEnabledProxyRules(mods) {

    return mods.exceptions
        .concat(mods.rules)
        .filter((rule) => rule.enabled && rule.action === 'PROXY');

  }

  function buildExplicitProxyResult(candidates) {

    const result = (Array.isArray(candidates) ? candidates : [])
        .reduce((parts, candidate) => parts.concat(
            String(candidate || '').split(/\s*;\s*/g),
        ), [])
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate && !/^DIRECT$/i.test(candidate))
        .join('; ');
    return result || null;

  }

  function getExplicitProxyConfigurationError(mods) {

    if (
      getEnabledProxyRules(mods).length &&
      !buildExplicitProxyResult(mv3PacMods.getProxyRuleCandidates(mods))
    ) {
      return createError(
          'PROXY_RULE_NO_CANDIDATE',
          'No proxy is enabled. Enable Tor, WARP, or an own proxy.',
      );
    }
    return null;

  }

  function stripPreviousCook(rawPacData) {

    const markerIndex = rawPacData.indexOf(COOK_START);
    return markerIndex === -1 ? rawPacData : rawPacData.slice(0, markerIndex);

  }

  function validatePacText(text, ifCooked) {

    if (typeof text !== 'string' || !text.trim()) {
      return createError(
          ifCooked ? 'PAC_INVALID_COOKED' : 'PAC_INVALID_RAW',
          ifCooked ? 'Cooked PAC is empty.' : 'Raw PAC is empty.',
      );
    }
    if (mv3Hash.getUtf8Length(text) > MAX_PAC_BYTES) {
      return createError(
          ifCooked ? 'PAC_INVALID_COOKED' : 'PAC_INVALID_RAW',
          ifCooked ? 'Cooked PAC is too large.' : 'Raw PAC is too large.',
          {maxPacBytes: MAX_PAC_BYTES},
      );
    }
    if (!/FindProxyForURL/i.test(text)) {
      return createError(
          ifCooked ? 'PAC_INVALID_COOKED' : 'PAC_INVALID_RAW',
          'PAC text does not contain FindProxyForURL.',
      );
    }
    return null;

  }

  function getProxyListForDirectReplacement(mods) {

    return mv3PacMods.getDirectReplacementCandidates(mods);

  }

  function getWarnings(mods) {

    const warnings = [];
    const proxyCandidates = mv3PacMods.getProxyRuleCandidates(mods);
    const proxyRules = getEnabledProxyRules(mods);
    if (proxyRules.length && !buildExplicitProxyResult(proxyCandidates)) {
      warnings.push('PROXY rules are configured but no proxy candidates are enabled.');
    }
    if (mods.ownProxies.some((proxy) => proxy.password)) {
      warnings.push(
          'own proxy credentials are removed from cooked PAC and handled by MV3 proxy auth.',
      );
    }
    if (mods.localTor.enabled || mods.torBrowser.enabled) {
      warnings.push(
          'Tor settings generate PAC proxy strings only; Tor itself must be running locally.',
      );
    }
    if (mods.warp.enabled) {
      warnings.push(
          'WARP is treated as a user-managed local proxy candidate.',
      );
    }
    if (mods.replaceDirectWithProxy && !getProxyListForDirectReplacement(mods).length) {
      warnings.push(
          'replaceDirectWithProxy is enabled but no proxy candidates are configured.',
      );
    }
    if (mods.usePacScriptProxies === false && !proxyCandidates.length) {
      warnings.push(
          'PAC provider proxies are disabled and no own proxy candidates are enabled.',
      );
    }
    return warnings;

  }

  function buildWrapper(mods) {

    const directReplacementList = getProxyListForDirectReplacement(mods);
    const onionProxyList = mv3PacMods.getOnionProxyCandidates(mods);
    const proxyRuleList = mv3PacMods.getProxyRuleCandidates(mods);
    const directRules = mods.exceptions
        .concat(mods.rules)
        .filter((rule) => rule.enabled && rule.action === 'DIRECT');
    const proxyRules = getEnabledProxyRules(mods);
    const directReplacement = mods.replaceDirectWithProxy && directReplacementList.length ?
      directReplacementList.join('; ') :
      null;
    const proxyRuleResult = buildExplicitProxyResult(proxyRuleList);
    const broadOwnProxyResult =
      !mods.ownProxiesOnlyForOwnSites && proxyRuleList.length ?
        proxyRuleList.join('; ') :
        null;

    return `${COOK_START}
;(function(global) {
  "use strict";

  const mv3OriginalFindProxyForURL = FindProxyForURL;
  const mv3Whitelist = ${JSON.stringify(mods.whitelist)};
  const mv3DirectRules = ${JSON.stringify(directRules)};
  const mv3ProxyRules = ${JSON.stringify(proxyRules)};
  const mv3OnionProxies = ${JSON.stringify(onionProxyList.join('; '))};
  const mv3ProxyRuleResult = ${JSON.stringify(proxyRuleResult)};
  const mv3BroadOwnProxyResult = ${JSON.stringify(broadOwnProxyResult)};
  const mv3DirectReplacement = ${JSON.stringify(directReplacement)};
  const mv3NoDirect = ${JSON.stringify(mods.noDirect)};
  const mv3UsePacScriptProxies = ${JSON.stringify(mods.usePacScriptProxies)};

  function mv3HostMatches(host, pattern) {
    const normalizedHost = String(host || "").toLowerCase();
    const normalizedPattern = String(pattern || "").toLowerCase();
    if (!normalizedPattern) {
      return false;
    }
    if (normalizedPattern.startsWith("*.")) {
      const baseDomain = normalizedPattern.slice(2);
      return normalizedHost === baseDomain || normalizedHost.endsWith("." + baseDomain);
    }
    if (normalizedPattern.startsWith("*")) {
      return normalizedHost.endsWith(normalizedPattern.slice(1));
    }
    return normalizedHost === normalizedPattern;
  }

  function mv3AnyHostMatches(host, patterns) {
    return patterns.some((entry) => {
      const pattern = typeof entry === "string" ? entry : entry.pattern;
      return entry && entry.enabled !== false && mv3HostMatches(host, pattern);
    });
  }

  function mv3RemoveDirect(result) {
    return String(result)
      .split(/\\s*;\\s*/g)
      .filter((proxy) => proxy && !/^DIRECT$/i.test(proxy))
      .join("; ");
  }

  function mv3ApplyDirectPolicy(result) {
    let value = String(result || "");
    if (mv3DirectReplacement) {
      value = value.replace(/(^|;)\\s*DIRECT\\s*(?=;|$)/g, "$1" + mv3DirectReplacement);
    }
    if (mv3NoDirect) {
      value = mv3RemoveDirect(value);
    }
    return value || (mv3NoDirect ? "" : "DIRECT");
  }

  function mv3ApplyProviderPolicy(result) {
    const parts = [];
    if (mv3BroadOwnProxyResult) {
      parts.push(mv3BroadOwnProxyResult);
    }
    if (mv3UsePacScriptProxies) {
      parts.push(String(result || ""));
    }
    if (!mv3NoDirect) {
      parts.push("DIRECT");
    }
    return mv3ApplyDirectPolicy(parts.filter(Boolean).join("; "));
  }

  function mv3FindProxyForURL(url, host) {
    if (mv3DirectRules.length && mv3AnyHostMatches(host, mv3DirectRules)) {
      return "DIRECT";
    }
    if (mv3ProxyRules.length && mv3AnyHostMatches(host, mv3ProxyRules)) {
      return mv3ProxyRuleResult;
    }
    if (mv3Whitelist.length && !mv3AnyHostMatches(host, mv3Whitelist)) {
      return "DIRECT";
    }
    if (mv3OnionProxies && String(host || "").toLowerCase().endsWith(".onion")) {
      return mv3OnionProxies;
    }
    return mv3ApplyProviderPolicy(mv3OriginalFindProxyForURL(url, host));
  }

  if (global) {
    global.FindProxyForURL = mv3FindProxyForURL;
  } else {
    FindProxyForURL = mv3FindProxyForURL;
  }
})(this);
${COOK_END}`;

  }

  async function cookPac({rawPacData, pacMods, provider, sourceRawPacSha256}) {

    const providerKey = provider && provider.key || null;
    if (!provider) {
      return createFailure(
          providerKey,
          sourceRawPacSha256,
          createError('PROVIDER_NOT_FOUND', 'PAC provider was not found.'),
      );
    }

    const rawError = validatePacText(rawPacData, false);
    if (rawError) {
      return createFailure(providerKey, sourceRawPacSha256, rawError);
    }

    const normalizedMods = normalizePacMods(pacMods);
    const warnings = getWarnings(normalizedMods);
    const explicitProxyError = getExplicitProxyConfigurationError(normalizedMods);
    if (explicitProxyError) {
      return createFailure(
          providerKey,
          sourceRawPacSha256,
          explicitProxyError,
          warnings,
      );
    }
    const basePac = stripPreviousCook(rawPacData);
    const cookedPacData = `${basePac}${buildWrapper(normalizedMods)}`;
    const cookedError = validatePacText(cookedPacData, true);
    if (cookedError) {
      return createFailure(providerKey, sourceRawPacSha256, cookedError, warnings);
    }

    const cookedPacSha256 = await mv3Hash.sha256Hex(cookedPacData);
    return {
      ok: true,
      status: 'success',
      providerKey,
      cookedPacData,
      cookedPacSha256,
      cookedContentLength: mv3Hash.getUtf8Length(cookedPacData),
      sourceRawPacSha256,
      pacModsSha256: await hashPacMods(normalizedMods),
      warnings,
    };

  }

  function selfTest() {

    const validPac = 'function FindProxyForURL(url, host) { return "DIRECT"; }';
    const samplePassword = ['sec', 'ret'].join('');
    const torBrowserProxyWrapper = buildWrapper(normalizePacMods({
      torBrowser: {enabled: true},
      exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
    }));
    const torServiceProxyWrapper = buildWrapper(normalizePacMods({
      localTor: {enabled: true},
      exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
    }));
    const multipleProxyWrapper = buildWrapper(normalizePacMods({
      torBrowser: {enabled: true},
      ownProxies: ['HTTPS proxy.example:443'],
      exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
    }));
    const explicitBranch =
      'if (mv3ProxyRules.length && mv3AnyHostMatches(host, mv3ProxyRules)) {';
    return {
      emptyFails: Boolean(validatePacText('', false)),
      missingFindProxyFails: Boolean(validatePacText('return "DIRECT";', false)),
      validPasses: !validatePacText(validPac, false),
      wrapperContainsFindProxy: buildWrapper(normalizePacMods({}))
          .includes('FindProxyForURL'),
      unsupportedWarnings: getWarnings(normalizePacMods({
        exceptions: [{pattern: 'proxy.example', action: 'PROXY', enabled: true}],
      })).length > 0,
      localTorDaemonPreset:
        buildWrapper(normalizePacMods({
          localTor: {enabled: true, type: 'SOCKS5', host: '127.0.0.1', port: 9050},
        })).includes('SOCKS5 127.0.0.1:9050'),
      torBrowserPreset:
        buildWrapper(normalizePacMods({
          torBrowser: {enabled: true, type: 'SOCKS5', host: '127.0.0.1', port: 9150},
        })).includes('SOCKS5 127.0.0.1:9150'),
      onionRoutesToTor:
        buildWrapper(normalizePacMods({
          localTor: {enabled: true, useForOnion: true},
        })).includes('endsWith(".onion")'),
      torEnabledDoesNotProxyProviderDirectByDefault:
        buildWrapper(normalizePacMods({
          localTor: {enabled: true},
        })).includes('const mv3BroadOwnProxyResult = null;'),
      torProxyRuleUsesTorCandidate:
        torServiceProxyWrapper.includes(
            'const mv3ProxyRuleResult = "SOCKS5 127.0.0.1:9050";',
        ),
      torBrowserProxyRuleFailsClosed:
        torBrowserProxyWrapper.includes(
            'const mv3ProxyRuleResult = "SOCKS5 127.0.0.1:9150";',
        ) && !torBrowserProxyWrapper.includes(
            'const mv3ProxyRuleResult = "SOCKS5 127.0.0.1:9150; DIRECT";',
        ),
      torServiceProxyRuleFailsClosed:
        torServiceProxyWrapper.includes(
            'const mv3ProxyRuleResult = "SOCKS5 127.0.0.1:9050";',
        ) && !torServiceProxyWrapper.includes(
            'const mv3ProxyRuleResult = "SOCKS5 127.0.0.1:9050; DIRECT";',
        ),
      multipleExplicitCandidatesHaveNoDirect:
        multipleProxyWrapper.includes(
            'const mv3ProxyRuleResult = "HTTPS proxy.example:443; ' +
            'SOCKS5 127.0.0.1:9150";',
        ) && !/mv3ProxyRuleResult = [^\n]*DIRECT/.test(multipleProxyWrapper),
      explicitProxyRulePrecedesWhitelistAndProvider:
        torBrowserProxyWrapper.indexOf(explicitBranch) <
          torBrowserProxyWrapper.indexOf('if (mv3Whitelist.length') &&
        torBrowserProxyWrapper.indexOf(explicitBranch) <
          torBrowserProxyWrapper.indexOf('mv3OriginalFindProxyForURL(url, host)'),
      explicitProxyRuleHasNoProviderFallback:
        torBrowserProxyWrapper.includes(
            `${explicitBranch}\n      return mv3ProxyRuleResult;\n    }`,
        ),
      explicitProxyResultFiltersDirectCandidate:
        buildExplicitProxyResult([
          'SOCKS5 127.0.0.1:9150; DIRECT',
          'HTTPS proxy.example:443',
        ]) ===
          'SOCKS5 127.0.0.1:9150; HTTPS proxy.example:443',
      explicitProxyWithoutCandidateIsRejected:
        getExplicitProxyConfigurationError(normalizePacMods({
          exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
        })).code === 'PROXY_RULE_NO_CANDIDATE',
      cookHashIncludesSafetySemanticsVersion:
        stableStringify({
          pacCookSemanticsVersion: PAC_COOK_SEMANTICS_VERSION,
          pacMods: normalizePacMods({}),
        }).includes('"pacCookSemanticsVersion":2'),
      directRuleReturnsDirect:
        buildWrapper(normalizePacMods({
          localTor: {enabled: true},
          exceptions: [{pattern: 'direct.example', action: 'DIRECT'}],
        })).includes('return "DIRECT";'),
      credentialsStrippedFromProxy:
        buildWrapper(normalizePacMods({
          ownProxies: [`HTTPS user:${samplePassword}@example.com:443`],
          replaceDirectWithProxy: true,
        })).includes('HTTPS example.com:443') &&
        !buildWrapper(normalizePacMods({
          ownProxies: [`HTTPS user:${samplePassword}@example.com:443`],
          replaceDirectWithProxy: true,
        })).includes(`${samplePassword}@`),
      unsupportedProxyRulesWarn:
        getWarnings(normalizePacMods({
          exceptions: [{pattern: 'proxy.example', action: 'PROXY', enabled: true}],
        })).some((warning) => warning.includes('no proxy candidates')),
      usePacScriptProxiesCanDisableProviderProxyOutput:
        buildWrapper(normalizePacMods({
          usePacScriptProxies: false,
        })).includes('const mv3UsePacScriptProxies = false;'),
      ownProxiesOnlyForOwnSitesPreventsBroadOwnProxyUse:
        buildWrapper(normalizePacMods({
          ownProxies: ['HTTPS proxy.example:443'],
        })).includes('const mv3BroadOwnProxyResult = null;'),
      ownProxiesBroadWhenOwnSitesOnlyIsDisabled:
        buildWrapper(normalizePacMods({
          ownProxiesOnlyForOwnSites: false,
          ownProxies: ['HTTPS proxy.example:443'],
        })).includes('const mv3BroadOwnProxyResult = "HTTPS proxy.example:443";'),
      userProxyRulesStillUseOwnProxyWithOwnSitesOnly:
        buildWrapper(normalizePacMods({
          ownProxiesOnlyForOwnSites: true,
          ownProxies: ['HTTPS proxy.example:443'],
          exceptions: [{pattern: 'site.example', action: 'PROXY'}],
        })).includes('const mv3ProxyRuleResult = "HTTPS proxy.example:443";'),
      wildcardRulesMatchBaseDomain:
        buildWrapper(normalizePacMods({}))
            .includes('normalizedHost === baseDomain'),
    };

  }

  exports.mv3PacCook = Object.freeze({
    MAX_PAC_BYTES,
    PAC_COOK_SEMANTICS_VERSION,
    buildExplicitProxyResult,
    cookPac,
    hashPacMods,
    selfTest,
  });

})(self);
