'use strict';

(function() {

  const rpc = window.mv3Rpc;
  const root = document.getElementById('app-root');
  const REDACTED_PASSWORD = '***';
  const LEGACY_MIGRATION_FIELDS = Object.freeze([
    {
      key: 'currentPacProviderKey',
      labelKey: 'popupPacProvider',
    },
    {
      key: 'pacUpdatePeriodInMinutes',
      labelKey: 'optionsPacUpdatePeriod',
    },
    {
      key: 'pacMods',
      labelKey: 'optionsPacModifiers',
    },
    {
      key: 'notificationPrefs',
      labelKey: 'optionsNotificationPrefs',
    },
  ]);
  let latestLegacyMigrationPlan = null;

  function t(key, substitutions) {

    return window.mv3I18n ?
      window.mv3I18n.t(key, substitutions) :
      chrome.i18n.getMessage(key, substitutions) || key;

  }

  function append(parent, tagName, className) {

    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    parent.appendChild(node);
    return node;

  }

  function appendText(parent, tagName, text, className) {

    const node = append(parent, tagName, className);
    node.textContent = text;
    return node;

  }

  function getSelectedProviderKey(form) {

    const selected = form.querySelector('input[name="provider"]:checked');
    return selected && selected.value ? selected.value : null;

  }

  function setButtonBusy(button, ifBusy) {

    button.disabled = ifBusy;
    button.textContent = ifBusy ? button.dataset.busyText : button.dataset.idleText;

  }

  function formatValue(value) {

    if (value === null || value === undefined || value === '') {
      return t('optionsNone');
    }
    return String(value);

  }

  function localizeStatusValue(value) {

    const status = String(value || 'idle');
    const keys = {
      idle: 'optionsStatusIdle',
      downloading: 'optionsStatusDownloading',
      success: 'optionsStatusSuccess',
      error: 'optionsStatusError',
      not_modified: 'optionsStatusNotModified',
      cooking: 'optionsStatusCooking',
      applying: 'optionsStatusApplying',
      applied: 'popupApplied',
      clearing: 'optionsStatusClearing',
      cleared: 'optionsStatusCleared',
      scheduled: 'optionsStatusScheduled',
      running: 'optionsStatusRunning',
      skipped: 'optionsStatusSkipped',
    };
    return keys[status] ? t(keys[status]) : status;

  }

  function appendDefinition(list, label, value) {

    appendText(list, 'dt', label);
    appendText(list, 'dd', formatValue(value));

  }

  function formatTime(value) {

    if (!value) {
      return t('optionsNone');
    }
    return new Date(value).toLocaleString();

  }

  function localizeWarning(message) {

    const text = String(message || '');
    if (text === 'No proxy is enabled. Enable Tor, WARP, or an own proxy.') {
      return t('popupNoProxyCandidate');
    }
    if (text.includes('host-pattern matching')) {
      return t('optionsMv2RulesWarning');
    }
    if (text.includes('no proxy candidates are enabled')) {
      return t('optionsProxyRuleNoCandidate');
    }
    if (text.includes('credentials are removed from cooked PAC')) {
      return t('optionsCredentialsRedactedWarning');
    }
    if (text.includes('Tor itself must be running locally')) {
      return t('optionsTorMustRunWarning');
    }
    if (text.includes('WARP is treated')) {
      return t('optionsWarpLocalProxyWarning');
    }
    if (text.includes('replaceDirectWithProxy is enabled')) {
      return t('optionsDirectReplacementNoCandidateWarning');
    }
    if (text.includes('PAC provider proxies are disabled')) {
      return t('optionsNoPacOrOwnProxyWarning');
    }
    return text;

  }

  function localizeOperationError(error) {

    if (error && error.code === 'PROXY_RULE_NO_CANDIDATE') {
      return t('popupNoProxyCandidate');
    }
    return error && error.message || t('optionsStatusError');

  }

  function clone(value) {

    return JSON.parse(JSON.stringify(value));

  }

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  async function refresh(message, ifError) {

    try {
      const snapshot = await rpc.callBackground('getState');
      await window.mv3I18n.init(snapshot.state && snapshot.state.uiLanguage);
      render(snapshot, message, ifError);
    } catch (err) {
      renderError(err);
    }

  }

  function render(snapshot, message, ifError) {

    const state = snapshot.state;
    root.replaceChildren();
    document.title = t('popupTitle');

    appendText(root, 'h1', t('popupTitle'));
    appendText(
        root,
        'p',
        t('optionsIntro'),
        'notice',
    );

    if (message) {
      appendText(root, 'p', message, ifError ? 'status error' : 'status');
    }

    renderGeneralSection(root, state);
    renderQuickStartSection(root, snapshot);
    renderReliabilitySection(root, snapshot);
    renderPacProvidersSection(root, state, snapshot.providers || []);
    renderSiteRulesSection(root, state.pacMods, snapshot.stale);
    renderLocalProxySection(root, state.pacMods);
    renderAdvancedPacRulesSection(root, state.pacMods);
    renderAboutSection(root);
    renderDebugDiagnosticsSection(root, snapshot);
    renderMaintenanceSection(root, snapshot);
    renderFooter(root);

  }

  function renderQuickStartSection(parent, snapshot) {

    const state = snapshot.state;
    const staleInfo = snapshot.stale && snapshot.stale.cookedPac;
    const proxySnapshot = snapshot.proxy || {};
    const proxyApply = proxySnapshot.proxyApply || state.proxyApply;
    const section = append(parent, 'section', 'panel primary-panel');
    appendText(section, 'h2', t('optionsQuickStart'));
    appendText(
        section,
        'p',
        t('optionsQuickStartHint'),
        'notice',
    );

    const statusGrid = append(section, 'div', 'status-grid');
    appendStatusItem(
        statusGrid,
        t('popupPacProvider'),
        getProviderLabelByKey(state.currentPacProviderKey, snapshot.providers || []),
    );
    appendStatusItem(statusGrid, t('optionsPacDownloaded'), state.pacCache.rawPacSha256 ?
      t('optionsYes') : t('optionsNo'));
    appendStatusItem(statusGrid, t('optionsPacCooked'), state.cookedPacCache.cookedPacSha256 ?
      t('optionsYes') : t('optionsNo'));
    appendStatusItem(
        statusGrid,
        t('optionsProxyStatus'),
        localizeStatusValue(proxyApply.status || 'idle'),
    );
    appendStatusItem(statusGrid, t('optionsPacSettingsChanged'), staleInfo && staleInfo.stale ?
      t('optionsYes') : t('optionsNo'));

    renderProviderPicker(section, state, snapshot.providers || []);
    renderQuickActionButtons(section, state, staleInfo);

    if (state.pacCook.warnings && state.pacCook.warnings.length) {
      appendText(
          section,
          'p',
          state.pacCook.warnings.map(localizeWarning).join(' '),
          'status warning',
      );
    }
    if (staleInfo && staleInfo.stale) {
      appendText(
          section,
          'p',
          t('optionsPacChangedCookApply'),
          'status warning',
      );
    }

  }

  function appendStatusItem(parent, label, value) {

    const item = append(parent, 'div', 'status-item');
    appendText(item, 'span', label, 'status-label');
    appendText(item, 'strong', formatValue(value));

  }

  function renderReliabilitySection(parent, snapshot) {

    const reliability = snapshot.reliability || {};
    const autoUpdate = reliability.autoUpdate || {};
    const proxyHealth = reliability.proxyHealth || {};
    const section = append(parent, 'section', 'panel reliability-panel');
    appendText(section, 'h2', t('optionsReliability'));
    appendText(section, 'p', t('optionsReliabilityHint'), 'notice');

    const enabledLabel = append(section, 'label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = autoUpdate.enabled === true;
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(document.createTextNode(
        ` ${t('optionsAutoUpdateEveryTwelveHours')}`,
    ));
    enabledInput.onchange = async () => {
      enabledInput.disabled = true;
      try {
        await rpc.callBackground('setPeriodicUpdateEnabled', {
          enabled: enabledInput.checked,
        });
        await refresh(t('optionsPeriodicSettingsSaved'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const statusGrid = append(section, 'div', 'status-grid');
    appendStatusItem(
        statusGrid,
        t('optionsLastSuccessfulPacUpdate'),
        formatTime(autoUpdate.lastSuccessfulUpdateAt),
    );
    appendStatusItem(
        statusGrid,
        t('optionsNextAutomaticPacUpdate'),
        autoUpdate.enabled ?
          formatTime(autoUpdate.nextUpdateAt) :
          t('optionsDisabled'),
    );
    appendStatusItem(
        statusGrid,
        t('popupProxyHealth'),
        localizeProxyHealthStatus(proxyHealth.status),
    );

    if (autoUpdate.error) {
      appendText(section, 'p', t('popupPacUpdateFailed'), 'status warning');
    }
    if (proxyHealth.status === 'error') {
      const error = appendText(
          section,
          'p',
          getLocalizedProxyHealthError(proxyHealth),
          'status error',
      );
      error.title = proxyHealth.lastErrorCode || '';
    }
    const checkButton = append(section, 'button');
    checkButton.type = 'button';
    checkButton.dataset.idleText = proxyHealth.status === 'error' ?
      t('popupCheckProxyAgain') :
      t('popupCheckProxy');
    checkButton.dataset.busyText = t('popupProxyHealthChecking');
    checkButton.textContent = checkButton.dataset.idleText;
    checkButton.onclick = async () => {
      setButtonBusy(checkButton, true);
      try {
        const result = await rpc.callBackground('checkProxyHealth', {});
        await refresh(localizeProxyCheckResult(result), result.status !== 'ok');
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function localizeProxyHealthStatus(status) {

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

  function getLocalizedProxyHealthError(proxyHealth) {

    if (proxyHealth.candidateType === 'torBrowser') {
      return t('proxyHealthTorBrowserError');
    }
    if (proxyHealth.candidateType === 'localTor') {
      return t('proxyHealthLocalTorError');
    }
    return t('proxyHealthGenericError');

  }

  function localizeProxyCheckResult(result) {

    if (result.status === 'ok') {
      return t('popupProxyCheckSucceeded');
    }
    if (result.status === 'error') {
      return getLocalizedProxyHealthError(result.proxyHealth || {});
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

  function renderGeneralSection(parent, state) {

    const details = append(parent, 'details', 'panel');
    appendText(details, 'summary', t('optionsGeneral'));
    appendText(details, 'p', t('optionsLanguageReloadNote'), 'notice');
    const label = append(details, 'label', 'field-row');
    appendText(label, 'span', t('optionsLanguage'));
    const select = append(label, 'select');
    [
      ['auto', t('optionsLanguageAuto')],
      ['ru', t('optionsLanguageRu')],
      ['en', t('optionsLanguageEn')],
    ].forEach(([value, labelText]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = labelText;
      select.appendChild(option);
    });
    select.value = state.uiLanguage || 'auto';
    select.onchange = async () => {
      await rpc.callBackground('setUiLanguage', {language: select.value});
      window.location.reload();
    };

  }

  function getProviderLabelByKey(providerKey, providers) {

    if (!providerKey) {
      return t('popupNotSelected');
    }
    const provider = providers.find((item) => item.key === providerKey);
    return provider ? getProviderLabel(provider) : providerKey;

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

  function getProviderDescription(provider) {

    if (provider.key === 'Антизапрет') {
      return t('providerAntizapretDescription');
    }
    if (provider.key === 'Антицензорити') {
      return t('providerAnticensorityDescription');
    }
    if (provider.key === 'onlyOwnSites') {
      return t('providerOnlyOwnSitesDescription');
    }
    return provider.description || '';

  }

  function renderProviderPicker(parent, state, providers) {

    const details = append(parent, 'details', 'provider-picker');
    appendText(details, 'summary', t('optionsChangePacProvider'));
    const form = append(details, 'form');
    const noneLabel = append(form, 'label', 'provider');
    const noneInput = document.createElement('input');
    noneInput.type = 'radio';
    noneInput.name = 'provider';
    noneInput.value = '';
    noneInput.checked = state.currentPacProviderKey === null;
    noneLabel.appendChild(noneInput);
    noneLabel.appendChild(document.createTextNode(` ${t('optionsNoProviderSelected')}`));

    providers.filter((provider) => provider.enabled !== false)
        .forEach((provider) => {
          const label = append(form, 'label', 'provider');
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = 'provider';
          input.value = provider.key;
          input.checked = state.currentPacProviderKey === provider.key;
          label.appendChild(input);
          label.appendChild(document.createTextNode(
              ` ${getProviderLabel(provider)}`,
          ));
          appendText(
              label,
              'span',
              getProviderDescription(provider),
              'provider-description',
          );
        });

    const saveButton = append(form, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = t('optionsSaveProvider');
    saveButton.dataset.busyText = t('optionsSaving');
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground(
            'setCurrentPacProvider',
            {providerKey: getSelectedProviderKey(form)},
        );
        await refresh(t('optionsPacProviderSaved'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function renderPacProvidersSection(parent, state, providers) {

    const section = append(parent, 'section', 'panel');
    appendText(section, 'h2', t('optionsPacProviders'));
    appendText(section, 'p', t('optionsPacProvidersHint'), 'notice');
    appendText(
        section,
        'p',
        t('optionsSelectedProviderValue', [
          getProviderLabelByKey(state.currentPacProviderKey, providers),
        ]),
        'provider-selected-status',
    );

    appendText(section, 'h3', t('optionsBuiltInProviders'));
    const builtInList = append(section, 'div', 'provider-management-list');
    providers.filter((provider) => provider.type === 'builtIn')
        .forEach((provider) => {
          renderBuiltInProviderRow(builtInList, state, provider);
        });

    appendText(section, 'h3', t('optionsCustomProviders'));
    const customProviders = providers.filter((provider) =>
      provider.type === 'custom',
    );
    if (!customProviders.length) {
      appendText(section, 'p', t('optionsNoCustomProviders'), 'notice');
    } else {
      const customList = append(section, 'div', 'provider-management-list');
      customProviders.forEach((provider) => {
        renderCustomProviderEditor(customList, state, provider);
      });
    }
    renderAddCustomProviderForm(section);

  }

  function renderBuiltInProviderRow(parent, state, provider) {

    const row = append(parent, 'div', 'provider-management-row');
    const header = append(row, 'div', 'provider-management-header');
    appendText(header, 'strong', getProviderLabel(provider));
    appendText(header, 'span', t('optionsReadOnlyProvider'), 'provider-badge');
    appendText(row, 'p', getProviderDescription(provider), 'provider-description');
    renderProviderUrls(row, provider.urls);
    appendSelectProviderButton(row, state, provider);

  }

  function renderCustomProviderEditor(parent, state, provider) {

    const details = append(parent, 'details', 'provider-management-row provider-editor');
    const summary = append(details, 'summary', 'provider-management-header');
    appendText(summary, 'strong', provider.label);
    appendText(
        summary,
        'span',
        `${provider.enabled ? t('optionsEnabled') : t('optionsDisabled')} · ` +
          t('optionsEditCustomProvider'),
        'provider-badge',
    );
    const form = append(details, 'form', 'provider-form');
    form.onsubmit = (event) => event.preventDefault();
    const labelInput = appendTextInput(
        form,
        `provider.${provider.key}.label`,
        t('optionsProviderName'),
        provider.label,
    );
    const descriptionInput = appendTextInput(
        form,
        `provider.${provider.key}.description`,
        t('optionsProviderDescription'),
        provider.description,
    );
    const urlsInput = appendTextareaInput(
        form,
        `provider.${provider.key}.urls`,
        t('optionsPacUrls'),
        provider.urls.join('\n'),
    );
    appendText(form, 'p', t('optionsPacUrlsHint'), 'note');
    const enabledInput = appendCheckbox(
        form,
        `provider.${provider.key}.enabled`,
        t('optionsCustomProviderEnabled'),
        provider.enabled,
    );
    const actions = append(form, 'div', 'provider-actions');
    const updateButton = append(actions, 'button');
    updateButton.type = 'button';
    updateButton.dataset.idleText = t('optionsUpdateCustomProvider');
    updateButton.dataset.busyText = t('optionsSaving');
    updateButton.textContent = updateButton.dataset.idleText;
    updateButton.onclick = async () => {
      setButtonBusy(updateButton, true);
      try {
        const result = await rpc.callBackground('updateCustomPacProvider', {
          key: provider.key,
          label: labelInput.value,
          description: descriptionInput.value,
          urls: splitProviderUrls(urlsInput.value),
          enabled: enabledInput.checked,
        });
        const message = result.selectedProviderCleared ?
          t('optionsSelectedProviderCleared') :
          result.cacheMetadataCleared ?
            t('optionsCustomProviderUpdatedRefresh') :
            t('optionsCustomProviderUpdated');
        await refresh(message);
      } catch (err) {
        await refresh(localizeProviderError(err), true);
      }
    };
    appendSelectProviderButton(actions, state, provider);
    const deleteButton = append(actions, 'button');
    deleteButton.type = 'button';
    deleteButton.className = 'danger';
    deleteButton.dataset.idleText = t('optionsDeleteCustomProvider');
    deleteButton.dataset.busyText = t('optionsDeleting');
    deleteButton.textContent = deleteButton.dataset.idleText;
    deleteButton.onclick = async () => {
      if (!window.confirm(t('optionsConfirmDeleteCustomProvider', [provider.label]))) {
        return;
      }
      setButtonBusy(deleteButton, true);
      try {
        const result = await rpc.callBackground('deleteCustomPacProvider', {
          key: provider.key,
        });
        await refresh(
            result.selectedProviderCleared ?
              t('optionsSelectedProviderDeleted') :
              t('optionsCustomProviderDeleted'),
        );
      } catch (err) {
        await refresh(localizeProviderError(err), true);
      }
    };

  }

  function renderAddCustomProviderForm(parent) {

    const details = append(parent, 'details', 'provider-add-form');
    appendText(details, 'summary', t('optionsAddCustomProvider'));
    const form = append(details, 'form', 'provider-form');
    form.onsubmit = (event) => event.preventDefault();
    const labelInput = appendTextInput(
        form,
        'newProvider.label',
        t('optionsProviderName'),
        '',
    );
    const descriptionInput = appendTextInput(
        form,
        'newProvider.description',
        t('optionsProviderDescription'),
        '',
    );
    const urlsInput = appendTextareaInput(
        form,
        'newProvider.urls',
        t('optionsPacUrls'),
        '',
    );
    urlsInput.placeholder = 'https://example.com/proxy.pac';
    appendText(form, 'p', t('optionsPacUrlsHint'), 'note');
    appendText(form, 'p', t('optionsProviderDuplicateUrls'), 'note');
    const addButton = append(form, 'button');
    addButton.type = 'button';
    addButton.dataset.idleText = t('optionsAddCustomProvider');
    addButton.dataset.busyText = t('optionsAdding');
    addButton.textContent = addButton.dataset.idleText;
    addButton.onclick = async () => {
      setButtonBusy(addButton, true);
      try {
        await rpc.callBackground('addCustomPacProvider', {
          label: labelInput.value,
          description: descriptionInput.value,
          urls: splitProviderUrls(urlsInput.value),
        });
        await refresh(t('optionsCustomProviderAdded'));
      } catch (err) {
        await refresh(localizeProviderError(err), true);
      }
    };

  }

  function renderProviderUrls(parent, urls) {

    const list = append(parent, 'ul', 'provider-url-list');
    (urls || []).forEach((url) => {
      appendText(list, 'li', url);
    });

  }

  function appendSelectProviderButton(parent, state, provider) {

    const button = append(parent, 'button');
    button.type = 'button';
    const ifSelected = state.currentPacProviderKey === provider.key;
    button.dataset.idleText = ifSelected ?
      t('optionsSelected') :
      t('optionsSelectProvider');
    button.dataset.busyText = t('optionsSaving');
    button.textContent = button.dataset.idleText;
    button.disabled = ifSelected || provider.enabled === false;
    button.onclick = async () => {
      setButtonBusy(button, true);
      try {
        await rpc.callBackground('setCurrentPacProvider', {
          providerKey: provider.key,
        });
        await refresh(t('optionsPacProviderSaved'));
      } catch (err) {
        await refresh(localizeProviderError(err), true);
      }
    };
    return button;

  }

  function splitProviderUrls(value) {

    return String(value || '').split(/\r?\n/g)
        .map((url) => url.trim())
        .filter(Boolean);

  }

  function localizeProviderError(error) {

    const messages = {
      CUSTOM_PROVIDER_LABEL_REQUIRED: 'optionsProviderLabelRequired',
      CUSTOM_PROVIDER_LABEL_TOO_LONG: 'optionsProviderLabelTooLong',
      CUSTOM_PROVIDER_DESCRIPTION_TOO_LONG: 'optionsProviderDescriptionTooLong',
      CUSTOM_PROVIDER_URL_REQUIRED: 'optionsProviderUrlRequired',
      CUSTOM_PROVIDER_URL_INVALID: 'optionsProviderInvalidUrl',
      CUSTOM_PROVIDER_URL_SCHEME: 'optionsProviderInvalidScheme',
      CUSTOM_PROVIDER_URL_CREDENTIALS: 'optionsProviderUrlCredentials',
      CUSTOM_PROVIDER_TOO_MANY_URLS: 'optionsProviderTooManyUrls',
      CUSTOM_PROVIDER_NOT_FOUND: 'optionsProviderNotFound',
      BUILT_IN_PROVIDER_READ_ONLY: 'optionsProviderBuiltInReadOnly',
    };
    const key = error && messages[error.code];
    return key ? t(key) : error && error.message || t('popupOperationFailed');

  }

  function renderQuickActionButtons(parent, state, staleInfo) {

    const actions = append(parent, 'div', 'quick-actions');
    appendActionButton(actions, t('optionsDownloadPac'), t('optionsDownloading'), async () => {
      const result = await rpc.callBackground('downloadPac', {});
      if (result.ok === false) {
        throw new Error(result.error.message);
      }
      return t('optionsPacDownloadStatus', [localizeStatusValue(result.status)]);
    });
    appendActionButton(actions, t('optionsCookPac'), t('optionsCooking'), async () => {
      const result = await rpc.callBackground('cookPac', {});
      if (result.ok === false) {
        throw new Error(localizeOperationError(result.error));
      }
      return t('optionsPacCookedApplyNow');
    }, t('optionsCookPacHelp'));
    const applyButton = appendActionButton(
        actions,
        t('optionsApplyProxy'),
        t('optionsApplying'),
        async () => {
          const result = await rpc.callBackground('applyCookedPac', {});
          if (result.ok === false) {
            throw new Error(result.error.message);
          }
          return t('optionsProxyApplyStatus', [localizeStatusValue(result.status)]);
        },
        t('optionsApplyProxyHelp'),
    );
    applyButton.disabled = !state.cookedPacCache.cookedPacSha256 ||
      Boolean(staleInfo && staleInfo.stale);
    appendActionButton(actions, t('popupClearProxy'), t('popupClearing'), async () => {
      const result = await rpc.callBackground('clearProxy', {});
      if (result.ok === false) {
        throw new Error(result.error.message);
      }
      return t('optionsProxyClearStatus', [localizeStatusValue(result.status)]);
    });

  }

  function appendActionButton(parent, idleText, busyText, action, title) {

    const button = append(parent, 'button');
    button.type = 'button';
    button.dataset.idleText = idleText;
    button.dataset.busyText = busyText;
    button.textContent = idleText;
    if (title) {
      button.title = title;
    }
    button.onclick = async () => {
      setButtonBusy(button, true);
      try {
        await refresh(await action());
      } catch (err) {
        await refresh(err.message, true);
      }
    };
    return button;

  }

  function renderSiteRulesSection(parent, pacMods, staleSnapshot) {

    const section = append(parent, 'section', 'panel');
    appendText(section, 'h2', t('optionsAddSiteRule'));
    appendText(
        section,
        'p',
        t('optionsAddSiteRuleHint'),
    );
    appendText(
        section,
        'p',
        t('optionsToolbarTip'),
        'notice',
    );

    const form = append(section, 'form', 'site-rule-form');
    const siteInput = appendTextInput(
        form,
        'siteRule.pattern',
        t('optionsSite'),
        '',
    );
    siteInput.placeholder = 'example.com, https://example.com/path, *.example.com';
    const noteInput = appendTextInput(form, 'siteRule.note', t('optionsNote'), '');
    noteInput.placeholder = t('optionsOptional');
    const addProxyButton = append(form, 'button');
    addProxyButton.type = 'button';
    addProxyButton.dataset.idleText = t('optionsAddProxyRule');
    addProxyButton.dataset.busyText = t('optionsAdding');
    addProxyButton.textContent = addProxyButton.dataset.idleText;
    const addDirectButton = append(form, 'button');
    addDirectButton.type = 'button';
    addDirectButton.dataset.idleText = t('optionsAddDirectRule');
    addDirectButton.dataset.busyText = t('optionsAdding');
    addDirectButton.textContent = addDirectButton.dataset.idleText;
    addProxyButton.onclick = () => addSiteRuleFromForm(
        addProxyButton,
        pacMods,
        siteInput,
        noteInput,
        'PROXY',
    );
    addDirectButton.onclick = () => addSiteRuleFromForm(
        addDirectButton,
        pacMods,
        siteInput,
        noteInput,
        'DIRECT',
    );

    if (hasProxySiteRules(pacMods) && !getProxyRuleCandidateCount(pacMods)) {
      appendText(
          section,
          'p',
          t('optionsProxyRuleNoCandidate'),
          'status warning',
      );
    }

    renderSiteRules(section, pacMods, staleSnapshot);

  }

  async function addSiteRuleFromForm(button, pacMods, siteInput, noteInput, action) {

    setButtonBusy(button, true);
    try {
      const pattern = normalizeSiteRuleInput(siteInput.value);
      await addSiteRule({
        pacMods,
        pattern,
        action,
        note: noteInput.value.trim(),
      });
      await refresh(t('optionsPacChangedCookApply'));
    } catch (err) {
      await refresh(err.message, true);
    }

  }

  function renderSiteRules(parent, pacMods, staleSnapshot) {

    appendText(parent, 'h3', t('optionsSiteRules'));
    const rules = getSiteRules(pacMods);
    if (!rules.length) {
      appendText(parent, 'p', t('optionsNoSiteRules'));
      return;
    }
    const list = append(parent, 'div', 'site-rule-list');
    rules.forEach((rule, index) => renderSiteRuleRow(list, pacMods, rule, index));
    const staleInfo = staleSnapshot && staleSnapshot.cookedPac;
    if (staleInfo && staleInfo.stale) {
      appendText(
          parent,
          'p',
          t('optionsPacChangedCookApply'),
          'status warning',
      );
    }

  }

  function renderSiteRuleRow(parent, pacMods, rule, index) {

    const row = append(parent, 'div', 'site-rule-row');
    const enabledLabel = append(row, 'label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = rule.enabled !== false;
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(document.createTextNode(` ${t('optionsEnabled')}`));
    appendText(row, 'span', rule.pattern, 'site-rule-pattern');
    appendText(
        row,
        'span',
        rule.action === 'PROXY' ? t('optionsProxyThisSite') : t('optionsOpenDirectly'),
        `site-rule-action ${rule.action === 'PROXY' ? 'proxy' : 'direct'}`,
    );
    appendText(row, 'span', rule.note || '', 'site-rule-note');
    enabledInput.onchange = async () => {
      try {
        await updateSiteRule(pacMods, index, {enabled: enabledInput.checked});
        await refresh(t('optionsPacChangedCookApply'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };
    const removeButton = append(row, 'button');
    removeButton.type = 'button';
    removeButton.textContent = t('optionsRemove');
    removeButton.onclick = async () => {
      try {
        await removeSiteRule(pacMods, index);
        await refresh(t('optionsPacChangedCookApply'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function renderLocalProxySection(parent, pacMods) {

    const section = append(parent, 'section', 'panel');
    appendText(section, 'h2', t('optionsLocalProxyPresets'));
    appendText(
        section,
        'p',
        t('optionsLocalProxyHint'),
    );
    appendText(
        section,
        'p',
        t('optionsPasswordNotice'),
        'notice',
    );
    appendText(section, 'p', t('optionsTorModeNote'), 'notice');
    appendText(section, 'p', t('popupTorAvailabilityNote'), 'notice');
    const form = append(section, 'form');
    renderPacProxyModeEditor(form, pacMods);
    renderTorConfigEditor(form, 'localTor', t('popupLocalTor'), pacMods.localTor);
    renderTorConfigEditor(
        form,
        'torBrowser',
        t('popupTorBrowser'),
        pacMods.torBrowser,
    );
    renderWarpEditor(form, pacMods.warp);
    renderOwnProxyEditor(form, pacMods.ownProxies || []);
    const saveButton = append(form, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = t('optionsSaveProxySettings');
    saveButton.dataset.busyText = t('optionsSaving');
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground(
            'setPacMods',
            {pacMods: collectLocalProxyPacMods(form, pacMods)},
        );
        await refresh(t('optionsPacChangedCookApply'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function renderAdvancedPacRulesSection(parent, pacMods) {

    const details = append(parent, 'details', 'panel');
    appendText(details, 'summary', t('optionsAdvancedPacRules'));
    appendText(
        details,
        'p',
        t('optionsAdvancedPacRulesHint'),
        'notice',
    );
    const form = append(details, 'form');
    renderPatternListEditor(
        form,
        'whitelist',
        t('optionsWhitelist'),
        pacMods.whitelist || [],
        false,
    );
    renderPacPolicyEditor(form, pacMods);
    const saveButton = append(form, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = t('optionsSaveAdvancedPacRules');
    saveButton.dataset.busyText = t('optionsSaving');
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground(
            'setPacMods',
            {pacMods: collectAdvancedPacRules(form, pacMods)},
        );
        await refresh(t('optionsPacChangedCookApply'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };
    renderAdvancedJsonEditor(details, pacMods);

  }

  function renderAdvancedJsonEditor(parent, pacMods) {

    const details = append(parent, 'details');
    appendText(details, 'summary', t('optionsAdvancedJsonEditor'));
    const textarea = append(details, 'textarea');
    textarea.value = JSON.stringify(redactPacModsForDisplay(pacMods), null, 2);
    const saveButton = append(details, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = t('optionsSavePacModifiersJson');
    saveButton.dataset.busyText = t('optionsSaving');
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      let nextPacMods;
      try {
        nextPacMods = JSON.parse(textarea.value);
      } catch (err) {
        await refresh(t('optionsPacJsonInvalid'), true);
        return;
      }
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground(
            'setPacMods',
            {pacMods: restoreRedactedPacMods(nextPacMods, pacMods)},
        );
        await refresh(t('optionsPacChangedCookApply'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function renderDebugDiagnosticsSection(parent, snapshot) {

    const details = append(parent, 'details', 'panel');
    appendText(details, 'summary', t('optionsDiagnostics'));
    appendText(
        details,
        'p',
        t('optionsDiagnosticsHint'),
    );
    const state = snapshot.state;
    renderArtifactStorageSection(details, snapshot.artifactStorage);
    renderPacDownloadSection(details, state);
    renderPacCookSection(details, state, snapshot.stale && snapshot.stale.cookedPac);
    renderProxySection(details, state, snapshot.proxy);
    renderProxyAuthSection(details, snapshot.proxyAuth);
    renderPeriodicUpdateSection(details, snapshot.periodicUpdate);
    renderNotificationSection(details, state.notificationPrefs);
    appendText(details, 'h2', t('optionsRcStatus'));
    appendText(details, 'p', snapshot.status);

  }

  function renderAboutSection(parent) {

    const details = append(parent, 'details', 'panel');
    appendText(details, 'summary', t('optionsAbout'));
    appendText(details, 'p', t('optionsAboutHint'), 'notice');
    appendText(details, 'h3', t('optionsLimitations'));
    const list = append(details, 'ul');
    [
      'optionsLimitationDns',
      'optionsLimitationRawReplaceDirect',
      'optionsLimitationSecureFiltering',
      'optionsLimitationWeightedRules',
      'optionsLimitationExternalProxyQa',
      'optionsLimitationTorQa',
    ].forEach((key) => {
      appendText(list, 'li', t(key));
    });
    appendText(details, 'h3', t('optionsRestoredMv2Behavior'));
    const restoredList = append(details, 'ul');
    [
      'optionsRestoredPacProxySwitch',
      'optionsRestoredOwnSitesOnly',
      'optionsRestoredOnionTor',
      'optionsRestoredDirectPolicy',
    ].forEach((key) => {
      appendText(restoredList, 'li', t(key));
    });

  }

  function renderMaintenanceSection(parent, snapshot) {

    const details = append(parent, 'details', 'panel');
    appendText(details, 'summary', t('optionsMaintenance'));
    appendText(details, 'p', t('optionsMaintenanceHint'), 'notice');
    const state = snapshot.state;
    renderLegacyMigrationSection(
        details,
        state.legacyMigration,
        latestLegacyMigrationPlan,
    );

  }

  function renderFooter(parent) {

    const footer = append(parent, 'footer', 'footer');
    appendText(footer, 'p', t('optionsMv3Credits'));

  }

  function renderArtifactStorageSection(parent, artifactStorage) {

    const section = append(parent, 'section');
    appendText(section, 'h2', 'PAC artifact storage');
    const list = append(section, 'dl');
    appendDefinition(list, 'Backend', artifactStorage && artifactStorage.backend);
    appendDefinition(list, 'Database', artifactStorage && artifactStorage.dbName);
    appendDefinition(
        list,
        'Schema',
        artifactStorage && artifactStorage.schemaVersion,
    );

  }

  function normalizeSiteRuleInput(value) {

    const input = String(value || '').trim();
    if (!input) {
      throw new Error(t('optionsEnterSite'));
    }
    if (/^[*]\.[a-z0-9.-]+$/i.test(input)) {
      return input.toLowerCase();
    }

    let host = input;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
        host = new URL(input).hostname;
      } else if (input.includes('/')) {
        host = new URL(`https://${input}`).hostname;
      }
    } catch (err) {
      throw new Error(t('optionsEnterValidSite'));
    }

    host = String(host || '')
        .trim()
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
    if (
      !host ||
      host.includes('/') ||
      host.includes(' ') ||
      !/^[a-z0-9.-]+$/i.test(host) ||
      host.startsWith('.') ||
      host.endsWith('.')
    ) {
      throw new Error(t('optionsEnterValidSite'));
    }
    return host;

  }

  function getSiteRules(pacMods) {

    return Array.isArray(pacMods && pacMods.exceptions) ?
      pacMods.exceptions :
      [];

  }

  function createPacModsPatch(pacMods, patch) {

    return Object.assign({}, clone(pacMods), patch);

  }

  async function savePacModsPatch(pacMods, patch) {

    await rpc.callBackground('setPacMods', {
      pacMods: createPacModsPatch(pacMods, patch),
    });

  }

  async function addSiteRule({pacMods, pattern, action, note}) {

    const rules = getSiteRules(pacMods).slice();
    const normalizedAction = String(action || '').toUpperCase();
    if (!['PROXY', 'DIRECT'].includes(normalizedAction)) {
      throw new Error(t('optionsUnsupportedSiteRuleAction'));
    }
    const duplicate = rules.some((rule) =>
      String(rule.pattern || '').toLowerCase() === pattern.toLowerCase(),
    );
    if (duplicate) {
      throw new Error(t('optionsDuplicateSiteRule'));
    }
    rules.push({
      pattern,
      action: normalizedAction,
      enabled: true,
      note: note || '',
    });
    await savePacModsPatch(pacMods, {exceptions: rules});

  }

  async function updateSiteRule(pacMods, index, patch) {

    const rules = getSiteRules(pacMods).slice();
    if (!rules[index]) {
      throw new Error(t('optionsSiteRuleNotFound'));
    }
    rules[index] = Object.assign({}, rules[index], patch);
    await savePacModsPatch(pacMods, {exceptions: rules});

  }

  async function removeSiteRule(pacMods, index) {

    const rules = getSiteRules(pacMods).slice();
    if (!rules[index]) {
      throw new Error(t('optionsSiteRuleNotFound'));
    }
    rules.splice(index, 1);
    await savePacModsPatch(pacMods, {exceptions: rules});

  }

  function getProxyRuleCandidateCount(pacMods) {

    const mods = pacMods || {};
    const ownProxyCount = Array.isArray(mods.ownProxies) ?
      mods.ownProxies.filter((proxy) =>
        proxy &&
        proxy.enabled !== false &&
        proxy.host &&
        proxy.port,
      ).length :
      0;
    const localTorCount = isObject(mods.localTor) &&
      mods.localTor.enabled === true ? 1 : 0;
    const torBrowserCount = isObject(mods.torBrowser) &&
      mods.torBrowser.enabled === true ? 1 : 0;
    const warpCount = isObject(mods.warp) && mods.warp.enabled === true &&
      String(mods.warp.proxyString || '').trim() ? 1 : 0;
    return ownProxyCount + localTorCount + torBrowserCount + warpCount;

  }

  function hasProxySiteRules(pacMods) {

    return getSiteRules(pacMods).some((rule) =>
      rule &&
      rule.enabled !== false &&
      rule.action === 'PROXY',
    );

  }

  function renderPacDownloadSection(parent, state) {

    const section = append(parent, 'section');
    appendText(section, 'h2', 'PAC download cache');

    const downloadButton = append(section, 'button');
    downloadButton.type = 'button';
    downloadButton.dataset.idleText = 'Download PAC';
    downloadButton.dataset.busyText = 'Downloading...';
    downloadButton.textContent = downloadButton.dataset.idleText;
    downloadButton.onclick = async () => {
      setButtonBusy(downloadButton, true);
      try {
        const result = await rpc.callBackground('downloadPac', {});
        if (result.ok === false) {
          await refresh(`PAC download failed: ${result.error.message}`, true);
          return;
        }
        await refresh(`PAC download status: ${result.status}.`);
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const clearButton = append(section, 'button');
    clearButton.type = 'button';
    clearButton.dataset.idleText = 'Clear PAC cache';
    clearButton.dataset.busyText = 'Clearing...';
    clearButton.textContent = clearButton.dataset.idleText;
    clearButton.onclick = async () => {
      setButtonBusy(clearButton, true);
      try {
        const result = await rpc.callBackground('clearPacCache', {});
        if (result.ok === false) {
          await refresh(`PAC cache clear failed: ${result.error.message}`, true);
          return;
        }
        await refresh('PAC cache cleared.');
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    renderPacDownloadDetails(section, state.pacDownload);
    renderPacCacheMetadata(section, state.pacCache);

  }

  function renderPacDownloadDetails(parent, pacDownload) {

    const list = append(parent, 'dl');
    appendDefinition(list, 'Status', pacDownload.status);
    appendDefinition(list, 'Provider', pacDownload.providerKey);
    appendDefinition(
        list,
        'URL',
        rpc.formatPacSourceUrlForDiagnostics(
            pacDownload.url,
            pacDownload.providerKey,
        ),
    );
    appendDefinition(list, 'HTTP status', pacDownload.httpStatus);
    appendDefinition(list, 'Content length', pacDownload.contentLength);
    appendDefinition(list, 'SHA-256', pacDownload.sha256);
    appendDefinition(list, 'Last-Modified', pacDownload.lastModified);
    appendDefinition(list, 'ETag', pacDownload.etag);
    if (pacDownload.error) {
      appendDefinition(list, 'Error', pacDownload.error.message);
    }

  }

  function renderPacCacheMetadata(parent, pacCache) {

    const details = append(parent, 'details');
    appendText(details, 'summary', 'PAC cache metadata');

    if (!pacCache.rawPacSha256) {
      appendText(details, 'p', 'No PAC data cached.');
      return;
    }

    const list = append(details, 'dl');
    appendDefinition(list, 'Artifact', pacCache.artifactRef);
    appendDefinition(list, 'Artifact present', pacCache.artifactRef ? 'yes' : 'no');
    appendDefinition(list, 'Raw PAC size', pacCache.rawPacSize);
    appendDefinition(list, 'SHA-256', pacCache.rawPacSha256);
    appendDefinition(
        list,
        'URL',
        rpc.formatPacSourceUrlForDiagnostics(pacCache.url, pacCache.providerKey),
    );

  }

  function renderPacCookSection(parent, state, staleInfo) {

    const section = append(parent, 'section');
    appendText(section, 'h2', 'PAC cooking cache');

    const cookButton = append(section, 'button');
    cookButton.type = 'button';
    cookButton.dataset.idleText = 'Cook PAC';
    cookButton.dataset.busyText = 'Cooking...';
    cookButton.textContent = cookButton.dataset.idleText;
    cookButton.onclick = async () => {
      setButtonBusy(cookButton, true);
      try {
        const result = await rpc.callBackground('cookPac', {});
        if (result.ok === false) {
          await refresh(`PAC cooking failed: ${result.error.message}`, true);
          return;
        }
        await refresh(`PAC cooking status: ${result.status}.`);
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const clearButton = append(section, 'button');
    clearButton.type = 'button';
    clearButton.dataset.idleText = 'Clear cooked PAC cache';
    clearButton.dataset.busyText = 'Clearing...';
    clearButton.textContent = clearButton.dataset.idleText;
    clearButton.onclick = async () => {
      setButtonBusy(clearButton, true);
      try {
        const result = await rpc.callBackground('clearCookedPacCache', {});
        if (result.ok === false) {
          await refresh(
              `Cooked PAC cache clear failed: ${result.error.message}`,
              true,
          );
          return;
        }
        await refresh('Cooked PAC cache cleared.');
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    if (staleInfo && staleInfo.stale) {
      appendText(
          section,
          'p',
          `Cooked PAC cache is stale: ${staleInfo.reasons.join(', ')}.`,
          'status error',
      );
    }

    renderPacCookDetails(section, state.pacCook);
    renderCookedPacCacheMetadata(section, state.cookedPacCache);

  }

  function renderPacCookDetails(parent, pacCook) {

    const list = append(parent, 'dl');
    appendDefinition(list, 'Status', pacCook.status);
    appendDefinition(list, 'Provider', pacCook.providerKey);
    appendDefinition(list, 'Source raw SHA-256', pacCook.sourceRawPacSha256);
    appendDefinition(list, 'PAC mods SHA-256', pacCook.pacModsSha256);
    appendDefinition(list, 'Cooked SHA-256', pacCook.cookedPacSha256);
    appendDefinition(list, 'Cooked content length', pacCook.cookedContentLength);
    if (pacCook.warnings && pacCook.warnings.length) {
      appendDefinition(list, 'Warnings', pacCook.warnings.join('; '));
    }
    if (pacCook.error) {
      appendDefinition(list, 'Error', pacCook.error.message);
    }

  }

  function renderCookedPacCacheMetadata(parent, cookedPacCache) {

    const details = append(parent, 'details');
    appendText(details, 'summary', 'Cooked PAC metadata');

    if (!cookedPacCache.cookedPacSha256) {
      appendText(details, 'p', 'No cooked PAC data cached.');
      return;
    }

    const list = append(details, 'dl');
    appendDefinition(list, 'Artifact', cookedPacCache.artifactRef);
    appendDefinition(
        list,
        'Artifact present',
        cookedPacCache.artifactRef ? 'yes' : 'no',
    );
    appendDefinition(list, 'Cooked PAC size', cookedPacCache.cookedPacSize);
    appendDefinition(list, 'Cooked SHA-256', cookedPacCache.cookedPacSha256);
    appendDefinition(list, 'Provider', cookedPacCache.providerKey);

  }

  function renderProxySection(parent, state, proxySnapshot) {

    const section = append(parent, 'section');
    appendText(section, 'h2', 'Proxy application');

    const proxyControl = proxySnapshot && proxySnapshot.proxyControl ||
      state.proxyControl;
    const proxyApply = proxySnapshot && proxySnapshot.proxyApply ||
      state.proxyApply;
    const staleInfo = proxySnapshot && proxySnapshot.stale &&
      proxySnapshot.stale.cookedPac;

    const refreshButton = append(section, 'button');
    refreshButton.type = 'button';
    refreshButton.dataset.idleText = 'Refresh proxy control';
    refreshButton.dataset.busyText = 'Refreshing...';
    refreshButton.textContent = refreshButton.dataset.idleText;
    refreshButton.onclick = async () => {
      setButtonBusy(refreshButton, true);
      try {
        await rpc.callBackground('refreshProxyControl', {});
        await refresh('Proxy control refreshed.');
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const applyButton = append(section, 'button');
    applyButton.type = 'button';
    applyButton.dataset.idleText = 'Apply cooked PAC';
    applyButton.dataset.busyText = 'Applying...';
    applyButton.textContent = applyButton.dataset.idleText;
    applyButton.disabled = !state.cookedPacCache.cookedPacSha256 ||
      Boolean(staleInfo && staleInfo.stale);
    applyButton.onclick = async () => {
      setButtonBusy(applyButton, true);
      try {
        const result = await rpc.callBackground('applyCookedPac', {});
        if (result.ok === false) {
          await refresh(`Proxy apply failed: ${result.error.message}`, true);
          return;
        }
        await refresh(`Proxy apply status: ${result.status}.`);
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const clearButton = append(section, 'button');
    clearButton.type = 'button';
    clearButton.dataset.idleText = 'Clear proxy settings';
    clearButton.dataset.busyText = 'Clearing...';
    clearButton.textContent = clearButton.dataset.idleText;
    clearButton.onclick = async () => {
      setButtonBusy(clearButton, true);
      try {
        const result = await rpc.callBackground('clearProxy', {});
        if (result.ok === false) {
          await refresh(`Proxy clear failed: ${result.error.message}`, true);
          return;
        }
        await refresh(`Proxy clear status: ${result.status}.`);
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    if (!state.cookedPacCache.cookedPacSha256) {
      appendText(section, 'p', 'Cook PAC before applying proxy settings.', 'status');
    }
    if (staleInfo && staleInfo.stale) {
      appendText(
          section,
          'p',
          `Cooked PAC is stale and normal apply is disabled: ` +
          `${staleInfo.reasons.join(', ')}.`,
          'status error',
      );
    }

    renderProxyControlDetails(section, proxyControl);
    renderProxyApplyDetails(section, proxyApply);

  }

  function renderProxyControlDetails(parent, proxyControl) {

    const list = append(parent, 'dl');
    appendDefinition(list, 'Level of control', proxyControl.levelOfControl);
    appendDefinition(
        list,
        'Can control',
        proxyControl.canControl === true ? 'yes' : 'no',
    );
    appendDefinition(
        list,
        'Controlled by this extension',
        proxyControl.controlledByThisExtension === true ? 'yes' : 'no',
    );
    appendDefinition(list, 'Last checked', formatTime(proxyControl.checkedAt));
    if (proxyControl.rawValue) {
      appendDefinition(
          list,
          'Current proxy config',
          JSON.stringify(proxyControl.rawValue),
      );
    }
    if (proxyControl.error) {
      appendDefinition(list, 'Control error', proxyControl.error.message);
    }

  }

  function renderProxyApplyDetails(parent, proxyApply) {

    const list = append(parent, 'dl');
    appendDefinition(list, 'Apply status', proxyApply.status);
    appendDefinition(list, 'Provider', proxyApply.providerKey);
    appendDefinition(list, 'Applied cooked SHA-256', proxyApply.cookedPacSha256);
    appendDefinition(list, 'Applied time', formatTime(proxyApply.appliedAt));
    appendDefinition(list, 'Cleared time', formatTime(proxyApply.clearedAt));
    appendDefinition(list, 'Apply level of control', proxyApply.levelOfControl);
    if (proxyApply.warnings && proxyApply.warnings.length) {
      appendDefinition(list, 'Apply warnings', proxyApply.warnings.join('; '));
    }
    if (proxyApply.error) {
      appendDefinition(list, 'Apply error', proxyApply.error.message);
    }

  }

  function renderProxyAuthSection(parent, proxyAuth) {

    const section = append(parent, 'section');
    appendText(section, 'h2', 'Proxy authentication');

    const enabledLabel = append(section, 'label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = Boolean(proxyAuth && proxyAuth.enabled);
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(document.createTextNode(' Enable proxy auth'));

    const saveButton = append(section, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = 'Save proxy auth';
    saveButton.dataset.busyText = 'Saving...';
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground(
            'setProxyAuthEnabled',
            {enabled: enabledInput.checked},
        );
        await refresh('Proxy auth setting saved.');
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const clearButton = append(section, 'button');
    clearButton.type = 'button';
    clearButton.dataset.idleText = 'Clear proxy auth events';
    clearButton.dataset.busyText = 'Clearing...';
    clearButton.textContent = clearButton.dataset.idleText;
    clearButton.onclick = async () => {
      setButtonBusy(clearButton, true);
      try {
        await rpc.callBackground('clearProxyAuthEvents', {});
        await refresh('Proxy auth events cleared.');
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    renderProxyAuthDetails(section, proxyAuth);

  }

  function renderProxyAuthDetails(parent, proxyAuth) {

    const list = append(parent, 'dl');
    appendDefinition(list, 'Enabled', proxyAuth && proxyAuth.enabled ? 'yes' : 'no');
    appendDefinition(list, 'Status', proxyAuth && proxyAuth.status);
    appendDefinition(list, 'Last challenge', formatTime(proxyAuth && proxyAuth.lastChallengeAt));
    appendDefinition(list, 'Last provided', formatTime(proxyAuth && proxyAuth.lastProvidedAt));
    appendDefinition(
        list,
        'Configured credentials',
        proxyAuth && proxyAuth.configuredCredentials ?
          proxyAuth.configuredCredentials.count :
          0,
    );
    if (proxyAuth && proxyAuth.lastError) {
      appendDefinition(list, 'Last error', proxyAuth.lastError.message);
    }

    renderProxyAuthCredentialSummary(parent, proxyAuth);
    renderProxyAuthStats(parent, proxyAuth && proxyAuth.stats);
    renderProxyAuthEvents(parent, proxyAuth && proxyAuth.lastEvents);

  }

  function renderProxyAuthCredentialSummary(parent, proxyAuth) {

    appendText(parent, 'h3', 'Configured proxy credentials');
    const proxies = proxyAuth && proxyAuth.configuredCredentials &&
      proxyAuth.configuredCredentials.proxies || [];
    if (!proxies.length) {
      appendText(parent, 'p', 'No configured proxy credentials.');
      return;
    }
    proxies.forEach((proxy) => {
      const list = append(parent, 'dl');
      appendDefinition(list, 'Type', proxy.type);
      appendDefinition(list, 'Host', proxy.host);
      appendDefinition(list, 'Port', proxy.port);
      appendDefinition(list, 'Has username', proxy.hasUsername ? 'yes' : 'no');
      appendDefinition(list, 'Has password', proxy.hasPassword ? 'yes' : 'no');
      appendDefinition(list, 'Username', proxy.username);
    });

  }

  function renderProxyAuthStats(parent, stats) {

    appendText(parent, 'h3', 'Proxy auth stats');
    const list = append(parent, 'dl');
    appendDefinition(list, 'Challenges seen', stats && stats.challenges);
    appendDefinition(list, 'Credentials provided', stats && stats.provided);
    appendDefinition(list, 'Missing credentials', stats && stats.missingCredentials);
    appendDefinition(list, 'Retry limit hits', stats && stats.retryLimit);
    appendDefinition(
        list,
        'Non-proxy ignored',
        stats && stats.nonProxyChallengesIgnored,
    );

  }

  function renderProxyAuthEvents(parent, events) {

    appendText(parent, 'h3', 'Proxy auth events');
    if (!events || !events.length) {
      appendText(parent, 'p', 'No proxy auth events.');
      return;
    }
    events.slice().reverse().forEach((event) => {
      const list = append(parent, 'dl');
      appendDefinition(list, 'Type', event.type);
      appendDefinition(list, 'Time', formatTime(event.at));
      appendDefinition(list, 'Proxy challenge', event.isProxy ? 'yes' : 'no');
      appendDefinition(list, 'Host', event.host);
      appendDefinition(list, 'Port', event.port);
      appendDefinition(list, 'Has credentials', event.hasCredentials ? 'yes' : 'no');
      appendDefinition(list, 'Username', event.username);
      appendDefinition(list, 'Message', event.message);
    });

  }

  function renderPeriodicUpdateSection(parent, periodicSnapshot) {

    const section = append(parent, 'section');
    appendText(section, 'h2', t('optionsPeriodicUpdates'));
    appendText(
        section,
        'p',
        t('optionsPeriodicUpdatesHint'),
        'notice',
    );
    appendText(
        section,
        'p',
        t('optionsPeriodicAuthHint'),
        'notice',
    );

    const periodicUpdate = periodicSnapshot && periodicSnapshot.periodicUpdate || {};
    const form = append(section, 'form');
    const enabledLabel = append(form, 'label');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = periodicUpdate.enabled === true;
    enabledLabel.appendChild(enabledInput);
    enabledLabel.appendChild(document.createTextNode(` ${t('optionsEnablePeriodicUpdates')}`));

    appendText(form, 'p', t('popupAutoUpdateEveryHours', ['12']), 'note');

    const saveButton = append(form, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = t('optionsSavePeriodicUpdates');
    saveButton.dataset.busyText = t('optionsSaving');
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground(
            'setPeriodicUpdateEnabled',
            {enabled: enabledInput.checked},
        );
        await refresh(t('optionsPeriodicSettingsSaved'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const runButton = append(section, 'button');
    runButton.type = 'button';
    runButton.dataset.idleText = t('optionsRunUpdateNow');
    runButton.dataset.busyText = t('optionsRunning');
    runButton.textContent = runButton.dataset.idleText;
    runButton.onclick = async () => {
      setButtonBusy(runButton, true);
      try {
        const result = await rpc.callBackground(
            'runPeriodicUpdateNow',
            {applyIfSafe: true},
        );
        if (result.ok === false && result.status !== 'skipped') {
          await refresh(
              t('optionsPeriodicUpdateFailed', [result.error.message]),
              true,
          );
          return;
        }
        await refresh(t('optionsPeriodicUpdateStatus', [
          localizeStatusValue(result.status),
        ]));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const clearButton = append(section, 'button');
    clearButton.type = 'button';
    clearButton.dataset.idleText = t('optionsClearPeriodicEvents');
    clearButton.dataset.busyText = t('popupClearing');
    clearButton.textContent = clearButton.dataset.idleText;
    clearButton.onclick = async () => {
      setButtonBusy(clearButton, true);
      try {
        await rpc.callBackground('clearPeriodicUpdateEvents', {});
        await refresh(t('optionsPeriodicEventsCleared'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    renderPeriodicUpdateDetails(section, periodicSnapshot);

  }

  function renderPeriodicUpdateDetails(parent, periodicSnapshot) {

    const periodicUpdate = periodicSnapshot && periodicSnapshot.periodicUpdate || {};
    const alarms = periodicSnapshot && periodicSnapshot.alarms || {};
    const periodicAlarm = alarms.periodicUpdate;
    const list = append(parent, 'dl');
    appendDefinition(list, t('optionsEnabled'), periodicUpdate.enabled ? t('optionsYes') : t('optionsNo'));
    appendDefinition(list, t('optionsInterval'), periodicUpdate.intervalMinutes);
    appendDefinition(
        list,
        t('popupStatus'),
        localizeStatusValue(periodicUpdate.status),
    );
    appendDefinition(list, t('optionsLastStarted'), formatTime(periodicUpdate.lastStartedAt));
    appendDefinition(
        list,
        t('optionsLastFinished'),
        formatTime(periodicUpdate.lastFinishedAt),
    );
    appendDefinition(list, t('optionsNextRun'), formatTime(periodicUpdate.nextRunAt));
    appendDefinition(
        list,
        t('optionsConsecutiveFailures'),
        periodicUpdate.consecutiveFailures,
    );
    appendDefinition(
        list,
        t('optionsAlarmScheduled'),
        periodicAlarm ? formatTime(periodicAlarm.scheduledTime) : t('optionsNone'),
    );
    appendDefinition(
        list,
        t('optionsAlarmPeriod'),
        periodicAlarm && periodicAlarm.periodInMinutes,
    );
    if (periodicUpdate.lastResult) {
      appendDefinition(
          list,
          t('optionsLastResult'),
          JSON.stringify(periodicUpdate.lastResult),
      );
    }
    if (periodicUpdate.lastError) {
      appendDefinition(list, t('optionsLastError'), periodicUpdate.lastError.message);
    }
    renderPeriodicUpdateEvents(parent, periodicUpdate.lastEvents);

  }

  function renderPeriodicUpdateEvents(parent, events) {

    appendText(parent, 'h3', t('optionsPeriodicEvents'));
    if (!events || !events.length) {
      appendText(parent, 'p', t('optionsNoPeriodicEvents'));
      return;
    }
    events.slice().reverse().forEach((event) => {
      const list = append(parent, 'dl');
      appendDefinition(list, t('optionsType'), event.type);
      appendDefinition(list, t('optionsTime'), formatTime(event.at));
      appendDefinition(list, t('optionsTrigger'), event.trigger);
      appendDefinition(list, t('popupProvider'), event.providerKey);
      appendDefinition(list, t('popupStatus'), event.status);
      appendDefinition(list, t('optionsMessage'), event.message);
      if (event.error) {
        appendDefinition(list, t('optionsError'), event.error.message);
      }
    });

  }

  function renderLegacyMigrationSection(parent, legacyMigration, latestPlan) {

    const section = append(parent, 'section');
    appendText(section, 'h2', t('optionsLegacyMigration'));
    appendText(
        section,
        'p',
        t('optionsLegacyMigrationHint'),
        'notice',
    );

    const scanButton = append(section, 'button');
    scanButton.type = 'button';
    scanButton.dataset.idleText = t('optionsScanLegacySettings');
    scanButton.dataset.busyText = t('optionsScanning');
    scanButton.textContent = scanButton.dataset.idleText;
    scanButton.onclick = async () => {
      setButtonBusy(scanButton, true);
      try {
        latestLegacyMigrationPlan = await rpc.callBackground(
            'runLegacyMigrationAudit',
            {includeValues: false},
        );
        await refresh(t('optionsLegacyAuditCompleted'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const loadButton = append(section, 'button');
    loadButton.type = 'button';
    loadButton.dataset.idleText = t('optionsLoadMigrationPlan');
    loadButton.dataset.busyText = t('optionsLoading');
    loadButton.textContent = loadButton.dataset.idleText;
    loadButton.onclick = async () => {
      setButtonBusy(loadButton, true);
      try {
        latestLegacyMigrationPlan = await rpc.callBackground(
            'getLegacyMigrationPlan',
            {includeValues: false},
        );
        await refresh(t('optionsLegacyPlanLoaded'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    const clearButton = append(section, 'button');
    clearButton.type = 'button';
    clearButton.dataset.idleText = t('optionsClearMigrationAudit');
    clearButton.dataset.busyText = t('popupClearing');
    clearButton.textContent = clearButton.dataset.idleText;
    clearButton.onclick = async () => {
      setButtonBusy(clearButton, true);
      try {
        latestLegacyMigrationPlan = null;
        await rpc.callBackground('clearLegacyMigrationAudit', {});
        await refresh(t('optionsLegacyAuditCleared'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

    renderLegacyMigrationStatus(section, legacyMigration);
    if (latestPlan) {
      renderLegacyMigrationPlan(section, latestPlan);
      renderLegacyMigrationApplyForm(section, latestPlan);
    }

  }

  function renderLegacyMigrationStatus(parent, legacyMigration) {

    const state = legacyMigration || {};
    const list = append(parent, 'dl');
    appendDefinition(list, t('optionsAuditStatus'), state.auditStatus);
    appendDefinition(list, t('optionsApplyStatus'), state.applyStatus);
    appendDefinition(list, t('optionsLastAudit'), formatTime(state.lastAuditAt));
    appendDefinition(list, t('optionsLastApply'), formatTime(state.lastApplyAt));
    appendDefinition(
        list,
        t('optionsDetectedLegacyData'),
        state.detectedLegacyData ? t('optionsYes') : t('optionsNo'),
    );
    if (state.lastSummary) {
      appendDefinition(list, t('optionsInstallType'), state.lastSummary.installType);
      appendDefinition(
          list,
          t('optionsChromeStorageKeys'),
          state.lastSummary.sources.chromeStorageLocal.keysFound.join(', ') ||
            t('optionsNone'),
      );
      appendDefinition(
          list,
          t('optionsLocalStorageKeys'),
          state.lastSummary.sources.localStorage.keysFound.join(', ') ||
            t('optionsNone'),
      );
      appendDefinition(
          list,
          t('optionsProposedSettings'),
          state.lastSummary.proposedKeys.join(', ') || t('optionsNone'),
      );
      appendDefinition(
          list,
          t('optionsCannotMigrate'),
          state.lastSummary.cannotMigrateCount,
      );
      appendDefinition(list, t('optionsConflicts'), state.lastSummary.conflictCount);
      appendDefinition(list, t('optionsWarnings'), state.lastSummary.warningCount);
    }
    if (state.lastError) {
      appendDefinition(list, t('optionsAuditError'), state.lastError.message);
    }
    if (state.appliedFields && state.appliedFields.length) {
      appendDefinition(list, t('optionsAppliedFields'), state.appliedFields.join(', '));
    }
    if (state.skippedFields && state.skippedFields.length) {
      appendDefinition(
          list,
          t('optionsSkippedFields'),
          state.skippedFields.map((field) => field.field).join(', '),
      );
    }
    if (state.conflicts && state.conflicts.length) {
      appendDefinition(
          list,
          t('optionsApplyConflicts'),
          state.conflicts.map((conflict) => conflict.field).join(', '),
      );
    }
    if (state.lastApplySummary) {
      appendText(parent, 'h4', t('optionsLastApplySummary'));
      appendJsonBlock(parent, state.lastApplySummary);
    }
    if (state.warnings && state.warnings.length) {
      appendDefinition(list, t('optionsAuditWarnings'), state.warnings.join('; '));
    }

  }

  function renderLegacyMigrationPlan(parent, plan) {

    appendText(parent, 'h3', t('optionsDryRunMigrationPlan'));
    const sources = plan.sources || {};
    const proposed = plan.proposedMigration || {};
    const list = append(parent, 'dl');
    appendDefinition(list, t('optionsDetected'), plan.detected ? t('optionsYes') : t('optionsNo'));
    appendDefinition(list, t('optionsInstallType'), plan.installType);
    appendDefinition(
        list,
        t('optionsChromeStorageChecked'),
        sources.chromeStorageLocal && sources.chromeStorageLocal.checked ?
          t('optionsYes') :
          t('optionsNo'),
    );
    appendDefinition(
        list,
        t('optionsChromeStorageKeys'),
        sources.chromeStorageLocal ?
          sources.chromeStorageLocal.keysFound.join(', ') || t('optionsNone') :
          t('optionsNone'),
    );
    appendDefinition(
        list,
        t('optionsLocalStorageChecked'),
        sources.localStorage && sources.localStorage.checked ?
          t('optionsYes') :
          t('optionsNo'),
    );
    appendDefinition(
        list,
        t('optionsLocalStorageKeys'),
        sources.localStorage ?
          sources.localStorage.keysFound.join(', ') || t('optionsNone') :
          t('optionsNone'),
    );

    appendText(parent, 'h4', t('optionsSettingsAvailableForMigration'));
    appendJsonBlock(parent, proposed.canMigrate || {});
    renderPlanItems(
        parent,
        t('optionsSettingsCannotMigrateSafely'),
        proposed.cannotMigrate,
    );
    renderPlanItems(parent, t('optionsConflictsWithCurrentMv3'), proposed.conflicts);
    renderPlanItems(parent, t('optionsWarnings'), proposed.warnings);

  }

  function renderLegacyMigrationApplyForm(parent, plan) {

    const proposed = plan.proposedMigration || {};
    const canMigrate = proposed.canMigrate || {};
    const section = append(parent, 'div', 'migration-apply');
    appendText(section, 'h4', t('optionsApplySelectedLegacySettings'));

    const form = append(section, 'form');
    LEGACY_MIGRATION_FIELDS.forEach((field) => {
      const label = append(form, 'label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.migrationField = field.key;
      input.disabled = canMigrate[field.key] === null ||
        canMigrate[field.key] === undefined;
      input.checked = !input.disabled;
      label.appendChild(input);
      label.appendChild(document.createTextNode(` ${t(field.labelKey)}`));
    });

    const strategyLabel = append(form, 'label');
    strategyLabel.appendChild(document.createTextNode(` ${t('optionsStrategy')} `));
    const strategySelect = document.createElement('select');
    strategySelect.name = 'migrationStrategy';
    [
      ['fillMissing', t('optionsFillMissingOnly')],
      ['overwriteSelected', t('optionsOverwriteSelectedMv3')],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      strategySelect.appendChild(option);
    });
    strategyLabel.appendChild(strategySelect);

    const confirmationLabel = append(form, 'label', 'confirmation');
    const confirmationInput = document.createElement('input');
    confirmationInput.type = 'checkbox';
    confirmationLabel.appendChild(confirmationInput);
    confirmationLabel.appendChild(document.createTextNode(
        ` ${t('optionsMigrationConfirmation')}`,
    ));

    const applyButton = append(form, 'button');
    applyButton.type = 'button';
    applyButton.dataset.idleText = t('optionsApplySelectedMigration');
    applyButton.dataset.busyText = t('optionsApplying');
    applyButton.textContent = applyButton.dataset.idleText;
    applyButton.disabled = true;

    const updateApplyEnabled = () => {
      const selectedFields = getSelectedMigrationFields(form);
      applyButton.disabled = !confirmationInput.checked || !selectedFields.length;
    };
    form.addEventListener('change', updateApplyEnabled);
    updateApplyEnabled();

    applyButton.onclick = async () => {
      const fields = getSelectedMigrationFields(form);
      if (!confirmationInput.checked || !fields.length) {
        return;
      }
      setButtonBusy(applyButton, true);
      try {
        const result = await rpc.callBackground('applyLegacyMigration', {
          strategy: strategySelect.value,
          fields,
        });
        if (result.ok === false) {
          await refresh(t('optionsMigrationApplyFailed', [result.error.message]), true);
          return;
        }
        await refresh(t('optionsMigrationApplyStatus', [result.status]));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function getSelectedMigrationFields(form) {

    return Array.from(form.querySelectorAll('input[data-migration-field]'))
        .filter((input) => input.checked && !input.disabled)
        .map((input) => input.dataset.migrationField);

  }

  function renderPlanItems(parent, title, items) {

    appendText(parent, 'h4', title);
    if (!items || !items.length) {
      appendText(parent, 'p', t('optionsNone'));
      return;
    }
    appendJsonBlock(parent, items);

  }

  function appendJsonBlock(parent, value) {

    const pre = append(parent, 'pre');
    pre.textContent = JSON.stringify(value, null, 2);

  }

  function renderNotificationSection(parent, prefs) {

    const section = append(parent, 'section');
    appendText(section, 'h2', t('optionsNotifications'));
    const form = append(section, 'form');

    Object.entries(prefs).forEach(([key, value]) => {
      const label = append(form, 'label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.pref = key;
      input.checked = value;
      label.appendChild(input);
      label.appendChild(document.createTextNode(` ${getNotificationPrefLabel(key)}`));
    });

    const saveButton = append(form, 'button');
    saveButton.type = 'button';
    saveButton.dataset.idleText = t('optionsSaveNotifications');
    saveButton.dataset.busyText = t('optionsSaving');
    saveButton.textContent = saveButton.dataset.idleText;
    saveButton.onclick = async () => {
      const nextPrefs = {};
      form.querySelectorAll('input[data-pref]').forEach((input) => {
        nextPrefs[input.dataset.pref] = input.checked;
      });
      setButtonBusy(saveButton, true);
      try {
        await rpc.callBackground('setNotificationPrefs', {prefs: nextPrefs});
        await refresh(t('optionsNotificationPrefsSaved'));
      } catch (err) {
        await refresh(err.message, true);
      }
    };

  }

  function getNotificationPrefLabel(key) {

    const labels = {
      pacError: t('optionsNotifyPacError'),
      extError: t('optionsNotifyExtensionError'),
      noControl: t('optionsNotifyNoControl'),
    };
    return labels[key] || key;

  }

  function renderTorConfigEditor(parent, key, title, config) {

    const fieldset = append(parent, 'fieldset', 'pac-mod-group');
    appendText(fieldset, 'legend', title);
    appendText(
        fieldset,
        'p',
        key === 'torBrowser' ? t('optionsTorBrowserHelp') : t('optionsLocalTorHelp'),
        'note',
    );
    const enabledInput = appendCheckbox(
        fieldset,
        `${key}.enabled`,
        t('optionsEnabled'),
        config && config.enabled,
        key === 'torBrowser' ? t('optionsTorBrowserHelp') : t('optionsLocalTorHelp'),
    );
    enabledInput.onchange = () => enforceTorModeInputs(parent, key, enabledInput);
    appendSelect(
        fieldset,
        `${key}.type`,
        t('optionsType'),
        ['SOCKS5', 'SOCKS4', 'PROXY', 'HTTPS'],
        config && config.type || 'SOCKS5',
    );
    appendTextInput(
        fieldset,
        `${key}.host`,
        t('optionsHost'),
        config && config.host || '127.0.0.1',
    );
    appendNumberInput(
        fieldset,
        `${key}.port`,
        t('optionsPort'),
        config && config.port || (key === 'torBrowser' ? 9150 : 9050),
    );
    appendCheckbox(
        fieldset,
        `${key}.useForOnion`,
        t('optionsUseForOnion'),
        !config || config.useForOnion !== false,
    );
    appendCheckbox(
        fieldset,
        `${key}.useAsDirectReplacement`,
        t('optionsUseAsDirectReplacement'),
        config && config.useAsDirectReplacement,
    );

  }

  function renderPacProxyModeEditor(parent, pacMods) {

    const fieldset = append(parent, 'fieldset', 'pac-mod-group');
    appendText(fieldset, 'legend', t('optionsPacProxyMode'));
    appendText(fieldset, 'p', t('optionsPacProxyModeHelp'), 'note');
    appendCheckbox(
        fieldset,
        'usePacScriptProxies',
        t('popupUsePacScriptProxies'),
        pacMods.usePacScriptProxies !== false,
        t('popupUsePacScriptProxiesHelp'),
    );
    appendCheckbox(
        fieldset,
        'ownProxiesOnlyForOwnSites',
        t('popupOwnProxiesOnlyForOwnSites'),
        pacMods.ownProxiesOnlyForOwnSites === true,
        t('popupOwnProxiesOnlyForOwnSitesHelp'),
    );

  }

  function renderWarpEditor(parent, warp) {

    const fieldset = append(parent, 'fieldset', 'pac-mod-group');
    appendText(fieldset, 'legend', t('popupWarpCustomProxy'));
    appendCheckbox(fieldset, 'warp.enabled', t('optionsEnabled'), warp && warp.enabled);
    appendTextInput(
        fieldset,
        'warp.proxyString',
        t('optionsProxyString'),
        warp && warp.proxyString ||
          'SOCKS5 127.0.0.1:40000; HTTPS 127.0.0.1:40000',
    );
    appendCheckbox(
        fieldset,
        'warp.useAsDirectReplacement',
        t('optionsUseAsDirectReplacement'),
        warp && warp.useAsDirectReplacement,
    );

  }

  function renderOwnProxyEditor(parent, ownProxies) {

    const fieldset = append(parent, 'fieldset', 'pac-mod-group');
    appendText(fieldset, 'legend', t('popupOwnProxies'));
    const rows = append(fieldset, 'div');
    const entries = ownProxies.length ? ownProxies : [createEmptyProxy()];
    entries.forEach((proxy) => renderOwnProxyRow(rows, proxy));
    const addButton = append(fieldset, 'button');
    addButton.type = 'button';
    addButton.textContent = t('optionsAddProxyRow');
    addButton.onclick = () => renderOwnProxyRow(rows, createEmptyProxy());

  }

  function renderOwnProxyRow(parent, proxy) {

    const row = append(parent, 'div', 'proxy-row');
    appendCheckbox(row, 'proxy.enabled', t('optionsEnabled'), proxy.enabled !== false);
    appendSelect(
        row,
        'proxy.type',
        t('optionsType'),
        ['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5'],
        proxy.type || 'PROXY',
    );
    appendTextInput(row, 'proxy.host', t('optionsHost'), proxy.host || '');
    appendNumberInput(row, 'proxy.port', t('optionsPort'), proxy.port || 8080);
    appendTextInput(row, 'proxy.username', t('optionsUsername'), proxy.username || '');
    appendTextInput(
        row,
        'proxy.password',
        t('optionsPassword'),
        proxy.password ? REDACTED_PASSWORD : '',
    );
    appendCheckbox(
        row,
        'proxy.useAsDirectReplacement',
        t('optionsDirectReplacement'),
        proxy.useAsDirectReplacement,
    );
    appendTextInput(row, 'proxy.note', t('optionsNote'), proxy.note || '');
    const removeButton = append(row, 'button');
    removeButton.type = 'button';
    removeButton.textContent = t('optionsRemove');
    removeButton.onclick = () => row.remove();

  }

  function renderPatternListEditor(parent, key, title, entries, ifRules) {

    const fieldset = append(parent, 'fieldset', 'pac-mod-group');
    appendText(fieldset, 'legend', title);
    const rows = append(fieldset, 'div');
    const normalizedEntries = entries.length ? entries : [createEmptyPattern()];
    normalizedEntries.forEach((entry) => {
      renderPatternRow(rows, key, entry);
    });
    const addButton = append(fieldset, 'button');
    addButton.type = 'button';
    addButton.textContent = ifRules ? t('optionsAddExceptionRule') : t('optionsAddWhitelistRow');
    addButton.onclick = () => {
      renderPatternRow(rows, key, createEmptyPattern());
    };

  }

  function renderPatternRow(parent, key, entry) {

    const row = append(parent, 'div', 'rule-row');
    appendCheckbox(row, `${key}.enabled`, t('optionsEnabled'), entry.enabled !== false);
    appendTextInput(row, `${key}.pattern`, t('optionsPattern'), entry.pattern || '');
    appendTextInput(row, `${key}.note`, t('optionsNote'), entry.note || '');
    const removeButton = append(row, 'button');
    removeButton.type = 'button';
    removeButton.textContent = t('optionsRemove');
    removeButton.onclick = () => row.remove();

  }

  function renderPacPolicyEditor(parent, pacMods) {

    const fieldset = append(parent, 'fieldset', 'pac-mod-group');
    appendText(fieldset, 'legend', t('optionsDirectPolicy'));
    appendCheckbox(
        fieldset,
        'replaceDirectWithProxy',
        t('optionsReplaceDirectWithProxy'),
        pacMods.replaceDirectWithProxy,
    );
    appendCheckbox(
        fieldset,
        'noDirect',
        t('optionsRemoveDirectFallbacks'),
        pacMods.noDirect,
    );

  }

  function enforceTorModeInputs(rootNode, key, input) {

    if (!input.checked) {
      return;
    }
    const otherName = key === 'localTor' ?
      'torBrowser.enabled' :
      'localTor.enabled';
    const other = rootNode.querySelector(`[name="${otherName}"]`);
    if (other) {
      other.checked = false;
    }

  }

  function appendCheckbox(parent, name, labelText, checked, title) {

    const label = append(parent, 'label');
    if (title) {
      label.title = title;
    }
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.checked = checked === true;
    if (title) {
      input.title = title;
    }
    label.appendChild(input);
    label.appendChild(document.createTextNode(` ${labelText}`));
    return input;

  }

  function appendTextInput(parent, name, labelText, value) {

    const label = append(parent, 'label');
    label.appendChild(document.createTextNode(`${labelText} `));
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.value = value === undefined || value === null ? '' : String(value);
    label.appendChild(input);
    return input;

  }

  function appendTextareaInput(parent, name, labelText, value) {

    const label = append(parent, 'label', 'textarea-field');
    appendText(label, 'span', labelText);
    const textarea = append(label, 'textarea');
    textarea.name = name;
    textarea.value = value === undefined || value === null ? '' : String(value);
    return textarea;

  }

  function appendNumberInput(parent, name, labelText, value) {

    const input = appendTextInput(parent, name, labelText, value);
    input.type = 'number';
    input.min = '1';
    input.max = '65535';
    return input;

  }

  function appendSelect(parent, name, labelText, options, value) {

    const label = append(parent, 'label');
    label.appendChild(document.createTextNode(`${labelText} `));
    const select = document.createElement('select');
    select.name = name;
    options.forEach((optionValue) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue;
      option.selected = optionValue === value;
      select.appendChild(option);
    });
    label.appendChild(select);
    return select;

  }

  function createEmptyProxy() {

    return {
      enabled: true,
      type: 'PROXY',
      host: '',
      port: 8080,
      username: '',
      password: '',
      useAsDirectReplacement: false,
      note: '',
    };

  }

  function createEmptyPattern() {

    return {
      pattern: '',
      enabled: true,
      note: '',
    };

  }

  function collectLocalProxyPacMods(form, originalPacMods) {

    const localTor = collectTorConfig(form, 'localTor');
    const torBrowser = collectTorConfig(form, 'torBrowser');
    if (localTor.enabled && torBrowser.enabled) {
      localTor.enabled = false;
    }
    return restoreRedactedPacMods(createPacModsPatch(originalPacMods, {
      localTor,
      torBrowser,
      usePacScriptProxies: getChecked(form, 'usePacScriptProxies'),
      ownProxiesOnlyForOwnSites: getChecked(
          form,
          'ownProxiesOnlyForOwnSites',
      ),
      warp: {
        enabled: getChecked(form, 'warp.enabled'),
        proxyString: getValue(form, 'warp.proxyString'),
        useAsDirectReplacement: getChecked(
            form,
            'warp.useAsDirectReplacement',
        ),
      },
      ownProxies: collectOwnProxyRows(form),
    }), originalPacMods);

  }

  function collectAdvancedPacRules(form, originalPacMods) {

    return createPacModsPatch(originalPacMods, {
      whitelist: collectPatternRows(form, 'whitelist'),
      replaceDirectWithProxy: getChecked(form, 'replaceDirectWithProxy'),
      noDirect: getChecked(form, 'noDirect'),
    });

  }

  function collectTorConfig(form, key) {

    return {
      enabled: getChecked(form, `${key}.enabled`),
      type: getValue(form, `${key}.type`),
      host: getValue(form, `${key}.host`),
      port: Number(getValue(form, `${key}.port`)),
      useForOnion: getChecked(form, `${key}.useForOnion`),
      useAsDirectReplacement: getChecked(
          form,
          `${key}.useAsDirectReplacement`,
      ),
    };

  }

  function collectOwnProxyRows(form) {

    return Array.from(form.querySelectorAll('.proxy-row'))
        .map((row) => ({
          enabled: getChecked(row, 'proxy.enabled'),
          type: getValue(row, 'proxy.type'),
          host: getValue(row, 'proxy.host'),
          port: Number(getValue(row, 'proxy.port')),
          username: getValue(row, 'proxy.username'),
          password: getValue(row, 'proxy.password'),
          useAsDirectReplacement: getChecked(
              row,
              'proxy.useAsDirectReplacement',
          ),
          note: getValue(row, 'proxy.note'),
        }))
        .filter((proxy) => proxy.host);

  }

  function collectPatternRows(form, key) {

    return Array.from(form.querySelectorAll('.rule-row'))
        .filter((row) => row.querySelector(`[name="${key}.pattern"]`))
        .map((row) => ({
          pattern: getValue(row, `${key}.pattern`),
          enabled: getChecked(row, `${key}.enabled`),
          note: getValue(row, `${key}.note`),
        }))
        .filter((entry) => entry.pattern);

  }

  function getValue(rootNode, name) {

    const input = rootNode.querySelector(`[name="${name}"]`);
    return input ? input.value.trim() : '';

  }

  function getChecked(rootNode, name) {

    const input = rootNode.querySelector(`[name="${name}"]`);
    return input ? input.checked : false;

  }

  function parseProxyForRedaction(proxyAsStringRaw) {

    if (proxyAsStringRaw && typeof proxyAsStringRaw === 'object') {
      const proxy = proxyAsStringRaw;
      const type = String(proxy.type || 'PROXY').toUpperCase();
      const username = String(proxy.username || '');
      const host = String(proxy.host || proxy.hostname || '');
      const port = String(proxy.port || '');
      if (!host || !port) {
        return null;
      }
      return {
        type,
        username,
        password: String(proxy.password || ''),
        address: `${host}:${port}`,
        host,
        port,
        key: `${type} ${username}@${host}:${port}`.toLowerCase(),
      };
    }

    const proxyAsString = String(proxyAsStringRaw || '').trim();
    const match = proxyAsString.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }
    const atIndex = match[2].lastIndexOf('@');
    if (atIndex === -1) {
      return null;
    }
    const credentials = match[2].slice(0, atIndex);
    const address = match[2].slice(atIndex + 1);
    const colonIndex = credentials.indexOf(':');
    const username = colonIndex === -1 ?
      credentials :
      credentials.slice(0, colonIndex);
    const password = colonIndex === -1 ? '' : credentials.slice(colonIndex + 1);
    return {
      type: match[1],
      username,
      password,
      address,
      key: `${match[1].toUpperCase()} ${username}@${address}`.toLowerCase(),
    };

  }

  function redactProxyPassword(proxyAsString) {

    if (proxyAsString && typeof proxyAsString === 'object') {
      const clone = JSON.parse(JSON.stringify(proxyAsString));
      if (clone.password) {
        clone.password = REDACTED_PASSWORD;
      }
      return clone;
    }
    const parsed = parseProxyForRedaction(proxyAsString);
    if (!parsed || !parsed.password) {
      return proxyAsString;
    }
    return `${parsed.type} ${parsed.username}:${REDACTED_PASSWORD}@${parsed.address}`;

  }

  function redactPacModsForDisplay(pacMods) {

    const clone = JSON.parse(JSON.stringify(pacMods));
    clone.ownProxies = Array.isArray(clone.ownProxies) ?
      clone.ownProxies.map(redactProxyPassword) :
      [];
    return clone;

  }

  function restoreRedactedProxyPassword(proxyAsString, originalOwnProxies) {

    const parsed = parseProxyForRedaction(proxyAsString);
    if (!parsed || parsed.password !== REDACTED_PASSWORD) {
      return proxyAsString;
    }
    const originalProxy = originalOwnProxies.find((candidate) => {
      const originalParsed = parseProxyForRedaction(candidate);
      return originalParsed && originalParsed.key === parsed.key;
    });
    if (!originalProxy) {
      return proxyAsString;
    }
    if (proxyAsString && typeof proxyAsString === 'object') {
      return Object.assign({}, proxyAsString, {
        password: parseProxyForRedaction(originalProxy).password,
      });
    }
    return originalProxy;

  }

  function restoreRedactedPacMods(nextPacMods, originalPacMods) {

    const clone = JSON.parse(JSON.stringify(nextPacMods));
    const originalOwnProxies = Array.isArray(originalPacMods.ownProxies) ?
      originalPacMods.ownProxies :
      [];
    clone.ownProxies = Array.isArray(clone.ownProxies) ?
      clone.ownProxies.map((proxy) =>
        restoreRedactedProxyPassword(proxy, originalOwnProxies),
      ) :
      [];
    return clone;

  }

  function renderError(err) {

    root.replaceChildren();
    appendText(root, 'h1', t('popupTitle'));
    appendText(
        root,
        'p',
        err && err.message ? err.message : t('optionsLoadStateFailed'),
        'status error',
    );

  }

  refresh();

})();
