'use strict';

(function(exports) {

  async function callBackground(method, params = {}) {

    const response = await chrome.runtime.sendMessage({
      v: 1,
      method,
      params,
    });

    if (!response || response.ok !== true) {
      const error = response && response.error;
      const rpcError = new Error(
        error && error.message ? error.message : 'Background RPC failed',
      );
      rpcError.code = error && error.code || 'RPC_FAILED';
      rpcError.details = error && error.details || null;
      throw rpcError;
    }

    return response.result;

  }

  function formatPacSourceUrlForDiagnostics(value, providerKey) {

    if (!value) {
      return value;
    }
    if (String(providerKey || '').startsWith('custom:')) {
      return '[custom provider URL hidden]';
    }
    try {
      const parsed = new URL(String(value));
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return '[non-network PAC source]';
      }
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch (err) {
      return '[PAC source URL hidden]';
    }

  }

  exports.mv3Rpc = Object.freeze({
    callBackground,
    formatPacSourceUrlForDiagnostics,
  });

})(window);
