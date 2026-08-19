'use strict';


const {expect} = require('chai');
const Fs = require('fs');
const Path = require('path');
const Vm = require('vm');

const MV3_DIRECTORY = Path.resolve(__dirname, '..');
const OPTIONS_SOURCE = Fs.readFileSync(
    Path.join(MV3_DIRECTORY, 'pages', 'options', 'index.js'),
    'utf8',
);
const OPTIONS_HTML = Fs.readFileSync(
    Path.join(MV3_DIRECTORY, 'pages', 'options', 'index.html'),
    'utf8',
);
const OPTIONS_CSS = Fs.readFileSync(
    Path.join(MV3_DIRECTORY, 'pages', 'options', 'options.css'),
    'utf8',
);
const POPUP_CSS = Fs.readFileSync(
    Path.join(MV3_DIRECTORY, 'pages', 'popup', 'popup.css'),
    'utf8',
);
const UI_TOKENS = Fs.readFileSync(
    Path.join(MV3_DIRECTORY, 'pages', 'shared', 'ui-tokens.css'),
    'utf8',
);
const CATALOGS = Object.fromEntries(['en', 'ru'].map((language) => [
  language,
  JSON.parse(Fs.readFileSync(
      Path.join(
          MV3_DIRECTORY,
          '_locales',
          language,
          'messages.json',
      ),
      'utf8',
  )),
]));

class FakeClassList {

  constructor(node) {

    this.node = node;

  }

  add(...classes) {

    const values = new Set(
        this.node.className.split(/\s+/g).filter(Boolean),
    );
    classes.forEach((value) => values.add(value));
    this.node.className = Array.from(values).join(' ');

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
    this.listeners = {};
    this._textValue = textValue;
    this.textContentWrites = 0;
    this.id = '';
    this.name = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.required = false;
    this.href = '';
    this.title = '';
    this.placeholder = '';
    this.autocomplete = '';
    this.onclick = null;
    this.onchange = null;
    this.onsubmit = null;

  }

  get textContent() {

    if (this.tagName === '#TEXT') {
      return this._textValue || '';
    }
    return (this._textValue || '') +
      this.childNodes.map((node) => node.textContent).join('');

  }

  set textContent(value) {

    this.textContentWrites += 1;
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

  insertBefore(node, reference) {

    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    const index = this.childNodes.indexOf(reference);
    node.parentNode = this;
    if (index < 0) {
      this.childNodes.push(node);
    } else {
      this.childNodes.splice(index, 0, node);
    }
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

  removeAttribute(name) {

    delete this.attributes[name];

  }

  addEventListener(type, listener) {

    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);

  }

  dispatch(type) {

    const event = {
      type,
      target: this,
      currentTarget: this,
      preventDefault() {},
    };
    (this.listeners[type] || []).forEach((listener) => listener(event));
    const property = `on${type}`;
    if (typeof this[property] === 'function') {
      this[property](event);
    }
    if (this.parentNode) {
      this.parentNode.dispatchFromChild(type, this);
    }

  }

  dispatchFromChild(type, target) {

    const event = {
      type,
      target,
      currentTarget: this,
      preventDefault() {},
    };
    (this.listeners[type] || []).forEach((listener) => listener(event));
    if (this.parentNode) {
      this.parentNode.dispatchFromChild(type, target);
    }

  }

  focus() {

    this.ownerDocument.activeElement = this;

  }

  contains(target) {

    return target === this || this.childNodes.some((node) =>
      node.contains && node.contains(target),
    );

  }

  closest(selector) {

    let node = this;
    while (node) {
      if (matchesSelector(node, selector)) {
        return node;
      }
      node = node.parentNode;
    }
    return null;

  }

  querySelectorAll(selector) {

    return findAll(this, (node) => matchesSelector(node, selector));

  }

  querySelector(selector) {

    return this.querySelectorAll(selector)[0] || null;

  }

}

function findAll(root, predicate) {

  const result = [];
  root.childNodes.forEach((child) => {
    if (predicate(child)) {
      result.push(child);
    }
    result.push(...findAll(child, predicate));
  });
  return result;

}

function matchesSimple(node, selector) {

  if (!node || node.tagName === '#TEXT') {
    return false;
  }
  let token = selector.trim();
  const attributes = [];
  token = token.replace(/\[([^\]=]+)(?:="([^"]*)")?\]/g,
      (match, name, value) => {
        attributes.push({name, value});
        return '';
      });
  const idMatch = token.match(/#([a-z0-9_-]+)/i);
  if (idMatch && node.id !== idMatch[1]) {
    return false;
  }
  token = token.replace(/#[a-z0-9_-]+/ig, '');
  const classes = Array.from(token.matchAll(/\.([a-z0-9_-]+)/ig))
      .map((match) => match[1]);
  if (classes.some((className) => !node.classList.contains(className))) {
    return false;
  }
  token = token.replace(/\.[a-z0-9_-]+/ig, '');
  if (token && node.tagName !== token.toUpperCase()) {
    return false;
  }
  return attributes.every(({name, value}) => {
    let actual;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (match, letter) =>
        letter.toUpperCase(),
      );
      actual = node.dataset[key];
    } else if (['id', 'name', 'type'].includes(name)) {
      actual = node[name];
    } else {
      actual = node.getAttribute(name);
    }
    return value === undefined ? actual !== undefined && actual !== null :
      String(actual) === value;
  });

}

function matchesSelector(node, selector) {

  return selector.split(',').some((part) => {
    const tokens = part.trim().split(/\s+/g);
    if (!matchesSimple(node, tokens[tokens.length - 1])) {
      return false;
    }
    let ancestor = node.parentNode;
    for (let index = tokens.length - 2; index >= 0; --index) {
      while (ancestor && !matchesSimple(ancestor, tokens[index])) {
        ancestor = ancestor.parentNode;
      }
      if (!ancestor) {
        return false;
      }
      ancestor = ancestor.parentNode;
    }
    return true;
  });

}

