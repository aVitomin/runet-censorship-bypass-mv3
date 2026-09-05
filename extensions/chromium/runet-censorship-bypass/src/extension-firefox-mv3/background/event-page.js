'use strict';

(function startFirefoxEventPage(root) {

  const offState = root.rucbFirefoxOffState;
  const proxyControlApi = root.rucbFirefoxProxyControl;
  const proxyAuthApi = root.rucbFirefoxProxyAuth;
  const routing = root.rucbFirefoxRoutingAdapter;
  const activationApi = root.rucbFirefoxActivationController;
  let activationController = null;
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
    routingAdapter,
    proxyAuth,
    storageArea: browser.storage.local,
  });
  const bootId = root.crypto && typeof root.crypto.randomUUID === 'function' ?
    root.crypto.randomUUID() :
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  function errorResponse(code) {

    return {ok: false, error: {code}};

  }

  async function readPrivateWindowAccess() {

    try {
      const allowed = await browser.extension.isAllowedIncognitoAccess();
      return allowed ? 'GRANTED' : 'DENIED';
    } catch (_error) {
      return 'UNKNOWN';
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
          activationSupported: false,
          providerDatasetImplemented: true,
          providerDatasetAvailable: false,
        },
      };
    }
    if (type === 'firefox.activation.apply') {
      return errorResponse('ACTIVATION_NOT_IMPLEMENTED');
    }
    if (type === 'firefox.activation.clear') {
      const cleared = await activationController.clear();
      if (!cleared.ok) {
        return errorResponse(cleared.error.code);
      }
      return {
        ok: true,
        result: {intent: offState.OFF, status: cleared.status},
      };
    }
    return errorResponse('UNKNOWN_RPC');

  }

  browser.proxy.onRequest.addListener(
      routingAdapter.onProxyRequest,
      {urls: ['<all_urls>']},
  );
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

  const initialization = activationController.initializeFromDurable();

  root.rucbFirefoxSkeletonRuntime = Object.freeze({
    bootId,
    whenReady() {

      return initialization;

    },
  });

})(typeof globalThis === 'object' ? globalThis : this);
