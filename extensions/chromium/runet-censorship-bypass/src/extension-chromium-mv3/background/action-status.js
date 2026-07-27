'use strict';

(function(exports) {

  const BADGE_COLORS = Object.freeze({
    auto: '#1D4ED8',
    proxy: '#166534',
    direct: '#475569',
    off: '#475569',
    external: '#6B21A8',
    warning: '#B91C1C',
    busy: '#334155',
    loading: '#475569',
  });
  const BADGE_TEXT_COLOR = '#FFFFFF';
  const TOOLBAR_ICON_SIZES = Object.freeze([16, 19, 20, 32, 38]);
  const LARGE_ICON_SIZES = Object.freeze([48, 128]);
  const MAX_CACHED_TABS = 256;
  const actionStateByApi = new WeakMap();

  function createIconPathMap(state, ifIncludeLarge) {

    const sizes = ifIncludeLarge ?
      TOOLBAR_ICON_SIZES.concat(LARGE_ICON_SIZES) :
      TOOLBAR_ICON_SIZES;
    return Object.freeze(sizes.reduce((paths, size) => {
      paths[size] = `icons/action-${state}-${size}.png`;
      return paths;
    }, {}));

  }

  const ICON_PATHS = Object.freeze({
    active: createIconPathMap('active', true),
    off: createIconPathMap('off', false),
    external: createIconPathMap('external', false),
    busy: createIconPathMap('busy', false),
    warning: createIconPathMap('warning', false),
    loading: createIconPathMap('loading', false),
  });
  const NOTIFICATION_ICON_PATH = 'icons/action-active-128.png';
  const RUNTIME_ICON_PATHS = Object.freeze(Array.from(new Set(
      Object.values(ICON_PATHS)
          .flatMap((paths) => Object.values(paths))
          .concat(NOTIFICATION_ICON_PATH),
  )));

  function getMessage(key, fallback) {

    if (
      typeof chrome !== 'undefined' &&
      chrome.i18n &&
      typeof chrome.i18n.getMessage === 'function'
    ) {
      return chrome.i18n.getMessage(key) || fallback;
    }
    return fallback;

  }

  function getProxyControl(status) {

    return status.proxyControl && typeof status.proxyControl === 'object' ?
      status.proxyControl :
      {};

  }

  function ifProxyControlIsExternal(status) {

    const control = getProxyControl(status);
    const level = String(control.levelOfControl || '');
    return control.controlledByThisExtension !== true && (
      level === 'controlled_by_other_extensions' ||
      level === 'not_controllable' ||
      Boolean(level) && control.canControl === false
    );

  }

  function ifControlsPac(status) {

    const control = getProxyControl(status);
    return status.proxyApplied === true || control.controlsPac === true;

  }

  function getTransientOperation(status) {

    if (['apply', 'clear', 'refresh', 'check'].includes(status.operation)) {
      return status.operation;
    }
    return '';

  }

  function ifOperationFailed(status) {

    return Boolean(status.error) ||
      status.proxyApplyStatus === 'error' ||
      status.pacDownloadStatus === 'error' ||
      status.pacCookStatus === 'error' ||
      status.autoUpdate && status.autoUpdate.status === 'error';

  }

  function getActionTitle(kind, operation) {

    if (kind === 'external') {
      return getMessage(
          'actionTitleExternal',
          'Proxy settings are controlled by another extension or browser ' +
            'policy. Open the extension for recovery steps.',
      );
    }
    if (kind === 'busy') {
      const titles = {
        apply: [
          'actionTitleApplying',
          'Applying changes…',
        ],
        clear: [
          'actionTitleClearing',
          'Turning off extension proxy…',
        ],
        refresh: [
          'actionTitleRefreshing',
          'Updating routing data…',
        ],
        check: [
          'actionTitleChecking',
          'Testing proxy connection…',
        ],
      };
      const entry = titles[operation] || titles.apply;
      return getMessage(entry[0], entry[1]);
    }
    const titles = {
      loading: [
        'actionTitleLoading',
        'Checking extension proxy state…',
      ],
      off: [
        'actionTitleOff',
        'Extension proxy is off. Chromium uses system proxy settings.',
      ],
      stale: [
        'actionTitleStale',
        'Extension proxy is on — Saved settings are newer than active ' +
          'routing rules. Open the extension to apply.',
      ],
      error: [
        'actionTitleError',
        'Extension proxy is on — An operation needs attention. Open the ' +
          'extension to retry.',
      ],
      controlError: [
        'actionTitleControlError',
        'Extension proxy state could not be confirmed. Open the extension ' +
          'to check again.',
      ],
      healthWarning: [
        'actionTitleHealthWarning',
        'Extension proxy is on — The last proxy check failed. Open the ' +
          'extension to test again.',
      ],
      auto: [
        'actionTitleActiveAuto',
        'Extension proxy is on — Current site: Auto',
      ],
      proxy: [
        'actionTitleActiveProxy',
        'Extension proxy is on — Current site: Proxy',
      ],
      direct: [
        'actionTitleActiveDirect',
        'Extension proxy is on — Current site: Direct',
      ],
      unsupported: [
        'actionTitleActiveUnavailable',
        'Extension proxy is on — Current page routing is unavailable',
      ],
    };
    const entry = titles[kind] || titles.loading;
    return getMessage(entry[0], entry[1]);

  }

  function createPresentation(kind, iconState, badge, options = {}) {

    const presentation = {
      kind,
      iconState,
      iconPath: ICON_PATHS[iconState],
      badgeText: badge.text,
      badgeTone: badge.tone,
      badgeColor: BADGE_COLORS[badge.tone],
      badgeTextColor: BADGE_TEXT_COLOR,
      title: getActionTitle(kind, options.operation),
      transient: options.transient === true,
    };
    presentation.fingerprint = JSON.stringify([
      presentation.kind,
      presentation.iconState,
      presentation.badgeText,
      presentation.badgeTone,
      presentation.badgeColor,
      presentation.badgeTextColor,
      presentation.title,
      presentation.transient,
    ]);
    return Object.freeze(presentation);

  }

  function deriveActionViewModel(status = {}) {

    if (ifProxyControlIsExternal(status)) {
      return createPresentation(
          'external',
          'external',
          {text: 'EXT', tone: 'external'},
      );
    }
    const operation = getTransientOperation(status);
    if (operation) {
      return createPresentation(
          'busy',
          'busy',
          {text: '…', tone: 'busy'},
          {operation, transient: true},
      );
    }
    const control = getProxyControl(status);
    if (control.error && !control.levelOfControl) {
      return createPresentation(
          'controlError',
          'warning',
          {text: '!', tone: 'warning'},
      );
    }
    const hasControlEvidence = typeof status.proxyApplied === 'boolean' ||
      Boolean(control.levelOfControl) ||
      Boolean(control.checkedAt);
    if (
      status.loading === true ||
      status.lifecycle === 'reconstructing' ||
      !hasControlEvidence
    ) {
      return createPresentation(
          'loading',
          'loading',
          {text: '…', tone: 'loading'},
          {transient: true},
      );
    }
    if (!ifControlsPac(status)) {
      return createPresentation(
          'off',
          'off',
          {text: 'OFF', tone: 'off'},
      );
    }
    if (ifOperationFailed(status)) {
      return createPresentation(
          'error',
          'warning',
          {text: '!', tone: 'warning'},
      );
    }
    if (status.pacStale === true) {
      return createPresentation(
          'stale',
          'warning',
          {text: '!', tone: 'warning'},
      );
    }
    if (status.proxyHealth && status.proxyHealth.status === 'error') {
      return createPresentation(
          'healthWarning',
          'warning',
          {text: '!', tone: 'warning'},
      );
    }
    if (status.controllable === false) {
      return createPresentation(
          'unsupported',
          'active',
          {text: '', tone: 'auto'},
      );
    }
    const mode = ['proxy', 'direct'].includes(status.mode) ?
      status.mode :
      'auto';
    return createPresentation(
        mode,
        'active',
        {
          text: mode === 'auto' ? 'A' : mode === 'proxy' ? 'P' : 'D',
          tone: mode,
        },
    );

  }

  function getBadgeStatus(status = {}) {

    const viewModel = deriveActionViewModel(status);
    return {
      text: viewModel.badgeText,
      color: viewModel.badgeColor,
      tone: viewModel.badgeTone,
    };

  }

  function formatTitle(status = {}) {

    return deriveActionViewModel(status).title;

  }

  function getIconPath(status = {}) {

    return deriveActionViewModel(status).iconPath;

  }

  function getRuntimeIconPaths() {

    return RUNTIME_ICON_PATHS.slice();

  }

  function resolveActionIconPaths(iconPaths, runtimeApi) {

    if (!runtimeApi || typeof runtimeApi.getURL !== 'function') {
      return null;
    }
    try {
      return Object.keys(iconPaths).reduce((resolved, size) => {
        const iconUrl = new URL(runtimeApi.getURL(iconPaths[size]));
        if (
          iconUrl.protocol !== 'chrome-extension:' ||
          !iconUrl.hostname ||
          (
            typeof runtimeApi.id === 'string' &&
            runtimeApi.id &&
            iconUrl.hostname !== runtimeApi.id
          )
        ) {
          throw new TypeError('Runtime icon URL is invalid.');
        }
        resolved[size] = iconUrl.href;
        return resolved;
      }, {});
    } catch (err) {
      return null;
    }

  }

  async function updateStatus(status = {}, options = {}) {

    const actionApi = options.actionApi ||
      (typeof chrome !== 'undefined' && chrome.action);
    const runtimeApi = options.runtimeApi ||
      (typeof chrome !== 'undefined' && chrome.runtime);
    if (!actionApi) {
      return {ok: false, status: 'unavailable'};
    }
    const tabId = Number.isInteger(options.tabId) ? options.tabId : null;
    const cacheKey = tabId === null ? 'global' : tabId;
    let cache = actionStateByApi.get(actionApi);
    if (!cache) {
      cache = new Map();
      actionStateByApi.set(actionApi, cache);
    }
    const previous = cache.get(cacheKey) || {};
    const presentation = deriveActionViewModel(status);
    if (
      options.forcePresentation !== true &&
      previous.fingerprint === presentation.fingerprint
    ) {
      return {
        ok: true,
        badge: {
          text: presentation.badgeText,
          color: presentation.badgeColor,
          tone: presentation.badgeTone,
        },
        iconPath: presentation.iconPath,
        presentation,
        fingerprint: presentation.fingerprint,
        changed: [],
        failed: [],
      };
    }
    const tabParams = tabId === null ? {} : {tabId};
    const changes = [
      ['iconState', 'setIcon', null],
      [
        'badgeText',
        'setBadgeText',
        Object.assign({text: presentation.badgeText}, tabParams),
      ],
      [
        'badgeColor',
        'setBadgeBackgroundColor',
        Object.assign({color: presentation.badgeColor}, tabParams),
      ],
      ['title', 'setTitle', Object.assign({title: presentation.title}, tabParams)],
    ];
    if (typeof actionApi.setBadgeTextColor === 'function') {
      changes.splice(3, 0, [
        'badgeTextColor',
        'setBadgeTextColor',
        Object.assign({color: presentation.badgeTextColor}, tabParams),
      ]);
    }
    const requiredChanges = changes.filter(([key]) =>
      options.forcePresentation === true ||
      previous[key] !== presentation[key],
    );
    const results = await Promise.all(requiredChanges.map(
        ([key, method, params]) => {
          if (key !== 'iconState') {
            return callAction(actionApi, runtimeApi, method, params);
          }
          const absoluteIconPaths = resolveActionIconPaths(
              presentation.iconPath,
              runtimeApi,
          );
          return absoluteIconPaths ?
            callAction(
                actionApi,
                runtimeApi,
                method,
                Object.assign({path: absoluteIconPaths}, tabParams),
            ) :
            false;
        },
    ));
    const ok = results.every(Boolean);
    const next = Object.assign({}, previous);
    delete next.fingerprint;
    results.forEach((ifSucceeded, index) => {
      if (ifSucceeded) {
        const key = requiredChanges[index][0];
        next[key] = presentation[key];
      }
    });
    if (ok) {
      next.fingerprint = presentation.fingerprint;
    }
    if (ok || results.some(Boolean)) {
      cache.delete(cacheKey);
      cache.set(cacheKey, next);
      while (cache.size > MAX_CACHED_TABS) {
        cache.delete(cache.keys().next().value);
      }
    }
    return {
      ok,
      badge: {
        text: presentation.badgeText,
        color: presentation.badgeColor,
        tone: presentation.badgeTone,
      },
      iconPath: presentation.iconPath,
      presentation,
      fingerprint: presentation.fingerprint,
      changed: requiredChanges.map(([, method]) => method),
      failed: requiredChanges
          .filter((change, index) => !results[index])
          .map(([, method]) => method),
    };

  }

  function forgetStatus(tabId, options = {}) {

    const actionApi = options.actionApi ||
      (typeof chrome !== 'undefined' && chrome.action);
    const cache = actionApi && actionStateByApi.get(actionApi);
    if (cache) {
      cache.delete(Number.isInteger(tabId) ? tabId : 'global');
    }

  }

  function callAction(actionApi, runtimeApi, method, params) {

    return new Promise((resolve) => {
      let ifSettled = false;
      const finish = (ifSucceeded) => {
        if (!ifSettled) {
          ifSettled = true;
          resolve(ifSucceeded);
        }
      };
      if (!actionApi || typeof actionApi[method] !== 'function') {
        finish(false);
        return;
      }
      try {
        const result = actionApi[method](params, () => {
          const error = runtimeApi && runtimeApi.lastError;
          finish(!error);
        });
        if (result && typeof result.then === 'function') {
          result.then(
              () => finish(true),
              () => finish(false),
          );
        }
      } catch (err) {
        finish(false);
      }
    });

  }

  function createRefreshCoordinator(options = {}) {

    const chromeApi = options.chromeApi ||
      (typeof chrome !== 'undefined' ? chrome : null);
    if (
      !chromeApi ||
      typeof options.loadState !== 'function' ||
      typeof options.createStatus !== 'function'
    ) {
      throw new TypeError('Action refresh dependencies are required.');
    }
    const tabs = chromeApi.tabs || {};
    const windows = chromeApi.windows || {};
    let started = false;
    let activeTabId = null;
    let activeWindowId = null;
    let latestToken = null;
    let pendingParams = null;
    let scheduledRefresh = null;
    let presentationQueue = Promise.resolve();

    function requestRefresh(params = {}) {

      latestToken = {};
      pendingParams = mergeRefreshParams(pendingParams, params);
      if (!scheduledRefresh) {
        scheduledRefresh = Promise.resolve().then(() => {
          const nextParams = pendingParams;
          const token = latestToken;
          pendingParams = null;
          scheduledRefresh = null;
          return performRefresh(nextParams, token);
        });
      }
      return scheduledRefresh;

    }

    function mergeRefreshParams(previous, latest) {

      return Object.assign({}, latest, {
        forcePresentation: Boolean(
            previous && previous.forcePresentation ||
            latest && latest.forcePresentation,
        ),
        overrides: Object.assign({}, latest && latest.overrides),
      });

    }

    async function performRefresh(params, token) {

      const tab = await resolveTargetTab(params);
      if (token !== latestToken) {
        return {ok: false, status: 'stale'};
      }
      if (!tab || !Number.isInteger(tab.id) || tab.active === false) {
        return {ok: false, status: 'no-active-tab'};
      }
      if (
        Number.isInteger(activeWindowId) &&
        Number.isInteger(tab.windowId) &&
        tab.windowId !== activeWindowId
      ) {
        return {ok: false, status: 'background-window'};
      }
      activeTabId = tab.id;
      if (Number.isInteger(tab.windowId)) {
        activeWindowId = tab.windowId;
      }
      const state = Object.prototype.hasOwnProperty.call(params, 'state') ?
        params.state :
        await options.loadState();
      if (token !== latestToken) {
        return {ok: false, status: 'stale'};
      }
      const status = await options.createStatus(tab.url || '', state);
      if (token !== latestToken) {
        return {ok: false, status: 'stale'};
      }
      const update = presentationQueue.then(() => {
        if (token !== latestToken) {
          return {ok: false, status: 'stale'};
        }
        return updateStatus(
            Object.assign({}, status, params.overrides),
            {
              actionApi: chromeApi.action,
              runtimeApi: chromeApi.runtime,
              tabId: tab.id,
              forcePresentation: params.forcePresentation === true,
            },
        );
      });
      presentationQueue = update.catch(() => undefined);
      return update;

    }

    async function resolveTargetTab(params) {

      if (params.tab && Number.isInteger(params.tab.id)) {
        return params.tab;
      }
      if (Number.isInteger(params.tabId)) {
        return getTab(params.tabId);
      }
      if (Number.isInteger(activeTabId)) {
        const knownTab = await getTab(activeTabId);
        if (
          knownTab &&
          knownTab.active !== false &&
          (
            !Number.isInteger(activeWindowId) ||
            knownTab.windowId === activeWindowId
          )
        ) {
          return knownTab;
        }
      }
      return queryActiveTab(params.windowId);

    }

    function getTab(tabId) {

      return new Promise((resolve) => {
        if (typeof tabs.get !== 'function') {
          resolve(null);
          return;
        }
        try {
          tabs.get(tabId, (tab) => {
            resolve(getRuntimeError() ? null : tab || null);
          });
        } catch (err) {
          resolve(null);
        }
      });

    }

    function queryActiveTab(windowId) {

      return new Promise((resolve) => {
        if (typeof tabs.query !== 'function') {
          resolve(null);
          return;
        }
        const query = {active: true};
        if (Number.isInteger(windowId)) {
          query.windowId = windowId;
        } else {
          query.lastFocusedWindow = true;
        }
        try {
          tabs.query(query, (matches) => {
            resolve(getRuntimeError() ? null : matches && matches[0] || null);
          });
        } catch (err) {
          resolve(null);
        }
      });

    }

    function getRuntimeError() {

      return chromeApi.runtime && chromeApi.runtime.lastError || null;

    }

    function addListener(event, listener) {

      if (!event || typeof event.addListener !== 'function') {
        return;
      }
      event.addListener(listener);

    }

    function refreshFromEvent(params) {

      requestRefresh(params).catch(() => undefined);

    }

    function start() {

      if (started) {
        return;
      }
      started = true;
      addListener(tabs.onActivated, (activeInfo) => {
        if (!activeInfo || !Number.isInteger(activeInfo.tabId)) {
          return;
        }
        if (
          Number.isInteger(activeWindowId) &&
          Number.isInteger(activeInfo.windowId) &&
          activeInfo.windowId !== activeWindowId
        ) {
          return;
        }
        activeTabId = activeInfo.tabId;
        if (Number.isInteger(activeInfo.windowId)) {
          activeWindowId = activeInfo.windowId;
        }
        refreshFromEvent({tabId: activeInfo.tabId});
      });
      addListener(tabs.onUpdated, (tabId, changeInfo, tab) => {
        const ifRelevant = changeInfo && (
          Object.prototype.hasOwnProperty.call(changeInfo, 'url') ||
          changeInfo.status === 'complete'
        );
        if (!ifRelevant || tabId !== activeTabId) {
          return;
        }
        const nextTab = Object.assign({}, tab, {
          id: tabId,
          url: changeInfo.url || tab && tab.url || '',
        });
        refreshFromEvent({
          tab: nextTab,
          forcePresentation: true,
        });
      });
      addListener(tabs.onRemoved, (tabId, removeInfo) => {
        forgetStatus(tabId, {actionApi: chromeApi.action});
        if (tabId !== activeTabId) {
          return;
        }
        activeTabId = null;
        refreshFromEvent({windowId: removeInfo && removeInfo.windowId});
      });
      addListener(tabs.onReplaced, (addedTabId, removedTabId) => {
        forgetStatus(removedTabId, {actionApi: chromeApi.action});
        if (removedTabId !== activeTabId) {
          return;
        }
        activeTabId = addedTabId;
        refreshFromEvent({tabId: addedTabId});
      });
      addListener(windows.onFocusChanged, (windowId) => {
        const noWindow = Number.isInteger(chromeApi.windows.WINDOW_ID_NONE) ?
          chromeApi.windows.WINDOW_ID_NONE :
          -1;
        activeTabId = null;
        if (windowId === noWindow) {
          activeWindowId = null;
          latestToken = {};
          return;
        }
        activeWindowId = windowId;
        refreshFromEvent({windowId});
      });

    }

    return Object.freeze({
      requestRefresh,
      start,
    });

  }

  function notify(params = {}) {

    const prefs = params.prefs || {};
    const type = params.type || 'extError';
    if (prefs[type] === false || !canNotify()) {
      return Promise.resolve({ok: false, status: 'disabled'});
    }
    const title = sanitizeMessage(params.title || 'Runet Censorship Bypass');
    const message = sanitizeMessage(params.message || 'Operation failed.');
    const notificationId = `mv3-${type}-${Date.now()}`;
    return new Promise((resolve) => {
      chrome.notifications.create(notificationId, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON_PATH,
        title,
        message,
      }, (id) => {
        const error = chrome.runtime && chrome.runtime.lastError;
        resolve({
          ok: !error,
          status: error ? 'error' : 'created',
          id: id || notificationId,
          error: error && error.message || null,
        });
      });
    });

  }

  function canNotify() {

    return typeof chrome !== 'undefined' &&
      chrome.notifications &&
      typeof chrome.notifications.create === 'function';

  }

  function sanitizeMessage(message) {

    return String(message || '')
        .replace(/\s+/g, ' ')
        .replace(/(password|passwd|pwd|secret|token)=\S+/ig, '$1=***')
        .replace(/:\/\/([^:/\s]+):([^@\s]+)@/g, '://$1:***@')
        .slice(0, 220)
        .trim();

  }

  function selfTest() {

    const active = {
      controllable: true,
      proxyApplied: true,
      proxyControl: {
        controlsPac: true,
        controlledByThisExtension: true,
        levelOfControl: 'controlled_by_this_extension',
      },
    };
    const proxy = deriveActionViewModel(Object.assign({}, active, {
      mode: 'proxy',
    }));
    const direct = deriveActionViewModel(Object.assign({}, active, {
      mode: 'direct',
    }));
    const auto = deriveActionViewModel(Object.assign({}, active, {
      mode: 'auto',
    }));
    const external = deriveActionViewModel(Object.assign({}, active, {
      operation: 'apply',
      proxyControl: {
        controlsPac: false,
        controlledByThisExtension: false,
        canControl: false,
        levelOfControl: 'controlled_by_other_extensions',
      },
    }));
    const off = deriveActionViewModel({
      controllable: true,
      proxyApplied: false,
      proxyControl: {
        controlsPac: false,
        controlledByThisExtension: false,
        canControl: true,
        levelOfControl: 'controllable_by_this_extension',
      },
    });
    const secret = ['not', '-for-title'].join('');
    const safeTitle = formatTitle(Object.assign({}, active, {
      host: `host-${secret}.example`,
      selectedProviderLabel: `provider-${secret}`,
      error: `password=${secret}`,
    }));
    return {
      proxyBadgeMapsToP: proxy.badgeText === 'P',
      directBadgeMapsToD: direct.badgeText === 'D',
      autoBadgeMapsToA: auto.badgeText === 'A',
      offAndExternalAreDistinct:
        off.badgeText === 'OFF' && external.badgeText === 'EXT',
      externalOverridesBusy:
        external.kind === 'external' && external.transient === false,
      activeUsesPurposeBuiltIcon:
        proxy.iconPath[16] === 'icons/action-active-16.png',
      titleOmitsSensitiveInputs: !safeTitle.includes(secret),
      fingerprintIsStable:
        proxy.fingerprint === deriveActionViewModel(Object.assign({}, active, {
          mode: 'proxy',
        })).fingerprint,
    };

  }

  exports.mv3ActionStatus = Object.freeze({
    deriveActionViewModel,
    getBadgeStatus,
    getIconPath,
    getRuntimeIconPaths,
    formatTitle,
    sanitizeMessage,
    updateStatus,
    forgetStatus,
    createRefreshCoordinator,
    notify,
    selfTest,
  });

})(self);
