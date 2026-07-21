'use strict';

/* eslint-env node */

const Crypto = require('crypto');
const Fs = require('fs');
const Path = require('path');
const Vm = require('vm');

const BACKGROUND_DIRECTORY = Path.resolve(__dirname, '..', 'background');
const MODULE_FILES = Object.freeze([
  'storage.js',
  'pac-artifacts.js',
  'pac-mods.js',
  'site-scope.js',
  'proxy-health.js',
  'pac-providers.js',
  'state.js',
  'action-status.js',
  'legacy-migration-audit.js',
  'legacy-migration-apply.js',
  'periodic-update.js',
  'hash.js',
  'pac-download.js',
  'pac-cook.js',
  'proxy-auth.js',
  'proxy-settings.js',
]);

const RAW_PAC =
  'function FindProxyForURL(url, host) { return "DIRECT"; }';
const CHANGED_RAW_PAC =
  'function FindProxyForURL(url, host) { return host ? "DIRECT" : "DIRECT"; }';

function clone(value) {

  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));

}

function sha256(text) {

  return Crypto.createHash('sha256').update(text).digest('hex');

}

function createEvent() {

  const listeners = [];
  return {
    addListener(listener) {

      listeners.push(listener);

    },
    dispatch(...args) {

      listeners.slice().forEach((listener) => listener(...args));

    },
    get listenerCount() {

      return listeners.length;

    },
  };

}

function createCounts() {

  return {
    storageGets: 0,
    storageSets: 0,
    storageRemoves: 0,
    indexedDbOpens: 0,
    indexedDbReads: 0,
    indexedDbWrites: 0,
    indexedDbTransactions: 0,
    runtimeRpcs: 0,
    tabQueries: 0,
    tabGets: 0,
    actionCalls: 0,
    pacDownloads: 0,
    pacCooks: 0,
    hashOperations: 0,
    proxySettingsReads: 0,
    proxySettingsWrites: 0,
    proxySettingsClears: 0,
    alarmGets: 0,
    alarmCreates: 0,
    alarmClears: 0,
  };

}

function resetObject(target, source) {

  Object.keys(target).forEach((key) => delete target[key]);
  Object.assign(target, source);

}

function waitForAsyncWork() {

  return new Promise((resolve) => {
    setImmediate(() => setImmediate(() => setImmediate(resolve)));
  });

}

