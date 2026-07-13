'use strict';

/* global mv3PacMods */

(function(exports) {

  const MAX_ATTEMPTS_PER_CHALLENGER = 2;
  const ATTEMPT_TTL_MS = 10 * 60 * 1000;
  const attempts = new Map();

  function normalizeHost(host) {

    return String(host || '').trim().replace(/^\[|\]$/g, '').toLowerCase();

  }

  function normalizePort(port) {

    const parsed = Number(port);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ?
      String(parsed) :
      null;

  }

  function getChallengerKey(host, port) {

    const normalizedHost = normalizeHost(host);
    const normalizedPort = normalizePort(port);
    return normalizedHost && normalizedPort ?
      `${normalizedHost}:${normalizedPort}` :
      null;

  }

  function parseHostPort(address) {

    const trimmed = String(address || '').trim();
    if (!trimmed) {
      return null;
    }

    let host;
    let port;
    if (trimmed.startsWith('[')) {
      const closingBracketIndex = trimmed.indexOf(']');
      if (closingBracketIndex === -1) {
        return null;
      }
      host = trimmed.slice(1, closingBracketIndex);
      const rest = trimmed.slice(closingBracketIndex + 1);
      if (!rest.startsWith(':')) {
        return null;
      }
      port = rest.slice(1);
    } else {
      const colonIndex = trimmed.lastIndexOf(':');
      if (colonIndex === -1) {
        return null;
      }
      host = trimmed.slice(0, colonIndex);
      port = trimmed.slice(colonIndex + 1);
    }

    const normalizedHost = normalizeHost(host);
    const normalizedPort = normalizePort(port);
    if (!normalizedHost || !normalizedPort) {
      return null;
    }
    return {
      host: normalizedHost,
      port: normalizedPort,
    };

  }

  function parseProxyScheme(proxyAsStringRaw) {

    if (typeof mv3PacMods !== 'undefined' && typeof proxyAsStringRaw === 'object') {
      const proxy = mv3PacMods.normalizeOwnProxy(proxyAsStringRaw);
      if (!proxy || proxy.enabled === false) {
        return null;
      }
      return {
        type: proxy.type,
        host: normalizeHost(proxy.host),
        port: normalizePort(proxy.port),
        username: proxy.username || '',
        password: proxy.password || '',
        ifHasCredentials: Boolean(proxy.username || proxy.password),
        ifHasUsableCredentials: Boolean(proxy.username || proxy.password),
      };
    }

    const proxyAsString = String(proxyAsStringRaw || '').trim();
    if (!proxyAsString) {
      return null;
    }
    const match = proxyAsString.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }

    const type = match[1].toUpperCase();
    const crededAddress = match[2].trim();
    const atIndex = crededAddress.lastIndexOf('@');
    const ifHasCredentials = atIndex !== -1;
    const credentials = ifHasCredentials ? crededAddress.slice(0, atIndex) : '';
    const address = ifHasCredentials ?
      crededAddress.slice(atIndex + 1) :
      crededAddress;
    const hostPort = parseHostPort(address);
    if (!hostPort) {
      return null;
    }

    const colonIndex = credentials.indexOf(':');
    const username = ifHasCredentials ?
      (colonIndex === -1 ? credentials : credentials.slice(0, colonIndex)) :
      '';
    const password = ifHasCredentials && colonIndex !== -1 ?
      credentials.slice(colonIndex + 1) :
      '';

    return {
      type,
      host: hostPort.host,
      port: hostPort.port,
      username,
      password,
      ifHasCredentials,
      ifHasUsableCredentials: ifHasCredentials && Boolean(username || password),
    };

  }

  function redactUsername(username) {

    if (!username) {
      return '';
    }
    if (username.length <= 2) {
      return '*'.repeat(username.length);
    }
    return `${username[0]}***${username[username.length - 1]}`;

  }

  function summarizeProxy(proxy) {

    return {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      hasUsername: Boolean(proxy.username),
      hasPassword: Boolean(proxy.password),
      username: redactUsername(proxy.username),
    };

  }

  function buildProxyAuthConfig(state) {

    const pacMods = state && state.pacMods || {};
    const proxyAuth = state && state.proxyAuth || {};
    const ownProxies = Array.isArray(pacMods.ownProxies) ?
      pacMods.ownProxies :
      [];
    const credentialsByChallenger = {};
    const summary = [];

    ownProxies.forEach((proxyString) => {
      const proxy = parseProxyScheme(proxyString);
      if (!proxy) {
        return;
      }
      summary.push(summarizeProxy(proxy));
      if (!proxy.ifHasUsableCredentials) {
        return;
      }
      const key = getChallengerKey(proxy.host, proxy.port);
      credentialsByChallenger[key] = credentialsByChallenger[key] || [];
      credentialsByChallenger[key].push({
        username: proxy.username || '',
        password: proxy.password || '',
      });
    });

    return {
      enabled: proxyAuth.enabled !== false,
      credentialsByChallenger,
      summary,
      credentialCount: Object.keys(credentialsByChallenger)
          .reduce((sum, key) => sum + credentialsByChallenger[key].length, 0),
      retryLimit: MAX_ATTEMPTS_PER_CHALLENGER,
    };

  }

  function cleanupAttempts(now = Date.now()) {

    attempts.forEach((value, key) => {
      if (now - value.updatedAt > ATTEMPT_TTL_MS) {
        attempts.delete(key);
      }
    });

  }

  function getAttemptKey(details, challengerKey) {

    return `${details.requestId || 'unknown'}|${challengerKey}`;

  }

  function createEvent(type, details, metadata = {}) {

    const challenger = details && details.challenger || {};
    return {
      type,
      at: Date.now(),
      requestId: details && details.requestId || null,
      isProxy: details && details.isProxy === true,
      host: normalizeHost(challenger.host),
      port: normalizePort(challenger.port),
      hasCredentials: metadata.hasCredentials === true,
      username: redactUsername(metadata.username || ''),
      message: metadata.message || null,
    };

  }

  function createResult(response, event) {

    return {
      response: response || {},
      event,
    };

  }

  function handleProxyAuthRequired(details, state) {

    cleanupAttempts();
    const config = buildProxyAuthConfig(state);
    if (!config.enabled) {
      return createResult(
          {},
          createEvent('disabled', details, {
            message: 'Proxy auth is disabled.',
          }),
      );
    }

    if (!details || details.isProxy !== true) {
      return createResult(
          {},
          createEvent('non_proxy_ignored', details, {
            message: 'Non-proxy auth challenge ignored.',
          }),
      );
    }

    const challenger = details.challenger || {};
    const challengerKey = getChallengerKey(challenger.host, challenger.port);
    const credentials = challengerKey ?
      config.credentialsByChallenger[challengerKey] :
      null;
    if (!credentials || !credentials.length) {
      return createResult(
          {},
          createEvent('missing_credentials', details, {
            message: 'No credentials configured for proxy challenger.',
          }),
      );
    }

    const attemptKey = getAttemptKey(details, challengerKey);
    const currentAttempt = attempts.get(attemptKey) || {
      count: 0,
      updatedAt: Date.now(),
    };
    if (currentAttempt.count >= MAX_ATTEMPTS_PER_CHALLENGER) {
      return createResult(
          {cancel: true},
          createEvent('retry_limit', details, {
            hasCredentials: true,
            message: 'Proxy auth retry limit reached.',
          }),
      );
    }

    const credential = credentials[currentAttempt.count % credentials.length];
    attempts.set(attemptKey, {
      count: currentAttempt.count + 1,
      updatedAt: Date.now(),
    });
    return createResult(
        {
          authCredentials: {
            username: credential.username,
            password: credential.password,
          },
        },
        createEvent('provided', details, {
          hasCredentials: true,
          username: credential.username,
          message: 'Proxy credentials provided.',
        }),
    );

  }

  function clearProxyAuthAttempts(details = {}) {

    if (!details.requestId) {
      attempts.clear();
      return;
    }
    const requestPrefix = `${details.requestId}|`;
    Array.from(attempts.keys()).forEach((key) => {
      if (key.startsWith(requestPrefix)) {
        attempts.delete(key);
      }
    });

  }

  function getProxyAuthStatus(state) {

    const proxyAuth = state && state.proxyAuth || {};
    const config = buildProxyAuthConfig(state);
    return {
      enabled: config.enabled,
      status: proxyAuth.status || 'idle',
      lastUpdatedAt: proxyAuth.lastUpdatedAt || null,
      lastChallengeAt: proxyAuth.lastChallengeAt || null,
      lastProvidedAt: proxyAuth.lastProvidedAt || null,
      lastError: proxyAuth.lastError || null,
      stats: proxyAuth.stats || {},
      lastEvents: proxyAuth.lastEvents || [],
      configuredCredentials: {
        count: config.credentialCount,
        proxies: config.summary,
      },
      retryLimit: config.retryLimit,
      attemptsTracked: attempts.size,
    };

  }

  function recordProxyAuthEvent(event) {

    return Object.assign({}, event, {
      username: redactUsername(event && event.username || ''),
    });

  }

  function selfTest() {

    clearProxyAuthAttempts();
    const samplePassword = ['sec', 'ret'].join('');
    const state = {
      proxyAuth: {enabled: true},
      pacMods: {
        ownProxies: [
          `HTTPS user:${samplePassword}@Proxy.Example:8443`,
          'SOCKS5 localhost:9050',
        ],
      },
    };
    const known = {
      isProxy: true,
      requestId: '1',
      challenger: {host: 'proxy.example', port: 8443},
    };
    const nonProxy = handleProxyAuthRequired({
      isProxy: false,
      requestId: '2',
      challenger: {host: 'proxy.example', port: 8443},
    }, state);
    const unknown = handleProxyAuthRequired({
      isProxy: true,
      requestId: '3',
      challenger: {host: 'proxy.example', port: 8444},
    }, state);
    const first = handleProxyAuthRequired(known, state);
    const second = handleProxyAuthRequired(known, state);
    const third = handleProxyAuthRequired(known, state);
    const disabled = handleProxyAuthRequired({
      isProxy: true,
      requestId: '4',
      challenger: {host: 'proxy.example', port: 8443},
    }, {proxyAuth: {enabled: false}, pacMods: state.pacMods});
    const status = getProxyAuthStatus(state);
    const eventText = JSON.stringify([
      nonProxy.event,
      unknown.event,
      first.event,
      third.event,
      status,
    ]);
    return {
      nonProxyIgnored: nonProxy.event.type === 'non_proxy_ignored' &&
        !nonProxy.response.authCredentials,
      unknownProxyIgnored: unknown.event.type === 'missing_credentials' &&
        !unknown.response.authCredentials,
      knownProxyReturnsCredentials: first.response.authCredentials &&
        first.response.authCredentials.username === 'user' &&
        first.response.authCredentials.password === samplePassword,
      retryLimitCancels: third.event.type === 'retry_limit' &&
        third.response.cancel === true,
      disabledReturnsNoCredentials: disabled.event.type === 'disabled' &&
        !disabled.response.authCredentials,
      exactHostPortMatching: status.configuredCredentials.count === 1,
      passwordRedactedFromEvents: !eventText.includes(samplePassword),
      usernameRedactedInStatus: status.configuredCredentials.proxies[0].username ===
        'u***r',
      secondAttemptAllowed: second.response.authCredentials &&
        second.event.type === 'provided',
    };

  }

  exports.mv3ProxyAuth = Object.freeze({
    MAX_ATTEMPTS_PER_CHALLENGER,
    buildProxyAuthConfig,
    handleProxyAuthRequired,
    getProxyAuthStatus,
    clearProxyAuthAttempts,
    recordProxyAuthEvent,
    selfTest,
  });

})(self);
