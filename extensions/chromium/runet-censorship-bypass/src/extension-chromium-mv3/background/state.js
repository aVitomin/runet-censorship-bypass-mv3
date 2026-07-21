'use strict';

/* global mv3PacArtifacts, mv3PacMods, mv3Providers, mv3Storage */

(function(exports) {

  const STORAGE_KEY = 'mv3State';
  const PAC_DOWNLOAD_STATUSES = Object.freeze([
    'idle',
    'downloading',
    'success',
    'error',
    'not_modified',
  ]);
  const PAC_COOK_STATUSES = Object.freeze([
    'idle',
    'cooking',
    'success',
    'error',
  ]);
  const PROXY_APPLY_STATUSES = Object.freeze([
    'idle',
    'applying',
    'applied',
    'clearing',
    'cleared',
    'error',
  ]);
  const PROXY_AUTH_STATUSES = Object.freeze([
    'idle',
    'ready',
    'challenge_seen',
    'provided',
    'missing_credentials',
    'retry_limit',
    'error',
  ]);
  const PROXY_HEALTH_STATUSES = Object.freeze([
    'unknown',
    'checking',
    'ok',
    'error',
  ]);
  const PERIODIC_UPDATE_STATUSES = Object.freeze([
    'idle',
    'scheduled',
    'running',
    'success',
    'error',
    'skipped',
  ]);
  const LEGACY_MIGRATION_STATUSES = Object.freeze([
    'idle',
    'running',
    'success',
    'error',
  ]);
  const LEGACY_MIGRATION_APPLY_STATUSES = Object.freeze([
    'idle',
    'running',
    'success',
    'error',
    'partial',
  ]);
  const MAX_PROXY_AUTH_EVENTS = 20;
  const MAX_PERIODIC_UPDATE_EVENTS = 20;
  const MAX_LEGACY_MIGRATION_WARNINGS = 20;
  const MIN_PERIODIC_UPDATE_INTERVAL_MINUTES = 1;
  const MAX_PERIODIC_UPDATE_INTERVAL_MINUTES = 24 * 60;
  const ATOMIC_NO_CHANGE = Object.freeze({});
  let stateOperationQueue = Promise.resolve();
  let ifAtomicMutatorActive = false;
  let atomicReentryError = null;

  const DEFAULT_STATE = Object.freeze({
    schemaVersion: 12,
    mv3: true,
    uiLanguage: 'auto',
    currentPacProviderKey: null,
    customPacProviders: Object.freeze([]),
    lastPacUpdateStamp: null,
    pacUpdatePeriodInMinutes: 12,
    pacModsRevision: 0,
    pacMods: mv3PacMods.DEFAULT_PAC_MODS,
    notificationPrefs: Object.freeze({
      pacError: true,
      extError: true,
      noControl: true,
    }),
    pacDownload: Object.freeze({
      status: 'idle',
      providerKey: null,
      url: null,
      startedAt: null,
      finishedAt: null,
      httpStatus: null,
      contentLength: null,
      sha256: null,
      lastModified: null,
      etag: null,
      error: null,
    }),
    pacCache: Object.freeze({
      providerKey: null,
      url: null,
      fetchedAt: null,
      rawPacSha256: null,
      rawPacSize: null,
      lastModified: null,
      etag: null,
      artifactRef: null,
    }),
    pacCook: Object.freeze({
      status: 'idle',
      providerKey: null,
      sourceRawPacSha256: null,
      pacModsSha256: null,
      startedAt: null,
      finishedAt: null,
      cookedPacSha256: null,
      cookedContentLength: null,
      warnings: Object.freeze([]),
      error: null,
    }),
    cookedPacCache: Object.freeze({
      providerKey: null,
      cookedAt: null,
      sourceRawPacSha256: null,
      pacModsSha256: null,
      cookedPacSha256: null,
      cookedPacSize: null,
      warnings: Object.freeze([]),
      artifactRef: null,
    }),
    proxyApply: Object.freeze({
      status: 'idle',
      providerKey: null,
      cookedPacSha256: null,
      appliedAt: null,
      clearedAt: null,
      levelOfControl: null,
      error: null,
      warnings: Object.freeze([]),
    }),
    proxyControl: Object.freeze({
      checkedAt: null,
      levelOfControl: null,
      controlledByThisExtension: false,
      canControl: false,
      rawValue: null,
      error: null,
    }),
    proxyHealth: Object.freeze({
      status: 'unknown',
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorUrl: null,
      candidateType: null,
      candidateEndpoint: null,
      targetOrigin: null,
      lastNotificationAt: null,
      lastNotificationKey: null,
    }),
    artifactMigration: Object.freeze({
      lastAttemptAt: null,
      rawPacMigrated: false,
      cookedPacMigrated: false,
      warnings: Object.freeze([]),
      error: null,
    }),
    proxyAuth: Object.freeze({
      enabled: true,
      status: 'idle',
      lastUpdatedAt: null,
      lastChallengeAt: null,
      lastProvidedAt: null,
      lastError: null,
      stats: Object.freeze({
        challenges: 0,
        provided: 0,
        missingCredentials: 0,
        retryLimit: 0,
        nonProxyChallengesIgnored: 0,
      }),
      lastEvents: Object.freeze([]),
    }),
    periodicUpdate: Object.freeze({
      enabled: true,
      intervalMinutes: 12 * 60,
      status: 'idle',
      lastAttemptAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessfulUpdateAt: null,
      lastSuccessfulProviderKey: null,
      lastFailureAt: null,
      lastFailureCode: null,
      nextRunAt: null,
      lastResult: null,
      lastError: null,
      consecutiveFailures: 0,
      lastEvents: Object.freeze([]),
    }),
    legacyMigration: Object.freeze({
      auditStatus: 'idle',
      applyStatus: 'idle',
      lastAuditAt: null,
      lastApplyAt: null,
      detectedLegacyData: false,
      applied: false,
      appliedFields: Object.freeze([]),
      skippedFields: Object.freeze([]),
      conflicts: Object.freeze([]),
      lastSummary: null,
      lastApplySummary: null,
      lastError: null,
      warnings: Object.freeze([]),
    }),
  });

  function clone(value) {

    return JSON.parse(JSON.stringify(value));

  }

  function freezeRecursively(value) {

    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.keys(value).forEach((key) => freezeRecursively(value[key]));
    return Object.freeze(value);

  }

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function assertObject(value, name) {

    if (!isObject(value)) {
      throw new TypeError(`${name} must be an object.`);
    }

  }

  function normalizeStringArray(value, name, ifStrict) {

    if (value === undefined) {
      return [];
    }
    if (!Array.isArray(value)) {
      if (ifStrict) {
        throw new TypeError(`${name} must be an array.`);
      }
      return [];
    }
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item);

  }

  function normalizeBoolean(value, defaultValue, name, ifStrict) {

    if (value === undefined) {
      return defaultValue;
    }
    if (typeof value !== 'boolean') {
      if (ifStrict) {
        throw new TypeError(`${name} must be a boolean.`);
      }
      return defaultValue;
    }
    return value;

  }

  function normalizePacMods(value, ifStrict = false) {

    if (ifStrict) {
      assertObject(value, 'pacMods');
    }
    return mv3PacMods.normalizePacMods(value);

  }

  function normalizeNotificationPrefs(value, ifStrict = false) {

    if (ifStrict) {
      assertObject(value, 'prefs');
    }
    const source = isObject(value) ? value : {};
    const defaults = DEFAULT_STATE.notificationPrefs;
    return {
      pacError: normalizeBoolean(source.pacError, defaults.pacError, 'pacError', ifStrict),
      extError: normalizeBoolean(source.extError, defaults.extError, 'extError', ifStrict),
      noControl: normalizeBoolean(source.noControl, defaults.noControl, 'noControl', ifStrict),
    };

  }

  function normalizePacUpdatePeriod(value) {

    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return DEFAULT_STATE.pacUpdatePeriodInMinutes;
    }
    return Math.round(value);

  }

  function normalizePeriodicUpdateInterval(value, ifStrict = false) {

    const parsed = Number(value);
    if (
      !Number.isFinite(parsed) ||
      parsed < MIN_PERIODIC_UPDATE_INTERVAL_MINUTES ||
      parsed > MAX_PERIODIC_UPDATE_INTERVAL_MINUTES
    ) {
      if (ifStrict) {
        throw new TypeError(
            `intervalMinutes must be between ` +
            `${MIN_PERIODIC_UPDATE_INTERVAL_MINUTES} and ` +
            `${MAX_PERIODIC_UPDATE_INTERVAL_MINUTES}.`,
        );
      }
      return DEFAULT_STATE.periodicUpdate.intervalMinutes;
    }
    return Math.round(parsed);

  }

  function normalizeNullableString(value) {

    return typeof value === 'string' && value ? value : null;

  }

  function normalizeNullableNumber(value) {

    return typeof value === 'number' && Number.isFinite(value) ? value : null;

  }

  function normalizePacDownloadError(value) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || 'PAC_DOWNLOAD_FAILED',
      message: message || 'PAC download failed.',
      details: value.details === undefined ? null : value.details,
    };

  }

  function normalizePacCookError(value) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || 'PAC_COOK_FAILED',
      message: message || 'PAC cooking failed.',
      details: value.details === undefined ? null : value.details,
    };

  }

  function normalizeProxyError(value, fallbackCode, fallbackMessage) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || fallbackCode,
      message: message || fallbackMessage,
      details: value.details === undefined ? null : value.details,
    };

  }

  function normalizeArtifactMigrationError(value) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || 'PAC_ARTIFACT_STORE_FAILED',
      message: message || 'PAC artifact migration failed.',
      details: value.details === undefined ? null : value.details,
    };

  }

  function normalizeProxyAuthError(value) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || 'PROXY_AUTH_ERROR',
      message: message || 'Proxy auth failed.',
      details: value.details === undefined ? null : value.details,
    };

  }

  function cloneWithoutPacText(value) {

    if (value === null || value === undefined) {
      return null;
    }
    return sanitizeRpcValue(value);

  }

  function sanitizeRpcText(value) {

    return String(value || '')
        .replace(
            /([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi,
            '$1***@',
        )
        .replace(
            /(\b(?:PROXY|HTTPS|SOCKS4|SOCKS5)\s+)[^\s;@]+@/gi,
            '$1***@',
        )
        .replace(
            /(\b(?:password|passwd|pwd)\s*[=:]\s*)[^\s,;]+/gi,
            '$1***',
        );

  }

  function sanitizeRpcValue(value, ancestors = new Set(), parentKey = '') {

    if (typeof value === 'string') {
      return sanitizeRpcText(value);
    }
    if (value === null || value === undefined || typeof value !== 'object') {
      return value;
    }
    if (parentKey === 'pacMods') {
      const credentialRevision = Number.isSafeInteger(value.credentialRevision) ?
        value.credentialRevision :
        undefined;
      return sanitizeRpcValue(
          mv3PacMods.serializePacModsForRpc(value, credentialRevision),
          ancestors,
          'rpcSafePacMods',
      );
    }
    if (parentKey === 'authCredentials') {
      return {
        hasCredentials: Boolean(value.username || value.password),
      };
    }
    if (ancestors.has(value)) {
      return null;
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      const sanitized = value.map((item) =>
        sanitizeRpcValue(item, ancestors, parentKey),
      );
      ancestors.delete(value);
      return sanitized;
    }
    const sanitized = Object.keys(value).reduce((result, key) => {
      const loweredKey = key.toLowerCase();
      const ifPasswordKey = loweredKey === 'password' ||
        (loweredKey.endsWith('password') && loweredKey !== 'haspassword');
      if (
        !ifPasswordKey &&
        !(parentKey === 'pacScript' && key === 'data') &&
        key !== 'rawPacData' &&
        key !== 'cookedPacData' &&
        key !== 'rawPacPreview' &&
        key !== 'cookedPacPreview' &&
        key !== 'pacModsSha256' &&
        key !== 'currentPacModsSha256'
      ) {
        result[key] = sanitizeRpcValue(value[key], ancestors, key);
      }
      return result;
    }, {});
    ancestors.delete(value);
    return sanitized;

  }

  function normalizePeriodicUpdateError(value) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || 'PERIODIC_UPDATE_FAILED',
      message: message || 'Periodic update failed.',
      details: cloneWithoutPacText(value.details),
    };

  }

  function normalizeLegacyMigrationError(value) {

    if (!isObject(value)) {
      return null;
    }
    const code = normalizeNullableString(value.code);
    const message = normalizeNullableString(value.message);
    if (!code && !message) {
      return null;
    }
    return {
      code: code || 'LEGACY_MIGRATION_AUDIT_FAILED',
      message: message || 'Legacy migration audit failed.',
      details: cloneWithoutPacText(value.details),
    };

  }

  function redactSensitiveText(value) {

    return String(value || '').replace(
        /([^\s:@;]+):([^\s@;]+)@/g,
        (match, username) => {
          const name = String(username || '');
          const redactedName = name.length <= 2 ?
            '*'.repeat(name.length) :
            `${name[0]}***${name[name.length - 1]}`;
          return `${redactedName}:***@`;
        },
    );

  }

  function sanitizeLegacyMigrationValue(value, key = '') {

    const loweredKey = String(key || '').toLowerCase();
    if (
      loweredKey.includes('password') ||
      loweredKey.includes('rawpacdata') ||
      loweredKey.includes('cookedpacdata') ||
      loweredKey.includes('pac-data')
    ) {
      return '[redacted]';
    }
    if (typeof value === 'string') {
      return redactSensitiveText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeLegacyMigrationValue(item, key));
    }
    if (isObject(value)) {
      return Object.keys(value).sort().reduce((acc, childKey) => {
        acc[childKey] = sanitizeLegacyMigrationValue(value[childKey], childKey);
        return acc;
      }, {});
    }
    return value === undefined ? null : value;

  }

  function normalizeLegacyMigrationItems(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    return value
        .map((item) => sanitizeLegacyMigrationValue(item))
        .slice(-MAX_LEGACY_MIGRATION_WARNINGS);

  }

  function normalizeLegacyMigrationApplySummary(value) {

    if (!isObject(value)) {
      return null;
    }
    return sanitizeLegacyMigrationValue({
      status: normalizeNullableString(value.status),
      strategy: normalizeNullableString(value.strategy),
      appliedFields: normalizeStringArray(
          value.appliedFields,
          'appliedFields',
          false,
      ),
      skippedFields: normalizeLegacyMigrationItems(value.skippedFields),
      conflicts: normalizeLegacyMigrationItems(value.conflicts),
      warnings: normalizeStringArray(value.warnings, 'warnings', false)
          .slice(-MAX_LEGACY_MIGRATION_WARNINGS),
    });

  }

  function normalizePacDownload(value) {

    const source = isObject(value) ? value : {};
    const status = PAC_DOWNLOAD_STATUSES.includes(source.status) ?
      source.status :
      DEFAULT_STATE.pacDownload.status;
    return {
      status,
      providerKey: normalizeNullableString(source.providerKey),
      url: normalizeNullableString(source.url),
      startedAt: normalizeNullableNumber(source.startedAt),
      finishedAt: normalizeNullableNumber(source.finishedAt),
      httpStatus: normalizeNullableNumber(source.httpStatus),
      contentLength: normalizeNullableNumber(source.contentLength),
      sha256: normalizeNullableString(source.sha256),
      lastModified: normalizeNullableString(source.lastModified),
      etag: normalizeNullableString(source.etag),
      error: normalizePacDownloadError(source.error),
    };

  }

  function normalizePacCache(value) {

    const source = isObject(value) ? value : {};
    const rawPacSize = normalizeNullableNumber(source.rawPacSize) ||
      normalizeNullableNumber(source.contentLength) ||
      normalizeNullableNumber(
          typeof source.rawPacData === 'string' ? source.rawPacData.length : null,
      );
    return {
      providerKey: normalizeNullableString(source.providerKey),
      url: normalizeNullableString(source.url),
      fetchedAt: normalizeNullableNumber(source.fetchedAt),
      rawPacSha256: normalizeNullableString(source.rawPacSha256),
      rawPacSize,
      lastModified: normalizeNullableString(source.lastModified),
      etag: normalizeNullableString(source.etag),
      artifactRef: normalizeNullableString(source.artifactRef),
    };

  }

  function normalizePacCook(value) {

    const source = isObject(value) ? value : {};
    const status = PAC_COOK_STATUSES.includes(source.status) ?
      source.status :
      DEFAULT_STATE.pacCook.status;
    return {
      status,
      providerKey: normalizeNullableString(source.providerKey),
      sourceRawPacSha256: normalizeNullableString(source.sourceRawPacSha256),
      pacModsSha256: normalizeNullableString(source.pacModsSha256),
      startedAt: normalizeNullableNumber(source.startedAt),
      finishedAt: normalizeNullableNumber(source.finishedAt),
      cookedPacSha256: normalizeNullableString(source.cookedPacSha256),
      cookedContentLength: normalizeNullableNumber(source.cookedContentLength),
      warnings: normalizeStringArray(source.warnings, 'warnings', false),
      error: normalizePacCookError(source.error),
    };

  }

  function normalizeCookedPacCache(value) {

    const source = isObject(value) ? value : {};
    const cookedPacSize = normalizeNullableNumber(source.cookedPacSize) ||
      normalizeNullableNumber(source.cookedContentLength) ||
      normalizeNullableNumber(
          typeof source.cookedPacData === 'string' ?
            source.cookedPacData.length :
            null,
      );
    return {
      providerKey: normalizeNullableString(source.providerKey),
      cookedAt: normalizeNullableNumber(source.cookedAt),
      sourceRawPacSha256: normalizeNullableString(source.sourceRawPacSha256),
      pacModsSha256: normalizeNullableString(source.pacModsSha256),
      cookedPacSha256: normalizeNullableString(source.cookedPacSha256),
      cookedPacSize,
      warnings: normalizeStringArray(source.warnings, 'warnings', false),
      artifactRef: normalizeNullableString(source.artifactRef),
    };

  }

  function normalizeProxyApply(value) {

    const source = isObject(value) ? value : {};
    const status = PROXY_APPLY_STATUSES.includes(source.status) ?
      source.status :
      DEFAULT_STATE.proxyApply.status;
    return {
      status,
      providerKey: normalizeNullableString(source.providerKey),
      cookedPacSha256: normalizeNullableString(source.cookedPacSha256),
      appliedAt: normalizeNullableNumber(source.appliedAt),
      clearedAt: normalizeNullableNumber(source.clearedAt),
      levelOfControl: normalizeNullableString(source.levelOfControl),
      error: normalizeProxyError(
          source.error,
          'PROXY_SET_FAILED',
          'Proxy settings operation failed.',
      ),
      warnings: normalizeStringArray(source.warnings, 'warnings', false),
    };

  }

  function normalizeProxyControl(value) {

    const source = isObject(value) ? value : {};
    return {
      checkedAt: normalizeNullableNumber(source.checkedAt),
      levelOfControl: normalizeNullableString(source.levelOfControl),
      controlledByThisExtension: normalizeBoolean(
          source.controlledByThisExtension,
          DEFAULT_STATE.proxyControl.controlledByThisExtension,
          'controlledByThisExtension',
          false,
      ),
      canControl: normalizeBoolean(
          source.canControl,
          DEFAULT_STATE.proxyControl.canControl,
          'canControl',
          false,
      ),
      rawValue: source.rawValue === undefined ? null : source.rawValue,
      error: normalizeProxyError(
          source.error,
          'PROXY_READ_FAILED',
          'Proxy control check failed.',
      ),
    };

  }

  function normalizeProxyHealth(value) {

    const source = isObject(value) ? value : {};
    const status = PROXY_HEALTH_STATUSES.includes(source.status) ?
      source.status :
      DEFAULT_STATE.proxyHealth.status;
    const candidateType = [
      'localTor',
      'torBrowser',
      'warp',
      'ownProxy',
    ].includes(source.candidateType) ? source.candidateType : null;
    return {
      status,
      lastCheckedAt: normalizeNullableNumber(source.lastCheckedAt),
      lastSuccessAt: normalizeNullableNumber(source.lastSuccessAt),
      lastErrorAt: normalizeNullableNumber(source.lastErrorAt),
      lastErrorCode: normalizeNullableString(source.lastErrorCode),
      lastErrorMessage: normalizeNullableString(source.lastErrorMessage),
      lastErrorUrl: normalizeNullableString(source.lastErrorUrl),
      candidateType,
      candidateEndpoint: normalizeNullableString(source.candidateEndpoint),
      targetOrigin: normalizeNullableString(source.targetOrigin),
      lastNotificationAt: normalizeNullableNumber(source.lastNotificationAt),
      lastNotificationKey: normalizeNullableString(source.lastNotificationKey),
    };

  }

  function normalizeArtifactMigration(value) {

    const source = isObject(value) ? value : {};
    return {
      lastAttemptAt: normalizeNullableNumber(source.lastAttemptAt),
      rawPacMigrated: normalizeBoolean(
          source.rawPacMigrated,
          DEFAULT_STATE.artifactMigration.rawPacMigrated,
          'rawPacMigrated',
          false,
      ),
      cookedPacMigrated: normalizeBoolean(
          source.cookedPacMigrated,
          DEFAULT_STATE.artifactMigration.cookedPacMigrated,
          'cookedPacMigrated',
          false,
      ),
      warnings: normalizeStringArray(source.warnings, 'warnings', false),
      error: normalizeArtifactMigrationError(source.error),
    };

  }

  function normalizeProxyAuthStats(value) {

    const source = isObject(value) ? value : {};
    const defaults = DEFAULT_STATE.proxyAuth.stats;
    return {
      challenges: normalizeNullableNumber(source.challenges) || defaults.challenges,
      provided: normalizeNullableNumber(source.provided) || defaults.provided,
      missingCredentials: normalizeNullableNumber(source.missingCredentials) ||
        defaults.missingCredentials,
      retryLimit: normalizeNullableNumber(source.retryLimit) || defaults.retryLimit,
      nonProxyChallengesIgnored:
        normalizeNullableNumber(source.nonProxyChallengesIgnored) ||
        defaults.nonProxyChallengesIgnored,
    };

  }

  function redactProxyAuthUsername(username) {

    if (!username) {
      return '';
    }
    if (username.length <= 2) {
      return '*'.repeat(username.length);
    }
    return `${username[0]}***${username[username.length - 1]}`;

  }

  function normalizeProxyAuthEvent(value) {

    const source = isObject(value) ? value : {};
    return {
      type: normalizeNullableString(source.type) || 'event',
      at: normalizeNullableNumber(source.at) || Date.now(),
      requestId: normalizeNullableString(source.requestId),
      isProxy: source.isProxy === true,
      host: normalizeNullableString(source.host),
      port: normalizeNullableString(source.port),
      hasCredentials: source.hasCredentials === true,
      username: redactProxyAuthUsername(source.username || ''),
      message: normalizeNullableString(source.message),
    };

  }

  function normalizeProxyAuthEvents(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    return value
        .map(normalizeProxyAuthEvent)
        .slice(-MAX_PROXY_AUTH_EVENTS);

  }

  function normalizeProxyAuth(value) {

    const source = isObject(value) ? value : {};
    const status = PROXY_AUTH_STATUSES.includes(source.status) ?
      source.status :
      DEFAULT_STATE.proxyAuth.status;
    return {
      enabled: normalizeBoolean(
          source.enabled,
          DEFAULT_STATE.proxyAuth.enabled,
          'enabled',
          false,
      ),
      status,
      lastUpdatedAt: normalizeNullableNumber(source.lastUpdatedAt),
      lastChallengeAt: normalizeNullableNumber(source.lastChallengeAt),
      lastProvidedAt: normalizeNullableNumber(source.lastProvidedAt),
      lastError: normalizeProxyAuthError(source.lastError),
      stats: normalizeProxyAuthStats(source.stats),
      lastEvents: normalizeProxyAuthEvents(source.lastEvents),
    };

  }

  function normalizePeriodicUpdateEvent(value) {

    const source = isObject(value) ? value : {};
    const error = normalizePeriodicUpdateError(source.error);
    return {
      type: normalizeNullableString(source.type) || 'event',
      at: normalizeNullableNumber(source.at) || Date.now(),
      trigger: normalizeNullableString(source.trigger),
      providerKey: normalizeNullableString(source.providerKey),
      status: normalizeNullableString(source.status),
      message: normalizeNullableString(source.message),
      error,
    };

  }

  function normalizePeriodicUpdateEvents(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    return value
        .map(normalizePeriodicUpdateEvent)
        .slice(-MAX_PERIODIC_UPDATE_EVENTS);

  }

  function normalizePeriodicUpdate(value, options = {}) {

    const source = isObject(value) ? value : {};
    const ifLegacySchema = Number(options.schemaVersion || 0) < 11;
    const status = PERIODIC_UPDATE_STATUSES.includes(source.status) ?
      source.status :
      DEFAULT_STATE.periodicUpdate.status;
    const lastSuccessfulUpdateAt =
      normalizeNullableNumber(source.lastSuccessfulUpdateAt) ||
      (ifLegacySchema && source.status === 'success' ?
        normalizeNullableNumber(source.lastFinishedAt) :
        null) ||
      (ifLegacySchema ?
        normalizeNullableNumber(options.fallbackSuccessfulUpdateAt) :
        null);
    return {
      enabled: ifLegacySchema ? true : normalizeBoolean(
          source.enabled,
          DEFAULT_STATE.periodicUpdate.enabled,
          'enabled',
          false,
      ),
      intervalMinutes: ifLegacySchema ?
        DEFAULT_STATE.periodicUpdate.intervalMinutes :
        normalizePeriodicUpdateInterval(source.intervalMinutes),
      status,
      lastAttemptAt: normalizeNullableNumber(source.lastAttemptAt) ||
        normalizeNullableNumber(source.lastStartedAt),
      lastStartedAt: normalizeNullableNumber(source.lastStartedAt),
      lastFinishedAt: normalizeNullableNumber(source.lastFinishedAt),
      lastSuccessfulUpdateAt,
      lastSuccessfulProviderKey:
        normalizeNullableString(source.lastSuccessfulProviderKey) ||
        (lastSuccessfulUpdateAt ?
          normalizeNullableString(options.fallbackProviderKey) :
          null),
      lastFailureAt: normalizeNullableNumber(source.lastFailureAt),
      lastFailureCode: normalizeNullableString(source.lastFailureCode),
      nextRunAt: normalizeNullableNumber(source.nextRunAt),
      lastResult: cloneWithoutPacText(source.lastResult),
      lastError: normalizePeriodicUpdateError(source.lastError),
      consecutiveFailures: normalizeNullableNumber(source.consecutiveFailures) ||
        DEFAULT_STATE.periodicUpdate.consecutiveFailures,
      lastEvents: normalizePeriodicUpdateEvents(source.lastEvents),
    };

  }

  function normalizeLegacyMigrationSourceSummary(value) {

    const source = isObject(value) ? value : {};
    return {
      checked: source.checked === true,
      keysFound: normalizeStringArray(source.keysFound, 'keysFound', false),
      warnings: normalizeStringArray(source.warnings, 'warnings', false)
          .slice(-MAX_LEGACY_MIGRATION_WARNINGS),
    };

  }

  function normalizeLegacyMigrationSummary(value) {

    if (!isObject(value)) {
      return null;
    }
    const sources = isObject(value.sources) ? value.sources : {};
    return {
      detected: value.detected === true,
      checkedAt: normalizeNullableNumber(value.checkedAt),
      installType: normalizeNullableString(value.installType) || 'unknown',
      sources: {
        chromeStorageLocal: normalizeLegacyMigrationSourceSummary(
            sources.chromeStorageLocal,
        ),
        localStorage: normalizeLegacyMigrationSourceSummary(
            sources.localStorage,
        ),
      },
      proposedKeys: normalizeStringArray(value.proposedKeys, 'proposedKeys', false),
      cannotMigrateCount: normalizeNullableNumber(value.cannotMigrateCount) || 0,
      conflictCount: normalizeNullableNumber(value.conflictCount) || 0,
      warningCount: normalizeNullableNumber(value.warningCount) || 0,
      sensitiveFieldsRedacted: value.sensitiveFieldsRedacted !== false,
    };

  }

  function normalizeLegacyMigration(value) {

    const source = isObject(value) ? value : {};
    const status = LEGACY_MIGRATION_STATUSES.includes(source.auditStatus) ?
      source.auditStatus :
      DEFAULT_STATE.legacyMigration.auditStatus;
    const applyStatus = LEGACY_MIGRATION_APPLY_STATUSES.includes(
        source.applyStatus,
    ) ?
      source.applyStatus :
      DEFAULT_STATE.legacyMigration.applyStatus;
    return {
      auditStatus: status,
      applyStatus,
      lastAuditAt: normalizeNullableNumber(source.lastAuditAt),
      lastApplyAt: normalizeNullableNumber(source.lastApplyAt),
      detectedLegacyData: source.detectedLegacyData === true,
      applied: source.applied === true,
      appliedFields: normalizeStringArray(
          source.appliedFields,
          'appliedFields',
          false,
      ),
      skippedFields: normalizeLegacyMigrationItems(source.skippedFields),
      conflicts: normalizeLegacyMigrationItems(source.conflicts),
      lastSummary: normalizeLegacyMigrationSummary(source.lastSummary),
      lastApplySummary: normalizeLegacyMigrationApplySummary(
          source.lastApplySummary,
      ),
      lastError: normalizeLegacyMigrationError(source.lastError),
      warnings: normalizeStringArray(source.warnings, 'warnings', false)
          .slice(-MAX_LEGACY_MIGRATION_WARNINGS),
    };

  }

  function normalizeUiLanguage(value) {

    const language = String(value || DEFAULT_STATE.uiLanguage).toLowerCase();
    return ['auto', 'ru', 'en'].includes(language) ?
      language :
      DEFAULT_STATE.uiLanguage;

  }

  function normalizeState(value) {

    const source = isObject(value) ? value : {};
    const sourceSchemaVersion = normalizeNullableNumber(source.schemaVersion) || 0;
    const currentPacProviderKey = typeof source.currentPacProviderKey === 'string' ?
      source.currentPacProviderKey :
      null;
    const lastPacUpdateStamp = typeof source.lastPacUpdateStamp === 'number' &&
      Number.isFinite(source.lastPacUpdateStamp) ?
      source.lastPacUpdateStamp :
      null;
    const pacCache = normalizePacCache(source.pacCache);
    const cookedPacCache = normalizeCookedPacCache(source.cookedPacCache);
    const fallbackSuccessfulUpdateAt =
      pacCache.providerKey &&
      cookedPacCache.providerKey === pacCache.providerKey &&
      cookedPacCache.sourceRawPacSha256 === pacCache.rawPacSha256 ?
        pacCache.fetchedAt || lastPacUpdateStamp :
        null;
    const periodicUpdate = normalizePeriodicUpdate(source.periodicUpdate, {
      schemaVersion: sourceSchemaVersion,
      fallbackSuccessfulUpdateAt,
      fallbackProviderKey: pacCache.providerKey || currentPacProviderKey,
    });

    return {
      schemaVersion: DEFAULT_STATE.schemaVersion,
      mv3: true,
      uiLanguage: normalizeUiLanguage(source.uiLanguage),
      currentPacProviderKey,
      customPacProviders: mv3Providers.normalizeCustomProviders(
          source.customPacProviders,
      ),
      lastPacUpdateStamp,
      pacUpdatePeriodInMinutes: normalizePacUpdatePeriod(
          source.pacUpdatePeriodInMinutes,
      ),
      pacModsRevision:
        Number.isSafeInteger(source.pacModsRevision) &&
        source.pacModsRevision >= 0 ?
          source.pacModsRevision :
          DEFAULT_STATE.pacModsRevision,
      pacMods: normalizePacMods(source.pacMods),
      notificationPrefs: normalizeNotificationPrefs(source.notificationPrefs),
      pacDownload: normalizePacDownload(source.pacDownload),
      pacCache,
      pacCook: normalizePacCook(source.pacCook),
      cookedPacCache,
      proxyApply: normalizeProxyApply(source.proxyApply),
      proxyControl: normalizeProxyControl(source.proxyControl),
      proxyHealth: normalizeProxyHealth(source.proxyHealth),
      artifactMigration: normalizeArtifactMigration(source.artifactMigration),
      proxyAuth: normalizeProxyAuth(source.proxyAuth),
      periodicUpdate,
      legacyMigration: normalizeLegacyMigration(source.legacyMigration),
    };

  }

  function hasInlinePacArtifactData(value) {

    const source = isObject(value) ? value : {};
    const pacCache = isObject(source.pacCache) ? source.pacCache : {};
    const cookedPacCache = isObject(source.cookedPacCache) ?
      source.cookedPacCache :
      {};
    return Boolean(
        typeof pacCache.rawPacData === 'string' && pacCache.rawPacData ||
        typeof cookedPacCache.cookedPacData === 'string' &&
          cookedPacCache.cookedPacData,
    );

  }

  function createMigrationError(err) {

    if (err && err.code && err.message) {
      return {
        code: err.code,
        message: err.message,
        details: err.details === undefined ? null : err.details,
      };
    }
    return {
      code: 'PAC_ARTIFACT_STORE_FAILED',
      message: err && err.message ? err.message : 'PAC artifact migration failed.',
      details: null,
    };

  }

  async function migrateInlinePacArtifactsIfNeeded(storedState) {

    if (!hasInlinePacArtifactData(storedState)) {
      return storedState;
    }
    if (typeof mv3PacArtifacts === 'undefined') {
      return storedState;
    }

    const source = isObject(storedState) ? clone(storedState) : {};
    const nextState = Object.assign({}, source);
    const warnings = normalizeStringArray(
        source.artifactMigration && source.artifactMigration.warnings,
        'warnings',
        false,
    );
    const migration = {
      lastAttemptAt: Date.now(),
      rawPacMigrated: false,
      cookedPacMigrated: false,
      warnings,
      error: null,
    };

    try {
      if (
        isObject(source.pacCache) &&
        typeof source.pacCache.rawPacData === 'string' &&
        source.pacCache.rawPacData &&
        source.pacCache.providerKey &&
        source.pacCache.rawPacSha256
      ) {
        const rawArtifact = await mv3PacArtifacts.putRawPacArtifact({
          providerKey: source.pacCache.providerKey,
          url: source.pacCache.url,
          rawPacData: source.pacCache.rawPacData,
          rawPacSha256: source.pacCache.rawPacSha256,
          fetchedAt: source.pacCache.fetchedAt,
          lastModified: source.pacCache.lastModified,
          etag: source.pacCache.etag,
          contentLength: source.pacCache.rawPacData.length,
        });
        nextState.pacCache = Object.assign({}, source.pacCache, {
          rawPacData: null,
          rawPacSize: rawArtifact.rawPacSize,
          artifactRef: rawArtifact.artifactRef,
        });
        delete nextState.pacCache.rawPacData;
        migration.rawPacMigrated = true;
      }

      if (
        isObject(source.cookedPacCache) &&
        typeof source.cookedPacCache.cookedPacData === 'string' &&
        source.cookedPacCache.cookedPacData &&
        source.cookedPacCache.providerKey &&
        source.cookedPacCache.cookedPacSha256
      ) {
        const cookedArtifact = await mv3PacArtifacts.putCookedPacArtifact({
          providerKey: source.cookedPacCache.providerKey,
          cookedPacData: source.cookedPacCache.cookedPacData,
          cookedPacSha256: source.cookedPacCache.cookedPacSha256,
          sourceRawPacSha256: source.cookedPacCache.sourceRawPacSha256,
          pacModsSha256: source.cookedPacCache.pacModsSha256,
          cookedAt: source.cookedPacCache.cookedAt,
          warnings: source.cookedPacCache.warnings,
          cookedPacSize: source.cookedPacCache.cookedPacData.length,
        });
        nextState.cookedPacCache = Object.assign({}, source.cookedPacCache, {
          cookedPacData: null,
          cookedPacSize: cookedArtifact.cookedPacSize,
          artifactRef: cookedArtifact.artifactRef,
        });
        delete nextState.cookedPacCache.cookedPacData;
        migration.cookedPacMigrated = true;
      }

      nextState.artifactMigration = migration;
      const normalizedState = normalizeState(nextState);
      await mv3Storage.set({[STORAGE_KEY]: normalizedState});
      return normalizedState;
    } catch (err) {
      const failedState = Object.assign({}, source, {
        artifactMigration: Object.assign({}, migration, {
          error: createMigrationError(err),
        }),
      });
      await mv3Storage.set({[STORAGE_KEY]: failedState});
      return failedState;
    }

  }

  function enqueueStateOperation(operation) {

    if (ifAtomicMutatorActive) {
      const error = new TypeError(
          'State APIs cannot be called from an atomic state mutator.',
      );
      atomicReentryError = error;
      const rejected = Promise.reject(error);
      rejected.catch(() => undefined);
      return rejected;
    }
    const queued = stateOperationQueue.then(operation);
    stateOperationQueue = queued.catch(() => undefined);
    return queued;

  }

  async function loadStateFromStorage() {

    const items = await mv3Storage.get({[STORAGE_KEY]: clone(DEFAULT_STATE)});
    const storedState = await migrateInlinePacArtifactsIfNeeded(items[STORAGE_KEY]);
    return normalizeState(storedState);

  }

  async function loadState() {

    return enqueueStateOperation(loadStateFromStorage);

  }

  async function saveStatePatchNow(patch, currentStateOverride) {

    const currentState = currentStateOverride || await loadStateFromStorage();
    const mergedState = Object.assign({}, currentState, patch);
    if (isObject(patch.pacMods)) {
      mergedState.pacMods = patch.pacMods;
      mergedState.pacModsRevision = currentState.pacModsRevision + 1;
    }
    if (isObject(patch.notificationPrefs)) {
      mergedState.notificationPrefs = Object.assign(
          {},
          currentState.notificationPrefs,
          patch.notificationPrefs,
      );
    }
    if (isObject(patch.pacDownload)) {
      mergedState.pacDownload = Object.assign(
          {},
          currentState.pacDownload,
          patch.pacDownload,
      );
    }
    if (isObject(patch.pacCache)) {
      mergedState.pacCache = Object.assign({}, currentState.pacCache, patch.pacCache);
    }
    if (isObject(patch.pacCook)) {
      mergedState.pacCook = Object.assign({}, currentState.pacCook, patch.pacCook);
    }
    if (isObject(patch.cookedPacCache)) {
      mergedState.cookedPacCache = Object.assign(
          {},
          currentState.cookedPacCache,
          patch.cookedPacCache,
      );
    }
    if (isObject(patch.proxyApply)) {
      mergedState.proxyApply = Object.assign(
          {},
          currentState.proxyApply,
          patch.proxyApply,
      );
    }
    if (isObject(patch.proxyControl)) {
      mergedState.proxyControl = Object.assign(
          {},
          currentState.proxyControl,
          patch.proxyControl,
      );
    }
    if (isObject(patch.proxyHealth)) {
      mergedState.proxyHealth = Object.assign(
          {},
          currentState.proxyHealth,
          patch.proxyHealth,
      );
    }
    if (isObject(patch.artifactMigration)) {
      mergedState.artifactMigration = Object.assign(
          {},
          currentState.artifactMigration,
          patch.artifactMigration,
      );
    }
    if (isObject(patch.proxyAuth)) {
      mergedState.proxyAuth = Object.assign(
          {},
          currentState.proxyAuth,
          patch.proxyAuth,
      );
      if (isObject(patch.proxyAuth.stats)) {
        mergedState.proxyAuth.stats = Object.assign(
            {},
            currentState.proxyAuth.stats,
            patch.proxyAuth.stats,
        );
      }
      if (Array.isArray(patch.proxyAuth.lastEvents)) {
        mergedState.proxyAuth.lastEvents = patch.proxyAuth.lastEvents;
      }
    }
    if (isObject(patch.periodicUpdate)) {
      mergedState.periodicUpdate = Object.assign(
          {},
          currentState.periodicUpdate,
          patch.periodicUpdate,
      );
      if (Array.isArray(patch.periodicUpdate.lastEvents)) {
        mergedState.periodicUpdate.lastEvents = patch.periodicUpdate.lastEvents;
      }
    }
    if (isObject(patch.legacyMigration)) {
      mergedState.legacyMigration = Object.assign(
          {},
          currentState.legacyMigration,
          patch.legacyMigration,
      );
    }
    const nextState = normalizeState(mergedState);
    await mv3Storage.set({[STORAGE_KEY]: nextState});
    return nextState;

  }

  async function saveStatePatch(patch) {

    assertObject(patch, 'patch');
    return enqueueStateOperation(() => saveStatePatchNow(patch));

  }

  async function updateStateAtomically(mutator) {

    if (typeof mutator !== 'function') {
      throw new TypeError('mutator must be a function.');
    }
    if (mutator.constructor && mutator.constructor.name === 'AsyncFunction') {
      throw new TypeError('atomic state mutator must return synchronously.');
    }
    return enqueueStateOperation(async () => {
      const currentState = await loadStateFromStorage();
      const workingState = freezeRecursively(clone(currentState));
      let patch;
      atomicReentryError = null;
      ifAtomicMutatorActive = true;
      try {
        patch = mutator(workingState);
      } finally {
        ifAtomicMutatorActive = false;
      }
      if (atomicReentryError) {
        throw atomicReentryError;
      }
      if (patch === ATOMIC_NO_CHANGE) {
        return clone(currentState);
      }
      if (patch && typeof patch.then === 'function') {
        Promise.resolve(patch).catch(() => undefined);
        throw new TypeError('atomic state mutator must return synchronously.');
      }
      assertObject(patch, 'atomic state patch');
      const patchPrototype = Object.getPrototypeOf(patch);
      if (
        patchPrototype !== null &&
        Object.getPrototypeOf(patchPrototype) !== null
      ) {
        throw new TypeError('atomic state patch must be a plain object.');
      }
      const patchKeys = Object.keys(patch);
      if (!patchKeys.length) {
        throw new TypeError('atomic state patch must not be empty.');
      }
      if (patchKeys.some((key) =>
        !Object.prototype.hasOwnProperty.call(DEFAULT_STATE, key),
      )) {
        throw new TypeError('atomic state patch contains unsupported fields.');
      }
      if (patchKeys.includes('schemaVersion') || patchKeys.includes('mv3')) {
        throw new TypeError(
            'atomic state mutator must return a patch, not complete state.',
        );
      }
      const committedState = await saveStatePatchNow(
          clone(patch),
          currentState,
      );
      return clone(committedState);
    });

  }

  async function savePacMods(pacMods, options = {}) {

    const patch = {
      pacMods: normalizePacMods(pacMods, true),
    };
    if (options.resetProxyHealth === true) {
      patch.proxyHealth = clone(DEFAULT_STATE.proxyHealth);
    }
    return saveStatePatch(patch);

  }

  async function saveRpcPacMods(pacMods, options = {}) {

    assertObject(pacMods, 'pacMods');
    return enqueueStateOperation(async () => {
      const currentState = await loadStateFromStorage();
      const restoredPacMods = mv3PacMods.restoreRpcPacModsCredentials(
          pacMods,
          currentState.pacMods,
          currentState.pacModsRevision,
      );
      const patch = {pacMods: restoredPacMods};
      if (
        typeof options.ifResetProxyHealth === 'function' &&
        options.ifResetProxyHealth(currentState.pacMods, restoredPacMods)
      ) {
        patch.proxyHealth = clone(DEFAULT_STATE.proxyHealth);
      }
      if (typeof options.onBeforeSave === 'function') {
        options.onBeforeSave(currentState.pacMods, restoredPacMods);
      }
      return saveStatePatchNow(patch, currentState);
    });

  }

  async function setPacMods(pacMods) {

    return (await savePacMods(pacMods)).pacMods;

  }

  async function setNotificationPrefs(prefs) {

    const normalizedPrefs = normalizeNotificationPrefs(prefs, true);
    const state = await saveStatePatch({notificationPrefs: normalizedPrefs});
    return state.notificationPrefs;

  }

  async function setCurrentPacProvider(providerKey) {

    if (providerKey !== null && typeof providerKey !== 'string') {
      throw new TypeError('providerKey must be a string or null.');
    }
    return saveStatePatch({currentPacProviderKey: providerKey});

  }

  async function setCustomPacProviders(customPacProviders) {

    if (!Array.isArray(customPacProviders)) {
      throw new TypeError('customPacProviders must be an array.');
    }
    return saveStatePatch({
      customPacProviders: mv3Providers.normalizeCustomProviders(
          customPacProviders,
      ),
    });

  }

  async function setUiLanguage(language) {

    return saveStatePatch({uiLanguage: normalizeUiLanguage(language)});

  }

  async function resetStateNow() {

    const currentState = await loadStateFromStorage();
    const defaultState = clone(DEFAULT_STATE);
    defaultState.pacModsRevision = currentState.pacModsRevision + 1;
    await mv3Storage.set({[STORAGE_KEY]: defaultState});
    return defaultState;

  }

  async function resetState() {

    return enqueueStateOperation(resetStateNow);

  }

  async function getPacDownloadState() {

    const state = await loadState();
    return state.pacDownload;

  }

  async function setPacDownloadState(pacDownload) {

    assertObject(pacDownload, 'pacDownload');
    const state = await saveStatePatch({pacDownload});
    return state.pacDownload;

  }

  async function getPacCache() {

    const state = await loadState();
    return state.pacCache;

  }

  async function setPacCache(pacCache) {

    assertObject(pacCache, 'pacCache');
    const state = await saveStatePatch({pacCache});
    return state.pacCache;

  }

  async function clearPacCache() {

    const state = await saveStatePatch({
      pacDownload: clone(DEFAULT_STATE.pacDownload),
      pacCache: clone(DEFAULT_STATE.pacCache),
    });
    return {
      pacDownload: state.pacDownload,
      pacCache: state.pacCache,
    };

  }

  async function getPacCookState() {

    const state = await loadState();
    return state.pacCook;

  }

  async function setPacCookState(pacCook) {

    assertObject(pacCook, 'pacCook');
    const state = await saveStatePatch({pacCook});
    return state.pacCook;

  }

  async function getCookedPacCache() {

    const state = await loadState();
    return state.cookedPacCache;

  }

  async function setCookedPacCache(cookedPacCache) {

    assertObject(cookedPacCache, 'cookedPacCache');
    const state = await saveStatePatch({cookedPacCache});
    return state.cookedPacCache;

  }

  async function clearCookedPacCache() {

    const state = await saveStatePatch({
      pacCook: clone(DEFAULT_STATE.pacCook),
      cookedPacCache: clone(DEFAULT_STATE.cookedPacCache),
    });
    return {
      pacCook: state.pacCook,
      cookedPacCache: state.cookedPacCache,
    };

  }

  async function getProxyApplyState() {

    const state = await loadState();
    return state.proxyApply;

  }

  async function setProxyApplyState(proxyApply) {

    assertObject(proxyApply, 'proxyApply');
    const state = await saveStatePatch({proxyApply});
    return state.proxyApply;

  }

  async function setProxyControlState(proxyControl) {

    assertObject(proxyControl, 'proxyControl');
    const state = await saveStatePatch({proxyControl});
    return state.proxyControl;

  }

  async function getProxyControlState() {

    const state = await loadState();
    return state.proxyControl;

  }

  async function getProxyHealthState() {

    const state = await loadState();
    return state.proxyHealth;

  }

  async function setProxyHealthState(proxyHealth) {

    assertObject(proxyHealth, 'proxyHealth');
    const state = await saveStatePatch({proxyHealth});
    return state.proxyHealth;

  }

  async function resetProxyHealth() {

    const state = await saveStatePatch({
      proxyHealth: clone(DEFAULT_STATE.proxyHealth),
    });
    return state.proxyHealth;

  }

  async function clearProxyApplyState() {

    const state = await saveStatePatch({
      proxyApply: clone(DEFAULT_STATE.proxyApply),
    });
    return state.proxyApply;

  }

  async function getProxyAuthState() {

    const state = await loadState();
    return state.proxyAuth;

  }

  async function setProxyAuthState(proxyAuth) {

    assertObject(proxyAuth, 'proxyAuth');
    const state = await saveStatePatch({proxyAuth});
    return state.proxyAuth;

  }

  async function setProxyAuthEnabled(enabled) {

    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean.');
    }
    const state = await saveStatePatch({
      proxyAuth: {
        enabled,
        status: enabled ? 'ready' : 'idle',
        lastUpdatedAt: Date.now(),
      },
    });
    return state.proxyAuth;

  }

  function getProxyAuthStatusForEvent(type) {

    if (type === 'provided') {
      return 'provided';
    }
    if (type === 'missing_credentials') {
      return 'missing_credentials';
    }
    if (type === 'retry_limit') {
      return 'retry_limit';
    }
    if (type === 'error') {
      return 'error';
    }
    if (type === 'non_proxy_ignored') {
      return 'ready';
    }
    if (type === 'disabled') {
      return 'idle';
    }
    return 'challenge_seen';

  }

  function getProxyAuthStatsForEvent(stats, event) {

    const nextStats = Object.assign({}, stats);
    if (event.type === 'non_proxy_ignored') {
      nextStats.nonProxyChallengesIgnored += 1;
      return nextStats;
    }
    if (event.isProxy) {
      nextStats.challenges += 1;
    }
    if (event.type === 'provided') {
      nextStats.provided += 1;
    } else if (event.type === 'missing_credentials') {
      nextStats.missingCredentials += 1;
    } else if (event.type === 'retry_limit') {
      nextStats.retryLimit += 1;
    }
    return nextStats;

  }

  async function recordProxyAuthEvent(event) {

    const normalizedEvent = normalizeProxyAuthEvent(event);
    const state = await updateStateAtomically((currentState) => {
      const currentAuth = currentState.proxyAuth;
      const lastEvents = currentAuth.lastEvents
          .concat(normalizedEvent)
          .slice(-MAX_PROXY_AUTH_EVENTS);
      const patch = {
        status: getProxyAuthStatusForEvent(normalizedEvent.type),
        lastUpdatedAt: normalizedEvent.at,
        stats: getProxyAuthStatsForEvent(currentAuth.stats, normalizedEvent),
        lastEvents,
      };
      if (normalizedEvent.isProxy) {
        patch.lastChallengeAt = normalizedEvent.at;
      }
      if (normalizedEvent.type === 'provided') {
        patch.lastProvidedAt = normalizedEvent.at;
      }
      if (normalizedEvent.type === 'error') {
        patch.lastError = {
          code: 'PROXY_AUTH_ERROR',
          message: normalizedEvent.message || 'Proxy auth error.',
          details: null,
        };
      }
      return {proxyAuth: patch};
    });
    return state.proxyAuth;

  }

  async function resetProxyAuthState() {

    const lastUpdatedAt = Date.now();
    const state = await updateStateAtomically((currentState) => {
      const nextProxyAuth = Object.assign({}, clone(DEFAULT_STATE.proxyAuth), {
        enabled: currentState.proxyAuth.enabled,
        status: currentState.proxyAuth.enabled ? 'ready' : 'idle',
        lastUpdatedAt,
      });
      return {proxyAuth: nextProxyAuth};
    });
    return state.proxyAuth;

  }

  async function getPeriodicUpdateState() {

    const state = await loadState();
    return state.periodicUpdate;

  }

  async function setPeriodicUpdateState(periodicUpdate) {

    assertObject(periodicUpdate, 'periodicUpdate');
    const state = await saveStatePatch({periodicUpdate});
    return state.periodicUpdate;

  }

  async function setPeriodicUpdateEnabled(enabled) {

    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean.');
    }
    const state = await saveStatePatch({
      periodicUpdate: {
        enabled,
        status: enabled ? 'scheduled' : 'idle',
        nextRunAt: enabled ? undefined : null,
      },
    });
    return state.periodicUpdate;

  }

  async function setPeriodicUpdateInterval(intervalMinutes) {

    const normalizedInterval = normalizePeriodicUpdateInterval(
        intervalMinutes,
        true,
    );
    const state = await saveStatePatch({
      periodicUpdate: {
        intervalMinutes: normalizedInterval,
      },
    });
    return state.periodicUpdate;

  }

  async function recordPeriodicUpdateEvent(event) {

    const normalizedEvent = normalizePeriodicUpdateEvent(event);
    const state = await updateStateAtomically((currentState) => {
      const lastEvents = currentState.periodicUpdate.lastEvents
          .concat(normalizedEvent)
          .slice(-MAX_PERIODIC_UPDATE_EVENTS);
      return {
        periodicUpdate: {lastEvents},
      };
    });
    return state.periodicUpdate;

  }

  async function clearPeriodicUpdateEvents() {

    const state = await saveStatePatch({
      periodicUpdate: {
        lastEvents: [],
        lastError: null,
      },
    });
    return state.periodicUpdate;

  }

  async function getLegacyMigrationState() {

    const state = await loadState();
    return state.legacyMigration;

  }

  async function setLegacyMigrationState(legacyMigration) {

    assertObject(legacyMigration, 'legacyMigration');
    const state = await saveStatePatch({legacyMigration});
    return state.legacyMigration;

  }

  async function clearLegacyMigrationAudit() {

    const state = await saveStatePatch({
      legacyMigration: clone(DEFAULT_STATE.legacyMigration),
    });
    return state.legacyMigration;

  }

  function selfTest() {

    const samplePassword = ['sec', 'ret'].join('');
    const applySummaryText = JSON.stringify(normalizeLegacyMigrationApplySummary({
      status: 'success',
      strategy: 'overwriteSelected',
      conflicts: [{
        field: 'pacMods',
        legacySummary: `HTTPS user:${samplePassword}@proxy.example:8443`,
      }],
    }));
    const normalized = normalizeState({
      schemaVersion: 5,
      pacCache: {
        providerKey: 'provider',
        rawPacData: 'function FindProxyForURL(){}',
        rawPacSha256: 'raw-sha',
      },
      cookedPacCache: {
        providerKey: 'provider',
        cookedPacData: 'function FindProxyForURL(){}',
        cookedPacSha256: 'cooked-sha',
      },
    });
    return {
      schemaUpgradesToTwelve: normalized.schemaVersion === 12,
      uiLanguageDefaultsToAuto: normalized.uiLanguage === 'auto',
      uiLanguagePersistsSupportedValue:
        normalizeState({uiLanguage: 'ru'}).uiLanguage === 'ru',
      uiLanguageRejectsUnsupportedValue:
        normalizeState({uiLanguage: 'de'}).uiLanguage === 'auto',
      customProvidersDefaultEmpty:
        normalized.customPacProviders.length === 0,
      customProviderMetadataNormalized:
        normalizeState({
          customPacProviders: [{
            key: 'custom:state-provider-01',
            label: 'State provider',
            urls: ['https://example.com/proxy.pac'],
          }],
        }).customPacProviders[0].label === 'State provider',
      legacyUseTorMapsToTorBrowserOnly:
        normalizePacMods({useTor: true}).localTor.enabled === false &&
        normalizePacMods({useTor: true}).torBrowser.enabled === true,
      ownProxyCredentialsSurviveNormalization:
        normalizePacMods({
          ownProxies: [`HTTPS user:${samplePassword}@proxy.example:8443`],
        }).ownProxies[0].password === samplePassword,
      rawPacDataIsNotNormalized: !Object.prototype.hasOwnProperty.call(
          normalized.pacCache,
          'rawPacData',
      ),
      cookedPacDataIsNotNormalized: !Object.prototype.hasOwnProperty.call(
          normalized.cookedPacCache,
          'cookedPacData',
      ),
      rawPacSizeRecovered: normalized.pacCache.rawPacSize > 0,
      cookedPacSizeRecovered: normalized.cookedPacCache.cookedPacSize > 0,
      proxyAuthDefaultsEnabled: normalized.proxyAuth.enabled === true,
      disabledAuthEventKeepsIdle: getProxyAuthStatusForEvent('disabled') ===
        'idle',
      periodicUpdateDefaultsEnabled:
        normalized.periodicUpdate.enabled === true,
      periodicUpdateDefaultsToTwelveHours:
        normalized.periodicUpdate.intervalMinutes === 12 * 60,
      schemaTenPeriodicStateMigratesToNewDefaults:
        normalizeState({
          schemaVersion: 10,
          periodicUpdate: {enabled: false, intervalMinutes: 12},
        }).periodicUpdate.enabled === true &&
        normalizeState({
          schemaVersion: 10,
          periodicUpdate: {enabled: false, intervalMinutes: 12},
        }).periodicUpdate.intervalMinutes === 12 * 60,
      schemaElevenCanDisablePeriodicUpdate:
        normalizeState({
          schemaVersion: 11,
          periodicUpdate: {enabled: false, intervalMinutes: 12 * 60},
        }).periodicUpdate.enabled === false,
      schemaElevenCanInvalidateSuccessfulUpdate:
        normalizeState({
          schemaVersion: 11,
          periodicUpdate: {
            status: 'success',
            lastFinishedAt: 1000,
            lastSuccessfulUpdateAt: null,
            lastSuccessfulProviderKey: null,
          },
        }).periodicUpdate.lastSuccessfulUpdateAt === null,
      proxyHealthDefaultsUnknown:
        normalized.proxyHealth.status === 'unknown' &&
        normalized.proxyHealth.lastErrorCode === null,
      periodicUpdateEventsCapped: normalizePeriodicUpdateEvents(
          new Array(MAX_PERIODIC_UPDATE_EVENTS + 1).fill({type: 'event'}),
      ).length === MAX_PERIODIC_UPDATE_EVENTS,
      legacyMigrationDefaultsIdle:
        normalized.legacyMigration.auditStatus === 'idle' &&
        normalized.legacyMigration.applyStatus === 'idle',
      legacyMigrationSummarySanitized: normalizeLegacyMigrationSummary({
        detected: true,
        installType: 'legacy-data-detected',
        sources: {
          chromeStorageLocal: {
            checked: true,
            keysFound: ['antiCensorRu'],
          },
        },
        cannotMigrateCount: 1,
      }).sources.chromeStorageLocal.keysFound[0] === 'antiCensorRu',
      legacyMigrationApplySummaryRedactsPasswords:
        applySummaryText.includes('***') &&
        !applySummaryText.includes(`${samplePassword}@`),
    };

  }

  exports.mv3State = Object.freeze({
    STORAGE_KEY,
    ATOMIC_NO_CHANGE,
    loadState,
    saveStatePatch,
    updateStateAtomically,
    savePacMods,
    saveRpcPacMods,
    setPacMods,
    setNotificationPrefs,
    setCurrentPacProvider,
    setCustomPacProviders,
    setUiLanguage,
    resetState,
    getPacDownloadState,
    setPacDownloadState,
    getPacCache,
    setPacCache,
    clearPacCache,
    getPacCookState,
    setPacCookState,
    getCookedPacCache,
    setCookedPacCache,
    clearCookedPacCache,
    getProxyApplyState,
    setProxyApplyState,
    getProxyControlState,
    setProxyControlState,
    getProxyHealthState,
    setProxyHealthState,
    resetProxyHealth,
    clearProxyApplyState,
    getProxyAuthState,
    setProxyAuthState,
    setProxyAuthEnabled,
    recordProxyAuthEvent,
    resetProxyAuthState,
    getPeriodicUpdateState,
    setPeriodicUpdateState,
    setPeriodicUpdateEnabled,
    setPeriodicUpdateInterval,
    recordPeriodicUpdateEvent,
    clearPeriodicUpdateEvents,
    getLegacyMigrationState,
    setLegacyMigrationState,
    clearLegacyMigrationAudit,
    sanitizeRpcValue,
    selfTest,
  });

})(self);
