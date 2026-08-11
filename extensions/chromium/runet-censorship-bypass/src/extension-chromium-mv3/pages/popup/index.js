'use strict';

(function() {

  const rpc = window.mv3Rpc;
  const root = document.getElementById('popup-root');
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const BUSY_PRESENTATION_KEYS = Object.freeze({
    apply: ['applying', 'popupControlApplying', 'popupControlApplyingHelp'],
    clear: ['clearing', 'popupControlClearing', 'popupControlClearingHelp'],
    check: ['checking', 'popupControlChecking', 'popupControlCheckingHelp'],
    updatePac: [
      'updating',
      'popupControlUpdating',
      'popupControlUpdatingHelp',
    ],
  });
  let activeTabUrl = '';
  let latestState = null;
  let draft = null;
  let busyOperation = '';
  let lastOperation = null;
  let advancedOpen = false;
  let requestedFocus = '';
  let initPromise = null;
  let refreshAfterInit = false;
  let openingSettings = false;
  let surfaceConfigured = false;

  document.addEventListener('DOMContentLoaded', init);

  function t(key, substitutions) {

    return window.mv3I18n ?
      window.mv3I18n.t(key, substitutions) :
      chrome.i18n.getMessage(key, substitutions) || key;

  }

  function init() {

    configureSurface();
    if (initPromise) {
      return initPromise;
    }
    initPromise = loadPopup().finally(() => {
      initPromise = null;
      if (refreshAfterInit) {
        refreshAfterInit = false;
        requestPopupRefresh();
      }
    });
    return initPromise;

  }

  function requestPopupRefresh() {

    if (busyOperation) {
      return;
    }
    if (initPromise) {
      refreshAfterInit = true;
      return initPromise;
    }
    initPromise = loadPopup(true).finally(() => {
      initPromise = null;
      if (refreshAfterInit) {
        refreshAfterInit = false;
        requestPopupRefresh();
      }
    });
    return initPromise;

  }

  function configureSurface() {

    if (surfaceConfigured) {
      return;
    }
    surfaceConfigured = true;
    if (
      chrome.storage && chrome.storage.onChanged &&
      typeof chrome.storage.onChanged.addListener === 'function'
    ) {
      chrome.storage.onChanged.addListener(handleStoredStateChange);
    }
    if (
      chrome.proxy && chrome.proxy.settings &&
      chrome.proxy.settings.onChange &&
      typeof chrome.proxy.settings.onChange.addListener === 'function'
    ) {
      chrome.proxy.settings.onChange.addListener(requestPopupRefresh);
    }
    if (!chrome.tabs || typeof chrome.tabs.getCurrent !== 'function') {
      return;
    }
    chrome.tabs.getCurrent((tab) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (tab) {
        document.documentElement.classList.add('standalone-popup-page');
        return;
      }
      updatePopupZoomLayout();
      window.addEventListener('resize', updatePopupZoomLayout);
    });

  }

  function handleStoredStateChange(changes, areaName) {

    const stateChange = changes && changes.mv3State;
    const previousHealth = stateChange && stateChange.oldValue &&
      stateChange.oldValue.proxyHealth;
    const nextHealth = stateChange && stateChange.newValue &&
      stateChange.newValue.proxyHealth;
    const ifHealthChanged = JSON.stringify(previousHealth || null) !==
      JSON.stringify(nextHealth || null);
    if (
      areaName === 'local' &&
      stateChange &&
      (!latestState || isOperationBusy(latestState) || ifHealthChanged)
    ) {
      requestPopupRefresh();
    }

  }

  function updatePopupZoomLayout() {

    const html = document.documentElement;
    const ifZoomed = window.devicePixelRatio > 1 && window.innerWidth < 392;
    if (ifZoomed && !html.classList.contains('zoomed-popup-surface')) {
      const availableWidth = Math.max(
          200,
          Math.min(window.innerWidth, html.clientWidth),
      );
      html.style.setProperty(
          '--popup-zoomed-min-width',
          `${availableWidth}px`,
      );
      html.classList.add('zoomed-popup-surface');
      return;
    }
    if (!ifZoomed) {
      html.classList.remove('zoomed-popup-surface');
      html.style.removeProperty('--popup-zoomed-min-width');
    }

  }

  async function loadPopup(ifPreserveUi = false) {

    if (!ifPreserveUi) {
      renderLoading();
    }
    try {
      const tab = await getActiveTab();
      activeTabUrl = tab && tab.url || '';
      latestState = await rpc.callBackground('getPopupState', {
        tabUrl: activeTabUrl,
      });
      await window.mv3I18n.init(latestState.uiLanguage);
      draft = createDraft(latestState);
      lastOperation = null;
      renderPopup(latestState);
    } catch (err) {
      renderLoadError();
    }

  }

  async function getActiveTab() {

    return new Promise((resolve, reject) => {
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(tabs && tabs[0] || null);
      });
    });

  }

  function createDraft(state) {

    const quick = state.quickProxies || {};
    return {
      providerKey: state.selectedProvider || '',
      siteMode: state.mode || 'auto',
      siteScope: state.siteRule && state.siteRule.scope || 'domain',
      quickProxies: {
        usePacScriptProxies: quick.usePacScriptProxies !== false,
        ownProxiesOnlyForOwnSites: quick.ownProxiesOnlyForOwnSites === true,
        localTorEnabled: quick.localTorEnabled === true,
        torBrowserEnabled: quick.torBrowserEnabled === true,
        warpEnabled: quick.warpEnabled === true,
        ownProxiesEnabled: quick.ownProxiesEnabled === true,
      },
    };

  }

  function renderLoading() {

    clear(root);
    root.setAttribute('aria-busy', 'true');
    document.title = t('popupTitle');
    renderHeader(root, {
      kind: 'loading',
      title: t('popupControlLoading'),
      pillText: t('popupStatusWorkingPill'),
      pillClass: '',
    });
    const card = append(root, 'section', 'ui-card card loading-card');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    appendText(card, 'p', t('popupLoadingState'), 'card-copy');
    const lines = append(card, 'div', 'loading-lines');
    append(lines, 'span', 'loading-line');
    append(lines, 'span', 'loading-line short');

  }

  function renderLoadError() {

    clear(root);
    root.setAttribute('aria-busy', 'false');
    document.title = t('popupTitle');
    const presentation = {
      kind: 'error',
      tone: 'error',
      title: t('popupLoadErrorTitle'),
      description: t('popupLoadErrorHelp'),
      pillText: t('popupStatusErrorPill'),
      pillClass: 'error',
    };
    renderHeader(root, presentation);
    const card = append(root, 'section', 'ui-card card global-card error');
    card.setAttribute('role', 'alert');
    appendText(card, 'h2', presentation.title, 'card-title');
    appendText(card, 'p', presentation.description, 'card-copy');
    const actions = append(card, 'div', 'global-actions');
    const retry = appendButton(
        actions,
        t('popupRetry'),
        'ui-button primary',
    );
    retry.onclick = init;
    appendSettingsButton(actions, false);

  }

  function renderPopup(state) {

    clear(root);
    root.setAttribute('aria-busy', isOperationBusy(state) ? 'true' : 'false');
    document.title = t('popupTitle');
    const presentation = getGlobalPresentation(state, lastOperation);
    renderHeader(root, presentation);
    renderGlobalCard(root, state, presentation, lastOperation);
    renderSiteCard(root, state);
    renderConnectionCard(root, state);
    renderAdvancedDisclosure(root, state);
    renderFooter(root);
    renderLiveAnnouncement(root, state, presentation, lastOperation);
    focusRequestedControl();

  }

  function renderHeader(parent, presentation) {

    const header = append(parent, 'header', 'popup-header');
    const titleGroup = append(header, 'div');
    appendText(titleGroup, 'h1', t('popupTitle'), 'popup-title');
    const statusRow = append(titleGroup, 'div', 'header-status-row');
    if (presentation.pillText) {
      appendText(
          statusRow,
          'span',
          presentation.pillText,
          `ui-pill ${presentation.pillClass || ''}`.trim(),
      );
    }
    if (draft && latestState && isDraftDirty(latestState)) {
      appendText(
          statusRow,
          'span',
          t('popupStatusPendingPill'),
          'ui-pill warning',
      );
    }
    appendSettingsButton(header, true);

  }

  function renderGlobalCard(parent, state, presentation, operation) {

    const tone = presentation.tone ? ` ${presentation.tone}` : '';
    const card = append(
        parent,
        'section',
        `ui-card card global-card${tone}`,
    );
    card.dataset.area = 'global-status';
    const headingId = 'popup-global-heading';
    card.setAttribute('aria-labelledby', headingId);
    appendText(card, 'p', t('popupExtensionControl'), 'eyebrow');
    const heading = appendText(
        card,
        'h2',
        presentation.title,
        'card-title',
    );
    heading.id = headingId;
    appendText(card, 'p', presentation.description, 'card-copy');

    renderOperationMessage(card, operation);
    renderGlobalActions(card, state, presentation, operation);

  }

  function renderOperationMessage(parent, operation) {

    if (!operation || operation.status === 'pending') {
      return;
    }
    if (operation.ok === false) {
      const message = appendText(
          parent,
          'p',
          getSafeOperationMessage(operation),
          operation.status === 'stale' ?
            'status-message warning' :
            'status-message error',
      );
      message.setAttribute('role', 'alert');
      return;
    }
    if (operation.message) {
      const message = appendText(
          parent,
          'p',
          localizeOperationMessage(operation.message),
          'status-message success',
      );
      message.setAttribute('role', 'status');
    }

  }

  function renderGlobalActions(parent, state, presentation, operation) {

    if (areGlobalActionsBlocked(presentation)) {
      return;
    }
    const actions = append(parent, 'div', 'global-actions');
    let ifActionAdded = false;
    const primaryAction = getPrimaryAction(state, operation);

    if (primaryAction === 'retry') {
      const retry = appendButton(
          actions,
          t('popupRetry'),
          'ui-button primary',
      );
      retry.onclick = () => retryLastOperation();
      ifActionAdded = true;
    } else if (primaryAction === 'retry-apply') {
      const retry = appendButton(
          actions,
          t('popupRetry'),
          'ui-button primary',
      );
      retry.onclick = () => runPopupOperation('apply');
      ifActionAdded = true;
    } else if (primaryAction === 'choose-provider') {
      const choose = appendButton(
          actions,
          t('popupChooseRoutingSource'),
          'ui-button primary',
      );
      choose.onclick = () => openAdvanced('provider');
      ifActionAdded = true;
    } else if (primaryAction === 'apply') {
      const applyButton = appendButton(
          actions,
          t('popupApplyChanges'),
          'ui-button primary',
      );
      const candidateMissing = draft.siteMode === 'proxy' &&
        getDraftProxyMethodCount(state) === 0;
      applyButton.disabled = candidateMissing;
      if (candidateMissing) {
        applyButton.title = t('popupNoProxyCandidate');
        applyButton.setAttribute('aria-describedby', 'popup-site-warning');
      }
      applyButton.onclick = () => runPopupOperation('apply');
      ifActionAdded = true;
    }

    if (controlsPac(state)) {
      const clearButton = appendButton(
          actions,
          t('popupTurnOffProxy'),
          'ui-button',
      );
      clearButton.title = t('popupTurnOffProxyHelp');
      clearButton.onclick = clearProxy;
      ifActionAdded = true;
    }

    if (!ifActionAdded) {
      actions.remove();
    }

  }

  function areGlobalActionsBlocked(presentation) {

    return Boolean(
        busyOperation ||
        presentation.kind === 'external' ||
        ['applying', 'clearing', 'updating', 'checking']
            .includes(presentation.kind),
    );

  }

  function getPrimaryAction(state, operation) {

    if (canRetryOperation(operation)) {
      return 'retry';
    }
    if (state.proxyApplyStatus === 'error' && draft.providerKey) {
      return 'retry-apply';
    }
    if (!draft.providerKey) {
      return 'choose-provider';
    }
    return shouldOfferApply(state, operation) ? 'apply' : '';

  }

  function renderSiteCard(parent, state) {

    const card = append(parent, 'section', 'ui-card card');
    card.dataset.area = 'site-routing';
    const headingId = 'popup-site-heading';
    card.setAttribute('aria-labelledby', headingId);
    appendText(card, 'p', t('popupCurrentSiteRouting'), 'eyebrow');
    const headingText = state.controllable ?
      state.host :
      t('popupCurrentTabUnavailable');
    const heading = appendText(card, 'h2', headingText, 'site-host');
    heading.id = headingId;

    if (!state.controllable) {
      appendText(
          card,
          'p',
          t('popupPageCannotBeControlledHelp'),
          'card-copy',
      );
      return;
    }

    const fieldset = append(card, 'fieldset', 'route-fieldset');
    const legend = appendText(
        fieldset,
        'legend',
        t('popupSiteModeGroup', [state.host]),
        'ui-sr-only',
    );
    legend.id = 'popup-site-mode-legend';
    const modes = append(fieldset, 'div', 'route-segments');
    const ifDisabled = isOperationBusy(state) || isExternallyControlled(state);
    [
      ['auto', t('popupAutoMode')],
      ['proxy', t('popupProxyMode')],
      ['direct', t('popupDirectMode')],
    ].forEach(([mode, labelText]) => {
      const label = append(modes, 'label', 'route-option');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'site-mode';
      input.value = mode;
      input.checked = draft.siteMode === mode;
      input.disabled = ifDisabled;
      input.setAttribute('aria-describedby', 'popup-route-description');
      input.onchange = () => {
        if (input.disabled || !input.checked) {
          return;
        }
        draft.siteMode = mode;
        markDraftPending(`mode-${mode}`);
      };
      label.appendChild(input);
      appendText(label, 'span', labelText, 'route-label');
      input.dataset.focusKey = `mode-${mode}`;
    });

    const description = appendText(
        card,
        'p',
        getSiteModeDescription(draft.siteMode),
        'route-description',
    );
    description.id = 'popup-route-description';

    if (draft.siteMode === 'proxy' && getDraftProxyMethodCount(state) === 0) {
      const warning = appendText(
          card,
          'p',
          t('popupProxyRouteNeedsMethod'),
          'status-message warning',
      );
      warning.id = 'popup-site-warning';
      const configure = appendButton(
          card,
          t('popupConfigureProxyMethods'),
          'ui-button',
      );
      configure.onclick = () => openAdvanced('proxy-methods');
    }

    if (draft.siteMode !== 'auto') {
      renderScopeControl(card, state, ifDisabled);
    }

  }

  function renderScopeControl(parent, state, ifDisabled) {

    const patterns = state.sitePatterns || {};
    const fieldset = append(parent, 'fieldset', 'scope-fieldset');
    appendText(fieldset, 'legend', t('popupScope'), 'eyebrow');
    const options = append(fieldset, 'div', 'scope-options');
    [
      ['host', t('popupHostOnly')],
      ['domain', t('popupDomainAndSubdomains')],
    ].forEach(([value, labelText]) => {
      const label = append(options, 'label', 'scope-option');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'site-scope';
      input.value = value;
      input.checked = draft.siteScope === value;
      input.disabled = ifDisabled ||
        value === 'domain' && !patterns.wildcardAvailable;
      input.onchange = () => {
        if (input.disabled || !input.checked) {
          return;
        }
        draft.siteScope = value;
        markDraftPending(`scope-${value}`);
      };
      input.dataset.focusKey = `scope-${value}`;
      label.appendChild(input);
      label.appendChild(document.createTextNode(labelText));
    });
    appendText(
        fieldset,
        'p',
        t('popupRulePreview', [getDraftPattern(state)]),
        'pattern-detail',
    );
    if (!patterns.wildcardAvailable) {
      appendText(
          fieldset,
          'p',
          t('popupHostScopeOnly'),
          'helper-text',
      );
    } else {
      appendText(
          fieldset,
          'p',
          t('popupDomainScopeSafeHelp'),
          'helper-text',
      );
    }

  }

  function renderConnectionCard(parent, state) {

    const card = append(parent, 'section', 'ui-card card');
    card.dataset.area = 'connection-summary';
    const heading = appendText(
        card,
        'h2',
        t('popupConnectionSummary'),
        'card-title',
    );
    heading.id = 'popup-connection-heading';
    card.setAttribute('aria-labelledby', heading.id);
    const list = append(card, 'dl', 'summary-list');
    const providerIfPending = draft.providerKey !== state.selectedProvider;
    appendSummaryRow(
        list,
        t('popupRoutingSource'),
        getDraftProviderLabel(state),
        providerIfPending ? t('popupStatusPendingPill') : '',
        providerIfPending ? 'warning' : '',
    );
    appendSummaryRow(
        list,
        t('popupProxyMethods'),
        getProxyMethodSummary(state),
    );
    appendSummaryRow(
        list,
        t('popupLastHealthCheck'),
        getProxyHealthSummary(state),
    );
    appendSummaryRow(
        list,
        t('popupLastRoutingUpdate'),
        getRoutingUpdateSummary(state),
    );

    if (
      state.mode === 'proxy' &&
      controlsPac(state) &&
      !isOperationBusy(state) &&
      !isExternallyControlled(state) &&
      !(lastOperation && lastOperation.kind === 'check' &&
        canRetryOperation(lastOperation))
    ) {
      const checkButton = appendButton(
          card,
          state.proxyHealth && state.proxyHealth.status === 'error' ?
            t('popupCheckProxyAgain') :
            t('popupCheckProxy'),
          'ui-button health-action',
      );
      checkButton.onclick = checkProxy;
    }

  }

  function renderAdvancedDisclosure(parent, state) {

    const details = append(
        parent,
        'details',
        'ui-card advanced-disclosure',
    );
    details.dataset.area = 'advanced';
    details.open = advancedOpen;
    const summary = appendText(
        details,
        'summary',
        t('popupAdvancedSettings'),
    );
    summary.setAttribute('aria-controls', 'popup-advanced-content');
    summary.setAttribute('aria-expanded', details.open ? 'true' : 'false');
    details.ontoggle = () => {
      advancedOpen = details.open;
      summary.setAttribute('aria-expanded', details.open ? 'true' : 'false');
    };
    const content = append(details, 'div', 'advanced-content');
    content.id = 'popup-advanced-content';
    appendText(
        content,
        'p',
        t('popupAdvancedSettingsHelp'),
        'helper-text',
    );
    renderAdvancedProvider(content, state);
    renderAdvancedProxyMethods(content, state);
    renderAdvancedStatus(content, state);

  }

  function renderAdvancedProvider(parent, state) {

    const group = append(parent, 'section', 'advanced-group');
    appendText(group, 'h3', t('popupRoutingSource'), 'advanced-heading');
    const row = append(group, 'div', 'provider-row');
    const select = append(row, 'select', 'ui-input');
    select.setAttribute('aria-label', t('popupPacProvider'));
    appendOption(select, '', t('popupSelectProvider'));
    (state.providers || []).forEach((provider) => {
      appendOption(select, provider.key, getProviderLabel(provider));
    });
    select.value = draft.providerKey || '';
    select.disabled = isOperationBusy(state);
    select.dataset.focusKey = 'provider';
    select.onchange = () => {
      draft.providerKey = select.value;
      markDraftPending('provider');
    };
    const updateButton = appendButton(
        row,
        t('popupRefreshRoutingData'),
        'ui-button',
    );
    updateButton.title = t('popupRefreshRoutingDataHelp');
    updateButton.disabled = isOperationBusy(state) || !draft.providerKey;
    updateButton.onclick = () => runPopupOperation('updatePac');

  }

  function renderAdvancedProxyMethods(parent, state) {

    const quick = state.quickProxies || {};
    const group = append(parent, 'section', 'advanced-group');
    group.dataset.focusKey = 'proxy-methods';
    appendText(group, 'h3', t('popupProxyMethods'), 'advanced-heading');
    const list = append(group, 'div', 'toggle-list');
    renderToggle(
        list,
        t('popupUsePacScriptProxies'),
        'usePacScriptProxies',
        false,
        t('popupUsePacScriptProxiesHelp'),
    );
    renderToggle(
        list,
        t('popupOwnProxiesOnlyForOwnSites'),
        'ownProxiesOnlyForOwnSites',
        false,
        t('popupOwnProxiesOnlyForOwnSitesHelp'),
    );
    renderToggle(
        list,
        t('popupLocalTor'),
        'localTorEnabled',
        false,
        t('popupLocalTorHelp'),
    );
    renderToggle(
        list,
        t('popupTorBrowser'),
        'torBrowserEnabled',
        false,
        t('popupTorBrowserHelp'),
    );
    renderToggle(
        list,
        t('popupWarpCustomProxy'),
        'warpEnabled',
        false,
        t('popupWarpHelp'),
    );
    renderToggle(
        list,
        quick.ownProxiesConfigured ?
          t('popupOwnProxiesCount', [String(quick.ownProxyCount)]) :
          t('popupOwnProxies'),
        'ownProxiesEnabled',
        !quick.ownProxiesConfigured,
        quick.ownProxiesConfigured ?
          t('popupOwnProxiesHelp') :
          t('popupOwnProxiesConfigure'),
    );
    appendText(group, 'p', t('popupTorModeNote'), 'helper-text');
    appendText(group, 'p', t('popupTorAvailabilityNote'), 'helper-text');

  }

  function renderToggle(parent, labelText, key, disabled, helpText) {

    const ifDisabled = disabled || isOperationBusy(latestState);
    const label = append(
        parent,
        'label',
        ifDisabled ? 'toggle-row disabled' : 'toggle-row',
    );
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = draft.quickProxies[key] === true;
    input.disabled = ifDisabled;
    input.onchange = () => {
      if (input.disabled) {
        return;
      }
      draft.quickProxies[key] = input.checked;
      if (key === 'localTorEnabled' && input.checked) {
        draft.quickProxies.torBrowserEnabled = false;
      }
      if (key === 'torBrowserEnabled' && input.checked) {
        draft.quickProxies.localTorEnabled = false;
      }
      advancedOpen = true;
      markDraftPending('');
    };
    label.appendChild(input);
    const content = append(label, 'span', 'toggle-content');
    appendText(content, 'span', labelText);
    if (helpText) {
      appendText(content, 'span', helpText, 'toggle-hint');
    }

  }

  function renderAdvancedStatus(parent, state) {

    const group = append(parent, 'section', 'advanced-group');
    appendText(group, 'h3', t('popupTechnicalStatus'), 'advanced-heading');
    const list = append(group, 'dl', 'summary-list');
    appendSummaryRow(list, t('popupPac'), getPacStatusText(state));
    appendSummaryRow(
        list,
        t('popupAutoUpdate'),
        getAutoUpdateStatusText(state),
    );
    appendSummaryRow(
        list,
        t('popupBrowserProxyControl'),
        getControlDetailText(state),
    );
    const warnings = (state.warnings || []).filter(Boolean);
    warnings.forEach((warning) => {
      appendText(
          group,
          'p',
          localizeWarning(warning),
          'status-message warning',
      );
    });

  }

  function renderFooter(parent) {

    const footer = append(parent, 'footer', 'footer');
    const actions = append(footer, 'div', 'footer-actions');
    appendSettingsButton(actions, false);

  }

  function markDraftPending(focusKey) {

    lastOperation = {
      kind: 'draft',
      ok: true,
      status: 'pending',
    };
    requestedFocus = focusKey || '';
    renderPopup(latestState);

  }

  function renderLiveAnnouncement(parent, state, presentation, operation) {

    let text = '';
    if (busyOperation) {
      text = presentation.title;
    } else if (operation && operation.status === 'pending') {
      text = t('popupChangesPending');
    } else if (operation && operation.message) {
      text = operation.ok === false ?
        getSafeOperationMessage(operation) :
        localizeOperationMessage(operation.message);
    } else if (!state.controllable) {
      text = t('popupPageCannotBeControlledHelp');
    }
    const live = appendText(parent, 'p', text, 'ui-sr-only');
    live.setAttribute('aria-live', operation && operation.ok === false ?
      'assertive' :
      'polite');
    live.setAttribute('aria-atomic', 'true');

  }

  function getGlobalPresentation(state, operation) {

    const reconstructedBusy = getReconstructedBusyOperation(state);
    const activeBusy = busyOperation || reconstructedBusy;
    if (activeBusy) {
      return getBusyPresentation(activeBusy);
    }
    if (isExternallyControlled(state)) {
      return createPresentation(
          'external',
          'warning',
          'popupControlExternal',
          t('popupControlExternalHelp'),
          'popupStatusExternalPill',
      );
    }
    if (operation && operation.ok === false && operation.status === 'stale') {
      return createPresentation(
          'stale-operation',
          'warning',
          'popupControlStaleOperation',
          t('popupControlStaleOperationHelp'),
          'popupStatusStalePill',
      );
    }
    if (
      operation && operation.ok === false ||
      state.proxyApplyStatus === 'error'
    ) {
      return createPresentation(
          'error',
          'error',
          'popupControlError',
          t('popupControlErrorHelp'),
          'popupStatusErrorPill',
      );
    }
    if (state.pacStale) {
      return createPresentation(
          'stale',
          'warning',
          'popupControlStale',
          controlsPac(state) ?
          t('popupControlStaleActiveHelp') :
          t('popupControlStaleOffHelp'),
          'popupStatusStalePill',
      );
    }
    if (controlsPac(state)) {
      if (state.proxyHealth && state.proxyHealth.status === 'error') {
        return createPresentation(
            'degraded',
            'warning',
            'popupControlActive',
            getProxyHealthErrorText(state.proxyHealth),
            'popupHealthWarningPill',
        );
      }
      return createPresentation(
          'active',
          'success',
          'popupControlActive',
          t('popupControlActiveHelp'),
          state.proxyHealth && state.proxyHealth.status === 'ok' ?
            'popupHealthWorkingPill' :
            'popupStatusActivePill',
      );
    }
    if (!state.selectedProvider) {
      return createPresentation(
          'setup',
          '',
          'popupControlSetup',
          t('popupControlSetupHelp'),
          'popupStatusOffPill',
      );
    }
    return createPresentation(
        'off',
        '',
        'popupControlOff',
        t('popupControlOffHelp'),
        'popupStatusOffPill',
    );

  }

  function createPresentation(
      kind,
      tone,
      titleKey,
      description,
      pillKey,
  ) {

    return {
      kind,
      tone,
      title: t(titleKey),
      description,
      pillText: t(pillKey),
      pillClass: tone,
    };

  }

  function getBusyPresentation(operation) {

    const keys = BUSY_PRESENTATION_KEYS[operation] ||
      BUSY_PRESENTATION_KEYS.apply;
    return createPresentation(
        keys[0],
        '',
        keys[1],
        t(keys[2]),
        'popupStatusWorkingPill',
    );

  }

  function getReconstructedBusyOperation(state) {

    if (state.proxyApplyStatus === 'applying') {
      return 'apply';
    }
    if (state.proxyApplyStatus === 'clearing') {
      return 'clear';
    }
    if (
      state.pacDownloadStatus === 'downloading' ||
      state.pacCookStatus === 'cooking'
    ) {
      return 'updatePac';
    }
    if (state.proxyHealth && state.proxyHealth.status === 'checking') {
      return 'check';
    }
    return '';

  }

  function isOperationBusy(state) {

    return Boolean(busyOperation || getReconstructedBusyOperation(state));

  }

  function controlsPac(state) {

    const control = state.proxyControl || {};
    return state.proxyApplied === true || control.controlsPac === true;

  }

  function isExternallyControlled(state) {

    const control = state.proxyControl || {};
    const level = control.levelOfControl || '';
    return Boolean(level) && (
      level === 'controlled_by_other_extensions' ||
      level === 'not_controllable' ||
      control.canControl === false
    );

  }

  function shouldOfferApply(state, operation) {

    if (isExternallyControlled(state) || busyOperation) {
      return false;
    }
    if (operation && operation.ok === false) {
      return false;
    }
    return isDraftDirty(state) ||
      !controlsPac(state) ||
      state.pacStale === true ||
      state.proxyApplyStatus === 'error';

  }

  function isDraftDirty(state) {

    if (!draft) {
      return false;
    }
    const persisted = createDraft(state);
    const ifModeChanged = draft.siteMode !== persisted.siteMode;
    const ifScopeChanged = draft.siteMode !== 'auto' &&
      draft.siteScope !== persisted.siteScope;
    return draft.providerKey !== persisted.providerKey ||
      ifModeChanged ||
      ifScopeChanged ||
      JSON.stringify(draft.quickProxies) !==
        JSON.stringify(persisted.quickProxies);

  }

  function getSiteModeDescription(mode) {

    if (mode === 'proxy') {
      return t('popupProxyModeDescription');
    }
    if (mode === 'direct') {
      return t('popupDirectModeDescription');
    }
    return t('popupAutoModeDescription');

  }

  function getDraftPattern(state) {

    const patterns = state.sitePatterns || {};
    if (draft.siteScope === 'domain' && patterns.wildcardAvailable) {
      return patterns.wildcardPattern || state.host || '';
    }
    return patterns.exactPattern || state.host || '';

  }

  function getDraftProxyMethodCount(state) {

    const quick = state.quickProxies || {};
    let count = 0;
    if (draft.quickProxies.localTorEnabled) {
      ++count;
    }
    if (draft.quickProxies.torBrowserEnabled) {
      ++count;
    }
    if (draft.quickProxies.warpEnabled) {
      ++count;
    }
    if (draft.quickProxies.ownProxiesEnabled) {
      count += Number(quick.enabledOwnProxyCount || quick.ownProxyCount || 0);
    }
    return count;

  }

  function getProxyMethodSummary(state) {

    const count = getDraftProxyMethodCount(state);
    if (count) {
      return t('popupProxyMethodsCount', [String(count)]);
    }
    return draft.siteMode === 'proxy' ?
      t('popupProxyMethodsRequired') :
      t('popupProxyMethodsOptional');

  }

  function getDraftProviderLabel(state) {

    if (!draft.providerKey) {
      return t('popupNotSelected');
    }
    const provider = (state.providers || []).find((item) =>
      item.key === draft.providerKey,
    );
    return provider ? getProviderLabel(provider) : draft.providerKey;

  }

  function getProviderLabel(provider) {

    if (provider.type === 'custom') {
      return t('popupCustomProviderLabel', [provider.label || provider.key]);
    }
    if (provider.key === 'onlyOwnSites') {
      return t('providerOnlyOwnSitesLabel');
    }
    return provider.label || provider.key;

  }

  function getProxyHealthSummary(state) {

    const health = state.proxyHealth || {};
    const status = health.status || 'unknown';
    let label;
    if (status === 'checking') {
      label = t('popupProxyHealthChecking');
    } else if (status === 'ok') {
      label = t('popupProxyHealthOk');
    } else if (status === 'error') {
      label = t('popupProxyHealthError');
    } else {
      label = t('popupProxyHealthUnknown');
    }
    if (!health.lastCheckedAt) {
      return label;
    }
    return t('popupStatusWithTime', [label, formatTimestamp(health.lastCheckedAt)]);

  }

  function getProxyHealthErrorText(proxyHealth) {

    if (proxyHealth.candidateType === 'torBrowser') {
      return t('proxyHealthTorBrowserError');
    }
    if (proxyHealth.candidateType === 'localTor') {
      return t('proxyHealthLocalTorError');
    }
    return t('proxyHealthGenericError');

  }

  function getRoutingUpdateSummary(state) {

    if (state.autoUpdate && state.autoUpdate.error) {
      return t('popupRoutingUpdateFailed');
    }
    if (!state.pacUpdatedAt) {
      return t('popupNeverUpdated');
    }
    return state.pacStale ?
      t('popupRoutingUpdatePending', [formatTimestamp(state.pacUpdatedAt)]) :
      formatTimestamp(state.pacUpdatedAt);

  }

  function getPacStatusText(state) {

    if (!state.pacDownloaded) {
      return t('popupNotDownloaded');
    }
    if (!state.pacCooked) {
      return t('popupDownloaded');
    }
    return state.pacStale ?
      t('popupCookedStale') :
      t('popupDownloadedAndCooked');

  }

  function getAutoUpdateStatusText(state) {

    const autoUpdate = state.autoUpdate || {};
    if (!autoUpdate.enabled) {
      return t('optionsDisabled');
    }
    return t('popupAutoUpdateEveryHours', [
      String(Math.round(autoUpdate.intervalHours || 12)),
    ]);

  }

  function getControlDetailText(state) {

    if (isExternallyControlled(state)) {
      return t('popupControlExternalShort');
    }
    if (controlsPac(state)) {
      return t('popupControlActiveShort');
    }
    return t('popupControlOffShort');

  }

  function appendSummaryRow(parent, label, value, pillText, pillClass) {

    const row = append(parent, 'div', 'summary-row');
    appendText(row, 'dt', label);
    const definition = append(row, 'dd');
    if (pillText) {
      const group = append(definition, 'span', 'summary-value-with-pill');
      appendText(group, 'span', value);
      appendText(
          group,
          'span',
          pillText,
          `ui-pill ${pillClass || ''}`.trim(),
      );
    } else {
      definition.textContent = value;
    }

  }

  function formatTimestamp(value) {

    if (!value) {
      return t('popupNeverUpdated');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return t('popupNeverUpdated');
    }
    const elapsedMinutes = Math.max(
        0,
        Math.floor((Date.now() - date.getTime()) / (60 * 1000)),
    );
    if (elapsedMinutes < 60) {
      return t('popupMinutesAgo', [String(elapsedMinutes)]);
    }
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 48) {
      return t('popupHoursAgo', [String(elapsedHours)]);
    }
    return t('popupDaysAgo', [String(Math.floor(elapsedHours / 24))]);

  }

  function canRetryOperation(operation) {

    if (!operation || operation.ok !== false || busyOperation) {
      return false;
    }
    const code = operation.error && operation.error.code || '';
    if (
      code === 'PROXY_RULE_NO_CANDIDATE' ||
      code === 'PROVIDER_NOT_SELECTED' ||
      !draft.providerKey && ['apply', 'updatePac'].includes(operation.kind)
    ) {
      return false;
    }
    return ['apply', 'updatePac', 'clear', 'check'].includes(operation.kind);

  }

  function retryLastOperation() {

    if (!canRetryOperation(lastOperation)) {
      return;
    }
    if (lastOperation.kind === 'clear') {
      return clearProxy();
    }
    if (lastOperation.kind === 'check') {
      return checkProxy();
    }
    return runPopupOperation(lastOperation.kind);

  }

  async function runPopupOperation(operation) {

    if (busyOperation) {
      return;
    }
    busyOperation = operation;
    lastOperation = null;
    renderPopup(latestState);
    try {
      const result = await rpc.callBackground('applyPopupChanges', {
        tabUrl: activeTabUrl,
        operation,
        draft,
      });
      latestState = result.popupState || latestState;
      lastOperation = Object.assign({kind: operation}, result);
      if (result.ok !== false) {
        draft = createDraft(latestState);
      }
    } catch (err) {
      lastOperation = createOperationError(operation, err);
    } finally {
      busyOperation = '';
      renderPopup(latestState);
    }

  }

  async function clearProxy() {

    if (busyOperation || isExternallyControlled(latestState)) {
      return;
    }
    busyOperation = 'clear';
    lastOperation = null;
    renderPopup(latestState);
    try {
      const result = await rpc.callBackground('clearProxy');
      latestState = await rpc.callBackground('getPopupState', {
        tabUrl: activeTabUrl,
      });
      lastOperation = Object.assign({
        kind: 'clear',
        message: result.ok === false ?
          t('popupClearProxyFailed') :
          t('popupProxyCleared'),
      }, result);
      if (result.ok !== false) {
        draft = createDraft(latestState);
      }
    } catch (err) {
      lastOperation = createOperationError('clear', err);
    } finally {
      busyOperation = '';
      renderPopup(latestState);
    }

  }

  async function checkProxy() {

    if (busyOperation || isExternallyControlled(latestState)) {
      return;
    }
    busyOperation = 'check';
    lastOperation = null;
    renderPopup(latestState);
    try {
      const result = await rpc.callBackground('checkProxyHealth', {
        tabUrl: activeTabUrl,
      });
      latestState = await rpc.callBackground('getPopupState', {
        tabUrl: activeTabUrl,
      });
      lastOperation = Object.assign({
        kind: 'check',
        message: localizeProxyCheckResult(result),
      }, result);
    } catch (err) {
      lastOperation = createOperationError('check', err);
    } finally {
      busyOperation = '';
      renderPopup(latestState);
    }

  }

  function createOperationError(kind, err) {

    return {
      kind,
      ok: false,
      status: err && err.code === 'PAC_APPLY_STALE' ? 'stale' : 'error',
      message: '',
      error: {
        code: err && err.code || 'POPUP_OPERATION_FAILED',
      },
    };

  }

  function getSafeOperationMessage(operation) {

    if (operation.status === 'stale') {
      return t('popupStaleOperation');
    }
    const code = operation.error && operation.error.code || '';
    if (code === 'PROXY_RULE_NO_CANDIDATE') {
      return t('popupNoProxyCandidate');
    }
    if (operation.kind === 'clear') {
      return t('popupClearProxyFailed');
    }
    if (operation.kind === 'check') {
      return t('popupProxyCheckInconclusive');
    }
    if (operation.kind === 'updatePac') {
      return t('popupRoutingUpdateFailed');
    }
    return t('popupOperationFailed');

  }

  function localizeProxyCheckResult(result) {

    if (result.status === 'ok') {
      return t('popupProxyCheckSucceeded');
    }
    if (result.status === 'error') {
      return getProxyHealthErrorText(result.proxyHealth || {});
    }
    if (result.code === 'PROXY_CHECK_REQUIRES_PROXY_RULE') {
      return t('popupProxyCheckRequiresProxyRule');
    }
    if (result.code === 'PROXY_CHECK_NOT_APPLIED') {
      return t('popupProxyCheckNotApplied');
    }
    if (result.code === 'NO_PROXY_CANDIDATE') {
      return t('popupNoProxyCandidate');
    }
    return t('popupProxyCheckInconclusive');

  }

  function localizeOperationMessage(message) {

    const text = String(message || '');
    const exact = {
      'PAC settings changed. Apply changes to activate.':
        t('popupChangesPending'),
      'PAC downloaded and cooked.': t('popupRoutingDataUpdated'),
      'Settings applied.': t('popupSettingsApplied'),
      'No proxy is enabled. Enable Tor, WARP, or an own proxy.':
        t('popupNoProxyCandidate'),
      'No proxy candidate enabled. Enable Local Tor, Tor Browser, WARP, or own proxy.':
        t('popupNoProxyCandidate'),
      'No proxy candidate enabled.': t('popupNoProxyCandidate'),
      'Select a PAC provider first.': t('popupSelectPacProviderFirst'),
      'Periodic PAC update is already running.':
        t('popupPeriodicUpdateRunning'),
      'Another PAC operation is already running.':
        t('popupPacOperationRunning'),
      'PAC application was superseded by newer PAC settings or an operation.':
        t('popupStaleOperation'),
    };
    return exact[text] || t('popupOperationCompleted');

  }

  function localizeWarning(message) {

    const text = String(message || '');
    if (text === 'No proxy is enabled. Enable Tor, WARP, or an own proxy.') {
      return t('popupNoProxyCandidate');
    }
    if (text.includes('host-pattern matching')) {
      return t('popupMv2RulesWarning');
    }
    if (text.includes('no proxy candidates are enabled')) {
      return t('popupNoProxyCandidate');
    }
    if (text.includes('credentials are removed from cooked PAC')) {
      return t('popupCredentialsRedactedWarning');
    }
    if (text.includes('Tor itself must be running locally')) {
      return t('popupTorMustRunWarning');
    }
    if (text.includes('WARP is treated')) {
      return t('popupWarpLocalProxyWarning');
    }
    if (text.includes('replaceDirectWithProxy is enabled')) {
      return t('popupDirectReplacementNoCandidateWarning');
    }
    if (text.includes('PAC provider proxies are disabled')) {
      return t('popupNoPacOrOwnProxyWarning');
    }
    if (text === 'This page cannot be controlled.') {
      return t('popupPageCannotBeControlled');
    }
    return t('popupConfigurationWarning');

  }

  function openAdvanced(focusKey) {

    advancedOpen = true;
    requestedFocus = focusKey || '';
    renderPopup(latestState);

  }

  function focusRequestedControl() {

    if (!requestedFocus) {
      return;
    }
    const target = findByFocusKey(root, requestedFocus);
    requestedFocus = '';
    if (target && typeof target.focus === 'function') {
      target.focus();
    }

  }

  function findByFocusKey(parent, focusKey) {

    if (parent.dataset && parent.dataset.focusKey === focusKey) {
      return parent;
    }
    const children = Array.from(parent.children || []);
    for (const child of children) {
      const match = findByFocusKey(child, focusKey);
      if (match) {
        return match;
      }
    }
    return null;

  }

  function appendSettingsButton(parent, iconOnly) {

    const className = iconOnly ?
      'ui-icon-button' :
      'ui-button quiet';
    const button = append(parent, 'button', className);
    button.type = 'button';
    button.setAttribute('aria-label', t('popupOpenSettings'));
    button.title = t('popupOpenSettings');
    if (iconOnly) {
      appendSettingsIcon(button);
    } else {
      button.textContent = t('popupOpenSettings');
    }
    button.onclick = openFullSettings;
    return button;

  }

  async function openFullSettings() {

    if (openingSettings) {
      return;
    }
    openingSettings = true;
    try {
      await rpc.callBackground('openOptionsPage');
      window.close();
    } catch (err) {
      chrome.runtime.openOptionsPage();
    } finally {
      openingSettings = false;
    }

  }

  function appendSettingsIcon(parent) {

    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('settings-icon');
    [
      ['M4 6h3m4 0h9', '9', '6'],
      ['M4 12h9m4 0h3', '15', '12'],
      ['M4 18h5m4 0h7', '11', '18'],
    ].forEach(([pathData, circleX, circleY]) => {
      const path = document.createElementNS(SVG_NAMESPACE, 'path');
      path.setAttribute('d', pathData);
      svg.appendChild(path);
      const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
      circle.setAttribute('cx', circleX);
      circle.setAttribute('cy', circleY);
      circle.setAttribute('r', '2');
      svg.appendChild(circle);
    });
    parent.appendChild(svg);

  }

  function appendButton(parent, text, className) {

    const button = append(parent, 'button', className || 'ui-button');
    button.type = 'button';
    button.textContent = text;
    return button;

  }

  function appendOption(parent, value, label) {

    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    parent.appendChild(option);

  }

  function append(parent, tagName, className) {

    const element = document.createElement(tagName);
    if (className) {
      element.className = className;
    }
    parent.appendChild(element);
    return element;

  }

  function appendText(parent, tagName, text, className) {

    const element = append(parent, tagName, className);
    element.textContent = text;
    return element;

  }

  function clear(element) {

    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }

  }

})();
