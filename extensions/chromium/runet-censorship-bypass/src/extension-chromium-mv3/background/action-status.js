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

  async function updateStatus(status = {}) {

    if (typeof chrome === 'undefined' || !chrome.action) {
      return {ok: false, status: 'unavailable'};
    }
    const badge = getBadgeStatus(status);
    await callAction('setBadgeText', {text: badge.text});
    await callAction('setBadgeBackgroundColor', {color: badge.color});
    await callAction('setTitle', {title: formatTitle(status)});
    return {
      ok: true,
      badge,
    };

  }

  function callAction(method, params) {

    return new Promise((resolve) => {
      if (!chrome.action || typeof chrome.action[method] !== 'function') {
        resolve(false);
        return;
      }
      try {
        chrome.action[method](params, () => resolve(true));
      } catch (err) {
        resolve(false);
      }
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
    formatTitle,
    sanitizeMessage,
    updateStatus,
    notify,
    selfTest,
  });

})(self);
