'use strict';

/* global importScripts, mv3LegacyMigrationApply, mv3LegacyMigrationAudit */
/* global mv3ActionStatus, mv3PacArtifacts, mv3PacCook, mv3PacDownload */
/* global mv3PacMods, mv3PeriodicUpdate, mv3SiteScope */
/* global mv3Providers, mv3ProxyAuth, mv3ProxyHealth, mv3ProxySettings */
/* global mv3State */

importScripts(
    'vendor/tldts/dist/index.umd.min.js',
    'storage.js',
    'pac-artifacts.js',
    'pac-mods.js',
    'site-scope.js',
    'proxy-health.js',
    'pac-providers.js',
    'state.js',
    'action-status.js',
    'legacy-migration-audit.js',
    'legacy-migration-apply.js',
    'periodic-update.js',
    'hash.js',
    'pac-download.js',
    'pac-cook.js',
    'proxy-auth.js',
    'proxy-settings.js',
);

const PHASE_TEN_STATUS = Object.freeze({
  mv3: true,
  phase: 10,
  status: 'MV3 proxy and PAC modifier parity controls are available',
  implementedFeatures: [
    'rpc-client',
    'page-status',
    'mv3-storage',
    'mv3-state',
    'pac-download',
    'custom-pac-providers',
    'pac-cache',
    'pac-cook',
    'cooked-pac-cache',
    'pac-artifact-storage',
    'proxy-control',
    'proxy-apply',
    'proxy-auth',
    'periodic-pac-updates',
    'legacy-migration-audit',
    'legacy-migration-apply',
    'proxy-pac-modifier-controls',
    'local-tor-pac-support',
  ],
  pac: {
    implemented: true,
    status: 'PAC download, cooking, artifact storage, explicit proxy application, proxy auth, periodic updates, legacy MV2 migration, and structured proxy/Tor settings are implemented.',
  },
});

let pacDownloadPromise = null;
let pacCookPromise = null;
let proxyHealthCheckPromise = null;
const proxyErrorDebounce = new Map();
const NO_PROXY_CANDIDATE_MESSAGE =
  'No proxy is enabled. Enable Tor, WARP, or an own proxy.';
const actionStatusRefresh = mv3ActionStatus.createRefreshCoordinator({
  chromeApi: chrome,
  loadState: () => mv3State.loadState(),
  createStatus: (tabUrl, state) => createPopupState(tabUrl, state),
});
actionStatusRefresh.start();
const actionStatusRecoveryPromise = recoverActionStatusOnWorkerStart()
    .catch(() => requestActionStatusRefresh({}));

function openFullOptionsPage() {

  if (chrome.runtime && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('pages/options/index.html'),
    });
  }

}

function getProvidersForState(state, ifIncludeDisabled) {

  return mv3Providers.getPacProviders(
      state && state.customPacProviders || [],
      {includeDisabled: ifIncludeDisabled === true},
  );

}

function getProviderForState(state, providerKey, ifIncludeDisabled) {

  return mv3Providers.getProviderByKey(
      providerKey,
      state && state.customPacProviders || [],
      {includeDisabled: ifIncludeDisabled === true},
  );

}

function createProviderError(code, message) {

  const error = new TypeError(message);
  error.code = code;
  return error;

}

function createProviderMutationResult(state, provider, metadata = {}) {

  return Object.assign({
    ok: true,
    provider: provider || null,
    providers: getProvidersForState(state, true),
    currentPacProviderKey: state.currentPacProviderKey,
  }, metadata);

}

function cloneRpcRecord(value) {

  return value && typeof value === 'object' ?
    JSON.parse(JSON.stringify(value)) :
    {};

}

function createOptionsStateForRpc(state) {

  const pacCook = cloneRpcRecord(state.pacCook);
  const cookedPacCache = cloneRpcRecord(state.cookedPacCache);
  delete pacCook.pacModsSha256;
  delete cookedPacCache.pacModsSha256;
  return {
    uiLanguage: state.uiLanguage,
    currentPacProviderKey: state.currentPacProviderKey,
    pacMods: mv3PacMods.serializePacModsForRpc(
        state.pacMods,
        state.pacModsRevision,
    ),
    notificationPrefs: cloneRpcRecord(state.notificationPrefs),
    pacDownload: cloneRpcRecord(state.pacDownload),
    pacCache: cloneRpcRecord(state.pacCache),
    pacCook,
    cookedPacCache,
    proxyApply: cloneRpcRecord(state.proxyApply),
    proxyControl: cloneRpcRecord(state.proxyControl),
    legacyMigration: cloneRpcRecord(state.legacyMigration),
  };

}

async function addCustomPacProvider(params) {

  const state = await mv3State.loadState();
  const now = Date.now();
  const key = mv3Providers.createCustomProviderKey(state.customPacProviders);
  const provider = mv3Providers.validateCustomProvider(params, {
    key,
    now,
    createdAt: now,
  });
  const nextState = await mv3State.setCustomPacProviders(
      state.customPacProviders.concat(provider),
  );
  return createProviderMutationResult(nextState, provider, {
    status: 'added',
  });

}

async function updateCustomPacProvider(params) {

  const key = String(params.key || '');
  if (mv3Providers.isBuiltInProviderKey(key)) {
    throw createProviderError(
        'BUILT_IN_PROVIDER_READ_ONLY',
        'Built-in PAC providers are read-only.',
    );
  }
  const state = await mv3State.loadState();
  const index = state.customPacProviders.findIndex((provider) =>
    provider.key === key,
  );
  if (index === -1) {
    throw createProviderError(
        'CUSTOM_PROVIDER_NOT_FOUND',
        'Custom PAC provider was not found.',
    );
  }
  const previous = state.customPacProviders[index];
  const provider = mv3Providers.validateCustomProvider(
      Object.assign({}, previous, params),
      {
        key,
        createdAt: previous.createdAt,
        now: Date.now(),
      },
  );
  const urlsChanged = JSON.stringify(previous.urls) !==
    JSON.stringify(provider.urls);
  const ifSelected = state.currentPacProviderKey === key;
  const selectedProviderCleared = ifSelected && !provider.enabled;
  const nextProviders = state.customPacProviders.slice();
  nextProviders[index] = provider;
  let nextState = await mv3State.saveStatePatch({
    customPacProviders: nextProviders,
    currentPacProviderKey: selectedProviderCleared ?
      null :
      state.currentPacProviderKey,
  });
  let cacheMetadataCleared = false;
  if (ifSelected && provider.enabled && urlsChanged) {
    await mv3State.clearPacCache();
    await mv3State.clearCookedPacCache();
    nextState = await mv3State.loadState();
    cacheMetadataCleared = true;
    await mv3State.setPeriodicUpdateState({
      lastSuccessfulProviderKey: null,
      nextRunAt: null,
    });
    nextState = await mv3State.loadState();
  }
  if (ifSelected && (urlsChanged || selectedProviderCleared)) {
    await mv3State.resetProxyHealth();
  }
  if (ifSelected && provider.enabled && urlsChanged) {
    await scheduleAutomaticPacUpdateCheck('provider-updated');
  }
  await updateActionStatusFromStoredState({});
  return createProviderMutationResult(nextState, provider, {
    status: 'updated',
    selectedProviderCleared,
    cacheMetadataCleared,
  });

}

async function deleteCustomPacProvider(params) {

  const key = String(params.key || '');
  if (mv3Providers.isBuiltInProviderKey(key)) {
    throw createProviderError(
        'BUILT_IN_PROVIDER_READ_ONLY',
        'Built-in PAC providers cannot be deleted.',
    );
  }
  const state = await mv3State.loadState();
  const provider = state.customPacProviders.find((item) => item.key === key);
  if (!provider) {
    throw createProviderError(
        'CUSTOM_PROVIDER_NOT_FOUND',
        'Custom PAC provider was not found.',
    );
  }
  const selectedProviderCleared = state.currentPacProviderKey === key;
  let nextState = await mv3State.saveStatePatch({
    customPacProviders: state.customPacProviders.filter((item) =>
      item.key !== key,
    ),
    currentPacProviderKey: selectedProviderCleared ?
      null :
      state.currentPacProviderKey,
  });
  if (selectedProviderCleared) {
    await mv3State.resetProxyHealth();
    nextState = await mv3State.loadState();
  }
  await updateActionStatusFromStoredState({});
  return createProviderMutationResult(nextState, null, {
    status: 'deleted',
    deletedKey: key,
    selectedProviderCleared,
    artifactsRetained: true,
  });

}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(openFullOptionsPage);
}

