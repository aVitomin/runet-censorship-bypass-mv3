'use strict';

(function() {

  const MESSAGE_TYPE = 'mv3-legacy-local-storage-audit';
  const REDACTED_PASSWORD = '***';
  const MAX_VALUE_LENGTH = 500;

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function redactUsername(username) {

    const value = String(username || '');
    if (!value) {
      return '';
    }
    if (value.length <= 2) {
      return '*'.repeat(value.length);
    }
    return `${value[0]}***${value[value.length - 1]}`;

  }

  function parseProxyEntry(proxyAsStringRaw) {

    const proxyAsString = String(proxyAsStringRaw || '').trim();
    const match = proxyAsString.match(/^(\S+)\s+(.+)$/);
    if (!match) {
      return null;
    }
    const type = match[1].toUpperCase();
    const addressWithCredentials = match[2].trim();
    const atIndex = addressWithCredentials.lastIndexOf('@');
    if (atIndex === -1) {
      return null;
    }
    const credentials = addressWithCredentials.slice(0, atIndex);
    const address = addressWithCredentials.slice(atIndex + 1);
    const colonIndex = credentials.indexOf(':');
    const username = colonIndex === -1 ?
      credentials :
      credentials.slice(0, colonIndex);
    return `${type} ${redactUsername(username)}:${REDACTED_PASSWORD}@${address}`;

  }

  function trimValue(value) {

    const stringValue = String(value);
    if (stringValue.length <= MAX_VALUE_LENGTH) {
      return stringValue;
    }
    return `${stringValue.slice(0, MAX_VALUE_LENGTH)}...`;

  }

  function redactString(value) {

    const proxyEntry = parseProxyEntry(value);
    if (proxyEntry) {
      return proxyEntry;
    }
    return trimValue(String(value || '').replace(
        /([^\s:@;]+):([^\s@;]+)@/g,
        (match, username) => `${redactUsername(username)}:${REDACTED_PASSWORD}@`,
    ));

  }

  function sanitizeValue(value, key = '') {

    const loweredKey = String(key || '').toLowerCase();
    if (
      loweredKey.includes('password') ||
      loweredKey.includes('pac-data') ||
      loweredKey === 'rawpacdata' ||
      loweredKey === 'cookedpacdata'
    ) {
      return '[redacted]';
    }
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, key));
    }
    if (isObject(value)) {
      return Object.keys(value).sort().reduce((acc, childKey) => {
        acc[childKey] = sanitizeValue(value[childKey], childKey);
        return acc;
      }, {});
    }
    return value;

  }

  function parseStoredValue(value) {

    if (typeof value !== 'string') {
      return value;
    }
    try {
      return JSON.parse(value);
    } catch (err) {
      return value;
    }

  }

  function readLocalStorage(ifIncludeSensitiveValues) {

    const items = {};
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      const parsedValue = parseStoredValue(window.localStorage.getItem(key));
      items[key] = ifIncludeSensitiveValues ?
        parsedValue :
        sanitizeValue(parsedValue, key);
    }
    return items;

  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (!message || message.type !== MESSAGE_TYPE) {
      return false;
    }
    try {
      sendResponse({
        ok: true,
        items: readLocalStorage(message.includeSensitiveValues === true),
        warnings: [],
        sensitiveFieldsRedacted: message.includeSensitiveValues !== true,
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: {
          code: 'LOCAL_STORAGE_AUDIT_FAILED',
          message: err && err.message || 'Failed to inspect localStorage.',
        },
      });
    }
    return false;

  });

})();
