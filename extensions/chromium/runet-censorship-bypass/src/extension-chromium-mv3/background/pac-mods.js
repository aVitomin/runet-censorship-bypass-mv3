'use strict';

(function(exports) {

  const REDACTED_PASSWORD = '***';
  const PROXY_TYPES = Object.freeze(['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5']);
  const RULE_ACTIONS = Object.freeze(['DIRECT', 'PROXY']);

  const DEFAULT_LOCAL_TOR = Object.freeze({
    enabled: false,
    type: 'SOCKS5',
    host: '127.0.0.1',
    port: 9050,
    useForOnion: true,
    useAsDirectReplacement: false,
  });
  const DEFAULT_TOR_BROWSER = Object.freeze({
    enabled: false,
    type: 'SOCKS5',
    host: '127.0.0.1',
    port: 9150,
    useForOnion: true,
    useAsDirectReplacement: false,
  });
  const DEFAULT_WARP = Object.freeze({
    enabled: false,
    proxyString: 'SOCKS5 127.0.0.1:40000; HTTPS 127.0.0.1:40000',
    useAsDirectReplacement: false,
  });
  const DEFAULT_PAC_MODS = Object.freeze({
    usePacScriptProxies: true,
    ownProxiesOnlyForOwnSites: true,
    ownProxies: Object.freeze([]),
    localTor: DEFAULT_LOCAL_TOR,
    torBrowser: DEFAULT_TOR_BROWSER,
    warp: DEFAULT_WARP,
    whitelist: Object.freeze([]),
    exceptions: Object.freeze([]),
    rules: Object.freeze([]),
    replaceDirectWithProxy: false,
    noDirect: false,
  });

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function normalizeBoolean(value, defaultValue) {

    return typeof value === 'boolean' ? value : defaultValue;

  }

  function normalizePort(value, defaultValue = null) {

    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return defaultValue;
    }
    return parsed;

  }

  function normalizeProxyType(value, defaultValue = 'PROXY') {

    const normalized = String(value || '').trim().toUpperCase();
    return PROXY_TYPES.includes(normalized) ? normalized : defaultValue;

  }

  function normalizeHost(value, defaultValue = '') {

    return String(value || defaultValue).trim();

  }

  function parseHostPort(address) {

    const trimmed = String(address || '').trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('[')) {
      const endIndex = trimmed.indexOf(']');
      if (endIndex === -1 || trimmed[endIndex + 1] !== ':') {
        return null;
      }
      const host = trimmed.slice(1, endIndex);
      const port = normalizePort(trimmed.slice(endIndex + 2));
      return host && port ? {host, port} : null;
    }
    const colonIndex = trimmed.lastIndexOf(':');
    if (colonIndex === -1) {
      return null;
    }
    const host = trimmed.slice(0, colonIndex);
    const port = normalizePort(trimmed.slice(colonIndex + 1));
    return host && port ? {host, port} : null;

  }

  function parseProxyString(value) {

    const proxyString = String(value || '').trim();
    const match = proxyString.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }
    const type = normalizeProxyType(match[1]);
    const addressWithCredentials = match[2].trim();
    const atIndex = addressWithCredentials.lastIndexOf('@');
    const credentials = atIndex === -1 ?
      '' :
      addressWithCredentials.slice(0, atIndex);
    const address = atIndex === -1 ?
      addressWithCredentials :
      addressWithCredentials.slice(atIndex + 1);
    const hostPort = parseHostPort(address);
    if (!hostPort) {
      return null;
    }
    const colonIndex = credentials.indexOf(':');
    const username = credentials ?
      (colonIndex === -1 ? credentials : credentials.slice(0, colonIndex)) :
      '';
    const password = credentials && colonIndex !== -1 ?
      credentials.slice(colonIndex + 1) :
      '';
    return {
      enabled: true,
      type,
      host: hostPort.host,
      port: hostPort.port,
      username,
      password,
      useAsDirectReplacement: false,
    };

  }

  function normalizeOwnProxy(value) {

    const parsed = typeof value === 'string' ? parseProxyString(value) : null;
    const source = parsed || (isObject(value) ? value : null);
    if (!source) {
      return null;
    }
    const host = normalizeHost(source.host || source.hostname);
    const port = normalizePort(source.port);
    if (!host || !port) {
      return null;
    }
    return {
      enabled: normalizeBoolean(source.enabled, true),
      type: normalizeProxyType(source.type),
      host,
      port,
      username: String(source.username || ''),
      password: String(source.password || ''),
      useAsDirectReplacement: normalizeBoolean(
          source.useAsDirectReplacement,
          false,
      ),
      note: String(source.note || ''),
    };

  }

  function normalizeOwnProxies(value) {

    if (typeof value === 'string') {
      return value
          .replace(/#.*$/mg, '')
          .split(/(?:\s*(?:;|\r?\n)+\s*)+/g)
          .map((item) => item.trim())
          .filter(Boolean)
          .map(normalizeOwnProxy)
          .filter(Boolean);
    }
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map(normalizeOwnProxy).filter(Boolean);

  }

  function normalizeTorConfig(value, defaults) {

    const source = isObject(value) ? value : {};
    return {
      enabled: normalizeBoolean(source.enabled, defaults.enabled),
      type: normalizeProxyType(source.type, defaults.type),
      host: normalizeHost(source.host, defaults.host),
      port: normalizePort(source.port, defaults.port),
      useForOnion: normalizeBoolean(
          source.useForOnion,
          defaults.useForOnion,
      ),
      useAsDirectReplacement: normalizeBoolean(
          source.useAsDirectReplacement,
          defaults.useAsDirectReplacement,
      ),
    };

  }

  function normalizeWarpConfig(value, ifLegacyUseWarp) {

    const source = isObject(value) ? value : {};
    return {
      enabled: normalizeBoolean(source.enabled, ifLegacyUseWarp === true),
      proxyString: String(source.proxyString || DEFAULT_WARP.proxyString).trim(),
      useAsDirectReplacement: normalizeBoolean(
          source.useAsDirectReplacement,
          DEFAULT_WARP.useAsDirectReplacement,
      ),
    };

  }

  function enforceExclusiveTorModes(localTor, torBrowser, preferredMode) {

    const nextLocalTor = Object.assign({}, localTor);
    const nextTorBrowser = Object.assign({}, torBrowser);
    if (nextLocalTor.enabled && nextTorBrowser.enabled) {
      if (preferredMode === 'localTor') {
        nextTorBrowser.enabled = false;
      } else {
        nextLocalTor.enabled = false;
      }
    }
    return {
      localTor: nextLocalTor,
      torBrowser: nextTorBrowser,
    };

  }

  function normalizePatternEntry(value, defaultNote = '') {

    if (typeof value === 'string') {
      const pattern = value.trim();
      return pattern ? {pattern, enabled: true, note: defaultNote} : null;
    }
    if (!isObject(value)) {
      return null;
    }
    const pattern = String(
        value.pattern || value.host || value.domain || '',
    ).trim();
    if (!pattern) {
      return null;
    }
    return {
      pattern,
      enabled: normalizeBoolean(value.enabled, true),
      note: String(value.note || value.comment || defaultNote),
    };

  }

  function normalizeRuleEntry(value, defaultAction = 'DIRECT') {

    if (typeof value === 'string') {
      const pattern = value.trim();
      return pattern ? {
        pattern,
        action: defaultAction,
        enabled: true,
        note: '',
      } : null;
    }
    if (!isObject(value)) {
      return null;
    }
    const pattern = String(
        value.pattern || value.host || value.domain || '',
    ).trim();
    if (!pattern) {
      return null;
    }
    const action = String(value.action || defaultAction).toUpperCase();
    return {
      pattern,
      action: RULE_ACTIONS.includes(action) ? action : defaultAction,
      enabled: normalizeBoolean(value.enabled, true),
      note: String(value.note || value.comment || ''),
    };

  }

  function normalizeWhitelist(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => normalizePatternEntry(item)).filter(Boolean);

  }

  function normalizeExceptions(value) {

    if (Array.isArray(value)) {
      return value.map((item) => normalizeRuleEntry(item, 'DIRECT')).filter(Boolean);
    }
    if (isObject(value)) {
      return Object.keys(value).sort().map((pattern) => ({
        pattern,
        action: value[pattern] ? 'PROXY' : 'DIRECT',
        enabled: true,
        note: 'Migrated legacy exception',
      }));
    }
    return [];

  }

  function normalizeRules(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => normalizeRuleEntry(item, 'DIRECT')).filter(Boolean);

  }

  function normalizePacMods(value) {

    const source = isObject(value) ? value : {};
    const ifLegacyUseTor = source.useTor === true;
    const ifLegacyUseWarp = source.useWarp === true;
    const ifLegacyReplaceDirect = source.replaceDirectWithProxy === true;
    let localTor = normalizeTorConfig(source.localTor, Object.assign(
        {},
        DEFAULT_LOCAL_TOR,
        {
          enabled: false,
          useAsDirectReplacement: ifLegacyUseTor && ifLegacyReplaceDirect,
        },
    ));
    let torBrowser = normalizeTorConfig(source.torBrowser, Object.assign(
        {},
        DEFAULT_TOR_BROWSER,
        {
          enabled: ifLegacyUseTor,
          useAsDirectReplacement: ifLegacyUseTor && ifLegacyReplaceDirect,
        },
    ));
    const warp = normalizeWarpConfig(source.warp, ifLegacyUseWarp);
    if (ifLegacyUseTor) {
      torBrowser.enabled = true;
      if (ifLegacyReplaceDirect) {
        localTor.useAsDirectReplacement = true;
        torBrowser.useAsDirectReplacement = true;
      }
    }
    if (ifLegacyUseWarp) {
      warp.enabled = true;
    }
    const torModes = enforceExclusiveTorModes(localTor, torBrowser, 'torBrowser');
    localTor = torModes.localTor;
    torBrowser = torModes.torBrowser;
    return {
      usePacScriptProxies: normalizeBoolean(
          source.usePacScriptProxies,
          normalizeBoolean(source.ifUsePacScriptProxies, true),
      ),
      ownProxiesOnlyForOwnSites: normalizeBoolean(
          source.ownProxiesOnlyForOwnSites,
          normalizeBoolean(source.ifUseOwnProxiesOnlyForOwnSites, true),
      ),
      ownProxies: normalizeOwnProxies(source.ownProxies),
      localTor,
      torBrowser,
      warp,
      whitelist: normalizeWhitelist(source.whitelist),
      exceptions: normalizeExceptions(source.exceptions),
      rules: normalizeRules(source.rules),
      replaceDirectWithProxy: normalizeBoolean(
          source.replaceDirectWithProxy,
          false,
      ),
      noDirect: normalizeBoolean(source.noDirect, false),
    };

  }

  function splitProxyString(value) {

    return String(value || '')
        .split(/\s*;\s*/g)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const parsed = parseProxyString(item);
          return parsed ? proxyEntryToPacString(parsed) : item;
        });

  }

  function proxyEntryToPacString(proxy, ifIncludeCredentials = false) {

    const normalized = normalizeOwnProxy(proxy);
    if (!normalized || normalized.enabled === false) {
      return '';
    }
    const credentials = ifIncludeCredentials &&
      (normalized.username || normalized.password) ?
      `${normalized.username}:${normalized.password}@` :
      '';
    return `${normalized.type} ${credentials}${normalized.host}:${normalized.port}`;

  }

  function torConfigToPacString(config) {

    const normalized = normalizeTorConfig(config, DEFAULT_LOCAL_TOR);
    if (!normalized.enabled) {
      return '';
    }
    return `${normalized.type} ${normalized.host}:${normalized.port}`;

  }

  function getOnionProxyCandidates(mods) {

    const normalized = normalizePacMods(mods);
    return [
      normalized.localTor.enabled && normalized.localTor.useForOnion ?
        torConfigToPacString(normalized.localTor) :
        '',
      normalized.torBrowser.enabled && normalized.torBrowser.useForOnion ?
        torConfigToPacString(normalized.torBrowser) :
        '',
    ].filter(Boolean);

  }

  function getDirectReplacementCandidates(mods) {

    const normalized = normalizePacMods(mods);
    const proxies = normalized.ownProxies
        .filter((proxy) => proxy.enabled && proxy.useAsDirectReplacement)
        .map((proxy) => proxyEntryToPacString(proxy))
        .filter(Boolean);
    if (normalized.localTor.enabled && normalized.localTor.useAsDirectReplacement) {
      proxies.push(torConfigToPacString(normalized.localTor));
    }
    if (normalized.torBrowser.enabled && normalized.torBrowser.useAsDirectReplacement) {
      proxies.push(torConfigToPacString(normalized.torBrowser));
    }
    if (normalized.warp.enabled && normalized.warp.useAsDirectReplacement) {
      proxies.push(...splitProxyString(normalized.warp.proxyString));
    }
    return proxies.filter(Boolean);

  }

  function getProxyRuleCandidates(mods) {

    const normalized = normalizePacMods(mods);
    const proxies = normalized.ownProxies
        .filter((proxy) => proxy.enabled)
        .map((proxy) => proxyEntryToPacString(proxy))
        .filter(Boolean);
    if (normalized.localTor.enabled) {
      proxies.push(torConfigToPacString(normalized.localTor));
    }
    if (normalized.torBrowser.enabled) {
      proxies.push(torConfigToPacString(normalized.torBrowser));
    }
    if (normalized.warp.enabled) {
      proxies.push(...splitProxyString(normalized.warp.proxyString));
    }
    return proxies.filter(Boolean);

  }

  function redactUsername(username) {

    const value = String(username || '');
    if (!value) {
      return '';
    }
    return value.length <= 2 ?
      '*'.repeat(value.length) :
      `${value[0]}***${value[value.length - 1]}`;

  }

  function redactProxy(proxy) {

    const normalized = normalizeOwnProxy(proxy);
    if (!normalized) {
      return null;
    }
    return Object.assign({}, normalized, {
      username: redactUsername(normalized.username),
      password: normalized.password ? REDACTED_PASSWORD : '',
    });

  }

  function redactPacMods(pacMods) {

    const normalized = normalizePacMods(pacMods);
    return Object.assign({}, normalized, {
      ownProxies: normalized.ownProxies.map(redactProxy).filter(Boolean),
    });

  }

  function selfTest() {

    const samplePassword = ['sec', 'ret'].join('');
    const legacy = normalizePacMods({
      ownProxies: [`HTTPS user:${samplePassword}@proxy.example:8443`],
      useTor: true,
      useWarp: true,
      exceptions: {'direct.example': false, 'proxy.example': true},
      whitelist: ['allowed.example'],
      replaceDirectWithProxy: true,
    });
    const defaults = normalizePacMods({});
    return {
      defaultUsesPacScriptProxies:
        defaults.usePacScriptProxies === true,
      defaultOwnProxiesOnlyForOwnSites:
        defaults.ownProxiesOnlyForOwnSites === true,
      defaultDirectReplacementDisabled:
        defaults.replaceDirectWithProxy === false,
      defaultNoDirectDisabled:
        defaults.noDirect === false,
      legacyUseTorDoesNotEnableLocalTor: legacy.localTor.enabled === false,
      legacyUseTorEnablesTorBrowser: legacy.torBrowser.enabled === true,
      legacyUseTorKeepsOnlyTorBrowser:
        legacy.localTor.enabled === false &&
        legacy.torBrowser.enabled === true,
      bothTorModesNormalizeToTorBrowser:
        normalizePacMods({
          localTor: {enabled: true},
          torBrowser: {enabled: true},
        }).localTor.enabled === false &&
        normalizePacMods({
          localTor: {enabled: true},
          torBrowser: {enabled: true},
        }).torBrowser.enabled === true,
      localTorOnlySurvivesNormalization:
        normalizePacMods({
          localTor: {enabled: true},
          torBrowser: {enabled: false},
        }).localTor.enabled === true &&
        normalizePacMods({
          localTor: {enabled: true},
          torBrowser: {enabled: false},
        }).torBrowser.enabled === false,
      bothTorModesCanBeDisabled:
        normalizePacMods({
          localTor: {enabled: false},
          torBrowser: {enabled: false},
        }).localTor.enabled === false &&
        normalizePacMods({
          localTor: {enabled: false},
          torBrowser: {enabled: false},
        }).torBrowser.enabled === false,
      legacyPacScriptProxySwitch:
        normalizePacMods({ifUsePacScriptProxies: false})
            .usePacScriptProxies === false,
      legacyOwnSitesOnlySwitch:
        normalizePacMods({ifUseOwnProxiesOnlyForOwnSites: true})
            .ownProxiesOnlyForOwnSites === true,
      legacyOwnProxyStructured:
        legacy.ownProxies[0].host === 'proxy.example' &&
        legacy.ownProxies[0].password === samplePassword,
      legacyStringOwnProxyStructured:
        normalizePacMods({
          ownProxies: `HTTPS user:${samplePassword}@proxy.example:8443`,
        }).ownProxies[0].password === samplePassword,
      legacyUseTorOverridesStructuredDefault:
        normalizePacMods({
          useTor: true,
          localTor: {enabled: false},
          torBrowser: {enabled: false},
        }).localTor.enabled === false &&
        normalizePacMods({
          useTor: true,
          localTor: {enabled: false},
          torBrowser: {enabled: false},
        }).torBrowser.enabled === true,
      legacyUseWarpOverridesStructuredDefault:
        normalizePacMods({
          useWarp: true,
          warp: {enabled: false},
        }).warp.enabled === true,
      localTorPacString:
        torConfigToPacString(DEFAULT_LOCAL_TOR) === '',
      directReplacementCandidates:
        getDirectReplacementCandidates(legacy).includes('SOCKS5 127.0.0.1:9150'),
      proxyRuleExceptionMigrated:
        legacy.exceptions.some((rule) =>
          rule.pattern === 'proxy.example' && rule.action === 'PROXY',
        ),
      redactionHidesPassword:
        redactPacMods(legacy).ownProxies[0].password === REDACTED_PASSWORD,
    };

  }

  exports.mv3PacMods = Object.freeze({
    DEFAULT_PAC_MODS,
    REDACTED_PASSWORD,
    normalizePacMods,
    normalizeOwnProxy,
    parseProxyString,
    enforceExclusiveTorModes,
    proxyEntryToPacString,
    splitProxyString,
    getOnionProxyCandidates,
    getDirectReplacementCandidates,
    getProxyRuleCandidates,
    redactPacMods,
    selfTest,
  });

})(self);