const RPC_METHODS = Object.freeze({
  async getState() {

    const state = await mv3State.loadState();
    const [periodicUpdate, cookedPacStale] = await Promise.all([
      mv3PeriodicUpdate.getStatus(state),
      getCookedPacStaleness(state),
    ]);
    return Object.assign({}, PHASE_TEN_STATUS, {
      state: createOptionsStateForRpc(state),
      providers: getProvidersForState(state, true),
      artifactStorage: mv3PacArtifacts.getStatus(),
      proxyAuth: getProxyAuthStatusFromState(state),
      periodicUpdate,
      reliability: {
        autoUpdate: getPacAutoUpdateSummary(state),
        proxyHealth: state.proxyHealth,
      },
      stale: {
        cookedPac: cookedPacStale,
      },
      proxy: await getProxyStatusFromState(state, cookedPacStale),
    });

  },

  async getPacProviders(params = {}) {

    const state = await mv3State.loadState();
    return getProvidersForState(state, params.includeDisabled === true);

  },

  async getPacMods() {

    const state = await mv3State.loadState();
    return mv3PacMods.serializePacModsForRpc(
        state.pacMods,
        state.pacModsRevision,
    );

  },

  async setPacMods(params = {}) {

    const state = await mv3State.saveRpcPacMods(params.pacMods, {
      ifResetProxyHealth(previousPacMods, nextPacMods) {

        return mv3ProxyHealth.getCandidateFingerprint(previousPacMods) !==
          mv3ProxyHealth.getCandidateFingerprint(nextPacMods);

      },
    });
    await requestActionStatusRefresh({state});
    return {ok: true};

  },

  async getPopupState(params = {}) {

    await actionStatusRecoveryPromise.catch(() => undefined);
    const state = await mv3State.loadState();
    return createPopupState(params.tabUrl, state);

  },

  setCurrentSiteMode(params = {}) {

    return setCurrentSiteModeAndApply(params);

  },

  updatePopupDraft(params = {}) {

    return updatePopupDraft(params);

  },

  applyPopupChanges(params = {}) {

    return applyPopupChanges(params);

  },

  openOptionsPage() {

    openFullOptionsPage();
    return {ok: true};

  },

  async normalizePacMods(params = {}) {

    const state = await mv3State.loadState();
    return mv3PacMods.serializePacModsForRpc(
        mv3PacMods.restoreRpcPacModsCredentials(
            params.pacMods,
            state.pacMods,
            state.pacModsRevision,
        ),
        state.pacModsRevision,
    );

  },

  async validatePacMods(params = {}) {

    const state = await mv3State.loadState();
    return {
      ok: true,
      pacMods: mv3PacMods.serializePacModsForRpc(
          mv3PacMods.restoreRpcPacModsCredentials(
              params.pacMods,
              state.pacMods,
              state.pacModsRevision,
          ),
          state.pacModsRevision,
      ),
    };

  },

  async getNotificationPrefs() {

    const state = await mv3State.loadState();
    return state.notificationPrefs;

  },

  setNotificationPrefs(params = {}) {

    return mv3State.setNotificationPrefs(params.prefs);

  },

  async setCurrentPacProvider(params = {}) {

    const providerKey = params.providerKey === undefined ? null : params.providerKey;
    const currentState = await mv3State.loadState();
    if (
      providerKey !== null &&
      !getProviderForState(currentState, providerKey)
    ) {
      throw new TypeError('Unknown PAC provider.');
    }
    const state = await mv3State.setCurrentPacProvider(providerKey);
    await mv3State.resetProxyHealth();
    await scheduleAutomaticPacUpdateCheck('provider-change');
    await updateActionStatusFromStoredState({});
    return {
      currentPacProviderKey: state.currentPacProviderKey,
    };

  },

  addCustomPacProvider(params = {}) {

    return addCustomPacProvider(params);

  },

  updateCustomPacProvider(params = {}) {

    return updateCustomPacProvider(params);

  },

  deleteCustomPacProvider(params = {}) {

    return deleteCustomPacProvider(params);

  },

  async setUiLanguage(params = {}) {

    const state = await mv3State.setUiLanguage(params.language);
    return {
      ok: true,
      uiLanguage: state.uiLanguage,
    };

  },

  async resetMv3State() {

    await mv3State.resetState();
    return {ok: true};

  },

  async downloadPac(params = {}) {

    if (mv3PeriodicUpdate.isUpdateInFlight()) {
      return createPacDownloadFailure(
          'PERIODIC_UPDATE_IN_PROGRESS',
          'Periodic PAC update is already running.',
      );
    }
    if (pacDownloadPromise) {
      return createPacDownloadFailure(
          'PAC_DOWNLOAD_IN_PROGRESS',
          'PAC download is already in progress.',
      );
    }

    pacDownloadPromise = downloadPacAndPersist(params)
        .finally(() => {
          pacDownloadPromise = null;
        });
    const result = await pacDownloadPromise;
    await handlePacOperationResult(result, 'PAC download failed.');
    await updateActionStatusFromStoredState({});
    return result;

  },

  getPacDownloadState() {

    return mv3State.getPacDownloadState();

  },

  async getPacCache() {

    const cache = await mv3State.getPacCache();
    return summarizePacCache(cache);

  },

  async clearPacCache() {

    const result = await clearPacCacheAndArtifacts();
    await updateActionStatusFromStoredState({});
    return result;

  },

  async cookPac(params = {}) {

    if (mv3PeriodicUpdate.isUpdateInFlight()) {
      return createPacCookFailure(
          'PERIODIC_UPDATE_IN_PROGRESS',
          'Periodic PAC update is already running.',
      );
    }
    if (pacCookPromise) {
      return createPacCookFailure(
          'PAC_COOK_IN_PROGRESS',
          'PAC cooking is already in progress.',
      );
    }

    pacCookPromise = cookPacAndPersist(params)
        .finally(() => {
          pacCookPromise = null;
        });
    const result = await pacCookPromise;
    await handlePacOperationResult(result, 'PAC cooking failed.');
    await updateActionStatusFromStoredState({});
    return result;

  },

  getPacCookState() {

    return mv3State.getPacCookState();

  },

  async getCookedPacCache() {

    const state = await mv3State.loadState();
    return Object.assign(
        await summarizeCookedPacCache(state.cookedPacCache),
        {stale: await getCookedPacStaleness(state)},
    );

  },

  async clearCookedPacCache() {

    const result = await clearCookedPacCacheAndArtifacts();
    await updateActionStatusFromStoredState({});
    return result;

  },

  async getProxyStatus() {

    const state = await mv3State.loadState();
    return getProxyStatusFromState(state);

  },

  async getProxyHealth() {

    const state = await mv3State.loadState();
    return state.proxyHealth;

  },

  checkProxyHealth(params = {}) {

    return runProxyHealthCheck(params);

  },

  async refreshProxyControl() {

    const refreshed = await refreshProxyControlAndPersistWithState();
    await requestActionStatusRefresh({state: refreshed.state});
    return refreshed.proxyControl;

  },

  async applyCookedPac(params = {}) {

    if (mv3PeriodicUpdate.isUpdateInFlight()) {
      return createProxyFailure(
          'PERIODIC_UPDATE_IN_PROGRESS',
          'Periodic PAC update is already running.',
      );
    }
    const result = await applyCookedPacAndPersist(params);
    await handleProxyOperationResult(result, 'Proxy apply failed.');
    await updateActionStatusFromStoredState({});
    return result;

  },

  async clearProxy() {

    const result = await clearProxyAndPersist();
    await handleProxyOperationResult(result, 'Proxy clear failed.');
    await updateActionStatusFromStoredState({});
    return result;

  },

  async getProxyAuthStatus() {

    const state = await mv3State.loadState();
    return getProxyAuthStatusFromState(state);

  },

  async setProxyAuthEnabled(params = {}) {

    if (typeof params.enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean.');
    }
    await mv3State.setProxyAuthEnabled(params.enabled);
    const state = await mv3State.loadState();
    return getProxyAuthStatusFromState(state);

  },

  async clearProxyAuthEvents() {

    await mv3State.resetProxyAuthState();
    mv3ProxyAuth.clearProxyAuthAttempts();
    const state = await mv3State.loadState();
    return getProxyAuthStatusFromState(state);

  },

  async testProxyAuthConfig() {

    const state = await mv3State.loadState();
    return mv3ProxyAuth.getProxyAuthStatus(state).configuredCredentials;

  },

  getPeriodicUpdateStatus() {

    return mv3PeriodicUpdate.getStatus();

  },

  setPeriodicUpdateEnabled(params = {}) {

    if (typeof params.enabled !== 'boolean') {
      throw new TypeError('enabled must be a boolean.');
    }
    return mv3PeriodicUpdate.setEnabled(params.enabled);

  },

  setPeriodicUpdateInterval(params = {}) {

    return mv3PeriodicUpdate.setIntervalMinutes(params.intervalMinutes);

  },

  async runPeriodicUpdateNow(params = {}) {

    return runPeriodicUpdate({
      trigger: 'manual',
      applyIfSafe: params.applyIfSafe !== false,
    });

  },

  async clearPeriodicUpdateEvents() {

    await mv3State.clearPeriodicUpdateEvents();
    return mv3PeriodicUpdate.getStatus();

  },

  runLegacyMigrationAudit(params = {}) {

    return runLegacyMigrationAuditAndPersist(params);

  },

  async getLegacyMigrationAuditStatus() {

    return mv3State.getLegacyMigrationState();

  },

  getLegacyMigrationPlan(params = {}) {

    return mv3LegacyMigrationAudit.runAudit({
      includeValues: params.includeValues === true,
    });

  },

  clearLegacyMigrationAudit() {

    return mv3State.clearLegacyMigrationAudit();

  },

  applyLegacyMigration(params = {}) {

    return mv3LegacyMigrationApply.applyLegacyMigration(params);

  },

  async getLegacyMigrationApplyStatus() {

    return mv3State.getLegacyMigrationState();

  },

  getPageStatus(params = {}) {

    const page = typeof params.page === 'string' ? params.page : 'unknown';
    return {
      page,
      mv3: true,
      migrated: false,
      status: 'This page is not fully migrated to MV3 yet.',
      backgroundStatus: PHASE_TEN_STATUS.status,
      pacStatus: PHASE_TEN_STATUS.pac.status,
    };

  },
});

chrome.runtime.onInstalled.addListener(() => {

  console.info('MV3 service worker shell installed.');
  initializeAutomaticPacUpdates('installed');
  updateActionStatusFromStoredState({})
      .catch((err) => console.warn('Failed to update action status.', err));

});

chrome.runtime.onStartup.addListener(() => {

  console.info('MV3 service worker shell started.');
  initializeAutomaticPacUpdates('browser-startup');
  updateActionStatusFromStoredState({})
      .catch((err) => console.warn('Failed to update action status.', err));

});

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (
      alarm &&
      [
        mv3PeriodicUpdate.ALARM_NAME,
        mv3PeriodicUpdate.RETRY_ALARM_NAME,
      ].includes(alarm.name)
    ) {
      runAutomaticPacUpdateIfDue({
        trigger: alarm.name === mv3PeriodicUpdate.RETRY_ALARM_NAME ?
          'retry' :
          'watchdog',
      }).catch((err) => {
        console.warn('Periodic PAC update failed.', err);
        updateActionStatusFromStoredState({
          error: err && err.message || 'Periodic PAC update failed.',
        }).catch(() => {});
      });
    }
  });
}

if (chrome.proxy && chrome.proxy.settings && chrome.proxy.settings.onChange) {
  chrome.proxy.settings.onChange.addListener(() => {
    handleProxySettingsChanged()
        .catch((err) => console.warn('Failed to refresh proxy control.', err));
  });
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (String(notificationId || '').startsWith('mv3-')) {
      chrome.notifications.clear(notificationId);
      openFullOptionsPage();
    }
  });
}

if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  chrome.webRequest.onAuthRequired.addListener(
      handleWebRequestAuthRequired,
      {urls: ['<all_urls>']},
      ['asyncBlocking'],
  );
  chrome.webRequest.onCompleted.addListener(
      clearWebRequestAuthAttempt,
      {urls: ['<all_urls>']},
  );
}

if (chrome.webRequest && chrome.webRequest.onErrorOccurred) {
  chrome.webRequest.onErrorOccurred.addListener(
      handleWebRequestError,
      {urls: ['<all_urls>']},
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (!isInternalRpcMessage(message, sender)) {
    return false;
  }

  const respond = (response) => {
    sendResponse(mv3State.sanitizeRpcValue(response));
  };
  handleRpcMessage(message)
      .then(respond)
      .catch((err) => respond(createErrorResponse(err)));
  return true;

});

initializeAutomaticPacUpdates('service-worker-startup');

function isInternalRpcMessage(message, sender) {

  if (sender && sender.id && sender.id !== chrome.runtime.id) {
    return false;
  }
  return Boolean(message) && message.v === 1;

}

function handleWebRequestAuthRequired(details, asyncCallback) {

  let ifCallbackCalled = false;
  const respond = (response) => {
    if (ifCallbackCalled) {
      return;
    }
    ifCallbackCalled = true;
    asyncCallback(response || {});
  };

  mv3State.loadState()
      .then((state) => mv3ProxyAuth.handleProxyAuthRequired(details, state))
      .then((result) => {
        respond(result.response);
        return mv3State.recordProxyAuthEvent(result.event);
      })
      .catch((err) => {
        respond({});
        return mv3State.recordProxyAuthEvent({
          type: 'error',
          at: Date.now(),
          requestId: details && details.requestId || null,
          isProxy: details && details.isProxy === true,
          host: details && details.challenger && details.challenger.host || null,
          port: details && details.challenger && details.challenger.port || null,
          message: err && err.message || 'Proxy auth handler failed.',
        });
      })
      .catch(() => {});

}

function clearWebRequestAuthAttempt(details) {

  mv3ProxyAuth.clearProxyAuthAttempts(details);

}

function handleWebRequestError(details) {

  clearWebRequestAuthAttempt(details);
  if (!mv3ProxyHealth.isProxyError(details && details.error)) {
    return;
  }
  recordProxyHealthFailure(details)
      .catch((err) => console.warn('Failed to record proxy health error.', err));

}

