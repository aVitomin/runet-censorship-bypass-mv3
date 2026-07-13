'use strict';

/* global mv3PacMods, mv3Providers, mv3State, mv3Storage */

(function(exports) {

  const OFFSCREEN_DOCUMENT_PATH = 'offscreen/migration-audit.html';
  const OFFSCREEN_MESSAGE_TYPE = 'mv3-legacy-local-storage-audit';
  const OFFSCREEN_TIMEOUT_MS = 5000;
  const REDACTED_PASSWORD = '***';
  const MAX_SUMMARY_VALUE_LENGTH = 500;

  const KNOWN_CHROME_STORAGE_KEYS = Object.freeze([
    'antiCensorRu',
    'ifConsentGiven',
    'firefox-only-pac-data',
  ]);

  const KNOWN_LOCAL_STORAGE_KEYS = Object.freeze([
    'pac-kitchen-mods',
    'pac-kitchen-if-incontinence',
    'ip-to-host',
    'handlers-if-on-pac-error',
    'handlers-if-on-ext-error',
    'handlers-if-on-no-control',
    'err-to-exc-if-coll',
    'ui-proxy-string-raw',
  ]);

  const UNSUPPORTED_PAC_MOD_KEYS = Object.freeze([
    'ifProxyHttpsUrlsOnly',
    'ifUseSecureProxiesOnly',
    'ifProhibitDns',
    'ifProxyMoreDomains',
    'replaceDirectWith',
  ]);

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function normalizeStringArray(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item);

  }

  function normalizeNumber(value) {

    const number = Number(value);
    return Number.isFinite(number) ? number : null;

  }

  function redactUsername(username) {

    const value = String(username || '');
    if (!value) {
      return '';
    }
    if (value.length <= 2) {
      return '*'.repeat(value.length);
    }
    return `${value[0]}***${value[value.length - 1]}`;

  }

  function parseProxyEntry(proxyAsStringRaw) {

    const proxyAsString = String(proxyAsStringRaw || '').trim();
    const match = proxyAsString.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }
    const type = match[1].toUpperCase();
    const addressWithCredentials = match[2].trim();
    const atIndex = addressWithCredentials.lastIndexOf('@');
    const ifHasCredentials = atIndex !== -1;
    const credentials = ifHasCredentials ?
      addressWithCredentials.slice(0, atIndex) :
      '';
    const address = ifHasCredentials ?
      addressWithCredentials.slice(atIndex + 1) :
      addressWithCredentials;
    const colonIndex = credentials.indexOf(':');
    const username = ifHasCredentials ?
      (colonIndex === -1 ? credentials : credentials.slice(0, colonIndex)) :
      '';
    const password = ifHasCredentials && colonIndex !== -1 ?
      credentials.slice(colonIndex + 1) :
      '';

    return {
      type,
      address,
      raw: ifHasCredentials ?
        `${type} ${username}:${password}@${address}` :
        `${type} ${address}`,
      username,
      hasUsername: Boolean(username),
      hasPassword: Boolean(password),
      redacted: ifHasCredentials ?
        `${type} ${redactUsername(username)}:${REDACTED_PASSWORD}@${address}` :
        `${type} ${address}`,
    };

  }

  function parseProxyList(proxyStringRaw) {

    if (typeof proxyStringRaw !== 'string') {
      return [];
    }
    return proxyStringRaw
        .replace(/#.*$/mg, '')
        .split(/(?:\s*(?:;|\r?\n)+\s*)+/g)
        .map((item) => item.trim())
        .filter((item) => item && /\s/.test(item))
        .map(parseProxyEntry)
        .filter(Boolean);

  }

  function redactProxyCredentialsInString(value) {

    const parsed = parseProxyEntry(value);
    if (parsed) {
      return parsed.redacted;
    }
    return String(value || '')
        .replace(/([^\s:@;]+):([^\s@;]+)@/g, (match, username) =>
          `${redactUsername(username)}:${REDACTED_PASSWORD}@`,
        );

  }

  function trimSummaryString(value) {

    const stringValue = String(value);
    if (stringValue.length <= MAX_SUMMARY_VALUE_LENGTH) {
      return stringValue;
    }
    return `${stringValue.slice(0, MAX_SUMMARY_VALUE_LENGTH)}...`;

  }

  function sanitizeValue(value, key = '') {

    const loweredKey = String(key || '').toLowerCase();
    if (
      loweredKey.includes('password') ||
      loweredKey.includes('pac-data') ||
      loweredKey === 'rawpacdata' ||
      loweredKey === 'cookedpacdata'
    ) {
      return '[redacted]';
    }
    if (typeof value === 'string') {
      const redacted = value.includes('@') ?
        redactProxyCredentialsInString(value) :
        value;
      return trimSummaryString(redacted);
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, key));
    }
    if (isObject(value)) {
      return Object.keys(value).sort().reduce((acc, childKey) => {
        acc[childKey] = sanitizeValue(value[childKey], childKey);
        return acc;
      }, {});
    }
    return value;

  }

  function describeValue(value, includeValues) {

    const description = {
      type: Array.isArray(value) ? 'array' : typeof value,
    };
    if (typeof value === 'string') {
      description.size = value.length;
    } else if (Array.isArray(value)) {
      description.size = value.length;
    } else if (isObject(value)) {
      description.size = Object.keys(value).length;
    }
    if (includeValues) {
      description.value = sanitizeValue(value);
    }
    return description;

  }

  function summarizeStorageSource(items, knownKeys, includeValues) {

    const sourceItems = isObject(items) ? items : {};
    const keys = Object.keys(sourceItems).sort();
    const keysFound = keys.filter((key) => knownKeys.includes(key));
    const unknownKeys = keys.filter((key) =>
      key !== mv3State.STORAGE_KEY && !knownKeys.includes(key),
    );
    const summary = {
      checked: true,
      keysFound,
      warnings: [],
    };
    if (unknownKeys.length) {
      summary.warnings.push(
          `Found unclassified extension storage keys: ${unknownKeys.join(', ')}.`,
      );
    }
    if (includeValues) {
      summary.items = keysFound.reduce((acc, key) => {
        acc[key] = describeValue(sourceItems[key], true);
        return acc;
      }, {});
    }
    return summary;

  }

  function createEmptyLocalStorageSummary(warning) {

    return {
      checked: false,
      keysFound: [],
      warnings: warning ? [warning] : [],
      items: {},
    };

  }

  function isProviderKnown(providerKey) {

    if (!providerKey) {
      return true;
    }
    if (typeof mv3Providers === 'undefined') {
      return true;
    }
    return mv3Providers.hasProvider(providerKey);

  }

  function getLegacyChromeStorageKeys(items) {

    const source = isObject(items) ? items : {};
    return Object.keys(source)
        .filter((key) => key !== mv3State.STORAGE_KEY)
        .sort();

  }

  function getLocalStorageItems(localStorageSummary) {

    if (!localStorageSummary || !isObject(localStorageSummary.items)) {
      return {};
    }
    return localStorageSummary.items;

  }

  function getLegacyPacMods(localStorageItems) {

    const mods = localStorageItems['pac-kitchen-mods'];
    return isObject(mods) ? mods : null;

  }

  function getNotificationPrefs(localStorageItems) {

    const keyToPref = {
      'handlers-if-on-pac-error': 'pacError',
      'handlers-if-on-ext-error': 'extError',
      'handlers-if-on-no-control': 'noControl',
    };
    const prefs = {};
    let ifAnyKnown = false;
    Object.keys(keyToPref).forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(localStorageItems, key)) {
        return;
      }
      ifAnyKnown = true;
      const value = localStorageItems[key];
      prefs[keyToPref[key]] = value === 'on' || value === true;
    });
    return ifAnyKnown ? prefs : null;

  }

  function createPacModsPlan(mods, localStorageItems, cannotMigrate, warnings) {

    if (!mods) {
      const uiRaw = localStorageItems['ui-proxy-string-raw'];
      if (typeof uiRaw === 'string' && uiRaw.trim()) {
        cannotMigrate.push({
          source: 'localStorage',
          key: 'ui-proxy-string-raw',
          reason: 'Proxy editor draft is UI-only and not authoritative.',
        });
      }
      return null;
    }

    const ownProxyEntries = parseProxyList(mods.customProxyStringRaw);
    const legacyExceptions = isObject(mods.exceptions) ? mods.exceptions : {};
    const legacyExceptionRules = Object.keys(legacyExceptions)
        .sort()
        .map((host) => ({
          pattern: host,
          action: legacyExceptions[host] === true ? 'PROXY' : 'DIRECT',
          enabled: true,
          note: 'Migrated from legacy PAC kitchen exceptions',
        }));

    UNSUPPORTED_PAC_MOD_KEYS.forEach((key) => {
      if (
        Object.prototype.hasOwnProperty.call(mods, key) &&
        mods[key] !== null &&
        mods[key] !== false &&
        mods[key] !== ''
      ) {
        cannotMigrate.push({
          source: 'localStorage',
          key: `pac-kitchen-mods.${key}`,
          reason: 'This legacy PAC kitchen modifier has no safe MV3 mapping yet.',
        });
      }
    });

    if (mods.ifMindWhitelist === false && Array.isArray(mods.whitelist) &&
      mods.whitelist.length) {
      warnings.push(
          'Legacy whitelist entries exist but whitelist mode was disabled.',
      );
    }
    if (mods.ifMindExceptions === false && Object.keys(legacyExceptions).length) {
      warnings.push(
          'Legacy exceptions exist but exception handling was disabled.',
      );
    }

    const apply = mv3PacMods.normalizePacMods({
      usePacScriptProxies: mods.ifUsePacScriptProxies !== false,
      ownProxiesOnlyForOwnSites:
        mods.ifUseOwnProxiesOnlyForOwnSites === true,
      exceptions: mods.ifMindExceptions === false ? [] : legacyExceptionRules,
      whitelist: mods.ifMindWhitelist === false ?
        [] :
        normalizeStringArray(mods.whitelist),
      ownProxies: ownProxyEntries.map((entry) => entry.raw),
      localTor: {
        enabled: mods.ifUseLocalTor === true,
        type: 'SOCKS5',
        host: '127.0.0.1',
        port: 9050,
        useForOnion: true,
        useAsDirectReplacement: false,
      },
      torBrowser: {
        enabled: mods.ifUseLocalTor === true,
        type: 'SOCKS5',
        host: '127.0.0.1',
        port: 9150,
        useForOnion: true,
        useAsDirectReplacement: false,
      },
      warp: {
        enabled: mods.ifUseLocalWarp === true,
        proxyString: 'SOCKS5 127.0.0.1:40000; HTTPS 127.0.0.1:40000',
        useAsDirectReplacement: false,
      },
      replaceDirectWithProxy: false,
      noDirect: mods.ifProxyOrDie === true,
    });
    const display = Object.assign({}, mv3PacMods.redactPacMods(apply), {
      notes: [
        'own proxy passwords are redacted in this dry-run plan; Phase 10 ' +
          'rereads legacy data before applying migration.',
      ],
    });
    return {
      display,
      apply,
    };

  }

  function createProviderPlan(antiCensorRu, cannotMigrate, warnings) {

    if (!isObject(antiCensorRu)) {
      return null;
    }
    const providerKey = typeof antiCensorRu._currentPacProviderKey === 'string' ?
      antiCensorRu._currentPacProviderKey :
      null;
    if (providerKey && !isProviderKnown(providerKey)) {
      cannotMigrate.push({
        source: 'chrome.storage.local',
        key: 'antiCensorRu._currentPacProviderKey',
        reason: 'Legacy provider key is not known in the MV3 provider list.',
        value: providerKey,
      });
      return null;
    }
    if (antiCensorRu.pacProviders) {
      cannotMigrate.push({
        source: 'chrome.storage.local',
        key: 'antiCensorRu.pacProviders',
        reason: 'Provider metadata is static in MV3 and should not be migrated.',
      });
    }
    if (antiCensorRu.ifFirstInstall === true) {
      warnings.push('Legacy storage marks the old extension as first-install.');
    }
    return providerKey;

  }

  function createLastPacMetadataPlan(antiCensorRu) {

    if (!isObject(antiCensorRu)) {
      return {
        lastPacUpdateStamp: null,
        currentProviderLastModified: null,
      };
    }
    return {
      lastPacUpdateStamp: normalizeNumber(antiCensorRu.lastPacUpdateStamp),
      currentProviderLastModified:
        antiCensorRu._currentPacProviderLastModified || null,
    };

  }

  function maybeAddCannotMigrateForKnownKeys(keys, cannotMigrate) {

    if (keys.includes('ifConsentGiven')) {
      cannotMigrate.push({
        source: 'chrome.storage.local',
        key: 'ifConsentGiven',
        reason: 'Consent page state has no MV3 migration target in Phase 9A.',
      });
    }
    if (keys.includes('firefox-only-pac-data')) {
      cannotMigrate.push({
        source: 'chrome.storage.local',
        key: 'firefox-only-pac-data',
        reason: 'Stored Firefox PAC text is not migrated into MV3 state.',
      });
    }
    if (keys.includes('ip-to-host')) {
      cannotMigrate.push({
        source: 'localStorage',
        key: 'ip-to-host',
        reason: 'IP-to-host data is a derived cache and should be rebuilt.',
      });
    }
    if (keys.includes('pac-kitchen-if-incontinence')) {
      cannotMigrate.push({
        source: 'localStorage',
        key: 'pac-kitchen-if-incontinence',
        reason: 'Old pending PAC recook flag is not safe to replay in MV3.',
      });
    }
    if (keys.includes('err-to-exc-if-coll')) {
      cannotMigrate.push({
        source: 'localStorage',
        key: 'err-to-exc-if-coll',
        reason: 'Last-error collection UI state is debug-only.',
      });
    }

  }

  function valuesEqual(left, right) {

    return JSON.stringify(left) === JSON.stringify(right);

  }

  function addConflict(conflicts, key, legacyValue, mv3Value) {

    if (legacyValue === null || legacyValue === undefined) {
      return;
    }
    if (valuesEqual(legacyValue, mv3Value)) {
      return;
    }
    conflicts.push({
      key,
      legacyValue: sanitizeValue(legacyValue, key),
      mv3Value: sanitizeValue(mv3Value, key),
      resolution: 'Phase 9A reports this conflict only; it does not choose.',
    });

  }

  function getProposedKeys(canMigrate) {

    return Object.keys(canMigrate)
        .filter((key) => canMigrate[key] !== null && canMigrate[key] !== undefined)
        .sort();

  }

  function createPlanFromSources({
    chromeStorageLocal,
    localStorage,
    currentState,
    includeValues = false,
    includeSensitiveValues = false,
  }) {

    const chromeItems = isObject(chromeStorageLocal.items) ?
      chromeStorageLocal.items :
      {};
    const localStorageItems = getLocalStorageItems(localStorage);
    const chromeKeys = getLegacyChromeStorageKeys(chromeItems);
    const localKeys = Object.keys(localStorageItems).sort();
    const cannotMigrate = [];
    const conflicts = [];
    const warnings = [];
    const antiCensorRu = isObject(chromeItems.antiCensorRu) ?
      chromeItems.antiCensorRu :
      null;
    const legacyPacMods = getLegacyPacMods(localStorageItems);
    const pacModsPlan = createPacModsPlan(
        legacyPacMods,
        localStorageItems,
        cannotMigrate,
        warnings,
    );

    maybeAddCannotMigrateForKnownKeys(chromeKeys, cannotMigrate);
    maybeAddCannotMigrateForKnownKeys(localKeys, cannotMigrate);

    const current = isObject(currentState) ? currentState : {};
    const canMigrate = {
      currentPacProviderKey: createProviderPlan(
          antiCensorRu,
          cannotMigrate,
          warnings,
      ),
      pacUpdatePeriodInMinutes: antiCensorRu ?
        normalizeNumber(
            antiCensorRu._pacUpdatePeriodInMinutes ||
              antiCensorRu.pacUpdatePeriodInMinutes,
        ) :
        null,
      lastPacMetadata: createLastPacMetadataPlan(antiCensorRu),
      pacMods: pacModsPlan && pacModsPlan.display,
      notificationPrefs: getNotificationPrefs(localStorageItems),
    };
    const applyValues = {
      currentPacProviderKey: canMigrate.currentPacProviderKey,
      pacUpdatePeriodInMinutes: canMigrate.pacUpdatePeriodInMinutes,
      pacMods: pacModsPlan && pacModsPlan.apply,
      notificationPrefs: canMigrate.notificationPrefs,
    };

    addConflict(
        conflicts,
        'currentPacProviderKey',
        canMigrate.currentPacProviderKey,
        current.currentPacProviderKey,
    );
    addConflict(
        conflicts,
        'pacUpdatePeriodInMinutes',
        canMigrate.pacUpdatePeriodInMinutes,
        current.pacUpdatePeriodInMinutes,
    );
    if (canMigrate.pacMods) {
      addConflict(conflicts, 'pacMods', canMigrate.pacMods, current.pacMods);
    }
    if (canMigrate.notificationPrefs) {
      addConflict(
          conflicts,
          'notificationPrefs',
          canMigrate.notificationPrefs,
          current.notificationPrefs,
      );
    }

    const detected = Boolean(chromeKeys.length || localKeys.length);
    const sources = {
      chromeStorageLocal: Object.assign(
          {},
          summarizeStorageSource(chromeItems, KNOWN_CHROME_STORAGE_KEYS, includeValues),
          {
            keysFound: chromeKeys,
          },
      ),
      localStorage: Object.assign(
          {},
          localStorage,
          {
            keysFound: localKeys,
            items: includeValues ? sanitizeValue(localStorageItems) : undefined,
          },
      ),
    };

    return {
      detected,
      checkedAt: Date.now(),
      installType: detected ? 'legacy-data-detected' : 'fresh-mv3-or-no-legacy-data',
      sources,
      proposedMigration: {
        canMigrate,
        applyValues: includeSensitiveValues ? applyValues : undefined,
        cannotMigrate,
        conflicts,
        warnings,
      },
      sensitiveFieldsRedacted: true,
    };

  }

  function summarizePlan(plan) {

    const proposed = plan.proposedMigration || {};
    return {
      detected: plan.detected === true,
      checkedAt: plan.checkedAt || Date.now(),
      installType: plan.installType || 'unknown',
      sources: {
        chromeStorageLocal: {
          checked: plan.sources.chromeStorageLocal.checked === true,
          keysFound: plan.sources.chromeStorageLocal.keysFound || [],
          warnings: plan.sources.chromeStorageLocal.warnings || [],
        },
        localStorage: {
          checked: plan.sources.localStorage.checked === true,
          keysFound: plan.sources.localStorage.keysFound || [],
          warnings: plan.sources.localStorage.warnings || [],
        },
      },
      proposedKeys: getProposedKeys(proposed.canMigrate || {}),
      cannotMigrateCount: (proposed.cannotMigrate || []).length,
      conflictCount: (proposed.conflicts || []).length,
      warningCount: (proposed.warnings || []).length,
      sensitiveFieldsRedacted: plan.sensitiveFieldsRedacted !== false,
    };

  }

  function hasOffscreenApi() {

    return Boolean(
        typeof chrome !== 'undefined' &&
        chrome.offscreen &&
        chrome.offscreen.createDocument &&
        chrome.runtime &&
        chrome.runtime.sendMessage,
    );

  }

  function getOffscreenReason() {

    if (
      typeof chrome !== 'undefined' &&
      chrome.offscreen &&
      chrome.offscreen.Reason &&
      chrome.offscreen.Reason.LOCAL_STORAGE
    ) {
      return chrome.offscreen.Reason.LOCAL_STORAGE;
    }
    return 'LOCAL_STORAGE';

  }

  function createOffscreenDocument() {

    return chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [getOffscreenReason()],
      justification:
        'Read legacy extension localStorage for an explicit migration audit.',
    });

  }

  async function ensureOffscreenDocument() {

    if (!hasOffscreenApi()) {
      return false;
    }
    if (chrome.offscreen.hasDocument) {
      const ifHasDocument = await chrome.offscreen.hasDocument();
      if (ifHasDocument) {
        return false;
      }
    }
    await createOffscreenDocument();
    return true;

  }

  function closeOffscreenDocumentIfCreated(ifCreated) {

    if (!ifCreated || !hasOffscreenApi() || !chrome.offscreen.closeDocument) {
      return Promise.resolve();
    }
    return chrome.offscreen.closeDocument().catch(() => {});

  }

  function sendOffscreenAuditMessage(includeValues, includeSensitiveValues) {

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Offscreen localStorage audit timed out.'));
      }, OFFSCREEN_TIMEOUT_MS);
      chrome.runtime.sendMessage(
          {
            type: OFFSCREEN_MESSAGE_TYPE,
            includeValues: includeValues === true,
            includeSensitiveValues: includeSensitiveValues === true,
          },
          (response) => {
            clearTimeout(timeoutId);
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              reject(new Error(lastError.message));
              return;
            }
            resolve(response || {});
          },
      );
    });

  }

  function normalizeLocalStorageResponse(response) {

    if (!response || response.ok !== true) {
      return createEmptyLocalStorageSummary(
          response && response.error && response.error.message ||
            'Offscreen localStorage audit failed.',
      );
    }
    const items = isObject(response.items) ? response.items : {};
    const summary = summarizeStorageSource(
        items,
        KNOWN_LOCAL_STORAGE_KEYS,
        false,
    );
    return Object.assign(summary, {
      keysFound: Object.keys(items).sort(),
      items,
      warnings: (response.warnings || []).concat(summary.warnings || []),
    });

  }

  async function auditLocalStorage(includeValues, includeSensitiveValues) {

    if (!hasOffscreenApi()) {
      return createEmptyLocalStorageSummary(
          'Offscreen API is unavailable; legacy localStorage was not checked.',
      );
    }

    let ifCreated = false;
    try {
      ifCreated = await ensureOffscreenDocument();
      return normalizeLocalStorageResponse(
          await sendOffscreenAuditMessage(includeValues, includeSensitiveValues),
      );
    } catch (err) {
      return createEmptyLocalStorageSummary(
          err && err.message || 'Failed to inspect legacy localStorage.',
      );
    } finally {
      await closeOffscreenDocumentIfCreated(ifCreated);
    }

  }

  async function auditChromeStorage() {

    const items = await mv3Storage.get();
    return {
      checked: true,
      keysFound: getLegacyChromeStorageKeys(items),
      warnings: [],
      items,
    };

  }

  async function runAudit(params = {}) {

    const includeValues = params.includeValues === true;
    const includeSensitiveValues = params.includeSensitiveValues === true;
    const currentState = params.currentState || await mv3State.loadState();
    const chromeStorageLocal = params.chromeStorageLocal ||
      await auditChromeStorage();
    const localStorage = params.localStorage ||
      await auditLocalStorage(includeValues, includeSensitiveValues);
    return createPlanFromSources({
      chromeStorageLocal,
      localStorage,
      currentState,
      includeValues,
      includeSensitiveValues,
    });

  }

  function selfTest() {

    const currentState = {
      currentPacProviderKey: 'onlyOwnSites',
      pacUpdatePeriodInMinutes: 12,
      pacMods: mv3PacMods.DEFAULT_PAC_MODS,
      notificationPrefs: {
        pacError: true,
        extError: true,
        noControl: true,
      },
    };
    const samplePassword = ['pass', 'word'].join('');
    const emptyPlan = createPlanFromSources({
      chromeStorageLocal: {checked: true, items: {}},
      localStorage: {checked: true, items: {}},
      currentState,
    });
    const legacyPlan = createPlanFromSources({
      chromeStorageLocal: {
        checked: true,
        items: {
          antiCensorRu: {
            _currentPacProviderKey: 'Антизапрет',
            _pacUpdatePeriodInMinutes: 720,
            lastPacUpdateStamp: 123,
            _currentPacProviderLastModified: 'Mon, 01 Jan 2024 00:00:00 GMT',
            pacProviders: {legacy: true},
          },
        },
      },
      localStorage: {
        checked: true,
        items: {
          'pac-kitchen-mods': {
            customProxyStringRaw:
              `HTTPS user:${samplePassword}@proxy.example:8443`,
            ifUseLocalTor: true,
            ifUsePacScriptProxies: false,
            ifUseOwnProxiesOnlyForOwnSites: true,
            ifProxyHttpsUrlsOnly: true,
            exceptions: {
              'direct.example': false,
              'proxy.example': true,
            },
            whitelist: ['allowed.example'],
          },
          'handlers-if-on-pac-error': 'on',
          'ip-to-host': {'127.0.0.1': 'localhost'},
        },
      },
      currentState,
      includeValues: true,
    });
    const legacyText = JSON.stringify(legacyPlan);
    return {
      noLegacyDataDetected: emptyPlan.detected === false,
      legacyDataDetected: legacyPlan.detected === true,
      chromeStorageKeyDetected:
        legacyPlan.sources.chromeStorageLocal.keysFound.includes('antiCensorRu'),
      localStorageKeyDetected:
        legacyPlan.sources.localStorage.keysFound.includes('pac-kitchen-mods'),
      passwordRedacted: !legacyText.includes(`${samplePassword}@`) &&
        legacyText.includes(REDACTED_PASSWORD),
      conflictReported:
        legacyPlan.proposedMigration.conflicts.length >= 1,
      nonMigratableCacheReported:
        legacyPlan.proposedMigration.cannotMigrate.some((item) =>
          item.key === 'ip-to-host',
        ),
      proxyOnlyExceptionMapped:
        legacyPlan.proposedMigration.canMigrate.pacMods.exceptions.some((rule) =>
          rule.pattern === 'proxy.example' && rule.action === 'PROXY',
        ),
      pacScriptProxySwitchMapped:
        legacyPlan.proposedMigration.canMigrate.pacMods
            .usePacScriptProxies === false,
      ownSitesOnlySwitchMapped:
        legacyPlan.proposedMigration.canMigrate.pacMods
            .ownProxiesOnlyForOwnSites === true,
      summaryHasNoValues:
        !Object.prototype.hasOwnProperty.call(
            summarizePlan(legacyPlan).sources.localStorage,
            'items',
        ),
    };

  }

  exports.mv3LegacyMigrationAudit = Object.freeze({
    OFFSCREEN_DOCUMENT_PATH,
    OFFSCREEN_MESSAGE_TYPE,
    KNOWN_CHROME_STORAGE_KEYS,
    KNOWN_LOCAL_STORAGE_KEYS,
    runAudit,
    summarizePlan,
    createPlanFromSources,
    sanitizeValue,
    selfTest,
  });

})(self);