function createDocument() {

  const listeners = {};
  const document = {
    activeElement: null,
    title: '',
    visibilityState: 'visible',
    documentElement: {lang: ''},
    addEventListener(type, listener) {

      listeners[type] = listeners[type] || [];
      listeners[type].push(listener);

    },
    createElement(tagName) {

      return new FakeNode(tagName, document);

    },
    createTextNode(value) {

      return new FakeNode('#text', document, String(value));

    },
    getElementById(id) {

      return id === 'app-root' ? document.root : null;

    },
    dispatch(type, event = {}) {

      return (listeners[type] || []).map((listener) => listener(event));

    },
    listenerCount(type) {

      return (listeners[type] || []).length;

    },
  };
  document.root = new FakeNode('main', document);
  document.root.id = 'app-root';
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

function createSnapshot(patch = {}) {

  const now = Date.now();
  const pacMods = {
    credentialRevision: 4,
    exceptions: [{
      pattern: 'proxy.example',
      action: 'PROXY',
      enabled: true,
      note: 'Main rule',
    }],
    rules: [],
    whitelist: [],
    usePacScriptProxies: true,
    ownProxiesOnlyForOwnSites: true,
    localTor: {
      enabled: true,
      type: 'SOCKS5',
      host: '127.0.0.1',
      port: 9050,
      useForOnion: true,
      useAsDirectReplacement: false,
    },
    torBrowser: {
      enabled: false,
      type: 'SOCKS5',
      host: '127.0.0.1',
      port: 9150,
      useForOnion: true,
      useAsDirectReplacement: false,
    },
    warp: {
      enabled: false,
      proxyString: 'SOCKS5 127.0.0.1:40000',
      useAsDirectReplacement: false,
    },
    ownProxies: [],
    replaceDirectWithProxy: false,
    noDirect: false,
  };
  const base = {
    status: 'ready',
    providers: [{
      key: 'Антизапрет',
      label: 'Antizapret',
      description: '',
      urls: ['https://example.test/proxy.pac'],
      enabled: true,
      type: 'builtIn',
    }],
    state: {
      uiLanguage: 'en',
      currentPacProviderKey: 'Антизапрет',
      pacMods,
      notificationPrefs: {
        pacError: true,
        extError: true,
        noControl: true,
      },
      pacDownload: {status: 'success'},
      pacCache: {rawPacSha256: 'hidden'},
      pacCook: {status: 'success'},
      cookedPacCache: {cookedPacSha256: 'hidden'},
      proxyApply: {status: 'applied'},
      proxyControl: {
        levelOfControl: 'controlled_by_this_extension',
        canControl: true,
        controlledByThisExtension: true,
        rawValue: {mode: 'pac_script'},
      },
      legacyMigration: {},
    },
    proxy: {
      proxyApply: {status: 'applied'},
      proxyControl: {
        levelOfControl: 'controlled_by_this_extension',
        canControl: true,
        controlledByThisExtension: true,
        rawValue: {mode: 'pac_script'},
      },
      stale: {cookedPac: {stale: false, reasons: []}},
    },
    stale: {cookedPac: {stale: false, reasons: []}},
    reliability: {
      autoUpdate: {
        enabled: true,
        lastSuccessfulUpdateAt: now - 1000,
        nextUpdateAt: now + 1000,
      },
      proxyHealth: {
        status: 'ok',
        lastCheckedAt: now - 500,
        candidateType: 'localTor',
      },
    },
    periodicUpdate: {
      periodicUpdate: {status: 'scheduled', nextRunAt: now + 1000},
    },
  };
  return Object.assign(base, patch);

}

function deferred() {

  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};

}

async function flush() {

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

}