function initializeAutomaticPacUpdates(trigger) {

  mv3PeriodicUpdate.reconcileAlarms({startupDelay: true})
      .catch((err) => console.warn(
          `Failed to initialize PAC auto-update (${trigger}).`,
          err,
      ));

}

async function recoverActionStatusOnWorkerStart() {

  const refreshed = await refreshProxyControlAndPersistWithState();
  return requestActionStatusRefresh({state: refreshed.state});

}

async function scheduleAutomaticPacUpdateCheck(trigger) {

  await mv3PeriodicUpdate.reconcileAlarms({startupDelay: true});
  return {
    ok: true,
    trigger,
  };

}

async function runLegacyMigrationAuditAndPersist(params = {}) {

  const startedAt = Date.now();
  await mv3State.setLegacyMigrationState({
    auditStatus: 'running',
    lastAuditAt: startedAt,
    lastError: null,
  });
  try {
    const plan = await mv3LegacyMigrationAudit.runAudit({
      includeValues: params.includeValues === true,
    });
    const summary = mv3LegacyMigrationAudit.summarizePlan(plan);
    await mv3State.setLegacyMigrationState({
      auditStatus: 'success',
      lastAuditAt: summary.checkedAt,
      detectedLegacyData: summary.detected,
      lastSummary: summary,
      lastError: null,
      warnings: plan.proposedMigration && plan.proposedMigration.warnings || [],
    });
    return plan;
  } catch (err) {
    const error = {
      code: err && err.code || 'LEGACY_MIGRATION_AUDIT_FAILED',
      message: err && err.message || 'Legacy migration audit failed.',
      details: err && err.details === undefined ? null : err && err.details,
    };
    await mv3State.setLegacyMigrationState({
      auditStatus: 'error',
      lastAuditAt: Date.now(),
      detectedLegacyData: false,
      lastError: error,
      warnings: [],
    });
    return {
      detected: false,
      sources: {
        chromeStorageLocal: {
          checked: false,
          keysFound: [],
          warnings: [],
        },
        localStorage: {
          checked: false,
          keysFound: [],
          warnings: [],
        },
      },
      proposedMigration: {
        canMigrate: {},
        cannotMigrate: [],
        conflicts: [],
        warnings: [],
      },
      sensitiveFieldsRedacted: true,
      error,
    };
  }

}

async function setCurrentSiteModeAndApply(params = {}) {

  return applyPopupChanges({
    tabUrl: params.tabUrl,
    operation: params.apply === false ? 'save' : 'apply',
    draft: {
      siteMode: params.mode,
      siteScope: params.scope,
    },
  });

}

async function updatePopupDraft(params = {}) {

  const validation = await validatePopupDraftProxyCandidates(
      params.tabUrl,
      params.draft || {},
  );
  if (validation.error) {
    return createPopupNoCandidateFailure(params.tabUrl, validation.state);
  }
  const state = await persistPopupDraft(params.tabUrl, params.draft || {});
  return {
    ok: true,
    status: 'saved',
    message: 'PAC settings changed. Apply changes to activate.',
    popupState: await createPopupStateAndUpdateAction(params.tabUrl, state),
  };

}

async function applyPopupChanges(params = {}) {

  const operation = params.operation || 'apply';
  if (!['save', 'updatePac', 'apply'].includes(operation)) {
    throw new TypeError('Unsupported popup operation.');
  }

  const draft = params.draft || {};
  const validation = await validatePopupDraftProxyCandidates(
      params.tabUrl,
      draft,
  );
  if (validation.error) {
    return createPopupNoCandidateFailure(params.tabUrl, validation.state);
  }
  let state = await persistPopupDraft(params.tabUrl, draft);
  const target = normalizePopupTabUrl(params.tabUrl);
  const siteMode = String(draft.siteMode || '').toLowerCase();
  if (operation === 'save') {
    return {
      ok: true,
      status: 'saved',
      message: target.controllable || !siteMode ?
        'PAC settings changed. Apply changes to activate.' :
        target.reason,
      popupState: await createPopupStateAndUpdateAction(params.tabUrl, state),
    };
  }

  if (mv3PeriodicUpdate.isUpdateInFlight()) {
    return createPopupOperationFailure(
        'Periodic PAC update is already running.',
        params.tabUrl,
    );
  }
  if (pacDownloadPromise || pacCookPromise) {
    return createPopupOperationFailure(
        'Another PAC operation is already running.',
        params.tabUrl,
    );
  }

  const providerKey = state.currentPacProviderKey;
  if (!providerKey) {
    return createPopupOperationFailure(
        'Select a PAC provider first.',
        params.tabUrl,
    );
  }

  const forceDownload = operation === 'updatePac';
  const needsDownload = forceDownload ||
    !state.pacCache.rawPacSha256 ||
    state.pacCache.providerKey !== providerKey;
  let download = null;
  if (needsDownload) {
    pacDownloadPromise = downloadPacAndPersist({
      providerKey,
      force: forceDownload,
    }).finally(() => {
      pacDownloadPromise = null;
    });
    download = await pacDownloadPromise;
    if (download.ok === false) {
      return createPopupPipelineFailure(download, params.tabUrl);
    }
    state = await mv3State.loadState();
  }

  pacCookPromise = cookPacAndPersist({providerKey})
      .finally(() => {
        pacCookPromise = null;
      });
  const cook = await pacCookPromise;
  if (cook.ok === false) {
    return createPopupPipelineFailure(cook, params.tabUrl);
  }
  if (operation === 'updatePac') {
    return {
      ok: true,
      status: 'updated',
      message: 'PAC downloaded and cooked.',
      downloadStatus: download && download.status || 'already_cached',
      cookStatus: cook.status,
      warnings: cook.warnings || [],
      popupState: await createPopupStateAndUpdateAction(
          params.tabUrl,
          await mv3State.loadState(),
      ),
    };
  }

  const apply = await applyCookedPacAndPersist({});
  if (apply.ok === false) {
    return createPopupPipelineFailure(apply, params.tabUrl);
  }
  const appliedState = await mv3State.loadState();
  const appliedSiteMode = target.controllable ?
    getPopupHostRuleState(appliedState.pacMods, target.host).mode :
    'auto';
  const healthCheck = appliedSiteMode === 'proxy' ?
    await runProxyHealthCheck({tabUrl: params.tabUrl}) :
    null;
  return {
    ok: true,
    status: 'applied',
    message: 'Settings applied.',
    downloadStatus: download && download.status || 'already_cached',
    cookStatus: cook.status,
    applyStatus: apply.status,
    healthCheck,
    warnings: (cook.warnings || []).concat(apply.warnings || []),
    popupState: await createPopupStateAndUpdateAction(
        params.tabUrl,
        await mv3State.loadState(),
    ),
  };

}

async function persistPopupDraft(tabUrl, draft) {

  let state = await mv3State.loadState();
  const providerKey = getPopupDraftProviderKey(draft);
  if (
    providerKey !== undefined &&
    providerKey !== state.currentPacProviderKey
  ) {
    if (providerKey !== null && !getProviderForState(state, providerKey)) {
      throw new TypeError('Unknown PAC provider.');
    }
    state = await mv3State.setCurrentPacProvider(providerKey);
    await mv3State.resetProxyHealth();
    await scheduleAutomaticPacUpdateCheck('popup-provider-change');
  }

  const previousPacMods = mv3PacMods.normalizePacMods(state.pacMods);
  const candidateFingerprint = mv3ProxyHealth.getCandidateFingerprint(
      previousPacMods,
  );
  const target = normalizePopupTabUrl(tabUrl);
  const previousSiteMode = target.controllable ?
    getPopupHostRuleState(previousPacMods, target.host).mode :
    'auto';
  const pacMods = applyPopupDraftToPacMods(previousPacMods, tabUrl, draft);
  const nextSiteMode = target.controllable ?
    getPopupHostRuleState(pacMods, target.host).mode :
    'auto';
  return mv3State.savePacMods(pacMods, {
    resetProxyHealth:
      candidateFingerprint !==
        mv3ProxyHealth.getCandidateFingerprint(pacMods) ||
      previousSiteMode !== nextSiteMode,
  });

}

async function validatePopupDraftProxyCandidates(tabUrl, draft) {

  const state = await mv3State.loadState();
  const pacMods = applyPopupDraftToPacMods(state.pacMods, tabUrl, draft);
  const proxyRules = pacMods.exceptions
      .concat(pacMods.rules)
      .filter((rule) => rule.enabled && rule.action === 'PROXY');
  const explicitProxyResult = mv3PacCook.buildExplicitProxyResult(
      mv3PacMods.getProxyRuleCandidates(pacMods),
  );
  return {
    state,
    error: proxyRules.length && !explicitProxyResult ?
      NO_PROXY_CANDIDATE_MESSAGE :
      '',
  };

}

function applyPopupDraftToPacMods(pacMods, tabUrl, draft) {

  let nextPacMods = mv3PacMods.normalizePacMods(pacMods);
  const target = normalizePopupTabUrl(tabUrl);
  const siteMode = String(draft.siteMode || '').toLowerCase();
  if (siteMode) {
    if (!['proxy', 'auto', 'direct'].includes(siteMode)) {
      throw new TypeError('Unsupported site mode.');
    }
    if (target.controllable) {
      nextPacMods = setPopupHostMode(
          nextPacMods,
          target.host,
          siteMode,
          draft.siteScope,
      );
    }
  }
  if (draft.quickProxies) {
    nextPacMods = applyPopupQuickProxyToggles(
        nextPacMods,
        draft.quickProxies,
    );
  }
  return nextPacMods;

}

async function createPopupNoCandidateFailure(tabUrl, state) {

  return {
    ok: false,
    status: 'warning',
    message: NO_PROXY_CANDIDATE_MESSAGE,
    error: {
      code: 'PROXY_RULE_NO_CANDIDATE',
      message: NO_PROXY_CANDIDATE_MESSAGE,
    },
    popupState: await createPopupStateAndUpdateAction(tabUrl, state, {
      error: NO_PROXY_CANDIDATE_MESSAGE,
    }),
  };

}

function getPopupDraftProviderKey(draft) {

  if (!Object.prototype.hasOwnProperty.call(draft, 'providerKey')) {
    return undefined;
  }
  return draft.providerKey ? String(draft.providerKey) : null;

}

function applyPopupQuickProxyToggles(pacMods, quickProxies) {

  const normalized = mv3PacMods.normalizePacMods(pacMods);
  const quick = quickProxies || {};
  const next = Object.assign({}, normalized, {
    localTor: Object.assign({}, normalized.localTor),
    torBrowser: Object.assign({}, normalized.torBrowser),
    warp: Object.assign({}, normalized.warp),
    ownProxies: normalized.ownProxies.map((proxy) => Object.assign({}, proxy)),
  });
  setBooleanPropertyPatch(next, quick, 'usePacScriptProxies');
  setBooleanPropertyPatch(next, quick, 'ownProxiesOnlyForOwnSites');
  setBooleanPatch(next.localTor, quick, 'localTorEnabled');
  setBooleanPatch(next.torBrowser, quick, 'torBrowserEnabled');
  if (quick.torBrowserEnabled === true) {
    next.localTor.enabled = false;
  } else if (quick.localTorEnabled === true) {
    next.torBrowser.enabled = false;
  }
  const torModes = mv3PacMods.enforceExclusiveTorModes(
      next.localTor,
      next.torBrowser,
      'torBrowser',
  );
  next.localTor = torModes.localTor;
  next.torBrowser = torModes.torBrowser;
  setBooleanPatch(next.warp, quick, 'warpEnabled');
  if (
    Object.prototype.hasOwnProperty.call(quick, 'ownProxiesEnabled') &&
    next.ownProxies.length
  ) {
    const enabled = quick.ownProxiesEnabled === true;
    next.ownProxies = next.ownProxies.map((proxy) =>
      Object.assign({}, proxy, {enabled}),
    );
  }
  return next;

}