async function createRuntimeHarness(options = {}) {

  const counts = createCounts();
  const actionState = {};
  const asyncCounterWaiters = [];
  let completedHashOperations = 0;
  const storageData = {};
  const alarms = new Map();
  const rawArtifacts = new Map();
  const cookedArtifacts = new Map();
  const tabs = new Map([
    [1, {
      id: 1,
      windowId: 10,
      active: true,
      url: 'https://audit.example/',
    }],
    [2, {
      id: 2,
      windowId: 10,
      active: false,
      url: 'https://background.example/',
    }],
  ]);
  const events = {
    actionClicked: createEvent(),
    alarm: createEvent(),
    installed: createEvent(),
    message: createEvent(),
    notificationClicked: createEvent(),
    proxyChanged: createEvent(),
    startup: createEvent(),
    tabActivated: createEvent(),
    tabRemoved: createEvent(),
    tabReplaced: createEvent(),
    tabUpdated: createEvent(),
    webAuth: createEvent(),
    webCompleted: createEvent(),
    webError: createEvent(),
    windowFocus: createEvent(),
  };
  let databaseOpened = false;
  let downloadResult = null;
  let pacDownloadGate = null;
  let markPacDownloadStarted = null;
  let pacCookGate = null;
  let markPacCookStarted = null;
  let cookedArtifactReads = 0;
  let cookedArtifactReadGate = null;
  let proxySettingsReadGate = null;
  let proxySettingsSetGate = null;
  let nextProxySettingsSetError = null;
  const proxySettingsSetValues = [];
  let proxyDetails = {
    levelOfControl: 'controlled_by_this_extension',
    value: {
      mode: 'pac_script',
      pacScript: {data: 'installed PAC', mandatory: false},
    },
  };

  function notifyAsyncCounterWaiters() {

    asyncCounterWaiters.slice().forEach((waiter) => {
      if (waiter.read() < waiter.target) {
        return;
      }
      asyncCounterWaiters.splice(asyncCounterWaiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    });

  }

  function waitForAsyncCounter(read, target, label) {

    if (read() >= target) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = {read, target, resolve, timer: null};
      waiter.timer = setTimeout(() => {
        const index = asyncCounterWaiters.indexOf(waiter);
        if (index !== -1) {
          asyncCounterWaiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for ${label}.`));
      }, 2000);
      asyncCounterWaiters.push(waiter);
    });

  }

  const chromeApi = {
    action: {
      onClicked: events.actionClicked,
    },
    alarms: {
      onAlarm: events.alarm,
      create(name, details) {

        ++counts.alarmCreates;
        alarms.set(name, Object.assign({name}, details));

      },
      get(name, callback) {

        ++counts.alarmGets;
        callback(clone(alarms.get(name)) || null);

      },
      clear(name, callback) {

        ++counts.alarmClears;
        callback(alarms.delete(name));

      },
    },
    i18n: {
      getMessage() {

        return '';

      },
    },
    notifications: {
      onClicked: events.notificationClicked,
      clear(id, callback) {

        if (callback) {
          callback(true);
        }

      },
      create(id, details, callback) {

        if (callback) {
          callback(id);
        }

      },
    },
    proxy: {
      settings: {
        onChange: events.proxyChanged,
        get(details, callback) {

          ++counts.proxySettingsReads;
          if (
            proxySettingsReadGate &&
            counts.proxySettingsReads === proxySettingsReadGate.target
          ) {
            proxySettingsReadGate.markStarted();
            proxySettingsReadGate.promise.then(() => {
              callback(clone(proxyDetails));
            });
            return;
          }
          callback(clone(proxyDetails));

        },
        set(details, callback) {

          ++counts.proxySettingsWrites;
          proxySettingsSetValues.push(clone(details.value));
          const gated = proxySettingsSetGate &&
            counts.proxySettingsWrites === proxySettingsSetGate.target ?
            proxySettingsSetGate :
            null;
          const errorMessage = gated ?
            gated.errorMessage :
            nextProxySettingsSetError;
          nextProxySettingsSetError = null;
          if (!errorMessage) {
            proxyDetails = {
              levelOfControl: 'controlled_by_this_extension',
              value: clone(details.value),
            };
          }
          const finish = () => {
            chromeApi.runtime.lastError = errorMessage ?
              {message: errorMessage} :
              null;
            callback();
            chromeApi.runtime.lastError = null;
          };
          if (gated) {
            gated.markStarted();
            gated.promise.then(finish);
            return;
          }
          finish();

        },
        clear(details, callback) {

          ++counts.proxySettingsClears;
          proxyDetails = {
            levelOfControl: 'controllable_by_this_extension',
            value: {mode: 'direct'},
          };
          callback();

        },
      },
    },
    runtime: {
      id: 'runtime-audit-extension',
      lastError: null,
      onInstalled: events.installed,
      onMessage: events.message,
      onStartup: events.startup,
      getURL(pathname) {

        return `chrome-extension://runtime-audit-extension/${pathname}`;

      },
      openOptionsPage() {},
    },
    storage: {
      local: {
        get(keysOrDefaults, callback) {

          ++counts.storageGets;
          if (
            keysOrDefaults &&
            typeof keysOrDefaults === 'object' &&
            !Array.isArray(keysOrDefaults)
          ) {
            const result = {};
            Object.keys(keysOrDefaults).forEach((key) => {
              result[key] = Object.prototype.hasOwnProperty.call(storageData, key) ?
                clone(storageData[key]) :
                clone(keysOrDefaults[key]);
            });
            callback(result);
            return;
          }
          callback(clone(storageData));

        },
        set(values, callback) {

          ++counts.storageSets;
          Object.assign(storageData, clone(values));
          callback();

        },
        remove(keys, callback) {

          ++counts.storageRemoves;
          (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
            delete storageData[key];
          });
          callback();

        },
        clear(callback) {

          resetObject(storageData, {});
          callback();

        },
      },
    },
    tabs: {
      onActivated: events.tabActivated,
      onRemoved: events.tabRemoved,
      onReplaced: events.tabReplaced,
      onUpdated: events.tabUpdated,
      create() {},
      get(tabId, callback) {

        ++counts.tabGets;
        callback(clone(tabs.get(tabId)) || null);

      },
      query(query, callback) {

        ++counts.tabQueries;
        callback(Array.from(tabs.values()).filter((tab) => {
          if (!tab.active) {
            return false;
          }
          return !Number.isInteger(query.windowId) ||
            tab.windowId === query.windowId;
        }).map(clone));

      },
    },
    webRequest: {
      onAuthRequired: events.webAuth,
      onCompleted: events.webCompleted,
      onErrorOccurred: events.webError,
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.windowFocus,
    },
  };
  [
    'setIcon',
    'setBadgeText',
    'setBadgeBackgroundColor',
    'setTitle',
  ].forEach((method) => {
    chromeApi.action[method] = (params, callback) => {
      ++counts.actionCalls;
      actionState[method] = clone(params);
      notifyAsyncCounterWaiters();
      callback();
    };
  });

  const context = Vm.createContext({
    AbortController,
    Array,
    Boolean,
    console: options.console || {info() {}, warn() {}, error() {}},
    crypto: Crypto.webcrypto,
    Date,
    Error,
    fetch: options.fetch || (async () => {
      throw new Error('Unexpected network request in runtime audit harness.');
    }),
    importScripts() {},
    Map,
    Math,
    Object,
    Promise,
    Set,
    String,
    TextEncoder,
    TypeError,
    URL,
    chrome: chromeApi,
    clearTimeout,
    setTimeout,
    structuredClone: global.structuredClone,
    tldts: require('tldts'),
  });
  context.self = context;
  context.globalThis = context;

  MODULE_FILES.forEach((file) => {
    const source = Fs.readFileSync(Path.join(BACKGROUND_DIRECTORY, file), 'utf8');
    Vm.runInContext(source, context, {filename: file});
  });

  const realHash = context.mv3Hash;
  context.mv3Hash = Object.freeze(Object.assign({}, realHash, {
    async sha256Hex(text) {

      ++counts.hashOperations;
      const result = await realHash.sha256Hex(text);
      ++completedHashOperations;
      notifyAsyncCounterWaiters();
      return result;

    },
  }));
  const realPacCook = context.mv3PacCook;
  context.mv3PacCook = Object.freeze(Object.assign({}, realPacCook, {
    async cookPac(params) {

      ++counts.pacCooks;
      if (pacCookGate) {
        markPacCookStarted();
        await pacCookGate;
      }
      return realPacCook.cookPac(params);

    },
  }));

  const pacMods = context.mv3PacMods.normalizePacMods(
      Object.prototype.hasOwnProperty.call(options, 'pacMods') ?
        options.pacMods :
        {torBrowser: {enabled: true}},
  );
  const seedAt = Date.now() - 5 * 60 * 1000;
  const rawPacSha256 = sha256(RAW_PAC);
  const seededCook = await context.mv3PacCook.cookPac({
    rawPacData: RAW_PAC,
    pacMods,
    provider: context.mv3Providers.getProviderByKey('Антизапрет', []),
    sourceRawPacSha256: rawPacSha256,
  });
  const rawArtifactRef = `raw:${encodeURIComponent('Антизапрет')}:${rawPacSha256}`;
  const cookedArtifactRef =
    `cooked:${encodeURIComponent('Антизапрет')}:${seededCook.cookedPacSha256}`;
  rawArtifacts.set(rawArtifactRef, {
    artifactRef: rawArtifactRef,
    providerKey: 'Антизапрет',
    url: 'https://example.invalid/provider.pac',
    rawPacData: RAW_PAC,
    rawPacSha256,
    rawPacSize: RAW_PAC.length,
    fetchedAt: seedAt,
    lastModified: 'seed',
    etag: 'seed',
  });
  cookedArtifacts.set(cookedArtifactRef, {
    artifactRef: cookedArtifactRef,
    providerKey: 'Антизапрет',
    cookedPacData: seededCook.cookedPacData,
    cookedPacSha256: seededCook.cookedPacSha256,
    cookedPacSize: seededCook.cookedContentLength,
    sourceRawPacSha256: rawPacSha256,
    pacModsSha256: seededCook.pacModsSha256,
    cookedAt: seedAt,
    warnings: seededCook.warnings,
  });
  storageData.mv3State = {
    schemaVersion: 13,
    currentPacProviderKey: 'Антизапрет',
    pacWorkflowGeneration: 0,
    pacModsRevision:
      Number.isSafeInteger(options.pacModsRevision) ?
        options.pacModsRevision :
        0,
    pacMods,
    lastPacUpdateStamp: seedAt,
    pacCook: {
      status: 'success',
      providerKey: 'Антизапрет',
      sourceRawPacSha256: rawPacSha256,
      pacModsSha256: seededCook.pacModsSha256,
      startedAt: seedAt,
      finishedAt: seedAt,
      cookedPacSha256: seededCook.cookedPacSha256,
      cookedContentLength: seededCook.cookedContentLength,
      warnings: seededCook.warnings,
      error: null,
    },
    pacCache: {
      providerKey: 'Антизапрет',
      url: 'https://example.invalid/provider.pac',
      fetchedAt: seedAt,
      rawPacSha256,
      rawPacSize: RAW_PAC.length,
      lastModified: 'seed',
      etag: 'seed',
      artifactRef: rawArtifactRef,
    },
    cookedPacCache: {
      providerKey: 'Антизапрет',
      cookedAt: seedAt,
      sourceRawPacSha256: rawPacSha256,
      pacModsSha256: seededCook.pacModsSha256,
      cookedPacSha256: seededCook.cookedPacSha256,
      cookedPacSize: seededCook.cookedContentLength,
      warnings: seededCook.warnings,
      artifactRef: cookedArtifactRef,
    },
    proxyApply: {
      status: 'applied',
      providerKey: 'Антизапрет',
      cookedPacSha256: seededCook.cookedPacSha256,
      appliedAt: seedAt,
      levelOfControl: 'controlled_by_this_extension',
    },
    proxyControl: {
      checkedAt: seedAt,
      levelOfControl: 'controlled_by_this_extension',
      controlledByThisExtension: true,
      canControl: true,
      rawValue: {
        mode: 'pac_script',
        pacScript: {hasData: true, hasUrl: false, mandatory: false},
      },
    },
    periodicUpdate: {
      enabled: true,
      intervalMinutes: 12 * 60,
      status: 'scheduled',
      lastSuccessfulUpdateAt: seedAt,
      lastSuccessfulProviderKey: 'Антизапрет',
      nextRunAt: seedAt + 12 * 60 * 60 * 1000,
    },
  };
  if (options.initialState) {
    storageData.mv3State = clone(options.initialState);
  }

  function countIndexedDb(type) {

    if (!databaseOpened) {
      databaseOpened = true;
      ++counts.indexedDbOpens;
    }
    ++counts.indexedDbTransactions;
    ++counts[type === 'read' ? 'indexedDbReads' : 'indexedDbWrites'];

  }

  function rawKey(input) {

    return `raw:${encodeURIComponent(input.providerKey)}:${input.sha256}`;

  }

  function cookedKey(input) {

    return `cooked:${encodeURIComponent(input.providerKey)}:${input.sha256}`;

  }

  context.mv3PacArtifacts = Object.freeze({
    getStatus() {

      return {backend: 'indexeddb', dbName: 'mv3PacArtifacts', schemaVersion: 1};

    },
    async getRawPacArtifact(input) {

      countIndexedDb('read');
      return clone(rawArtifacts.get(rawKey(input))) || null;

    },
    async putRawPacArtifact(input) {

      countIndexedDb('write');
      const artifactRef =
        `raw:${encodeURIComponent(input.providerKey)}:${input.rawPacSha256}`;
      const artifact = Object.assign({}, input, {
        artifactRef,
        rawPacSize: input.contentLength || input.rawPacData.length,
      });
      rawArtifacts.set(artifactRef, artifact);
      return clone(artifact);

    },
    async deleteRawPacArtifact(input) {

      countIndexedDb('write');
      rawArtifacts.delete(rawKey(input));

    },
    async getCookedPacArtifact(input) {

      countIndexedDb('read');
      ++cookedArtifactReads;
      if (
        cookedArtifactReadGate &&
        cookedArtifactReads >= cookedArtifactReadGate.target
      ) {
        cookedArtifactReadGate.markStarted();
        await cookedArtifactReadGate.promise;
      }
      return clone(cookedArtifacts.get(cookedKey(input))) || null;

    },
    async putCookedPacArtifact(input) {

      countIndexedDb('write');
      const artifactRef =
        `cooked:${encodeURIComponent(input.providerKey)}:${input.cookedPacSha256}`;
      const artifact = Object.assign({}, input, {artifactRef});
      cookedArtifacts.set(artifactRef, artifact);
      return clone(artifact);

    },
    async deleteCookedPacArtifact(input) {

      countIndexedDb('write');
      cookedArtifacts.delete(cookedKey(input));

    },
  });
  context.mv3PacDownload = Object.freeze(Object.assign({}, context.mv3PacDownload, {
    async downloadPac() {

      ++counts.pacDownloads;
      if (pacDownloadGate) {
        markPacDownloadStarted();
        await pacDownloadGate;
      }
      const result = downloadResult || createDownloadResult(RAW_PAC);
      if (result.ok && result.status === 'success') {
        ++counts.hashOperations;
      }
      return clone(result);

    },
  }));

  resetObject(counts, createCounts());
  const serviceWorkerSource = Fs.readFileSync(
      Path.join(BACKGROUND_DIRECTORY, 'service-worker.js'),
      'utf8',
  );
  Vm.runInContext(`${serviceWorkerSource}\nself.__runtimeAudit = {\n` +
    '  RPC_METHODS,\n' +
    '  actionStatusRecoveryPromise,\n' +
    '  applyCookedPacAndPersist,\n' +
    '  applyPeriodicUpdateIfStillSafe,\n' +
    '  beginPacWorkflow,\n' +
    '  clearCookedPacCacheAndArtifacts,\n' +
    '  clearPacCacheAndArtifacts,\n' +
    '  clearProxyAndPersist,\n' +
    '  cookPacAndPersist,\n' +
    '  createPacApplyFingerprint,\n' +
    '  createErrorResponse,\n' +
    '  downloadPacAndPersist,\n' +
    '  executePeriodicUpdatePipeline,\n' +
    '  handleProxySettingsChanged,\n' +
    '};', context, {filename: 'service-worker.js'});
  await context.__runtimeAudit.actionStatusRecoveryPromise;
  await waitForAsyncWork();

  function createDownloadResult(rawPacData) {

    return {
      ok: true,
      status: 'success',
      providerKey: 'Антизапрет',
      url: 'https://example.invalid/provider.pac',
      rawPacData,
      sha256: sha256(rawPacData),
      contentLength: rawPacData.length,
      lastModified: 'updated',
      etag: 'updated',
      httpStatus: 200,
      warnings: [],
    };

  }

  async function callRpcRaw(method, params = {}) {

    ++counts.runtimeRpcs;
    const listeners = events.message;
    return new Promise((resolve) => {
      const sender = {id: chromeApi.runtime.id};
      const callback = (response) => resolve(response);
      listeners.dispatch({v: 1, method, params}, sender, callback);
    });

  }

  async function callRpc(method, params = {}) {

    const response = await callRpcRaw(method, params);
    if (!response || response.ok !== true) {
      throw response && response.error || new Error('RPC failed.');
    }
    return response.result;

  }

  return {
    audit: context.__runtimeAudit,
    chromeApi,
    context,
    counts,
    events,
    tabs,
    callRpc,
    callRpcRaw,
    activateTab(tabId) {

      const target = tabs.get(tabId);
      const actionCompletion = waitForAsyncCounter(
          () => counts.actionCalls,
          counts.actionCalls + 4,
          'active-tab action refresh',
      );
      Array.from(tabs.values()).forEach((tab) => {
        if (tab.windowId === target.windowId) {
          tab.active = false;
        }
      });
      target.active = true;
      events.tabActivated.dispatch({tabId, windowId: target.windowId});
      return actionCompletion.then(waitForAsyncWork);

    },
    blockCookedArtifactRead(offset = 1) {

      let release;
      let markStarted;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const promise = new Promise((resolve) => {
        release = () => {
          cookedArtifactReadGate = null;
          resolve();
        };
      });
      cookedArtifactReadGate = {
        markStarted,
        promise,
        target: cookedArtifactReads + offset,
      };
      return {release, started};

    },
    blockPacCook() {

      let release;
      const started = new Promise((resolve) => {
        markPacCookStarted = resolve;
      });
      pacCookGate = new Promise((resolve) => {
        release = () => {
          pacCookGate = null;
          markPacCookStarted = null;
          resolve();
        };
      });
      return {release, started};

    },
    blockPacDownload() {

      let release;
      const started = new Promise((resolve) => {
        markPacDownloadStarted = resolve;
      });
      pacDownloadGate = new Promise((resolve) => {
        release = () => {
          pacDownloadGate = null;
          markPacDownloadStarted = null;
          resolve();
        };
      });
      return {release, started};

    },
    blockProxySettingsRead(offset = 1) {

      let release;
      let markStarted;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const promise = new Promise((resolve) => {
        release = () => {
          proxySettingsReadGate = null;
          resolve();
        };
      });
      proxySettingsReadGate = {
        markStarted,
        promise,
        target: counts.proxySettingsReads + offset,
      };
      return {release, started};

    },
    blockProxySettingsSetCallback(options = {}) {

      let release;
      let markStarted;
      const started = new Promise((resolve) => {
        markStarted = resolve;
      });
      const promise = new Promise((resolve) => {
        release = () => {
          proxySettingsSetGate = null;
          resolve();
        };
      });
      proxySettingsSetGate = {
        errorMessage: options.errorMessage || null,
        markStarted,
        promise,
        target: counts.proxySettingsWrites + (options.offset || 1),
      };
      return {release, started};

    },
    createDownloadResult,
    getState() {

      return clone(storageData.mv3State);

    },
    getActionState() {

      return clone(actionState);

    },
    getProxyDetails() {

      return clone(proxyDetails);

    },
    getProxySettingsSetValues() {

      return clone(proxySettingsSetValues);

    },
    failNextProxySettingsSet(message) {

      nextProxySettingsSetError = message;

    },
    async installPacVersion(options = {}) {

      const providerKey = options.providerKey || 'Антизапрет';
      const rawPacData = options.rawPacData || RAW_PAC;
      const nextPacMods = context.mv3PacMods.normalizePacMods(
          options.pacMods || storageData.mv3State.pacMods,
      );
      const nextRawPacSha256 = sha256(rawPacData);
      const provider = context.mv3Providers.getProviderByKey(
          providerKey,
          storageData.mv3State.customPacProviders || [],
      );
      const cooked = await realPacCook.cookPac({
        rawPacData,
        pacMods: nextPacMods,
        provider,
        sourceRawPacSha256: nextRawPacSha256,
      });
      const installedAt = Date.now();
      const nextRawArtifactRef =
        `raw:${encodeURIComponent(providerKey)}:${nextRawPacSha256}`;
      const nextCookedArtifactRef =
        `cooked:${encodeURIComponent(providerKey)}:${cooked.cookedPacSha256}`;
      rawArtifacts.set(nextRawArtifactRef, {
        artifactRef: nextRawArtifactRef,
        providerKey,
        url: 'https://example.invalid/provider.pac',
        rawPacData,
        rawPacSha256: nextRawPacSha256,
        rawPacSize: rawPacData.length,
        fetchedAt: installedAt,
      });
      cookedArtifacts.set(nextCookedArtifactRef, {
        artifactRef: nextCookedArtifactRef,
        providerKey,
        cookedPacData: cooked.cookedPacData,
        cookedPacSha256: cooked.cookedPacSha256,
        cookedPacSize: cooked.cookedContentLength,
        sourceRawPacSha256: nextRawPacSha256,
        pacModsSha256: cooked.pacModsSha256,
        cookedAt: installedAt,
        warnings: cooked.warnings,
      });
      await context.mv3State.saveStatePatch({
        currentPacProviderKey: providerKey,
        pacMods: nextPacMods,
        pacCache: {
          providerKey,
          url: 'https://example.invalid/provider.pac',
          fetchedAt: installedAt,
          rawPacSha256: nextRawPacSha256,
          rawPacSize: rawPacData.length,
          artifactRef: nextRawArtifactRef,
        },
        cookedPacCache: {
          providerKey,
          cookedAt: installedAt,
          sourceRawPacSha256: nextRawPacSha256,
          pacModsSha256: cooked.pacModsSha256,
          cookedPacSha256: cooked.cookedPacSha256,
          cookedPacSize: cooked.cookedContentLength,
          warnings: cooked.warnings,
          artifactRef: nextCookedArtifactRef,
        },
      });
      return clone(cooked);

    },
    dropCookedArtifact() {

      cookedArtifacts.clear();

    },
    resetCounts() {

      resetObject(counts, createCounts());
      databaseOpened = false;

    },
    setDownloadResult(result) {

      downloadResult = clone(result);

    },
    changeProxyDetails(details) {

      const actionCompletion = waitForAsyncCounter(
          () => counts.actionCalls,
          counts.actionCalls + 4,
          'proxy-change action refresh',
      );
      proxyDetails = clone(details);
      events.proxyChanged.dispatch({});
      return actionCompletion.then(waitForAsyncWork);

    },
    setProxyDetails(details) {

      proxyDetails = clone(details);

    },
    updateTab(tabId, changeInfo) {

      const tab = tabs.get(tabId);
      const hashCompletion = waitForAsyncCounter(
          () => completedHashOperations,
          completedHashOperations + 1,
          'updated-tab status hash',
      );
      Object.assign(tab, changeInfo);
      events.tabUpdated.dispatch(tabId, clone(changeInfo), clone(tab));
      return hashCompletion.then(waitForAsyncWork);

    },
    waitForAsyncWork,
  };

}

module.exports = {
  CHANGED_RAW_PAC,
  RAW_PAC,
  createRuntimeHarness,
};
