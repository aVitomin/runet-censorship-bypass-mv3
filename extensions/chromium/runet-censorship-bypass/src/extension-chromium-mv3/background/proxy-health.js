'use strict';

/* global mv3PacMods */

(function(exports) {

  const CHECK_TIMEOUT_MS = 9000;
  const NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;
  const ALARM_NAME = 'mv3-proxy-health';
  const SESSION_STORAGE_KEY = 'mv3ProxyHealthSessionId';
  const STARTUP_DELAY_MS = 30 * 1000;
  const HEALTHY_TTL_MS = 60 * 60 * 1000;
  const FAILED_TTL_MS = 60 * 60 * 1000;
  const INCONCLUSIVE_RETRY_MS = 60 * 60 * 1000;
  const FAILURE_RETRY_MS = Object.freeze([
    1 * 60 * 1000,
    5 * 60 * 1000,
    15 * 60 * 1000,
    30 * 60 * 1000,
    60 * 60 * 1000,
  ]);
  let sessionIdPromise = null;
  // Keep this allowlist limited to proxy failures from Chromium's net errors.
  // Destination/DNS/TLS errors are deliberately inconclusive.
  const PROXY_ERROR_CODES = Object.freeze([
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_SOCKS_CONNECTION_FAILED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_NO_SUPPORTED_PROXIES',
    'net::ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
    'net::ERR_PROXY_CERTIFICATE_INVALID',
    'net::ERR_PROXY_AUTH_UNSUPPORTED',
  ]);
  const PROXY_ERROR_CODE_SET = new Set(PROXY_ERROR_CODES);

  function normalizeErrorCode(value) {

    const code = String(value || '').trim().toUpperCase();
    if (!code) {
      return '';
    }
    return `net::${code.startsWith('NET::') ? code.slice(5) : code}`;

  }

  function isProxyError(value) {

    return PROXY_ERROR_CODE_SET.has(normalizeErrorCode(value));

  }

  function sanitizeHostname(value) {

    try {
      const parsed = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return '';
      }
      return parsed.hostname.toLowerCase().slice(0, 253);
    } catch (err) {
      return '';
    }

  }

  function sanitizeOrigin(value) {

    try {
      const parsed = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
        return '';
      }
      return parsed.origin;
    } catch (err) {
      return '';
    }

  }

  function sanitizeEndpoint(host, port) {

    const normalizedHost = String(host || '')
        .replace(/[^a-z0-9.:[\]-]/gi, '')
        .slice(0, 253);
    const normalizedPort = Number(port);
    if (
      !normalizedHost ||
      !Number.isInteger(normalizedPort) ||
      normalizedPort < 1 ||
      normalizedPort > 65535
    ) {
      return '';
    }
    return `${normalizedHost}:${normalizedPort}`;

  }

  function getCandidateSummary(pacMods) {

    const normalized = mv3PacMods.normalizePacMods(pacMods);
    const ownProxy = normalized.ownProxies.find((proxy) =>
      proxy.enabled !== false && proxy.host && proxy.port,
    );
    if (ownProxy) {
      return createCandidateSummary({
        type: 'ownProxy',
        proxyType: ownProxy.type,
        host: ownProxy.host,
        port: ownProxy.port,
      });
    }
    if (normalized.localTor.enabled) {
      return createCandidateSummary({
        type: 'localTor',
        proxyType: normalized.localTor.type,
        host: normalized.localTor.host,
        port: normalized.localTor.port,
      });
    }
    if (normalized.torBrowser.enabled) {
      return createCandidateSummary({
        type: 'torBrowser',
        proxyType: normalized.torBrowser.type,
        host: normalized.torBrowser.host,
        port: normalized.torBrowser.port,
      });
    }
    if (normalized.warp.enabled) {
      const candidate = mv3PacMods.splitProxyString(
          normalized.warp.proxyString,
      )[0];
      const parsed = candidate ? mv3PacMods.parseProxyString(candidate) : null;
      return createCandidateSummary({
        type: 'warp',
        proxyType: parsed && parsed.type,
        host: parsed && parsed.host,
        port: parsed && parsed.port,
      });
    }
    return {
      type: null,
      proxyType: null,
      endpoint: '',
      key: '',
    };

  }

  function createCandidateSummary(candidate) {

    const type = [
      'localTor',
      'torBrowser',
      'warp',
      'ownProxy',
    ].includes(candidate && candidate.type) ? candidate.type : null;
    const proxyType = String(candidate && candidate.proxyType || '')
        .trim()
        .toUpperCase();
    const endpoint = sanitizeEndpoint(
        candidate && candidate.host,
        candidate && candidate.port,
    );
    if (!type || !proxyType || !endpoint) {
      return {
        type: null,
        proxyType: null,
        endpoint: '',
        key: '',
      };
    }
    return {
      type,
      proxyType,
      endpoint,
      key: `${type}|${proxyType}|${endpoint}`,
    };

  }

  function getCandidateFingerprint(pacMods) {

    const normalized = mv3PacMods.normalizePacMods(pacMods);
    return JSON.stringify(
        mv3PacMods.getProxyRuleCandidates(normalized)
            .map((entry) => mv3PacMods.parseProxyString(entry))
            .filter(Boolean)
            .map((entry) => ({
              proxyType: entry.type,
              endpoint: sanitizeEndpoint(entry.host, entry.port),
            })),
    );

  }

  function normalizeRetryStep(value) {

    const step = Number(value);
    if (!Number.isSafeInteger(step) || step < 0) {
      return 0;
    }
    return Math.min(step, FAILURE_RETRY_MS.length - 1);

  }

  function getFailureRetryMs(retryStep) {

    return FAILURE_RETRY_MS[normalizeRetryStep(retryStep)];

  }

  function getNextRetryStep(retryStep) {

    return Math.min(
        normalizeRetryStep(retryStep) + 1,
        FAILURE_RETRY_MS.length - 1,
    );

  }

  function isCurrentIdentity(health, expected) {

    return Boolean(
        health &&
        expected &&
        expected.candidate &&
        expected.candidate.key &&
        health.candidateKey === expected.candidate.key &&
        health.candidateRevision === expected.candidateRevision,
    );

  }

  function classifyFreshness(health, expected, options = {}) {

    const value = health && typeof health === 'object' ? health : {};
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const ifIdentityCurrent = isCurrentIdentity(value, expected);
    if (
      value.status === 'checking' &&
      options.ifCheckingActive === true &&
      ifIdentityCurrent &&
      value.sessionId === expected.sessionId
    ) {
      return {status: 'checking', stale: false, reason: null};
    }
    if (value.status === 'checking') {
      const ifErrorWasLatest = value.lastErrorAt &&
        (!value.lastSuccessAt || value.lastErrorAt >= value.lastSuccessAt);
      if (
        ifErrorWasLatest &&
        ifIdentityCurrent &&
        value.sessionId === expected.sessionId &&
        now - value.lastErrorAt <= FAILED_TTL_MS
      ) {
        return {status: 'error', stale: false, reason: 'interrupted-check'};
      }
      if (
        value.lastSuccessAt &&
        (!value.lastErrorAt || value.lastSuccessAt > value.lastErrorAt) &&
        ifIdentityCurrent &&
        now - value.lastSuccessAt <= HEALTHY_TTL_MS
      ) {
        return {status: 'ok', stale: false, reason: 'interrupted-check'};
      }
      return {status: 'unknown', stale: true, reason: 'interrupted-check'};
    }
    if (!ifIdentityCurrent) {
      return {status: 'unknown', stale: true, reason: 'candidate-changed'};
    }
    if (
      value.status === 'ok' &&
      value.lastCheckedAt &&
      value.lastSuccessAt &&
      now - value.lastSuccessAt <= HEALTHY_TTL_MS
    ) {
      return {status: 'ok', stale: false, reason: null};
    }
    if (value.status === 'ok') {
      return {status: 'unknown', stale: true, reason: 'healthy-expired'};
    }
    if (
      value.status === 'error' &&
      value.lastCheckedAt &&
      value.lastErrorAt &&
      value.sessionId === expected.sessionId &&
      now - value.lastErrorAt <= FAILED_TTL_MS
    ) {
      return {status: 'error', stale: false, reason: null};
    }
    if (value.status === 'error' && value.sessionId !== expected.sessionId) {
      return {status: 'unknown', stale: true, reason: 'previous-session'};
    }
    if (value.status === 'error') {
      return {status: 'unknown', stale: true, reason: 'failure-expired'};
    }
    return {status: 'unknown', stale: true, reason: 'no-result'};

  }

  function createSessionId() {

    if (crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');

  }

  function ensureSessionId() {

    if (sessionIdPromise) {
      return sessionIdPromise;
    }
    sessionIdPromise = new Promise((resolve, reject) => {
      const area = chrome.storage && chrome.storage.session;
      if (!area || typeof area.get !== 'function' || typeof area.set !== 'function') {
        reject(new Error('Session storage is unavailable.'));
        return;
      }
      area.get({[SESSION_STORAGE_KEY]: null}, (items) => {
        const readError = chrome.runtime.lastError;
        if (readError) {
          reject(new Error(readError.message));
          return;
        }
        const current = items && items[SESSION_STORAGE_KEY];
        if (typeof current === 'string' && current) {
          resolve(current);
          return;
        }
        const sessionId = createSessionId();
        area.set({[SESSION_STORAGE_KEY]: sessionId}, () => {
          const writeError = chrome.runtime.lastError;
          if (writeError) {
            reject(new Error(writeError.message));
            return;
          }
          resolve(sessionId);
        });
      });
    }).catch((err) => {
      sessionIdPromise = null;
      throw err;
    });
    return sessionIdPromise;

  }

  function getAlarm() {

    return new Promise((resolve) => {
      chrome.alarms.get(ALARM_NAME, (alarm) => resolve(alarm || null));
    });

  }

  function getAlarmTime(alarm) {

    if (!alarm) {
      return null;
    }
    return Number(alarm.scheduledTime || alarm.when) || null;

  }

  async function reconcileAlarm(when) {

    const requestedAt = Number(when) || null;
    const alarm = await getAlarm();
    const scheduledAt = getAlarmTime(alarm);
    if (!requestedAt) {
      if (!alarm) {
        return {status: 'absent', scheduledAt: null};
      }
      await new Promise((resolve) => chrome.alarms.clear(ALARM_NAME, resolve));
      return {status: 'cleared', scheduledAt: null};
    }
    if (scheduledAt && Math.abs(scheduledAt - requestedAt) < 1000) {
      return {status: 'unchanged', scheduledAt};
    }
    chrome.alarms.create(ALARM_NAME, {when: requestedAt});
    return {status: 'scheduled', scheduledAt: requestedAt};

  }

  function getNotificationKey(errorCode, candidateType) {

    return `${normalizeErrorCode(errorCode)}:${String(candidateType || 'unknown')}`;

  }

  function shouldNotify(previous, errorCode, candidateType, now = Date.now()) {

    const health = previous && typeof previous === 'object' ? previous : {};
    const key = getNotificationKey(errorCode, candidateType);
    return health.lastNotificationKey !== key ||
      !health.lastNotificationAt ||
      now - health.lastNotificationAt >= NOTIFICATION_COOLDOWN_MS;

  }

  function selfTest() {

    const samplePassword = ['sec', 'ret'].join('');
    const own = getCandidateSummary({
      ownProxies: [{
        enabled: true,
        type: 'HTTPS',
        host: 'proxy.example',
        port: 8443,
        username: 'user',
        password: samplePassword,
      }],
    });
    return {
      proxyConnectionFailureDetected:
        isProxyError('net::ERR_PROXY_CONNECTION_FAILED'),
      socksFailureDetected:
        isProxyError('net::ERR_SOCKS_CONNECTION_FAILED'),
      dnsFailureIgnored: !isProxyError('net::ERR_NAME_NOT_RESOLVED'),
      canceledRequestIgnored: !isProxyError('net::ERR_ABORTED'),
      originDropsPathAndQuery:
        sanitizeOrigin('https://example.com/private?q=secret') ===
        'https://example.com',
      hostnameDropsPathAndQuery:
        sanitizeHostname('https://example.com/private?q=secret') ===
        'example.com',
      ownProxySummaryHasNoCredentials:
        own.endpoint === 'proxy.example:8443' &&
        !JSON.stringify(own).includes(samplePassword),
      candidateFingerprintHasNoCredentials:
        !getCandidateFingerprint({
          ownProxies: [{
            enabled: true,
            type: 'HTTPS',
            host: 'proxy.example',
            port: 8443,
            username: 'user',
            password: samplePassword,
          }],
        }).includes(samplePassword),
      torBrowserSummary:
        getCandidateSummary({torBrowser: {enabled: true}}).key ===
        'torBrowser|SOCKS5|127.0.0.1:9150',
      localTorSummary:
        getCandidateSummary({localTor: {enabled: true}}).key ===
        'localTor|SOCKS5|127.0.0.1:9050',
      retrySchedule:
        FAILURE_RETRY_MS.map((value, index) => getFailureRetryMs(index))
            .join(',') === FAILURE_RETRY_MS.join(','),
      retryScheduleCaps:
        getFailureRetryMs(99) === FAILURE_RETRY_MS[4] &&
        getNextRetryStep(4) === 4,
      duplicateNotificationLimited:
        shouldNotify({
          lastNotificationKey:
            'net::ERR_PROXY_CONNECTION_FAILED:torBrowser',
          lastNotificationAt: 1000,
        }, 'net::ERR_PROXY_CONNECTION_FAILED', 'torBrowser', 2000) === false,
      notificationAllowedAfterCooldown:
        shouldNotify({
          lastNotificationKey:
            'net::ERR_PROXY_CONNECTION_FAILED:torBrowser',
          lastNotificationAt: 1000,
        }, 'net::ERR_PROXY_CONNECTION_FAILED', 'torBrowser',
        1000 + NOTIFICATION_COOLDOWN_MS) === true,
    };

  }

  exports.mv3ProxyHealth = Object.freeze({
    CHECK_TIMEOUT_MS,
    NOTIFICATION_COOLDOWN_MS,
    ALARM_NAME,
    SESSION_STORAGE_KEY,
    STARTUP_DELAY_MS,
    HEALTHY_TTL_MS,
    FAILED_TTL_MS,
    INCONCLUSIVE_RETRY_MS,
    FAILURE_RETRY_MS,
    PROXY_ERROR_CODES,
    normalizeErrorCode,
    isProxyError,
    sanitizeHostname,
    sanitizeOrigin,
    sanitizeEndpoint,
    createCandidateSummary,
    getCandidateSummary,
    getCandidateFingerprint,
    normalizeRetryStep,
    getFailureRetryMs,
    getNextRetryStep,
    classifyFreshness,
    ensureSessionId,
    getAlarm,
    reconcileAlarm,
    getNotificationKey,
    shouldNotify,
    selfTest,
  });

})(self);
