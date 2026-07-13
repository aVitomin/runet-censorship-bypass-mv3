'use strict';

(function() {

  const rpc = window.mv3Rpc;
  const root = document.getElementById('popup-root');
  let activeTabUrl = '';
  let latestState = null;
  let draft = null;

  document.addEventListener('DOMContentLoaded', init);

  function t(key, substitutions) {

    return window.mv3I18n ?
      window.mv3I18n.t(key, substitutions) :
      chrome.i18n.getMessage(key, substitutions) || key;

  }

  async function init() {

    renderLoading();
    try {
      const tab = await getActiveTab();
      activeTabUrl = tab && tab.url || '';
      latestState = await rpc.callBackground('getPopupState', {
        tabUrl: activeTabUrl,
      });
      await window.mv3I18n.init(latestState.uiLanguage);
      draft = createDraft(latestState);
      renderPopup(latestState);
    } catch (err) {
      renderError(err.message || t('popupLoadError'));
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
    appendText(root, 'p', t('popupLoading'));

  }

  function renderError(message) {

    clear(root);
    document.title = t('popupTitle');
    appendText(root, 'h1', t('popupTitle'));
    appendText(root, 'p', message, 'status error');
    appendFullSettingsButton(root);

  }

  function renderPopup(state, operation) {

    clear(root);
    document.title = t('popupTitle');
    appendText(root, 'h1', t('popupTitle'));
    renderProviderSection(root, state, operation);
    renderSiteSection(root, state);
    renderQuickProxySection(root, state);
    renderStatus(root, state, operation);
    renderActions(root);

  }

  function renderProviderSection(parent, state, operation) {

    const section = append(parent, 'section', 'panel');
    appendText(section, 'h2', t('popupPacScript'));
    appendText(
        section,
        'p',
        t(
            'popupProviderStatus',
            [getSelectedProviderLabel(state)],
        ),
        'note',
    );
    const row = append(section, 'div', 'provider-row');
    const select = append(row, 'select');
    select.setAttribute('aria-label', t('popupPacProvider'));
    select.title = t('popupPacProviderHelp');
    appendOption(select, '', t('popupSelectProvider'));
    (state.providers || []).forEach((provider) => {
      appendOption(select, provider.key, getProviderLabel(provider));
    });
    select.value = draft.providerKey || '';
    select.onchange = () => {
      draft.providerKey = select.value;
      renderPopup(latestState, {
        ok: true,
        message: t('popupPacChanged'),
      });
    };

    const updateButton = append(row, 'button');
    updateButton.type = 'button';
    updateButton.textContent = t('popupUpdatePac');
    updateButton.title = t('popupUpdatePacHelp');
    updateButton.onclick = () => runPopupOperation(updateButton, 'updatePac');
    if (!draft.providerKey) {
      updateButton.disabled = true;
    }
    if (operation && operation.status === 'updated') {
      appendText(section, 'p', localizeOperationMessage(operation.message), 'status success');
    }

  }

  function renderSiteSection(parent, state) {

    const section = append(parent, 'section', 'panel');
    appendText(section, 'h2', t('popupCurrentSite'));
    appendText(
        section,
        'p',
        state.controllable ? state.host : t('popupPageCannotBeControlled'),
        state.controllable ? 'current-site' : 'current-site muted',
    );

    const modes = append(section, 'div', 'segmented');
    [
      ['auto', t('popupAutoMode')],
      ['proxy', t('popupProxyMode')],
      ['direct', t('popupDirectMode')],
    ].forEach(([mode, label]) => {
      const button = append(modes, 'button');
      button.type = 'button';
      button.textContent = mode === 'auto' ? t('popupAutoMode') : label;
      button.title = getSiteModeHelp(mode);
      button.disabled = !state.controllable;
      if (draft.siteMode === mode) {
        button.classList.add('selected');
      }
      button.onclick = () => {
        draft.siteMode = mode;
        renderPopup(latestState, {
          ok: true,
          message: t('popupPacChanged'),
        });
      };
    });
    renderScopeControl(section, state);

  }

  function renderScopeControl(parent, state) {

    if (!state.controllable) {
      return;
    }
    const patterns = state.sitePatterns || {};
    const scope = append(parent, 'div', 'scope-control');
    appendText(scope, 'p', t('popupScope'), 'scope-title');
    [
      ['host', t('popupHostOnly')],
      ['domain', t('popupDomainAndSubdomains')],
    ].forEach(([value, labelText]) => {
      const label = append(scope, 'label', 'radio-row');
      if (value === 'domain') {
        label.title = t('popupDomainScopeHelp');
      }
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'site-scope';
      input.value = value;
      input.checked = draft.siteScope === value;
      input.disabled = value === 'domain' && !patterns.wildcardAvailable;
      input.title = value === 'domain' ? t('popupDomainScopeHelp') : '';
      input.onchange = () => {
        draft.siteScope = value;
        renderPopup(latestState, {
          ok: true,
          message: t('popupPacChanged'),
        });
      };
      label.appendChild(input);
      label.appendChild(document.createTextNode(labelText));
    });
    appendText(
        scope,
        'p',
        t('popupRulePreview', [getDraftPattern(state)]),
        'pattern-preview',
    );
    if (draft.siteScope === 'domain') {
      appendText(
          scope,
          'p',
          t('popupSubdomainHeuristicNote'),
          'note',
      );
    }

  }

  function getSiteModeHelp(mode) {

    if (mode === 'proxy') {
      return t('popupProxyModeHelp');
    }
    if (mode === 'direct') {
      return t('popupDirectModeHelp');
    }
    return t('popupAutoModeHelp');

  }

  function renderQuickProxySection(parent, state) {

    const section = append(parent, 'section', 'panel');
    const quick = state.quickProxies || {};
    appendText(section, 'h2', t('popupQuickProxies'));
    renderToggle(
        section,
        t('popupUsePacScriptProxies'),
        'usePacScriptProxies',
        false,
        t('popupUsePacScriptProxiesHelp'),
        t('popupUsePacScriptProxiesHint'),
    );
    renderToggle(
        section,
        t('popupOwnProxiesOnlyForOwnSites'),
        'ownProxiesOnlyForOwnSites',
        false,
        t('popupOwnProxiesOnlyForOwnSitesHelp'),
        t('popupOwnProxiesOnlyForOwnSitesHint'),
    );
    renderToggle(
        section,
        t('popupLocalTor'),
        'localTorEnabled',
        false,
        t('popupLocalTorHelp'),
        t('popupLocalTorHint'),
    );
    renderToggle(
        section,
        t('popupTorBrowser'),
        'torBrowserEnabled',
        false,
        t('popupTorBrowserHelp'),
        t('popupTorBrowserHint'),
    );
    appendText(section, 'p', t('popupTorModeNote'), 'note');
    appendText(section, 'p', t('popupTorAvailabilityNote'), 'note');
    renderToggle(
        section,
        t('popupWarpCustomProxy'),
        'warpEnabled',
        false,
        t('popupWarpHelp'),
        '',
    );
    renderToggle(
        section,
        quick.ownProxiesConfigured ?
          t('popupOwnProxiesCount', [String(quick.ownProxyCount)]) :
          t('popupOwnProxies'),
        'ownProxiesEnabled',
        !quick.ownProxiesConfigured,
        t('popupOwnProxiesHelp'),
        '',
    );
    if (!quick.ownProxiesConfigured) {
      appendText(section, 'p', t('popupOwnProxiesConfigure'), 'note');
    }

  }

  function renderToggle(parent, labelText, key, disabled, title, hint) {

    const label = append(
        parent,
        'label',
        disabled ? 'toggle-row disabled' : 'toggle-row',
    );
    if (title) {
      label.title = title;
    }
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = draft.quickProxies[key] === true;
    input.disabled = disabled === true;
    if (title) {
      input.title = title;
    }
    input.onchange = () => {
      draft.quickProxies[key] = input.checked;
      if (key === 'localTorEnabled' && input.checked) {
        draft.quickProxies.torBrowserEnabled = false;
      }
      if (key === 'torBrowserEnabled' && input.checked) {
        draft.quickProxies.localTorEnabled = false;
      }
      renderPopup(latestState, {
        ok: true,
        message: t('popupPacChanged'),
      });
    };
    label.appendChild(input);
    label.appendChild(document.createTextNode(labelText));
    if (hint) {
      appendText(label, 'span', hint, 'toggle-hint');
    }

  }

  function renderStatus(parent, state, operation) {

    const section = append(parent, 'section', 'panel status-panel');
    appendText(section, 'h2', t('popupStatus'));
    appendStatusRow(
        section,
        t('popupProvider'),
        getSelectedProviderLabel(state),
    );
    appendStatusRow(section, t('popupPac'), getPacStatusText(state));
    appendStatusRow(section, t('popupUpdated'), formatTimestamp(state.pacUpdatedAt));
    appendStatusRow(
        section,
        t('popupAutoUpdate'),
        getAutoUpdateStatusText(state),
    );
    appendStatusRow(
        section,
        t('popupProxy'),
        getProxyApplyStatusText(state),
    );
    appendStatusRow(
        section,
        t('popupCandidate'),
        getProxyCandidateSummaryText(state),
    );
    appendStatusRow(
        section,
        t('popupProxyHealth'),
        getProxyHealthStatusText(state),
    );

    if (
      state.mode === 'proxy' &&
      state.proxyHealth &&
      state.proxyHealth.status === 'error'
    ) {
      const error = appendText(
          section,
          'p',
          getProxyHealthErrorText(state.proxyHealth),
          'status error',
      );
      error.title = state.proxyHealth.lastErrorCode || '';
    }
    if (state.mode === 'proxy' && state.proxyApplied) {
      const checkButton = append(section, 'button', 'status-action');
      checkButton.type = 'button';
      checkButton.textContent = state.proxyHealth &&
        state.proxyHealth.status === 'error' ?
        t('popupCheckProxyAgain') :
        t('popupCheckProxy');
      checkButton.onclick = () => checkProxy(checkButton);
    }
    if (state.autoUpdate && state.autoUpdate.error) {
      appendText(
          section,
          'p',
          t('popupPacUpdateFailed'),
          'status warning',
      );
    }

    const warnings = (operation && operation.warnings || [])
        .concat(state.warnings || [])
        .filter(Boolean);
    warnings.forEach((warning) => {
      appendText(section, 'p', localizeWarning(warning), 'status warning');
    });
    if (operation && operation.message) {
      appendText(
          section,
          'p',
          localizeOperationMessage(operation.message),
          operation.ok === false ? 'status warning' : 'status success',
      );
    }

  }

  function getPacStatusText(state) {

    if (!state.pacDownloaded) {
      return t('popupNotDownloaded');
    }
    if (!state.pacCooked) {
      return t('popupDownloaded');
    }
    return state.pacStale ? t('popupCookedStale') : t('popupDownloadedAndCooked');

  }

  function getProxyApplyStatusText(state) {

    if (state.proxyApplied) {
      return t('popupApplied');
    }
    return state.proxyApplyStatus === 'error' ?
      t('optionsStatusError') :
      t('popupNotApplied');

  }

  function getProxyCandidateSummaryText(state) {

    if (!state.proxyCandidates || !state.proxyCandidates.available) {
      return t('popupMissing');
    }
    const quick = state.quickProxies || {};
    const labels = [];
    if (quick.localTorEnabled) {
      labels.push(t('popupLocalTor'));
    }
    if (quick.torBrowserEnabled) {
      labels.push(t('popupTorBrowser'));
    }
    if (quick.warpEnabled) {
      labels.push(t('popupWarpCustomProxy'));
    }
    if (quick.ownProxiesEnabled && quick.enabledOwnProxyCount) {
      labels.push(t('popupOwnProxiesCount', [String(quick.enabledOwnProxyCount)]));
    }
    return labels.length ? labels.join(', ') : t('popupMissing');

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

  function getProxyHealthStatusText(state) {

    if (state.mode !== 'proxy') {
      return t('popupProxyHealthUnknown');
    }
    const status = state.proxyHealth && state.proxyHealth.status || 'unknown';
    if (status === 'checking') {
      return t('popupProxyHealthChecking');
    }
    if (status === 'ok') {
      return t('popupProxyHealthOk');
    }
    if (status === 'error') {
      return t('popupProxyHealthError');
    }
    return t('popupProxyHealthUnknown');

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

  function getSelectedProviderLabel(state) {

    if (!state.selectedProvider) {
      return t('popupNotSelected');
    }
    const provider = (state.providers || []).find((item) =>
      item.key === state.selectedProvider,
    );
    return provider ? getProviderLabel(provider) :
      state.selectedProviderLabel || state.selectedProvider;

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

  function appendStatusRow(parent, label, value) {

    const row = append(parent, 'div', 'status-row');
    appendText(row, 'span', label, 'status-label');
    appendText(row, 'span', value, 'status-value');

  }

  function renderActions(parent) {

    const actions = append(parent, 'div', 'actions');
    const applyButton = append(actions, 'button', 'primary');
    applyButton.type = 'button';
    applyButton.textContent = t('popupApplyChanges');
    applyButton.title = t('popupApplyChangesHelp');
    applyButton.disabled = !draft.providerKey;
    applyButton.onclick = () => runPopupOperation(applyButton, 'apply');
    const clearButton = append(actions, 'button');
    clearButton.type = 'button';
    clearButton.textContent = t('popupClearProxy');
    clearButton.title = t('popupClearProxyHelp');
    clearButton.onclick = () => clearProxy(clearButton);
    appendFullSettingsButton(actions);

  }

  async function runPopupOperation(button, operation) {

    button.disabled = true;
    const label = button.textContent;
    button.textContent = operation === 'apply' ? t('popupApplying') : t('popupUpdating');
    try {
      const result = await rpc.callBackground('applyPopupChanges', {
        tabUrl: activeTabUrl,
        operation,
        draft,
      });
      latestState = result.popupState;
      draft = createDraft(latestState);
      renderPopup(latestState, result);
    } catch (err) {
      renderPopup(latestState, {
        ok: false,
        message: err.message || t('popupOperationFailed'),
      });
    } finally {
      button.textContent = label;
    }

  }

  async function clearProxy(button) {

    button.disabled = true;
    const label = button.textContent;
    button.textContent = t('popupClearing');
    try {
      const result = await rpc.callBackground('clearProxy');
      latestState = await rpc.callBackground('getPopupState', {
        tabUrl: activeTabUrl,
      });
      draft = createDraft(latestState);
      renderPopup(latestState, {
        ok: result.ok !== false,
        status: result.status || 'cleared',
        message: result.ok === false ?
          result.error && result.error.message || t('popupClearProxyFailed') :
          t('popupProxyCleared'),
      });
    } catch (err) {
      renderPopup(latestState, {
        ok: false,
        message: err.message || t('popupClearProxyFailed'),
      });
    } finally {
      button.textContent = label;
    }

  }

  async function checkProxy(button) {

    button.disabled = true;
    const label = button.textContent;
    button.textContent = t('popupProxyHealthChecking');
    try {
      const result = await rpc.callBackground('checkProxyHealth', {
        tabUrl: activeTabUrl,
      });
      latestState = await rpc.callBackground('getPopupState', {
        tabUrl: activeTabUrl,
      });
      draft = createDraft(latestState);
      renderPopup(latestState, {
        ok: result.ok,
        message: localizeProxyCheckResult(result),
      });
    } catch (err) {
      renderPopup(latestState, {
        ok: false,
        message: err.message || t('popupProxyCheckInconclusive'),
      });
    } finally {
      button.textContent = label;
    }

  }

  function getDraftPattern(state) {

    const patterns = state.sitePatterns || {};
    if (draft.siteScope === 'domain' && patterns.wildcardAvailable) {
      return patterns.wildcardPattern || state.host || '';
    }
    return patterns.exactPattern || state.host || '';

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
      'PAC settings changed. Apply changes to activate.': t('popupPacChanged'),
      'PAC downloaded and cooked.': t('popupPacDownloadedAndCookedMessage'),
      'Settings applied.': t('popupSettingsApplied'),
      'No proxy is enabled. Enable Tor, WARP, or an own proxy.':
        t('popupNoProxyCandidate'),
      'No proxy candidate enabled. Enable Local Tor, Tor Browser, WARP, or own proxy.':
        t('popupNoProxyCandidate'),
      'No proxy candidate enabled.': t('popupNoProxyCandidate'),
      'Select a PAC provider first.': t('popupSelectPacProviderFirst'),
      'Periodic PAC update is already running.': t('popupPeriodicUpdateRunning'),
      'Another PAC operation is already running.': t('popupPacOperationRunning'),
    };
    return exact[text] || text;

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
    return text;

  }

  function appendFullSettingsButton(parent) {

    const button = append(parent, 'button');
    button.type = 'button';
    button.textContent = t('popupFullSettings');
    button.onclick = async () => {
      try {
        await rpc.callBackground('openOptionsPage');
        window.close();
      } catch (err) {
        chrome.runtime.openOptionsPage();
      }
    };
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
