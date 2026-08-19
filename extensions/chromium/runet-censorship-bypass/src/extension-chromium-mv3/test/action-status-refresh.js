'use strict';


const Chai = require('chai');
const Mocha = require('mocha');
const {loadBackgroundModules} = require('./background-modules');

const TEST_EXTENSION_ID = 'action-status-test';
const TEST_EXTENSION_ORIGIN = `chrome-extension://${TEST_EXTENSION_ID}`;
const TOOLBAR_ICON_SIZES = [16, 19, 20, 32, 38];

function getAbsoluteIconPath(pathname) {

  return `${TEST_EXTENSION_ORIGIN}/${pathname}`;

}

function getAbsoluteIconMap(variant, ifLarge = false) {

  const sizes = ifLarge ? TOOLBAR_ICON_SIZES.concat([48, 128]) :
    TOOLBAR_ICON_SIZES;
  return sizes.reduce((paths, size) => {
    paths[size] = getAbsoluteIconPath(`icons/action-${variant}-${size}.png`);
    return paths;
  }, {});

}

function createEvent() {

  const listeners = new Set();
  return {
    addListener(listener) {

      listeners.add(listener);

    },
    dispatch(...args) {

      listeners.forEach((listener) => listener(...args));

    },
  };

}

function waitForRefresh() {

  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

}