function setBooleanPatch(target, source, key) {

  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target.enabled = source[key] === true;
  }

}

function setBooleanPropertyPatch(target, source, key) {

  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key] === true;
  }

}

async function createPopupOperationFailure(message, tabUrl) {

  await notifyErrorIfEnabled('extError', 'Operation failed', message);
  return {
    ok: false,
    status: 'error',
    message,
    popupState: await createPopupStateAndUpdateAction(
        tabUrl,
        await mv3State.loadState(),
        {error: message},
    ),
  };

}

async function createPopupPipelineFailure(result, tabUrl) {

  const error = result && result.error;
  const message = error && error.message || 'PAC update failed.';
  await notifyErrorIfEnabled(getNotificationTypeForResult(result), 'Operation failed', message);
  return {
    ok: false,
    status: result && result.status || 'error',
    message,
    error: error || null,
    warnings: result && result.warnings || [],
    popupState: await createPopupStateAndUpdateAction(
        tabUrl,
        await mv3State.loadState(),
        {error: message},
    ),
  };

}

async function createPopupState(tabUrl, state) {

  const target = normalizePopupTabUrl(tabUrl);
  const pacMods = mv3PacMods.normalizePacMods(state.pacMods);
  const candidates = getPopupProxyCandidateSummary(pacMods);
  const providers = getProvidersForState(state, false);
  const selectedProvider = state.currentPacProviderKey || '';
  const selectedProviderDetails = providers.find((provider) =>
    provider.key === selectedProvider,
  );
  const warnings = [];
  let mode = 'auto';
  let siteRule = {
    scope: 'host',
    pattern: '',
  };
  const sitePatterns = target.controllable ?
    getPopupSitePatterns(target.host) :
    getPopupSitePatterns('');

  if (!target.controllable) {
    warnings.push(target.reason);
  } else {
    siteRule = getPopupHostRuleState(pacMods, target.host);
    mode = siteRule.mode;
    if (mode === 'proxy' && candidates.available === false) {
      warnings.push(NO_PROXY_CANDIDATE_MESSAGE);
    }
  }

  const stale = await getCookedPacStaleness(state);
  const proxyApply = state.proxyApply || {};
  const proxyControl = state.proxyControl || {};
  const ifLivePacControlled = Boolean(
      proxyControl.controlledByThisExtension === true &&
      proxyControl.rawValue &&
      proxyControl.rawValue.mode === 'pac_script',
  );
  const autoUpdate = getPacAutoUpdateSummary(state);
  return {
    uiLanguage: state.uiLanguage || 'auto',
    host: target.host || '',
    controllable: target.controllable,
    reason: target.reason || '',
    mode,
    siteRule,
    sitePatterns,
    providers: providers.map((provider) => ({
      key: provider.key,
      label: provider.label,
      description: provider.description,
      type: provider.type,
      readOnly: provider.readOnly,
    })),
    selectedProvider,
    selectedProviderLabel: selectedProviderDetails ?
      selectedProviderDetails.label :
      '',
    pacDownloaded: Boolean(state.pacCache && state.pacCache.rawPacSha256),
    pacCooked: Boolean(
        state.cookedPacCache && state.cookedPacCache.cookedPacSha256,
    ),
    pacStale: stale.stale,
    pacStaleReasons: stale.reasons || [],
    pacUpdatedAt: autoUpdate.lastSuccessfulUpdateAt ||
      state.pacCache && state.pacCache.fetchedAt ||
      state.lastPacUpdateStamp ||
      null,
    pacCookedAt: state.cookedPacCache && state.cookedPacCache.cookedAt ||
      null,
    pacDownloadStatus: state.pacDownload && state.pacDownload.status ||
      'idle',
    pacCookStatus: state.pacCook && state.pacCook.status || 'idle',
    proxyApplied: proxyApply.status === 'applied' && ifLivePacControlled,
    proxyApplyStatus: proxyApply.status || 'idle',
    proxyHealth: state.proxyHealth,
    autoUpdate,
    proxyCandidates: candidates,
    quickProxies: getPopupQuickProxyState(pacMods),
    warnings,
  };

}

async function createPopupStateAndUpdateAction(tabUrl, state, overrides = {}) {

  const popupState = await createPopupState(tabUrl, state);
  await requestActionStatusRefresh({state, overrides});
  return popupState;

}

async function updateActionStatusFromStoredState(overrides = {}) {

  return requestActionStatusRefresh({overrides});

}

function requestActionStatusRefresh(params = {}) {

  return actionStatusRefresh.requestRefresh(params);

}

function normalizePopupTabUrl(tabUrl) {

  let parsed;
  try {
    parsed = new URL(String(tabUrl || ''));
  } catch (err) {
    return {
      controllable: false,
      host: '',
      reason: 'This page cannot be controlled.',
    };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    return {
      controllable: false,
      host: '',
      reason: 'This page cannot be controlled.',
    };
  }
  return {
    controllable: true,
    host: mv3SiteScope.normalizeHost(parsed.hostname),
    reason: '',
  };

}

function getPopupHostRuleState(pacMods, host) {

  return mv3SiteScope.getHostRuleState(pacMods, host);

}

function setPopupHostMode(pacMods, host, mode, scope) {

  return mv3SiteScope.setHostMode(pacMods, host, mode, scope);

}

function getPopupSitePatterns(host) {

  return mv3SiteScope.getSitePatterns(host);

}

function getPopupProxyCandidateSummary(pacMods) {

  const normalized = mv3PacMods.normalizePacMods(pacMods);
  const labels = [];
  if (normalized.localTor.enabled) {
    labels.push('Local Tor');
  }
  if (normalized.torBrowser.enabled) {
    labels.push('Tor Browser');
  }
  if (normalized.warp.enabled && normalized.warp.proxyString) {
    labels.push('WARP/custom proxy');
  }
  const ownProxyCount = normalized.ownProxies.filter((proxy) =>
    proxy && proxy.enabled !== false && proxy.host && proxy.port,
  ).length;
  if (ownProxyCount) {
    labels.push(`${ownProxyCount} own proxy${ownProxyCount === 1 ? '' : 'ies'}`);
  }
  const explicitProxyResult = mv3PacCook.buildExplicitProxyResult(
      mv3PacMods.getProxyRuleCandidates(normalized),
  );
  return {
    available: Boolean(explicitProxyResult),
    labels,
  };

}

function getPopupQuickProxyState(pacMods) {

  const normalized = mv3PacMods.normalizePacMods(pacMods);
  const ownProxyCount = normalized.ownProxies.length;
  const enabledOwnProxyCount = normalized.ownProxies.filter((proxy) =>
    proxy.enabled !== false,
  ).length;
  return {
    usePacScriptProxies: normalized.usePacScriptProxies !== false,
    usePacScriptProxiesEditable: true,
    ownProxiesOnlyForOwnSites: normalized.ownProxiesOnlyForOwnSites === true,
    localTorEnabled: normalized.localTor.enabled === true,
    torBrowserEnabled: normalized.torBrowser.enabled === true,
    warpEnabled: normalized.warp.enabled === true,
    ownProxiesConfigured: ownProxyCount > 0,
    ownProxiesEnabled: enabledOwnProxyCount > 0,
    ownProxyCount,
    enabledOwnProxyCount,
  };

}

function getEffectivePacUpdateSuccess(state) {

  const providerKey = state.currentPacProviderKey;
  const periodic = state.periodicUpdate || {};
  let lastSuccessfulUpdateAt =
    periodic.lastSuccessfulProviderKey === providerKey ?
      periodic.lastSuccessfulUpdateAt :
      null;
  const ifCurrentCacheBelongsToFailedPeriodicRun =
    periodic.lastFailureAt &&
    periodic.lastAttemptAt &&
    state.pacCache.fetchedAt &&
    periodic.lastAttemptAt <= state.pacCache.fetchedAt &&
    state.pacCache.fetchedAt <= periodic.lastFailureAt;
  if (
    !ifCurrentCacheBelongsToFailedPeriodicRun &&
    providerKey &&
    state.pacCache.providerKey === providerKey &&
    state.pacCache.fetchedAt &&
    state.cookedPacCache.providerKey === providerKey &&
    state.cookedPacCache.sourceRawPacSha256 === state.pacCache.rawPacSha256
  ) {
    lastSuccessfulUpdateAt = Math.max(
        lastSuccessfulUpdateAt || 0,
        state.pacCache.fetchedAt,
    );
  }
  return {
    providerKey,
    lastSuccessfulUpdateAt: lastSuccessfulUpdateAt || null,
  };

}

function getPacAutoUpdateSummary(state) {

  const periodic = state.periodicUpdate || {};
  const success = getEffectivePacUpdateSuccess(state);
  const dueAt = success.lastSuccessfulUpdateAt ?
    success.lastSuccessfulUpdateAt +
    periodic.intervalMinutes * 60 * 1000 :
    null;
  const nextUpdateAt = periodic.nextRunAt &&
    periodic.nextRunAt > Date.now() &&
    (dueAt === null || dueAt <= Date.now()) ?
    periodic.nextRunAt :
    dueAt;
  return {
    enabled: periodic.enabled === true,
    intervalHours: periodic.intervalMinutes / 60,
    lastAttemptAt: periodic.lastAttemptAt,
    lastSuccessfulUpdateAt: success.lastSuccessfulUpdateAt,
    lastFailureAt: periodic.lastFailureAt,
    lastFailureCode: periodic.lastFailureCode,
    consecutiveFailures: periodic.consecutiveFailures,
    nextUpdateAt: periodic.enabled ? nextUpdateAt : null,
    due: periodic.enabled === true && Boolean(success.providerKey) &&
      (dueAt === null || Date.now() >= dueAt),
    status: periodic.status,
    error: periodic.lastError,
  };

}

