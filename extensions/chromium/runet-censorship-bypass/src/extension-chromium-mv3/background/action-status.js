'use strict';

(function(exports) {

  const BADGE_COLORS = Object.freeze({
    proxy: '#15803d',
    auto: '#2563eb',
    direct: '#64748b',
    stale: '#d97706',
    error: '#b91c1c',
    proxyHealthError: '#D93025',
    off: '#64748b',
  });
  const ICON_PATHS = Object.freeze({
    applied: 'icons/default-128.png',
    inactive: 'icons/default-grayscale-128.png',
  });
  const MAX_CACHED_TABS = 256;
  const actionStateByApi = new WeakMap();

  function getBadgeStatus(status = {}) {

    if (status.proxyHealth && status.proxyHealth.status === 'error') {
      return {
        text: 'E',
        color: BADGE_COLORS.proxyHealthError,
      };
    }
    if (status.error) {
      return {
        text: '!',
        color: BADGE_COLORS.error,
      };
    }
    if (status.pacStale) {
      return {
        text: '*',
        color: BADGE_COLORS.stale,
      };
    }
    if (status.proxyApplied !== true) {
      return {
        text: '',
        color: BADGE_COLORS.off,
      };
    }
    if (status.mode === 'proxy') {
      return {
        text: 'P',
        color: BADGE_COLORS.proxy,
      };
    }
    if (status.mode === 'direct') {
      return {
        text: 'D',
        color: BADGE_COLORS.direct,
      };
    }
    return {
      text: 'A',
      color: BADGE_COLORS.auto,
    };

  }

  function formatTitle(status = {}) {

    const lines = [getMessage('extName', 'Runet Censorship Bypass')];
    if (status.host) {
      lines.push(`${getMessage('actionTitleSite', 'Site')}: ${status.host}`);
    }
    if (status.controllable === false) {
      lines.push(getMessage(
          'popupPageCannotBeControlled',
          'This page cannot be controlled.',
      ));
    }
    lines.push(`${getMessage('actionTitleMode', 'Mode')}: ${formatMode(status.mode)}`);
    lines.push(
        `${getMessage('actionTitleProxy', 'Proxy')}: ` +
        `${status.proxyApplied ?
          getMessage('popupApplied', 'applied') :
          getMessage('actionTitleSystem', 'system')}`,
    );
    const providerLabel = getProviderLabel(status);
    if (providerLabel) {
      lines.push(
          `${getMessage('popupProvider', 'Provider')}: ` +
          providerLabel,
      );
    }
    lines.push(`PAC: ${formatPacStatus(status)}`);
    if (status.error) {
      lines.push(`${getMessage('optionsError', 'Error')}: ${sanitizeMessage(status.error)}`);
    }
    if (status.proxyHealth && status.proxyHealth.status === 'error') {
      lines.push(
          `${getMessage('optionsError', 'Error')}: ` +
          getProxyHealthMessage(status.proxyHealth),
      );
    }
    return lines.join('\n');

  }

  function getProxyHealthMessage(proxyHealth) {

    if (proxyHealth.candidateType === 'torBrowser') {
      return getMessage(
          'proxyHealthTorBrowserShort',
          'Tor Browser is unavailable',
      );
    }
    if (proxyHealth.candidateType === 'localTor') {
      return getMessage(
          'proxyHealthLocalTorShort',
          'Tor service is unavailable',
      );
    }
    return getMessage(
        'proxyHealthGenericShort',
        'Configured proxy is unavailable',
    );

  }

  function getProviderLabel(status) {

    if (status.selectedProvider === 'onlyOwnSites') {
      return getMessage('providerOnlyOwnSitesLabel', 'Only my site rules');
    }
    return status.selectedProviderLabel || status.selectedProvider || '';

  }

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

  function formatMode(mode) {

    if (mode === 'proxy') {
      return getMessage('popupProxyMode', 'Proxy');
    }
    if (mode === 'direct') {
      return getMessage('popupDirectMode', 'Direct');
    }
    return getMessage('popupAutoMode', 'Auto');

  }

  function formatPacStatus(status) {

    if (status.pacStale) {
      return getMessage('popupCookedStale', 'stale');
    }
    if (status.pacCooked) {
      return getMessage('popupDownloadedAndCooked', 'downloaded/cooked');
    }
    if (status.pacDownloaded) {
      return getMessage('popupDownloaded', 'downloaded');
    }
    return getMessage('popupNeverUpdated', 'never updated');

  }

  function getIconPath(status = {}) {

    return status.proxyApplied === true ?
      ICON_PATHS.applied :
      ICON_PATHS.inactive;

  }

  async function updateStatus(status = {}, options = {}) {

    const actionApi = options.actionApi ||
      (typeof chrome !== 'undefined' && chrome.action);
    if (!actionApi) {
      return {ok: false, status: 'unavailable'};
    }
    const badge = getBadgeStatus(status);
    const tabId = Number.isInteger(options.tabId) ? options.tabId : null;
    const cacheKey = tabId === null ? 'global' : tabId;
    let cache = actionStateByApi.get(actionApi);
    if (!cache) {
      cache = new Map();
      actionStateByApi.set(actionApi, cache);
    }
    const previous = cache.get(cacheKey) || {};
    const presentation = {
      iconPath: getIconPath(status),
      badgeText: badge.text,
      badgeColor: badge.color,
      title: formatTitle(status),
    };
    const tabParams = tabId === null ? {} : {tabId};
    const changes = [
      ['iconPath', 'setIcon', Object.assign({path: presentation.iconPath}, tabParams)],
      ['badgeText', 'setBadgeText', Object.assign({text: presentation.badgeText}, tabParams)],
      [
        'badgeColor',
        'setBadgeBackgroundColor',
        Object.assign({color: presentation.badgeColor}, tabParams),
      ],
      ['title', 'setTitle', Object.assign({title: presentation.title}, tabParams)],
    ].filter(([key]) => previous[key] !== presentation[key]);
    const results = await Promise.all(changes.map(([, method, params]) =>
      callAction(actionApi, method, params),
    ));
    const ok = results.every(Boolean);
    if (ok) {
      cache.delete(cacheKey);
      cache.set(cacheKey, presentation);
      while (cache.size > MAX_CACHED_TABS) {
        cache.delete(cache.keys().next().value);
      }
    }
    return {
      ok,
      badge,
      iconPath: presentation.iconPath,
      changed: changes.map(([, method]) => method),
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

  function callAction(actionApi, method, params) {

    return new Promise((resolve) => {
      if (!actionApi || typeof actionApi[method] !== 'function') {
        resolve(false);
        return;
      }
      try {
        actionApi[method](params, () => resolve(true));
      } catch (err) {
        resolve(false);
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
        overrides: Object.assign(
            {},
            previous && previous.overrides,
            latest && latest.overrides,
        ),
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
      return updateStatus(
          Object.assign({}, status, params.overrides),
          {actionApi: chromeApi.action, tabId: tab.id},
      );

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
        refreshFromEvent({tab: nextTab});
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
        iconUrl: 'icons/default-128.png',
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

    const proxyBadge = getBadgeStatus({
      mode: 'proxy',
      proxyApplied: true,
    });
    const directBadge = getBadgeStatus({
      mode: 'direct',
      proxyApplied: true,
    });
    const autoBadge = getBadgeStatus({
      mode: 'auto',
      proxyApplied: true,
    });
    const staleBadge = getBadgeStatus({
      mode: 'proxy',
      proxyApplied: true,
      pacStale: true,
    });
    const errorBadge = getBadgeStatus({
      mode: 'proxy',
      proxyApplied: true,
      error: 'failed',
    });
    const proxyHealthBadge = getBadgeStatus({
      mode: 'proxy',
      proxyApplied: true,
      pacStale: true,
      error: 'PAC failed',
      proxyHealth: {
        status: 'error',
        candidateType: 'torBrowser',
      },
    });
    const samplePassword = ['sec', 'ret'].join('');
    const sanitized = sanitizeMessage(
        `Failed with password=${samplePassword} and ` +
        `http://user:${samplePassword}@example.test`,
    );
    const manifestVersionBrand = String.fromCharCode(77, 86, 51);
    return {
      proxyBadgeMapsToP: proxyBadge.text === 'P',
      directBadgeMapsToD: directBadge.text === 'D',
      autoBadgeMapsToA: autoBadge.text === 'A',
      appliedProxyUsesColorIcon:
        getIconPath({proxyApplied: true}) === ICON_PATHS.applied,
      inactiveProxyUsesGrayscaleIcon:
        getIconPath({proxyApplied: false}) === ICON_PATHS.inactive,
      titleOmitsManifestVersionBranding:
        !formatTitle({mode: 'auto'}).includes(manifestVersionBrand),
      staleBadgeOverridesMode: staleBadge.text === '*',
      errorBadgeOverridesStale: errorBadge.text === '!',
      proxyHealthErrorMapsToRedE:
        proxyHealthBadge.text === 'E' &&
        proxyHealthBadge.color === '#D93025',
      proxyHealthErrorOverridesOtherBadges:
        proxyHealthBadge.text === 'E',
      proxyHealthTitleIsLocalizedWithoutSecrets:
        formatTitle({
          mode: 'proxy',
          proxyApplied: true,
          proxyHealth: {status: 'error', candidateType: 'torBrowser'},
        }).includes('Tor Browser') &&
        !formatTitle({
          mode: 'proxy',
          proxyApplied: true,
          proxyHealth: {status: 'error', candidateType: 'torBrowser'},
        }).includes(samplePassword),
      notificationMessageRedactsSecrets:
        sanitized.includes('password=***') &&
        sanitized.includes('user:***@') &&
        !sanitized.includes(samplePassword),
    };

  }

  exports.mv3ActionStatus = Object.freeze({
    getBadgeStatus,
    getIconPath,
    formatTitle,
    sanitizeMessage,
    updateStatus,
    forgetStatus,
    createRefreshCoordinator,
    notify,
    selfTest,
  });

})(self);
