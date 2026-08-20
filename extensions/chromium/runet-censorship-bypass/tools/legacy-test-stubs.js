'use strict';

function clone(value) {

  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));

}

function createMethod(implementation) {

  const initialImplementation = implementation;
  const calls = [];
  const method = function(...args) {

    calls.push(args);
    return implementation.apply(this, args);

  };
  Object.defineProperties(method, {
    calls: {get: () => calls},
    called: {get: () => calls.length > 0},
    callCount: {get: () => calls.length},
    notCalled: {get: () => calls.length === 0},
  });
  method.returns = function(value) {

    implementation = () => value;
    return method;

  };
  method.reset = function() {

    calls.length = 0;
    implementation = initialImplementation;

  };
  return method;

}

function createEvent() {

  const listeners = [];
  const addListener = createMethod((listener) => {

    if (!listeners.includes(listener)) {
      listeners.push(listener);
    }

  });
  const removeListener = createMethod((listener) => {

    const index = listeners.indexOf(listener);
    if (index >= 0) {
      listeners.splice(index, 1);
    }

  });
  const hasListener = createMethod((listener) => listeners.includes(listener));
  const trigger = createMethod((...args) =>
    listeners.slice().map((listener) => listener(...args))
  );
  return {
    addListener,
    removeListener,
    hasListener,
    trigger,
    get listenerCount() {

      return listeners.length;

    },
    reset() {

      listeners.length = 0;
      addListener.reset();
      removeListener.reset();
      hasListener.reset();
      trigger.reset();

    },
  };

}

function createChromeApiStub(options = {}) {

  const initialManifest = clone(options.manifest || {version: '0.0.0.0'});
  const initialProxySettings = clone(options.proxySettings || {
    levelOfControl: 'controllable_by_this_extension',
    value: {mode: 'direct'},
  });
  let proxySettings = clone(initialProxySettings);

  const getManifest = createMethod(() => clone(initialManifest));
  const getProxySettings = createMethod((details, callback) => {

    if (callback) {
      callback(clone(proxySettings));
    }

  });
  const setProxySettings = createMethod((details, callback) => {

    proxySettings = clone(details);
    if (callback) {
      callback();
    }

  });
  const clearProxySettings = createMethod((details, callback) => {

    proxySettings = undefined;
    if (callback) {
      callback();
    }

  });
  const webRequestEvents = {
    onAuthRequired: createEvent(),
    onCompleted: createEvent(),
    onErrorOccurred: createEvent(),
  };
  const proxySettingsApi = {
    get: getProxySettings,
    set: setProxySettings,
    clear: clearProxySettings,
  };
  const chrome = {
    extension: {lastError: null},
    proxy: {settings: proxySettingsApi},
    runtime: {
      getManifest,
      lastError: null,
    },
    webRequest: webRequestEvents,
  };

  return {
    chrome,
    reset() {

      proxySettings = clone(initialProxySettings);
      getManifest.reset();
      getProxySettings.reset();
      setProxySettings.reset();
      clearProxySettings.reset();
      proxySettingsApi.get = getProxySettings;
      proxySettingsApi.set = setProxySettings;
      proxySettingsApi.clear = clearProxySettings;
      chrome.runtime.lastError = null;
      chrome.extension.lastError = null;
      Object.values(webRequestEvents).forEach((event) => event.reset());

    },
  };

}

function createLocalStorageStub() {

  let storage = Object.create(null);
  const target = {
    setItem(key, value) {

      storage[key] = value || '';

    },
    getItem(key) {

      return key in storage ? storage[key] : null;

    },
    removeItem(key) {

      delete storage[key];

    },
    get length() {

      return Object.keys(storage).length;

    },
    key() {

      throw new Error('Not implemented!');

    },
    clear() {

      storage = Object.create(null);

    },
  };
  return new Proxy(target, {
    get(targetObject, name) {

      return name in targetObject ? targetObject[name] : targetObject.getItem(name);

    },
    set(targetObject, property, value) {

      if (property in targetObject) {
        targetObject[property] = value;
      } else {
        targetObject.setItem(property, value);
      }
      return true;

    },
  });

}

module.exports = {
  createChromeApiStub,
  createLocalStorageStub,
};
