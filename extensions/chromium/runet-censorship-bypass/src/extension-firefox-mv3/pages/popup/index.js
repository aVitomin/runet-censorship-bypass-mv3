'use strict';
/* global globalThis, module, require */

(function publishFirefoxPopup(root, factory) {

  const runtime = typeof module === 'object' && module.exports ?
    require('../shared/ui-runtime') : root.rucbFirefoxUi;
  const api = factory(runtime);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxPopup = api;
  root.document.addEventListener('DOMContentLoaded', () => {
    api.mount(root.document, root.browser);
  });

})(typeof globalThis === 'object' ? globalThis : this, function(Ui) {

  function presentation(capabilities) {

    const value = Ui.validateCapabilities(capabilities);
    const privateDenied = value.privateWindowAccess !== 'GRANTED';
    const ownsProtectedIntent = value.durableIntent === 'ON' ||
      value.runtimeState === 'READY';
    if (privateDenied && ownsProtectedIntent) {
      return Object.freeze({
        kind: 'BLOCKED', tone: 'error', action: 'DISABLE',
        titleKey: 'popupStateBlocked', helpKey: 'popupHelpPrivateBlocked',
      });
    }
    if (value.runtimeState === 'READY') {
      const recovered = value.recoveryStatus === 'RECOVERED';
      return Object.freeze({
        kind: recovered ? 'RECOVERED' : 'ACTIVE',
        tone: 'success',
        action: 'DISABLE',
        titleKey: recovered ? 'popupStateRecovered' : 'popupStateActive',
        helpKey: recovered ? 'popupHelpRecovered' : 'popupHelpActive',
      });
    }
    if (value.runtimeState === 'INITIALIZING' ||
        value.recoveryStatus === 'INITIALIZING') {
      return Object.freeze({
        kind: 'INITIALIZING', tone: 'warning', action: 'NONE',
        titleKey: 'popupStateInitializing', helpKey: 'popupHelpInitializing',
      });
    }
    if (value.runtimeState === 'FAILED' ||
        value.recoveryStatus.startsWith('BLOCKED') ||
        value.recoveryStatus.includes('FAILED')) {
      return Object.freeze({
        kind: 'BLOCKED', tone: 'error',
        action: value.durableIntent === 'ON' ? 'DISABLE' : 'NONE',
        titleKey: 'popupStateBlocked', helpKey: 'popupHelpBlocked',
      });
    }
    return Object.freeze({
      kind: 'OFF', tone: '', action: 'ENABLE',
      titleKey: 'popupStateOff',
      helpKey: privateDenied ? 'popupHelpPrivateRequired' :
        !value.providerDatasetAvailable ? 'popupHelpDatasetMissing' :
          'popupHelpOff',
    });

  }

  function userErrorKey(code) {

    if (code === 'PRIVATE_ACCESS_REQUIRED') {
      return 'popupErrorPrivateAccess';
    }
    if (String(code).includes('DATASET')) {
      return 'popupErrorDataset';
    }
    if (String(code).includes('PRODUCT_CONFIG') ||
        code === 'REQUIRED_CREDENTIAL_MISSING') {
      return 'popupErrorSettings';
    }
    return 'popupErrorGeneric';

  }

  function createController(options = {}) {

    const rpc = options.rpc;
    const changed = typeof options.changed === 'function' ?
      options.changed : () => {};
    if (!rpc || typeof rpc.call !== 'function') {
      throw Ui.rpcError('UI_RPC_FAILED');
    }
    let state = {
      capabilities: null,
      errorCode: null,
      operation: null,
      pending: false,
    };

    function emit() {

      changed(snapshot());

    }

    function snapshot() {

      return Object.freeze({
        capabilities: state.capabilities,
        errorCode: state.errorCode,
        operation: state.operation,
        pending: state.pending,
      });

    }

    async function readCapabilities() {

      const result = await rpc.call({type: 'firefox.capabilities.get'});
      return Ui.validateCapabilities(result);

    }

    async function refresh() {

      if (state.pending) {
        return false;
      }
      state = Object.assign({}, state, {
        errorCode: null, operation: 'REFRESH', pending: true,
      });
      emit();
      try {
        state.capabilities = await readCapabilities();
        state.errorCode = null;
        return true;
      } catch (error) {
        state.errorCode = Ui.safeErrorCode(error);
        return false;
      } finally {
        state.operation = null;
        state.pending = false;
        emit();
      }

    }

    async function operate(kind) {

      if (state.pending) {
        return false;
      }
      state = Object.assign({}, state, {
        errorCode: null, operation: kind, pending: true,
      });
      emit();
      try {
        const type = kind === 'ENABLE' ?
          'firefox.activation.apply' : 'firefox.activation.clear';
        await rpc.call({type});
        state.capabilities = await readCapabilities();
        return true;
      } catch (error) {
        state.errorCode = Ui.safeErrorCode(error);
        try {
          state.capabilities = await readCapabilities();
        } catch (_refreshError) {
          // Keep the original sanitized operation error.
        }
        return false;
      } finally {
        state.operation = null;
        state.pending = false;
        emit();
      }

    }

    return Object.freeze({
      apply: () => operate('ENABLE'),
      clear: () => operate('DISABLE'),
      refresh,
      snapshot,
    });

  }

  function mount(document, browserApi) {

    const root = document.getElementById('popup-root');
    if (!root) {
      return null;
    }
    const t = (key, substitutions) =>
      Ui.translate(browserApi, key, substitutions);
    const controller = createController({
      rpc: Ui.createRpc(browserApi),
      changed: render,
    });

    function render(state) {

      Ui.clear(root);
      root.setAttribute('aria-busy', state.pending ? 'true' : 'false');
      document.title = t('popupTitle');
      const header = Ui.append(root, 'header', 'popup-header');
      Ui.appendText(header, 'h1', t('extensionName'));
      Ui.appendText(header, 'p', t('popupSubtitle'), 'muted');
      if (!state.capabilities) {
        const loading = Ui.append(root, 'section', 'card control-card');
        Ui.appendText(
            loading,
            'p',
            state.errorCode ? t('popupLoadFailed') : t('popupLoading'),
            `status ${state.errorCode ? 'error' : ''}`,
        );
        if (state.errorCode && !state.pending) {
          const retry = Ui.append(loading, 'button', 'primary');
          retry.type = 'button';
          retry.textContent = t('actionRetry');
          retry.addEventListener('click', () => controller.refresh());
        }
        return;
      }
      const view = presentation(state.capabilities);
      const card = Ui.append(root, 'section', 'card control-card');
      Ui.appendText(card, 'h2', t(view.titleKey));
      Ui.appendText(card, 'p', t(view.helpKey), `status ${view.tone}`);
      if (state.errorCode) {
        const error = Ui.appendText(
            card, 'p', t(userErrorKey(state.errorCode)), 'status error message',
        );
        error.setAttribute('role', 'alert');
      }
      const actions = Ui.append(card, 'div', 'actions');
      if (view.action !== 'NONE') {
        const primary = Ui.append(actions, 'button', 'primary');
        primary.type = 'button';
        primary.textContent = t(view.action === 'ENABLE' ?
          'actionEnable' : 'actionDisable');
        primary.disabled = state.pending ||
          (view.action === 'ENABLE' && (
            !state.capabilities.activationSupported ||
            !state.capabilities.providerDatasetAvailable ||
            state.capabilities.privateWindowAccess !== 'GRANTED'));
        primary.addEventListener('click', () => view.action === 'ENABLE' ?
          controller.apply() : controller.clear());
      }
      const settings = Ui.append(actions, 'button');
      settings.type = 'button';
      settings.textContent = t('actionSettings');
      settings.disabled = state.pending;
      settings.addEventListener('click', () => {
        if (browserApi.runtime &&
            typeof browserApi.runtime.openOptionsPage === 'function') {
          browserApi.runtime.openOptionsPage();
        }
      });

      const facts = Ui.append(root, 'section', 'card facts-card');
      Ui.appendText(facts, 'h2', t('popupDetails'));
      const list = Ui.append(facts, 'dl', 'facts');
      const rows = [
        ['popupDataset', state.capabilities.providerDatasetAvailable ?
          'valueAvailable' : 'valueUnavailable'],
        ['popupPrivateAccess', state.capabilities.privateWindowAccess ===
          'GRANTED' ? 'valueGranted' : state.capabilities.privateWindowAccess ===
            'DENIED' ? 'valueDenied' : 'valueUnknown'],
      ];
      for (const [labelKey, valueKey] of rows) {
        const row = Ui.append(list, 'div', 'fact');
        Ui.appendText(row, 'dt', t(labelKey), 'muted');
        Ui.appendText(row, 'dd', t(valueKey));
      }
      const live = Ui.appendText(
          root,
          'p',
          state.pending ? t('popupOperationPending') : t(view.titleKey),
          'sr-only',
      );
      live.setAttribute('aria-live', 'polite');

    }

    controller.refresh();
    return controller;

  }

  return Object.freeze({
    createController,
    mount,
    presentation,
    userErrorKey,
  });

});
