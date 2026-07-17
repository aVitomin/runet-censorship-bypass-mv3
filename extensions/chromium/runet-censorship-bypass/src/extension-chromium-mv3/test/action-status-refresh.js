'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const {loadBackgroundModules} = require('./background-modules');

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
  const counts = {
    runtimeErrorReads: 0,
    stateReads: 0,
    tabQueries: 0,
    tabGets: 0,
    statusBuilds: 0,
  };
  let runtimeLastError = null;
  const runtime = {};
  Object.defineProperty(runtime, 'lastError', {
    get() {

      ++counts.runtimeErrorReads;
      return runtimeLastError;

    },
  });
  let state = Object.assign({
    mode: 'auto',
    proxyApplied: true,
    controlledByThisExtension: true,
    pacDownloaded: true,
    pacCooked: true,
  }, options.state);
  let focusedWindowId = 10;
  let iconFailuresRemaining = options.iconFailures || 0;
  const action = {};
  [
    'setIcon',
    'setBadgeText',
    'setBadgeBackgroundColor',
    'setTitle',
  ].forEach((method) => {
    action[method] = (params, callback) => {
      calls.push({method, params});
      if (method === 'setIcon' && iconFailuresRemaining > 0) {
        --iconFailuresRemaining;
        runtimeLastError = {
          message: 'Failed to set icon: Failed to fetch',
        };
        callback();
        runtimeLastError = null;
        return;
      }
      callback();
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
    pacDownloaded: snapshot.pacDownloaded === true,
    pacCooked: snapshot.pacCooked === true,
    pacStale: snapshot.pacStale === true,
    selectedProvider: 'test-provider',
    proxyHealth: {status: 'unknown'},
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
      return createStatus(url, snapshot, defaultCreateStatus);

    },
  });

  return {
    calls,
    chromeApi,
    coordinator,
    counts,
    events,
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
        path: {128: 'icons/default-128.png'},
        tabId: 2,
      },
    });
    const title = harness.calls.find((call) => call.method === 'setTitle');
    Chai.expect(title.params).to.include({tabId: 2});
    Chai.expect(title.params.title).to.include('beta.example');

  });

  Mocha.it('refreshes status after an active-tab URL change or reload', async function() {

    const harness = createHarness();
    await harness.start();
    harness.calls.length = 0;

    harness.updateTab(1, {url: 'https://changed.example/path'});
    await waitForRefresh();
    harness.updateTab(1, {status: 'complete'});
    await waitForRefresh();

    const titles = harness.calls.filter((call) => call.method === 'setTitle');
    Chai.expect(titles).to.have.length(1);
    Chai.expect(titles[0].params.title).to.include('changed.example');

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
          call.params.tabId === 2 &&
          call.method === 'setTitle' &&
          call.params.title.includes('beta.example'),
        )).to.equal(true);

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
          {128: 'icons/default-128.png'},
          {128: 'icons/default-grayscale-128.png'},
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
        path: {128: 'icons/default-grayscale-128.png'},
        tabId: 1,
      },
    });
    Chai.expect(harness.calls).to.deep.include({
      method: 'setBadgeText',
      params: {text: '', tabId: 1},
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
          'setTitle',
        ]);
        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('alpha.example');

      });

  Mocha.it('does not repeat identical action API calls', async function() {

    const harness = createHarness();
    await harness.start();
    harness.calls.length = 0;

    await harness.coordinator.requestRefresh({state: harness.setState({})});

    Chai.expect(harness.calls).to.deep.equal([]);

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
          'setTitle',
        ]);

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
        tabId,
      });
    }
    harness.calls.length = 0;

    await global.mv3ActionStatus.updateStatus(status, {
      actionApi: harness.chromeApi.action,
      tabId: 1,
    });

    Chai.expect(harness.calls.map((call) => call.method)).to.have.members([
      'setIcon',
      'setBadgeText',
      'setBadgeBackgroundColor',
      'setTitle',
    ]);

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
        Chai.expect(titles[0].params.title).to.include('latest.example');

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
        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('beta.example');

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
        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('replacement.example');

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

        Chai.expect(harness.calls.find((call) => call.method === 'setTitle')
            .params.title).to.include('focused.example');

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
