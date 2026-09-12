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

  const SITE_KEYS = Object.freeze([
    'patterns', 'proxyCandidateAvailable', 'revision', 'route',
    'schemaVersion', 'target',
  ]);
  const TARGET_KEYS = Object.freeze(['controllable', 'host', 'reasonCode']);
  const ROUTE_KEYS = Object.freeze(['mode', 'pattern', 'scope']);
  const PATTERN_KEYS = Object.freeze([
    'exact', 'wildcard', 'wildcardAvailable',
  ]);
  const MODES = Object.freeze(['AUTO', 'PROXY', 'DIRECT']);
  const SCOPES = Object.freeze(['HOST', 'DOMAIN']);

  function presentation(capabilities) {

    const value = Ui.validateCapabilities(capabilities);
    const privateDenied = value.privateWindowAccess !== 'GRANTED';
    const ownsProtectedIntent = value.durableIntent === 'ON' ||
      value.runtimeState === 'READY';
    if (value.recoveryStatus === 'BLOCKED_CONTROL_LOSS' ||
        value.recoveryFailureCode === 'CONTROL_LOSS') {
      return Object.freeze({
        kind: 'EXTERNAL', tone: 'error',
        action: value.durableIntent === 'ON' ? 'DISABLE' : 'NONE',
        titleKey: 'popupStateExternal', helpKey: 'popupHelpExternal',
      });
    }
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
    if (code === 'SITE_PROXY_CANDIDATE_UNAVAILABLE') {
      return 'popupErrorProxyCandidate';
    }
    if (code === 'SETTINGS_REVISION_CONFLICT' ||
        code === 'STALE_REVISION') {
      return 'popupErrorRevision';
    }
    if (String(code).includes('PRODUCT_CONFIG') ||
        String(code).includes('SETTINGS') ||
        code === 'REQUIRED_CREDENTIAL_MISSING') {
      return 'popupErrorSettings';
    }
    return 'popupErrorGeneric';

  }

  function validateSiteState(value) {

    if (!Ui.hasExactKeys(value, SITE_KEYS) || value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !Ui.hasExactKeys(value.target, TARGET_KEYS) ||
        typeof value.target.controllable !== 'boolean' ||
        typeof value.target.host !== 'string' ||
        (value.target.reasonCode !== null &&
          typeof value.target.reasonCode !== 'string') ||
        typeof value.proxyCandidateAvailable !== 'boolean') {
      throw Ui.rpcError('UI_RPC_FAILED');
    }
    if (!value.target.controllable) {
      if (value.route !== null || value.patterns !== null ||
          value.target.host !== '') {
        throw Ui.rpcError('UI_RPC_FAILED');
      }
    } else if (!Ui.hasExactKeys(value.route, ROUTE_KEYS) ||
        !MODES.includes(value.route.mode) ||
        !SCOPES.includes(value.route.scope) ||
        typeof value.route.pattern !== 'string' ||
        !Ui.hasExactKeys(value.patterns, PATTERN_KEYS) ||
        typeof value.patterns.exact !== 'string' ||
        typeof value.patterns.wildcard !== 'string' ||
        typeof value.patterns.wildcardAvailable !== 'boolean') {
      throw Ui.rpcError('UI_RPC_FAILED');
    }
    return Object.freeze(Ui.clone(value));

  }

  function isDraftDirty(site, draft) {

    return Boolean(site && site.target.controllable && draft &&
      (site.route.mode !== draft.mode || site.route.scope !== draft.scope));

  }

  function createController(options = {}) {

    const rpc = options.rpc;
    const getActiveTabUrl = options.getActiveTabUrl;
    const changed = typeof options.changed === 'function' ?
      options.changed : () => {};
    if (!rpc || typeof rpc.call !== 'function' ||
        typeof getActiveTabUrl !== 'function') {
      throw Ui.rpcError('UI_RPC_FAILED');
    }
    let state = {
      capabilities: null,
      errorCode: null,
      operation: null,
      pending: false,
      site: null,
      tabUrl: '',
    };

    function snapshot() {

      return Object.freeze(Object.assign({}, state));

    }

    function emit() {

      changed(snapshot());

    }

    async function readAll() {

      let tabUrl = '';
      try {
        const candidate = await getActiveTabUrl();
        tabUrl = typeof candidate === 'string' ? candidate : '';
      } catch (_error) {
        // An unreadable privileged tab is represented as uncontrollable.
      }
      const results = await Promise.all([
        rpc.call({type: 'firefox.capabilities.get'}),
        rpc.call({type: 'firefox.site.get', tabUrl}),
      ]);
      state.capabilities = Ui.validateCapabilities(results[0]);
      state.site = validateSiteState(results[1]);
      state.tabUrl = tabUrl;

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
        await readAll();
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

    async function operate(kind, draft = null) {

      if (state.pending) {
        return false;
      }
      state = Object.assign({}, state, {
        errorCode: null, operation: kind, pending: true,
      });
      emit();
      try {
        if (kind === 'ENABLE' && isDraftDirty(state.site, draft)) {
          state.site = validateSiteState(await rpc.call({
            type: 'firefox.site.replace',
            tabUrl: state.tabUrl,
            expectedRevision: state.site.revision,
            mode: draft.mode,
            scope: draft.scope,
          }));
        }
        const type = kind === 'ENABLE' ?
          'firefox.activation.apply' : 'firefox.activation.clear';
        await rpc.call({type});
        await readAll();
        return true;
      } catch (error) {
        state.errorCode = Ui.safeErrorCode(error);
        try {
          await readAll();
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
      apply: (draft) => operate('ENABLE', draft),
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
    let draft = null;
    let renderedRevision = null;
    const controller = createController({
      rpc: Ui.createRpc(browserApi),
      async getActiveTabUrl() {

        if (!browserApi.tabs || typeof browserApi.tabs.query !== 'function') {
          return '';
        }
        const tabs = await browserApi.tabs.query({
          active: true,
          currentWindow: true,
        });
        return tabs && tabs[0] && typeof tabs[0].url === 'string' ?
          tabs[0].url : '';

      },
      changed: render,
    });

    function openSettings(section = '') {

      if (section) {
        const url = browserApi.runtime.getURL(
            `pages/options/index.html#${section}`,
        );
        browserApi.tabs.create({url});
        return;
      }
      browserApi.runtime.openOptionsPage();

    }

    function modeDescription(mode) {

      return t(mode === 'PROXY' ? 'popupProxyModeDescription' :
        mode === 'DIRECT' ? 'popupDirectModeDescription' :
          'popupAutoModeDescription');

    }

    function renderRoute(parent, state, view) {

      const site = state.site;
      const card = Ui.append(parent, 'section', 'card site-card');
      Ui.appendText(card, 'p', t('popupCurrentSiteRouting'), 'eyebrow');
      Ui.appendText(
          card,
          'h2',
          site.target.controllable ? site.target.host :
            t('popupCurrentTabUnavailable'),
          'site-host',
      );
      if (!site.target.controllable) {
        Ui.appendText(
            card, 'p', t('popupPageCannotBeControlledHelp'), 'muted',
        );
        return;
      }
      const editable = view.kind === 'OFF' && !state.pending;
      const fieldset = Ui.append(card, 'fieldset', 'route-fieldset');
      const legend = Ui.appendText(
          fieldset, 'legend', t('popupSiteModeGroup', [site.target.host]),
          'sr-only',
      );
      legend.id = 'site-mode-legend';
      const choices = Ui.append(fieldset, 'div', 'route-segments');
      for (const mode of MODES) {
        const label = Ui.append(choices, 'label', 'route-option');
        const input = Ui.append(label, 'input');
        input.type = 'radio';
        input.name = 'site-mode';
        input.value = mode;
        input.checked = draft.mode === mode;
        input.disabled = !editable;
        input.addEventListener('change', () => {
          if (input.checked) {
            draft.mode = mode;
            render(state);
          }
        });
        Ui.appendText(label, 'span', t(`popupMode${mode}`));
      }
      Ui.appendText(card, 'p', modeDescription(draft.mode), 'muted route-help');
      if (draft.mode === 'PROXY' && !site.proxyCandidateAvailable) {
        Ui.appendText(
            card, 'p', t('popupProxyRouteNeedsMethod'),
            'status warning proxy-warning',
        );
        const configure = Ui.append(card, 'button', 'link-button');
        configure.type = 'button';
        configure.textContent = t('popupConfigureProxyMethods');
        configure.addEventListener('click', () =>
          openSettings('proxy-connections'));
      }
      if (draft.mode !== 'AUTO') {
        const scope = Ui.append(card, 'fieldset', 'scope-fieldset');
        Ui.appendText(scope, 'legend', t('popupScope'));
        for (const value of SCOPES) {
          const label = Ui.append(scope, 'label', 'scope-option');
          const input = Ui.append(label, 'input');
          input.type = 'radio';
          input.name = 'site-scope';
          input.value = value;
          input.checked = draft.scope === value;
          input.disabled = !editable ||
            value === 'DOMAIN' && !site.patterns.wildcardAvailable;
          input.addEventListener('change', () => {
            if (input.checked) {
              draft.scope = value;
              render(state);
            }
          });
          Ui.appendText(label, 'span', t(value === 'HOST' ?
            'popupHostOnly' : 'popupDomainAndSubdomains'));
        }
        const pattern = draft.scope === 'DOMAIN' &&
          site.patterns.wildcardAvailable ?
          site.patterns.wildcard : site.patterns.exact;
        Ui.appendText(
            card, 'p', t('popupRulePreview', [pattern]), 'pattern-preview',
        );
      }
      if (view.kind !== 'OFF') {
        Ui.appendText(
            card, 'p', t('popupSiteEditingRequiresOff'), 'muted',
        );
      } else if (isDraftDirty(site, draft)) {
        Ui.appendText(
            card, 'span', t('popupNotApplied'), 'pill warning',
        );
      }

    }

    function render(state) {

      if (state.site && state.site.target.controllable &&
          renderedRevision !== state.site.revision) {
        draft = {
          mode: state.site.route.mode,
          scope: state.site.route.scope,
        };
        renderedRevision = state.site.revision;
      }
      Ui.clear(root);
      root.setAttribute('aria-busy', state.pending ? 'true' : 'false');
      document.title = t('popupTitle');
      const header = Ui.append(root, 'header', 'popup-header');
      const heading = Ui.append(header, 'div');
      Ui.appendText(heading, 'h1', t('extensionName'));
      Ui.appendText(heading, 'p', t('popupSubtitle'), 'muted');
      const settings = Ui.append(header, 'button', 'settings-button');
      settings.type = 'button';
      settings.textContent = t('actionSettings');
      settings.disabled = state.pending;
      settings.addEventListener('click', () => openSettings());
      if (!state.capabilities || !state.site) {
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
      const statusRow = Ui.append(card, 'div', 'status-row');
      Ui.appendText(statusRow, 'h2', t(view.titleKey));
      Ui.appendText(
          statusRow, 'span', t(`popupPill${view.kind}`),
          `pill ${view.tone}`,
      );
      Ui.appendText(card, 'p', t(view.helpKey), 'muted');
      if (state.errorCode) {
        const error = Ui.appendText(
            card, 'p', t(userErrorKey(state.errorCode)),
            'status error message',
        );
        error.setAttribute('role', 'alert');
      }
      const actions = Ui.append(card, 'div', 'actions');
      if (view.action !== 'NONE') {
        const primary = Ui.append(actions, 'button', 'primary');
        primary.type = 'button';
        primary.textContent = t(view.action === 'ENABLE' ?
          'popupApplyChanges' : 'popupTurnOff');
        const proxyUnavailable = draft && draft.mode === 'PROXY' &&
          !state.site.proxyCandidateAvailable;
        primary.disabled = state.pending ||
          (view.action === 'ENABLE' && (
            !state.capabilities.activationSupported ||
            !state.capabilities.providerDatasetAvailable ||
            state.capabilities.privateWindowAccess !== 'GRANTED' ||
            proxyUnavailable));
        primary.addEventListener('click', () => view.action === 'ENABLE' ?
          controller.apply(draft) : controller.clear());
      }
      renderRoute(root, state, view);
      const facts = Ui.append(root, 'section', 'card facts-card');
      Ui.appendText(facts, 'h2', t('popupAutomaticRouting'));
      Ui.appendText(facts, 'p', t('popupAutomaticSource'), 'muted');
      const list = Ui.append(facts, 'dl', 'facts');
      const rows = [
        ['popupDataset', state.capabilities.providerDatasetAvailable ?
          'valueAvailable' : 'valueUnavailable'],
        ['popupPrivateAccess', state.capabilities.privateWindowAccess ===
          'GRANTED' ? 'valueGranted' :
            state.capabilities.privateWindowAccess === 'DENIED' ?
              'valueDenied' : 'valueUnknown'],
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
    isDraftDirty,
    mount,
    presentation,
    userErrorKey,
    validateSiteState,
  });

});
