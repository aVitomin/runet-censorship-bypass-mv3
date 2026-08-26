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
  let scopeOpen = false;
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
    if (presentation.kind !== 'setup') {
      renderSiteCard(root, state);
      renderDailyDetails(root, state, presentation);
    }
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
    appendSettingsButton(header, true);

  }

  function renderGlobalCard(parent, state, presentation, operation) {

    const tone = presentation.tone ? ` ${presentation.tone}` : '';
    const card = append(
        parent,
        'section',
        `ui-card card global-card compact${tone}`,
    );
    card.dataset.area = 'global-status';
    const headingId = 'popup-global-heading';
    card.setAttribute('aria-labelledby', headingId);
    const heading = appendText(
        card,
        'h2',
        presentation.title,
        'card-title',
    );
    heading.id = headingId;
    const description = appendText(
        card,
        'p',
        presentation.description,
        'card-copy',
    );
    description.id = 'popup-global-description';

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
    const siteChangePending = isSiteDraftDirty(state);

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
      choose.onclick = openFullSettings;
      ifActionAdded = true;
    } else if (primaryAction === 'apply' && !siteChangePending) {
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
    } else if (primaryAction === 'connection-check') {
      appendOptionsLink(
          actions,
          t('popupOpenConnectionCheck'),
          'maintenance',
          'ui-button primary',
      );
      ifActionAdded = true;
    }

    if (canTurnOffProxy(state)) {
      const clearButton = appendButton(
          actions,
          t('popupTurnOffProxy'),
          'ui-button quiet',
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
        ['applying', 'clearing', 'updating', 'checking']
            .includes(presentation.kind),
    );

  }

  function getPrimaryAction(state, operation) {

    if (isExternallyControlled(state)) {
      return '';
    }
    if (canRetryOperation(operation)) {
      return 'retry';
    }
    if (state.proxyApplyStatus === 'error' && draft.providerKey) {
      return 'retry-apply';
    }
    if (!draft.providerKey) {
      return 'choose-provider';
    }
    if (
      controlsPac(state) &&
      state.proxyHealth &&
      state.proxyHealth.status === 'error'
    ) {
      return 'connection-check';
    }
    return shouldOfferApply(state, operation) ? 'apply' : '';

  }

  function renderSiteCard(parent, state) {

    const card = append(parent, 'section', 'ui-card card site-card');
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
      input.setAttribute('aria-describedby', [
        'popup-route-description',
        ...(ifDisabled ? ['popup-global-description'] : []),
      ].join(' '));
      input.onchange = () => {
        if (input.disabled || !input.checked) {
          return;
        }
        draft.siteMode = mode;
        if (mode === 'auto') {
          scopeOpen = false;
        }
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
      appendOptionsLink(
          card,
          t('popupConfigureProxyMethods'),
          'proxy-methods',
          'ui-button quiet compact-link',
      );
    }

    if (draft.siteMode !== 'auto') {
      renderScopeControl(card, state, ifDisabled);
    }

    renderPendingSiteChange(card, state, ifDisabled);

  }

  function renderScopeControl(parent, state, ifDisabled) {

    const patterns = state.sitePatterns || {};
    const scopeHelpId = 'popup-scope-help';
    const details = append(parent, 'details', 'scope-disclosure');
    details.open = scopeOpen;
    const selectedScope = draft.siteScope === 'host' ?
      t('popupHostOnly') :
      t('popupDomainAndSubdomains');
    const summary = appendText(
        details,
        'summary',
        t('popupScopeSummary', [selectedScope]),
    );
    summary.setAttribute('aria-controls', 'popup-scope-content');
    details.ontoggle = () => {
      scopeOpen = details.open;
    };
    const fieldset = append(details, 'fieldset', 'scope-fieldset');
    fieldset.id = 'popup-scope-content';
    appendText(fieldset, 'legend', t('popupScope'), 'ui-sr-only');
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
      const descriptions = [];
      if (ifDisabled) {
        descriptions.push('popup-global-description');
      }
      if (value === 'domain' && !patterns.wildcardAvailable) {
        descriptions.push(scopeHelpId);
      }
      if (descriptions.length) {
        input.setAttribute('aria-describedby', descriptions.join(' '));
      }
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
      const help = appendText(
          fieldset,
          'p',
          t('popupHostScopeOnly'),
          'helper-text',
      );
      help.id = scopeHelpId;
    } else {
      const help = appendText(
          fieldset,
          'p',
          t('popupDomainScopeSafeHelp'),
          'helper-text',
      );
      help.id = scopeHelpId;
    }

  }

  function renderPendingSiteChange(parent, state, ifDisabled) {

    if (!isSiteDraftDirty(state) || isOperationBusy(state)) {
      return;
    }
    const pending = append(parent, 'div', 'site-pending');
    const status = appendText(
        pending,
        'span',
        t('popupNotApplied'),
        'ui-pill warning',
    );
    status.id = 'popup-site-pending-status';
    const applyButton = appendButton(
        pending,
        t('popupApplyChanges'),
        'ui-button primary compact-action',
    );
    const candidateMissing = draft.siteMode === 'proxy' &&
      getDraftProxyMethodCount(state) === 0;
    applyButton.disabled = ifDisabled || candidateMissing;
    applyButton.setAttribute('aria-describedby', candidateMissing ?
      'popup-site-warning' :
      isExternallyControlled(state) ?
        'popup-global-description' :
        'popup-site-pending-status');
    applyButton.onclick = () => runPopupOperation('apply');

  }

  function renderDailyDetails(parent, state, presentation) {

    const details = append(
        parent,
        'details',
        'ui-card daily-details',
    );
    details.dataset.area = 'details';
    const summary = appendText(
        details,
        'summary',
        t('popupDetails'),
    );
    summary.setAttribute('aria-controls', 'popup-details-content');
    const content = append(details, 'div', 'daily-details-content');
    content.id = 'popup-details-content';
    const source = append(content, 'div', 'daily-detail-row');
    appendText(source, 'span', t('popupRoutingSource'));
    appendText(source, 'strong', getDraftProviderLabel(state));
    const links = append(content, 'div', 'daily-detail-links');
    appendOptionsLink(
        links,
        t('popupAutomaticRoutingSettings'),
        'routing-sources',
    );
    appendOptionsLink(
        links,
        t('popupConfigureProxyMethods'),
        'proxy-methods',
    );
    if (presentation.kind === 'degraded') {
      appendOptionsLink(
          links,
          t('popupOpenConnectionCheck'),
          'maintenance',
      );
    }

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
      const ifCleared = state.proxyApplyStatus === 'cleared';
      return createPresentation(
          'external',
          'warning',
          ifCleared ? 'popupControlOff' : 'popupControlExternal',
          t(ifCleared ?
            'popupControlExternalClearedHelp' :
            'popupControlExternalHelp'),
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
          t(controlsPac(state) ?
            'popupControlErrorActiveHelp' :
            'popupControlErrorOffHelp'),
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

  function canTurnOffProxy(state) {

    if (controlsPac(state)) {
      return true;
    }
    return isExternallyControlled(state) &&
      state.proxyApplyStatus !== 'cleared';

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

  function isSiteDraftDirty(state) {

    if (!draft) {
      return false;
    }
    const persisted = createDraft(state);
    return draft.siteMode !== persisted.siteMode ||
      draft.siteMode !== 'auto' && draft.siteScope !== persisted.siteScope;

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

  function getProxyHealthErrorText(proxyHealth) {

    if (proxyHealth.candidateType === 'torBrowser') {
      return t('proxyHealthTorBrowserError');
    }
    if (proxyHealth.candidateType === 'localTor') {
      return t('proxyHealthLocalTorError');
    }
    return t('proxyHealthGenericError');

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
    return ['apply', 'updatePac', 'clear'].includes(operation.kind);

  }

  function retryLastOperation() {

    if (!canRetryOperation(lastOperation)) {
      return;
    }
    if (lastOperation.kind === 'clear') {
      return clearProxy();
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

    if (busyOperation) {
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
          t(result.cleanupStatus === 'deferred' ?
            'popupProxyClearDeferred' :
            'popupProxyCleared'),
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

  function appendOptionsLink(parent, text, section, className) {

    const link = append(parent, 'a', className || 'settings-link');
    link.textContent = text;
    link.href = `${chrome.runtime.getURL('pages/options/index.html')}#${section}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;

  }

  function appendButton(parent, text, className) {

    const button = append(parent, 'button', className || 'ui-button');
    button.type = 'button';
    button.textContent = text;
    return button;

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