async function runAutomaticPacUpdateIfDue(params = {}) {

  let state = await mv3State.loadState();
  const trigger = params.trigger || 'watchdog';
  if (!state.periodicUpdate.enabled) {
    return createPeriodicSkip(
        'AUTO_UPDATE_DISABLED',
        'Automatic PAC updates are disabled.',
        {trigger},
    );
  }
  if (!state.currentPacProviderKey) {
    return createPeriodicSkip(
        'PROVIDER_NOT_SELECTED',
        'Select a PAC provider before running periodic updates.',
        {trigger},
    );
  }
  const success = getEffectivePacUpdateSuccess(state);
  if (
    success.lastSuccessfulUpdateAt &&
    (
      state.periodicUpdate.lastSuccessfulUpdateAt !==
        success.lastSuccessfulUpdateAt ||
      state.periodicUpdate.lastSuccessfulProviderKey !==
        success.providerKey
    )
  ) {
    await mv3State.setPeriodicUpdateState({
      lastSuccessfulUpdateAt: success.lastSuccessfulUpdateAt,
      lastSuccessfulProviderKey: success.providerKey,
      nextRunAt: success.lastSuccessfulUpdateAt +
        state.periodicUpdate.intervalMinutes * 60 * 1000,
    });
    state = await mv3State.loadState();
  }
  if (!mv3PeriodicUpdate.isUpdateDue(
      state.periodicUpdate,
      state.currentPacProviderKey,
  )) {
    await mv3State.setPeriodicUpdateState({
      status: 'scheduled',
      nextRunAt: mv3PeriodicUpdate.getDueAt(
          state.periodicUpdate,
          state.currentPacProviderKey,
      ),
    });
    return createPeriodicSkip(
        'PAC_UPDATE_NOT_DUE',
        'Automatic PAC update is not due yet.',
        {trigger, providerKey: state.currentPacProviderKey},
    );
  }
  return runPeriodicUpdate({
    trigger,
    applyIfSafe: true,
  });

}

function runPeriodicUpdate(params = {}) {

  const trigger = params.trigger || 'manual';
  if (pacDownloadPromise || pacCookPromise) {
    const ifAutomatic = trigger !== 'manual';
    const result = {
      ok: false,
      status: ifAutomatic ? 'skipped' : 'error',
      trigger,
      error: {
        code: 'PAC_OPERATION_IN_PROGRESS',
        message: 'A manual PAC operation is already running.',
        details: null,
      },
    };
    return mv3State.recordPeriodicUpdateEvent({
      type: 'in_progress',
      at: Date.now(),
      trigger,
      status: result.status,
      message: result.error.message,
      error: result.error,
    }).then(async () => {
      if (ifAutomatic) {
        await mv3PeriodicUpdate.scheduleDueCheck(15);
      }
      await updateActionStatusFromStoredState({
        error: result.status === 'error' ? result.error.message : '',
      });
      return result;
    });
  }

  return mv3PeriodicUpdate.runUpdate({
    trigger,
    applyIfSafe: params.applyIfSafe !== false,
    execute: executePeriodicUpdatePipeline,
  }).then(async (result) => {
    if (result && result.ok === false && result.status !== 'skipped') {
      await notifyErrorIfEnabled(
          'pacError',
          getChromeMessage(
              'periodicUpdateNotificationTitle',
              'PAC update failed',
          ),
          getChromeMessage(
              'periodicUpdateNotificationBody',
              'The automatic PAC update failed. Open settings for details.',
          ),
      );
    }
    await updateActionStatusFromStoredState({
      error: result && result.ok === false && result.status !== 'skipped' ?
        result.error && result.error.message || 'Periodic PAC update failed.' :
        '',
    });
    return result;
  });

}

async function executePeriodicUpdatePipeline({trigger, applyIfSafe}) {

  const initialState = await mv3State.loadState();
  const providerKey = initialState.currentPacProviderKey;
  if (!providerKey) {
    return createPeriodicSkip(
        'PROVIDER_NOT_SELECTED',
        'Select a PAC provider before running periodic updates.',
        {trigger},
    );
  }
  if (!getProviderForState(initialState, providerKey)) {
    return createPeriodicFailure(
        'PROVIDER_NOT_FOUND',
        'PAC provider was not found.',
        {trigger, providerKey},
    );
  }

  const autoApply = getPeriodicAutoApplyPlan(initialState, applyIfSafe);
  const download = await downloadPacAndPersist({providerKey});
  if (download.ok === false) {
    return createPeriodicFailure(
        download.error && download.error.code || 'PAC_DOWNLOAD_FAILED',
        download.error && download.error.message || 'PAC download failed.',
        {
          trigger,
          providerKey,
          details: download.error && download.error.details,
          downloadStatus: download.status,
          autoApply,
        },
    );
  }

  const cook = await cookPacAndPersist({providerKey});
  if (cook.ok === false) {
    return createPeriodicFailure(
        cook.error && cook.error.code || 'PAC_COOK_FAILED',
        cook.error && cook.error.message || 'PAC cooking failed.',
        {
          trigger,
          providerKey,
          details: cook.error && cook.error.details,
          downloadStatus: download.status,
          cookStatus: cook.status,
          autoApply,
        },
    );
  }

  let finalAutoApply = autoApply;
  if (autoApply.allowed) {
    finalAutoApply = await applyPeriodicUpdateIfStillSafe(
        providerKey,
        autoApply.previousCookedPacSha256,
    );
    if (finalAutoApply.status === 'error') {
      return createPeriodicFailure(
          finalAutoApply.error.code,
          finalAutoApply.error.message,
          {
            trigger,
            providerKey,
            details: finalAutoApply.error.details,
            downloadStatus: download.status,
            cookStatus: cook.status,
            autoApply: finalAutoApply,
          },
      );
    }
  }

  return {
    ok: true,
    status: 'success',
    trigger,
    providerKey,
    successfulUpdateAt: Date.now(),
    downloadStatus: download.status,
    cookStatus: cook.status,
    rawPacSha256: download.pacCache && download.pacCache.rawPacSha256 ||
      null,
    cookedPacSha256: cook.cookedPacCache &&
      cook.cookedPacCache.cookedPacSha256 || null,
    autoApply: finalAutoApply,
  };

}

function createPeriodicSkip(code, message, metadata = {}) {

  return {
    ok: false,
    status: 'skipped',
    trigger: metadata.trigger || null,
    providerKey: metadata.providerKey || null,
    message,
    error: {
      code,
      message,
      details: metadata.details || null,
    },
  };

}

function createPeriodicFailure(code, message, metadata = {}) {

  return {
    ok: false,
    status: 'error',
    trigger: metadata.trigger || null,
    providerKey: metadata.providerKey || null,
    downloadStatus: metadata.downloadStatus || null,
    cookStatus: metadata.cookStatus || null,
    autoApply: metadata.autoApply || null,
    error: {
      code,
      message,
      details: metadata.details || null,
    },
  };

}

function getPeriodicAutoApplyPlan(state, applyIfSafe) {

  const providerKey = state.currentPacProviderKey;
  const proxyApply = state.proxyApply || {};
  if (!applyIfSafe) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'apply disabled for this run',
    };
  }
  if (proxyApply.status !== 'applied') {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'proxy is not currently applied by this extension',
    };
  }
  if (proxyApply.providerKey !== providerKey) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'applied provider does not match selected provider',
      appliedProviderKey: proxyApply.providerKey || null,
    };
  }
  if (!proxyApply.cookedPacSha256) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'applied cooked PAC metadata is missing',
    };
  }
  return {
    allowed: true,
    status: 'pending',
    reason: 'proxy was already applied for the selected provider',
    appliedProviderKey: proxyApply.providerKey,
    previousCookedPacSha256: proxyApply.cookedPacSha256,
  };

}

async function applyPeriodicUpdateIfStillSafe(
    providerKey,
    previousCookedPacSha256,
) {

  const state = await mv3State.loadState();
  if (
    state.cookedPacCache.providerKey !== providerKey ||
    !state.cookedPacCache.cookedPacSha256
  ) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'cooked PAC cache is missing or belongs to another provider',
    };
  }

  const stale = await getCookedPacStaleness(state);
  if (stale.stale) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'cooked PAC is stale',
      stale,
    };
  }

  const control = await refreshProxyControlAndPersist();
  if (!control.canControl) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'proxy settings are not controllable by this extension',
      levelOfControl: control.levelOfControl,
      error: control.error,
    };
  }
  if (
    control.controlledByThisExtension !== true ||
    !control.rawValue ||
    control.rawValue.mode !== 'pac_script'
  ) {
    return {
      allowed: false,
      status: 'skipped',
      reason: 'proxy settings are not currently controlled by this extension',
      levelOfControl: control.levelOfControl,
      rawValue: control.rawValue,
    };
  }
  if (
    previousCookedPacSha256 &&
    state.cookedPacCache.cookedPacSha256 === previousCookedPacSha256
  ) {
    return {
      allowed: true,
      status: 'unchanged',
      applied: false,
      reason: 'effective cooked PAC is unchanged',
      proxyControl: control,
    };
  }

  const apply = await applyCookedPacAndPersist({});
  if (apply.ok === false) {
    return {
      allowed: true,
      status: 'error',
      error: apply.error || {
        code: 'PROXY_SET_FAILED',
        message: 'Failed to apply cooked PAC.',
        details: null,
      },
    };
  }
  return {
    allowed: true,
    status: 'applied',
    applied: true,
    proxyApply: apply.proxyApply,
    proxyControl: apply.proxyControl,
  };

}

async function handleRpcMessage(message) {

  const handler = RPC_METHODS[message.method];
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_METHOD',
        message: 'Unknown RPC method',
      },
    };
  }

  try {
    const result = await handler(message.params || {});
    return {
      ok: true,
      result,
    };
  } catch (err) {
    return createErrorResponse(err);
  }

}

function createErrorResponse(err) {

  return {
    ok: false,
    error: {
      code: err && err.code ||
        (err instanceof TypeError ? 'INVALID_PARAMS' : 'INTERNAL_ERROR'),
      message: err && err.message || 'Internal RPC error',
      details: err && err.details || null,
    },
  };

}

function createPacDownloadFailure(code, message, metadata = {}) {

  return Object.assign({
    ok: false,
    status: 'error',
    providerKey: metadata.providerKey || null,
    url: metadata.url || null,
    error: {
      code,
      message,
      details: metadata.details || null,
    },
  }, metadata);

}

function createPacDownloadState(status, metadata = {}) {

  return {
    status,
    providerKey: metadata.providerKey || null,
    url: metadata.url || null,
    startedAt: metadata.startedAt || null,
    finishedAt: metadata.finishedAt || null,
    httpStatus: metadata.httpStatus || null,
    contentLength: metadata.contentLength || null,
    sha256: metadata.sha256 || null,
    lastModified: metadata.lastModified || null,
    etag: metadata.etag || null,
    error: metadata.error || null,
  };

}

function createPacCookFailure(code, message, metadata = {}) {

  return Object.assign({
    ok: false,
    status: 'error',
    providerKey: metadata.providerKey || null,
    sourceRawPacSha256: metadata.sourceRawPacSha256 || null,
    error: {
      code,
      message,
      details: metadata.details || null,
    },
    warnings: metadata.warnings || [],
  }, metadata);

}

function createPacCookState(status, metadata = {}) {

  return {
    status,
    providerKey: metadata.providerKey || null,
    sourceRawPacSha256: metadata.sourceRawPacSha256 || null,
    pacModsSha256: metadata.pacModsSha256 || null,
    startedAt: metadata.startedAt || null,
    finishedAt: metadata.finishedAt || null,
    cookedPacSha256: metadata.cookedPacSha256 || null,
    cookedContentLength: metadata.cookedContentLength || null,
    warnings: metadata.warnings || [],
    error: metadata.error || null,
  };

}

function createProxyFailure(code, message, metadata = {}) {

  return Object.assign({
    ok: false,
    status: 'error',
    providerKey: metadata.providerKey || null,
    cookedPacSha256: metadata.cookedPacSha256 || null,
    error: {
      code,
      message,
      details: metadata.details || null,
    },
    warnings: metadata.warnings || [],
  }, metadata);

}

