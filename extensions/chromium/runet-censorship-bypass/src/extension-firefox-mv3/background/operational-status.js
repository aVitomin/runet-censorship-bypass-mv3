'use strict';

(function publishFirefoxOperationalStatus(root, factory) {

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxOperationalStatus = api;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'firefoxOperationalState';
  const HEALTH_TIMEOUT_MS = 9000;
  const NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;
  const HEALTH_STATUSES = Object.freeze([
    'ERROR', 'INCONCLUSIVE', 'OK', 'UNKNOWN',
  ]);
  const INTERNAL_HEALTH_STATUSES = Object.freeze(
      HEALTH_STATUSES.concat('CHECKING'),
  );
  const HEALTH_CODES = Object.freeze([
    'HEALTH_CHECK_FAILED',
    'HEALTH_CHECK_INTERRUPTED',
    'HEALTH_CHECK_SUPERSEDED',
    'HEALTH_CHECK_TIMEOUT',
    'HEALTH_NOT_ACTIVE',
    'HEALTH_PROXY_CANDIDATE_UNAVAILABLE',
    'HEALTH_PROXY_RULE_REQUIRED',
    'HEALTH_TARGET_REQUIRED',
  ]);
  const HEALTH_CODE_SET = new Set(HEALTH_CODES);
  const CANDIDATE_TYPES = Object.freeze([
    'localTor', 'ownProxy', 'torBrowser', 'warp',
  ]);
  const CONTROL_LEVELS = Object.freeze([
    'controlled_by_other_extensions',
    'controlled_by_this_extension',
    'controllable_by_this_extension',
    'not_controllable',
    'unknown',
  ]);
  const RECOVERY_STATUSES = Object.freeze([
    'ACTIVE',
    'BLOCKED_CONTROL_LOSS',
    'BLOCKED_PRIVATE_ACCESS',
    'FAILED',
    'INITIALIZING',
    'OFF',
    'OFF_RECONCILIATION_FAILED',
    'RECOVERED',
  ]);
  const NOTIFICATION_TYPES = Object.freeze([
    'BLOCKED_PRIVATE_ACCESS',
    'CONTROL_LOSS',
    'HEALTH_FAILURE',
    'RECOVERY_BLOCKED',
  ]);
  const TOOLBAR_ICON_SIZES = Object.freeze([16, 19, 20, 32, 38]);
  const BADGE_COLORS = Object.freeze({
    auto: '#1D4ED8',
    busy: '#334155',
    direct: '#475569',
    external: '#6B21A8',
    loading: '#475569',
    off: '#475569',
    proxy: '#166534',
    warning: '#B91C1C',
  });

  function operationalError(code) {

    const error = new TypeError(code);
    error.code = code;
    return error;

  }

  function defaultHealth() {

    return {
      status: 'UNKNOWN',
      code: null,
      checkedAt: null,
      candidateType: null,
      targetOrigin: null,
    };

  }

  function defaultState() {

    return {
      schemaVersion: SCHEMA_VERSION,
      health: defaultHealth(),
      lastNotification: {key: null, at: null},
    };

  }

  function safeTimestamp(value) {

    return Number.isSafeInteger(value) && value > 0 ? value : null;

  }

  function normalizeOrigin(value) {

    if (value === null || value === undefined || value === '') {
      return null;
    }
    try {
      const parsed = new URL(String(value));
      if (!['http:', 'https:'].includes(parsed.protocol) ||
          !parsed.hostname || parsed.username || parsed.password ||
          parsed.origin.length > 2048) {
        return null;
      }
      return parsed.origin;
    } catch (_error) {
      return null;
    }

  }

  function normalizeHealth(value) {

    const result = defaultHealth();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return result;
    }
    result.status = INTERNAL_HEALTH_STATUSES.includes(value.status) ?
      value.status : 'UNKNOWN';
    result.code = value.code === null || HEALTH_CODE_SET.has(value.code) ?
      value.code : null;
    result.checkedAt = safeTimestamp(value.checkedAt);
    result.candidateType = value.candidateType === null ||
      CANDIDATE_TYPES.includes(value.candidateType) ?
      value.candidateType : null;
    result.targetOrigin = normalizeOrigin(value.targetOrigin);
    if (result.status === 'UNKNOWN') {
      result.code = null;
      result.checkedAt = null;
      result.candidateType = null;
    }
    if (result.status === 'ERROR' && !result.code) {
      result.code = 'HEALTH_CHECK_FAILED';
    }
    return result;

  }

  function normalizeState(value) {

    const result = defaultState();
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        value.schemaVersion !== SCHEMA_VERSION) {
      return result;
    }
    result.health = normalizeHealth(value.health);
    const notification = value.lastNotification;
    if (notification && typeof notification === 'object' &&
        !Array.isArray(notification) &&
        NOTIFICATION_TYPES.includes(notification.key)) {
      result.lastNotification = {
        key: notification.key,
        at: safeTimestamp(notification.at),
      };
    }
    return result;

  }

  function publicHealth(value) {

    const health = normalizeHealth(value);
    return Object.freeze({
      status: health.status,
      code: health.code,
      checkedAt: health.checkedAt,
      candidateType: health.candidateType,
    });

  }

  function sanitizeCode(value) {

    const code = String(value || '');
    return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;

  }

  function proxySummary(settings) {

    const value = settings && typeof settings === 'object' ? settings : {};
    const own = Array.isArray(value.ownProxies) ? value.ownProxies : [];
    const warp = value.warp && Array.isArray(value.warp.candidates) ?
      value.warp.candidates : [];
    const configured = own.concat(
        value.localTor ? [value.localTor] : [],
        value.torBrowser ? [value.torBrowser] : [],
        warp,
    );
    const enabled = own.filter((candidate) => candidate.enabled === true);
    if (value.localTor && value.localTor.useForProxyRules === true) {
      enabled.push(value.localTor);
    }
    if (value.torBrowser && value.torBrowser.useForProxyRules === true) {
      enabled.push(value.torBrowser);
    }
    if (value.warp && value.warp.useForProxyRules === true) {
      enabled.push(...warp);
    }
    const types = Array.from(new Set(configured.map((candidate) =>
      String(candidate && candidate.type || '').toUpperCase(),
    ).filter((type) => ['HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5'].includes(type))))
        .sort();
    let candidateType = null;
    if (own.some((candidate) => candidate.enabled === true)) {
      candidateType = 'ownProxy';
    } else if (value.localTor &&
        value.localTor.useForProxyRules === true) {
      candidateType = 'localTor';
    } else if (value.torBrowser &&
        value.torBrowser.useForProxyRules === true) {
      candidateType = 'torBrowser';
    } else if (value.warp && value.warp.useForProxyRules === true &&
        warp.length > 0) {
      candidateType = 'warp';
    }
    return Object.freeze({
      candidateType,
      configuredCount: configured.length,
      enabledCount: enabled.length,
      types: Object.freeze(types),
    });

  }

  function iconPaths(state) {

    return Object.freeze(TOOLBAR_ICON_SIZES.reduce((paths, size) => {
      paths[size] = `icons/action-${state}-${size}.png`;
      return paths;
    }, {}));

  }

  const ICON_PATHS = Object.freeze({
    active: iconPaths('active'),
    busy: iconPaths('busy'),
    external: iconPaths('external'),
    loading: iconPaths('loading'),
    off: iconPaths('off'),
    warning: iconPaths('warning'),
  });

  function isExternalLevel(level) {

    return level === 'controlled_by_other_extensions' ||
      level === 'not_controllable';

  }

  function presentation(kind, icon, text, tone, title, transient = false) {

    const value = Object.freeze({
      kind,
      icon,
      iconPath: ICON_PATHS[icon],
      badgeText: text,
      badgeColor: BADGE_COLORS[tone],
      badgeTextColor: '#FFFFFF',
      title,
      transient,
    });
    return Object.freeze(Object.assign({}, value, {
      fingerprint: JSON.stringify(value),
    }));

  }

  function deriveToolbarPresentation(input, message) {

    const activation = input.activation || {};
    const health = normalizeHealth(input.health);
    const level = CONTROL_LEVELS.includes(input.controlLevel) ?
      input.controlLevel : 'unknown';
    if (isExternalLevel(level) ||
        activation.recoveryStatus === 'BLOCKED_CONTROL_LOSS' ||
        activation.failureCode === 'CONTROL_LOSS') {
      return presentation(
          'EXTERNAL', 'external', 'EXT', 'external',
          message('actionTitleExternal'),
      );
    }
    if (['APPLY', 'CLEAR', 'HEALTH'].includes(input.operation)) {
      const titleKey = input.operation === 'CLEAR' ? 'actionTitleClearing' :
        input.operation === 'HEALTH' ? 'actionTitleChecking' :
          'actionTitleApplying';
      return presentation(
          'BUSY', 'busy', '…', 'busy', message(titleKey), true,
      );
    }
    if (!activation.runtimeState || activation.runtimeState === 'INITIALIZING') {
      return presentation(
          'LOADING', 'loading', '…', 'loading',
          message('actionTitleLoading'), true,
      );
    }
    if (activation.runtimeState === 'FAILED' ||
        String(activation.recoveryStatus || '').startsWith('BLOCKED') ||
        String(activation.recoveryStatus || '').includes('FAILED')) {
      return presentation(
          'BLOCKED', 'warning', '!', 'warning',
          message('actionTitleError'),
      );
    }
    if (activation.runtimeState !== 'READY') {
      return presentation(
          'OFF', 'off', 'OFF', 'off', message('actionTitleOff'),
      );
    }
    if (health.status === 'ERROR') {
      return presentation(
          'HEALTH_ERROR', 'warning', '!', 'warning',
          message('actionTitleHealthWarning'),
      );
    }
    const site = input.site;
    if (!site || !site.target || site.target.controllable !== true ||
        !site.route) {
      return presentation(
          'UNAVAILABLE', 'active', '', 'auto',
          message('actionTitleActiveUnavailable'),
      );
    }
    const mode = ['AUTO', 'DIRECT', 'PROXY'].includes(site.route.mode) ?
      site.route.mode : 'AUTO';
    return presentation(
        mode,
        'active',
        mode === 'AUTO' ? 'A' : mode === 'PROXY' ? 'P' : 'D',
        mode.toLowerCase(),
        message(`actionTitleActive${mode[0]}${mode.slice(1).toLowerCase()}`),
    );

  }

  function createController(options = {}) {

    const storageArea = options.storageArea;
    const actionApi = options.actionApi;
    const notificationsApi = options.notificationsApi;
    const tabsApi = options.tabsApi;
    const runtimeApi = options.runtimeApi;
    const extensionApi = options.extensionApi;
    const proxySettings = options.proxySettings;
    const settingsController = options.settingsController;
    const siteController = options.siteController;
    const activationSnapshot = options.activationSnapshot;
    const fetchFn = options.fetch;
    const AbortControllerClass = options.AbortController;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const getDatasetInfo = options.getDatasetInfo;
    if (!storageArea || typeof storageArea.get !== 'function' ||
        typeof storageArea.set !== 'function' || !settingsController ||
        typeof settingsController.get !== 'function' || !siteController ||
        typeof siteController.get !== 'function' ||
        typeof activationSnapshot !== 'function' ||
        typeof fetchFn !== 'function' ||
        typeof AbortControllerClass !== 'function' || !runtimeApi ||
        typeof runtimeApi.getManifest !== 'function' || !proxySettings ||
        typeof proxySettings.get !== 'function' || !extensionApi ||
        typeof extensionApi.isAllowedIncognitoAccess !== 'function' ||
        typeof getDatasetInfo !== 'function') {
      throw operationalError('INVALID_OPERATIONAL_DEPENDENCIES');
    }
    let state = defaultState();
    let initialization = null;
    let operationQueue = Promise.resolve();
    let toolbarRequest = 0;
    let toolbarFingerprint = null;
    let activeOperation = null;
    let operationSequence = 0;

    function message(key) {

      try {
        const value = options.getMessage(key);
        return typeof value === 'string' && value ? value : key;
      } catch (_error) {
        return key;
      }

    }

    function enqueue(operation) {

      const result = operationQueue.then(operation, operation);
      operationQueue = result.catch(() => undefined);
      return result;

    }

    async function saveState(next) {

      const normalized = normalizeState(next);
      try {
        await storageArea.set({[STORAGE_KEY]: normalized});
      } catch (_error) {
        throw operationalError('OPERATIONAL_STATE_UNAVAILABLE');
      }
      state = normalized;
      return state;

    }

    function initialize() {

      if (!initialization) {
        initialization = (async () => {
          let stored;
          try {
            stored = await storageArea.get(STORAGE_KEY);
          } catch (_error) {
            throw operationalError('OPERATIONAL_STATE_UNAVAILABLE');
          }
          state = normalizeState(stored && stored[STORAGE_KEY]);
          if (state.health.status === 'CHECKING') {
            state.health.status = 'INCONCLUSIVE';
            state.health.code = 'HEALTH_CHECK_INTERRUPTED';
            state.health.checkedAt = now();
            await saveState(state);
          }
          return publicHealth(state.health);
        })().catch((error) => {
          initialization = null;
          throw error;
        });
      }
      return initialization;

    }

    async function controlLevel() {

      try {
        const live = await proxySettings.get({});
        return live && CONTROL_LEVELS.includes(live.levelOfControl) ?
          live.levelOfControl : 'unknown';
      } catch (_error) {
        return 'unknown';
      }

    }

    async function privateAccess() {

      try {
        return await extensionApi.isAllowedIncognitoAccess() ?
          'GRANTED' : 'DENIED';
      } catch (_error) {
        return 'UNKNOWN';
      }

    }

    async function browserInfo() {

      try {
        const value = typeof runtimeApi.getBrowserInfo === 'function' ?
          await runtimeApi.getBrowserInfo() : null;
        return {
          name: value && typeof value.name === 'string' ? value.name :
            'Firefox',
          version: value && typeof value.version === 'string' ?
            value.version : null,
        };
      } catch (_error) {
        return {name: 'Firefox', version: null};
      }

    }

    async function publicStatus() {

      await initialize();
      const manifest = runtimeApi.getManifest();
      const activation = activationSnapshot() || {};
      const [settingsResult, level, access, browser, dataset] =
        await Promise.all([
          settingsController.get(),
          controlLevel(),
          privateAccess(),
          browserInfo(),
          Promise.resolve(getDatasetInfo()),
        ]);
      const proxies = proxySummary(settingsResult.settings);
      return Object.freeze({
        schemaVersion: SCHEMA_VERSION,
        health: publicHealth(state.health),
        diagnostics: Object.freeze({
          schemaVersion: SCHEMA_VERSION,
          generatedAt: now(),
          extensionVersion: String(manifest.version || ''),
          browserName: browser.name,
          browserVersion: browser.version,
          runtimeState: String(activation.runtimeState || 'INITIALIZING'),
          durableIntent: String(activation.durableIntent || 'OFF'),
          recoveryStatus: RECOVERY_STATUSES.includes(
              activation.recoveryStatus) ?
            activation.recoveryStatus : 'FAILED',
          recoveryFailureCode: sanitizeCode(activation.failureCode),
          controlLevel: level,
          datasetAvailable: Boolean(dataset && dataset.available),
          datasetVersion: dataset && dataset.available &&
            typeof dataset.version === 'string' ? dataset.version : null,
          configuredProxyCount: proxies.configuredCount,
          enabledProxyCount: proxies.enabledCount,
          proxyTypes: proxies.types,
          privateWindowAccess: access,
          notificationsAvailable: Boolean(notificationsApi &&
            typeof notificationsApi.create === 'function'),
        }),
      });

    }

    async function activeTab() {

      if (!tabsApi || typeof tabsApi.query !== 'function') {
        return null;
      }
      try {
        const tabs = await tabsApi.query({active: true, lastFocusedWindow: true});
        return tabs && tabs[0] || null;
      } catch (_error) {
        return null;
      }

    }

    async function applyToolbar(presentationValue, tabId, requestId) {

      if (!actionApi || requestId !== toolbarRequest) {
        return {ok: false, status: 'SUPERSEDED'};
      }
      const cacheKey = `${tabId === null ? 'global' : tabId}:` +
        presentationValue.fingerprint;
      if (toolbarFingerprint === cacheKey) {
        return {ok: true, status: 'UNCHANGED'};
      }
      const tab = Number.isInteger(tabId) ? {tabId} : {};
      const calls = [
        ['setIcon', Object.assign({path: presentationValue.iconPath}, tab)],
        ['setBadgeText', Object.assign({text: presentationValue.badgeText}, tab)],
        ['setBadgeBackgroundColor', Object.assign({
          color: presentationValue.badgeColor,
        }, tab)],
        ['setTitle', Object.assign({title: presentationValue.title}, tab)],
      ];
      if (typeof actionApi.setBadgeTextColor === 'function') {
        calls.splice(3, 0, ['setBadgeTextColor', Object.assign({
          color: presentationValue.badgeTextColor,
        }, tab)]);
      }
      const results = await Promise.all(calls.map(async ([method, params]) => {
        try {
          if (typeof actionApi[method] !== 'function') {
            return false;
          }
          await actionApi[method](params);
          return true;
        } catch (_error) {
          return false;
        }
      }));
      if (requestId === toolbarRequest && results.every(Boolean)) {
        toolbarFingerprint = cacheKey;
      }
      return {ok: results.every(Boolean), status: 'UPDATED'};

    }

    async function refreshToolbar(params = {}) {

      const requestId = ++toolbarRequest;
      try {
        await initialize();
      } catch (_error) {
        // A storage failure is represented by the blocked presentation below.
      }
      let tab = params.tab || null;
      if (!tab && Number.isInteger(params.tabId) && tabsApi &&
          typeof tabsApi.get === 'function') {
        try {
          tab = await tabsApi.get(params.tabId);
        } catch (_error) {
          tab = null;
        }
      }
      if (!tab) {
        tab = await activeTab();
      }
      let site = null;
      if (tab && typeof tab.url === 'string') {
        try {
          site = await siteController.get(tab.url);
        } catch (_error) {
          site = null;
        }
      }
      const value = deriveToolbarPresentation({
        activation: activationSnapshot(),
        controlLevel: await controlLevel(),
        health: state.health,
        operation: activeOperation && activeOperation.kind,
        site,
      }, message);
      return applyToolbar(
          value,
          tab && Number.isInteger(tab.id) ? tab.id : null,
          requestId,
      );

    }

    async function refreshGlobalToolbar() {

      const requestId = ++toolbarRequest;
      try {
        await initialize();
      } catch (_error) {
        // A storage failure is represented by the blocked presentation below.
      }
      const value = deriveToolbarPresentation({
        activation: activationSnapshot(),
        controlLevel: await controlLevel(),
        health: state.health,
        operation: activeOperation && activeOperation.kind,
        site: null,
      }, message);
      return applyToolbar(value, null, requestId);

    }

    async function restoreToolbar() {

      await refreshGlobalToolbar();
      return refreshToolbar();

    }

    function showLoading() {

      const requestId = ++toolbarRequest;
      return applyToolbar(deriveToolbarPresentation({
        activation: {runtimeState: 'INITIALIZING'},
        controlLevel: 'unknown',
        health: defaultHealth(),
      }, message), null, requestId);

    }

    function beginOperation(kind) {

      if (!['APPLY', 'CLEAR', 'HEALTH'].includes(kind)) {
        throw operationalError('INVALID_OPERATION');
      }
      const operation = Object.freeze({kind, id: ++operationSequence});
      activeOperation = operation;
      restoreToolbar().catch(() => undefined);
      return operation;

    }

    function endOperation(operation) {

      if (activeOperation && operation &&
          activeOperation.id === operation.id) {
        activeOperation = null;
      }
      return restoreToolbar();

    }

    async function notificationNow(type) {

      await initialize();
      if (!NOTIFICATION_TYPES.includes(type) || !notificationsApi ||
          typeof notificationsApi.create !== 'function') {
        return {ok: false, status: 'UNAVAILABLE'};
      }
      const timestamp = now();
      if (state.lastNotification.key === type &&
          state.lastNotification.at && timestamp - state.lastNotification.at <
            NOTIFICATION_COOLDOWN_MS) {
        return {ok: false, status: 'COOLDOWN'};
      }
      const titleKey = type === 'HEALTH_FAILURE' ?
        'notificationHealthTitle' : 'notificationProtectionTitle';
      const messageKey = {
        BLOCKED_PRIVATE_ACCESS: 'notificationPrivateAccessBlocked',
        CONTROL_LOSS: 'notificationControlLoss',
        HEALTH_FAILURE: 'notificationHealthFailure',
        RECOVERY_BLOCKED: 'notificationRecoveryBlocked',
      }[type];
      try {
        await notificationsApi.create(`firefox-operational-${type}`, {
          type: 'basic',
          iconUrl: runtimeApi.getURL('icons/action-active-128.png'),
          title: message(titleKey),
          message: message(messageKey),
        });
      } catch (_error) {
        return {ok: false, status: 'FAILED'};
      }
      await saveState(Object.assign({}, state, {
        lastNotification: {key: type, at: timestamp},
      }));
      return {ok: true, status: 'CREATED'};

    }

    function notify(type) {

      return enqueue(() => notificationNow(type));

    }

    async function saveHealth(health) {

      await saveState(Object.assign({}, state, {health}));
      await restoreToolbar();
      return publicHealth(state.health);

    }

    async function checkHealthNow(tabUrl) {

      await initialize();
      const activation = activationSnapshot() || {};
      if (activation.runtimeState !== 'READY' || activation.active !== true ||
          activation.durableIntent !== 'ON') {
        return saveHealth(Object.assign(defaultHealth(), {
          status: 'INCONCLUSIVE',
          code: 'HEALTH_NOT_ACTIVE',
          checkedAt: now(),
          targetOrigin: state.health.targetOrigin,
        }));
      }
      const targetOrigin = normalizeOrigin(tabUrl) ||
        state.health.targetOrigin;
      if (!targetOrigin) {
        return saveHealth(Object.assign(defaultHealth(), {
          status: 'INCONCLUSIVE',
          code: 'HEALTH_TARGET_REQUIRED',
          checkedAt: now(),
        }));
      }
      let site;
      let settings;
      try {
        [site, settings] = await Promise.all([
          siteController.get(targetOrigin),
          settingsController.get(),
        ]);
      } catch (_error) {
        return saveHealth(Object.assign(defaultHealth(), {
          status: 'INCONCLUSIVE',
          code: 'HEALTH_CHECK_SUPERSEDED',
          checkedAt: now(),
          targetOrigin,
        }));
      }
      if (!site.target.controllable || !site.route ||
          site.route.mode !== 'PROXY') {
        return saveHealth(Object.assign(defaultHealth(), {
          status: 'INCONCLUSIVE',
          code: 'HEALTH_PROXY_RULE_REQUIRED',
          checkedAt: now(),
          targetOrigin,
        }));
      }
      const summary = proxySummary(settings.settings);
      if (!summary.candidateType || summary.enabledCount < 1) {
        return saveHealth(Object.assign(defaultHealth(), {
          status: 'INCONCLUSIVE',
          code: 'HEALTH_PROXY_CANDIDATE_UNAVAILABLE',
          checkedAt: now(),
          targetOrigin,
        }));
      }
      const startedAt = now();
      await saveState(Object.assign({}, state, {
        health: {
          status: 'INCONCLUSIVE',
          code: 'HEALTH_CHECK_INTERRUPTED',
          checkedAt: startedAt,
          candidateType: summary.candidateType,
          targetOrigin,
        },
      }));
      await restoreToolbar();
      const controller = new AbortControllerClass();
      const timeoutId = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      try {
        const response = await fetchFn(targetOrigin, {
          cache: 'no-store',
          credentials: 'omit',
          method: 'GET',
          mode: 'no-cors',
          redirect: 'manual',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
        if (response && response.body &&
            typeof response.body.cancel === 'function') {
          Promise.resolve(response.body.cancel()).catch(() => undefined);
        }
        const latest = activationSnapshot() || {};
        if (latest.runtimeState !== 'READY' || latest.active !== true) {
          return saveHealth(Object.assign(defaultHealth(), {
            status: 'INCONCLUSIVE',
            code: 'HEALTH_CHECK_SUPERSEDED',
            checkedAt: now(),
            candidateType: summary.candidateType,
            targetOrigin,
          }));
        }
        return saveHealth({
          status: 'OK',
          code: null,
          checkedAt: now(),
          candidateType: summary.candidateType,
          targetOrigin,
        });
      } catch (error) {
        const latest = activationSnapshot() || {};
        if (latest.runtimeState !== 'READY' || latest.active !== true) {
          return saveHealth(Object.assign(defaultHealth(), {
            status: 'INCONCLUSIVE',
            code: 'HEALTH_CHECK_SUPERSEDED',
            checkedAt: now(),
            candidateType: summary.candidateType,
            targetOrigin,
          }));
        }
        const health = await saveHealth({
          status: 'ERROR',
          code: error && error.name === 'AbortError' ?
            'HEALTH_CHECK_TIMEOUT' : 'HEALTH_CHECK_FAILED',
          checkedAt: now(),
          candidateType: summary.candidateType,
          targetOrigin,
        });
        await notificationNow('HEALTH_FAILURE');
        return health;
      } finally {
        clearTimeout(timeoutId);
      }

    }

    function checkHealth(tabUrl) {

      return enqueue(() => checkHealthNow(tabUrl));

    }

    function resetHealth() {

      return enqueue(async () => {
        await initialize();
        return saveHealth(Object.assign(defaultHealth(), {
          targetOrigin: state.health.targetOrigin,
        }));
      });

    }

    function handleControlChange(result) {

      restoreToolbar().catch(() => undefined);
      const code = result && result.error && result.error.code;
      if (code === 'CONTROL_LOSS') {
        notify('CONTROL_LOSS').catch(() => undefined);
      }
      const reconciliation = result && result.reconciliation;
      if (reconciliation && typeof reconciliation.then === 'function') {
        Promise.resolve(reconciliation).then(
            () => restoreToolbar(), () => restoreToolbar(),
        ).catch(() => undefined);
      }

    }

    async function reconcileStartupAttention() {

      await initialize();
      const activation = activationSnapshot() || {};
      if (activation.recoveryStatus === 'BLOCKED_PRIVATE_ACCESS') {
        return notificationNow('BLOCKED_PRIVATE_ACCESS');
      }
      if (activation.durableIntent === 'ON' &&
          (activation.runtimeState === 'FAILED' ||
            String(activation.recoveryStatus || '').startsWith('BLOCKED') ||
            String(activation.recoveryStatus || '').includes('FAILED'))) {
        return notificationNow('RECOVERY_BLOCKED');
      }
      return {ok: false, status: 'NOT_REQUIRED'};

    }

    async function handleNotificationClicked(notificationId) {

      if (!String(notificationId || '').startsWith('firefox-operational-')) {
        return false;
      }
      try {
        if (notificationsApi && typeof notificationsApi.clear === 'function') {
          await notificationsApi.clear(notificationId);
        }
        if (tabsApi && typeof tabsApi.create === 'function') {
          await tabsApi.create({
            url: runtimeApi.getURL('pages/options/index.html#maintenance'),
          });
        }
      } catch (_error) {
        return false;
      }
      return true;

    }

    return Object.freeze({
      beginOperation,
      checkHealth,
      endOperation,
      handleControlChange,
      handleNotificationClicked,
      initialize,
      notify,
      publicStatus,
      reconcileStartupAttention,
      restoreToolbar,
      refreshToolbar,
      resetHealth,
      showLoading,
    });

  }

  return Object.freeze({
    CANDIDATE_TYPES,
    CONTROL_LEVELS,
    HEALTH_CODES,
    HEALTH_STATUSES,
    HEALTH_TIMEOUT_MS,
    NOTIFICATION_COOLDOWN_MS,
    NOTIFICATION_TYPES,
    RECOVERY_STATUSES,
    SCHEMA_VERSION,
    STORAGE_KEY,
    createController,
    deriveToolbarPresentation,
    normalizeOrigin,
    normalizeState,
    proxySummary,
    publicHealth,
  });

});
