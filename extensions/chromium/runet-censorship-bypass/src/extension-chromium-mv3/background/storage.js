'use strict';

(function(exports) {

  const storageArea = chrome.storage.local;

  function rejectIfLastError(reject) {

    const error = chrome.runtime.lastError;
    if (!error) {
      return false;
    }
    reject(new Error(error.message));
    return true;

  }

  function get(keysOrDefaults) {

    return new Promise((resolve, reject) => {
      storageArea.get(keysOrDefaults === undefined ? null : keysOrDefaults, (items) => {
        if (rejectIfLastError(reject)) {
          return;
        }
        resolve(items);
      });
    });

  }

  function set(values) {

    return new Promise((resolve, reject) => {
      storageArea.set(values, () => {
        if (rejectIfLastError(reject)) {
          return;
        }
        resolve();
      });
    });

  }

  function remove(keys) {

    return new Promise((resolve, reject) => {
      storageArea.remove(keys, () => {
        if (rejectIfLastError(reject)) {
          return;
        }
        resolve();
      });
    });

  }

  function clear() {

    return new Promise((resolve, reject) => {
      storageArea.clear(() => {
        if (rejectIfLastError(reject)) {
          return;
        }
        resolve();
      });
    });

  }

  exports.mv3Storage = Object.freeze({
    get,
    set,
    remove,
    clear,
  });

})(self);