function normalizeProxyError(err, fallbackCode, fallbackMessage) {

  if (err && err.code && err.message) {
    return {
      code: err.code,
      message: err.message,
      details: err.details === undefined ? null : err.details,
    };
  }
  return {
    code: fallbackCode,
    message: err && err.message ? err.message : fallbackMessage,
    details: null,
  };

}

function createStructuredError(code, message, details) {

  const error = new Error(message);
  error.code = code;
  error.details = details === undefined ? null : details;
  return error;

}

function createProxyApplyState(status, metadata = {}) {

  return {
    status,
    providerKey: metadata.providerKey || null,
    cookedPacSha256: metadata.cookedPacSha256 || null,
    appliedAt: metadata.appliedAt || null,
    clearedAt: metadata.clearedAt || null,
    levelOfControl: metadata.levelOfControl || null,
    error: metadata.error || null,
    warnings: metadata.warnings || [],
  };

}

async function summarizePacCache(cache) {

  const summary = Object.assign({}, cache);
  summary.artifactPresent = Boolean(cache.artifactRef);
  return summary;

}

async function summarizeCookedPacCache(cache) {

  const summary = Object.assign({}, cache);
  summary.artifactPresent = Boolean(cache.artifactRef);
  return summary;

}

function createPacCacheFromDownload(result, rawArtifact, finishedAt) {

  return {
    providerKey: result.providerKey,
    url: result.url,
    fetchedAt: finishedAt,
    rawPacSha256: result.sha256,
    rawPacSize: rawArtifact.rawPacSize,
    lastModified: result.lastModified,
    etag: result.etag,
    artifactRef: rawArtifact.artifactRef,
  };

}

function createCookedPacCacheFromCook(result, cookedArtifact, finishedAt) {

  return {
    providerKey: result.providerKey,
    cookedAt: finishedAt,
    sourceRawPacSha256: result.sourceRawPacSha256,
    pacModsSha256: result.pacModsSha256,
    cookedPacSha256: result.cookedPacSha256,
    cookedPacSize: cookedArtifact.cookedPacSize,
    warnings: result.warnings,
    artifactRef: cookedArtifact.artifactRef,
  };

}

async function getCookedPacStaleness(state) {

  const cache = state.cookedPacCache;
  const reasons = [];
  if (!cache.cookedPacSha256) {
    return {
      stale: false,
      reasons,
    };
  }
  if (cache.providerKey !== state.currentPacProviderKey) {
    reasons.push('selected provider changed');
  }
  if (!state.pacCache.rawPacSha256) {
    reasons.push('raw PAC cache is missing');
  } else if (cache.sourceRawPacSha256 !== state.pacCache.rawPacSha256) {
    reasons.push('raw PAC cache changed');
  }

  const currentPacModsSha256 = await mv3PacCook.hashPacMods(state.pacMods);
  if (cache.pacModsSha256 !== currentPacModsSha256) {
    reasons.push('PAC modifiers changed');
  }
  return {
    stale: reasons.length > 0,
    reasons,
    currentPacModsSha256,
  };

}

async function getProxyStatusFromState(state, cookedPacStale) {

  return {
    proxyApply: state.proxyApply,
    proxyControl: state.proxyControl,
    stale: {
      cookedPac: cookedPacStale || await getCookedPacStaleness(state),
    },
    currentPacProviderKey: state.currentPacProviderKey,
    cookedPacCache: await summarizeCookedPacCache(state.cookedPacCache),
    proxyHealth: state.proxyHealth,
  };

}

function getChromeMessage(key, fallback) {

  if (
    chrome.i18n &&
    typeof chrome.i18n.getMessage === 'function'
  ) {
    return chrome.i18n.getMessage(key) || fallback;
  }
  return fallback;

}

function getProxyHealthMessage(candidateType, ifNotification) {

  if (candidateType === 'torBrowser') {
    return ifNotification ?
      getChromeMessage(
          'proxyHealthTorBrowserNotification',
          'Tor Browser is unavailable. Start Tor Browser and try again.',
      ) :
      getChromeMessage(
          'proxyHealthTorBrowserError',
          'Could not connect to Tor Browser. Make sure Tor Browser is running ' +
          'and 127.0.0.1:9150 is available.',
      );
  }
  if (candidateType === 'localTor') {
    return ifNotification ?
      getChromeMessage(
          'proxyHealthLocalTorNotification',
          'The Tor service is unavailable. Start Tor and try again.',
      ) :
      getChromeMessage(
          'proxyHealthLocalTorError',
          'Could not connect to the Tor service. Make sure Tor is running and ' +
          '127.0.0.1:9050 is available.',
      );
  }
  return getChromeMessage(
      'proxyHealthGenericError',
      'Could not connect through the configured proxy.',
  );

}

async function recordProxyHealthFailure(details) {

  const errorCode = mv3ProxyHealth.normalizeErrorCode(details && details.error);
  if (!mv3ProxyHealth.isProxyError(errorCode)) {
    return {ok: false, status: 'ignored'};
  }
  const state = await mv3State.loadState();
  if (state.proxyApply.status !== 'applied') {
    return {ok: false, status: 'ignored'};
  }
  const control = await mv3ProxySettings.getProxyControlState();
  if (
    control.controlledByThisExtension !== true ||
    !control.rawValue ||
    control.rawValue.mode !== 'pac_script'
  ) {
    return {ok: false, status: 'ignored'};
  }

  const failureOrigin = mv3ProxyHealth.sanitizeOrigin(details && details.url);
  const failureHost = mv3ProxyHealth.sanitizeHostname(details && details.url);
  const ifExplicitProxyRule = failureHost &&
    getPopupHostRuleState(state.pacMods, failureHost).mode === 'proxy';
  const candidate = ifExplicitProxyRule ?
    mv3ProxyHealth.getCandidateSummary(state.pacMods) :
    {type: null, endpoint: ''};
  const debounceKey = mv3ProxyHealth.getNotificationKey(
      errorCode,
      candidate.type,
  );
  const now = Date.now();
  const lastDebouncedAt = proxyErrorDebounce.get(debounceKey) || 0;
  if (now - lastDebouncedAt < mv3ProxyHealth.ERROR_DEBOUNCE_MS) {
    return {ok: false, status: 'debounced'};
  }
  proxyErrorDebounce.set(debounceKey, now);
  if (proxyErrorDebounce.size > 50) {
    for (const [key, at] of proxyErrorDebounce) {
      if (now - at >= mv3ProxyHealth.ERROR_DEBOUNCE_MS) {
        proxyErrorDebounce.delete(key);
      }
    }
  }

  const previous = state.proxyHealth || {};
  const targetOrigin = ifExplicitProxyRule ?
    failureOrigin :
    previous.targetOrigin;
  const ifNotify = mv3ProxyHealth.shouldNotify(
      previous,
      errorCode,
      candidate.type,
      now,
  );
  const patch = {
    status: 'error',
    lastCheckedAt: now,
    lastErrorAt: now,
    lastErrorCode: errorCode,
    lastErrorMessage: errorCode,
    lastErrorUrl: failureHost,
    candidateType: candidate.type,
    candidateEndpoint: candidate.endpoint || null,
    targetOrigin: targetOrigin || null,
  };
  if (ifNotify) {
    patch.lastNotificationAt = now;
    patch.lastNotificationKey = debounceKey;
  }
  const proxyHealth = await mv3State.setProxyHealthState(patch);
  if (ifNotify) {
    await mv3ActionStatus.notify({
      prefs: state.notificationPrefs,
      type: 'extError',
      title: getChromeMessage('proxyHealthNotificationTitle', 'Proxy error'),
      message: getProxyHealthMessage(candidate.type, true),
    });
  }
  await updateActionStatusFromStoredState({});
  return {
    ok: false,
    status: 'error',
    proxyHealth,
  };

}

function createProxyCheckResult(status, code, message, proxyHealth) {

  return {
    ok: status === 'ok',
    status,
    code,
    message,
    proxyHealth,
  };

}

function runProxyHealthCheck(params = {}) {

  if (proxyHealthCheckPromise) {
    return Promise.resolve(createProxyCheckResult(
        'checking',
        'PROXY_CHECK_IN_PROGRESS',
        'A proxy check is already running.',
        null,
    ));
  }
  proxyHealthCheckPromise = runProxyHealthCheckInternal(params)
      .finally(() => {
        proxyHealthCheckPromise = null;
      });
  return proxyHealthCheckPromise;

}

async function runProxyHealthCheckInternal(params) {

  const state = await mv3State.loadState();
  const requestedTarget = params.tabUrl ||
    state.proxyHealth && state.proxyHealth.targetOrigin;
  const targetOrigin = mv3ProxyHealth.sanitizeOrigin(requestedTarget);
  if (!targetOrigin) {
    return createProxyCheckResult(
        'inconclusive',
        'PROXY_CHECK_REQUIRES_PROXY_RULE',
        'Enable Proxy mode for the current site before checking.',
        state.proxyHealth,
    );
  }
  const host = new URL(targetOrigin).hostname.toLowerCase();
  if (getPopupHostRuleState(state.pacMods, host).mode !== 'proxy') {
    return createProxyCheckResult(
        'inconclusive',
        'PROXY_CHECK_REQUIRES_PROXY_RULE',
        'Enable Proxy mode for the current site before checking.',
        state.proxyHealth,
    );
  }
  if (state.proxyApply.status !== 'applied') {
    return createProxyCheckResult(
        'inconclusive',
        'PROXY_CHECK_NOT_APPLIED',
        'Apply proxy settings before checking.',
        state.proxyHealth,
    );
  }
  const control = await refreshProxyControlAndPersist();
  if (
    control.controlledByThisExtension !== true ||
    !control.rawValue ||
    control.rawValue.mode !== 'pac_script'
  ) {
    return createProxyCheckResult(
        'inconclusive',
        'PROXY_CHECK_NOT_APPLIED',
        'Apply proxy settings before checking.',
        state.proxyHealth,
    );
  }

  const candidate = mv3ProxyHealth.getCandidateSummary(state.pacMods);
  if (!candidate.type) {
    return createProxyCheckResult(
        'inconclusive',
        'NO_PROXY_CANDIDATE',
        'No proxy candidate is enabled.',
        state.proxyHealth,
    );
  }
  const previousHealth = state.proxyHealth;
  const startedAt = Date.now();
  await mv3State.setProxyHealthState({
    status: 'checking',
    candidateType: candidate.type,
    candidateEndpoint: candidate.endpoint || null,
    targetOrigin,
  });
  await updateActionStatusFromStoredState({});

  const controller = new AbortController();
  const timeoutId = setTimeout(
      () => controller.abort(),
      mv3ProxyHealth.CHECK_TIMEOUT_MS,
  );
  try {
    // Fetch cannot expose which PAC branch was used. The explicit Proxy rule
    // makes the target deterministic; webRequest proxy errors remain authoritative.
    const response = await fetch(targetOrigin, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (response.body && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {});
    }
    const checkedAt = Date.now();
    const proxyHealth = await mv3State.setProxyHealthState({
      status: 'ok',
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorUrl: null,
      candidateType: candidate.type,
      candidateEndpoint: candidate.endpoint || null,
      targetOrigin,
      lastNotificationAt: null,
      lastNotificationKey: null,
    });
    await updateActionStatusFromStoredState({});
    return createProxyCheckResult(
        'ok',
        null,
        'Proxy connectivity check succeeded.',
        proxyHealth,
    );
  } catch (err) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const latest = await mv3State.loadState();
    if (
      latest.proxyHealth.status === 'error' &&
      latest.proxyHealth.lastErrorAt >= startedAt &&
      latest.proxyHealth.lastErrorUrl === host
    ) {
      return createProxyCheckResult(
          'error',
          latest.proxyHealth.lastErrorCode,
          getProxyHealthMessage(latest.proxyHealth.candidateType, false),
          latest.proxyHealth,
      );
    }
    const checkedAt = Date.now();
    const restoreError = previousHealth.status === 'error';
    const proxyHealth = await mv3State.setProxyHealthState({
      status: restoreError ? 'error' : 'unknown',
      lastCheckedAt: checkedAt,
      candidateType: candidate.type,
      candidateEndpoint: candidate.endpoint || null,
      targetOrigin,
      lastErrorAt: restoreError ? previousHealth.lastErrorAt : null,
      lastErrorCode: restoreError ? previousHealth.lastErrorCode : null,
      lastErrorMessage: restoreError ? previousHealth.lastErrorMessage : null,
      lastErrorUrl: restoreError ? previousHealth.lastErrorUrl : null,
    });
    await updateActionStatusFromStoredState({});
    return createProxyCheckResult(
        'inconclusive',
        err && err.name === 'AbortError' ?
          'PROXY_CHECK_TIMEOUT' :
          'PROXY_CHECK_INCONCLUSIVE',
        'The request failed without a proxy-specific browser error.',
        proxyHealth,
    );
  } finally {
    clearTimeout(timeoutId);
  }

}

