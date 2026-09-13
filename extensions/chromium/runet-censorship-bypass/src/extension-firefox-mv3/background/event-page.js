'use strict';

(function startFirefoxEventPage(root) {

  const offState = root.rucbFirefoxOffState;
  const proxyControlApi = root.rucbFirefoxProxyControl;
  const proxyAuthApi = root.rucbFirefoxProxyAuth;
  const routing = root.rucbFirefoxRoutingAdapter;
  const activationApi = root.rucbFirefoxActivationController;
  const datasetStoreApi = root.rucbFirefoxDatasetStore;
  const productConfigApi = root.rucbFirefoxProductConfig;
  const productionProviderApi = root.rucbFirefoxProductionProvider;
  const datasetPromotionApi = root.rucbFirefoxDatasetPromotion;
  const settingsControlApi = root.rucbFirefoxSettingsControl;
  const siteControlApi = root.rucbFirefoxSiteControl;
  const operationalStatusApi = root.rucbFirefoxOperationalStatus;
  let activationController = null;
  let settingsController = null;
  let siteController = null;
  let operationalController = null;
  let productionDatasetStore = null;
  let datasetPromotionController = null;
  let providerBootstrapState = Object.freeze({
    ok: false,
    status: 'INITIALIZING',
    datasetAvailable: false,
    productConfigAvailable: false,
  });

  async function sha256(bytes) {

    const digest = await root.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0')).join('');

  }

  function createProductionDatasetStore() {

    if (!productionDatasetStore) {
      const backend = datasetStoreApi.createIndexedDbBackend(root.indexedDB);
      productionDatasetStore = datasetStoreApi.createStore({backend, sha256});
    }
    return productionDatasetStore;

  }

  async function readPackagedAsset(relativePath, maximumBytes) {

    const packagedUrl = browser.runtime.getURL(relativePath);
    const response = await root.fetch(packagedUrl, {
      cache: 'no-store',
      credentials: 'omit',
      method: 'GET',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    if (!response || response.ok !== true || response.status !== 200 ||
        response.redirected === true || response.url !== packagedUrl) {
      const error = new TypeError('PACKAGED_ASSET_READ_FAILED');
      error.code = 'PACKAGED_ASSET_READ_FAILED';
      throw error;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maximumBytes) {
      const error = new TypeError('PACKAGED_ASSET_TOO_LARGE');
      error.code = 'PACKAGED_ASSET_TOO_LARGE';
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > maximumBytes) {
      const error = new TypeError('PACKAGED_ASSET_TOO_LARGE');
      error.code = 'PACKAGED_ASSET_TOO_LARGE';
      throw error;
    }
    return bytes;

  }

  const productFactoryOptions = {
    storageArea: browser.storage.local,
    createDatasetStore: createProductionDatasetStore,
    sha256,
  };
  const activationFactory = productConfigApi.createActivationFactory(
      productFactoryOptions,
  );
  const recoveryFactory = productConfigApi.createRecoveryFactory(
      productFactoryOptions,
  );
  const providerBootstrap = productionProviderApi.createBootstrap({
    storageArea: browser.storage.local,
    datasetStore: createProductionDatasetStore(),
    sha256,
    readPackagedAsset,
  });
  const routingAdapter = routing.createAdapter({
    runtimeStateForRequest: () => activationController ?
      activationController.currentRuntimeState() : routing.STATES.INITIALIZING,
    routingInputForRequest: (details) =>
      activationController.routingInputForRequest(details),
  });
  const proxyAuth = proxyAuthApi.createHandler({
    routingAdapter,
    resolveCredentials: (authRef) => activationController ?
      activationController.resolveCredentials(authRef) : null,
  });
  function clearEphemeralState() {

    routingAdapter.clearAllAuthorizations();
    proxyAuth.clearAllAttempts();

  }
  const proxyControl = proxyControlApi.createController({
    proxySettings: browser.proxy.settings,
    storageArea: browser.storage.local,
    isPrivateAccessAllowed: () =>
      browser.extension.isAllowedIncognitoAccess(),
    clearEphemeralState,
  });
  activationController = activationApi.createController({
    proxyControl,
    recoveryFactory,
    routingAdapter,
    proxyAuth,
    storageArea: browser.storage.local,
  });
  settingsController = settingsControlApi.createController({
    storageArea: browser.storage.local,
    sha256,
    activationSnapshot: () => activationController.snapshot(),
    async datasetIdentityAvailable(identity) {

      const stored = await createProductionDatasetStore().loadVerifications(
          identity.providerKey,
      );
      return [stored.active, stored.previousLkg, stored.packagedBaseline]
          .some((verification) => verification && verification.ok === true &&
            verification.dataset.identity.providerKey === identity.providerKey &&
            verification.dataset.identity.datasetVersion ===
              identity.datasetVersion &&
            verification.dataset.identity.artifactSha256 ===
              identity.artifactSha256);

    },
  });
  siteController = siteControlApi.createController({settingsController});
  operationalController = operationalStatusApi.createController({
    storageArea: browser.storage.local,
    actionApi: browser.action,
    notificationsApi: browser.notifications,
    tabsApi: browser.tabs,
    runtimeApi: browser.runtime,
    extensionApi: browser.extension,
    proxySettings: browser.proxy.settings,
    settingsController,
    siteController,
    activationSnapshot: () => activationController.snapshot(),
    fetch: root.fetch.bind(root),
    AbortController: root.AbortController,
    getMessage: (key) => browser.i18n.getMessage(key),
    getDatasetInfo: () => ({
      available: providerBootstrapState.datasetAvailable === true,
      version: productionProviderApi.DATASET_VERSION,
    }),
  });
  datasetPromotionController = datasetPromotionApi.createController({
    storageArea: browser.storage.local,
    datasetStore: createProductionDatasetStore(),
    sha256,
    activationSnapshot: () => activationController.snapshot(),
    providerKey: productionProviderApi.PROVIDER_KEY,
  });
  const bootId = root.crypto && typeof root.crypto.randomUUID === 'function' ?
    root.crypto.randomUUID() :
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function errorResponse(code) {

    return {ok: false, error: {code}};

  }

  const SAFE_APPLY_ERROR_CODES = new Set([
    ...Object.values(productConfigApi.ERRORS),
    ...Object.values(activationApi.ERRORS),
    ...Object.values(proxyControlApi.ERRORS),
    'DATASET_INDEX_BUILD_FAILED',
    'NO_USABLE_PROVIDER_DATASET',
    'SELECTED_DATASET_UNAVAILABLE',
  ]);
  const SAFE_SETTINGS_ERROR_CODES = new Set(
      Object.values(settingsControlApi.ERRORS)
          .concat(Object.values(siteControlApi.ERRORS)),
  );
  const SAFE_PROMOTION_ERROR_CODES = new Set(
      Object.values(datasetPromotionApi.ERRORS),
  );

  function exactRpcRequest(message, type) {

    return Boolean(message) && typeof message === 'object' &&
      !Array.isArray(message) && message.type === type &&
      Object.keys(message).length === 1;

  }

  function safeApplyErrorCode(value) {

    const code = typeof value === 'string' ? value :
      value && typeof value === 'object' ? value.code : null;
    return SAFE_APPLY_ERROR_CODES.has(code) ? code :
      activationApi.ERRORS.ACTIVATION_FAILED;

  }

  function safeSettingsErrorCode(value) {

    const code = typeof value === 'string' ? value :
      value && typeof value === 'object' ? value.code : null;
    return SAFE_SETTINGS_ERROR_CODES.has(code) ? code :
      settingsControlApi.ERRORS.SETTINGS_STATE_UNAVAILABLE;

  }

  function safePromotionErrorCode(value) {

    const code = typeof value === 'string' ? value :
      value && typeof value === 'object' ? value.code : null;
    return SAFE_PROMOTION_ERROR_CODES.has(code) ? code :
      datasetPromotionApi.ERRORS.RECOVERY_REQUIRED;

  }

  function exactSettingsReplaceRequest(message) {

    return Boolean(message) && typeof message === 'object' &&
      !Array.isArray(message) &&
      message.type === 'firefox.settings.replace' &&
      Object.keys(message).length === 3 &&
      Object.prototype.hasOwnProperty.call(message, 'expectedRevision') &&
      Object.prototype.hasOwnProperty.call(message, 'settings');

  }

  function exactSiteGetRequest(message) {

    return Boolean(message) && typeof message === 'object' &&
      !Array.isArray(message) && message.type === 'firefox.site.get' &&
      Object.keys(message).length === 2 &&
      Object.prototype.hasOwnProperty.call(message, 'tabUrl') &&
      typeof message.tabUrl === 'string';

  }

  function exactSiteReplaceRequest(message) {

    return Boolean(message) && typeof message === 'object' &&
      !Array.isArray(message) && message.type === 'firefox.site.replace' &&
      Object.keys(message).length === 5 &&
      Object.prototype.hasOwnProperty.call(message, 'tabUrl') &&
      Object.prototype.hasOwnProperty.call(message, 'expectedRevision') &&
      Object.prototype.hasOwnProperty.call(message, 'mode') &&
      Object.prototype.hasOwnProperty.call(message, 'scope');

  }

  function exactHealthCheckRequest(message) {

    if (!message || typeof message !== 'object' || Array.isArray(message) ||
        message.type !== 'firefox.health.check') {
      return false;
    }
    const keys = Object.keys(message).sort();
    return keys.length === 1 && keys[0] === 'type' ||
      keys.length === 2 && keys[0] === 'tabUrl' && keys[1] === 'type' &&
      typeof message.tabUrl === 'string';

  }

  async function readPrivateWindowAccess() {

    try {
      const allowed = await browser.extension.isAllowedIncognitoAccess();
      return allowed ? 'GRANTED' : 'DENIED';
    } catch (_error) {
      return 'UNKNOWN';
    }

  }

  let rpcControlQueue = Promise.resolve();

  function enqueueRpcControlOperation(operation) {

    const result = rpcControlQueue.then(operation, operation);
    rpcControlQueue = result.catch(() => undefined);
    return result;

  }

  async function applyPersistedProductConfiguration() {

    const current = activationController.snapshot();
    if (current.active) {
      return errorResponse(activationApi.ERRORS.ACTIVATION_ALREADY_ACTIVE);
    }
    if (current.durableIntent !== offState.OFF ||
        current.runtimeState !== routing.STATES.OFF) {
      return errorResponse(activationApi.ERRORS.BOOT_NOT_READY);
    }
    let prepared;
    try {
      prepared = await activationFactory();
    } catch (error) {
      return errorResponse(safeApplyErrorCode(error));
    }
    let activated;
    try {
      activated = await activationController.activatePrepared(prepared);
    } catch (_error) {
      return errorResponse(activationApi.ERRORS.ACTIVATION_FAILED);
    }
    if (!activated || activated.ok !== true) {
      return errorResponse(safeApplyErrorCode(
          activated && activated.error,
      ));
    }
    return {
      ok: true,
      result: {intent: offState.ON, status: activated.status},
    };

  }

  async function clearProductActivation() {

    const cleared = await activationController.clear();
    if (!cleared.ok) {
      return errorResponse(cleared.error.code);
    }
    return {
      ok: true,
      result: {intent: offState.OFF, status: cleared.status},
    };

  }

  async function getProductSettings() {

    try {
      return {ok: true, result: await settingsController.get()};
    } catch (error) {
      return errorResponse(safeSettingsErrorCode(error));
    }

  }

  async function replaceProductSettings(message) {

    try {
      return {
        ok: true,
        result: await settingsController.replace(
            message.expectedRevision,
            message.settings,
        ),
      };
    } catch (error) {
      return errorResponse(safeSettingsErrorCode(error));
    }

  }

  async function getSiteSettings(message) {

    try {
      return {ok: true, result: await siteController.get(message.tabUrl)};
    } catch (error) {
      return errorResponse(safeSettingsErrorCode(error));
    }

  }

  async function replaceSiteSettings(message) {

    try {
      return {ok: true, result: await siteController.replace(message)};
    } catch (error) {
      return errorResponse(safeSettingsErrorCode(error));
    }

  }

  async function installStagedProviderDataset() {

    try {
      const installed = await datasetPromotionController.install();
      return {ok: true, result: {status: installed.status}};
    } catch (error) {
      return errorResponse(safePromotionErrorCode(error));
    }

  }

  async function runOperationalAction(kind, operation) {

    const token = operationalController.beginOperation(kind);
    try {
      return await operation();
    } finally {
      await operationalController.endOperation(token);
    }

  }

  async function runHealthCheck(message) {

    try {
      return {
        ok: true,
        result: await operationalController.checkHealth(message.tabUrl),
      };
    } catch (_error) {
      return errorResponse('OPERATIONAL_STATE_UNAVAILABLE');
    }

  }

  async function handleMessage(message) {

    await initialization;
    const type = message && typeof message === 'object' ? message.type : null;
    if (type === 'firefox.capabilities.get') {
      const manifest = browser.runtime.getManifest();
      const activation = activationController.snapshot();
      return {
        ok: true,
        result: {
          apiVersion: 2,
          browser: 'FIREFOX',
          manifestVersion: manifest.manifest_version,
          runtimeModel: 'BACKGROUND_EVENT_PAGE',
          runtimeState: activation.runtimeState,
          durableIntent: activation.durableIntent,
          recoveryStatus: activation.recoveryStatus,
          recoveryFailureCode: activation.failureCode,
          privateWindowAccess: await readPrivateWindowAccess(),
          routingImplemented: true,
          activationSupported: true,
          providerDatasetImplemented: true,
          providerDatasetAvailable:
            providerBootstrapState.datasetAvailable === true,
        },
      };
    }
    if (type === 'firefox.activation.apply') {
      if (!exactRpcRequest(message, type)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(() => runOperationalAction(
          'APPLY',
          async () => {
            const result = await applyPersistedProductConfiguration();
            if (result.ok === true) {
              await operationalController.resetHealth();
            }
            return result;
          },
      ));
    }
    if (type === 'firefox.activation.clear') {
      if (!exactRpcRequest(message, type)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(() => runOperationalAction(
          'CLEAR',
          async () => {
            const result = await clearProductActivation();
            if (result.ok === true) {
              await operationalController.resetHealth();
            }
            return result;
          },
      ));
    }
    if (type === 'firefox.settings.get') {
      if (!exactRpcRequest(message, type)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(getProductSettings);
    }
    if (type === 'firefox.settings.replace') {
      if (!exactSettingsReplaceRequest(message)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(() => replaceProductSettings(message));
    }
    if (type === 'firefox.site.get') {
      if (!exactSiteGetRequest(message)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(() => getSiteSettings(message));
    }
    if (type === 'firefox.site.replace') {
      if (!exactSiteReplaceRequest(message)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(async () => {
        const result = await replaceSiteSettings(message);
        await operationalController.refreshToolbar();
        return result;
      });
    }
    if (type === 'firefox.operational.get') {
      if (!exactRpcRequest(message, type)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      try {
        return {ok: true, result: await operationalController.publicStatus()};
      } catch (_error) {
        return errorResponse('OPERATIONAL_STATE_UNAVAILABLE');
      }
    }
    if (type === 'firefox.health.check') {
      if (!exactHealthCheckRequest(message)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(() => runOperationalAction(
          'HEALTH', () => runHealthCheck(message),
      ));
    }
    if (type === 'firefox.provider.update.install') {
      if (!exactRpcRequest(message, type)) {
        return errorResponse('INVALID_RPC_REQUEST');
      }
      return enqueueRpcControlOperation(installStagedProviderDataset);
    }
    return errorResponse('UNKNOWN_RPC');

  }

  browser.proxy.onRequest.addListener(
      routingAdapter.onProxyRequest,
      {urls: ['<all_urls>']},
  );
  browser.proxy.settings.onChange.addListener((change) => {

    const result = activationController.handleProxySettingsChange(change);
    operationalController.handleControlChange(result);

  });
  browser.webRequest.onBeforeRequest.addListener(
      routingAdapter.onBeforeRequest,
      {urls: ['<all_urls>']},
      ['blocking'],
  );
  browser.webRequest.onAuthRequired.addListener(
      proxyAuth.onAuthRequired,
      {urls: ['<all_urls>']},
      ['blocking'],
  );
  function onRequestTerminal(details) {

    routingAdapter.onRequestTerminal(details);
    proxyAuth.onRequestTerminal(details);

  }
  browser.webRequest.onCompleted.addListener(
      onRequestTerminal,
      {urls: ['<all_urls>']},
  );
  browser.webRequest.onErrorOccurred.addListener(
      onRequestTerminal,
      {urls: ['<all_urls>']},
  );
  browser.runtime.onMessage.addListener(handleMessage);
  if (browser.tabs && browser.tabs.onActivated) {
    browser.tabs.onActivated.addListener((activeInfo) => {

      operationalController.refreshToolbar({tabId: activeInfo.tabId})
          .catch(() => undefined);

    });
  }
  if (browser.tabs && browser.tabs.onUpdated) {
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {

      if (!tab || tab.active !== true || !changeInfo ||
          !Object.prototype.hasOwnProperty.call(changeInfo, 'url') &&
          changeInfo.status !== 'complete') {
        return;
      }
      operationalController.refreshToolbar({tabId, tab})
          .catch(() => undefined);

    });
  }
  if (browser.windows && browser.windows.onFocusChanged) {
    browser.windows.onFocusChanged.addListener(() => {

      operationalController.refreshToolbar().catch(() => undefined);

    });
  }
  if (browser.notifications && browser.notifications.onClicked) {
    browser.notifications.onClicked.addListener((notificationId) => {

      operationalController.handleNotificationClicked(notificationId)
          .catch(() => undefined);

    });
  }

  operationalController.showLoading().catch(() => undefined);

  const initialization = (async () => {

    providerBootstrapState = await providerBootstrap.initialize();
    await datasetPromotionController.initialize();
    await settingsController.initialize();
    const activation = await activationController.initializeFromDurable();
    await operationalController.initialize();
    await operationalController.restoreToolbar();
    await operationalController.reconcileStartupAttention();
    return activation;

  })();

  root.rucbFirefoxRuntime = Object.freeze({
    bootId,
    whenReady() {

      return initialization;

    },
  });

})(typeof globalThis === 'object' ? globalThis : this);