function createHarness(options = {}) {

  const events = {
    activated: createEvent(),
    updated: createEvent(),
    removed: createEvent(),
    replaced: createEvent(),
    focusChanged: createEvent(),
  };
  const tabs = new Map([
    [1, {id: 1, windowId: 10, active: true, url: 'https://alpha.example/'}],
    [2, {id: 2, windowId: 10, active: false, url: 'https://beta.example/'}],
  ]);
  const calls = [];
  const statusUrls = [];
  const counts = {
    runtimeErrorReads: 0,
    runtimeUrlResolutions: 0,
    stateReads: 0,
    tabQueries: 0,
    tabGets: 0,
    statusBuilds: 0,
  };
  let runtimeLastError = null;
  const runtime = {id: TEST_EXTENSION_ID};
  Object.defineProperty(runtime, 'lastError', {
    get() {

      ++counts.runtimeErrorReads;
      return runtimeLastError;

    },
  });
  if (options.runtimeGetURL !== null) {
    runtime.getURL = (pathname) => {
      ++counts.runtimeUrlResolutions;
      return typeof options.runtimeGetURL === 'function' ?
        options.runtimeGetURL(pathname) :
        getAbsoluteIconPath(pathname);
    };
  }
  let state = Object.assign({
    mode: 'auto',
    proxyApplied: true,
    controlledByThisExtension: true,
    pacDownloaded: true,
    pacCooked: true,
  }, options.state);
  let focusedWindowId = 10;
  const actionFailures = Object.assign(
      {setIcon: options.iconFailures || 0},
      options.actionFailures,
  );
  const promiseActionFailures = Object.assign(
      {},
      options.promiseActionFailures,
  );
  let ifHoldActionCallbacks = false;
  const heldActionCallbacks = [];
  const appliedActionState = {};
  const action = {};
  const actionMethods = [
    'setIcon',
    'setBadgeText',
    'setBadgeBackgroundColor',
    'setBadgeTextColor',
    'setTitle',
  ].filter((method) =>
    method !== 'setBadgeTextColor' ||
    options.badgeTextColorSupported !== false,
  );
  actionMethods.forEach((method) => {
    if (Object.prototype.hasOwnProperty.call(promiseActionFailures, method)) {
      action[method] = (params) => {
        calls.push({method, params});
        if (promiseActionFailures[method] > 0) {
          --promiseActionFailures[method];
          return Promise.reject(new Error(`Failed to call ${method}`));
        }
        appliedActionState[method] = params;
        return Promise.resolve();
      };
      return;
    }
    action[method] = (params, callback) => {
      calls.push({method, params});
      const complete = () => {
        if (actionFailures[method] > 0) {
          --actionFailures[method];
          runtimeLastError = {
            message: `Failed to call ${method}`,
          };
          callback();
          runtimeLastError = null;
          return;
        }
        appliedActionState[method] = params;
        callback();
      };
      if (ifHoldActionCallbacks) {
        heldActionCallbacks.push(complete);
      } else {
        complete();
      }
    };
  });
  const chromeApi = {
    action,
    runtime,
    tabs: {
      onActivated: events.activated,
      onUpdated: events.updated,
      onRemoved: events.removed,
      onReplaced: events.replaced,
      get(tabId, callback) {

        ++counts.tabGets;
        callback(tabs.get(tabId) || null);

      },
      query(query, callback) {

        ++counts.tabQueries;
        const windowId = Number.isInteger(query.windowId) ?
          query.windowId :
          focusedWindowId;
        callback(Array.from(tabs.values()).filter((tab) =>
          tab.active && tab.windowId === windowId,
        ));

      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.focusChanged,
    },
  };
  const defaultCreateStatus = (url, snapshot) => ({
    host: new URL(url).hostname,
    controllable: true,
    mode: snapshot.mode,
    proxyApplied: snapshot.proxyApplied === true &&
      snapshot.controlledByThisExtension === true,
    proxyControl: {
      controlsPac: snapshot.proxyApplied === true &&
        snapshot.controlledByThisExtension === true,
      controlledByThisExtension:
        snapshot.controlledByThisExtension === true,
      canControl: snapshot.controlledByThisExtension === true,
      levelOfControl: snapshot.controlledByThisExtension === true ?
        (
          snapshot.proxyApplied === true ?
            'controlled_by_this_extension' :
            'controllable_by_this_extension'
        ) :
        'controlled_by_other_extensions',
    },
    pacDownloaded: snapshot.pacDownloaded === true,
    pacCooked: snapshot.pacCooked === true,
    pacStale: snapshot.pacStale === true,
    selectedProvider: 'test-provider',
    proxyHealth: snapshot.proxyHealth || {status: 'unknown'},
    autoUpdate: snapshot.autoUpdate || {status: 'scheduled'},
  });
  const createStatus = options.createStatus || defaultCreateStatus;
  const coordinator = global.mv3ActionStatus.createRefreshCoordinator({
    chromeApi,
    async loadState() {

      ++counts.stateReads;
      return state;

    },
    async createStatus(url, snapshot) {

      ++counts.statusBuilds;
      statusUrls.push(url);
      return createStatus(url, snapshot, defaultCreateStatus);

    },
  });

  return {
    calls,
    chromeApi,
    coordinator,
    counts,
    events,
    appliedActionState,
    statusUrls,
    tabs,
    async start() {

      coordinator.start();
      if (options.refreshOnStart !== false) {
        return coordinator.requestRefresh({});
      }
      return undefined;

    },
    activate(tabId) {

      const tab = tabs.get(tabId);
      Array.from(tabs.values()).forEach((item) => {
        if (item.windowId === tab.windowId) {
          item.active = false;
        }
      });
      tab.active = true;
      focusedWindowId = tab.windowId;
      events.activated.dispatch({tabId, windowId: tab.windowId});

    },
    focusWindow(windowId) {

      focusedWindowId = windowId;
      events.focusChanged.dispatch(windowId);

    },
    setState(patch) {

      state = Object.assign({}, state, patch);
      return state;

    },
    updateTab(tabId, changeInfo) {

      const tab = tabs.get(tabId);
      if (changeInfo.url) {
        tab.url = changeInfo.url;
      }
      events.updated.dispatch(tabId, changeInfo, Object.assign({}, tab));

    },
    holdActionCallbacks() {

      ifHoldActionCallbacks = true;

    },
    releaseActionCallbacks() {

      ifHoldActionCallbacks = false;
      heldActionCallbacks.splice(0).forEach((complete) => complete());

    },
  };

}

Mocha.describe('MV3 active-tab action status refresh', function() {

  Mocha.beforeEach(function() {

    loadBackgroundModules();

  });

  Mocha.it('refreshes the icon and title when a tab is activated', async function() {

    const harness = createHarness();
    await harness.start();
    harness.calls.length = 0;

    harness.activate(2);
    await waitForRefresh();

    Chai.expect(harness.calls).to.deep.include({
      method: 'setIcon',
      params: {
        path: getAbsoluteIconMap('active', true),
        tabId: 2,
      },
    });
    const title = harness.calls.find((call) => call.method === 'setTitle');
    Chai.expect(title.params).to.include({tabId: 2});
    Chai.expect(title.params.title).to.include('Current site: Auto');
    Chai.expect(title.params.title).to.not.include('beta.example');

  });

  Mocha.it('reapplies the complete presentation after same-tab navigation',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;

        harness.updateTab(1, {url: 'https://changed.example/path'});
        await waitForRefresh();

        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ]);
        Chai.expect(harness.calls.find((call) => call.method === 'setIcon'))
            .to.deep.equal({
              method: 'setIcon',
              params: {
                path: getAbsoluteIconMap('active', true),
                tabId: 1,
              },
            });
        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('Current site: Auto');
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://changed.example/path');

      });

  Mocha.it('reapplies the complete presentation after a same-URL reload',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;

        harness.updateTab(1, {status: 'complete'});
        await waitForRefresh();

        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ]);
        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('Current site: Auto');

      });

  Mocha.it('deduplicates unchanged status after navigation reapplication',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;

        harness.updateTab(1, {url: 'https://changed.example/path'});
        await waitForRefresh();
        Chai.expect(harness.calls).to.have.length(5);
        harness.calls.length = 0;

        await harness.coordinator.requestRefresh({state: harness.setState({})});

        Chai.expect(harness.calls).to.deep.equal([]);

      });

  Mocha.it('ignores URL updates from background tabs', async function() {

    const harness = createHarness();
    await harness.start();
    harness.calls.length = 0;
    const readsBefore = harness.counts.stateReads;

    harness.updateTab(2, {url: 'https://background.example/'});
    await waitForRefresh();

    Chai.expect(harness.calls).to.deep.equal([]);
    Chai.expect(harness.counts.stateReads).to.equal(readsBefore);

  });

  Mocha.it('prevents a slow old-tab refresh from overwriting a newer tab',
      async function() {

        let releaseOld;
        let markOldStarted;
        const oldStarted = new Promise((resolve) => {
          markOldStarted = resolve;
        });
        const oldStatus = new Promise((resolve) => {
          releaseOld = resolve;
        });
        const harness = createHarness({
          refreshOnStart: false,
          createStatus(url, snapshot, fallback) {

            if (url.includes('alpha.example')) {
              markOldStarted();
              return oldStatus;
            }
            return fallback(url, snapshot);

          },
        });
        await harness.start();
        harness.activate(1);
        await oldStarted;

        harness.activate(2);
        await waitForRefresh();
        Chai.expect(harness.calls.some((call) =>
          call.params.tabId === 2 && call.method === 'setTitle',
        )).to.equal(true);
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://beta.example/');

        releaseOld({
          host: 'alpha.example',
          controllable: true,
          mode: 'proxy',
          proxyApplied: true,
        });
        await waitForRefresh();
        Chai.expect(harness.calls.some((call) => call.params.tabId === 1))
            .to.equal(false);

      });

  Mocha.it('rejects slow pre-navigation work after the active URL changes',
      async function() {

        let releaseOld;
        let markOldStarted;
        const oldStarted = new Promise((resolve) => {
          markOldStarted = resolve;
        });
        const oldStatus = new Promise((resolve) => {
          releaseOld = resolve;
        });
        const harness = createHarness({
          refreshOnStart: false,
          createStatus(url, snapshot, fallback) {

            if (url.includes('alpha.example')) {
              markOldStarted();
              return oldStatus;
            }
            return fallback(url, snapshot);

          },
        });
        await harness.start();
        const oldRefresh = harness.coordinator.requestRefresh({});
        await oldStarted;

        harness.updateTab(1, {url: 'https://post-navigation.example/'});
        await waitForRefresh();
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setTitle' && call.params.tabId === 1,
        )).to.be.an('object');
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://post-navigation.example/');

        const callCount = harness.calls.length;
        releaseOld({
          host: 'alpha.example',
          controllable: true,
          mode: 'proxy',
          proxyApplied: true,
        });
        await oldRefresh;
        Chai.expect(harness.calls).to.have.length(callCount);

      });

  Mocha.it('refreshes Auto, Proxy, and Direct site-rule changes immediately',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;
        const readsBefore = harness.counts.stateReads;

        for (const mode of ['proxy', 'direct', 'auto']) {
          const state = harness.setState({mode});
          await harness.coordinator.requestRefresh({state});
        }

        Chai.expect(harness.calls.filter((call) =>
          call.method === 'setBadgeText',
        ).map((call) => call.params.text)).to.deep.equal(['P', 'D', 'A']);
        Chai.expect(harness.counts.stateReads).to.equal(readsBefore);

      });

  Mocha.it('refreshes the icon after PAC apply and clear state changes',
      async function() {

        const harness = createHarness({state: {proxyApplied: false}});
        await harness.start();
        harness.calls.length = 0;

        let state = harness.setState({proxyApplied: true});
        await harness.coordinator.requestRefresh({state});
        state = harness.setState({proxyApplied: false});
        await harness.coordinator.requestRefresh({state});

        Chai.expect(harness.calls.filter((call) =>
          call.method === 'setIcon',
        ).map((call) => call.params.path)).to.deep.equal([
          getAbsoluteIconMap('active', true),
          getAbsoluteIconMap('off'),
        ]);

      });

  Mocha.it('refreshes status after external proxy control changes', async function() {

    const harness = createHarness();
    await harness.start();
    harness.calls.length = 0;

    const state = harness.setState({controlledByThisExtension: false});
    await harness.coordinator.requestRefresh({state});

    Chai.expect(harness.calls).to.deep.include({
      method: 'setIcon',
      params: {
        path: getAbsoluteIconMap('external'),
        tabId: 1,
      },
    });
    Chai.expect(harness.calls).to.deep.include({
      method: 'setBadgeText',
      params: {text: 'EXT', tabId: 1},
    });

  });

  Mocha.it('restores active-tab status when the worker coordinator starts',
      async function() {

        const harness = createHarness();
        await harness.start();

        Chai.expect(harness.counts.tabQueries).to.equal(1);
        Chai.expect(harness.counts.stateReads).to.equal(1);
        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ]);
        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('Current site: Auto');

      });

  Mocha.it('resolves dynamic Action icons through runtime.getURL',
      async function() {

        const harness = createHarness();
        await harness.start();

        Chai.expect(harness.counts.runtimeUrlResolutions).to.equal(7);
        Chai.expect(harness.calls.find((call) => call.method === 'setIcon'))
            .to.deep.equal({
              method: 'setIcon',
              params: {
                path: getAbsoluteIconMap('active', true),
                tabId: 1,
              },
            });

      });

  Mocha.it('does not repeat identical action API calls', async function() {

    const harness = createHarness();
    await harness.start();
    harness.calls.length = 0;

    await harness.coordinator.requestRefresh({state: harness.setState({})});

    Chai.expect(harness.calls).to.deep.equal([]);

  });

  Mocha.it('keeps deterministic property-level Action API call counts',
      async function() {

        const harness = createHarness();
        await harness.start();
        Chai.expect(harness.calls).to.have.length(5);
        harness.calls.length = 0;

        await harness.coordinator.requestRefresh({
          state: harness.setState({}),
        });
        Chai.expect(harness.calls, 'identical refresh').to.have.length(0);

        harness.activate(2);
        await waitForRefresh();
        Chai.expect(harness.calls, 'first same-state tab').to.have.length(5);
        harness.calls.length = 0;
        harness.activate(1);
        await waitForRefresh();
        Chai.expect(harness.calls, 'cached same-state tab').to.have.length(0);

        for (const mode of ['proxy', 'direct', 'auto']) {
          await harness.coordinator.requestRefresh({
            state: harness.setState({mode}),
          });
          Chai.expect(harness.calls, `${mode} route transition`)
              .to.have.length(3);
          harness.calls.length = 0;
        }

        await harness.coordinator.requestRefresh({
          state: harness.setState({}),
          overrides: {operation: 'refresh'},
        });
        Chai.expect(harness.calls, 'refresh start').to.have.length(4);
        harness.calls.length = 0;
        await harness.coordinator.requestRefresh({
          state: harness.setState({}),
        });
        Chai.expect(harness.calls, 'refresh completion').to.have.length(4);
        harness.calls.length = 0;

        for (const proxyApplied of [false, true]) {
          await harness.coordinator.requestRefresh({
            state: harness.setState({proxyApplied}),
          });
          Chai.expect(
              harness.calls,
              proxyApplied ? 'Off to applied' : 'applied to Off',
          ).to.have.length(4);
          harness.calls.length = 0;
        }

        for (const patch of [
          {controlledByThisExtension: false},
          {controlledByThisExtension: true},
          {proxyHealth: {status: 'error'}},
          {proxyHealth: {status: 'unknown'}},
        ]) {
          await harness.coordinator.requestRefresh({
            state: harness.setState(patch),
          });
          Chai.expect(harness.calls, JSON.stringify(patch)).to.have.length(4);
          harness.calls.length = 0;
        }

      });

  Mocha.it('updates only badge and title properties when the route changes',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;

        await harness.coordinator.requestRefresh({
          state: harness.setState({mode: 'proxy'}),
        });

        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setTitle',
        ]);
        Chai.expect(harness.calls.some((call) =>
          ['setIcon', 'setBadgeTextColor'].includes(call.method),
        )).to.equal(false);

      });

  Mocha.it('feature-detects badge text color without making it required',
      async function() {

        const harness = createHarness({badgeTextColorSupported: false});
        const result = await harness.start();

        Chai.expect(result.ok).to.equal(true);
        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setTitle',
        ]);

      });

  Mocha.it('isolates an icon failure and retries it on a later refresh',
      async function() {

        const harness = createHarness({iconFailures: 1});
        const first = await harness.start();

        Chai.expect(first).to.include({ok: false});
        Chai.expect(first.failed).to.deep.equal(['setIcon']);
        Chai.expect(harness.counts.runtimeErrorReads).to.be.greaterThan(0);
        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ]);
        Chai.expect(harness.calls.find((call) => call.method === 'setIcon')
            .params.path).to.deep.equal(getAbsoluteIconMap('active', true));

        harness.calls.length = 0;
        const retry = await harness.coordinator.requestRefresh({
          state: harness.setState({}),
        });
        Chai.expect(retry).to.include({ok: true});
        Chai.expect(harness.calls.map((call) => call.method)).to.deep.equal([
          'setIcon',
        ]);

        harness.calls.length = 0;
        await harness.coordinator.requestRefresh({state: harness.setState({})});
        Chai.expect(harness.calls).to.deep.equal([]);

      });

  Mocha.it('fails malformed runtime icon URLs without blocking other status',
      async function() {

        const invalidResolvers = [
          null,
          () => '',
          (pathname) => pathname,
          (pathname) => `https://example.test/${pathname}`,
          () => {
            throw new TypeError('runtime.getURL failed');
          },
        ];
        for (const runtimeGetURL of invalidResolvers) {
          const harness = createHarness({runtimeGetURL});
          const first = await harness.start();

          Chai.expect(first).to.include({ok: false});
          Chai.expect(first.failed).to.deep.equal(['setIcon']);
          Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
            'setBadgeText',
            'setBadgeBackgroundColor',
            'setBadgeTextColor',
            'setTitle',
          ]);
          Chai.expect(harness.calls.some((call) => call.method === 'setIcon'))
              .to.equal(false);

          harness.calls.length = 0;
          const retry = await harness.coordinator.requestRefresh({
            state: harness.setState({}),
          });
          Chai.expect(retry).to.include({ok: false});
          Chai.expect(retry.failed).to.deep.equal(['setIcon']);
          Chai.expect(harness.calls).to.deep.equal([]);
        }

      });

  Mocha.it('bounds the per-tab presentation cache', async function() {

    const harness = createHarness({refreshOnStart: false});
    const status = {
      host: 'cache.example',
      controllable: true,
      mode: 'auto',
      proxyApplied: true,
      pacDownloaded: true,
      pacCooked: true,
    };
    for (let tabId = 1; tabId <= 257; ++tabId) {
      await global.mv3ActionStatus.updateStatus(status, {
        actionApi: harness.chromeApi.action,
        runtimeApi: harness.chromeApi.runtime,
        tabId,
      });
    }
    harness.calls.length = 0;

    await global.mv3ActionStatus.updateStatus(status, {
      actionApi: harness.chromeApi.action,
      runtimeApi: harness.chromeApi.runtime,
      tabId: 1,
    });

    Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
      'setIcon',
      'setBadgeText',
      'setBadgeBackgroundColor',
      'setBadgeTextColor',
      'setTitle',
    ]);

  });

  Mocha.it('retries every failed Action property and consumes runtime errors',
      async function() {

        const failedMethods = [
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ];
        const harness = createHarness({
          actionFailures: failedMethods.reduce((failures, method) => {
            failures[method] = 1;
            return failures;
          }, {}),
        });
        const first = await harness.start();

        Chai.expect(first.ok).to.equal(false);
        Chai.expect(first.failed).to.have.members(failedMethods);
        Chai.expect(harness.counts.runtimeErrorReads).to.be.at.least(
            failedMethods.length,
        );

        harness.calls.length = 0;
        const retry = await harness.coordinator.requestRefresh({
          state: harness.setState({}),
        });
        Chai.expect(retry.ok).to.equal(true);
        Chai.expect(retry.failed).to.deep.equal([]);
        Chai.expect(harness.calls.map((call) => call.method))
            .to.have.members(failedMethods);

        harness.calls.length = 0;
        await harness.coordinator.requestRefresh({state: harness.setState({})});
        Chai.expect(harness.calls).to.deep.equal([]);

      });

  Mocha.it('handles Promise-style Action rejection and retries the property',
      async function() {

        const harness = createHarness({
          promiseActionFailures: {setTitle: 1},
        });
        const first = await harness.start();

        Chai.expect(first).to.include({ok: false});
        Chai.expect(first.failed).to.deep.equal(['setTitle']);
        Chai.expect(harness.appliedActionState.setIcon).to.be.an('object');
        Chai.expect(harness.appliedActionState.setTitle).to.equal(undefined);

        harness.calls.length = 0;
        const retry = await harness.coordinator.requestRefresh({
          state: harness.setState({}),
        });
        Chai.expect(retry).to.include({ok: true});
        Chai.expect(retry.failed).to.deep.equal([]);
        Chai.expect(harness.calls.map((call) => call.method))
            .to.deep.equal(['setTitle']);
        Chai.expect(harness.appliedActionState.setTitle.title)
            .to.include('Current site: Auto');

      });

  Mocha.it('serializes Action writes so a clear remains newer than apply',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;
        harness.holdActionCallbacks();

        const applying = harness.coordinator.requestRefresh({
          state: harness.setState({mode: 'proxy'}),
          overrides: {operation: 'apply'},
        });
        await waitForRefresh();
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setBadgeText' && call.params.text === '…',
        )).to.be.an('object');

        const cleared = harness.coordinator.requestRefresh({
          state: harness.setState({proxyApplied: false}),
        });
        await waitForRefresh();
        Chai.expect(harness.calls.some((call) =>
          call.method === 'setBadgeText' && call.params.text === 'OFF',
        )).to.equal(false);

        harness.releaseActionCallbacks();
        await Promise.all([applying, cleared]);
        Chai.expect(harness.appliedActionState.setBadgeText.text).to.equal('OFF');
        Chai.expect(harness.appliedActionState.setTitle.title)
            .to.include('Extension proxy is off');
        Chai.expect(harness.appliedActionState.setIcon.path)
            .to.deep.equal(getAbsoluteIconMap('off'));

      });

  Mocha.it('drops a coalesced stale busy override after authoritative clear',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;

        const busy = harness.coordinator.requestRefresh({
          state: harness.setState({proxyApplied: true}),
          overrides: {operation: 'apply'},
        });
        const cleared = harness.coordinator.requestRefresh({
          state: harness.setState({proxyApplied: false}),
        });
        await Promise.all([busy, cleared]);

        Chai.expect(harness.calls.some((call) =>
          call.method === 'setBadgeText' && call.params.text === '…',
        )).to.equal(false);
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setBadgeText',
        ).params.text).to.equal('OFF');

      });

  Mocha.it('coalesces event bursts onto the latest URL and state read',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;
        const readsBefore = harness.counts.stateReads;
        const buildsBefore = harness.counts.statusBuilds;

        harness.updateTab(1, {url: 'https://first.example/'});
        harness.updateTab(1, {url: 'https://second.example/'});
        harness.updateTab(1, {url: 'https://latest.example/'});
        await waitForRefresh();

        Chai.expect(harness.counts.stateReads - readsBefore).to.equal(1);
        Chai.expect(harness.counts.statusBuilds - buildsBefore).to.equal(1);
        const titles = harness.calls.filter((call) => call.method === 'setTitle');
        Chai.expect(titles).to.have.length(1);
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://latest.example/');

      });

  Mocha.it('lets external ownership supersede an older pending lookup',
      async function() {

        let releaseOld;
        let markOldStarted;
        const oldStarted = new Promise((resolve) => {
          markOldStarted = resolve;
        });
        const oldStatus = new Promise((resolve) => {
          releaseOld = resolve;
        });
        const harness = createHarness({
          refreshOnStart: false,
          state: {generation: 'old'},
          createStatus(url, snapshot, fallback) {

            if (snapshot.generation === 'old') {
              markOldStarted();
              return oldStatus;
            }
            return fallback(url, snapshot);

          },
        });
        await harness.start();
        const oldRefresh = harness.coordinator.requestRefresh({});
        await oldStarted;

        await harness.coordinator.requestRefresh({
          state: harness.setState({
            generation: 'new',
            controlledByThisExtension: false,
          }),
        });
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setBadgeText' && call.params.text === 'EXT',
        )).to.be.an('object');

        const callCount = harness.calls.length;
        releaseOld({
          controllable: true,
          mode: 'proxy',
          proxyApplied: true,
        });
        await oldRefresh;
        Chai.expect(harness.calls).to.have.length(callCount);

      });

  Mocha.it('prevents an old window lookup from overwriting new focus',
      async function() {

        let releaseOld;
        let markOldStarted;
        const oldStarted = new Promise((resolve) => {
          markOldStarted = resolve;
        });
        const oldStatus = new Promise((resolve) => {
          releaseOld = resolve;
        });
        const harness = createHarness({
          refreshOnStart: false,
          createStatus(url, snapshot, fallback) {

            if (url.includes('alpha.example')) {
              markOldStarted();
              return oldStatus;
            }
            return fallback(url, snapshot);

          },
        });
        harness.tabs.set(4, {
          id: 4,
          windowId: 20,
          active: true,
          url: 'https://focused.example/',
        });
        await harness.start();
        const oldRefresh = harness.coordinator.requestRefresh({windowId: 10});
        await oldStarted;

        harness.focusWindow(20);
        await waitForRefresh();
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setTitle' && call.params.tabId === 4,
        )).to.be.an('object');

        const callCount = harness.calls.length;
        releaseOld({
          controllable: true,
          mode: 'auto',
          proxyApplied: true,
        });
        await oldRefresh;
        Chai.expect(harness.calls).to.have.length(callCount);

      });

  Mocha.it('keeps active ownership visible on unsupported browser pages',
      async function() {

        const harness = createHarness({
          createStatus(url, snapshot, fallback) {

            if (url.startsWith('chrome://')) {
              return Object.assign(
                  fallback('https://safe.invalid/', snapshot),
                  {controllable: false, mode: 'direct'},
              );
            }
            return fallback(url, snapshot);

          },
        });
        harness.tabs.get(1).url = 'chrome://settings/';
        await harness.start();

        Chai.expect(harness.calls.find((call) =>
          call.method === 'setBadgeText',
        ).params.text).to.equal('');
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setTitle',
        ).params.title).to.include('routing is unavailable');
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setIcon',
        ).params.path).to.deep.equal(getAbsoluteIconMap('active', true));

      });

  Mocha.it('refreshes the successor after active tabs are closed or replaced',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.calls.length = 0;

        harness.tabs.delete(1);
        harness.tabs.get(2).active = true;
        harness.events.removed.dispatch(1, {windowId: 10, isWindowClosing: false});
        await waitForRefresh();
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setTitle' && call.params.tabId === 2,
        )).to.be.an('object');
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://beta.example/');

        harness.calls.length = 0;
        harness.tabs.get(2).active = false;
        harness.tabs.set(1, {
          id: 1,
          windowId: 10,
          active: false,
          url: 'https://alpha.example/',
        });
        harness.activate(1);
        await waitForRefresh();
        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ]);

        harness.activate(2);
        await waitForRefresh();
        harness.calls.length = 0;
        harness.tabs.delete(2);
        harness.tabs.get(1).active = false;
        harness.tabs.set(3, {
          id: 3,
          windowId: 10,
          active: true,
          url: 'https://replacement.example/',
        });
        harness.events.replaced.dispatch(3, 2);
        await waitForRefresh();
        Chai.expect(harness.calls.find((call) =>
          call.method === 'setTitle' && call.params.tabId === 3,
        )).to.be.an('object');
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://replacement.example/');

        harness.calls.length = 0;
        harness.tabs.get(3).active = false;
        harness.tabs.set(2, {
          id: 2,
          windowId: 10,
          active: false,
          url: 'https://beta.example/',
        });
        harness.activate(2);
        await waitForRefresh();
        Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
          'setIcon',
          'setBadgeText',
          'setBadgeBackgroundColor',
          'setBadgeTextColor',
          'setTitle',
        ]);

      });

  Mocha.it('refreshes the active tab when browser window focus changes',
      async function() {

        const harness = createHarness();
        harness.tabs.set(4, {
          id: 4,
          windowId: 20,
          active: true,
          url: 'https://focused.example/',
        });
        await harness.start();
        harness.calls.length = 0;

        harness.focusWindow(20);
        await waitForRefresh();

        Chai.expect(harness.calls.find((call) =>
          call.method === 'setTitle' && call.params.tabId === 4,
        )).to.be.an('object');
        Chai.expect(harness.statusUrls[harness.statusUrls.length - 1])
            .to.equal('https://focused.example/');

      });

  Mocha.it('registers listeners once and reads state once per event refresh',
      async function() {

        const harness = createHarness();
        await harness.start();
        harness.coordinator.start();
        harness.calls.length = 0;
        const readsBefore = harness.counts.stateReads;
        const buildsBefore = harness.counts.statusBuilds;

        harness.activate(2);
        await waitForRefresh();

        Chai.expect(harness.counts.stateReads - readsBefore).to.equal(1);
        Chai.expect(harness.counts.statusBuilds - buildsBefore).to.equal(1);
        Chai.expect(harness.calls.filter((call) =>
          call.method === 'setTitle',
        )).to.have.length(1);

      });

});