function getProxyAuthStatusFromState(state) {

  return mv3ProxyAuth.getProxyAuthStatus(state);

}

async function refreshProxyControlAndPersist() {

  return (await refreshProxyControlAndPersistWithState()).proxyControl;

}

async function refreshProxyControlAndPersistWithState() {

  const proxyControl = await mv3ProxySettings.getProxyControlState();
  const state = await mv3State.saveStatePatch({proxyControl});
  return {
    proxyControl: state.proxyControl,
    state,
  };

}

async function handleProxySettingsChanged() {

  const previous = await mv3State.loadState();
  const refreshed = await refreshProxyControlAndPersistWithState();
  const proxyControl = refreshed.proxyControl;
  let state = refreshed.state;
  if (
    previous.proxyControl &&
    previous.proxyControl.canControl &&
    proxyControl.canControl === false
  ) {
    await notifyErrorIfEnabled(
        'noControl',
        'Proxy control changed',
        'This extension cannot control Chromium proxy settings.',
    );
  }
  if (
    proxyControl.controlledByThisExtension !== true ||
    !proxyControl.rawValue ||
    proxyControl.rawValue.mode !== 'pac_script'
  ) {
    await mv3State.resetProxyHealth();
    state = await mv3State.loadState();
  }
  return requestActionStatusRefresh({state});

}

async function handlePacOperationResult(result, fallbackMessage) {

  if (result && result.ok === false) {
    const error = result.error || {};
    await notifyErrorIfEnabled(
        'pacError',
        'PAC operation failed',
        error.message || fallbackMessage,
    );
  }
  return result;

}

async function handleProxyOperationResult(result, fallbackMessage) {

  if (result && result.ok === false) {
    const error = result.error || {};
    await notifyErrorIfEnabled(
        'extError',
        'Proxy operation failed',
        error.message || fallbackMessage,
    );
  }
  return result;

}

function getNotificationTypeForResult(result) {

  const code = result && result.error && result.error.code || '';
  if (
    code.includes('PAC') ||
    code.includes('PROVIDER') ||
    code.includes('ARTIFACT')
  ) {
    return 'pacError';
  }
  return 'extError';

}

async function notifyErrorIfEnabled(type, title, message) {

  const state = await mv3State.loadState();
  return mv3ActionStatus.notify({
    prefs: state.notificationPrefs,
    type,
    title,
    message,
  });

}

async function clearPacCacheAndArtifacts() {

  const cache = await mv3State.getPacCache();
  if (cache.providerKey && cache.rawPacSha256) {
    try {
      await mv3PacArtifacts.deleteRawPacArtifact({
        providerKey: cache.providerKey,
        sha256: cache.rawPacSha256,
      });
    } catch (err) {
      return createPacDownloadFailure(
          err.code || 'PAC_ARTIFACT_DELETE_FAILED',
          err.message || 'Failed to delete raw PAC artifact.',
          {
            providerKey: cache.providerKey,
            details: err.details || null,
          },
      );
    }
  }
  return mv3State.clearPacCache();

}

async function clearCookedPacCacheAndArtifacts() {

  const cache = await mv3State.getCookedPacCache();
  if (cache.providerKey && cache.cookedPacSha256) {
    try {
      await mv3PacArtifacts.deleteCookedPacArtifact({
        providerKey: cache.providerKey,
        sha256: cache.cookedPacSha256,
      });
    } catch (err) {
      return createPacCookFailure(
          err.code || 'PAC_ARTIFACT_DELETE_FAILED',
          err.message || 'Failed to delete cooked PAC artifact.',
          {
            providerKey: cache.providerKey,
            sourceRawPacSha256: cache.sourceRawPacSha256,
            details: err.details || null,
          },
      );
    }
  }
  return mv3State.clearCookedPacCache();

}

async function persistProxyFailure(code, message, metadata = {}) {

  const error = {
    code,
    message,
    details: metadata.details || null,
  };
  const proxyApply = await mv3State.setProxyApplyState(
      createProxyApplyState('error', Object.assign({}, metadata, {error})),
  );
  return Object.assign(
      createProxyFailure(code, message, metadata),
      {proxyApply},
  );

}

async function applyCookedPacAndPersist(params) {

  const state = await mv3State.loadState();
  const providerKey = state.currentPacProviderKey;
  const cache = state.cookedPacCache;
  if (!providerKey) {
    return persistProxyFailure(
        'VALIDATION_ERROR',
        'Select a PAC provider before applying proxy settings.',
    );
  }
  if (!cache.cookedPacSha256) {
    return persistProxyFailure(
        'COOKED_PAC_MISSING',
        'Cook PAC before applying proxy settings.',
        {providerKey},
    );
  }
  if (cache.providerKey !== providerKey) {
    return persistProxyFailure(
        'PROVIDER_MISMATCH',
        'Cooked PAC belongs to another provider.',
        {
          providerKey,
          cookedPacSha256: cache.cookedPacSha256,
          details: {cachedProviderKey: cache.providerKey},
        },
    );
  }

  const stale = await getCookedPacStaleness(state);
  const warnings = [];
  if (stale.stale) {
    if (!params.force) {
      return persistProxyFailure(
          'COOKED_PAC_STALE',
          'Cooked PAC is stale. Cook PAC again before applying.',
          {
            providerKey,
            cookedPacSha256: cache.cookedPacSha256,
            details: {reasons: stale.reasons},
          },
      );
    }
    warnings.push(`Forced stale cooked PAC apply: ${stale.reasons.join(', ')}.`);
  }

  const control = await refreshProxyControlAndPersist();
  if (control.error && !control.canControl) {
    return persistProxyFailure(
        control.error.code || 'PROXY_READ_FAILED',
        control.error.message || 'Failed to read proxy settings.',
        {
          providerKey,
          cookedPacSha256: cache.cookedPacSha256,
          details: control.error.details,
        },
    );
  }
  if (!control.canControl) {
    return persistProxyFailure(
        'PROXY_NOT_CONTROLLABLE',
        'This extension cannot control Chromium proxy settings.',
        {
          providerKey,
          cookedPacSha256: cache.cookedPacSha256,
          details: {
            levelOfControl: control.levelOfControl,
            error: control.error,
          },
        },
    );
  }

  await mv3State.setProxyApplyState(createProxyApplyState('applying', {
    providerKey,
    cookedPacSha256: cache.cookedPacSha256,
    levelOfControl: control.levelOfControl,
    warnings,
  }));

  try {
    const cookedArtifact = await mv3PacArtifacts.getCookedPacArtifact({
      providerKey,
      sha256: cache.cookedPacSha256,
    });
    if (!cookedArtifact || !cookedArtifact.cookedPacData) {
      throw createStructuredError(
          'PAC_ARTIFACT_READ_FAILED',
          'Cooked PAC artifact is missing. Cook PAC again.',
          {providerKey, cookedPacSha256: cache.cookedPacSha256},
      );
    }
    await mv3ProxySettings.applyPacScript({
      cookedPacData: cookedArtifact.cookedPacData,
    });
    const appliedAt = Date.now();
    const proxyControl = await refreshProxyControlAndPersist();
    const proxyApply = await mv3State.setProxyApplyState(
        createProxyApplyState('applied', {
          providerKey,
          cookedPacSha256: cache.cookedPacSha256,
          appliedAt,
          levelOfControl: proxyControl.levelOfControl,
          warnings,
        }),
    );
    return {
      ok: true,
      status: 'applied',
      proxyApply,
      proxyControl,
      stale,
    };
  } catch (err) {
    const error = normalizeProxyError(
        err,
        'PROXY_SET_FAILED',
        'Failed to apply proxy settings.',
    );
    const proxyApply = await mv3State.setProxyApplyState(
        createProxyApplyState('error', {
          providerKey,
          cookedPacSha256: cache.cookedPacSha256,
          levelOfControl: control.levelOfControl,
          error,
          warnings,
        }),
    );
    return Object.assign(
        createProxyFailure(error.code, error.message, {
          providerKey,
          cookedPacSha256: cache.cookedPacSha256,
          details: error.details,
          warnings,
        }),
        {proxyApply},
    );
  }

}

async function clearProxyAndPersist() {

  const state = await mv3State.loadState();
  const control = await refreshProxyControlAndPersist();
  if (control.error && !control.canControl) {
    return persistProxyFailure(
        control.error.code || 'PROXY_READ_FAILED',
        control.error.message || 'Failed to read proxy settings.',
        {
          providerKey: state.currentPacProviderKey,
          cookedPacSha256: state.cookedPacCache.cookedPacSha256,
          details: control.error.details,
        },
    );
  }
  if (!control.canControl) {
    return persistProxyFailure(
        'PROXY_NOT_CONTROLLABLE',
        'This extension cannot control Chromium proxy settings.',
        {
          providerKey: state.currentPacProviderKey,
          cookedPacSha256: state.cookedPacCache.cookedPacSha256,
          details: {
            levelOfControl: control.levelOfControl,
            error: control.error,
          },
        },
    );
  }

  await mv3State.setProxyApplyState(createProxyApplyState('clearing', {
    providerKey: state.currentPacProviderKey,
    cookedPacSha256: state.cookedPacCache.cookedPacSha256,
    levelOfControl: control.levelOfControl,
  }));

  try {
    await mv3ProxySettings.clearProxySettings();
    const clearedAt = Date.now();
    const proxyControl = await refreshProxyControlAndPersist();
    const proxyApply = await mv3State.setProxyApplyState(
        createProxyApplyState('cleared', {
          providerKey: state.currentPacProviderKey,
          cookedPacSha256: state.cookedPacCache.cookedPacSha256,
          clearedAt,
          levelOfControl: proxyControl.levelOfControl,
        }),
    );
    await mv3State.resetProxyHealth();
    return {
      ok: true,
      status: 'cleared',
      proxyApply,
      proxyControl,
    };
  } catch (err) {
    const error = normalizeProxyError(
        err,
        'PROXY_CLEAR_FAILED',
        'Failed to clear proxy settings.',
    );
    const proxyApply = await mv3State.setProxyApplyState(
        createProxyApplyState('error', {
          providerKey: state.currentPacProviderKey,
          cookedPacSha256: state.cookedPacCache.cookedPacSha256,
          levelOfControl: control.levelOfControl,
          error,
        }),
    );
    return Object.assign(
        createProxyFailure(error.code, error.message, {
          providerKey: state.currentPacProviderKey,
          cookedPacSha256: state.cookedPacCache.cookedPacSha256,
          details: error.details,
        }),
        {proxyApply},
    );
  }

}

