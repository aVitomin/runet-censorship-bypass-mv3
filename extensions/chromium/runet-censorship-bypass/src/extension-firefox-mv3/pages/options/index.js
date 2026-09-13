'use strict';
/* global globalThis, module, require */

(function publishFirefoxOptions(root, factory) {

  const runtime = typeof module === 'object' && module.exports ?
    require('../shared/ui-runtime') : root.rucbFirefoxUi;
  const api = factory(runtime);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxOptions = api;
  root.document.addEventListener('DOMContentLoaded', () => {
    api.mount(root.document, root.browser);
  });

})(typeof globalThis === 'object' ? globalThis : this, function(Ui) {

  const SETTINGS_KEYS = Object.freeze([
    'flags', 'localTor', 'ownProxies', 'rules', 'schemaVersion',
    'torBrowser', 'warp',
  ]);
  const RULE_KEYS = Object.freeze(['direct', 'proxy', 'whitelist']);
  const FLAG_KEYS = Object.freeze([
    'noDirect', 'ownProxiesOnlyForOwnSites', 'replaceDirectWithProxy',
    'useProviderProxies',
  ]);
  const CANDIDATE_KEYS = Object.freeze([
    'failoverTimeoutSeconds', 'host', 'port', 'proxyDNS', 'type',
  ]);
  const OWN_PROXY_KEYS = Object.freeze(CANDIDATE_KEYS.concat([
    'credentials', 'enabled', 'id', 'useAsDirectReplacement',
  ]));
  const SCOPED_PROXY_KEYS = Object.freeze(CANDIDATE_KEYS.concat([
    'useAsDirectReplacement', 'useForOnion', 'useForProxyRules',
  ]));
  const WARP_KEYS = Object.freeze([
    'candidates', 'useAsDirectReplacement', 'useForProxyRules',
  ]);
  const WARP_CANDIDATE_KEYS = Object.freeze(CANDIDATE_KEYS.concat(['id']));
  const CANDIDATE_TYPES = Object.freeze([
    'HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5',
  ]);
  const CONFLICT_CODES = new Set([
    'SETTINGS_REVISION_CONFLICT',
    'STALE_REVISION',
  ]);
  const NAV_ITEMS = Object.freeze([
    ['overview', 'optionsNavOverview'],
    ['automatic-routing', 'optionsNavAutomaticRouting'],
    ['site-rules', 'optionsNavSiteRules'],
    ['proxy-connections', 'optionsNavProxyConnections'],
    ['maintenance', 'optionsNavMaintenance'],
    ['advanced', 'optionsNavAdvanced'],
    ['about', 'optionsNavAbout'],
  ]);

  function validCandidateFields(value, expected, requiresId = false) {

    return Ui.hasExactKeys(value, expected) &&
      CANDIDATE_TYPES.includes(value.type) &&
      typeof value.host === 'string' && Boolean(value.host.trim()) &&
      Number.isSafeInteger(value.port) && value.port >= 1 &&
      value.port <= 65535 && typeof value.proxyDNS === 'boolean' &&
      (value.failoverTimeoutSeconds === null ||
        (Number.isSafeInteger(value.failoverTimeoutSeconds) &&
          value.failoverTimeoutSeconds >= 1)) &&
      (!requiresId ||
        (typeof value.id === 'string' && Boolean(value.id.trim())));

  }

  function validRedactedSettings(value) {

    if (!Ui.hasExactKeys(value, SETTINGS_KEYS) ||
        value.schemaVersion !== 1 ||
        !Ui.hasExactKeys(value.rules, RULE_KEYS) ||
        RULE_KEYS.some((key) => !Array.isArray(value.rules[key]) ||
          value.rules[key].some((rule) => typeof rule !== 'string')) ||
        !Ui.hasExactKeys(value.flags, FLAG_KEYS) ||
        FLAG_KEYS.some((key) => typeof value.flags[key] !== 'boolean') ||
        !Array.isArray(value.ownProxies) ||
        !validCandidateFields(
            value.localTor, SCOPED_PROXY_KEYS,
        ) ||
        !validCandidateFields(
            value.torBrowser, SCOPED_PROXY_KEYS,
        ) ||
        !Ui.hasExactKeys(value.warp, WARP_KEYS) ||
        !Array.isArray(value.warp.candidates) ||
        typeof value.warp.useAsDirectReplacement !== 'boolean' ||
        typeof value.warp.useForProxyRules !== 'boolean') {
      return false;
    }
    for (const proxy of value.ownProxies) {
      if (!validCandidateFields(proxy, OWN_PROXY_KEYS, true) ||
          typeof proxy.enabled !== 'boolean' ||
          typeof proxy.useAsDirectReplacement !== 'boolean' ||
          !proxy.credentials || typeof proxy.credentials !== 'object' ||
          Array.isArray(proxy.credentials)) {
        return false;
      }
      const credentialKeys = proxy.credentials.mode === 'NONE' ? ['mode'] :
        proxy.credentials.mode === 'KEEP' ? ['mode', 'username'] : [];
      if (!credentialKeys.length ||
          !Ui.hasExactKeys(proxy.credentials, credentialKeys) ||
          (proxy.credentials.mode === 'KEEP' &&
            typeof proxy.credentials.username !== 'string')) {
        return false;
      }
    }
    if (value.warp.candidates.some((candidate) =>
      !validCandidateFields(candidate, WARP_CANDIDATE_KEYS, true))) {
      return false;
    }
    for (const scoped of [value.localTor, value.torBrowser]) {
      if (typeof scoped.useAsDirectReplacement !== 'boolean' ||
          typeof scoped.useForOnion !== 'boolean' ||
          typeof scoped.useForProxyRules !== 'boolean') {
        return false;
      }
    }
    return true;

  }

  function validateSettingsResult(value) {

    if (!Ui.hasExactKeys(value, ['revision', 'settings']) ||
        !Number.isSafeInteger(value.revision) || value.revision < 0 ||
        !validRedactedSettings(value.settings)) {
      throw Ui.rpcError('UI_RPC_FAILED');
    }
    return Object.freeze({
      revision: value.revision,
      settings: Ui.clone(value.settings),
    });

  }

  function editableFromCapabilities(value) {

    const capabilities = Ui.validateCapabilities(value);
    return capabilities.durableIntent === 'OFF' &&
      capabilities.runtimeState === 'OFF' &&
      capabilities.recoveryStatus === 'OFF';

  }

  function parseRuleLines(value) {

    return String(value || '').split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);

  }

  function credentialPayload(existing, action, username, password) {

    if (action === 'NONE') {
      return {mode: 'NONE'};
    }
    if (action === 'KEEP' && existing && existing.mode === 'KEEP') {
      return {mode: 'KEEP', username: String(username)};
    }
    if (action === 'SET') {
      return {
        mode: 'SET',
        username: String(username),
        password: String(password),
      };
    }
    throw Ui.rpcError('UI_VALIDATION_FAILED');

  }

  function validateCandidate(value, requiresId = false) {

    if (!value || typeof value !== 'object' ||
        !CANDIDATE_TYPES.includes(value.type) ||
        typeof value.host !== 'string' || !value.host.trim() ||
        !Number.isSafeInteger(value.port) || value.port < 1 ||
        value.port > 65535 || typeof value.proxyDNS !== 'boolean' ||
        (value.failoverTimeoutSeconds !== null &&
          (!Number.isSafeInteger(value.failoverTimeoutSeconds) ||
            value.failoverTimeoutSeconds < 1)) ||
        (requiresId && (typeof value.id !== 'string' || !value.id.trim()))) {
      throw Ui.rpcError('UI_VALIDATION_FAILED');
    }
    return value;

  }

  function createController(options = {}) {

    const rpc = options.rpc;
    const changed = typeof options.changed === 'function' ?
      options.changed : () => {};
    if (!rpc || typeof rpc.call !== 'function') {
      throw Ui.rpcError('UI_RPC_FAILED');
    }
    const state = {
      capabilities: null,
      editable: false,
      errorCode: null,
      notice: null,
      operational: null,
      pending: false,
      revision: null,
      settings: null,
    };

    function snapshot() {

      return Object.freeze(Object.assign({}, state));

    }

    function emit() {

      changed(snapshot());

    }

    async function loadNow() {

      const results = await Promise.all([
        rpc.call({type: 'firefox.capabilities.get'}),
        rpc.call({type: 'firefox.settings.get'}),
        rpc.call({type: 'firefox.operational.get'}),
      ]);
      const capabilities = Ui.validateCapabilities(results[0]);
      const settings = validateSettingsResult(results[1]);
      const operational = Ui.validateOperationalStatus(results[2]);
      state.capabilities = capabilities;
      state.editable = editableFromCapabilities(capabilities);
      state.operational = operational;
      state.revision = settings.revision;
      state.settings = settings.settings;

    }

    async function load() {

      if (state.pending) {
        return false;
      }
      state.pending = true;
      state.errorCode = null;
      emit();
      try {
        await loadNow();
        return true;
      } catch (error) {
        state.errorCode = Ui.safeErrorCode(error);
        return false;
      } finally {
        state.pending = false;
        emit();
      }

    }

    async function save(nextSettings) {

      if (state.pending) {
        return false;
      }
      if (!state.editable || state.revision === null) {
        state.errorCode = 'SETTINGS_READ_ONLY';
        emit();
        return false;
      }
      state.pending = true;
      state.errorCode = null;
      state.notice = null;
      emit();
      try {
        const replaced = validateSettingsResult(await rpc.call({
          type: 'firefox.settings.replace',
          expectedRevision: state.revision,
          settings: nextSettings,
        }));
        state.revision = replaced.revision;
        state.settings = replaced.settings;
        state.notice = 'SAVED';
        return true;
      } catch (error) {
        const code = Ui.safeErrorCode(error);
        if (CONFLICT_CODES.has(code)) {
          try {
            await loadNow();
            state.notice = 'REVISION_CONFLICT';
          } catch (_reloadError) {
            state.errorCode = 'UI_RPC_FAILED';
          }
        } else {
          state.errorCode = code;
        }
        return false;
      } finally {
        state.pending = false;
        emit();
      }

    }

    async function checkHealth() {

      if (state.pending) {
        return false;
      }
      state.pending = true;
      state.errorCode = null;
      state.notice = null;
      emit();
      try {
        const health = Ui.validateHealth(await rpc.call({
          type: 'firefox.health.check',
        }));
        await loadNow();
        state.notice = `HEALTH_${health.status}`;
        return true;
      } catch (error) {
        state.errorCode = Ui.safeErrorCode(error);
        return false;
      } finally {
        state.pending = false;
        emit();
      }

    }

    return Object.freeze({checkHealth, load, save, snapshot});

  }

  function userErrorKey(code) {

    if (code === 'SETTINGS_READ_ONLY' ||
        code === 'SETTINGS_MUTATION_REQUIRES_OFF') {
      return 'optionsErrorReadOnly';
    }
    if (code === 'UI_VALIDATION_FAILED' ||
        code === 'SETTINGS_MALFORMED' ||
        code === 'SETTINGS_CREDENTIAL_AMBIGUOUS' ||
        code === 'SETTINGS_CREDENTIAL_STALE') {
      return 'optionsErrorValidation';
    }
    return 'optionsErrorGeneric';

  }

  function diagnosticsExport(value) {

    const operational = Ui.validateOperationalStatus(value);
    return JSON.stringify(operational.diagnostics, null, 2);

  }

  function mount(document, browserApi) {

    const root = document.getElementById('options-root');
    if (!root) {
      return null;
    }
    const t = (key, substitutions) =>
      Ui.translate(browserApi, key, substitutions);
    let draft = null;
    let renderedRevision = null;
    let localError = null;
    const controller = createController({
      rpc: Ui.createRpc(browserApi),
      changed: render,
    });

    function field(parent, labelKey, name, value, type = 'text') {

      const label = Ui.append(parent, 'label', 'field');
      Ui.appendText(label, 'span', t(labelKey));
      const input = Ui.append(label, type === 'select' ? 'select' : 'input');
      input.name = name;
      if (type === 'select') {
        for (const candidateType of CANDIDATE_TYPES) {
          const option = Ui.append(input, 'option');
          option.value = candidateType;
          option.textContent = candidateType;
        }
      } else {
        input.type = type;
      }
      input.value = value === null || value === undefined ? '' : String(value);
      return input;

    }

    function check(parent, labelKey, name, checked) {

      const label = Ui.append(parent, 'label', 'check');
      const input = Ui.append(label, 'input');
      input.type = 'checkbox';
      input.name = name;
      input.checked = checked === true;
      Ui.appendText(label, 'span', t(labelKey));
      return input;

    }

    function textarea(parent, labelKey, name, values) {

      const label = Ui.append(parent, 'label', 'field');
      Ui.appendText(label, 'span', t(labelKey));
      const input = Ui.append(label, 'textarea');
      input.name = name;
      input.value = values.join('\n');
      input.placeholder = t('optionsRulesPlaceholder');
      return input;

    }

    function formatTime(value) {

      if (!Number.isSafeInteger(value) || value < 1) {
        return t('optionsNone');
      }
      try {
        return new Date(value).toLocaleString();
      } catch (_error) {
        return t('optionsNone');
      }

    }

    function healthLabel(health) {

      const keys = {
        ERROR: 'healthStatusError',
        INCONCLUSIVE: 'healthStatusInconclusive',
        OK: 'healthStatusOk',
        UNKNOWN: 'healthStatusUnknown',
      };
      return t(keys[health.status] || keys.UNKNOWN);

    }

    function candidateLabel(type) {

      const keys = {
        localTor: 'optionsLocalTor',
        ownProxy: 'optionsOwnProxies',
        torBrowser: 'optionsTorBrowser',
        warp: 'optionsWarp',
      };
      return type && keys[type] ? t(keys[type]) : t('optionsNone');

    }

    function controlLabel(level) {

      const keys = {
        controlled_by_other_extensions: 'diagnosticsControlExternal',
        controlled_by_this_extension: 'diagnosticsControlOwned',
        controllable_by_this_extension: 'diagnosticsControlAvailable',
        not_controllable: 'diagnosticsControlPolicy',
        unknown: 'valueUnknown',
      };
      return t(keys[level] || keys.unknown);

    }

    function definition(parent, labelKey, value) {

      Ui.appendText(parent, 'dt', t(labelKey), 'muted');
      Ui.appendText(parent, 'dd', value || t('optionsNone'));

    }

    function downloadDiagnostics(operational) {

      const view = document.defaultView;
      if (!view || typeof view.Blob !== 'function' || !view.URL ||
          typeof view.URL.createObjectURL !== 'function') {
        throw Ui.rpcError('UI_RPC_FAILED');
      }
      const blob = new view.Blob([diagnosticsExport(operational)], {
        type: 'application/json',
      });
      const href = view.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = 'runet-censorship-bypass-firefox-diagnostics.json';
      link.click();
      view.setTimeout(() => view.URL.revokeObjectURL(href), 0);

    }

    function candidateFields(parent, value, options = {}) {

      const grid = Ui.append(parent, 'div', 'grid');
      if (options.id) {
        field(grid, 'fieldId', 'id', value.id);
      }
      field(grid, 'fieldType', 'type', value.type, 'select');
      field(grid, 'fieldHost', 'host', value.host);
      field(grid, 'fieldPort', 'port', value.port, 'number');
      field(
          grid,
          'fieldFailoverTimeout',
          'failoverTimeoutSeconds',
          value.failoverTimeoutSeconds,
          'number',
      );
      check(grid, 'fieldProxyDns', 'proxyDNS', value.proxyDNS);
      if (options.enabled) {
        check(grid, 'fieldEnabled', 'enabled', value.enabled);
      }
      if (options.proxyRules) {
        check(
            grid,
            'fieldUseForProxyRules',
            'useForProxyRules',
            value.useForProxyRules,
        );
      }
      if (options.onion) {
        check(grid, 'fieldUseForOnion', 'useForOnion', value.useForOnion);
      }
      if (options.directReplacement) {
        check(
            grid,
            'fieldUseAsDirectReplacement',
            'useAsDirectReplacement',
            value.useAsDirectReplacement,
        );
      }
      return grid;

    }

    function actionButton(parent, key, action, index, disabled) {

      const button = Ui.append(parent, 'button');
      button.type = 'button';
      button.textContent = t(key);
      button.dataset.action = action;
      button.dataset.index = String(index);
      button.disabled = disabled;
      return button;

    }

    function renderOrderedHeader(parent, title, group, index, length, disabled) {

      const header = Ui.append(parent, 'div', 'candidate-header');
      Ui.appendText(header, 'h3', title);
      const actions = Ui.append(header, 'div', 'candidate-actions');
      actionButton(actions, 'actionMoveUp', `${group}-up`, index,
          disabled || index === 0);
      actionButton(actions, 'actionMoveDown', `${group}-down`, index,
          disabled || index === length - 1);
      actionButton(actions, 'actionRemove', `${group}-remove`, index, disabled);

    }

    function renderOwnProxy(parent, proxy, index, length, disabled) {

      const row = Ui.append(parent, 'article', 'candidate');
      row.dataset.kind = 'own';
      row.dataset.index = String(index);
      renderOrderedHeader(
          row,
          proxy.id || t('optionsOwnProxyUntitled'),
          'own',
          index,
          length,
          disabled,
      );
      candidateFields(row, proxy, {
        directReplacement: true, enabled: true, id: true,
      });
      const credentialGrid = Ui.append(row, 'div', 'grid credentials');
      const existing = proxy.credentials && proxy.credentials.mode === 'KEEP';
      const modeLabel = Ui.append(credentialGrid, 'label', 'field');
      Ui.appendText(modeLabel, 'span', t('fieldCredentials'));
      const mode = Ui.append(modeLabel, 'select');
      mode.name = 'credentialMode';
      const modes = existing ? ['KEEP', 'SET', 'NONE'] : ['NONE', 'SET'];
      for (const value of modes) {
        const option = Ui.append(mode, 'option');
        option.value = value;
        option.textContent = t(`credential${value}`);
      }
      mode.value = proxy.credentials && proxy.credentials.mode || 'NONE';
      field(
          credentialGrid,
          'fieldUsername',
          'username',
          proxy.credentials && proxy.credentials.username || '',
      );
      const password = field(
          credentialGrid, 'fieldNewPassword', 'password', '', 'password',
      );
      password.autocomplete = 'new-password';
      Ui.appendText(
          row,
          'p',
          existing ? t('optionsPasswordKept') : t('optionsPasswordEmpty'),
          'muted technical-note',
      );

    }

    function renderWarpCandidate(parent, candidate, index, length, disabled) {

      const row = Ui.append(parent, 'article', 'candidate');
      row.dataset.kind = 'warp';
      row.dataset.index = String(index);
      renderOrderedHeader(
          row,
          candidate.id || t('optionsWarpUntitled'),
          'warp',
          index,
          length,
          disabled,
      );
      candidateFields(row, candidate, {id: true});

    }

    function renderScoped(parent, titleKey, name, value) {

      const section = Ui.append(parent, 'article', 'subsection');
      Ui.appendText(section, 'h2', t(titleKey));
      const candidate = Ui.append(section, 'div', 'candidate');
      candidate.dataset.kind = name;
      candidateFields(candidate, value, {
        directReplacement: true,
        onion: true,
        proxyRules: true,
      });

    }

    function readNumber(row, name, allowEmpty = false) {

      const raw = row.querySelector(`[name="${name}"]`).value.trim();
      if (allowEmpty && !raw) {
        return null;
      }
      const number = Number(raw);
      if (!Number.isSafeInteger(number)) {
        throw Ui.rpcError('UI_VALIDATION_FAILED');
      }
      return number;

    }

    function readCandidate(row, requiresId) {

      const value = {
        type: row.querySelector('[name="type"]').value,
        host: row.querySelector('[name="host"]').value,
        port: readNumber(row, 'port'),
        proxyDNS: row.querySelector('[name="proxyDNS"]').checked,
        failoverTimeoutSeconds: readNumber(
            row, 'failoverTimeoutSeconds', true,
        ),
      };
      if (requiresId) {
        value.id = row.querySelector('[name="id"]').value;
      }
      return validateCandidate(value, requiresId);

    }

    function collect(form) {

      const next = Ui.clone(draft);
      next.rules = {
        direct: parseRuleLines(form.elements.directRules.value),
        proxy: parseRuleLines(form.elements.proxyRules.value),
        whitelist: parseRuleLines(form.elements.whitelistRules.value),
      };
      for (const key of [
        'noDirect',
        'ownProxiesOnlyForOwnSites',
        'replaceDirectWithProxy',
        'useProviderProxies',
      ]) {
        next.flags[key] = form.elements[key].checked;
      }
      next.ownProxies = Array.from(
          form.querySelectorAll('[data-kind="own"]'),
      ).map((row, index) => {
        const candidate = readCandidate(row, true);
        const existing = draft.ownProxies[index] &&
          draft.ownProxies[index].credentials;
        return Object.assign(candidate, {
          enabled: row.querySelector('[name="enabled"]').checked,
          useAsDirectReplacement: row.querySelector(
              '[name="useAsDirectReplacement"]',
          ).checked,
          credentials: credentialPayload(
              existing,
              row.querySelector('[name="credentialMode"]').value,
              row.querySelector('[name="username"]').value,
              row.querySelector('[name="password"]').value,
          ),
        });
      });
      for (const name of ['localTor', 'torBrowser']) {
        const row = form.querySelector(`[data-kind="${name}"]`);
        next[name] = Object.assign(readCandidate(row, false), {
          useAsDirectReplacement: row.querySelector(
              '[name="useAsDirectReplacement"]',
          ).checked,
          useForOnion: row.querySelector('[name="useForOnion"]').checked,
          useForProxyRules: row.querySelector(
              '[name="useForProxyRules"]',
          ).checked,
        });
      }
      next.warp = {
        candidates: Array.from(
            form.querySelectorAll('[data-kind="warp"]'),
        ).map((row) => readCandidate(row, true)),
        useAsDirectReplacement:
          form.elements.warpUseAsDirectReplacement.checked,
        useForProxyRules: form.elements.warpUseForProxyRules.checked,
      };
      return next;

    }

    function uniqueId(prefix, values) {

      const used = new Set(values.map((value) => value.id));
      for (let number = 1; number <= 9999; number += 1) {
        const candidate = `${prefix}-${number}`;
        if (!used.has(candidate)) {
          return candidate;
        }
      }
      throw Ui.rpcError('UI_VALIDATION_FAILED');

    }

    function newCandidate(id) {

      return {
        id,
        type: 'HTTPS',
        host: '127.0.0.1',
        port: 443,
        proxyDNS: false,
        failoverTimeoutSeconds: null,
      };

    }

    function move(list, index, direction) {

      const target = index + direction;
      if (index < 0 || target < 0 || index >= list.length ||
          target >= list.length) {
        return;
      }
      const temporary = list[index];
      list[index] = list[target];
      list[target] = temporary;

    }

    function render(state) {

      if (state.settings && renderedRevision !== state.revision) {
        draft = Ui.clone(state.settings);
        renderedRevision = state.revision;
      }
      Ui.clear(root);
      root.setAttribute('aria-busy', state.pending ? 'true' : 'false');
      document.title = t('optionsTitle');
      const header = Ui.append(root, 'header', 'page-header');
      Ui.appendText(header, 'h1', t('optionsTitle'));
      Ui.appendText(header, 'p', t('optionsSubtitle'), 'muted');
      if (!draft) {
        const loading = Ui.append(root, 'section', 'card section');
        Ui.appendText(
            loading,
            'p',
            state.errorCode ? t('optionsLoadFailed') : t('optionsLoading'),
            `status ${state.errorCode ? 'error' : ''}`,
        );
        const retry = Ui.append(loading, 'button', 'primary');
        retry.type = 'button';
        retry.textContent = t('actionRetry');
        retry.disabled = state.pending;
        retry.addEventListener('click', () => controller.load());
        return;
      }
      const disabled = !state.editable || state.pending;
      const layout = Ui.append(root, 'div', 'options-layout');
      const nav = Ui.append(layout, 'nav', 'options-nav card');
      nav.setAttribute('aria-label', t('optionsNavigationLabel'));
      for (const [id, labelKey] of NAV_ITEMS) {
        const link = Ui.append(nav, 'a');
        link.href = `#${id}`;
        link.textContent = t(labelKey);
      }
      const content = Ui.append(layout, 'div', 'options-content');
      if (!state.editable) {
        Ui.appendText(
            content,
            'p',
            t('optionsReadOnlyHelp'),
            'status warning read-only',
        );
      }
      const form = Ui.append(content, 'form');
      form.id = 'settings-form';

      const overview = Ui.append(form, 'section', 'card section');
      overview.id = 'overview';
      Ui.appendText(overview, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(overview, 'h2', t('optionsNavOverview'));
      const overviewFacts = Ui.append(overview, 'dl', 'overview-facts');
      const overviewRows = [
        ['optionsProtectionState', state.capabilities.runtimeState === 'READY' ?
          'popupStateActive' : state.capabilities.runtimeState ===
            'INITIALIZING' ? 'popupStateInitializing' :
              state.capabilities.runtimeState === 'FAILED' ?
                'popupStateBlocked' : 'popupStateOff'],
        ['popupDataset', state.capabilities.providerDatasetAvailable ?
          'valueAvailable' : 'valueUnavailable'],
        ['popupPrivateAccess', state.capabilities.privateWindowAccess ===
          'GRANTED' ? 'valueGranted' : state.capabilities.privateWindowAccess ===
            'DENIED' ? 'valueDenied' : 'valueUnknown'],
      ];
      for (const [labelKey, valueKey] of overviewRows) {
        const row = Ui.append(overviewFacts, 'div', 'overview-fact');
        Ui.appendText(row, 'dt', t(labelKey), 'muted');
        Ui.appendText(row, 'dd', t(valueKey));
      }

      const automatic = Ui.append(form, 'section', 'card section');
      automatic.id = 'automatic-routing';
      Ui.appendText(automatic, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(automatic, 'h2', t('optionsNavAutomaticRouting'));
      Ui.appendText(
          automatic, 'p', t('optionsAutomaticSourceHelp'), 'muted',
      );
      const sourceCard = Ui.append(automatic, 'div', 'source-card');
      Ui.appendText(sourceCard, 'strong', t('optionsAnticensoritySource'));
      Ui.appendText(
          sourceCard, 'span',
          state.capabilities.providerDatasetAvailable ?
            t('valueAvailable') : t('valueUnavailable'),
          `pill ${state.capabilities.providerDatasetAvailable ?
            'success' : 'warning'}`,
      );
      const automaticFlags = Ui.append(automatic, 'div', 'flags');
      for (const key of [
        'useProviderProxies',
        'ownProxiesOnlyForOwnSites',
      ]) {
        check(automaticFlags,
            `flag${key[0].toUpperCase()}${key.slice(1)}`,
            key, draft.flags[key]);
      }

      const rules = Ui.append(form, 'section', 'card section');
      rules.id = 'site-rules';
      Ui.appendText(rules, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(rules, 'h2', t('optionsRulesTitle'));
      Ui.appendText(rules, 'p', t('optionsRulesHelp'), 'muted');
      const ruleGrid = Ui.append(rules, 'div', 'grid');
      textarea(ruleGrid, 'optionsDirectRules', 'directRules',
          draft.rules.direct);
      textarea(ruleGrid, 'optionsProxyRules', 'proxyRules',
          draft.rules.proxy);
      textarea(ruleGrid, 'optionsWhitelistRules', 'whitelistRules',
          draft.rules.whitelist);

      const own = Ui.append(form, 'section', 'card section');
      own.id = 'proxy-connections';
      Ui.appendText(own, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(own, 'h2', t('optionsOwnProxies'));
      Ui.appendText(own, 'p', t('optionsOwnProxiesHelp'), 'muted');
      const ownList = Ui.append(own, 'div', 'candidate-list');
      draft.ownProxies.forEach((proxy, index) =>
        renderOwnProxy(
            ownList, proxy, index, draft.ownProxies.length, disabled,
        ));
      const addOwn = Ui.append(own, 'button');
      addOwn.type = 'button';
      addOwn.textContent = t('actionAddProxy');
      addOwn.dataset.action = 'own-add';

      const maintenance = Ui.append(form, 'section', 'card section');
      maintenance.id = 'maintenance';
      Ui.appendText(maintenance, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(maintenance, 'h2', t('optionsNavMaintenance'));
      Ui.appendText(maintenance, 'p', t('optionsMaintenanceHelp'), 'muted');
      const maintenanceFacts = Ui.append(maintenance, 'div', 'source-card');
      Ui.appendText(
          maintenanceFacts, 'strong', t('optionsLocalDatasetTitle'),
      );
      Ui.appendText(
          maintenanceFacts, 'span',
          state.capabilities.providerDatasetAvailable ?
            t('valueAvailable') : t('valueUnavailable'),
          `pill ${state.capabilities.providerDatasetAvailable ?
            'success' : 'warning'}`,
      );
      const health = state.operational.health;
      const healthCard = Ui.append(maintenance, 'article', 'subsection');
      const healthHeader = Ui.append(healthCard, 'div', 'section-row');
      Ui.appendText(healthHeader, 'h3', t('healthConnectionTitle'));
      Ui.appendText(
          healthHeader,
          'span',
          healthLabel(health),
          `pill ${health.status === 'OK' ? 'success' :
            health.status === 'ERROR' ? 'error' : 'warning'}`,
      );
      Ui.appendText(
          healthCard, 'p', t('healthConnectionHelp'), 'muted',
      );
      const healthFacts = Ui.append(healthCard, 'dl', 'overview-facts');
      definition(
          healthFacts, 'healthLastChecked', formatTime(health.checkedAt),
      );
      definition(
          healthFacts, 'healthCheckedCandidate',
          candidateLabel(health.candidateType),
      );
      if (health.status === 'ERROR' ||
          health.status === 'INCONCLUSIVE') {
        Ui.appendText(
            healthCard,
            'p',
            t(health.code ? `healthCode_${health.code}` :
              'healthStatusInconclusive'),
            `status ${health.status === 'ERROR' ? 'error' : 'warning'}`,
        );
      }
      const healthButton = Ui.append(healthCard, 'button', 'primary');
      healthButton.type = 'button';
      healthButton.dataset.operational = 'true';
      healthButton.textContent = t(health.status === 'ERROR' ?
        'healthCheckAgain' : 'healthCheckAction');
      healthButton.disabled = state.pending ||
        state.capabilities.runtimeState !== 'READY';
      healthButton.addEventListener('click', () => controller.checkHealth());

      const diagnostic = state.operational.diagnostics;
      const diagnostics = Ui.append(maintenance, 'details', 'subsection');
      const diagnosticsSummary = Ui.append(diagnostics, 'summary');
      diagnosticsSummary.textContent = t('diagnosticsTitle');
      Ui.appendText(
          diagnostics, 'p', t('diagnosticsRedactionHelp'), 'muted',
      );
      const diagnosticFacts = Ui.append(
          diagnostics, 'dl', 'overview-facts diagnostics-facts',
      );
      definition(
          diagnosticFacts, 'diagnosticsExtensionVersion',
          diagnostic.extensionVersion,
      );
      definition(
          diagnosticFacts, 'diagnosticsBrowserVersion',
          [diagnostic.browserName, diagnostic.browserVersion]
              .filter(Boolean).join(' '),
      );
      definition(
          diagnosticFacts, 'diagnosticsRuntimeState',
          diagnostic.runtimeState,
      );
      definition(
          diagnosticFacts, 'diagnosticsRecoveryState',
          diagnostic.recoveryStatus,
      );
      definition(
          diagnosticFacts, 'diagnosticsControlState',
          controlLabel(diagnostic.controlLevel),
      );
      definition(
          diagnosticFacts, 'diagnosticsDatasetVersion',
          diagnostic.datasetVersion,
      );
      definition(
          diagnosticFacts, 'diagnosticsProxyCounts',
          `${diagnostic.enabledProxyCount}/${diagnostic.configuredProxyCount}`,
      );
      definition(
          diagnosticFacts, 'diagnosticsProxyTypes',
          diagnostic.proxyTypes.join(', ') || t('optionsNone'),
      );
      definition(
          diagnosticFacts, 'popupPrivateAccess',
          t(diagnostic.privateWindowAccess === 'GRANTED' ? 'valueGranted' :
            diagnostic.privateWindowAccess === 'DENIED' ? 'valueDenied' :
              'valueUnknown'),
      );
      const exported = Ui.append(
          diagnostics, 'pre', 'diagnostics-export technical-note',
      );
      exported.textContent = diagnosticsExport(state.operational);
      const download = Ui.append(diagnostics, 'button');
      download.type = 'button';
      download.dataset.operational = 'true';
      download.textContent = t('diagnosticsDownload');
      download.addEventListener('click', () => {
        try {
          downloadDiagnostics(state.operational);
        } catch (_error) {
          localError = 'UI_RPC_FAILED';
          render(controller.snapshot());
        }
      });

      const notificationCard = Ui.append(
          maintenance, 'article', 'subsection',
      );
      Ui.appendText(
          notificationCard, 'h3', t('notificationsAttentionTitle'),
      );
      Ui.appendText(
          notificationCard,
          'p',
          t(diagnostic.notificationsAvailable ?
            'notificationsAttentionEnabled' :
            'notificationsAttentionUnavailable'),
          'muted',
      );

      const advanced = Ui.append(form, 'section', 'card section');
      advanced.id = 'advanced';
      Ui.appendText(advanced, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(advanced, 'h2', t('optionsNavAdvanced'));
      Ui.appendText(advanced, 'p', t('optionsAdvancedHelp'), 'muted');
      const advancedFlags = Ui.append(advanced, 'div', 'flags');
      for (const key of ['replaceDirectWithProxy', 'noDirect']) {
        check(advancedFlags,
            `flag${key[0].toUpperCase()}${key.slice(1)}`,
            key, draft.flags[key]);
      }

      renderScoped(advanced, 'optionsLocalTor', 'localTor', draft.localTor);
      renderScoped(
          advanced, 'optionsTorBrowser', 'torBrowser', draft.torBrowser,
      );

      const warp = Ui.append(advanced, 'article', 'subsection');
      Ui.appendText(warp, 'h2', t('optionsWarp'));
      const warpFlags = Ui.append(warp, 'div', 'flags');
      check(warpFlags, 'fieldUseForProxyRules', 'warpUseForProxyRules',
          draft.warp.useForProxyRules);
      check(
          warpFlags,
          'fieldUseAsDirectReplacement',
          'warpUseAsDirectReplacement',
          draft.warp.useAsDirectReplacement,
      );
      const warpList = Ui.append(warp, 'div', 'candidate-list');
      draft.warp.candidates.forEach((candidate, index) =>
        renderWarpCandidate(
            warpList, candidate, index, draft.warp.candidates.length, disabled,
        ));
      const addWarp = Ui.append(warp, 'button');
      addWarp.type = 'button';
      addWarp.textContent = t('actionAddWarp');
      addWarp.dataset.action = 'warp-add';

      const about = Ui.append(form, 'section', 'card section');
      about.id = 'about';
      Ui.appendText(about, 'p', t('optionsSectionEyebrow'), 'eyebrow');
      Ui.appendText(about, 'h2', t('optionsNavAbout'));
      Ui.appendText(about, 'p', t('optionsAboutHelp'), 'muted');
      const manifest = browserApi.runtime.getManifest();
      Ui.appendText(
          about, 'p', t('optionsVersion', [manifest.version]),
          'technical-note',
      );

      const actions = Ui.append(form, 'div', 'form-actions');
      const save = Ui.append(actions, 'button', 'primary');
      save.type = 'submit';
      save.textContent = t('actionSave');
      const reload = Ui.append(actions, 'button');
      reload.type = 'button';
      reload.textContent = t('actionReload');
      reload.addEventListener('click', () => controller.load());
      let statusKey = 'optionsReady';
      let statusClass = 'status';
      if (localError || state.errorCode) {
        statusKey = userErrorKey(localError || state.errorCode);
        statusClass = 'status error';
      } else if (state.notice === 'REVISION_CONFLICT') {
        statusKey = 'optionsRevisionConflict';
        statusClass = 'status warning';
      } else if (state.notice === 'SAVED') {
        statusKey = 'optionsSaved';
        statusClass = 'status success';
      } else if (!state.editable) {
        statusKey = 'optionsReadOnlyShort';
        statusClass = 'status warning';
      }
      const status = Ui.appendText(actions, 'p', t(statusKey), statusClass);
      status.setAttribute('aria-live', 'polite');

      for (const control of form.elements) {
        control.disabled = disabled && control.dataset.operational !== 'true';
      }
      healthButton.disabled = state.pending ||
        state.capabilities.runtimeState !== 'READY';
      download.disabled = state.pending;
      reload.disabled = state.pending;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        localError = null;
        try {
          draft = collect(form);
        } catch (error) {
          localError = error.code || 'UI_VALIDATION_FAILED';
          render(controller.snapshot());
          return;
        }
        const saved = await controller.save(draft);
        if (!saved) {
          draft.ownProxies.forEach((proxy) => {
            if (proxy.credentials && proxy.credentials.mode === 'SET') {
              proxy.credentials.password = '';
            }
          });
        }
      });
      form.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button || disabled) {
          return;
        }
        localError = null;
        try {
          draft = collect(form);
          const action = button.dataset.action;
          const index = Number(button.dataset.index);
          if (action === 'own-add') {
            draft.ownProxies.push(Object.assign(
                newCandidate(uniqueId('own', draft.ownProxies)),
                {
                  enabled: true,
                  useAsDirectReplacement: false,
                  credentials: {mode: 'NONE'},
                },
            ));
          } else if (action === 'warp-add') {
            draft.warp.candidates.push(newCandidate(
                uniqueId('warp', draft.warp.candidates),
            ));
          } else if (action === 'own-remove') {
            draft.ownProxies.splice(index, 1);
          } else if (action === 'warp-remove') {
            draft.warp.candidates.splice(index, 1);
          } else if (action === 'own-up' || action === 'own-down') {
            move(draft.ownProxies, index, action.endsWith('up') ? -1 : 1);
          } else if (action === 'warp-up' || action === 'warp-down') {
            move(
                draft.warp.candidates,
                index,
                action.endsWith('up') ? -1 : 1,
            );
          }
          render(controller.snapshot());
        } catch (error) {
          localError = error.code || 'UI_VALIDATION_FAILED';
          render(controller.snapshot());
        }
      });

    }

    controller.load();
    return controller;

  }

  return Object.freeze({
    CANDIDATE_TYPES,
    NAV_ITEMS,
    createController,
    credentialPayload,
    diagnosticsExport,
    editableFromCapabilities,
    mount,
    parseRuleLines,
    userErrorKey,
    validateCandidate,
    validateSettingsResult,
  });

});
