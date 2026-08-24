'use strict';

/* global mv3PacMods */

(function(exports) {

  const MAX_ATTEMPTS_PER_CHALLENGER = 2;
  const ATTEMPT_TTL_MS = 10 * 60 * 1000;
  const SESSION_STORAGE_KEY = 'mv3ProxyAuthAttempts';
  let attemptOperationQueue = Promise.resolve();
  let attemptsTracked = 0;

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

  function getAttemptRequestId(details) {

    return String(details && details.requestId || 'unknown');

  }

  function normalizeAttemptEntry(value) {

    if (!value || typeof value !== 'object') {
      return null;
    }
    const requestId = typeof value.requestId === 'string' ? value.requestId : '';
    const challengerKey = typeof value.challengerKey === 'string' ?
      value.challengerKey :
      '';
    const count = Number(value.count);
    const updatedAt = Number(value.updatedAt);
    if (
      !requestId ||
      !challengerKey ||
      !Number.isInteger(count) ||
      count < 1 ||
      !Number.isFinite(updatedAt) ||
      updatedAt <= 0
    ) {
      return null;
    }
    return {
      requestId,
      challengerKey,
      count: Math.min(count, MAX_ATTEMPTS_PER_CHALLENGER),
      updatedAt,
    };

  }

  function normalizeAttemptEntries(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    const normalized = [];
    value.forEach((candidate) => {
      const entry = normalizeAttemptEntry(candidate);
      if (!entry) {
        return;
      }
      const duplicate = normalized.find((current) =>
        current.requestId === entry.requestId &&
        current.challengerKey === entry.challengerKey,
      );
      if (!duplicate) {
        normalized.push(entry);
        return;
      }
      duplicate.count = Math.max(duplicate.count, entry.count);
      duplicate.updatedAt = Math.max(duplicate.updatedAt, entry.updatedAt);
    });
    return normalized;

  }

  function cleanupAttemptEntries(entries, now = Date.now()) {

    return entries.filter((entry) => now - entry.updatedAt <= ATTEMPT_TTL_MS);

  }

  function createRetryStateError() {

    const error = new Error('Proxy auth retry state is unavailable.');
    error.code = 'PROXY_AUTH_RETRY_STATE_FAILED';
    return error;

  }

  function getSessionStorageArea() {

    const area = typeof chrome !== 'undefined' &&
      chrome.storage && chrome.storage.session;
    if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
      throw createRetryStateError();
    }
    return area;

  }

  function getRuntimeLastError() {

    return typeof chrome !== 'undefined' &&
      chrome.runtime && chrome.runtime.lastError || null;

  }

  function readAttemptEntries() {

    return new Promise((resolve, reject) => {
      let area;
      try {
        area = getSessionStorageArea();
        area.get({[SESSION_STORAGE_KEY]: []}, (items) => {
          if (getRuntimeLastError()) {
            reject(createRetryStateError());
            return;
          }
          const entries = normalizeAttemptEntries(
              items && items[SESSION_STORAGE_KEY],
          );
          attemptsTracked = entries.length;
          resolve(entries);
        });
      } catch (error) {
        reject(createRetryStateError());
      }
    });

  }

  function writeAttemptEntries(entries) {

    const normalized = normalizeAttemptEntries(entries);
    return new Promise((resolve, reject) => {
      let area;
      try {
        area = getSessionStorageArea();
        area.set({[SESSION_STORAGE_KEY]: normalized}, () => {
          if (getRuntimeLastError()) {
            reject(createRetryStateError());
            return;
          }
          attemptsTracked = normalized.length;
          resolve(normalized);
        });
      } catch (error) {
        reject(createRetryStateError());
      }
    });

  }

  function runAttemptOperation(operation) {

    const result = attemptOperationQueue.then(operation, operation);
    attemptOperationQueue = result.then(() => undefined, () => undefined);
    return result;

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

  function prepareProxyAuthRequest(details, state) {

    const config = buildProxyAuthConfig(state);
    if (!config.enabled) {
      return {
        result: createResult({}, createEvent('disabled', details, {
          message: 'Proxy auth is disabled.',
        })),
      };
    }

    if (!details || details.isProxy !== true) {
      return {
        result: createResult({}, createEvent('non_proxy_ignored', details, {
          message: 'Non-proxy auth challenge ignored.',
        })),
      };
    }

    const challenger = details.challenger || {};
    const challengerKey = getChallengerKey(challenger.host, challenger.port);
    const credentials = challengerKey ?
      config.credentialsByChallenger[challengerKey] :
      null;
    if (!credentials || !credentials.length) {
      return {
        result: createResult({}, createEvent('missing_credentials', details, {
          message: 'No credentials configured for proxy challenger.',
        })),
      };
    }
    return {challengerKey, credentials};

  }

  async function reserveProxyAuthAttempt(details, challengerKey, credentials) {

    return runAttemptOperation(async () => {
      const now = Date.now();
      const requestId = getAttemptRequestId(details);
      const entries = cleanupAttemptEntries(await readAttemptEntries(), now);
      const currentAttempt = entries.find((entry) =>
        entry.requestId === requestId &&
        entry.challengerKey === challengerKey,
      );
      const count = currentAttempt ? currentAttempt.count : 0;
      if (count >= MAX_ATTEMPTS_PER_CHALLENGER) {
        await writeAttemptEntries(entries);
        return {allowed: false};
      }

      const credential = credentials[count % credentials.length];
      const updatedEntries = entries.filter((entry) =>
        entry.requestId !== requestId ||
        entry.challengerKey !== challengerKey,
      );
      updatedEntries.push({
        requestId,
        challengerKey,
        count: count + 1,
        updatedAt: now,
      });
      await writeAttemptEntries(updatedEntries);
      return {allowed: true, credential};
    });

  }

  async function handleProxyAuthRequired(details, state) {

    const prepared = prepareProxyAuthRequest(details, state);
    if (prepared.result) {
      return prepared.result;
    }

    let reservation;
    try {
      reservation = await reserveProxyAuthAttempt(
          details,
          prepared.challengerKey,
          prepared.credentials,
      );
    } catch (error) {
      return createResult(
          {cancel: true},
          createEvent('error', details, {
            hasCredentials: true,
            message: 'Proxy auth retry state is unavailable.',
          }),
      );
    }
    if (!reservation.allowed) {
      return createResult(
          {cancel: true},
          createEvent('retry_limit', details, {
            hasCredentials: true,
            message: 'Proxy auth retry limit reached.',
          }),
      );
    }

    const credential = reservation.credential;
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

    return runAttemptOperation(async () => {
      const storedEntries = await readAttemptEntries();
      const entries = cleanupAttemptEntries(storedEntries);
      if (!details.requestId) {
        if (!storedEntries.length) {
          return;
        }
        await writeAttemptEntries([]);
        return;
      }
      const requestId = getAttemptRequestId(details);
      const challenger = details.challenger || {};
      const challengerKey = getChallengerKey(challenger.host, challenger.port);
      const retained = entries.filter((entry) => {
        if (entry.requestId !== requestId) {
          return true;
        }
        return challengerKey && entry.challengerKey !== challengerKey;
      });
      if (
        retained.length === storedEntries.length &&
        entries.length === storedEntries.length
      ) {
        return;
      }
      await writeAttemptEntries(retained);
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
      attemptsTracked,
    };

  }

  function recordProxyAuthEvent(event) {

    return Object.assign({}, event, {
      username: redactUsername(event && event.username || ''),
    });

  }

  function selfTest() {

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
    const nonProxy = prepareProxyAuthRequest({
      isProxy: false,
      requestId: '2',
      challenger: {host: 'proxy.example', port: 8443},
    }, state);
    const unknown = prepareProxyAuthRequest({
      isProxy: true,
      requestId: '3',
      challenger: {host: 'proxy.example', port: 8444},
    }, state);
    const prepared = prepareProxyAuthRequest(known, state);
    const disabled = prepareProxyAuthRequest({
      isProxy: true,
      requestId: '4',
      challenger: {host: 'proxy.example', port: 8443},
    }, {proxyAuth: {enabled: false}, pacMods: state.pacMods});
    const status = getProxyAuthStatus(state);
    const providedEvent = createEvent('provided', known, {
      hasCredentials: true,
      username: prepared.credentials[0].username,
      message: 'Proxy credentials provided.',
    });
    const eventText = JSON.stringify([
      nonProxy.result.event,
      unknown.result.event,
      providedEvent,
      status,
    ]);
    return {
      nonProxyIgnored: nonProxy.result.event.type === 'non_proxy_ignored' &&
        !nonProxy.result.response.authCredentials,
      unknownProxyIgnored: unknown.result.event.type === 'missing_credentials' &&
        !unknown.result.response.authCredentials,
      knownProxyFindsCredentials: prepared.credentials.length === 1 &&
        prepared.credentials[0].username === 'user' &&
        prepared.credentials[0].password === samplePassword,
      disabledReturnsNoCredentials: disabled.result.event.type === 'disabled' &&
        !disabled.result.response.authCredentials,
      exactHostPortMatching: status.configuredCredentials.count === 1,
      passwordRedactedFromEvents: !eventText.includes(samplePassword),
      usernameRedactedInStatus: status.configuredCredentials.proxies[0].username ===
        'u***r',
    };

  }

  exports.mv3ProxyAuth = Object.freeze({
    ATTEMPT_TTL_MS,
    MAX_ATTEMPTS_PER_CHALLENGER,
    SESSION_STORAGE_KEY,
    buildProxyAuthConfig,
    handleProxyAuthRequired,
    getProxyAuthStatus,
    clearProxyAuthAttempts,
    recordProxyAuthEvent,
    selfTest,
  });

})(self);
