'use strict';

/* eslint-env node, mocha */

const {expect} = require('chai');
const Fs = require('fs');
const Path = require('path');
const Vm = require('vm');
const {createRuntimeHarness} = require('./runtime-performance-harness');

const MV3_DIRECTORY = Path.resolve(__dirname, '..');
const POPUP_SOURCE = Fs.readFileSync(
    Path.join(MV3_DIRECTORY, 'pages', 'popup', 'index.js'),
    'utf8',
);
const CATALOGS = Object.fromEntries(['en', 'ru'].map((language) => [
  language,
  JSON.parse(Fs.readFileSync(
      Path.join(MV3_DIRECTORY, '_locales', language, 'messages.json'),
      'utf8',
  )),
]));

class FakeClassList {

  constructor(node) {

    this.node = node;

  }

  add(...values) {

    const classes = new Set(this.node.className.split(/\s+/g).filter(Boolean));
    values.forEach((value) => classes.add(value));
    this.node.className = Array.from(classes).join(' ');

  }

  contains(value) {

    return this.node.className.split(/\s+/g).includes(value);

  }

}

class FakeNode {

  constructor(tagName, ownerDocument, textValue = null) {

    this.tagName = String(tagName || '').toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this._textValue = textValue;
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this.value = '';
    this.type = '';
    this.name = '';
    this.title = '';
    this.id = '';
    this.onclick = null;
    this.onchange = null;
    this.ontoggle = null;

  }

  get children() {

    return this.childNodes.filter((node) => node.tagName !== '#TEXT');

  }

  get firstChild() {

    return this.childNodes[0] || null;

  }

  get textContent() {

    if (this.tagName === '#TEXT') {
      return this._textValue || '';
    }
    return (this._textValue || '') +
      this.childNodes.map((node) => node.textContent).join('');

  }

  set textContent(value) {

    this._textValue = value === null || value === undefined ?
      '' :
      String(value);
    this.childNodes = [];

  }

  appendChild(node) {

    node.parentNode = this;
    this.childNodes.push(node);
    return node;

  }

  removeChild(node) {

    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
      node.parentNode = null;
    }
    return node;

  }

  replaceChildren(...nodes) {

    this.childNodes.forEach((node) => {
      node.parentNode = null;
    });
    this.childNodes = [];
    nodes.forEach((node) => this.appendChild(node));

  }

  remove() {

    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }

  }

  setAttribute(name, value) {

    this.attributes[name] = String(value);
    if (name === 'id') {
      this.id = String(value);
    }

  }

  getAttribute(name) {

    return Object.prototype.hasOwnProperty.call(this.attributes, name) ?
      this.attributes[name] :
      null;

  }

  focus() {

    this.ownerDocument.activeElement = this;

  }

}

function createDocument() {

  const listeners = {};
  const document = {
    activeElement: null,
    title: '',
    addEventListener(type, listener) {

      listeners[type] = listeners[type] || [];
      listeners[type].push(listener);

    },
    createElement(tagName) {

      return new FakeNode(tagName, document);

    },
    createElementNS(namespace, tagName) {

      return new FakeNode(tagName, document);

    },
    createTextNode(value) {

      return new FakeNode('#text', document, String(value));

    },
    getElementById(id) {

      return id === 'popup-root' ? document.root : null;

    },
    dispatch(type) {

      return (listeners[type] || []).map((listener) => listener());

    },
    listenerCount(type) {

      return (listeners[type] || []).length;

    },
  };
  document.root = new FakeNode('main', document);
  document.root.id = 'popup-root';
  return document;

}

function translate(catalog, key, substitutions) {

  const entry = catalog[key];
  if (!entry || typeof entry.message !== 'string') {
    return key;
  }
  const values = Array.isArray(substitutions) ?
    substitutions.map(String) :
    substitutions === undefined ? [] : [String(substitutions)];
  let message = entry.message;
  Object.entries(entry.placeholders || {}).forEach(([name, placeholder]) => {
    const match = String(placeholder.content || '').match(/^\$(\d+)$/);
    const value = match ? values[Number(match[1]) - 1] || '' : '';
    message = message.replace(new RegExp(`\\$${name}\\$`, 'gi'), value);
  });
  values.forEach((value, index) => {
    message = message.replace(new RegExp(`\\$${index + 1}`, 'g'), value);
  });
  return message;

}

