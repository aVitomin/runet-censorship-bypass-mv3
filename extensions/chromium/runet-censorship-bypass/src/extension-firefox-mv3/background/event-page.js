'use strict';

(function startFirefoxEventPage(root) {

  const offState = root.rucbFirefoxOffState;
  const runtimeState = offState.OFF;
  const durableIntent = offState.OFF;
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
      return {
        ok: true,
        result: {
          apiVersion: 1,
          browser: 'FIREFOX',
          manifestVersion: manifest.manifest_version,
          runtimeModel: 'BACKGROUND_EVENT_PAGE',
          runtimeState,
          durableIntent,
          privateWindowAccess: await readPrivateWindowAccess(),
          routingImplemented: false,
          activationSupported: false,
          providerDatasetAvailable: false,
        },
      };
    }
    if (type === 'firefox.activation.apply') {
      return errorResponse('ACTIVATION_NOT_IMPLEMENTED');
    }
    return errorResponse('UNKNOWN_RPC');

  }

  browser.runtime.onMessage.addListener(handleMessage);

  const initialization = offState.initialize(browser.storage.local).catch(() =>
    offState.normalizeDurableState(null));

  root.rucbFirefoxSkeletonRuntime = Object.freeze({
    bootId,
    whenReady() {

      return initialization;

    },
  });

})(typeof globalThis === 'object' ? globalThis : this);
