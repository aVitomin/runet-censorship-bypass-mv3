'use strict';

/* global mv3PacMods */

(function(exports) {

  const CHECK_TIMEOUT_MS = 9000;
  const ERROR_DEBOUNCE_MS = 10 * 1000;
  const NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;
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
      return {
        type: 'ownProxy',
        endpoint: sanitizeEndpoint(ownProxy.host, ownProxy.port),
      };
    }
    if (normalized.localTor.enabled) {
      return {
        type: 'localTor',
        endpoint: sanitizeEndpoint(
            normalized.localTor.host,
            normalized.localTor.port,
        ),
      };
    }
    if (normalized.torBrowser.enabled) {
      return {
        type: 'torBrowser',
        endpoint: sanitizeEndpoint(
            normalized.torBrowser.host,
            normalized.torBrowser.port,
        ),
      };
    }
    if (normalized.warp.enabled) {
      const candidate = mv3PacMods.splitProxyString(
          normalized.warp.proxyString,
      )[0];
      const parsed = candidate ? mv3PacMods.parseProxyString(candidate) : null;
      return {
        type: 'warp',
        endpoint: parsed ? sanitizeEndpoint(parsed.host, parsed.port) : '',
      };
    }
    return {
      type: null,
      endpoint: '',
    };

  }

  function getCandidateFingerprint(pacMods) {

    const normalized = mv3PacMods.normalizePacMods(pacMods);
    return JSON.stringify({
      localTor: normalized.localTor,
      torBrowser: normalized.torBrowser,
      warp: normalized.warp,
      ownProxies: normalized.ownProxies,
    });

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
      torBrowserSummary:
        getCandidateSummary({torBrowser: {enabled: true}}).type ===
        'torBrowser',
      localTorSummary:
        getCandidateSummary({localTor: {enabled: true}}).type === 'localTor',
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
    ERROR_DEBOUNCE_MS,
    NOTIFICATION_COOLDOWN_MS,
    PROXY_ERROR_CODES,
    normalizeErrorCode,
    isProxyError,
    sanitizeHostname,
    sanitizeOrigin,
    sanitizeEndpoint,
    getCandidateSummary,
    getCandidateFingerprint,
    getNotificationKey,
    shouldNotify,
    selfTest,
  });

})(self);