function createPopupState(patch = {}) {

  const now = Date.now();
  const base = {
    uiLanguage: 'en',
    host: 'audit.example',
    controllable: true,
    reason: '',
    mode: 'auto',
    siteRule: {
      scope: 'domain',
      pattern: '*.audit.example',
    },
    sitePatterns: {
      exactPattern: 'audit.example',
      wildcardPattern: '*.audit.example',
      wildcardAvailable: true,
      registrableDomain: 'audit.example',
      domainResolution: 'public-suffix-list',
    },
    providers: [{
      key: 'Антизапрет',
      label: 'Antizapret',
      description: '',
      type: 'builtIn',
      readOnly: true,
    }],
    selectedProvider: 'Антизапрет',
    selectedProviderLabel: 'Antizapret',
    pacDownloaded: true,
    pacCooked: true,
    pacStale: false,
    pacStaleReasons: [],
    pacUpdatedAt: now - 60 * 60 * 1000,
    pacCookedAt: now - 60 * 60 * 1000,
    pacDownloadStatus: 'success',
    pacCookStatus: 'success',
    proxyApplied: true,
    proxyApplyStatus: 'applied',
    proxyControl: {
      levelOfControl: 'controlled_by_this_extension',
      canControl: true,
      controlledByThisExtension: true,
      controlsPac: true,
      checkedAt: now,
    },
    proxyHealth: {
      status: 'ok',
      lastCheckedAt: now - 5 * 60 * 1000,
      candidateType: 'localTor',
    },
    autoUpdate: {
      enabled: true,
      intervalHours: 12,
      lastSuccessfulUpdateAt: now - 60 * 60 * 1000,
      error: null,
    },
    proxyCandidates: {
      available: true,
      labels: ['Local Tor'],
    },
    quickProxies: {
      usePacScriptProxies: true,
      ownProxiesOnlyForOwnSites: true,
      localTorEnabled: true,
      torBrowserEnabled: false,
      warpEnabled: false,
      ownProxiesConfigured: false,
      ownProxiesEnabled: false,
      ownProxyCount: 0,
      enabledOwnProxyCount: 0,
    },
    warnings: [],
  };
  return Object.assign(base, patch);

}

function createPopupHarness(options = {}) {

  const document = createDocument();
  const calls = [];
  const storageListeners = [];
  const proxyListeners = [];
  let activeLanguage = options.language || 'en';
  const handler = options.rpcHandler || (async (method) => {
    if (method === 'getPopupState') {
      return options.state || createPopupState({uiLanguage: activeLanguage});
    }
    return {ok: true};
  });
  const context = Vm.createContext({
    URL,
    chrome: {
      i18n: {
        getMessage(key, substitutions) {

          return translate(CATALOGS[activeLanguage], key, substitutions);

        },
      },
      runtime: {
        lastError: null,
        openOptionsPage() {},
      },
      storage: {
        onChanged: {
          addListener(listener) {

            storageListeners.push(listener);

          },
        },
      },
      proxy: {
        settings: {
          onChange: {
            addListener(listener) {

              proxyListeners.push(listener);

            },
          },
        },
      },
      tabs: {
        query(query, callback) {

          callback([{url: options.tabUrl || 'https://audit.example/'}]);

        },
      },
    },
    console: {error() {}, warn() {}},
    document,
    setTimeout,
  });
  context.window = context;
  context.close = () => undefined;
  context.mv3Rpc = {
    async callBackground(method, params) {

      calls.push({method, params});
      return handler(method, params, calls);

    },
  };
  context.mv3I18n = {
    async init(language) {

      activeLanguage = language === 'ru' ? 'ru' : 'en';

    },
    t(key, substitutions) {

      return translate(CATALOGS[activeLanguage], key, substitutions);

    },
  };
  Vm.runInContext(POPUP_SOURCE, context, {filename: 'pages/popup/index.js'});
  return {
    calls,
    context,
    document,
    root: document.root,
    emitProxyChange() {

      return Promise.all(proxyListeners.map((listener) => listener()));

    },
    emitStorageChange() {

      return Promise.all(storageListeners.map((listener) => listener(
          {mv3State: {newValue: {}}},
          'local',
      )));

    },
    extensionListenerCount(type) {

      return type === 'storage' ? storageListeners.length : proxyListeners.length;

    },
    start() {

      return document.dispatch('DOMContentLoaded');

    },
  };

}