async function downloadPacAndPersist(params) {

  const state = await mv3State.loadState();
  const providerKey = params.providerKey === undefined ?
    state.currentPacProviderKey :
    params.providerKey;
  if (!providerKey) {
    const failure = createPacDownloadFailure(
        'PROVIDER_NOT_SELECTED',
        'Select a PAC provider before downloading.',
    );
    await mv3State.setPacDownloadState(createPacDownloadState('error', {
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  const provider = getProviderForState(state, providerKey);
  if (!provider) {
    const failure = createPacDownloadFailure(
        'PROVIDER_NOT_FOUND',
        'PAC provider was not found.',
        {providerKey},
    );
    await mv3State.setPacDownloadState(createPacDownloadState('error', {
      providerKey,
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  const startedAt = Date.now();
  await mv3State.setPacDownloadState(createPacDownloadState('downloading', {
    providerKey,
    startedAt,
  }));

  const cacheForHeaders = params.force ? null : state.pacCache;
  const result = await mv3PacDownload.downloadPac(provider, cacheForHeaders);
  const finishedAt = Date.now();

  if (result.ok && result.status === 'success') {
    let rawArtifact;
    if (
      state.pacCache.providerKey === result.providerKey &&
      state.pacCache.rawPacSha256 === result.sha256 &&
      state.pacCache.artifactRef
    ) {
      try {
        const cachedArtifact = await mv3PacArtifacts.getRawPacArtifact({
          providerKey: result.providerKey,
          sha256: result.sha256,
        });
        if (
          cachedArtifact &&
          cachedArtifact.rawPacSha256 === result.sha256 &&
          cachedArtifact.rawPacData === result.rawPacData
        ) {
          rawArtifact = cachedArtifact;
        }
      } catch (err) {
        rawArtifact = null;
      }
    }
    try {
      if (!rawArtifact) {
        rawArtifact = await mv3PacArtifacts.putRawPacArtifact({
          providerKey: result.providerKey,
          url: result.url,
          rawPacData: result.rawPacData,
          rawPacSha256: result.sha256,
          fetchedAt: finishedAt,
          lastModified: result.lastModified,
          etag: result.etag,
          contentLength: result.contentLength,
        });
      }
    } catch (err) {
      const error = normalizeProxyError(
          err,
          'PAC_ARTIFACT_STORE_FAILED',
          'Failed to store raw PAC artifact.',
      );
      const pacDownload = await mv3State.setPacDownloadState(
          createPacDownloadState('error', Object.assign({}, result, {
            startedAt,
            finishedAt,
            error,
          })),
      );
      return Object.assign(
          createPacDownloadFailure(error.code, error.message, {
            providerKey,
            url: result.url,
            details: error.details,
          }),
          {pacDownload},
      );
    }

    const nextState = await mv3State.saveStatePatch({
      pacCache: createPacCacheFromDownload(result, rawArtifact, finishedAt),
      pacDownload: createPacDownloadState(
          'success',
          Object.assign({}, result, {
            startedAt,
            finishedAt,
          }),
      ),
      lastPacUpdateStamp: finishedAt,
    });
    return {
      ok: true,
      status: 'success',
      pacDownload: nextState.pacDownload,
      pacCache: await summarizePacCache(nextState.pacCache),
    };
  }

  if (result.ok && result.status === 'not_modified') {
    const nextState = await mv3State.saveStatePatch({
      pacDownload: createPacDownloadState(
          'not_modified',
          Object.assign({}, result, {
            startedAt,
            finishedAt,
          }),
      ),
    });
    return {
      ok: true,
      status: 'not_modified',
      pacDownload: nextState.pacDownload,
      pacCache: await summarizePacCache(nextState.pacCache),
    };
  }

  const errorDownload = createPacDownloadState('error', Object.assign({}, result, {
    startedAt,
    finishedAt,
    error: result.error,
  }));
  const pacDownload = await mv3State.setPacDownloadState(errorDownload);
  return Object.assign({}, result, {
    pacDownload,
  });

}

async function cookPacAndPersist(params) {

  const state = await mv3State.loadState();
  const providerKey = params.providerKey === undefined ?
    state.currentPacProviderKey :
    params.providerKey;
  if (!providerKey) {
    const failure = createPacCookFailure(
        'PROVIDER_NOT_SELECTED',
        'Select a PAC provider before cooking.',
    );
    await mv3State.setPacCookState(createPacCookState('error', {
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  const provider = getProviderForState(state, providerKey);
  if (!provider) {
    const failure = createPacCookFailure(
        'PROVIDER_NOT_FOUND',
        'PAC provider was not found.',
        {providerKey},
    );
    await mv3State.setPacCookState(createPacCookState('error', {
      providerKey,
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  if (!state.pacCache.rawPacSha256) {
    const failure = createPacCookFailure(
        'PAC_CACHE_MISSING',
        'Download PAC before cooking.',
        {providerKey},
    );
    await mv3State.setPacCookState(createPacCookState('error', {
      providerKey,
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  if (state.pacCache.providerKey !== providerKey) {
    const failure = createPacCookFailure(
        'PAC_CACHE_MISSING',
        'Cached raw PAC belongs to another provider.',
        {
          providerKey,
          sourceRawPacSha256: state.pacCache.rawPacSha256,
          details: {cachedProviderKey: state.pacCache.providerKey},
        },
    );
    await mv3State.setPacCookState(createPacCookState('error', {
      providerKey,
      sourceRawPacSha256: state.pacCache.rawPacSha256,
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  const pacModsSha256 = await mv3PacCook.hashPacMods(state.pacMods);
  const cachedCook = state.cookedPacCache;
  if (
    cachedCook.providerKey === providerKey &&
    cachedCook.sourceRawPacSha256 === state.pacCache.rawPacSha256 &&
    cachedCook.pacModsSha256 === pacModsSha256 &&
    cachedCook.cookedPacSha256 &&
    cachedCook.artifactRef &&
    state.pacCook.status === 'success'
  ) {
    try {
      const cachedArtifact = await mv3PacArtifacts.getCookedPacArtifact({
        providerKey,
        sha256: cachedCook.cookedPacSha256,
      });
      if (
        cachedArtifact &&
        cachedArtifact.cookedPacData &&
        cachedArtifact.cookedPacSha256 === cachedCook.cookedPacSha256 &&
        cachedArtifact.sourceRawPacSha256 === state.pacCache.rawPacSha256 &&
        cachedArtifact.pacModsSha256 === pacModsSha256
      ) {
        const latestState = await mv3State.loadState();
        return {
          ok: true,
          status: 'not_modified',
          pacCook: state.pacCook,
          cookedPacCache: await summarizeCookedPacCache(cachedCook),
          stale: await getCookedPacStaleness(latestState),
        };
      }
    } catch (err) {
      // Fall through and reconstruct the cooked artifact from durable raw PAC.
    }
  }

  let rawArtifact;
  try {
    rawArtifact = await mv3PacArtifacts.getRawPacArtifact({
      providerKey,
      sha256: state.pacCache.rawPacSha256,
    });
  } catch (err) {
    const error = normalizeProxyError(
        err,
        'PAC_ARTIFACT_READ_FAILED',
        'Failed to read raw PAC artifact.',
    );
    const failure = createPacCookFailure(
        error.code,
        error.message,
        {
          providerKey,
          sourceRawPacSha256: state.pacCache.rawPacSha256,
          details: error.details,
        },
    );
    await mv3State.setPacCookState(createPacCookState('error', {
      providerKey,
      sourceRawPacSha256: state.pacCache.rawPacSha256,
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  if (!rawArtifact || !rawArtifact.rawPacData) {
    const failure = createPacCookFailure(
        'PAC_ARTIFACT_READ_FAILED',
        'Raw PAC artifact is missing. Download PAC again.',
        {
          providerKey,
          sourceRawPacSha256: state.pacCache.rawPacSha256,
        },
    );
    await mv3State.setPacCookState(createPacCookState('error', {
      providerKey,
      sourceRawPacSha256: state.pacCache.rawPacSha256,
      finishedAt: Date.now(),
      error: failure.error,
    }));
    return failure;
  }

  const startedAt = Date.now();
  await mv3State.setPacCookState(createPacCookState('cooking', {
    providerKey,
    sourceRawPacSha256: state.pacCache.rawPacSha256,
    pacModsSha256,
    startedAt,
  }));

  const result = await mv3PacCook.cookPac({
    rawPacData: rawArtifact.rawPacData,
    pacMods: state.pacMods,
    pacModsSha256,
    provider,
    sourceRawPacSha256: state.pacCache.rawPacSha256,
  });
  const finishedAt = Date.now();

  if (result.ok) {
    let cookedArtifact;
    try {
      cookedArtifact = await mv3PacArtifacts.putCookedPacArtifact({
        providerKey: result.providerKey,
        cookedPacData: result.cookedPacData,
        cookedPacSha256: result.cookedPacSha256,
        sourceRawPacSha256: result.sourceRawPacSha256,
        pacModsSha256: result.pacModsSha256,
        cookedAt: finishedAt,
        warnings: result.warnings,
        cookedPacSize: result.cookedContentLength,
      });
    } catch (err) {
      const error = normalizeProxyError(
          err,
          'PAC_ARTIFACT_STORE_FAILED',
          'Failed to store cooked PAC artifact.',
      );
      const pacCook = await mv3State.setPacCookState(
          createPacCookState('error', Object.assign({}, result, {
            startedAt,
            finishedAt,
            error,
          })),
      );
      return Object.assign(
          createPacCookFailure(error.code, error.message, {
            providerKey,
            sourceRawPacSha256: result.sourceRawPacSha256,
            details: error.details,
            warnings: result.warnings,
          }),
          {pacCook},
      );
    }

    const nextState = await mv3State.saveStatePatch({
      cookedPacCache: createCookedPacCacheFromCook(
          result,
          cookedArtifact,
          finishedAt,
      ),
      pacCook: createPacCookState('success', Object.assign({}, result, {
        startedAt,
        finishedAt,
      })),
    });
    const latestState = await mv3State.loadState();
    return {
      ok: true,
      status: 'success',
      pacCook: nextState.pacCook,
      cookedPacCache: await summarizeCookedPacCache(nextState.cookedPacCache),
      stale: await getCookedPacStaleness(latestState),
    };
  }

  const pacCook = await mv3State.setPacCookState(
      createPacCookState('error', Object.assign({}, result, {
        startedAt,
        finishedAt,
        error: result.error,
      })),
  );
  return Object.assign({}, result, {
    pacCook,
  });

}