async function createHarness(options = {}) {

  const document = createDocument();
  const calls = [];
  const windowListeners = {};
  const storageListeners = [];
  const proxyListeners = [];
  let activeLanguage = options.language || 'en';
  let snapshot = options.snapshot || createSnapshot();
  const handler = options.rpcHandler || (async (method) => {
    if (method === 'getState') {
      return snapshot;
    }
    return {ok: true};
  });
  const location = {
    hash: options.hash || '',
    reloadCalls: 0,
    reload() {

      this.reloadCalls += 1;

    },
  };
  const context = Vm.createContext({
    URL,
    chrome: {
      runtime: {
        getManifest() {

          return {version: '0.0.2.0', version_name: '0.0.2.00'};

        },
      },
      i18n: {
        getMessage(key, substitutions) {

          return translate(CATALOGS[activeLanguage], key, substitutions);

        },
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
    },
    console: {error() {}, warn() {}},
    document,
    location,
    setTimeout,
  });
  context.window = context;
  context.window.location = location;
  context.window.confirm = options.confirm || (() => true);
  context.window.addEventListener = (type, listener) => {
    windowListeners[type] = windowListeners[type] || [];
    windowListeners[type].push(listener);
  };
  context.window.dispatch = (type, event = {}) =>
    (windowListeners[type] || []).map((listener) => listener(event));
  context.mv3Rpc = {
    async callBackground(method, params) {

      calls.push({method, params});
      return handler(method, params, calls);

    },
  };
  context.mv3I18n = {
    async init(language) {

      activeLanguage = language === 'ru' ? 'ru' :
        language === 'en' ? 'en' : activeLanguage;
      document.documentElement.lang = activeLanguage;

    },
    t(key, substitutions) {

      return translate(CATALOGS[activeLanguage], key, substitutions);

    },
  };
  Vm.runInContext(OPTIONS_SOURCE, context, {filename: 'options/index.js'});
  await flush();
  return {
    calls,
    context,
    document,
    location,
    root: document.root,
    setSnapshot(value) {

      snapshot = value;

    },
    dispatchStorageChange(changes = {mv3State: {newValue: {}}}) {

      storageListeners.forEach((listener) => listener(changes, 'local'));

    },
    dispatchProxyChange() {

      proxyListeners.forEach((listener) => listener({}));

    },
    listenerCounts: {
      storage: storageListeners.length,
      proxy: proxyListeners.length,
    },
  };

}

function findButton(root, text) {

  return root.querySelectorAll('button').find((button) =>
    button.textContent === text,
  );

}

function getInput(root, name) {

  return root.querySelector(`[name="${name}"]`);

}

function getSection(root, id) {

  return root.querySelector(`[data-options-section="${id}"]`);

}

describe('MV3 options UI', function() {

  it('opens read-only with task navigation and one selected section',
      async function() {

        const harness = await createHarness();
        expect(harness.calls.map((call) => call.method)).to.deep.equal([
          'getState',
        ]);
        expect(harness.root.textContent).to.include('Overview');
        expect(harness.root.textContent).to.include('Routing sources');
        expect(harness.root.textContent).to.include('0.0.2.00');
        expect(harness.root.textContent).to.include('Limited MV3 beta');
        expect(harness.root.textContent).not.to.include('MV3 migration:');
        const aboutLinks = harness.root.querySelectorAll('.about-links a');
        expect(aboutLinks.map((link) => link.textContent)).to.deep.equal([
          'GitHub repository',
          'What\'s new',
          'Report an issue',
          'GNU GPL v3 license',
          'Upstream project',
        ]);
        expect(aboutLinks.map((link) => link.href)).to.deep.equal([
          'https://github.com/aVitomin/runet-censorship-bypass-mv3',
          'https://github.com/aVitomin/runet-censorship-bypass-mv3/releases',
          'https://github.com/aVitomin/runet-censorship-bypass-mv3/issues/new/choose',
          'https://github.com/aVitomin/runet-censorship-bypass-mv3/blob/main/LICENSE',
          'https://github.com/anticensority/runet-censorship-bypass',
        ]);
        expect(aboutLinks.every((link) =>
          link.target === '_blank' && link.rel === 'noopener noreferrer',
        )).to.equal(true);
        expect(getSection(harness.root, 'overview').hidden).to.equal(false);
        expect(getSection(harness.root, 'site-rules').hidden).to.equal(true);
        const current = harness.root.querySelector(
            '.options-nav a[aria-current="page"]',
        );
        expect(current.textContent).to.equal('Overview');
        current.dispatch('click');
        expect(harness.document.activeElement.id).to.equal('overview-heading');

      });

  it('uses hash navigation without replacing drafts or reloading',
      async function() {

        const harness = await createHarness();
        const sections = [
          'overview',
          'routing-sources',
          'site-rules',
          'proxy-methods',
          'updates-health',
          'diagnostics',
          'advanced',
        ];
        for (const sectionId of sections) {
          harness.location.hash = `#${sectionId}`;
          harness.context.window.dispatch('hashchange');
          expect(getSection(harness.root, sectionId).hidden).to.equal(false);
          expect(harness.root.querySelectorAll(
              '[data-options-section]',
          ).filter((section) => !section.hidden)).to.have.length(1);
          expect(harness.root.querySelector(
              '.options-nav a[aria-current="page"]',
          ).dataset.section).to.equal(sectionId);
          expect(harness.document.activeElement.id)
              .to.equal(`${sectionId}-heading`);
        }
        harness.location.hash = '#unknown-section';
        harness.context.window.dispatch('hashchange');
        expect(getSection(harness.root, 'overview').hidden).to.equal(false);
        expect(harness.root.querySelector(
            '.options-nav a[aria-current="page"]',
        ).dataset.section).to.equal('overview');
        harness.location.hash = '#site-rules';
        harness.context.window.dispatch('hashchange');
        harness.location.hash = '#routing-sources';
        harness.context.window.dispatch('hashchange');
        harness.location.hash = '#site-rules';
        harness.context.window.dispatch('hashchange');
        expect(getSection(harness.root, 'site-rules').hidden).to.equal(false);
        expect(harness.location.reloadCalls).to.equal(0);

      });

  it('separates applied, cleared, and external ownership actions',
      async function() {

        const applied = await createHarness();
        expect(applied.root.textContent).to.include('Extension proxy is on');
        expect(findButton(applied.root, 'Turn off extension proxy')).to.exist;
        const clearedSnapshot = createSnapshot();
        clearedSnapshot.state.proxyApply = {status: 'cleared'};
        clearedSnapshot.state.proxyControl = {
          levelOfControl: 'controllable_by_this_extension',
          canControl: true,
          controlledByThisExtension: false,
        };
        clearedSnapshot.proxy.proxyApply = clearedSnapshot.state.proxyApply;
        clearedSnapshot.proxy.proxyControl =
          clearedSnapshot.state.proxyControl;
        const cleared = await createHarness({snapshot: clearedSnapshot});
        expect(cleared.root.textContent).to.include('Extension proxy is off');
        expect(findButton(cleared.root, 'Apply configuration')).to.exist;
        const externalSnapshot = createSnapshot();
        externalSnapshot.state.proxyControl = {
          levelOfControl: 'controlled_by_other_extensions',
          canControl: false,
          controlledByThisExtension: false,
        };
        externalSnapshot.proxy.proxyControl =
          externalSnapshot.state.proxyControl;
        const external = await createHarness({snapshot: externalSnapshot});
        expect(external.root.textContent).to.include(
            'Proxy settings are controlled elsewhere',
        );
        expect(findButton(external.root, 'Apply configuration')).not.to.exist;
        expect(findButton(external.root, 'Turn off extension proxy')).not.to.exist;

      });

  it('updates external ownership after the page is already open',
      async function() {

        const harness = await createHarness();
        expect(findButton(harness.root, 'Turn off extension proxy')).to.exist;
        const external = createSnapshot();
        external.state.proxyControl = {
          levelOfControl: 'controlled_by_other_extensions',
          canControl: false,
          controlledByThisExtension: false,
        };
        external.proxy.proxyControl = external.state.proxyControl;
        harness.setSnapshot(external);
        harness.dispatchProxyChange();
        await flush();
        expect(harness.root.textContent).to.include(
            'Proxy settings are controlled elsewhere',
        );
        expect(findButton(harness.root, 'Apply configuration')).not.to.exist;
        expect(findButton(harness.root, 'Turn off extension proxy')).not.to.exist;
        expect(harness.calls.filter((call) => call.method === 'getState'))
            .to.have.length(2);

      });

  it('uses one guarded normal apply workflow', async function() {

    const snapshot = createSnapshot();
    snapshot.state.proxyApply = {status: 'cleared'};
    snapshot.proxy.proxyApply = snapshot.state.proxyApply;
    snapshot.state.proxyControl = {
      levelOfControl: 'controllable_by_this_extension',
      canControl: true,
      controlledByThisExtension: false,
    };
    snapshot.proxy.proxyControl = snapshot.state.proxyControl;
    const gate = deferred();
    const harness = await createHarness({
      snapshot,
      rpcHandler(method) {

        if (method === 'getState') {
          return snapshot;
        }
        if (method === 'applyPopupChanges') {
          return gate.promise;
        }
        return {ok: true};

      },
    });
    const apply = findButton(harness.root, 'Apply configuration');
    const first = apply.onclick();
    const second = apply.onclick();
    expect(harness.calls.filter((call) =>
      call.method === 'applyPopupChanges',
    )).to.have.length(1);
    gate.resolve({ok: true, status: 'applied'});
    await Promise.all([first, second]);
    expect(harness.calls.find((call) =>
      call.method === 'applyPopupChanges',
    ).params).to.deep.equal({operation: 'apply', draft: {}});

  });

  it('prevents duplicate clear workflows', async function() {

    const snapshot = createSnapshot();
    const gate = deferred();
    const harness = await createHarness({
      snapshot,
      rpcHandler(method) {

        if (method === 'getState') {
          return snapshot;
        }
        if (method === 'clearProxy') {
          return gate.promise;
        }
        return {ok: true};

      },
    });
    const clear = findButton(harness.root, 'Turn off extension proxy');
    const first = clear.onclick();
    const second = clear.onclick();
    expect(harness.calls.filter((call) => call.method === 'clearProxy'))
        .to.have.length(1);
    gate.resolve({ok: true, status: 'cleared'});
    await Promise.all([first, second]);

  });

  it('preserves a provider draft after field validation fails',
      async function() {

        const harness = await createHarness();
        const name = getInput(harness.root, 'newProvider.label');
        const urls = getInput(harness.root, 'newProvider.urls');
        name.value = 'Draft source';
        name.dispatch('input');
        urls.value = 'http://remote.example/private.pac?token=secret';
        urls.dispatch('input');
        await findButton(harness.root, 'Save and use').onclick();
        expect(name.value).to.equal('Draft source');
        expect(urls.value).to.include('token=secret');
        expect(urls.getAttribute('aria-invalid')).to.equal('true');
        expect(harness.calls.some((call) =>
          call.method === 'addCustomPacProvider',
        )).to.equal(false);

      });

  it('preserves a provider draft after a stale RPC rejection',
      async function() {

        const harness = await createHarness({
          rpcHandler(method) {

            if (method === 'getState') {
              return createSnapshot();
            }
            const error = new Error('Proxy credential state is stale.');
            error.code = 'RPC_FAILED';
            throw error;

          },
        });
        const name = getInput(harness.root, 'newProvider.label');
        const urls = getInput(harness.root, 'newProvider.urls');
        name.value = 'Preserved source';
        name.dispatch('input');
        urls.value = 'https://pac.example/proxy.pac';
        urls.dispatch('input');
        await findButton(harness.root, 'Save and use').onclick();
        expect(name.value).to.equal('Preserved source');
        expect(harness.root.textContent).to.include('older settings');

      });

  it('adds, selects, edits, and deletes custom providers explicitly',
      async function() {

        const snapshot = createSnapshot();
        const custom = {
          key: 'custom:one',
          label: 'Custom one',
          description: 'Private source',
          urls: ['https://pac.example/one.pac'],
          enabled: true,
          type: 'custom',
        };
        snapshot.providers.push(custom);
        const harness = await createHarness({
          snapshot,
          rpcHandler(method) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'addCustomPacProvider') {
              return {ok: true, provider: {key: 'custom:new'}};
            }
            if (method === 'updateCustomPacProvider') {
              return {ok: true, status: 'updated'};
            }
            if (method === 'deleteCustomPacProvider') {
              return {ok: true, selectedProviderCleared: false};
            }
            return {ok: true};

          },
        });
        const newName = getInput(harness.root, 'newProvider.label');
        const newUrls = getInput(harness.root, 'newProvider.urls');
        newName.value = 'New source';
        newName.dispatch('input');
        newUrls.value = 'https://pac.example/new.pac';
        newUrls.dispatch('input');
        await findButton(harness.root, 'Save and use').onclick();
        expect(harness.calls.map((call) => call.method)).to.include.members([
          'addCustomPacProvider',
          'setCurrentPacProvider',
        ]);
        const customName = getInput(
            harness.root,
            'provider.custom:one.label',
        );
        customName.value = 'Edited source';
        customName.dispatch('input');
        await findButton(harness.root, 'Save source').onclick();
        expect(harness.calls.some((call) =>
          call.method === 'updateCustomPacProvider' &&
          call.params.label === 'Edited source',
        )).to.equal(true);
        await findButton(harness.root, 'Delete source').onclick();
        expect(harness.calls.some((call) =>
          call.method === 'deleteCustomPacProvider' &&
          call.params.key === 'custom:one',
        )).to.equal(true);

      });

  it('warns and clears selection when deleting the selected source',
      async function() {

        const snapshot = createSnapshot();
        snapshot.providers = [{
          key: 'custom:selected',
          label: 'Selected custom',
          description: '',
          urls: ['https://pac.example/selected.pac'],
          enabled: true,
          type: 'custom',
        }];
        snapshot.state.currentPacProviderKey = 'custom:selected';
        let confirmation = '';
        const harness = await createHarness({
          snapshot,
          confirm(message) {

            confirmation = message;
            return true;

          },
          rpcHandler(method) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'deleteCustomPacProvider') {
              return {ok: true, selectedProviderCleared: true};
            }
            return {ok: true};

          },
        });
        await findButton(harness.root, 'Delete source').onclick();
        expect(confirmation).to.include('source selection will be cleared');
        expect(harness.calls.some((call) =>
          call.method === 'deleteCustomPacProvider',
        )).to.equal(true);

      });

  it('does not overwrite a dirty draft during a background refresh',
      async function() {

        const first = createSnapshot();
        const second = createSnapshot();
        second.state.pacMods.credentialRevision = 5;
        let current = first;
        const harness = await createHarness({
          rpcHandler(method) {

            if (method === 'getState') {
              return current;
            }
            return {ok: true};

          },
        });
        const pattern = getInput(harness.root, 'siteRule.pattern');
        pattern.value = 'draft.example';
        pattern.dispatch('input');
        current = second;
        harness.document.dispatch('visibilitychange');
        await flush();
        expect(pattern.value).to.equal('draft.example');
        expect(harness.root.textContent).to.include(
            'Saved settings changed while you were editing',
        );

      });

  it('marks a custom-source draft conflicted after a remote edit',
      async function() {

        const first = createSnapshot();
        first.providers.push({
          key: 'custom-1',
          label: 'Original source',
          description: '',
          urls: ['https://source.example/proxy.pac'],
          enabled: true,
          type: 'custom',
        });
        const second = createSnapshot();
        second.providers.push(Object.assign({}, first.providers[1], {
          label: 'Remote source',
        }));
        let current = first;
        const harness = await createHarness({
          rpcHandler(method) {

            return method === 'getState' ? current : {ok: true};

          },
        });
        const label = getInput(harness.root, 'provider.custom-1.label');
        label.value = 'Local source';
        label.dispatch('input');
        current = second;
        harness.dispatchStorageChange();
        await flush();
        expect(label.value).to.equal('Local source');
        expect(harness.root.textContent).to.include(
            'Saved settings changed while you were editing',
        );

      });

  it('preserves a stale PAC draft across section navigation',
      async function() {

        const snapshot = createSnapshot();
        const harness = await createHarness({
          snapshot,
          rpcHandler(method) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'setPacMods') {
              const error = new Error('Proxy credential state is stale.');
              error.code = 'RPC_FAILED';
              throw error;
            }
            return {ok: true};

          },
        });
        const host = getInput(harness.root, 'localTor.host');
        host.value = 'stale-draft.example';
        host.dispatch('input');
        harness.location.hash = '#diagnostics';
        harness.context.window.dispatch('hashchange');
        await findButton(harness.root, 'Save proxy settings').onclick();
        harness.location.hash = '#proxy-methods';
        harness.context.window.dispatch('hashchange');
        expect(getInput(harness.root, 'localTor.host').value)
            .to.equal('stale-draft.example');
        expect(harness.root.textContent).to.include('older settings');

      });

  it('updates the baseline after a successful site-rule save',
      async function() {

        const snapshot = createSnapshot();
        const harness = await createHarness({
          snapshot,
          rpcHandler(method, params) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'setPacMods') {
              snapshot.state.pacMods = params.pacMods;
              snapshot.state.pacMods.credentialRevision += 1;
              return {ok: true};
            }
            return {ok: true};

          },
        });
        const pattern = getInput(harness.root, 'siteRule.pattern');
        pattern.value = 'new.example';
        pattern.dispatch('input');
        await findButton(harness.root, 'Add rule').onclick();
        expect(harness.calls.some((call) =>
          call.method === 'setPacMods' &&
          call.params.pacMods.exceptions.some((rule) =>
            rule.pattern === 'new.example',
          ),
        )).to.equal(true);
        expect(harness.root.textContent).not.to.include(
            'section has unsaved changes',
        );

      });

  it('normalizes an internationalized site scope without losing the draft',
      async function() {

        const snapshot = createSnapshot();
        const harness = await createHarness({snapshot});
        const pattern = getInput(harness.root, 'siteRule.pattern');
        pattern.value = 'пример.рф';
        pattern.dispatch('input');
        expect(harness.root.textContent).to.include(
            'xn--e1afmkfd.xn--p1ai',
        );
        await findButton(harness.root, 'Add rule').onclick();
        const save = harness.calls.find((call) =>
          call.method === 'setPacMods',
        );
        expect(save.params.pacMods.exceptions.some((rule) =>
          rule.pattern === 'xn--e1afmkfd.xn--p1ai',
        )).to.equal(true);

      });

  it('edits and removes one site rule without changing unrelated rules',
      async function() {

        const snapshot = createSnapshot();
        snapshot.state.pacMods.exceptions.push({
          pattern: 'keep.example',
          action: 'DIRECT',
          enabled: true,
          note: '',
        });
        const saved = [];
        const harness = await createHarness({
          snapshot,
          rpcHandler(method, params) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'setPacMods') {
              saved.push(params.pacMods);
              return {ok: true};
            }
            return {ok: true};

          },
        });
        const action = getInput(
            harness.root,
            'site-rule:0:proxy.example.action',
        );
        action.value = 'DIRECT';
        action.dispatch('change');
        await findButton(harness.root, 'Save rule').onclick();
        expect(saved[0].exceptions[0].action).to.equal('DIRECT');
        expect(saved[0].exceptions[1].pattern).to.equal('keep.example');
        await findButton(harness.root, 'Remove rule').onclick();
        expect(saved[1].exceptions).to.deep.equal([{
          pattern: 'keep.example',
          action: 'DIRECT',
          enabled: true,
          note: '',
        }]);

      });

  it('prevents duplicate site-rule mutations while one is pending',
      async function() {

        const gate = deferred();
        const snapshot = createSnapshot();
        const harness = await createHarness({
          snapshot,
          rpcHandler(method) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'setPacMods') {
              return gate.promise;
            }
            return {ok: true};

          },
        });
        const pattern = getInput(harness.root, 'siteRule.pattern');
        pattern.value = 'pending.example';
        pattern.dispatch('input');
        const add = findButton(harness.root, 'Add rule');
        const first = add.onclick();
        const second = add.onclick();
        expect(harness.calls.filter((call) =>
          call.method === 'setPacMods',
        )).to.have.length(1);
        gate.resolve({ok: true});
        await Promise.all([first, second]);

      });

  it('keeps a large site-rule list deterministic and filterable',
      async function() {

        const snapshot = createSnapshot();
        snapshot.state.pacMods.exceptions = Array.from(
            {length: 400},
            (unused, index) => ({
              pattern: `site-${String(index).padStart(3, '0')}.example`,
              action: index % 2 ? 'DIRECT' : 'PROXY',
              enabled: true,
              note: `Rule ${index}`,
            }),
        );
        const harness = await createHarness({snapshot});
        const section = getSection(harness.root, 'site-rules');
        const rows = section.querySelectorAll('[data-rule-search]');
        expect(rows).to.have.length(400);
        expect(rows.map((row) => row.dataset.ruleSearch))
            .to.deep.equal(rows.map((row) => row.dataset.ruleSearch).sort());
        const filter = getInput(section, 'siteRule.filter');
        filter.value = 'site-399.example';
        filter.dispatch('input');
        expect(rows.filter((row) => !row.hidden)).to.have.length(1);
        expect(rows.find((row) => !row.hidden).dataset.ruleSearch)
            .to.include('site-399.example');

      });

  it('uses explicit password preservation without rendering a password',
      async function() {

        const snapshot = createSnapshot();
        const credentialRef = {
          index: 0,
          revision: 4,
          type: 'HTTPS',
          host: 'proxy.example',
          port: 443,
          username: 'proxy-user',
        };
        snapshot.state.pacMods.ownProxies = [{
          enabled: true,
          type: 'HTTPS',
          host: 'proxy.example',
          port: 443,
          username: 'proxy-user',
          hasPassword: true,
          credentialRef,
          note: '',
        }];
        const harness = await createHarness({snapshot});
        const username = getInput(harness.root, 'proxy.username');
        const password = getInput(harness.root, 'proxy.password');
        expect(password.type).to.equal('password');
        expect(password.value).to.equal('');
        expect(password.autocomplete).to.equal('new-password');
        expect(harness.root.textContent).not.to.include('***');
        username.value = 'updated-user';
        username.dispatch('input');
        await findButton(harness.root, 'Save proxy settings').onclick();
        const save = harness.calls.find((call) => call.method === 'setPacMods');
        expect(save.params.pacMods.ownProxies[0]).to.include({
          password: '***',
          hasPassword: true,
          username: 'updated-user',
        });
        expect(save.params.pacMods.ownProxies[0].credentialRef)
            .to.deep.equal(credentialRef);

      });

  it('supports explicit password replacement and removal intents',
      async function() {

        const snapshot = createSnapshot();
        snapshot.state.pacMods.ownProxies = [{
          enabled: true,
          type: 'HTTPS',
          host: 'proxy.example',
          port: 443,
          username: 'proxy-user',
          hasPassword: true,
          credentialRef: {
            index: 0,
            revision: 4,
            type: 'HTTPS',
            host: 'proxy.example',
            port: 443,
            username: 'proxy-user',
          },
          note: '',
        }];
        const harness = await createHarness({snapshot});
        const mode = getInput(harness.root, 'proxy.passwordMode');
        const password = getInput(harness.root, 'proxy.password');
        mode.value = 'replace';
        mode.dispatch('change');
        password.value = 'synthetic replacement';
        password.dispatch('input');
        await findButton(harness.root, 'Save proxy settings').onclick();
        const save = harness.calls.find((call) => call.method === 'setPacMods');
        expect(save.params.pacMods.ownProxies[0].password)
            .to.equal('synthetic replacement');
        expect(save.params.pacMods.ownProxies[0]).not.to.have.property(
            'credentialRef',
        );
        expect(getInput(harness.root, 'proxy.password').value).to.equal('');

        const removalSnapshot = createSnapshot();
        removalSnapshot.state.pacMods.ownProxies = JSON.parse(JSON.stringify(
            snapshot.state.pacMods.ownProxies,
        ));
        const removal = await createHarness({snapshot: removalSnapshot});
        const removeMode = getInput(removal.root, 'proxy.passwordMode');
        removeMode.value = 'remove';
        removeMode.dispatch('change');
        await findButton(removal.root, 'Save proxy settings').onclick();
        const removalSave = removal.calls.find((call) =>
          call.method === 'setPacMods',
        );
        expect(removalSave.params.pacMods.ownProxies[0].password).to.equal('');
        expect(removalSave.params.pacMods.ownProxies[0]).not.to.have.property(
            'credentialRef',
        );
        expect(removalSave.params.pacMods.ownProxies[0]).not.to.have.property(
            'hasPassword',
        );

      });

  it('reorders own proxies with keyboard-operable buttons',
      async function() {

        const snapshot = createSnapshot();
        snapshot.state.pacMods.ownProxies = [
          {
            enabled: true,
            type: 'HTTPS',
            host: 'first.example',
            port: 443,
            username: '',
            hasPassword: false,
            note: '',
          },
          {
            enabled: true,
            type: 'HTTPS',
            host: 'second.example',
            port: 443,
            username: '',
            hasPassword: false,
            note: '',
          },
        ];
        const harness = await createHarness({snapshot});
        const up = harness.root.querySelectorAll('[data-proxy-move="up"]');
        const down = harness.root.querySelectorAll(
            '[data-proxy-move="down"]',
        );
        expect(up[0].disabled).to.equal(true);
        expect(down[1].disabled).to.equal(true);
        down[0].onclick();
        await findButton(harness.root, 'Save proxy settings').onclick();
        const save = harness.calls.find((call) =>
          call.method === 'setPacMods',
        );
        expect(save.params.pacMods.ownProxies.map((proxy) => proxy.host))
            .to.deep.equal(['second.example', 'first.example']);

      });

  it('requires a password decision when a credential endpoint changes',
      async function() {

        const snapshot = createSnapshot();
        snapshot.state.pacMods.ownProxies = [{
          enabled: true,
          type: 'HTTPS',
          host: 'proxy.example',
          port: 443,
          username: 'proxy-user',
          hasPassword: true,
          credentialRef: {
            index: 0,
            revision: 4,
            type: 'HTTPS',
            host: 'proxy.example',
            port: 443,
            username: 'proxy-user',
          },
          note: '',
        }];
        const harness = await createHarness({snapshot});
        const host = getInput(harness.root, 'proxy.host');
        host.value = 'new-proxy.example';
        host.dispatch('input');
        await findButton(harness.root, 'Save proxy settings').onclick();
        const mode = getInput(harness.root, 'proxy.passwordMode');
        expect(mode.getAttribute('aria-invalid')).to.equal('true');
        expect(harness.calls.some((call) => call.method === 'setPacMods'))
            .to.equal(false);

      });

  it('discards dirty drafts only after explicit confirmation',
      async function() {

        let confirmations = 0;
        const harness = await createHarness({
          confirm() {

            confirmations += 1;
            return true;

          },
        });
        const name = getInput(harness.root, 'newProvider.label');
        name.value = 'Discard me';
        name.dispatch('input');
        await findButton(harness.root, 'Discard all').onclick();
        expect(confirmations).to.equal(1);
        expect(getInput(harness.root, 'newProvider.label').value).to.equal('');
        expect(harness.calls.map((call) => call.method)).to.deep.equal([
          'getState',
        ]);

      });

  it('preserves migration choices across refresh and discards explicitly',
      async function() {

        const first = createSnapshot();
        const second = createSnapshot();
        second.state.legacyMigration = {
          auditStatus: 'success',
          lastAuditAt: Date.now(),
          detectedLegacyData: true,
        };
        let current = first;
        const plan = {
          proposedMigration: {
            canMigrate: {
              currentPacProviderKey: {available: true},
            },
          },
        };
        const harness = await createHarness({
          snapshot: first,
          rpcHandler(method) {

            if (method === 'getState') {
              return current;
            }
            if (method === 'runLegacyMigrationAudit') {
              return plan;
            }
            return {ok: true};

          },
        });
        await findButton(harness.root, 'Scan legacy MV2 settings').onclick();
        const strategy = getInput(harness.root, 'migration.strategy');
        const confirm = getInput(harness.root, 'migration.confirm');
        strategy.value = 'overwriteSelected';
        strategy.dispatch('change');
        confirm.checked = true;
        confirm.dispatch('change');
        current = second;
        harness.dispatchStorageChange();
        await flush();
        expect(getInput(harness.root, 'migration.strategy').value)
            .to.equal('overwriteSelected');
        expect(getInput(harness.root, 'migration.confirm').checked)
            .to.equal(true);
        expect(harness.root.textContent).to.include(
            'Saved settings changed while you were editing',
        );
        await findButton(harness.root, 'Discard all').onclick();
        expect(getInput(harness.root, 'migration.strategy').value)
            .to.equal('fillMissing');
        expect(getInput(harness.root, 'migration.confirm').checked)
            .to.equal(false);
        const acceptedConfirm = getInput(harness.root, 'migration.confirm');
        acceptedConfirm.checked = true;
        acceptedConfirm.dispatch('change');
        await findButton(harness.root, 'Apply selected migration').onclick();
        expect(harness.calls.some((call) =>
          call.method === 'applyLegacyMigration',
        )).to.equal(true);
        expect(getInput(harness.root, 'migration.confirm')).to.equal(null);

      });

  it('renders hostile text as text and keeps diagnostics redacted',
      async function() {

        const snapshot = createSnapshot();
        snapshot.providers.push({
          key: 'custom:hostile',
          label: '<img src=x onerror=alert(1)>',
          description: '<script>bad()</script>',
          urls: ['https://pac.example/private.pac?token=private'],
          enabled: true,
          type: 'custom',
        });
        snapshot.state.currentPacProviderKey = 'custom:hostile';
        snapshot.state.pacMods.ownProxies = [{
          enabled: true,
          type: 'HTTPS',
          host: '<svg/onload=host()>',
          port: 443,
          username: '"><img src=x onerror=user()>',
          hasPassword: false,
          note: '<script>note()</script>',
        }];
        const harness = await createHarness({
          snapshot,
          rpcHandler(method) {

            if (method === 'getState') {
              return snapshot;
            }
            if (method === 'checkProxyHealth') {
              throw new Error(
                  'https://private.example/pac?token=synthetic-secret',
              );
            }
            return {ok: true};

          },
        });
        expect(harness.root.querySelectorAll('script')).to.have.length(0);
        expect(getInput(harness.root, 'proxy.host').value)
            .to.equal('<svg/onload=host()>');
        expect(getInput(harness.root, 'proxy.username').value)
            .to.equal('"><img src=x onerror=user()>');
        const diagnostics = getSection(harness.root, 'diagnostics');
        expect(harness.root.textContent).to.include(
            '<img src=x onerror=alert(1)>',
        );
        expect(diagnostics.textContent).not.to.include('token=private');
        expect(diagnostics.textContent).not.to.include('hidden');
        expect(diagnostics.textContent).not.to.match(/artifact(?:Ref|:)/i);
        expect(diagnostics.textContent).not.to.match(/sha-?256/i);
        await findButton(harness.root, 'Check proxy').onclick();
        expect(harness.root.textContent).not.to.include('synthetic-secret');
        expect(harness.document.title).not.to.include('synthetic-secret');

      });

  it('keeps a newer refresh when an older response resolves last',
      async function() {

        const oldGate = deferred();
        const initial = createSnapshot();
        const old = createSnapshot();
        old.providers[0].label = 'Old source';
        const newer = createSnapshot();
        newer.providers[0].label = 'Newer source';
        let calls = 0;
        const harness = await createHarness({
          rpcHandler(method) {

            if (method !== 'getState') {
              return {ok: true};
            }
            calls += 1;
            if (calls === 1) {
              return initial;
            }
            return calls === 2 ? oldGate.promise : newer;

          },
        });
        harness.document.dispatch('visibilitychange');
        harness.document.dispatch('visibilitychange');
        await flush();
        expect(harness.root.textContent).to.include('Newer source');
        oldGate.resolve(old);
        await flush();
        expect(harness.root.textContent).to.include('Newer source');
        expect(harness.root.textContent).not.to.include('Old source');

      });

  it('recovers from a worker restart without writing or losing the page',
      async function() {

        const snapshot = createSnapshot();
        let reads = 0;
        const harness = await createHarness({
          rpcHandler(method) {

            if (method === 'getState') {
              reads += 1;
              if (reads === 1) {
                throw new Error('Worker stopped');
              }
              return snapshot;
            }
            return {ok: true};

          },
        });
        expect(harness.root.textContent).to.include('Could not load settings');
        await findButton(harness.root, 'Retry').onclick();
        await flush();
        expect(harness.root.textContent).to.include('Overview');
        expect(harness.calls.map((call) => call.method)).to.deep.equal([
          'getState',
          'getState',
        ]);

      });

  it('installs global listeners once and warns on unsaved page exit',
      async function() {

        const harness = await createHarness();
        expect(harness.document.listenerCount('visibilitychange')).to.equal(1);
        expect(harness.listenerCounts).to.deep.equal({
          storage: 1,
          proxy: 1,
        });
        const routingLink = harness.root.querySelector(
            '.options-nav a[data-section="routing-sources"]',
        );
        routingLink.focus();
        harness.dispatchStorageChange();
        await flush();
        expect(harness.document.activeElement.dataset.focusKey)
            .to.equal('nav-routing-sources');
        const controlButton = findButton(
            harness.root,
            'Turn off extension proxy',
        );
        controlButton.focus();
        harness.dispatchProxyChange();
        await flush();
        expect(harness.document.activeElement.textContent)
            .to.equal('Turn off extension proxy');
        const name = getInput(harness.root, 'newProvider.label');
        name.value = 'Unsaved';
        name.dispatch('input');
        const live = harness.root.querySelector('[aria-live="polite"]');
        expect(live.textContentWrites).to.equal(1);
        name.value = 'Unsaved again';
        name.dispatch('input');
        expect(live.textContentWrites).to.equal(1);
        name.value = '';
        name.dispatch('input');
        expect(live.textContent).to.equal('');
        expect(live.textContentWrites).to.equal(2);
        name.value = 'Unsaved';
        name.dispatch('input');
        let prevented = false;
        const event = {
          preventDefault() {

            prevented = true;

          },
          returnValue: null,
        };
        harness.context.window.dispatch('beforeunload', event);
        expect(prevented).to.equal(true);
        expect(event.returnValue).to.equal('');
        harness.dispatchStorageChange();
        harness.dispatchStorageChange();
        await flush();
        expect(harness.document.listenerCount('visibilitychange')).to.equal(1);
        expect(harness.listenerCounts).to.deep.equal({
          storage: 1,
          proxy: 1,
        });

      });

  it('keeps English and Russian options localization complete', function() {

    const keys = Array.from(OPTIONS_SOURCE.matchAll(
        /['"]((?:options|popup|provider|proxyHealth|migrationField)[A-Z][A-Za-z0-9]+)['"]/g,
    ))
        .map((match) => match[1]);
    const enKeys = Object.keys(CATALOGS.en).sort();
    const ruKeys = Object.keys(CATALOGS.ru).sort();
    expect(ruKeys).to.deep.equal(enKeys);
    expect(keys.filter((key) => !CATALOGS.en[key])).to.deep.equal([]);
    expect(keys.filter((key) => !CATALOGS.ru[key])).to.deep.equal([]);
    enKeys.forEach((key) => {
      const enPlaceholders = Object.keys(
          CATALOGS.en[key].placeholders || {},
      ).sort();
      const ruPlaceholders = Object.keys(
          CATALOGS.ru[key].placeholders || {},
      ).sort();
      expect(ruPlaceholders, key).to.deep.equal(enPlaceholders);
    });
    expect(CATALOGS.ru.optionsPageSubtitle.message)
        .not.to.match(/[A-Za-z]{4,}/);

  });

  it('renders natural Russian navigation and long task labels',
      async function() {

        const snapshot = createSnapshot();
        snapshot.state.uiLanguage = 'ru';
        const harness = await createHarness({language: 'ru', snapshot});
        expect(harness.root.textContent).to.include('Источники правил');
        expect(harness.root.textContent).to.include(
            'Обновления и проверка',
        );
        expect(harness.root.textContent).to.include(
            'Ограниченная бета-версия MV3',
        );
        expect(harness.root.textContent).to.include(
            'Сообщить о проблеме',
        );
        expect(
            harness.root.textContent.includes('Применить конфигурацию') ||
            harness.root.textContent.includes('Выключить прокси расширения'),
        ).to.equal(true);
        expect(harness.root.textContent).not.to.include(
            'Routing sources',
        );

      });

  it('associates navigation, sections, fields, and errors accessibly',
      async function() {

        const harness = await createHarness();
        expect(OPTIONS_HTML).to.include('<main id="app-root"');
        expect(OPTIONS_SOURCE).not.to.match(
            /setAttribute\('role', 'main'\)/,
        );
        const nav = harness.root.querySelector('nav');
        expect(nav.getAttribute('aria-label')).to.equal('Settings sections');
        const section = getSection(harness.root, 'site-rules');
        expect(section.getAttribute('aria-labelledby'))
            .to.equal('site-rules-heading');
        const pattern = getInput(harness.root, 'siteRule.pattern');
        expect(pattern.parentNode.tagName).to.equal('LABEL');
        expect(pattern.getAttribute('aria-describedby')).to.be.a('string');
        await findButton(harness.root, 'Add rule').onclick();
        expect(pattern.getAttribute('aria-invalid')).to.equal('true');
        expect(pattern.getAttribute('aria-describedby')).to.include('-error');
        const details = harness.root.querySelector('details');
        expect(details.querySelector('summary')).to.exist;
        const mobile = harness.root.querySelector('#options-section-select');
        expect(mobile.parentNode.tagName).to.equal('LABEL');

      });

  it('uses shared tokens and responsive accessible navigation', function() {

    expect(OPTIONS_HTML).to.include('../shared/ui-tokens.css');
    expect(OPTIONS_HTML).to.include('name="viewport"');
    expect(OPTIONS_CSS).to.include('@media (max-width: 900px)');
    expect(OPTIONS_CSS).to.include('@media (forced-colors: active)');
    expect(OPTIONS_CSS).to.include('@media (prefers-reduced-motion: reduce)');
    expect(OPTIONS_CSS).not.to.match(/#[0-9a-f]{3,8}/i);
    expect(UI_TOKENS).to.include('--ui-color-accent-surface:');
    expect(OPTIONS_CSS).to.include('var(--ui-color-accent-surface)');
    expect(POPUP_CSS).to.include('var(--ui-color-accent)');
    expect(POPUP_CSS).to.include('@media (forced-colors: active)');
    expect(POPUP_CSS).not.to.include('--ui-color-accent-surface:');

  });

});