function findAll(root, predicate) {

  const matches = predicate(root) ? [root] : [];
  root.childNodes.forEach((child) => {
    matches.push(...findAll(child, predicate));
  });
  return matches;

}

function findButton(root, text) {

  return findAll(root, (node) =>
    node.tagName === 'BUTTON' && node.textContent.trim() === text,
  )[0] || null;

}

function getRadios(root, name) {

  return findAll(root, (node) =>
    node.tagName === 'INPUT' &&
    node.type === 'radio' &&
    node.name === name,
  );

}

function flushUi() {

  return new Promise((resolve) => {
    setImmediate(() => setImmediate(resolve));
  });

}

function createDeferred() {

  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};

}

describe('MV3 popup UI', () => {

  it('loads with one read-only RPC and separates global control from site route',
      async () => {

        const harness = createPopupHarness();
        harness.start();
        await flushUi();

        expect(harness.calls.map((call) => call.method))
            .to.deep.equal(['getPopupState']);
        expect(harness.root.textContent).to.include('Extension proxy is on');
        expect(harness.root.textContent).to.include('Routing for this site');
        expect(harness.root.textContent)
            .to.include('No site override. The selected routing source decides.');
        expect(findButton(harness.root, 'Turn off extension proxy')).to.exist;
        expect(findButton(harness.root, 'Apply')).to.equal(null);

        const radios = getRadios(harness.root, 'site-mode');
        expect(radios).to.have.length(3);
        expect(radios.find((radio) => radio.value === 'auto').checked).to.equal(true);
        expect(radios.every((radio) => !radio.disabled)).to.equal(true);

        const settings = findAll(harness.root, (node) =>
          node.tagName === 'BUTTON' &&
          node.getAttribute('aria-label') === 'Open settings',
        );
        expect(settings).to.have.length(2);

      });

  it('renders a stable accessible loading state before the model resolves',
      async () => {

        const stateRequest = createDeferred();
        const harness = createPopupHarness({
          rpcHandler: async (method) => {
            if (method === 'getPopupState') {
              return stateRequest.promise;
            }
            return {ok: true};
          },
        });
        harness.start();

        expect(harness.root.getAttribute('aria-busy')).to.equal('true');
        expect(harness.root.textContent)
            .to.include('Loading current proxy and site routing status');
        expect(findAll(harness.root, (node) =>
          node.getAttribute('role') === 'status',
        )).to.have.length(1);

        stateRequest.resolve(createPopupState());
        await flushUi();
        expect(harness.root.getAttribute('aria-busy')).to.equal('false');

      });

  it('coalesces repeated startup events while the original state RPC is pending',
      async () => {

        const stateRequest = createDeferred();
        const harness = createPopupHarness({
          rpcHandler: async (method) => method === 'getPopupState' ?
            stateRequest.promise :
            {ok: true},
        });
        harness.start();
        harness.start();
        await flushUi();

        expect(harness.document.listenerCount('DOMContentLoaded')).to.equal(1);
        expect(harness.extensionListenerCount('storage')).to.equal(1);
        expect(harness.extensionListenerCount('proxy')).to.equal(1);
        expect(harness.calls.filter((call) => call.method === 'getPopupState'))
            .to.have.length(1);

        stateRequest.resolve(createPopupState());
        await flushUi();
        expect(harness.root.textContent).to.include('Extension proxy is on');

      });

  it('queues an ownership refresh behind an older popup-state response',
      async () => {

        const initialRequest = createDeferred();
        const initialState = createPopupState();
        const externalState = createPopupState({
          proxyApplied: false,
          proxyControl: {
            levelOfControl: 'controlled_by_other_extensions',
            canControl: false,
            controlledByThisExtension: false,
            controlsPac: false,
          },
        });
        let stateReads = 0;
        const harness = createPopupHarness({
          rpcHandler: async (method) => {
            if (method !== 'getPopupState') {
              return {ok: true};
            }
            stateReads += 1;
            return stateReads === 1 ? initialRequest.promise : externalState;
          },
        });
        harness.start();
        const refresh = harness.emitProxyChange();
        initialRequest.resolve(initialState);
        await refresh;
        await flushUi();

        expect(stateReads).to.equal(2);
        expect(harness.root.textContent)
            .to.include('Proxy settings are controlled elsewhere');
        expect(findButton(harness.root, 'Apply')).to.equal(null);
        expect(getRadios(harness.root, 'site-mode').every((radio) => radio.disabled))
            .to.equal(true);

      });

  it('shows Apply for cleared state and blocks actions under external ownership',
      async () => {

        const cleared = createPopupHarness({
          state: createPopupState({
            proxyApplied: false,
            proxyApplyStatus: 'cleared',
            proxyControl: {
              levelOfControl: 'controllable_by_this_extension',
              canControl: true,
              controlledByThisExtension: false,
              controlsPac: false,
            },
          }),
        });
        cleared.start();
        await flushUi();
        expect(cleared.root.textContent).to.include('Extension proxy is off');
        expect(findButton(cleared.root, 'Apply')).to.exist;
        expect(findButton(cleared.root, 'Turn off extension proxy')).to.equal(null);

        const external = createPopupHarness({
          state: createPopupState({
            proxyApplied: false,
            proxyControl: {
              levelOfControl: 'controlled_by_other_extensions',
              canControl: false,
              controlledByThisExtension: false,
              controlsPac: false,
            },
          }),
        });
        external.start();
        await flushUi();
        expect(external.root.textContent)
            .to.include('Proxy settings are controlled elsewhere');
        expect(findButton(external.root, 'Apply')).to.equal(null);
        expect(findButton(external.root, 'Turn off extension proxy')).to.equal(null);
        expect(getRadios(external.root, 'site-mode').every((radio) => radio.disabled))
            .to.equal(true);

      });

  it('shows Retry for a reconstructed recoverable apply error', async () => {

    const harness = createPopupHarness({
      state: createPopupState({
        proxyApplied: false,
        proxyApplyStatus: 'error',
        proxyControl: {
          levelOfControl: 'controllable_by_this_extension',
          canControl: true,
          controlledByThisExtension: false,
          controlsPac: false,
        },
      }),
    });
    harness.start();
    await flushUi();

    expect(harness.root.textContent)
        .to.include('The last operation needs attention');
    expect(findButton(harness.root, 'Retry')).to.exist;
    expect(findButton(harness.root, 'Apply')).to.equal(null);
    expect(findButton(harness.root, 'Turn off extension proxy')).to.equal(null);

  });

  it('renders health degradation without confusing it with global ownership',
      async () => {

        const state = createPopupState({
          mode: 'proxy',
          siteRule: {
            mode: 'proxy',
            scope: 'domain',
            pattern: '*.audit.example',
            legacy: false,
          },
          proxyHealth: {
            status: 'error',
            lastCheckedAt: Date.now(),
            candidateType: 'localTor',
          },
        });
        const harness = createPopupHarness({
          state,
          rpcHandler: async (method) => method === 'checkProxyHealth' ? {
            ok: false,
            status: 'error',
            code: 'net::ERR_PROXY_CONNECTION_FAILED',
          } : state,
        });
        harness.start();
        await flushUi();

        expect(harness.root.textContent).to.include('Extension proxy is on');
        expect(harness.root.textContent).to.include('Proxy problem');
        expect(harness.root.textContent)
            .to.include('Could not connect to the Tor service');
        expect(findButton(harness.root, 'Turn off extension proxy')).to.exist;
        expect(findButton(harness.root, 'Check again')).to.exist;

        await findButton(harness.root, 'Check again').onclick();
        await flushUi();
        expect(findButton(harness.root, 'Retry')).to.exist;
        expect(findButton(harness.root, 'Check again')).to.equal(null);

      });

  it('renders setup and missing-proxy-method blockers with contextual actions',
      async () => {

        const setup = createPopupHarness({
          state: createPopupState({
            selectedProvider: '',
            selectedProviderLabel: '',
            proxyApplied: false,
            proxyApplyStatus: 'idle',
            proxyControl: {
              levelOfControl: 'controllable_by_this_extension',
              canControl: true,
              controlledByThisExtension: false,
              controlsPac: false,
            },
          }),
        });
        setup.start();
        await flushUi();
        expect(setup.root.textContent).to.include('Setup is not complete');
        expect(findButton(setup.root, 'Choose routing source')).to.exist;
        expect(findButton(setup.root, 'Apply')).to.equal(null);

        const noCandidateState = createPopupState({
          mode: 'auto',
          proxyApplied: false,
          proxyApplyStatus: 'cleared',
          proxyControl: {
            levelOfControl: 'controllable_by_this_extension',
            canControl: true,
            controlledByThisExtension: false,
            controlsPac: false,
          },
          proxyCandidates: {available: false, labels: []},
          quickProxies: {
            usePacScriptProxies: true,
            ownProxiesOnlyForOwnSites: true,
            localTorEnabled: false,
            torBrowserEnabled: false,
            warpEnabled: false,
            ownProxiesConfigured: false,
            ownProxiesEnabled: false,
            ownProxyCount: 0,
            enabledOwnProxyCount: 0,
          },
        });
        const noCandidate = createPopupHarness({state: noCandidateState});
        noCandidate.start();
        await flushUi();
        const proxyRadio = getRadios(noCandidate.root, 'site-mode')
            .find((radio) => radio.value === 'proxy');
        proxyRadio.checked = true;
        proxyRadio.onchange();
        expect(noCandidate.root.textContent)
            .to.include('Proxy routing needs at least one enabled');
        expect(noCandidate.root.textContent).to.include('Pending');
        expect(findButton(noCandidate.root, 'Configure proxy methods')).to.exist;
        expect(findButton(noCandidate.root, 'Apply').disabled).to.equal(true);
        expect(noCandidate.calls.map((call) => call.method))
            .to.deep.equal(['getPopupState']);

      });

  it('adopts external ownership returned by a pending operation without races',
      async () => {

        const applyRequest = createDeferred();
        const initialState = createPopupState();
        const externalState = createPopupState({
          proxyApplied: false,
          proxyApplyStatus: 'error',
          proxyControl: {
            levelOfControl: 'controlled_by_other_extensions',
            canControl: false,
            controlledByThisExtension: false,
            controlsPac: false,
          },
        });
        const harness = createPopupHarness({
          state: initialState,
          rpcHandler: async (method) => {
            if (method === 'getPopupState') {
              return initialState;
            }
            if (method === 'applyPopupChanges') {
              return applyRequest.promise;
            }
            return {ok: true};
          },
        });
        harness.start();
        await flushUi();

        let details = findAll(harness.root, (node) =>
          node.tagName === 'DETAILS' && node.dataset.area === 'advanced',
        )[0];
        details.open = true;
        details.ontoggle();
        const directRadio = getRadios(harness.root, 'site-mode')
            .find((radio) => radio.value === 'direct');
        directRadio.checked = true;
        directRadio.onchange();
        const apply = findButton(harness.root, 'Apply').onclick();

        applyRequest.resolve({
          ok: false,
          status: 'error',
          error: {code: 'PROXY_NOT_CONTROLLABLE'},
          popupState: externalState,
        });
        await apply;
        await flushUi();

        expect(harness.root.textContent)
            .to.include('Proxy settings are controlled elsewhere');
        expect(findButton(harness.root, 'Apply')).to.equal(null);
        expect(findButton(harness.root, 'Retry')).to.equal(null);
        expect(findButton(harness.root, 'Turn off extension proxy')).to.equal(null);
        expect(getRadios(harness.root, 'site-mode').every((radio) => radio.disabled))
            .to.equal(true);
        details = findAll(harness.root, (node) =>
          node.tagName === 'DETAILS' && node.dataset.area === 'advanced',
        )[0];
        expect(details.open).to.equal(true);
        expect(details.children.find((node) => node.tagName === 'SUMMARY')
            .getAttribute('aria-expanded')).to.equal('true');

      });

  it('reconstructs in-progress apply and clear states without contradictory actions',
      async () => {

        for (const [status, text] of [
          ['applying', 'Applying changes'],
          ['clearing', 'Turning off extension proxy'],
        ]) {
          const harness = createPopupHarness({
            state: createPopupState({proxyApplyStatus: status}),
          });
          harness.start();
          await flushUi();
          expect(harness.root.textContent).to.include(text);
          expect(findButton(harness.root, 'Apply')).to.equal(null);
          expect(findButton(harness.root, 'Turn off extension proxy')).to.equal(null);
          expect(findButton(harness.root, 'Retry')).to.equal(null);
          expect(getRadios(harness.root, 'site-mode').every((radio) => radio.disabled))
              .to.equal(true);
        }

      });

  it('refreshes a reconstructed operation when durable state completes',
      async () => {

        let currentState = createPopupState({
          proxyHealth: {
            status: 'checking',
            lastCheckedAt: Date.now(),
            candidateType: 'localTor',
          },
        });
        const harness = createPopupHarness({
          rpcHandler: async (method) => method === 'getPopupState' ?
            currentState : {ok: true},
        });
        harness.start();
        await flushUi();
        expect(harness.root.textContent).to.include('Testing proxy connection');
        expect(findButton(harness.root, 'Turn off extension proxy')).to.equal(null);

        currentState = createPopupState();
        await harness.emitStorageChange();
        await flushUi();

        expect(harness.root.textContent).to.include('Extension proxy is on');
        expect(harness.root.textContent).to.not.include('Testing proxy connection');
        expect(findButton(harness.root, 'Turn off extension proxy')).to.exist;
        expect(harness.calls.filter((call) => call.method === 'getPopupState'))
            .to.have.length(2);

      });

  it('prevents duplicate clear mutations while a clear is pending', async () => {

    const clearRequest = createDeferred();
    const initialState = createPopupState();
    const clearedState = createPopupState({
      proxyApplied: false,
      proxyApplyStatus: 'cleared',
      proxyControl: {
        levelOfControl: 'controllable_by_this_extension',
        canControl: true,
        controlledByThisExtension: false,
        controlsPac: false,
      },
    });
    const harness = createPopupHarness({
      state: initialState,
      rpcHandler: async (method) => {
        if (method === 'getPopupState') {
          return harness.calls.filter((call) => call.method === 'clearProxy').length ?
            clearedState :
            initialState;
        }
        if (method === 'clearProxy') {
          return clearRequest.promise;
        }
        return {ok: true};
      },
    });
    harness.start();
    await flushUi();

    const clearButton = findButton(harness.root, 'Turn off extension proxy');
    const firstClear = clearButton.onclick();
    clearButton.onclick();
    expect(harness.calls.filter((call) => call.method === 'clearProxy'))
        .to.have.length(1);
    expect(harness.root.textContent).to.include('Turning off extension proxy');

    clearRequest.resolve({ok: true, status: 'cleared'});
    await firstClear;
    await flushUi();
    expect(harness.root.textContent).to.include('Extension proxy is off');

  });

  it('keeps site changes pending locally and prevents duplicate apply calls',
      async () => {

        const applyRequest = createDeferred();
        const initialState = createPopupState();
        const appliedState = createPopupState({
          mode: 'proxy',
          siteRule: {scope: 'domain', pattern: '*.audit.example'},
        });
        const harness = createPopupHarness({
          state: initialState,
          rpcHandler: async (method) => {
            if (method === 'getPopupState') {
              return initialState;
            }
            if (method === 'applyPopupChanges') {
              return applyRequest.promise;
            }
            return {ok: true};
          },
        });
        harness.start();
        await flushUi();

        const proxyRadio = getRadios(harness.root, 'site-mode')
            .find((radio) => radio.value === 'proxy');
        proxyRadio.checked = true;
        proxyRadio.onchange();
        expect(harness.calls.map((call) => call.method))
            .to.deep.equal(['getPopupState']);
        expect(harness.root.textContent).to.include('Pending');

        const applyButton = findButton(harness.root, 'Apply');
        const firstApply = applyButton.onclick();
        applyButton.onclick();
        expect(harness.calls.filter((call) =>
          call.method === 'applyPopupChanges',
        )).to.have.length(1);
        expect(harness.root.textContent).to.include('Applying changes');
        expect(findButton(harness.root, 'Apply')).to.equal(null);
        expect(getRadios(harness.root, 'site-mode').every((radio) => radio.disabled))
            .to.equal(true);

        applyRequest.resolve({
          ok: true,
          status: 'applied',
          message: 'Settings applied.',
          popupState: appliedState,
        });
        await firstApply;
        await flushUi();
        expect(getRadios(harness.root, 'site-mode')
            .find((radio) => radio.value === 'proxy').checked).to.equal(true);

      });

  it('preserves the selected site route after a stale apply rejection',
      async () => {

        const initialState = createPopupState();
        const appliedState = createPopupState({
          mode: 'proxy',
          siteRule: {scope: 'domain', pattern: '*.audit.example'},
        });
        let applyCount = 0;
        const harness = createPopupHarness({
          state: initialState,
          rpcHandler: async (method) => {
            if (method === 'getPopupState') {
              return initialState;
            }
            if (method === 'applyPopupChanges') {
              ++applyCount;
              if (applyCount > 1) {
                return {
                  ok: true,
                  status: 'applied',
                  message: 'Settings applied.',
                  popupState: appliedState,
                };
              }
              return {
                ok: false,
                status: 'stale',
                error: {code: 'PAC_APPLY_STALE'},
                popupState: initialState,
              };
            }
            return {ok: true};
          },
        });
        harness.start();
        await flushUi();
        const proxyRadio = getRadios(harness.root, 'site-mode')
            .find((radio) => radio.value === 'proxy');
        proxyRadio.checked = true;
        proxyRadio.onchange();
        await findButton(harness.root, 'Apply').onclick();
        await flushUi();

        expect(harness.root.textContent)
            .to.include('The proxy state changed during the operation');
        expect(findButton(harness.root, 'Retry')).to.exist;
        expect(getRadios(harness.root, 'site-mode')
            .find((radio) => radio.value === 'proxy').checked).to.equal(true);

        await findButton(harness.root, 'Retry').onclick();
        await flushUi();
        expect(harness.root.textContent)
            .to.not.include('The proxy state changed during the operation');
        expect(harness.root.textContent).to.include('Settings applied');
        expect(findButton(harness.root, 'Retry')).to.equal(null);

      });

  it('renders unsupported tabs without site mutation controls', async () => {

    const harness = createPopupHarness({
      tabUrl: 'chrome://extensions/',
      state: createPopupState({
        host: '',
        controllable: false,
        reason: 'This page cannot be controlled.',
        mode: 'auto',
      }),
    });
    harness.start();
    await flushUi();

    expect(harness.root.textContent).to.include('Current page unavailable');
    expect(harness.root.textContent)
        .to.include('A site-specific route cannot be set');
    expect(getRadios(harness.root, 'site-mode')).to.have.length(0);

  });

  it('keeps Advanced collapsed, exposes expansion semantics, and renders no secrets',
      async () => {

        const secret = ['do-not', '-render'].join('');
        const state = createPopupState();
        state.quickProxies.password = secret;
        state.proxyCandidates.credentials = secret;
        const harness = createPopupHarness({state});
        harness.start();
        await flushUi();

        const details = findAll(harness.root, (node) =>
          node.tagName === 'DETAILS' && node.dataset.area === 'advanced',
        )[0];
        const summary = details.children.find((node) => node.tagName === 'SUMMARY');
        expect(details.open).to.equal(false);
        expect(summary.getAttribute('aria-expanded')).to.equal('false');
        expect(summary.getAttribute('aria-controls'))
            .to.equal('popup-advanced-content');
        expect(findAll(details, (node) =>
          node.id === 'popup-advanced-content',
        )).to.have.length(1);
        expect(harness.root.textContent).to.not.include(secret);

        const callsBefore = harness.calls.length;
        details.open = true;
        details.ontoggle();
        expect(summary.getAttribute('aria-expanded')).to.equal('true');
        expect(harness.calls).to.have.length(callsBefore);

      });

  it('uses text-only DOM construction for hostile provider and error strings',
      async () => {

        const hostileProvider = '<img src=x onerror=credentialProbe()>Provider';
        const hostileError = '<script>credentialProbe()</script>';
        const state = createPopupState({
          providers: [{
            key: 'custom-safe-id',
            label: hostileProvider,
            description: hostileError,
            type: 'custom',
            readOnly: false,
          }],
          selectedProvider: 'custom-safe-id',
          selectedProviderLabel: hostileProvider,
          mode: 'direct',
        });
        const harness = createPopupHarness({
          state,
          rpcHandler: async (method) => {
            if (method === 'getPopupState') {
              return state;
            }
            if (method === 'applyPopupChanges') {
              return {
                ok: false,
                status: 'error',
                message: hostileError,
                error: {code: 'POPUP_OPERATION_FAILED'},
                popupState: state,
              };
            }
            return {ok: true};
          },
        });
        harness.start();
        await flushUi();

        expect(harness.root.textContent).to.include(hostileProvider);
        expect(findAll(harness.root, (node) =>
          ['IMG', 'SCRIPT'].includes(node.tagName),
        )).to.have.length(0);

        const hostRadio = getRadios(harness.root, 'site-scope')
            .find((radio) => radio.value === 'host');
        hostRadio.checked = true;
        hostRadio.onchange();
        await findButton(harness.root, 'Apply').onclick();
        await flushUi();
        expect(harness.root.textContent).to.include('requested change was not completed');
        expect(harness.root.textContent).to.not.include(hostileError);
        expect(findAll(harness.root, (node) => node.tagName === 'SCRIPT'))
            .to.have.length(0);

      });

  it('renders natural Russian status copy without English popup fallbacks',
      async () => {

        const harness = createPopupHarness({
          language: 'ru',
          state: createPopupState({uiLanguage: 'ru'}),
        });
        harness.start();
        await flushUi();

        expect(harness.root.textContent).to.include('Прокси расширения включён');
        expect(harness.root.textContent).to.include('Маршрут для этого сайта');
        expect(harness.root.textContent).to.include('Проверка пройдена');
        expect(harness.root.textContent).to.not.include('Extension proxy is on');

      });

  it('keeps popup localization keys complete and aligned', () => {

    const popupKeys = Array.from(
        POPUP_SOURCE.matchAll(/'(popup[A-Z][A-Za-z0-9]+)'/g),
        (match) => match[1],
    );
    const missing = Array.from(new Set(popupKeys)).filter((key) =>
      !CATALOGS.en[key] || !CATALOGS.ru[key],
    );
    const parity = Array.from(new Set([
      ...Object.keys(CATALOGS.en),
      ...Object.keys(CATALOGS.ru),
    ])).filter((key) => !CATALOGS.en[key] || !CATALOGS.ru[key]);
    const placeholderMismatches = Object.keys(CATALOGS.en)
        .filter((key) => CATALOGS.ru[key])
        .filter((key) => JSON.stringify(
            Object.keys(CATALOGS.en[key].placeholders || {}).sort(),
        ) !== JSON.stringify(
            Object.keys(CATALOGS.ru[key].placeholders || {}).sort(),
        ));

    expect(missing).to.deep.equal([]);
    expect(parity).to.deep.equal([]);
    expect(placeholderMismatches).to.deep.equal([]);

  });

  it('exposes only the safe proxy-control summary in popup RPC state',
      async () => {

        const runtime = await createRuntimeHarness();
        const popup = await runtime.callRpc('getPopupState', {
          tabUrl: 'https://audit.example/',
        });

        expect(popup.proxyControl).to.have.keys([
          'levelOfControl',
          'canControl',
          'controlledByThisExtension',
          'controlsPac',
          'checkedAt',
        ]);
        expect(popup.proxyControl).to.not.have.property('rawValue');
        expect(popup.proxyControl).to.not.have.property('error');

      });

});
