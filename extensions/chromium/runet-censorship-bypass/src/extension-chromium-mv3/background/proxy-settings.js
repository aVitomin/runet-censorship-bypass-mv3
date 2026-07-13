'use strict';

(function(exports) {

  const REGULAR_SCOPE = 'regular';
  const CONTROLLABLE_LEVELS = Object.freeze([
    'controllable_by_this_extension',
    'controlled_by_this_extension',
  ]);

  function createError(code, message, details) {

    return {
      code,
      message,
      details: details === undefined ? null : details,
    };

  }

  function getLastError(code, fallbackMessage) {

    const lastError = chrome.runtime.lastError;
    if (!lastError) {
      return null;
    }
    return createError(code, lastError.message || fallbackMessage);

  }

  function summarizeProxyValue(value) {

    if (!value || typeof value !== 'object') {
      return null;
    }
    const pacScript = value.pacScript && typeof value.pacScript === 'object' ?
      value.pacScript :
      {};
    return {
      mode: typeof value.mode === 'string' ? value.mode : null,
      pacScript: value.pacScript ? {
        hasData: typeof pacScript.data === 'string' && pacScript.data.length > 0,
        hasUrl: typeof pacScript.url === 'string' && pacScript.url.length > 0,
        mandatory: pacScript.mandatory === true,
      } : null,
      hasRules: Boolean(value.rules),
      hasAutoConfigUrl: typeof value.autoConfigUrl === 'string' &&
        value.autoConfigUrl.length > 0,
    };

  }

  function normalizeControl(details, error = null) {

    const levelOfControl = details && typeof details.levelOfControl === 'string' ?
      details.levelOfControl :
      null;
    return {
      checkedAt: Date.now(),
      levelOfControl,
      controlledByThisExtension: levelOfControl === 'controlled_by_this_extension',
      canControl: CONTROLLABLE_LEVELS.includes(levelOfControl),
      rawValue: summarizeProxyValue(details && details.value),
      error,
    };

  }

  function ensureProxyApi() {

    if (!chrome.proxy || !chrome.proxy.settings) {
      throw createError(
          'PROXY_READ_FAILED',
          'chrome.proxy.settings is unavailable.',
      );
    }

  }

  function getProxySettings() {

    ensureProxyApi();
    return new Promise((resolve, reject) => {
      chrome.proxy.settings.get({}, (details) => {
        const error = getLastError(
            'PROXY_READ_FAILED',
            'Failed to read proxy settings.',
        );
        if (error) {
          reject(error);
          return;
        }
        resolve(details || {});
      });
    });

  }

  async function getProxyControlState() {

    try {
      return normalizeControl(await getProxySettings());
    } catch (error) {
      return normalizeControl(null, normalizeError(error, 'PROXY_READ_FAILED'));
    }

  }

  function normalizeError(error, fallbackCode) {

    if (error && typeof error === 'object' && error.code && error.message) {
      return {
        code: error.code,
        message: error.message,
        details: error.details === undefined ? null : error.details,
      };
    }
    return createError(
        fallbackCode,
        error && error.message ? error.message : 'Proxy settings operation failed.',
    );

  }

  async function assertCanControl() {

    const control = await getProxyControlState();
    if (control.error && !control.canControl) {
      throw control.error;
    }
    if (!control.canControl) {
      throw createError(
          'PROXY_NOT_CONTROLLABLE',
          'This extension cannot control Chromium proxy settings.',
          {levelOfControl: control.levelOfControl},
      );
    }
    return control;

  }

  async function applyPacScript({cookedPacData}) {

    if (typeof cookedPacData !== 'string' || !cookedPacData.trim()) {
      throw createError(
          'VALIDATION_ERROR',
          'Cooked PAC data is required before applying proxy settings.',
      );
    }
    await assertCanControl();
    ensureProxyApi();

    return new Promise((resolve, reject) => {
      chrome.proxy.settings.set({
        value: {
          mode: 'pac_script',
          pacScript: {
            mandatory: false,
            data: cookedPacData,
          },
        },
        scope: REGULAR_SCOPE,
      }, () => {
        const error = getLastError(
            'PROXY_SET_FAILED',
            'Failed to apply proxy settings.',
        );
        if (error) {
          reject(error);
          return;
        }
        resolve({ok: true});
      });
    });

  }

  async function clearProxySettings() {

    await assertCanControl();
    ensureProxyApi();

    return new Promise((resolve, reject) => {
      chrome.proxy.settings.clear({scope: REGULAR_SCOPE}, () => {
        const error = getLastError(
            'PROXY_CLEAR_FAILED',
            'Failed to clear proxy settings.',
        );
        if (error) {
          reject(error);
          return;
        }
        resolve({ok: true});
      });
    });

  }

  function selfTest() {

    return {
      controllableByThisExtension: normalizeControl({
        levelOfControl: 'controllable_by_this_extension',
      }).canControl === true,
      controlledByOtherExtensionsBlocked: normalizeControl({
        levelOfControl: 'controlled_by_other_extensions',
      }).canControl === false,
      pacDataIsSummarized: summarizeProxyValue({
        mode: 'pac_script',
        pacScript: {data: 'function FindProxyForURL(){}'},
      }).pacScript.hasData === true,
      createStructuredError: normalizeError(
          createError('PROXY_SET_FAILED', 'failed'),
          'PROXY_SET_FAILED',
      ).code === 'PROXY_SET_FAILED',
    };

  }

  exports.mv3ProxySettings = Object.freeze({
    getProxySettings,
    getProxyControlState,
    applyPacScript,
    clearProxySettings,
    selfTest,
  });

})(self);
