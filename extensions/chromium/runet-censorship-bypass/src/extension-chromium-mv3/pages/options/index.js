'use strict';

(function() {

  const rpc = window.mv3Rpc;
  const root = document.getElementById('app-root');
  const REDACTED_PASSWORD = '***';
  const NAV_ITEMS = Object.freeze([
    ['overview', 'optionsNavOverview'],
    ['routing-sources', 'optionsNavRoutingSources'],
    ['site-rules', 'optionsNavSiteRules'],
    ['proxy-methods', 'optionsNavProxyMethods'],
    ['maintenance', 'optionsNavMaintenance'],
    ['advanced', 'optionsNavAdvanced'],
    ['about', 'optionsAbout'],
  ]);
  const HASH_ALIASES = Object.freeze({
    'updates-health': Object.freeze({
      section: 'maintenance',
      focusId: 'maintenance-updates-heading',
    }),
    'updates': Object.freeze({
      section: 'maintenance',
      focusId: 'maintenance-updates-heading',
    }),
    'diagnostics': Object.freeze({
      section: 'maintenance',
      focusId: 'maintenance-diagnostics-heading',
      openDisclosure: 'diagnostics-expert',
    }),
  });
  const LEGACY_MIGRATION_FIELDS = Object.freeze([
    ['currentPacProviderKey', 'popupPacProvider'],
    ['pacUpdatePeriodInMinutes', 'optionsPacUpdatePeriod'],
    ['pacMods', 'optionsPacModifiers'],
    ['notificationPrefs', 'optionsNotificationPrefs'],
  ]);
  const state = {
    snapshot: null,
    requestSerial: 0,
    drafts: new Map(),
    pending: new Set(),
    openDisclosures: new Set(),
    activeSection: 'overview',
    message: null,
    retry: null,
    latestMigrationPlan: null,
    listenersInstalled: false,
    setupEligibilityInitialized: false,
    setupEligible: false,
  };
  let fieldId = 0;

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
    node.textContent = text === null || text === undefined ? '' : String(text);
    return node;

  }

  function clone(value) {

    return JSON.parse(JSON.stringify(value));

  }

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function formatTime(value) {

    if (!value) {
      return t('optionsNone');
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ?
      t('optionsNone') :
      date.toLocaleString();

  }

  function formatCount(count, singularKey, pluralKey) {

    const value = Number(count) || 0;
    return t(value === 1 ? singularKey : pluralKey, [String(value)]);

  }

  function setMessage(text, tone = 'info', retry) {

    state.message = text ? {text: String(text), tone} : null;
    state.retry = typeof retry === 'function' ? retry : null;
    updateMessageBanner();

  }

  function getSafeError(error, context) {

    const code = error && error.code || '';
    const message = String(error && error.message || '');
    const keys = {
      CUSTOM_PROVIDER_LABEL_REQUIRED: 'optionsProviderNameRequired',
      CUSTOM_PROVIDER_URL_REQUIRED: 'optionsProviderUrlRequired',
      CUSTOM_PROVIDER_URL_INVALID: 'optionsProviderUrlInvalid',
      CUSTOM_PROVIDER_URL_SCHEME: 'optionsProviderUrlScheme',
      CUSTOM_PROVIDER_URL_CREDENTIALS: 'optionsProviderUrlCredentials',
      CUSTOM_PROVIDER_TOO_MANY_URLS: 'optionsProviderTooManyUrls',
      CUSTOM_PROVIDER_NOT_FOUND: 'optionsProviderNotFound',
      BUILT_IN_PROVIDER_READ_ONLY: 'optionsProviderBuiltInReadOnly',
      PROXY_RULE_NO_CANDIDATE: 'popupNoProxyCandidate',
      PAC_APPLY_STALE: 'optionsConflictError',
    };
    if (keys[code]) {
      return t(keys[code]);
    }
    if (/stale|revision/i.test(message)) {
      return t('optionsConflictError');
    }
    if (context === 'provider') {
      return t('optionsProviderSaveFailed');
    }
    if (context === 'validation') {
      return t('optionsValidationFailed');
    }
    if (context === 'apply') {
      return t('optionsApplyFailedSafe');
    }
    return t('optionsOperationFailedSafe');

  }

  function getPacRevision(snapshot = state.snapshot) {

    const pacMods = snapshot && snapshot.state && snapshot.state.pacMods;
    return Number.isSafeInteger(pacMods && pacMods.credentialRevision) ?
      pacMods.credentialRevision :
      null;

  }

  function getDraftRemoteSignature(key, snapshot = state.snapshot) {

    if (!snapshot) {
      return null;
    }
    if (key.startsWith('provider:') && key !== 'provider:add') {
      const providerKey = key.slice('provider:'.length);
      const provider = (snapshot.providers || []).find((entry) =>
        entry.key === providerKey,
      );
      return JSON.stringify(provider ? {
        key: provider.key,
        label: provider.label,
        description: provider.description || '',
        urls: provider.urls || [],
        enabled: provider.enabled !== false,
      } : {missing: true});
    }
    if (key === 'updates') {
      const autoUpdate = snapshot.reliability &&
        snapshot.reliability.autoUpdate || {};
      return JSON.stringify({enabled: autoUpdate.enabled === true});
    }
    if (key === 'notifications') {
      return JSON.stringify(
          snapshot.state && snapshot.state.notificationPrefs || {},
      );
    }
    if (key === 'migration') {
      return JSON.stringify(
          snapshot.state && snapshot.state.legacyMigration || {},
      );
    }
    return null;

  }

  function hasDirtyDrafts() {

    return Array.from(state.drafts.values()).some((draft) => draft.dirty);

  }

  function getDirtyDrafts() {

    return Array.from(state.drafts.entries())
        .filter((entry) => entry[1].dirty);

  }

  function serializeForm(form) {

    return Array.from(form.querySelectorAll('input, select, textarea'))
        .filter((input) => !['button', 'submit'].includes(input.type))
        .map((input) => ({
          name: input.name || '',
          type: input.type || input.tagName.toLowerCase(),
          value: input.value,
          checked: input.checked === true,
        }));

  }

  function restoreForm(form, values) {

    const inputs = Array.from(
        form.querySelectorAll('input, select, textarea'),
    ).filter((input) => !['button', 'submit'].includes(input.type));
    (values || []).forEach((saved, index) => {
      const input = inputs[index];
      if (!input || input.name !== saved.name || input.type !== saved.type) {
        return;
      }
      if (['checkbox', 'radio'].includes(input.type)) {
        input.checked = saved.checked === true;
      } else {
        input.value = saved.value;
      }
    });

  }

  function bindDraftForm(form, key, options = {}) {

    form.dataset.draftKey = key;
    let draft = state.drafts.get(key);
    const baseline = serializeForm(form);
    if (!draft) {
      draft = {
        baseline,
        values: baseline,
        dirty: false,
        conflict: false,
        pacRevision: options.usesPacMods ? getPacRevision() : null,
        usesPacMods: options.usesPacMods === true,
        remoteSignature: getDraftRemoteSignature(key),
      };
      state.drafts.set(key, draft);
    } else if (draft.dirty) {
      restoreForm(form, draft.values);
    } else {
      draft.baseline = baseline;
      draft.values = baseline;
      draft.pacRevision = options.usesPacMods ? getPacRevision() : null;
      draft.conflict = false;
      draft.remoteSignature = getDraftRemoteSignature(key);
    }
    const record = () => {
      const current = serializeForm(form);
      draft.values = current;
      draft.dirty = JSON.stringify(current) !== JSON.stringify(draft.baseline);
      if (!draft.dirty) {
        draft.conflict = false;
      }
      updateDraftPresentation();
    };
    form.addEventListener('input', record);
    form.addEventListener('change', record);
    return draft;

  }

  function markDraftDirty(form) {

    const key = form && form.dataset && form.dataset.draftKey;
    const draft = key && state.drafts.get(key);
    if (!draft) {
      return;
    }
    draft.values = serializeForm(form);
    draft.dirty = true;
    updateDraftPresentation();

  }

  function markDraftClean(key, form) {

    const values = form ? serializeForm(form) : [];
    state.drafts.set(key, {
      baseline: values,
      values,
      dirty: false,
      conflict: false,
      pacRevision: getPacRevision(),
      usesPacMods: state.drafts.get(key) &&
        state.drafts.get(key).usesPacMods === true,
      remoteSignature: getDraftRemoteSignature(key),
    });
    updateDraftPresentation();

  }

  function discardAllDrafts() {

    state.drafts.clear();
    setMessage(t('optionsDraftsDiscarded'), 'info');
    render();

  }

  function captureDraftForms() {

    if (typeof root.querySelectorAll !== 'function') {
      return;
    }
    root.querySelectorAll('form[data-draft-key]').forEach((form) => {
      const draft = state.drafts.get(form.dataset.draftKey);
      if (draft && draft.dirty) {
        draft.values = serializeForm(form);
      }
    });

  }

  function markRemoteConflicts(previousRevision, nextRevision, nextSnapshot) {

    const pacChanged = previousRevision !== null &&
      nextRevision !== null && previousRevision !== nextRevision;
    state.drafts.forEach((draft, key) => {
      if (!draft.dirty) {
        return;
      }
      if (draft.usesPacMods && pacChanged) {
        draft.conflict = true;
        return;
      }
      const nextSignature = getDraftRemoteSignature(key, nextSnapshot);
      if (
        draft.remoteSignature !== null &&
        nextSignature !== null &&
        draft.remoteSignature !== nextSignature
      ) {
        draft.conflict = true;
      }
    });

  }

  function getFocusToken() {

    const active = document.activeElement;
    if (!active || !root.contains(active)) {
      return null;
    }
    const stableKey = active.dataset.focusKey || active.id ||
      active.name || null;
    if (stableKey) {
      return {stableKey};
    }
    const form = active.closest('form[data-draft-key]');
    const section = active.closest('[data-options-section]');
    const scope = form || section || root;
    const label = String(active.textContent || '').trim();
    const matches = Array.from(scope.querySelectorAll('button, summary, a'))
        .filter((node) =>
          node.tagName === active.tagName &&
          String(node.type || '') === String(active.type || '') &&
          String(node.textContent || '').trim() === label,
        );
    const index = matches.indexOf(active);
    return index === -1 ? null : {
      draftKey: form && form.dataset.draftKey || null,
      section: section && section.dataset.optionsSection || null,
      tagName: active.tagName,
      type: String(active.type || ''),
      label,
      index,
    };

  }

  function restoreFocus(token) {

    if (!token) {
      return;
    }
    let target = null;
    if (token.stableKey) {
      const candidates = root.querySelectorAll(
          '[data-focus-key], [id], [name]',
      );
      target = Array.from(candidates).find((node) =>
        node.dataset.focusKey === token.stableKey ||
        node.id === token.stableKey ||
        node.name === token.stableKey,
      );
    } else {
      let scope = root;
      if (token.draftKey) {
        scope = Array.from(root.querySelectorAll('form[data-draft-key]'))
            .find((form) => form.dataset.draftKey === token.draftKey) || root;
      } else if (token.section) {
        scope = Array.from(root.querySelectorAll('[data-options-section]'))
            .find((section) =>
              section.dataset.optionsSection === token.section,
            ) || root;
      }
      target = Array.from(scope.querySelectorAll('button, summary, a'))
          .filter((node) =>
            node.tagName === token.tagName &&
            String(node.type || '') === token.type &&
            String(node.textContent || '').trim() === token.label,
          )[token.index] || null;
    }
    if (target && !target.hidden && !target.disabled) {
      target.focus();
    }

  }

  async function refresh(options = {}) {

    const serial = ++state.requestSerial;
    const focusToken = options.restoreFocus === false ? null : getFocusToken();
    captureDraftForms();
    const previousRevision = getPacRevision();
    try {
      const snapshot = await rpc.callBackground('getState');
      if (serial !== state.requestSerial) {
        return;
      }
      await window.mv3I18n.init(snapshot.state && snapshot.state.uiLanguage);
      if (serial !== state.requestSerial) {
        return;
      }
      markRemoteConflicts(
          previousRevision,
          getPacRevision(snapshot),
          snapshot,
      );
      state.snapshot = snapshot;
      updateSetupEligibility();
      if (options.message) {
        state.message = {
          text: options.message,
          tone: options.tone || 'success',
        };
      }
      if (hasDirtyDrafts() && root.querySelector('.options-shell')) {
        updateLiveState();
        updateDraftPresentation();
      } else {
        render();
        restoreFocus(focusToken);
      }
    } catch (error) {
      if (serial !== state.requestSerial) {
        return;
      }
      if (state.snapshot) {
        setMessage(
            t('optionsRefreshFailedDraftsKept'),
            'error',
            () => refresh(),
        );
      } else {
        renderLoadError();
      }
    }

  }

  async function runOperation(key, button, action, options = {}) {

    if (state.pending.has(key)) {
      return null;
    }
    state.pending.add(key);
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      if (button.dataset.busyText) {
        button.textContent = button.dataset.busyText;
      }
    }
    updateDraftPresentation();
    try {
      const result = await action();
      const acceptedStatuses = options.acceptStatuses || [];
      if (
        result &&
        result.ok === false &&
        !acceptedStatuses.includes(result.status)
      ) {
        const operationError = new Error('Operation rejected.');
        operationError.code = result.error && result.error.code ||
          result.code || result.status;
        throw operationError;
      }
      state.retry = null;
      return result;
    } catch (error) {
      const message = getSafeError(error, options.context);
      setMessage(
          message,
          'error',
          options.retry ? () => options.retry() : null,
      );
      if (/stale|revision/i.test(String(error && error.message || '')) ||
          error && error.code === 'PAC_APPLY_STALE') {
        const draft = options.draftKey &&
          state.drafts.get(options.draftKey);
        if (draft) {
          draft.conflict = true;
        }
      }
      return null;
    } finally {
      state.pending.delete(key);
      if (button && button.parentNode) {
        button.removeAttribute('aria-busy');
        button.disabled = false;
        if (button.dataset.idleText) {
          button.textContent = button.dataset.idleText;
        }
      }
      updateDraftPresentation();
    }

  }

  function installGlobalListeners() {

    if (state.listenersInstalled) {
      return;
    }
    state.listenersInstalled = true;
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('hashchange', () => {
        activateHashTarget(true);
      });
      window.addEventListener('beforeunload', (event) => {
        if (!hasDirtyDrafts()) {
          return;
        }
        event.preventDefault();
        event.returnValue = '';
      });
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          refresh();
        }
      });
    }
    if (
      chrome.storage && chrome.storage.onChanged &&
      typeof chrome.storage.onChanged.addListener === 'function'
    ) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local' && changes && changes.mv3State) {
          refresh();
        }
      });
    }
    if (
      chrome.proxy && chrome.proxy.settings &&
      chrome.proxy.settings.onChange &&
      typeof chrome.proxy.settings.onChange.addListener === 'function'
    ) {
      chrome.proxy.settings.onChange.addListener(() => {
        refresh();
      });
    }

  }

  function getHashTarget() {

    const section = String(window.location.hash || '').replace(/^#/, '');
    if (NAV_ITEMS.some((item) => item[0] === section)) {
      return {section};
    }
    return HASH_ALIASES[section] || {section: 'overview'};

  }

  function activateHashTarget(moveFocus) {

    const target = getHashTarget();
    activateSection(target.section, moveFocus, target);

  }

  function activateSection(sectionId, moveFocus, target = {}) {

    const next = NAV_ITEMS.some((item) => item[0] === sectionId) ?
      sectionId :
      'overview';
    state.activeSection = next;
    root.querySelectorAll('[data-options-section]').forEach((section) => {
      section.hidden = section.dataset.optionsSection !== next;
    });
    root.querySelectorAll('.options-nav a').forEach((link) => {
      if (link.dataset.section === next) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
    const select = root.querySelector('#options-section-select');
    if (select) {
      select.value = next;
    }
    const actionBar = root.querySelector('#global-action-bar');
    if (actionBar && state.snapshot) {
      actionBar.replaceChildren();
      renderGlobalActionBarContents(actionBar);
    }
    if (target.openDisclosure) {
      state.openDisclosures.add(target.openDisclosure);
      const details = root.querySelector(
          `[data-disclosure-key="${target.openDisclosure}"]`,
      );
      if (details) {
        details.open = true;
      }
    }
    if (moveFocus) {
      const heading = root.querySelector(
          `#${target.focusId || `${next}-heading`}`,
      );
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }
    }

  }

  function renderLoading() {

    root.replaceChildren();
    root.setAttribute('aria-busy', 'true');
    const card = append(root, 'section', 'loading-shell ui-card');
    appendText(card, 'h1', t('popupTitle'));
    appendText(card, 'p', t('optionsLoadingPage'));
    append(card, 'div', 'loading-line short');
    append(card, 'div', 'loading-line');
    append(card, 'div', 'loading-line');

  }

  function renderLoadError() {

    root.replaceChildren();
    root.removeAttribute('aria-busy');
    const card = append(root, 'section', 'loading-shell ui-card');
    appendText(card, 'h1', t('optionsLoadFailedTitle'));
    appendText(card, 'p', t('optionsLoadFailedHelp'));
    const button = createButton(
        card,
        t('popupRetry'),
        'primary',
    );
    button.onclick = () => refresh({restoreFocus: false});

  }

  function render() {

    if (!state.snapshot) {
      renderLoading();
      return;
    }
    fieldId = 0;
    root.replaceChildren();
    root.removeAttribute('aria-busy');
    document.title = t('optionsPageTitle');
    const shell = append(root, 'div', 'options-shell');
    renderHeader(shell);
    renderMessageBanner(shell);
    const layout = append(shell, 'div', 'options-layout');
    renderNavigation(layout);
    const main = append(layout, 'div', 'options-main');
    renderMobileNavigation(main);
    renderOverviewSection(main);
    renderRoutingSourcesSection(main);
    renderSiteRulesSection(main);
    renderProxyMethodsSection(main);
    renderMaintenanceSection(main);
    renderAdvancedSection(main);
    renderAboutSection(main);
    renderGlobalActionBar(main);
    append(shell, 'div', 'ui-sr-only').setAttribute('aria-live', 'polite');
    activateHashTarget(false);
    updateDraftPresentation();

  }

  function renderHeader(parent) {

    const header = append(parent, 'header', 'options-header');
    const copy = append(header, 'div', 'options-header-copy');
    appendText(copy, 'h1', t('optionsPageTitle'));
    appendText(copy, 'p', t('optionsPageSubtitle'), 'options-subtitle');
    const language = append(header, 'label', 'language-field');
    appendText(language, 'span', t('optionsLanguage'));
    const select = append(language, 'select', 'ui-input');
    select.setAttribute('aria-label', t('optionsLanguage'));
    [
      ['auto', t('optionsLanguageAuto')],
      ['ru', t('optionsLanguageRu')],
      ['en', t('optionsLanguageEn')],
    ].forEach(([value, label]) => {
      const option = appendText(select, 'option', label);
      option.value = value;
    });
    select.value = state.snapshot.state.uiLanguage || 'auto';
    select.onchange = async () => {
      if (hasDirtyDrafts() && !window.confirm(
          t('optionsConfirmLanguageWithDrafts'),
      )) {
        select.value = state.snapshot.state.uiLanguage || 'auto';
        return;
      }
      const result = await runOperation(
          'language',
          select,
          () => rpc.callBackground('setUiLanguage', {
            language: select.value,
          }),
      );
      if (result) {
        window.location.reload();
      }
    };

  }

  function renderNavigation(parent) {

    const nav = append(parent, 'nav', 'options-nav ui-card');
    nav.setAttribute('aria-label', t('optionsNavigationLabel'));
    NAV_ITEMS.forEach(([id, labelKey]) => {
      const link = appendText(nav, 'a', t(labelKey));
      link.href = `#${id}`;
      link.dataset.section = id;
      link.dataset.focusKey = `nav-${id}`;
      link.onclick = (event) => {
        event.preventDefault();
        navigateTo(id);
      };
    });

  }

  function renderMobileNavigation(parent) {

    const label = append(parent, 'label', 'mobile-nav');
    appendText(label, 'span', t('optionsNavigationLabel'), 'field-label');
    const select = append(label, 'select', 'ui-input');
    select.id = 'options-section-select';
    NAV_ITEMS.forEach(([id, labelKey]) => {
      const option = appendText(select, 'option', t(labelKey));
      option.value = id;
    });
    select.value = state.activeSection;
    select.onchange = () => {
      navigateTo(select.value);
    };

  }

  function createPageSection(parent, id, titleKey, descriptionKey) {

    const section = append(parent, 'section', 'page-section');
    section.dataset.optionsSection = id;
    section.id = id;
    section.setAttribute('aria-labelledby', `${id}-heading`);
    const header = append(section, 'header', 'section-header');
    const heading = appendText(header, 'h2', t(titleKey));
    heading.id = `${id}-heading`;
    appendText(header, 'p', t(descriptionKey), 'section-description');
    return section;

  }

  function createButton(parent, label, variant = '', busyText) {

    const button = appendText(
        parent,
        'button',
        label,
        `ui-button${variant ? ` ${variant}` : ''}`,
    );
    button.type = 'button';
    button.dataset.idleText = label;
    button.dataset.busyText = busyText || label;
    return button;

  }

  function createDetails(parent, key, summary) {

    const details = append(parent, 'details', 'disclosure');
    details.dataset.disclosureKey = key;
    details.open = state.openDisclosures.has(key);
    const summaryNode = appendText(details, 'summary', summary);
    details.addEventListener('toggle', () => {
      if (details.open) {
        state.openDisclosures.add(key);
      } else {
        state.openDisclosures.delete(key);
      }
    });
    const content = append(details, 'div', 'disclosure-content');
    return {details, summary: summaryNode, content};

  }

  function renderMessageBanner(parent) {

    const banner = append(parent, 'div', 'status-banner info');
    banner.id = 'options-message';
    banner.setAttribute('role', 'status');
    populateMessageBanner(banner);

  }

  function updateMessageBanner() {

    const banner = root.querySelector('#options-message');
    if (!banner) {
      return;
    }
    banner.replaceChildren();
    populateMessageBanner(banner);

  }

  function populateMessageBanner(banner) {

    if (!state.message) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.className = `status-banner ${state.message.tone}`;
    appendText(banner, 'span', state.message.text);
    if (state.retry) {
      const retry = createButton(banner, t('popupRetry'), 'quiet');
      retry.onclick = () => state.retry && state.retry();
    }

  }

  function deriveControlView() {

    const snapshot = state.snapshot || {};
    const stored = snapshot.state || {};
    const proxy = snapshot.proxy || {};
    const control = proxy.proxyControl || stored.proxyControl || {};
    const apply = proxy.proxyApply || stored.proxyApply || {};
    const stale = proxy.stale && proxy.stale.cookedPac ||
      snapshot.stale && snapshot.stale.cookedPac || {};
    const rawMode = control.rawValue && control.rawValue.mode;
    const controlsPac = control.controlledByThisExtension === true &&
      rawMode === 'pac_script';
    const external = control.controlledByThisExtension !== true &&
      control.canControl !== true &&
      ['controlled_by_other_extensions', 'not_controllable']
          .includes(control.levelOfControl);
    const busyStatus = String(apply.status || 'idle');
    if (external) {
      const ifCleared = busyStatus === 'cleared';
      return {
        kind: 'external',
        tone: 'error',
        title: t(ifCleared ? 'popupControlOff' : 'popupControlExternal'),
        help: t(ifCleared ?
          'popupControlExternalClearedHelp' :
          'popupControlExternalHelp'),
        controlsPac: false,
        external: true,
        clearAvailable: busyStatus !== 'cleared',
        clearDeferred: ifCleared,
        busy: false,
        stale: Boolean(stale.stale),
      };
    }
    if (busyStatus === 'applying') {
      return {
        kind: 'applying',
        tone: 'warning',
        title: t('popupControlApplying'),
        help: t('popupControlApplyingHelp'),
        controlsPac,
        external: false,
        busy: true,
        stale: Boolean(stale.stale),
      };
    }
    if (busyStatus === 'clearing') {
      return {
        kind: 'clearing',
        tone: 'warning',
        title: t('popupControlClearing'),
        help: t('popupControlClearingHelp'),
        controlsPac,
        external: false,
        busy: true,
        stale: Boolean(stale.stale),
      };
    }
    if (busyStatus === 'error') {
      return {
        kind: 'error',
        tone: 'error',
        title: t('popupControlError'),
        help: t('optionsControlErrorHelp'),
        controlsPac,
        external: false,
        busy: false,
        stale: Boolean(stale.stale),
      };
    }
    if (stale.stale) {
      return {
        kind: 'stale',
        tone: 'warning',
        title: t('popupControlStale'),
        help: controlsPac ?
          t('popupControlStaleActiveHelp') :
          t('popupControlStaleOffHelp'),
        controlsPac,
        external: false,
        busy: false,
        stale: true,
      };
    }
    if (apply.status === 'applied' && controlsPac) {
      return {
        kind: 'active',
        tone: 'success',
        title: t('popupControlActive'),
        help: t('popupControlActiveHelp'),
        controlsPac: true,
        external: false,
        busy: false,
        stale: false,
      };
    }
    return {
      kind: 'off',
      tone: 'neutral',
      title: t('popupControlOff'),
      help: t('popupControlOffHelp'),
      controlsPac: false,
      external: false,
      busy: false,
      stale: false,
    };

  }

  function getProviders() {

    return Array.isArray(state.snapshot && state.snapshot.providers) ?
      state.snapshot.providers :
      [];

  }

  function getProviderLabel(provider) {

    if (!provider) {
      return t('popupNotSelected');
    }
    if (provider.key === 'onlyOwnSites') {
      return t('providerOnlyOwnSitesLabel');
    }
    return provider.label || provider.key;

  }

  function getSelectedProvider() {

    const key = state.snapshot.state.currentPacProviderKey;
    return getProviders().find((provider) => provider.key === key) || null;

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
    return provider.description || t('optionsNoDescription');

  }

  function getDurableProxyApply() {

    return state.snapshot && state.snapshot.state &&
      state.snapshot.state.proxyApply || {};

  }

  function ifPristineInitialSetup() {

    const apply = getDurableProxyApply();
    return String(apply.status || 'idle') === 'idle' &&
      !apply.providerKey &&
      !apply.cookedPacSha256 &&
      !apply.appliedAt &&
      !apply.clearedAt &&
      !apply.error;

  }

  function updateSetupEligibility() {

    if (!state.setupEligibilityInitialized) {
      state.setupEligible = ifPristineInitialSetup();
      state.setupEligibilityInitialized = true;
    }
    const view = deriveControlView();
    const apply = getDurableProxyApply();
    if (
      view.controlsPac ||
      ['applied', 'cleared'].includes(String(apply.status || 'idle'))
    ) {
      state.setupEligible = false;
    }

  }

  function ifShowInitialSetup() {

    const view = deriveControlView();
    return state.setupEligible && !view.external && !view.controlsPac;

  }

  function getHealthView() {

    const health = state.snapshot.reliability &&
      state.snapshot.reliability.proxyHealth || {};
    if (health.status === 'ok') {
      return {tone: 'success', text: t('popupProxyHealthOk')};
    }
    if (health.status === 'error') {
      return {tone: 'error', text: t('popupProxyHealthError')};
    }
    if (health.status === 'checking') {
      return {tone: 'warning', text: t('popupProxyHealthChecking')};
    }
    return {tone: '', text: t('popupProxyHealthUnknown')};

  }

  function appendSummaryItem(parent, label, value, liveKey) {

    const item = append(parent, 'div', 'summary-item');
    appendText(item, 'span', label, 'compact-label');
    const output = appendText(item, 'span', value, 'summary-value');
    if (liveKey) {
      output.dataset.liveValue = liveKey;
    }
    return output;

  }

  function renderOverviewSection(parent) {

    const section = createPageSection(
        parent,
        'overview',
        'optionsNavOverview',
        'optionsOverviewDescription',
    );
    renderInitialSetupCard(section);
    const view = deriveControlView();
    const card = append(section, 'div', `settings-card ui-card status-card ${
      view.tone
    }`);
    const heading = append(card, 'div', 'status-heading');
    const titleWrap = append(heading, 'div');
    const title = appendText(titleWrap, 'div', view.title, 'status-title');
    title.dataset.liveValue = 'control-title';
    const help = appendText(titleWrap, 'p', view.help, 'status-copy');
    help.dataset.liveValue = 'control-help';
    const pill = appendText(
        heading,
        'span',
        getControlPillLabel(view),
        `ui-pill ${view.tone === 'neutral' ? '' : view.tone}`,
    );
    pill.dataset.liveValue = 'control-pill';
    const grid = append(card, 'div', 'summary-grid');
    appendSummaryItem(
        grid,
        t('optionsActiveRoutingSource'),
        getProviderLabel(getSelectedProvider()),
        'provider',
    );
    appendSummaryItem(
        grid,
        t('popupProxyHealth'),
        getHealthView().text,
        'health',
    );
    const autoUpdate = state.snapshot.reliability &&
      state.snapshot.reliability.autoUpdate || {};
    appendSummaryItem(
        grid,
        t('optionsLastSuccessfulPacUpdate'),
        formatTime(autoUpdate.lastSuccessfulUpdateAt),
        'updated',
    );
    appendSummaryItem(
        grid,
        t('optionsSavedConfiguration'),
        view.stale ? t('optionsApplyRequired') : t('optionsConfigurationCurrent'),
        'freshness',
    );
    if (!getSelectedProvider() && !ifShowInitialSetup()) {
      const warning = append(card, 'div', 'status-banner warning');
      warning.setAttribute('role', 'status');
      appendText(warning, 'strong', t('optionsChooseSourceTitle'));
      appendText(warning, 'p', t('optionsChooseSourceHelp'));
      const button = createButton(
          warning,
          t('optionsGoToRoutingSources'),
          'quiet',
      );
      button.onclick = () => navigateTo('routing-sources');
    }

  }

  function renderInitialSetupCard(parent) {

    if (!ifShowInitialSetup()) {
      return;
    }
    const provider = getSelectedProvider();
    const view = deriveControlView();
    const card = append(parent, 'section', 'settings-card ui-card setup-card');
    card.id = 'initial-setup-card';
    card.setAttribute('aria-labelledby', 'initial-setup-heading');
    const header = append(card, 'div', 'setup-header');
    const copy = append(header, 'div');
    const heading = appendText(copy, 'h3', t('optionsSetupTitle'));
    heading.id = 'initial-setup-heading';
    appendText(copy, 'p', t('optionsSetupIntro'), 'section-description');
    appendText(header, 'span', t('optionsSetupStatus'), 'ui-pill');
    const steps = append(card, 'ol', 'setup-steps');
    renderSetupSourceStep(steps, provider);
    renderSetupProxyStep(steps);
    renderSetupApplyStep(steps, provider, view);

  }

  function createSetupStep(parent, number, title, description, status, tone) {

    const item = append(parent, 'li', `setup-step ${tone || ''}`.trim());
    const marker = appendText(item, 'span', String(number), 'setup-step-marker');
    marker.setAttribute('aria-hidden', 'true');
    const body = append(item, 'div', 'setup-step-body');
    const header = append(body, 'div', 'setup-step-header');
    appendText(header, 'h4', title);
    appendText(
        header,
        'span',
        status,
        `setup-step-status ${tone || ''}`.trim(),
    );
    appendText(body, 'p', description, 'section-description');
    return body;

  }

  function renderSetupSourceStep(parent, provider) {

    const selected = Boolean(provider);
    const body = createSetupStep(
        parent,
        1,
        t('optionsSetupSourceTitle'),
        t('optionsSetupSourceHelp'),
        selected ?
          t('optionsSetupSourceSelected', [getProviderLabel(provider)]) :
          t('optionsSetupSourceNotSelected'),
        selected ? 'complete' : 'current',
    );
    const action = createButton(
        body,
        t(selected ? 'optionsSetupChangeSource' : 'optionsGoToRoutingSources'),
        'quiet setup-step-action',
    );
    action.onclick = () => navigateTo('routing-sources');

  }

  function renderSetupProxyStep(parent) {

    const count = getProxyCandidateCount();
    const status = count ?
      formatCount(
          count,
          'optionsSetupOneProxyConnection',
          'optionsSetupManyProxyConnections',
      ) :
      t('optionsSetupNoProxyConnections');
    const body = createSetupStep(
        parent,
        2,
        t('optionsSetupProxyTitle'),
        t('optionsSetupProxyHelp'),
        status,
        'optional',
    );
    const action = createButton(
        body,
        t('optionsSetupConfigureProxies'),
        'quiet setup-step-action',
    );
    action.onclick = () => navigateTo('proxy-methods');

  }

  function getSetupApplyStatus(provider, view) {

    if (!provider) {
      return t('optionsSetupWaitingForSource');
    }
    if (state.pending.has('configuration:apply') || view.kind === 'applying') {
      return t('optionsSetupApplying');
    }
    if (
      view.kind === 'error' ||
      state.message && state.message.tone === 'error'
    ) {
      return t('optionsSetupApplyError');
    }
    if (hasDirtyDrafts()) {
      return t('optionsSetupSaveChangesFirst');
    }
    return t('optionsSetupReadyToApply');

  }

  function renderSetupApplyStep(parent, provider, view) {

    const ifApplying = state.pending.has('configuration:apply') ||
      view.kind === 'applying';
    const body = createSetupStep(
        parent,
        3,
        t('optionsSetupApplyTitle'),
        t('optionsSetupApplyHelp'),
        getSetupApplyStatus(provider, view),
        provider ? 'current' : '',
    );
    const status = body.querySelector('.setup-step-status');
    status.dataset.setupApplyStatus = 'true';
    if (!provider) {
      return;
    }
    const apply = createButton(
        body,
        t('optionsApplyConfiguration'),
        'primary setup-step-action',
        t('optionsApplyingConfiguration'),
    );
    apply.dataset.setupApplyAction = 'true';
    apply.disabled = ifApplying || hasDirtyDrafts();
    apply.onclick = () => applyConfiguration(apply);

  }

  function getControlPillLabel(view) {

    const keys = {
      active: 'optionsStateActive',
      off: 'optionsStateOff',
      external: 'optionsStateExternal',
      applying: 'optionsStateApplying',
      clearing: 'optionsStateApplying',
      stale: 'optionsStateNeedsApply',
      error: 'optionsStateNeedsAttention',
    };
    return t(keys[view.kind] || 'optionsStateOff');

  }

  function navigateTo(section) {

    window.location.hash = section;
    activateSection(section, true);

  }

  function updateLiveState() {

    const view = deriveControlView();
    const values = {
      'control-title': view.title,
      'control-help': view.help,
      'control-pill': getControlPillLabel(view),
      'provider': getProviderLabel(getSelectedProvider()),
      'health': getHealthView().text,
      'updated': formatTime(
          state.snapshot.reliability &&
          state.snapshot.reliability.autoUpdate &&
          state.snapshot.reliability.autoUpdate.lastSuccessfulUpdateAt,
      ),
      'freshness': view.stale ?
        t('optionsApplyRequired') :
        t('optionsConfigurationCurrent'),
    };
    root.querySelectorAll('[data-live-value]').forEach((node) => {
      if (Object.prototype.hasOwnProperty.call(
          values,
          node.dataset.liveValue,
      )) {
        node.textContent = values[node.dataset.liveValue];
      }
    });
    updateMessageBanner();
    const bar = root.querySelector('#global-action-bar');
    if (bar) {
      bar.replaceChildren();
      renderGlobalActionBarContents(bar);
    }

  }

  function renderRoutingSourcesSection(parent) {

    const section = createPageSection(
        parent,
        'routing-sources',
        'optionsNavRoutingSources',
        'optionsRoutingSourcesDescription',
    );
    const providers = getProviders();
    const builtIn = providers.filter((provider) =>
      provider.type === 'builtIn',
    );
    const custom = providers.filter((provider) =>
      provider.type === 'custom',
    );
    const builtInCard = append(section, 'div', 'settings-card ui-card');
    appendText(builtInCard, 'h3', t('optionsBuiltInProviders'));
    appendText(
        builtInCard,
        'p',
        t('optionsBuiltInProvidersHelp'),
        'section-description',
    );
    const list = append(builtInCard, 'fieldset', 'source-choice-group');
    appendText(list, 'legend', t('optionsChooseAutomaticSource'));
    builtIn.forEach((provider) => renderProviderChoice(list, provider));
    const customCard = append(section, 'div', 'settings-card ui-card');
    const customHeader = append(customCard, 'div', 'card-header');
    appendText(customHeader, 'h3', t('optionsCustomProviders'));
    if (!custom.length) {
      const empty = append(customCard, 'div', 'empty-state');
      appendText(empty, 'p', t('optionsNoCustomProviders'), 'item-title');
      appendText(empty, 'p', t('optionsNoCustomProvidersHelp'));
    } else {
      const customList = append(customCard, 'div', 'settings-list');
      custom.forEach((provider) =>
        renderCustomProviderEditor(customList, provider),
      );
    }
    renderAddProviderEditor(customCard);

  }

  function renderProviderChoice(parent, provider) {

    const selected = state.snapshot.state.currentPacProviderKey === provider.key;
    const choice = append(
        parent,
        'label',
        `source-choice${selected ? ' selected' : ''}`,
    );
    const input = append(choice, 'input', 'source-choice-input');
    input.type = 'radio';
    input.name = 'automatic-routing-source';
    input.value = provider.key;
    input.checked = selected;
    input.disabled = provider.enabled === false;
    const content = append(choice, 'div', 'source-choice-content');
    const header = append(content, 'div', 'source-choice-header');
    const copy = append(header, 'div');
    appendText(copy, 'div', getProviderLabel(provider), 'item-title');
    appendText(copy, 'p', getProviderDescription(provider), 'item-meta');
    const status = appendText(
        header,
        'span',
        selected ? t('optionsSelected') : t('optionsAvailable'),
        selected ? 'ui-pill success' : 'scope-badge',
    );
    status.dataset.sourceChoiceStatus = provider.key;
    input.onchange = () => {
      if (!input.checked) {
        return;
      }
      selectProvider(provider.key, input);
    };

  }

  async function selectProvider(providerKey, button) {

    const result = await runOperation(
        'select-provider',
        button,
        () => rpc.callBackground('setCurrentPacProvider', {providerKey}),
        {context: 'provider'},
    );
    if (result) {
      await refresh({
        message: t('optionsRoutingSourceSaved'),
        tone: 'success',
      });
      return;
    }
    root.querySelectorAll('input[name="automatic-routing-source"]')
        .forEach((input) => {
          input.checked = input.value ===
            state.snapshot.state.currentPacProviderKey;
        });

  }

  function renderCustomProviderEditor(parent, provider) {

    const disclosure = createDetails(
        parent,
        `provider-${provider.key}`,
        getProviderLabel(provider),
    );
    const summary = append(disclosure.content, 'div', 'item-header');
    appendText(
        summary,
        'span',
        formatCount(
            (provider.urls || []).length,
            'optionsOneSourceAddress',
            'optionsManySourceAddresses',
        ),
        'item-meta',
    );
    appendText(
        summary,
        'span',
        provider.enabled ? t('optionsEnabled') : t('optionsDisabled'),
        provider.enabled ? 'ui-pill success' : 'scope-badge',
    );
    const form = append(disclosure.content, 'form', 'field-grid');
    form.onsubmit = (event) => event.preventDefault();
    const key = `provider:${provider.key}`;
    const name = appendField(
        form,
        'text',
        `provider.${provider.key}.label`,
        t('optionsProviderName'),
        provider.label,
        {required: true},
    );
    appendField(
        form,
        'text',
        `provider.${provider.key}.description`,
        t('optionsProviderDescription'),
        provider.description || '',
    );
    const urls = appendField(
        form,
        'textarea',
        `provider.${provider.key}.urls`,
        t('optionsPacUrls'),
        (provider.urls || []).join('\n'),
        {
          full: true,
          help: t('optionsPacUrlsSafeHelp'),
          required: true,
        },
    );
    const enabled = appendCheckbox(
        form,
        `provider.${provider.key}.enabled`,
        t('optionsCustomProviderEnabled'),
        provider.enabled !== false,
        t('optionsCustomProviderEnabledHelp'),
        'full',
    );
    const actions = append(form, 'div', 'provider-actions full');
    const save = createButton(
        actions,
        t('optionsSaveSource'),
        'primary',
        t('optionsSaving'),
    );
    save.onclick = () => saveCustomProvider({
      provider,
      form,
      draftKey: key,
      name,
      urls,
      enabled,
      button: save,
    });
    const duplicate = createButton(
        actions,
        t('optionsDuplicateSource'),
        'quiet',
    );
    duplicate.onclick = () => copyProviderToAddDraft(provider);
    const use = createButton(
        actions,
        state.snapshot.state.currentPacProviderKey === provider.key ?
          t('optionsSelected') :
          t('optionsUseSource'),
        'quiet',
        t('optionsSaving'),
    );
    use.disabled = state.snapshot.state.currentPacProviderKey === provider.key ||
      provider.enabled === false;
    use.onclick = () => selectProvider(provider.key, use);
    const remove = createButton(
        actions,
        t('optionsDeleteSource'),
        'danger quiet',
        t('optionsDeleting'),
    );
    remove.onclick = () => deleteCustomProvider(provider, remove);
    bindDraftForm(form, key);
    renderDraftConflict(form, key);

  }

  function renderAddProviderEditor(parent) {

    const disclosure = createDetails(
        parent,
        'provider-add',
        t('optionsAddCustomProvider'),
    );
    appendText(
        disclosure.content,
        'p',
        t('optionsCustomSourceTrustHelp'),
        'status-banner warning',
    );
    const form = append(disclosure.content, 'form', 'field-grid');
    form.onsubmit = (event) => event.preventDefault();
    const name = appendField(
        form,
        'text',
        'newProvider.label',
        t('optionsProviderName'),
        '',
        {required: true},
    );
    appendField(
        form,
        'text',
        'newProvider.description',
        t('optionsProviderDescription'),
        '',
    );
    const urls = appendField(
        form,
        'textarea',
        'newProvider.urls',
        t('optionsPacUrls'),
        '',
        {
          full: true,
          help: t('optionsPacUrlsSafeHelp'),
          required: true,
          placeholder: 'https://example.com/proxy.pac',
        },
    );
    const actions = append(form, 'div', 'provider-actions full');
    const saveAndUse = createButton(
        actions,
        t('optionsSaveAndUse'),
        'primary',
        t('optionsSaving'),
    );
    const saveOnly = createButton(
        actions,
        t('optionsSaveOnly'),
        '',
        t('optionsSaving'),
    );
    saveAndUse.onclick = () => addCustomProvider(
        form,
        name,
        urls,
        saveAndUse,
        true,
    );
    saveOnly.onclick = () => addCustomProvider(
        form,
        name,
        urls,
        saveOnly,
        false,
    );
    bindDraftForm(form, 'provider:add');

  }

  function splitProviderUrls(value) {

    return String(value || '').split(/[\n,]+/g)
        .map((url) => url.trim())
        .filter(Boolean);

  }

  function validateProviderForm(form, nameInput, urlsInput) {

    clearValidation(form);
    let valid = true;
    if (!nameInput.value.trim()) {
      showFieldError(nameInput, t('optionsProviderNameRequired'));
      valid = false;
    }
    const urls = splitProviderUrls(urlsInput.value);
    if (!urls.length) {
      showFieldError(urlsInput, t('optionsProviderUrlRequired'));
      return null;
    }
    const seen = new Set();
    for (const value of urls) {
      try {
        const parsed = new URL(value);
        const loopback = parsed.hostname === 'localhost' ||
          parsed.hostname === '::1' ||
          parsed.hostname.startsWith('127.');
        if (parsed.username || parsed.password) {
          showFieldError(urlsInput, t('optionsProviderUrlCredentials'));
          return null;
        }
        if (parsed.protocol !== 'https:' &&
            !(parsed.protocol === 'http:' && loopback)) {
          showFieldError(urlsInput, t('optionsProviderUrlScheme'));
          return null;
        }
      } catch (error) {
        showFieldError(urlsInput, t('optionsProviderUrlInvalid'));
        return null;
      }
      if (seen.has(value)) {
        showFieldError(urlsInput, t('optionsProviderDuplicateUrls'));
        return null;
      }
      seen.add(value);
    }
    if (!valid) {
      nameInput.focus();
      return null;
    }
    return urls;

  }

  async function saveCustomProvider(options) {

    const urls = validateProviderForm(
        options.form,
        options.name,
        options.urls,
    );
    if (!urls) {
      setMessage(t('optionsValidationFailed'), 'error');
      return;
    }
    const description = options.form.querySelector(
        `[name="provider.${options.provider.key}.description"]`,
    );
    const result = await runOperation(
        `provider:${options.provider.key}:save`,
        options.button,
        () => rpc.callBackground('updateCustomPacProvider', {
          key: options.provider.key,
          label: options.name.value.trim(),
          description: description.value.trim(),
          urls,
          enabled: options.enabled.checked,
        }),
        {
          context: 'provider',
          draftKey: options.draftKey,
          retry: () => saveCustomProvider(options),
        },
    );
    if (result) {
      markDraftClean(options.draftKey, options.form);
      await refresh({
        message: result.selectedProviderCleared ?
          t('optionsSelectedProviderCleared') :
          t('optionsCustomProviderUpdated'),
        tone: 'success',
      });
    }

  }

  async function addCustomProvider(form, name, urlsInput, button, ifUse) {

    const urls = validateProviderForm(form, name, urlsInput);
    if (!urls) {
      setMessage(t('optionsValidationFailed'), 'error');
      return;
    }
    const description = form.querySelector(
        '[name="newProvider.description"]',
    );
    const result = await runOperation(
        'provider:add',
        button,
        () => rpc.callBackground('addCustomPacProvider', {
          label: name.value.trim(),
          description: description.value.trim(),
          urls,
        }),
        {
          context: 'provider',
          draftKey: 'provider:add',
          retry: () => addCustomProvider(
              form,
              name,
              urlsInput,
              button,
              ifUse,
          ),
        },
    );
    if (!result) {
      return;
    }
    if (ifUse && result.provider && result.provider.key) {
      const selected = await runOperation(
          'select-provider',
          button,
          () => rpc.callBackground('setCurrentPacProvider', {
            providerKey: result.provider.key,
          }),
          {context: 'provider'},
      );
      if (!selected) {
        state.drafts.delete('provider:add');
        await refresh({
          message: t('optionsSourceSavedNotSelected'),
          tone: 'warning',
        });
        return;
      }
    }
    state.drafts.delete('provider:add');
    state.openDisclosures.delete('provider-add');
    await refresh({
      message: ifUse ?
        t('optionsSourceSavedAndSelected') :
        t('optionsCustomProviderAdded'),
      tone: 'success',
    });

  }

  function copyProviderToAddDraft(provider) {

    state.openDisclosures.add('provider-add');
    const baseline = [
      {
        name: 'newProvider.label',
        type: 'text',
        value: t('optionsProviderCopyName', [provider.label]),
        checked: false,
      },
      {
        name: 'newProvider.description',
        type: 'text',
        value: provider.description || '',
        checked: false,
      },
      {
        name: 'newProvider.urls',
        type: 'textarea',
        value: (provider.urls || []).join('\n'),
        checked: false,
      },
    ];
    state.drafts.set('provider:add', {
      baseline: [],
      values: baseline,
      dirty: true,
      conflict: false,
      pacRevision: null,
      usesPacMods: false,
    });
    render();
    navigateTo('routing-sources');

  }

  async function deleteCustomProvider(provider, button) {

    const selected = state.snapshot.state.currentPacProviderKey === provider.key;
    const message = selected ?
      t('optionsConfirmDeleteSelectedSource', [provider.label]) :
      t('optionsConfirmDeleteCustomProvider', [provider.label]);
    if (!window.confirm(message)) {
      return;
    }
    const result = await runOperation(
        `provider:${provider.key}:delete`,
        button,
        () => rpc.callBackground('deleteCustomPacProvider', {
          key: provider.key,
        }),
        {context: 'provider'},
    );
    if (result) {
      state.drafts.delete(`provider:${provider.key}`);
      await refresh({
        message: result.selectedProviderCleared ?
          t('optionsSelectedProviderDeleted') :
          t('optionsCustomProviderDeleted'),
        tone: 'success',
      });
    }

  }

  function appendField(parent, type, name, labelText, value, options = {}) {

    const group = append(
        parent,
        'label',
        `field-group${options.full ? ' full' : ''}`,
    );
    const label = appendText(group, 'span', labelText, 'field-label');
    const input = append(
        group,
        type === 'textarea' ? 'textarea' : 'input',
        'ui-input',
    );
    fieldId += 1;
    input.id = `options-field-${fieldId}`;
    label.setAttribute('for', input.id);
    input.name = name;
    if (type !== 'textarea') {
      input.type = type;
    }
    input.value = value === null || value === undefined ? '' : String(value);
    if (options.required) {
      input.required = true;
      input.setAttribute('aria-required', 'true');
    }
    if (options.placeholder) {
      input.placeholder = options.placeholder;
    }
    if (options.autocomplete) {
      input.autocomplete = options.autocomplete;
    }
    if (options.min !== undefined) {
      input.min = String(options.min);
    }
    if (options.max !== undefined) {
      input.max = String(options.max);
    }
    if (options.help) {
      const help = appendText(group, 'span', options.help, 'field-help');
      help.id = `${input.id}-help`;
      input.setAttribute('aria-describedby', help.id);
    }
    return input;

  }

  function appendSelect(parent, name, labelText, entries, value, options = {}) {

    const group = append(
        parent,
        'label',
        `field-group${options.full ? ' full' : ''}`,
    );
    const label = appendText(group, 'span', labelText, 'field-label');
    const select = append(group, 'select', 'ui-input');
    fieldId += 1;
    select.id = `options-field-${fieldId}`;
    label.setAttribute('for', select.id);
    select.name = name;
    entries.forEach((entry) => {
      const option = appendText(
          select,
          'option',
          Array.isArray(entry) ? entry[1] : entry,
      );
      option.value = Array.isArray(entry) ? entry[0] : entry;
    });
    select.value = value;
    if (options.help) {
      const help = appendText(group, 'span', options.help, 'field-help');
      help.id = `${select.id}-help`;
      select.setAttribute('aria-describedby', help.id);
    }
    return select;

  }

  function appendCheckbox(
      parent,
      name,
      labelText,
      checked,
      help,
      className = '',
  ) {

    const label = append(
        parent,
        'label',
        `check-row${className ? ` ${className}` : ''}`,
    );
    const input = append(label, 'input');
    input.type = 'checkbox';
    input.name = name;
    input.checked = checked === true;
    const copy = append(label, 'span', 'check-row-copy');
    appendText(copy, 'span', labelText);
    if (help) {
      appendText(copy, 'small', help);
    }
    return input;

  }

  function clearValidation(form) {

    form.querySelectorAll('.validation-message').forEach((message) => {
      message.remove();
    });
    form.querySelectorAll('[aria-invalid="true"]').forEach((input) => {
      input.removeAttribute('aria-invalid');
      const described = String(input.getAttribute('aria-describedby') || '')
          .split(/\s+/g)
          .filter((id) => id && !id.endsWith('-error'));
      if (described.length) {
        input.setAttribute('aria-describedby', described.join(' '));
      } else {
        input.removeAttribute('aria-describedby');
      }
    });

  }

  function showFieldError(input, message) {

    input.setAttribute('aria-invalid', 'true');
    const error = appendText(
        input.parentNode,
        'span',
        message,
        'validation-message',
    );
    error.id = `${input.id}-error`;
    const described = String(input.getAttribute('aria-describedby') || '')
        .split(/\s+/g)
        .filter(Boolean);
    described.push(error.id);
    input.setAttribute('aria-describedby', described.join(' '));

  }

  function renderDraftConflict(form, key) {

    const draft = state.drafts.get(key);
    if (!draft || !draft.conflict) {
      return;
    }
    const banner = append(form, 'div', 'status-banner warning full');
    banner.setAttribute('role', 'alert');
    appendText(banner, 'strong', t('optionsConflictTitle'));
    appendText(banner, 'p', t('optionsConflictHelp'));

  }

  function normalizeSiteRuleInput(value) {

    const input = String(value || '').trim();
    if (!input) {
      throw new Error('EMPTY_SITE');
    }
    if (input.startsWith('*.')) {
      try {
        const wildcardHost = new URL(`https://${input.slice(2)}`).hostname;
        if (wildcardHost && /^[a-z0-9.-]+$/i.test(wildcardHost)) {
          return `*.${wildcardHost.toLowerCase()}`;
        }
      } catch (error) {
        throw new Error('INVALID_SITE');
      }
    }
    let host = input;
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
        host = new URL(input).hostname;
      } else if (
        input.includes('/') ||
        Array.from(input).some((character) => character.charCodeAt(0) > 127)
      ) {
        host = new URL(`https://${input}`).hostname;
      }
    } catch (error) {
      throw new Error('INVALID_SITE');
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
      throw new Error('INVALID_SITE');
    }
    return host;

  }

  function getSiteRules(pacMods = state.snapshot.state.pacMods) {

    return Array.isArray(pacMods && pacMods.exceptions) ?
      pacMods.exceptions :
      [];

  }

  function createPacModsPatch(patch) {

    return Object.assign({}, clone(state.snapshot.state.pacMods), patch);

  }

  function renderSiteRulesSection(parent) {

    const section = createPageSection(
        parent,
        'site-rules',
        'optionsNavSiteRules',
        'optionsSiteRulesDescription',
    );
    renderAddSiteRuleCard(section);
    const listCard = append(section, 'div', 'settings-card ui-card');
    const header = append(listCard, 'div', 'card-header');
    appendText(header, 'h3', t('optionsNavSiteRules'));
    const rules = getSiteRules();
    appendText(
        header,
        'span',
        formatCount(
            rules.length,
            'optionsOneSiteRule',
            'optionsManySiteRules',
        ),
        'scope-badge',
    );
    if (!rules.length) {
      const empty = append(listCard, 'div', 'empty-state');
      appendText(empty, 'p', t('optionsNoSiteRules'), 'item-title');
      appendText(empty, 'p', t('optionsNoSiteRulesHelp'));
      return;
    }
    const filter = appendField(
        listCard,
        'search',
        'siteRule.filter',
        t('optionsFilterSiteRules'),
        '',
        {placeholder: t('optionsFilterSiteRulesPlaceholder')},
    );
    const list = append(listCard, 'div', 'settings-list');
    rules.forEach((rule, index) =>
      renderSiteRuleEditor(list, rule, index),
    );
    filter.addEventListener('input', () => {
      const query = filter.value.trim().toLowerCase();
      list.querySelectorAll('[data-rule-search]').forEach((row) => {
        row.hidden = query && !row.dataset.ruleSearch.includes(query);
      });
    });
    if (rules.some((rule) =>
      rule.enabled !== false && rule.action === 'PROXY',
    ) && getProxyCandidateCount() === 0) {
      const warning = append(listCard, 'div', 'status-banner warning');
      appendText(warning, 'strong', t('optionsProxyRuleNoCandidate'));
      const button = createButton(
          warning,
          t('optionsGoToProxyMethods'),
          'quiet',
      );
      button.onclick = () => navigateTo('proxy-methods');
    }

  }

  function renderAddSiteRuleCard(parent) {

    const card = append(parent, 'div', 'settings-card ui-card');
    appendText(card, 'h3', t('optionsAddSiteRule'));
    appendText(
        card,
        'p',
        t('optionsAddSiteRuleTaskHelp'),
        'section-description',
    );
    appendText(
        card,
        'p',
        t('optionsSiteLimitationsHelp'),
        'technical-note',
    );
    const form = append(card, 'form', 'field-grid');
    form.onsubmit = (event) => event.preventDefault();
    const pattern = appendField(
        form,
        'text',
        'siteRule.pattern',
        t('optionsSiteOrDomain'),
        '',
        {
          help: t('optionsSiteScopeHelp'),
          placeholder: 'example.com or *.example.com',
          required: true,
        },
    );
    const route = appendSelect(
        form,
        'siteRule.action',
        t('optionsRoute'),
        [
          ['PROXY', t('optionsProxyThisSite')],
          ['DIRECT', t('optionsOpenDirectly')],
        ],
        'PROXY',
        {help: t('optionsSiteRouteHelp')},
    );
    appendField(
        form,
        'text',
        'siteRule.note',
        t('optionsNote'),
        '',
        {full: true, placeholder: t('optionsOptional')},
    );
    const preview = appendText(
        form,
        'p',
        t('optionsNormalizedScopePending'),
        'field-help full',
    );
    pattern.addEventListener('input', () => {
      try {
        preview.textContent = t('optionsNormalizedScopePreview', [
          normalizeSiteRuleInput(pattern.value),
        ]);
      } catch (error) {
        preview.textContent = t('optionsNormalizedScopePending');
      }
    });
    const actions = append(form, 'div', 'action-row full');
    const addButton = createButton(
        actions,
        t('optionsAddRule'),
        'primary',
        t('optionsAdding'),
    );
    addButton.onclick = () => addSiteRule(
        form,
        pattern,
        route,
        addButton,
    );
    bindDraftForm(form, 'site-rule:add', {usesPacMods: true});
    renderDraftConflict(form, 'site-rule:add');

  }

  async function addSiteRule(form, patternInput, routeInput, button) {

    clearValidation(form);
    let pattern;
    try {
      pattern = normalizeSiteRuleInput(patternInput.value);
    } catch (error) {
      showFieldError(
          patternInput,
          error.message === 'EMPTY_SITE' ?
            t('optionsEnterSite') :
            t('optionsEnterValidSite'),
      );
      patternInput.focus();
      setMessage(t('optionsValidationFailed'), 'error');
      return;
    }
    if (getSiteRules().some((rule) =>
      String(rule.pattern || '').toLowerCase() === pattern,
    )) {
      showFieldError(patternInput, t('optionsDuplicateSiteRule'));
      patternInput.focus();
      setMessage(t('optionsValidationFailed'), 'error');
      return;
    }
    const note = form.querySelector('[name="siteRule.note"]');
    const rules = getSiteRules().concat({
      pattern,
      action: routeInput.value,
      enabled: true,
      note: note.value.trim(),
    });
    const result = await savePacMods(
        'site-rule:add',
        button,
        createPacModsPatch({exceptions: rules}),
        () => addSiteRule(form, patternInput, routeInput, button),
    );
    if (result) {
      state.drafts.delete('site-rule:add');
      await refresh({
        message: t('optionsRuleSavedApplyRequired'),
        tone: 'success',
      });
    }

  }

  function renderSiteRuleEditor(parent, rule, index) {

    const key = `site-rule:${index}:${rule.pattern}`;
    const disclosure = createDetails(
        parent,
        key,
        rule.pattern,
    );
    disclosure.details.dataset.ruleSearch = [
      rule.pattern,
      rule.note || '',
      rule.action,
    ].join(' ').toLowerCase();
    const meta = append(disclosure.content, 'div', 'item-header');
    appendText(
        meta,
        'span',
        rule.pattern.startsWith('*.') ?
          t('optionsDomainScope') :
          t('optionsExactHostScope'),
        'scope-badge',
    );
    appendText(
        meta,
        'span',
        rule.action === 'PROXY' ?
          t('optionsProxyThisSite') :
          t('optionsOpenDirectly'),
        rule.action === 'PROXY' ? 'ui-pill warning' : 'ui-pill',
    );
    const form = append(disclosure.content, 'form', 'field-grid');
    form.onsubmit = (event) => event.preventDefault();
    const pattern = appendField(
        form,
        'text',
        `${key}.pattern`,
        t('optionsNormalizedScope'),
        rule.pattern,
        {help: t('optionsSiteScopeHelp'), required: true},
    );
    const route = appendSelect(
        form,
        `${key}.action`,
        t('optionsRoute'),
        [
          ['PROXY', t('optionsProxyThisSite')],
          ['DIRECT', t('optionsOpenDirectly')],
          ['AUTO', t('popupAutoMode')],
        ],
        rule.action,
        {help: t('optionsAutoRemovesRuleHelp')},
    );
    const note = appendField(
        form,
        'text',
        `${key}.note`,
        t('optionsNote'),
        rule.note || '',
        {full: true},
    );
    const enabled = appendCheckbox(
        form,
        `${key}.enabled`,
        t('optionsEnabled'),
        rule.enabled !== false,
        t('optionsDisabledRuleHelp'),
        'full',
    );
    const actions = append(form, 'div', 'rule-actions full');
    const save = createButton(
        actions,
        t('optionsSaveRule'),
        'primary',
        t('optionsSaving'),
    );
    save.onclick = () => updateSiteRule({
      form,
      draftKey: key,
      index,
      pattern,
      route,
      note,
      enabled,
      button: save,
    });
    const remove = createButton(
        actions,
        t('optionsRemoveRule'),
        'danger quiet',
        t('optionsDeleting'),
    );
    remove.onclick = () => removeSiteRule(rule, index, key, remove);
    bindDraftForm(form, key, {usesPacMods: true});
    renderDraftConflict(form, key);

  }

  async function updateSiteRule(options) {

    clearValidation(options.form);
    let pattern;
    try {
      pattern = normalizeSiteRuleInput(options.pattern.value);
    } catch (error) {
      showFieldError(options.pattern, t('optionsEnterValidSite'));
      options.pattern.focus();
      return;
    }
    const rules = getSiteRules().slice();
    if (!rules[options.index]) {
      setMessage(t('optionsConflictError'), 'error');
      return;
    }
    if (rules.some((rule, index) =>
      index !== options.index &&
      String(rule.pattern || '').toLowerCase() === pattern,
    )) {
      showFieldError(options.pattern, t('optionsDuplicateSiteRule'));
      options.pattern.focus();
      return;
    }
    if (options.route.value === 'AUTO') {
      rules.splice(options.index, 1);
    } else {
      rules[options.index] = {
        pattern,
        action: options.route.value,
        enabled: options.enabled.checked,
        note: options.note.value.trim(),
      };
    }
    const result = await savePacMods(
        options.draftKey,
        options.button,
        createPacModsPatch({exceptions: rules}),
        () => updateSiteRule(options),
    );
    if (result) {
      state.drafts.delete(options.draftKey);
      await refresh({
        message: t('optionsRuleSavedApplyRequired'),
        tone: 'success',
      });
    }

  }

  async function removeSiteRule(rule, index, draftKey, button) {

    if (!window.confirm(t('optionsConfirmRemoveRule', [rule.pattern]))) {
      return;
    }
    const rules = getSiteRules().slice();
    if (!rules[index]) {
      setMessage(t('optionsConflictError'), 'error');
      return;
    }
    rules.splice(index, 1);
    const result = await savePacMods(
        draftKey,
        button,
        createPacModsPatch({exceptions: rules}),
    );
    if (result) {
      state.drafts.delete(draftKey);
      await refresh({
        message: t('optionsRuleRemovedApplyRequired'),
        tone: 'success',
      });
    }

  }

  async function savePacMods(draftKey, button, pacMods, retry) {

    return runOperation(
        `save:${draftKey}`,
        button,
        () => rpc.callBackground('setPacMods', {pacMods}),
        {
          context: 'validation',
          draftKey,
          retry,
        },
    );

  }

  function getProxyCandidateCount(pacMods = state.snapshot.state.pacMods) {

    const own = Array.isArray(pacMods.ownProxies) ?
      pacMods.ownProxies.filter((proxy) =>
        proxy && proxy.enabled !== false && proxy.host && proxy.port,
      ).length :
      0;
    const localTor = isObject(pacMods.localTor) &&
      pacMods.localTor.enabled === true ? 1 : 0;
    const torBrowser = isObject(pacMods.torBrowser) &&
      pacMods.torBrowser.enabled === true ? 1 : 0;
    const warp = isObject(pacMods.warp) &&
      pacMods.warp.enabled === true &&
      String(pacMods.warp.proxyString || '').trim() ? 1 : 0;
    return own + localTor + torBrowser + warp;

  }

  function renderProxyMethodsSection(parent) {

    const section = createPageSection(
        parent,
        'proxy-methods',
        'optionsNavProxyMethods',
        'optionsProxyMethodsDescription',
    );
    const pacMods = state.snapshot.state.pacMods;
    const summary = append(section, 'div', 'settings-card ui-card compact');
    const summaryHeader = append(summary, 'div', 'card-header');
    appendText(summaryHeader, 'h3', t('optionsProxyMethodAvailability'));
    appendText(
        summaryHeader,
        'span',
        formatCount(
            getProxyCandidateCount(pacMods),
            'optionsOneProxyMethod',
            'optionsManyProxyMethods',
        ),
        getProxyCandidateCount(pacMods) ? 'ui-pill success' : 'ui-pill warning',
    );
    appendText(
        summary,
        'p',
        t('optionsProxyHealthAuthSeparateHelp'),
        'section-description',
    );
    const card = append(section, 'div', 'settings-card ui-card');
    const form = append(card, 'form');
    form.onsubmit = (event) => event.preventDefault();
    renderProxyPolicy(form, pacMods);
    const methods = append(form, 'div', 'method-grid');
    renderTorMethod(
        methods,
        'localTor',
        t('popupLocalTor'),
        pacMods.localTor || {},
        9050,
    );
    renderTorMethod(
        methods,
        'torBrowser',
        t('popupTorBrowser'),
        pacMods.torBrowser || {},
        9150,
    );
    renderWarpMethod(methods, pacMods.warp || {});
    renderOwnProxyMethods(form, pacMods.ownProxies || []);
    const actions = append(form, 'div', 'split-actions');
    const save = createButton(
        actions,
        t('optionsSaveProxySettings'),
        'primary',
        t('optionsSaving'),
    );
    save.onclick = () => saveProxyMethods(form, pacMods, save);
    const discard = createButton(
        actions,
        t('optionsDiscardAllChanges'),
        'quiet',
    );
    discard.onclick = () => confirmDiscardAll();
    bindDraftForm(form, 'proxy-methods', {usesPacMods: true});
    renderDraftConflict(form, 'proxy-methods');

  }

  function renderProxyPolicy(parent, pacMods) {

    const group = append(parent, 'div', 'editor-panel');
    appendText(group, 'h3', t('optionsProxyMethodPolicy'));
    appendCheckbox(
        group,
        'usePacScriptProxies',
        t('popupUsePacScriptProxies'),
        pacMods.usePacScriptProxies !== false,
        t('popupUsePacScriptProxiesHelp'),
    );
    appendCheckbox(
        group,
        'ownProxiesOnlyForOwnSites',
        t('popupOwnProxiesOnlyForOwnSites'),
        pacMods.ownProxiesOnlyForOwnSites === true,
        t('popupOwnProxiesOnlyForOwnSitesHelp'),
    );

  }

  function renderTorMethod(parent, key, title, config, defaultPort) {

    const card = append(parent, 'fieldset', 'method-card');
    appendText(card, 'legend', title, 'item-title');
    const enabled = appendCheckbox(
        card,
        `${key}.enabled`,
        t('optionsEnabled'),
        config.enabled === true,
        key === 'torBrowser' ?
          t('optionsTorBrowserHelp') :
          t('optionsLocalTorHelp'),
    );
    enabled.onchange = () => {
      if (!enabled.checked) {
        return;
      }
      const otherName = key === 'localTor' ?
        'torBrowser.enabled' :
        'localTor.enabled';
      const other = parent.querySelector(`[name="${otherName}"]`);
      if (other) {
        other.checked = false;
      }
    };
    appendSelect(
        card,
        `${key}.type`,
        t('optionsType'),
        ['SOCKS5', 'SOCKS4', 'PROXY', 'HTTPS'],
        config.type || 'SOCKS5',
        {full: true},
    );
    appendField(
        card,
        'text',
        `${key}.host`,
        t('optionsHost'),
        config.host || '127.0.0.1',
        {full: true},
    );
    appendField(
        card,
        'number',
        `${key}.port`,
        t('optionsPort'),
        config.port || defaultPort,
        {full: true, min: 1, max: 65535},
    );
    appendCheckbox(
        card,
        `${key}.useForOnion`,
        t('optionsUseForOnion'),
        config.useForOnion !== false,
        '',
    );
    appendCheckbox(
        card,
        `${key}.useAsDirectReplacement`,
        t('optionsUseAsDirectReplacement'),
        config.useAsDirectReplacement === true,
        t('optionsDirectReplacementHelp'),
    );

  }

  function renderWarpMethod(parent, warp) {

    const card = append(parent, 'fieldset', 'method-card');
    appendText(card, 'legend', t('popupWarpCustomProxy'), 'item-title');
    appendCheckbox(
        card,
        'warp.enabled',
        t('optionsEnabled'),
        warp.enabled === true,
        t('optionsWarpLocalProxyWarning'),
    );
    appendField(
        card,
        'text',
        'warp.proxyString',
        t('optionsProxyString'),
        warp.proxyString ||
          'SOCKS5 127.0.0.1:40000; HTTPS 127.0.0.1:40000',
        {full: true, help: t('optionsProxyStringHelp')},
    );
    appendCheckbox(
        card,
        'warp.useAsDirectReplacement',
        t('optionsUseAsDirectReplacement'),
        warp.useAsDirectReplacement === true,
        t('optionsDirectReplacementHelp'),
    );

  }

  function renderOwnProxyMethods(parent, proxies) {

    const section = append(parent, 'fieldset', 'editor-panel');
    appendText(section, 'legend', t('popupOwnProxies'), 'item-title');
    appendText(
        section,
        'p',
        t('optionsOwnProxyEditorHelp'),
        'section-description',
    );
    const rows = append(section, 'div', 'own-proxy-rows');
    proxies.forEach((proxy) => renderOwnProxyRow(rows, proxy));
    if (!proxies.length) {
      const empty = append(rows, 'div', 'empty-state proxy-empty-state');
      appendText(empty, 'p', t('optionsNoOwnProxies'), 'item-title');
      appendText(empty, 'p', t('optionsNoOwnProxiesHelp'));
    }
    const add = createButton(
        section,
        t('optionsAddProxyRow'),
        '',
    );
    add.onclick = () => {
      const empty = rows.querySelector('.proxy-empty-state');
      if (empty) {
        empty.remove();
      }
      renderOwnProxyRow(rows, createEmptyProxy());
      updateOwnProxyOrderButtons(rows);
      markDraftDirty(parent);
    };

  }

  function createEmptyProxy() {

    return {
      enabled: true,
      type: 'PROXY',
      host: '',
      port: 8080,
      username: '',
      hasPassword: false,
      useAsDirectReplacement: false,
      note: '',
    };

  }

  function renderOwnProxyRow(parent, proxy) {

    const row = append(parent, 'div', 'proxy-row');
    row.mv3CredentialRef = proxy.credentialRef ?
      clone(proxy.credentialRef) :
      null;
    row.mv3HasPassword = proxy.hasPassword === true;
    appendCheckbox(
        row,
        'proxy.enabled',
        t('optionsEnabled'),
        proxy.enabled !== false,
        '',
        'full',
    );
    appendSelect(
        row,
        'proxy.type',
        t('optionsType'),
        ['PROXY', 'HTTPS', 'SOCKS4', 'SOCKS5'],
        proxy.type || 'PROXY',
    );
    appendField(
        row,
        'text',
        'proxy.host',
        t('optionsHost'),
        proxy.host || '',
        {required: true},
    );
    appendField(
        row,
        'number',
        'proxy.port',
        t('optionsPort'),
        proxy.port || 8080,
        {min: 1, max: 65535, required: true},
    );
    appendField(
        row,
        'text',
        'proxy.username',
        t('optionsUsername'),
        proxy.username || '',
        {autocomplete: 'username'},
    );
    const passwordMode = appendSelect(
        row,
        'proxy.passwordMode',
        t('optionsPasswordAction'),
        proxy.hasPassword ? [
          ['preserve', t('optionsKeepSavedPassword')],
          ['replace', t('optionsReplacePassword')],
          ['remove', t('optionsRemovePassword')],
        ] : [
          ['none', t('optionsNoPassword')],
          ['replace', t('optionsSetPassword')],
        ],
        proxy.hasPassword ? 'preserve' : 'none',
        {help: t('optionsPasswordIntentHelp')},
    );
    const password = appendField(
        row,
        'password',
        'proxy.password',
        t('optionsNewPassword'),
        '',
        {
          autocomplete: 'new-password',
          help: t('optionsPasswordNotShownHelp'),
        },
    );
    password.disabled = passwordMode.value !== 'replace';
    passwordMode.onchange = () => {
      password.disabled = passwordMode.value !== 'replace';
      if (password.disabled) {
        password.value = '';
      }
    };
    appendCheckbox(
        row,
        'proxy.useAsDirectReplacement',
        t('optionsDirectReplacement'),
        proxy.useAsDirectReplacement === true,
        t('optionsDirectReplacementHelp'),
        'full',
    );
    appendField(
        row,
        'text',
        'proxy.note',
        t('optionsNote'),
        proxy.note || '',
        {full: true},
    );
    const actions = append(row, 'div', 'rule-actions full');
    const moveUp = createButton(
        actions,
        t('optionsMoveUp'),
        'quiet',
    );
    moveUp.dataset.proxyMove = 'up';
    moveUp.onclick = () => moveOwnProxyRow(parent, row, -1);
    const moveDown = createButton(
        actions,
        t('optionsMoveDown'),
        'quiet',
    );
    moveDown.dataset.proxyMove = 'down';
    moveDown.onclick = () => moveOwnProxyRow(parent, row, 1);
    const remove = createButton(
        actions,
        t('optionsRemove'),
        'danger quiet row-remove',
    );
    remove.onclick = () => {
      row.remove();
      updateOwnProxyOrderButtons(parent);
      const form = parent.closest('form');
      if (form) {
        markDraftDirty(form);
      }
    };
    updateOwnProxyOrderButtons(parent);

  }

  function moveOwnProxyRow(parent, row, offset) {

    const rows = Array.from(parent.querySelectorAll('.proxy-row'));
    const index = rows.indexOf(row);
    const target = rows[index + offset];
    if (!target) {
      return;
    }
    if (offset < 0) {
      parent.insertBefore(row, target);
    } else {
      parent.insertBefore(target, row);
    }
    updateOwnProxyOrderButtons(parent);
    const form = parent.closest('form');
    if (form) {
      markDraftDirty(form);
    }

  }

  function updateOwnProxyOrderButtons(parent) {

    const rows = Array.from(parent.querySelectorAll('.proxy-row'));
    rows.forEach((row, index) => {
      const up = row.querySelector('[data-proxy-move="up"]');
      const down = row.querySelector('[data-proxy-move="down"]');
      if (up) {
        up.disabled = index === 0;
      }
      if (down) {
        down.disabled = index === rows.length - 1;
      }
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
        .map((row) => {
          const passwordMode = getValue(row, 'proxy.passwordMode');
          const proxy = {
            enabled: getChecked(row, 'proxy.enabled'),
            type: getValue(row, 'proxy.type'),
            host: getValue(row, 'proxy.host'),
            port: Number(getValue(row, 'proxy.port')),
            username: getValue(row, 'proxy.username'),
            useAsDirectReplacement: getChecked(
                row,
                'proxy.useAsDirectReplacement',
            ),
            note: getValue(row, 'proxy.note'),
          };
          if (passwordMode === 'preserve' && row.mv3CredentialRef) {
            proxy.password = REDACTED_PASSWORD;
            proxy.hasPassword = true;
            proxy.credentialRef = clone(row.mv3CredentialRef);
          } else {
            proxy.password = passwordMode === 'replace' ?
              getRawValue(row, 'proxy.password') :
              '';
          }
          return proxy;
        })
        .filter((proxy) => proxy.host);

  }

  function validateProxyMethods(form) {

    clearValidation(form);
    let firstInvalid = null;
    form.querySelectorAll('.proxy-row').forEach((row) => {
      const host = row.querySelector('[name="proxy.host"]');
      const port = row.querySelector('[name="proxy.port"]');
      const passwordMode = row.querySelector(
          '[name="proxy.passwordMode"]',
      );
      const password = row.querySelector('[name="proxy.password"]');
      const type = row.querySelector('[name="proxy.type"]');
      if (!host.value.trim()) {
        showFieldError(host, t('optionsProxyHostRequired'));
        firstInvalid = firstInvalid || host;
      }
      const portValue = Number(port.value);
      if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) {
        showFieldError(port, t('optionsProxyPortInvalid'));
        firstInvalid = firstInvalid || port;
      }
      if (passwordMode.value === 'replace' && !password.value) {
        showFieldError(password, t('optionsPasswordRequiredForReplace'));
        firstInvalid = firstInvalid || password;
      }
      const ref = row.mv3CredentialRef;
      const endpointChanged = ref && (
        ref.type !== type.value ||
        ref.host.toLowerCase() !== host.value.trim().toLowerCase() ||
        ref.port !== portValue
      );
      if (passwordMode.value === 'preserve' && endpointChanged) {
        showFieldError(
            passwordMode,
            t('optionsPasswordEndpointChanged'),
        );
        firstInvalid = firstInvalid || passwordMode;
      }
    });
    if (firstInvalid) {
      firstInvalid.focus();
      return false;
    }
    return true;

  }

  async function saveProxyMethods(form, originalPacMods, button) {

    if (!validateProxyMethods(form)) {
      setMessage(t('optionsValidationFailed'), 'error');
      return;
    }
    let localTor = collectTorConfig(form, 'localTor');
    const torBrowser = collectTorConfig(form, 'torBrowser');
    if (localTor.enabled && torBrowser.enabled) {
      localTor = Object.assign({}, localTor, {enabled: false});
    }
    const pacMods = Object.assign({}, clone(originalPacMods), {
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
    });
    const result = await savePacMods(
        'proxy-methods',
        button,
        pacMods,
        () => saveProxyMethods(form, originalPacMods, button),
    );
    if (result) {
      markDraftClean('proxy-methods', form);
      await refresh({
        message: t('optionsProxyMethodsSavedApplyRequired'),
        tone: 'success',
      });
    }

  }

  function getValue(parent, name) {

    const input = parent.querySelector(`[name="${name}"]`);
    return input ? String(input.value || '').trim() : '';

  }

  function getRawValue(parent, name) {

    const input = parent.querySelector(`[name="${name}"]`);
    return input ? String(input.value || '') : '';

  }

  function getChecked(parent, name) {

    const input = parent.querySelector(`[name="${name}"]`);
    return Boolean(input && input.checked);

  }

  function renderMaintenanceSection(parent) {

    const section = createPageSection(
        parent,
        'maintenance',
        'optionsNavMaintenance',
        'optionsMaintenanceDescription',
    );
    const reliability = state.snapshot.reliability || {};
    const autoUpdate = reliability.autoUpdate || {};
    const health = reliability.proxyHealth || {};
    const settings = append(section, 'div', 'settings-card ui-card');
    settings.id = 'updates-health';
    const updatesHeading = appendText(
        settings,
        'h3',
        t('optionsAutomaticUpdates'),
    );
    updatesHeading.id = 'maintenance-updates-heading';
    const form = append(settings, 'form');
    form.onsubmit = (event) => event.preventDefault();
    const enabled = appendCheckbox(
        form,
        'updates.enabled',
        t('optionsAutoUpdateEveryTwelveHours'),
        autoUpdate.enabled === true,
        t('optionsAutoUpdateSafetyHelp'),
    );
    const grid = append(form, 'div', 'summary-grid');
    appendSummaryItem(
        grid,
        t('optionsLastSuccessfulPacUpdate'),
        formatTime(autoUpdate.lastSuccessfulUpdateAt),
    );
    appendSummaryItem(
        grid,
        t('optionsNextAutomaticPacUpdate'),
        autoUpdate.enabled ?
          formatTime(autoUpdate.nextUpdateAt) :
          t('optionsDisabled'),
    );
    const actions = append(form, 'div', 'action-row');
    const save = createButton(
        actions,
        t('optionsSaveUpdateSettings'),
        'primary',
        t('optionsSaving'),
    );
    save.onclick = () => saveUpdateSettings(form, enabled, save);
    const update = createButton(
        actions,
        t('optionsUpdateRoutingRules'),
        '',
        t('optionsUpdatingRoutingRules'),
    );
    update.disabled = !state.snapshot.state.currentPacProviderKey;
    update.onclick = () => runUpdateNow(update);
    bindDraftForm(form, 'updates');
    const healthCard = append(section, 'div', 'settings-card ui-card');
    const healthHeader = append(healthCard, 'div', 'card-header');
    appendText(healthHeader, 'h3', t('optionsConnectionHealth'));
    const healthView = getHealthView();
    appendText(
        healthHeader,
        'span',
        healthView.text,
        `ui-pill ${healthView.tone}`,
    );
    const healthGrid = append(healthCard, 'div', 'summary-grid');
    appendSummaryItem(
        healthGrid,
        t('optionsLastProxyCheck'),
        formatTime(health.lastCheckedAt),
    );
    appendSummaryItem(
        healthGrid,
        t('optionsCheckedMethod'),
        getCandidateTypeLabel(health.candidateType),
    );
    appendText(
        healthCard,
        'p',
        t('optionsHealthCheckNeedsProxyRuleHelp'),
        'section-description',
    );
    if (health.status === 'error') {
      appendText(
          healthCard,
          'p',
          getLocalizedProxyHealthError(health),
          'status-banner error',
      );
    }
    const check = createButton(
        healthCard,
        health.status === 'error' ?
          t('popupCheckProxyAgain') :
          t('popupCheckProxy'),
        'primary',
        t('popupProxyHealthChecking'),
    );
    check.onclick = () => runHealthCheck(check);
    renderMaintenanceDiagnostics(section);

  }

  async function saveUpdateSettings(form, enabled, button) {

    const result = await runOperation(
        'updates:save',
        button,
        () => rpc.callBackground('setPeriodicUpdateEnabled', {
          enabled: enabled.checked,
        }),
        {
          draftKey: 'updates',
          retry: () => saveUpdateSettings(form, enabled, button),
        },
    );
    if (result) {
      markDraftClean('updates', form);
      await refresh({
        message: t('optionsPeriodicSettingsSaved'),
        tone: 'success',
      });
    }

  }

  async function runUpdateNow(button) {

    const result = await runOperation(
        'updates:run',
        button,
        () => rpc.callBackground('runPeriodicUpdateNow', {
          applyIfSafe: true,
        }),
        {
          context: 'apply',
          acceptStatuses: ['skipped'],
          retry: () => runUpdateNow(button),
        },
    );
    if (result) {
      await refresh({
        message: result.status === 'skipped' ?
          t('optionsUpdateSkipped') :
          t('optionsRoutingRulesUpdated'),
        tone: result.status === 'skipped' ? 'warning' : 'success',
      });
    }

  }

  function getLocalizedProxyHealthError(health) {

    if (health.candidateType === 'torBrowser') {
      return t('proxyHealthTorBrowserError');
    }
    if (health.candidateType === 'localTor') {
      return t('proxyHealthLocalTorError');
    }
    return t('proxyHealthGenericError');

  }

  function getCandidateTypeLabel(type) {

    const keys = {
      localTor: 'popupLocalTor',
      torBrowser: 'popupTorBrowser',
      warp: 'popupWarpCustomProxy',
      ownProxy: 'popupOwnProxies',
    };
    return keys[type] ? t(keys[type]) : t('optionsNone');

  }

  async function runHealthCheck(button) {

    const result = await runOperation(
        'health:check',
        button,
        () => rpc.callBackground('checkProxyHealth', {}),
        {
          acceptStatuses: ['checking', 'error', 'inconclusive'],
          retry: () => runHealthCheck(button),
        },
    );
    if (!result) {
      return;
    }
    const messages = {
      ok: t('popupProxyCheckSucceeded'),
      error: getLocalizedProxyHealthError(result.proxyHealth || {}),
      inconclusive: t('popupProxyCheckInconclusive'),
      checking: t('popupProxyHealthChecking'),
    };
    await refresh({
      message: messages[result.status] || t('popupProxyCheckInconclusive'),
      tone: result.status === 'ok' ? 'success' : 'warning',
    });

  }

  function renderMaintenanceDiagnostics(parent) {

    const details = createDetails(
        parent,
        'diagnostics-expert',
        t('optionsNavDiagnostics'),
    );
    details.details.id = 'diagnostics';
    details.summary.id = 'maintenance-diagnostics-heading';
    appendText(
        details.content,
        'p',
        t('optionsDiagnosticsDescriptionNew'),
        'section-description',
    );
    renderSafeExpertDetails(details.content);

  }

  function renderSafeExpertDetails(parent) {

    appendText(
        parent,
        'p',
        t('optionsExpertDetailsRedactionHelp'),
        'technical-note',
    );
    const snapshot = state.snapshot;
    const stored = snapshot.state;
    const periodic = snapshot.periodicUpdate &&
      snapshot.periodicUpdate.periodicUpdate || {};
    const health = snapshot.reliability &&
      snapshot.reliability.proxyHealth || {};
    const list = append(parent, 'dl', 'technical-list');
    appendDefinition(
        list,
        t('optionsControlLevel'),
        localizeControlLevel(
            stored.proxyControl && stored.proxyControl.levelOfControl,
        ),
    );
    appendDefinition(
        list,
        t('optionsApplyStatus'),
        localizeStatusValue(stored.proxyApply && stored.proxyApply.status),
    );
    appendDefinition(
        list,
        t('optionsDownloadStatus'),
        localizeStatusValue(stored.pacDownload && stored.pacDownload.status),
    );
    appendDefinition(
        list,
        t('optionsCookStatus'),
        localizeStatusValue(stored.pacCook && stored.pacCook.status),
    );
    appendDefinition(
        list,
        t('optionsHealthCode'),
        localizeHealthCode(health.lastErrorCode),
    );
    appendDefinition(
        list,
        t('optionsLastProxyCheck'),
        formatTime(health.lastCheckedAt),
    );
    appendDefinition(
        list,
        t('optionsUpdateStatus'),
        localizeStatusValue(periodic.status),
    );
    appendDefinition(
        list,
        t('optionsNextRun'),
        formatTime(periodic.nextRunAt),
    );

  }

  function appendDefinition(parent, label, value) {

    appendText(parent, 'dt', label);
    appendText(parent, 'dd', value || t('optionsNone'));

  }

  function localizeControlLevel(level) {

    const keys = {
      controlled_by_this_extension: 'optionsControlLevelThisExtension',
      controllable_by_this_extension: 'optionsControlLevelAvailable',
      controlled_by_other_extensions: 'optionsControlLevelOther',
      not_controllable: 'optionsControlLevelPolicy',
    };
    return keys[level] ? t(keys[level]) : t('optionsNone');

  }

  function localizeHealthCode(code) {

    if (!code) {
      return t('optionsNone');
    }
    const safeCodes = {
      ERR_PROXY_CONNECTION_FAILED: t('optionsHealthCodeConnection'),
      ERR_TUNNEL_CONNECTION_FAILED: t('optionsHealthCodeTunnel'),
      ERR_SOCKS_CONNECTION_FAILED: t('optionsHealthCodeConnection'),
      ERR_PROXY_AUTH_UNSUPPORTED: t('optionsHealthCodeAuthentication'),
      ERR_PROXY_AUTH_REQUESTED: t('optionsHealthCodeAuthentication'),
    };
    return safeCodes[code] || t('optionsHealthCodeGeneric');

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
    return keys[status] ? t(keys[status]) : t('optionsStatusUnknown');

  }

  function renderAdvancedSection(parent) {

    const section = createPageSection(
        parent,
        'advanced',
        'optionsNavAdvanced',
        'optionsAdvancedDescriptionNew',
    );
    renderAdvancedPacRules(section);
    renderNotificationSettings(section);
    renderExpertOperations(section);
    renderMigration(section);

  }

  function renderAdvancedPacRules(parent) {

    const disclosure = createDetails(
        parent,
        'advanced-routing',
        t('optionsAdvancedPacRules'),
    );
    appendText(
        disclosure.content,
        'p',
        t('optionsAdvancedPacRulesHint'),
        'status-banner warning',
    );
    const form = append(disclosure.content, 'form');
    form.onsubmit = (event) => event.preventDefault();
    const pacMods = state.snapshot.state.pacMods;
    const whitelist = append(form, 'fieldset', 'editor-panel');
    appendText(whitelist, 'legend', t('optionsWhitelist'), 'item-title');
    appendText(
        whitelist,
        'p',
        t('optionsWhitelistHelpNew'),
        'section-description',
    );
    const rows = append(whitelist, 'div', 'pattern-rows');
    (pacMods.whitelist || []).forEach((entry) =>
      renderPatternRow(rows, entry),
    );
    if (!(pacMods.whitelist || []).length) {
      appendText(
          rows,
          'p',
          t('optionsNoWhitelistRules'),
          'empty-state pattern-empty-state',
      );
    }
    const add = createButton(
        whitelist,
        t('optionsAddWhitelistRow'),
    );
    add.onclick = () => {
      const empty = rows.querySelector('.pattern-empty-state');
      if (empty) {
        empty.remove();
      }
      renderPatternRow(rows, {pattern: '', enabled: true, note: ''});
      markDraftDirty(form);
    };
    const policy = append(form, 'fieldset', 'editor-panel');
    appendText(policy, 'legend', t('optionsDirectPolicy'), 'item-title');
    appendCheckbox(
        policy,
        'replaceDirectWithProxy',
        t('optionsReplaceDirectWithProxy'),
        pacMods.replaceDirectWithProxy === true,
        t('optionsReplaceDirectWarningNew'),
    );
    appendCheckbox(
        policy,
        'noDirect',
        t('optionsRemoveDirectFallbacks'),
        pacMods.noDirect === true,
        t('optionsNoDirectWarningNew'),
    );
    const actions = append(form, 'div', 'split-actions');
    const save = createButton(
        actions,
        t('optionsSaveAdvancedPacRules'),
        'primary',
        t('optionsSaving'),
    );
    save.onclick = () => saveAdvancedRules(form, pacMods, save);
    const discard = createButton(
        actions,
        t('optionsDiscardAllChanges'),
        'quiet',
    );
    discard.onclick = () => confirmDiscardAll();
    bindDraftForm(form, 'advanced-routing', {usesPacMods: true});
    renderDraftConflict(form, 'advanced-routing');

  }

  function renderPatternRow(parent, entry) {

    const row = append(parent, 'div', 'rule-row');
    appendCheckbox(
        row,
        'whitelist.enabled',
        t('optionsEnabled'),
        entry.enabled !== false,
        '',
        'full',
    );
    appendField(
        row,
        'text',
        'whitelist.pattern',
        t('optionsPattern'),
        entry.pattern || '',
        {required: true, full: true},
    );
    appendField(
        row,
        'text',
        'whitelist.note',
        t('optionsNote'),
        entry.note || '',
        {full: true},
    );
    const remove = createButton(
        row,
        t('optionsRemove'),
        'danger quiet row-remove',
    );
    remove.onclick = () => {
      row.remove();
      const form = parent.closest('form');
      if (form) {
        markDraftDirty(form);
      }
    };

  }

  function collectPatternRows(form) {

    return Array.from(form.querySelectorAll('.rule-row'))
        .map((row) => ({
          pattern: getValue(row, 'whitelist.pattern'),
          enabled: getChecked(row, 'whitelist.enabled'),
          note: getValue(row, 'whitelist.note'),
        }))
        .filter((entry) => entry.pattern);

  }

  async function saveAdvancedRules(form, originalPacMods, button) {

    clearValidation(form);
    let firstInvalid = null;
    form.querySelectorAll('[name="whitelist.pattern"]').forEach((input) => {
      if (!input.value.trim()) {
        showFieldError(input, t('optionsPatternRequired'));
        firstInvalid = firstInvalid || input;
      }
    });
    if (firstInvalid) {
      firstInvalid.focus();
      setMessage(t('optionsValidationFailed'), 'error');
      return;
    }
    const pacMods = Object.assign({}, clone(originalPacMods), {
      whitelist: collectPatternRows(form),
      replaceDirectWithProxy: getChecked(form, 'replaceDirectWithProxy'),
      noDirect: getChecked(form, 'noDirect'),
    });
    const result = await savePacMods(
        'advanced-routing',
        button,
        pacMods,
        () => saveAdvancedRules(form, originalPacMods, button),
    );
    if (result) {
      markDraftClean('advanced-routing', form);
      await refresh({
        message: t('optionsAdvancedRulesSavedApplyRequired'),
        tone: 'success',
      });
    }

  }

  function renderNotificationSettings(parent) {

    const disclosure = createDetails(
        parent,
        'notifications',
        t('optionsNotifications'),
    );
    const form = append(disclosure.content, 'form');
    form.onsubmit = (event) => event.preventDefault();
    const prefs = state.snapshot.state.notificationPrefs || {};
    appendCheckbox(
        form,
        'notification.pacError',
        t('optionsNotifyPacError'),
        prefs.pacError === true,
        '',
    );
    appendCheckbox(
        form,
        'notification.extError',
        t('optionsNotifyExtensionError'),
        prefs.extError === true,
        '',
    );
    appendCheckbox(
        form,
        'notification.noControl',
        t('optionsNotifyNoControl'),
        prefs.noControl === true,
        '',
    );
    const save = createButton(
        form,
        t('optionsSaveNotifications'),
        'primary',
        t('optionsSaving'),
    );
    save.onclick = () => saveNotifications(form, save);
    bindDraftForm(form, 'notifications');

  }

  async function saveNotifications(form, button) {

    const result = await runOperation(
        'notifications:save',
        button,
        () => rpc.callBackground('setNotificationPrefs', {
          prefs: {
            pacError: getChecked(form, 'notification.pacError'),
            extError: getChecked(form, 'notification.extError'),
            noControl: getChecked(form, 'notification.noControl'),
          },
        }),
        {
          draftKey: 'notifications',
          retry: () => saveNotifications(form, button),
        },
    );
    if (result) {
      markDraftClean('notifications', form);
      await refresh({
        message: t('optionsNotificationPrefsSaved'),
        tone: 'success',
      });
    }

  }

  function renderExpertOperations(parent) {

    const disclosure = createDetails(
        parent,
        'expert-operations',
        t('optionsExpertOperations'),
    );
    appendText(
        disclosure.content,
        'p',
        t('optionsExpertOperationsHelp'),
        'status-banner warning',
    );
    const actions = append(disclosure.content, 'div', 'action-row');
    const download = createButton(
        actions,
        t('optionsDownloadPac'),
        '',
        t('optionsDownloading'),
    );
    download.onclick = () => runExpertOperation(
        'expert:download',
        download,
        'downloadPac',
        t('optionsRoutingRulesDownloaded'),
    );
    const cook = createButton(
        actions,
        t('optionsRebuildRoutingRules'),
        '',
        t('optionsCooking'),
    );
    cook.onclick = () => runExpertOperation(
        'expert:cook',
        cook,
        'cookPac',
        t('optionsRoutingRulesRebuilt'),
    );
    const apply = createButton(
        actions,
        t('optionsActivatePreparedRules'),
        '',
        t('optionsApplying'),
    );
    apply.onclick = () => runExpertOperation(
        'expert:apply',
        apply,
        'applyCookedPac',
        t('optionsPreparedRulesActivated'),
    );

  }

  async function runExpertOperation(key, button, method, message) {

    const result = await runOperation(
        key,
        button,
        () => rpc.callBackground(method, {}),
        {
          context: 'apply',
          retry: () => runExpertOperation(key, button, method, message),
        },
    );
    if (result) {
      await refresh({message, tone: 'success'});
    }

  }

  function renderMigration(parent) {

    const disclosure = createDetails(
        parent,
        'legacy-migration',
        t('optionsLegacyMigration'),
    );
    appendText(
        disclosure.content,
        'p',
        t('optionsLegacyMigrationSafeHelp'),
        'section-description',
    );
    const actions = append(disclosure.content, 'div', 'action-row');
    const scan = createButton(
        actions,
        t('optionsScanLegacySettings'),
        '',
        t('optionsScanning'),
    );
    scan.onclick = () => runMigrationAudit(scan);
    const clear = createButton(
        actions,
        t('optionsClearMigrationAudit'),
        'danger quiet',
        t('popupClearing'),
    );
    clear.onclick = () => clearMigrationAudit(clear);
    renderMigrationStatus(disclosure.content);
    if (state.latestMigrationPlan) {
      renderMigrationPlan(disclosure.content, state.latestMigrationPlan);
    }

  }

  function renderMigrationStatus(parent) {

    const migration = state.snapshot.state.legacyMigration || {};
    const list = append(parent, 'dl', 'technical-list');
    appendDefinition(
        list,
        t('optionsAuditStatus'),
        localizeStatusValue(migration.auditStatus),
    );
    appendDefinition(
        list,
        t('optionsApplyStatus'),
        localizeStatusValue(migration.applyStatus),
    );
    appendDefinition(
        list,
        t('optionsLastAudit'),
        formatTime(migration.lastAuditAt),
    );
    appendDefinition(
        list,
        t('optionsDetectedLegacyData'),
        migration.detectedLegacyData ? t('optionsYes') : t('optionsNo'),
    );

  }

  async function runMigrationAudit(button) {

    const result = await runOperation(
        'migration:audit',
        button,
        () => rpc.callBackground('runLegacyMigrationAudit', {
          includeValues: false,
        }),
    );
    if (result) {
      state.latestMigrationPlan = result;
      state.openDisclosures.add('legacy-migration');
      await refresh({
        message: t('optionsLegacyAuditCompleted'),
        tone: 'success',
      });
    }

  }

  async function clearMigrationAudit(button) {

    if (!window.confirm(t('optionsConfirmClearMigrationAudit'))) {
      return;
    }
    const result = await runOperation(
        'migration:clear',
        button,
        () => rpc.callBackground('clearLegacyMigrationAudit', {}),
    );
    if (result) {
      state.latestMigrationPlan = null;
      state.drafts.delete('migration');
      await refresh({
        message: t('optionsLegacyAuditCleared'),
        tone: 'success',
      });
    }

  }

  function renderMigrationPlan(parent, plan) {

    const proposed = plan.proposedMigration || {};
    const available = proposed.canMigrate || {};
    const card = append(parent, 'div', 'editor-panel');
    appendText(card, 'h3', t('optionsSettingsAvailableForMigration'));
    const form = append(card, 'form');
    LEGACY_MIGRATION_FIELDS.forEach(([key, labelKey]) => {
      const ifAvailable = available[key] !== null &&
        available[key] !== undefined;
      const input = appendCheckbox(
          form,
          `migration.${key}`,
          t(labelKey),
          ifAvailable,
          ifAvailable ? '' : t('optionsMigrationFieldUnavailable'),
      );
      input.disabled = !ifAvailable;
    });
    const strategy = appendSelect(
        form,
        'migration.strategy',
        t('optionsStrategy'),
        [
          ['fillMissing', t('optionsFillMissingOnly')],
          ['overwriteSelected', t('optionsOverwriteSelectedMv3')],
        ],
        'fillMissing',
        {full: true},
    );
    const confirm = appendCheckbox(
        form,
        'migration.confirm',
        t('optionsMigrationConfirmation'),
        false,
        t('optionsMigrationDoesNotApplyHelp'),
    );
    const apply = createButton(
        form,
        t('optionsApplySelectedMigration'),
        'primary',
        t('optionsApplying'),
    );
    const updateEnabled = () => {
      const selected = LEGACY_MIGRATION_FIELDS.some(([key]) =>
        getChecked(form, `migration.${key}`),
      );
      apply.disabled = !confirm.checked || !selected;
    };
    form.addEventListener('change', updateEnabled);
    bindDraftForm(form, 'migration');
    updateEnabled();
    apply.onclick = () => applyMigration(form, strategy, apply);
    renderDraftConflict(form, 'migration');

  }

  async function applyMigration(form, strategy, button) {

    const fields = LEGACY_MIGRATION_FIELDS
        .filter(([key]) => getChecked(form, `migration.${key}`))
        .map(([key]) => key);
    if (!getChecked(form, 'migration.confirm') || !fields.length) {
      return;
    }
    const result = await runOperation(
        'migration:apply',
        button,
        () => rpc.callBackground('applyLegacyMigration', {
          strategy: strategy.value,
          fields,
        }),
    );
    if (result) {
      state.latestMigrationPlan = null;
      state.drafts.delete('migration');
      await refresh({
        message: t('optionsMigrationAppliedSafely'),
        tone: 'success',
      });
    }

  }

  function renderAboutSection(parent) {

    const section = createPageSection(
        parent,
        'about',
        'optionsAbout',
        'optionsAboutDescription',
    );
    const card = append(section, 'div', 'settings-card ui-card compact');
    const manifest = chrome.runtime.getManifest();
    const details = append(card, 'dl', 'technical-list');
    appendDefinition(
        details,
        t('optionsVersion'),
        manifest.version_name || manifest.version,
    );
    appendDefinition(
        details,
        t('optionsReleaseChannel'),
        t('optionsLimitedBeta'),
    );
    const links = append(card, 'ul', 'about-links');
    [
      [
        'optionsGitHubRepository',
        'https://github.com/aVitomin/runet-censorship-bypass-mv3',
      ],
      [
        'optionsWhatsNew',
        'https://github.com/aVitomin/runet-censorship-bypass-mv3/releases',
      ],
      [
        'optionsReportIssue',
        'https://github.com/aVitomin/runet-censorship-bypass-mv3/issues/new/choose',
      ],
      [
        'optionsLicense',
        'https://github.com/aVitomin/runet-censorship-bypass-mv3/blob/main/LICENSE',
      ],
      [
        'optionsUpstreamProject',
        'https://github.com/anticensority/runet-censorship-bypass',
      ],
    ].forEach(([labelKey, href]) => {
      const item = append(links, 'li');
      const link = appendText(item, 'a', t(labelKey));
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });

  }

  function renderGlobalActionBar(parent) {

    const bar = append(parent, 'aside', 'global-action-bar');
    bar.id = 'global-action-bar';
    bar.setAttribute('aria-label', t('optionsConfigurationActions'));
    renderGlobalActionBarContents(bar);

  }

  function renderGlobalActionBarContents(bar) {

    bar.hidden = false;
    const dirty = getDirtyDrafts();
    const conflicts = dirty.filter((entry) => entry[1].conflict);
    const view = deriveControlView();
    const copy = append(bar, 'div', 'global-action-copy');
    const buttons = append(bar, 'div', 'global-action-buttons');
    if (conflicts.length) {
      appendText(copy, 'strong', t('optionsConflictTitle'));
      appendText(copy, 'span', t('optionsConflictActionHelp'));
      const review = createButton(
          buttons,
          t('optionsReviewConflict'),
          'primary',
      );
      review.onclick = () => navigateTo(getSectionForDraft(conflicts[0][0]));
      const discard = createButton(
          buttons,
          t('optionsDiscardAllChanges'),
          'danger quiet',
      );
      discard.onclick = () => confirmDiscardAll();
      return;
    }
    if (dirty.length) {
      appendText(
          copy,
          'strong',
          formatCount(
              dirty.length,
              'optionsOneUnsavedDraft',
              'optionsManyUnsavedDrafts',
          ),
      );
      appendText(copy, 'span', t('optionsSaveSectionBeforeApply'));
      const review = createButton(
          buttons,
          t('optionsReviewChanges'),
          'primary',
      );
      review.onclick = () => navigateTo(getSectionForDraft(dirty[0][0]));
      const discard = createButton(
          buttons,
          t('optionsDiscardAllChanges'),
          'danger quiet',
      );
      discard.onclick = () => confirmDiscardAll();
      return;
    }
    if (ifShowInitialSetup() && state.activeSection === 'overview') {
      bar.hidden = true;
      return;
    }
    if (view.external) {
      appendText(copy, 'strong', view.title);
      appendText(
          copy,
          'span',
          t(view.clearDeferred ?
            'popupControlExternalClearedHelp' :
            'optionsExternalActionHelp'),
      );
      if (view.clearAvailable) {
        const clear = createButton(
            buttons,
            t('popupTurnOffProxy'),
            '',
            t('popupClearing'),
        );
        clear.onclick = () => clearConfiguration(clear);
      }
      const refreshButton = createButton(
          buttons,
          t('optionsCheckAgain'),
          '',
          t('optionsLoading'),
      );
      refreshButton.onclick = () => refresh({restoreFocus: false});
      return;
    }
    if (view.busy || state.pending.has('configuration:apply') ||
        state.pending.has('configuration:clear')) {
      appendText(copy, 'strong', view.title);
      appendText(copy, 'span', t('optionsOperationInProgressHelp'));
      const busy = createButton(
          buttons,
          view.kind === 'clearing' ?
            t('popupControlClearing') :
            t('popupControlApplying'),
          'primary',
      );
      busy.disabled = true;
      busy.setAttribute('aria-busy', 'true');
      return;
    }
    if (!getSelectedProvider()) {
      appendText(copy, 'strong', t('optionsChooseSourceTitle'));
      appendText(copy, 'span', t('optionsChooseSourceBeforeApply'));
      const choose = createButton(
          buttons,
          t('optionsGoToRoutingSources'),
          'primary',
      );
      choose.onclick = () => navigateTo('routing-sources');
      return;
    }
    if (view.controlsPac && !view.stale) {
      appendText(copy, 'strong', t('optionsSavedAndActive'));
      appendText(copy, 'span', t('optionsTurnOffKeepsSettings'));
      const clear = createButton(
          buttons,
          t('popupTurnOffProxy'),
          '',
          t('popupClearing'),
      );
      clear.onclick = () => clearConfiguration(clear);
      return;
    }
    appendText(
        copy,
        'strong',
        view.stale ? t('optionsApplyRequired') : t('optionsReadyToApply'),
    );
    appendText(copy, 'span', t('optionsApplyWorkflowHelp'));
    const apply = createButton(
        buttons,
        t('optionsApplyConfiguration'),
        'primary',
        t('optionsApplyingConfiguration'),
    );
    apply.onclick = () => applyConfiguration(apply);
    if (view.controlsPac) {
      const clear = createButton(
          buttons,
          t('popupTurnOffProxy'),
          'quiet',
          t('popupClearing'),
      );
      clear.onclick = () => clearConfiguration(clear);
    }

  }

  function getSectionForDraft(key) {

    if (key.startsWith('provider:')) {
      return 'routing-sources';
    }
    if (key.startsWith('site-rule:')) {
      return 'site-rules';
    }
    if (key === 'proxy-methods') {
      return 'proxy-methods';
    }
    if (key === 'updates') {
      return 'maintenance';
    }
    return 'advanced';

  }

  function confirmDiscardAll() {

    if (!hasDirtyDrafts()) {
      return;
    }
    if (window.confirm(t('optionsConfirmDiscardAll'))) {
      discardAllDrafts();
    }

  }

  async function applyConfiguration(button) {

    if (hasDirtyDrafts()) {
      setMessage(t('optionsSaveSectionBeforeApply'), 'warning');
      return;
    }
    const result = await runOperation(
        'configuration:apply',
        button,
        () => rpc.callBackground('applyPopupChanges', {
          operation: 'apply',
          draft: {},
        }),
        {
          context: 'apply',
          retry: () => applyConfiguration(button),
        },
    );
    if (result) {
      await refresh({
        message: t('optionsConfigurationApplied'),
        tone: 'success',
      });
    }

  }

  async function clearConfiguration(button) {

    const result = await runOperation(
        'configuration:clear',
        button,
        () => rpc.callBackground('clearProxy', {}),
        {
          context: 'apply',
          retry: () => clearConfiguration(button),
        },
    );
    if (result) {
      await refresh({
        message: t(result.cleanupStatus === 'deferred' ?
          'popupProxyClearDeferred' :
          'optionsConfigurationTurnedOff'),
        tone: 'success',
      });
    }

  }

  function updateDraftPresentation() {

    const dirty = getDirtyDrafts();
    root.querySelectorAll('form[data-draft-key]').forEach((form) => {
      const draft = state.drafts.get(form.dataset.draftKey);
      form.dataset.dirty = draft && draft.dirty ? 'true' : 'false';
      form.dataset.conflict = draft && draft.conflict ? 'true' : 'false';
    });
    const bar = root.querySelector('#global-action-bar');
    if (bar && state.snapshot) {
      bar.replaceChildren();
      renderGlobalActionBarContents(bar);
    }
    const setupStatus = root.querySelector('[data-setup-apply-status]');
    if (setupStatus && state.snapshot) {
      setupStatus.textContent = getSetupApplyStatus(
          getSelectedProvider(),
          deriveControlView(),
      );
    }
    const setupApply = root.querySelector('[data-setup-apply-action]');
    if (setupApply) {
      setupApply.disabled = hasDirtyDrafts() ||
        state.pending.has('configuration:apply');
    }
    const live = root.querySelector('[aria-live="polite"]');
    if (live) {
      const message = dirty.length ? formatCount(
          dirty.length,
          'optionsOneUnsavedDraft',
          'optionsManyUnsavedDrafts',
      ) : '';
      if (live.textContent !== message) {
        live.textContent = message;
      }
    }

  }

  installGlobalListeners();
  renderLoading();
  refresh({restoreFocus: false});

})();
