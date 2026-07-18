'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Fs = require('fs');
const Mocha = require('mocha');
const Path = require('path');
const Vm = require('vm');
const {
  CHANGED_RAW_PAC,
  RAW_PAC,
  createRuntimeHarness,
} = require('./runtime-performance-harness');

const PAGES_DIRECTORY = Path.resolve(__dirname, '..', 'pages');

function pickCounts(counts, keys) {

  return Object.fromEntries(keys.map((key) => [key, counts[key]]));

}

function createNode() {

  return {
    classList: {add() {}},
    dataset: {},
    appendChild() {},
    querySelector() {

      return null;

    },
    replaceChildren() {},
    setAttribute() {},
  };

}

async function measurePageInitialization(page) {

  const counts = {rpcCalls: 0, tabQueries: 0};
  const domReadyListeners = [];
  const document = {
    title: '',
    addEventListener(type, listener) {

      if (type === 'DOMContentLoaded') {
        domReadyListeners.push(listener);
      }

    },
    createElement: createNode,
    createTextNode: createNode,
    getElementById: createNode,
  };
  const context = Vm.createContext({
    URL,
    chrome: {
      i18n: {getMessage: (key) => key},
      runtime: {lastError: null},
      tabs: {
        query(query, callback) {

          ++counts.tabQueries;
          callback([{url: 'https://audit.example/'}]);

        },
      },
    },
    console: {error() {}, warn() {}},
    document,
    setTimeout,
  });
  context.window = context;
  context.mv3Rpc = {
    async callBackground() {

      ++counts.rpcCalls;
      throw new Error('Stop after the initialization request.');

    },
  };
  context.mv3I18n = {
    init: async () => undefined,
    t: (key) => key,
  };
  const source = Fs.readFileSync(
      Path.join(PAGES_DIRECTORY, page, 'index.js'),
      'utf8',
  );
  Vm.runInContext(source, context, {filename: `${page}/index.js`});
  domReadyListeners.forEach((listener) => listener());
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  return counts;

}

Mocha.describe('MV3 runtime performance operation counts', function() {

  Mocha.it('keeps cold startup bounded and reconstructs live action status',
      async function() {

        const first = await createRuntimeHarness();
        const second = await createRuntimeHarness();
        const keys = [
          'storageGets',
          'storageSets',
          'indexedDbOpens',
          'tabQueries',
          'actionCalls',
          'hashOperations',
          'proxySettingsReads',
          'alarmGets',
          'alarmCreates',
        ];
        const expected = {
          storageGets: 2,
          storageSets: 1,
          indexedDbOpens: 0,
          tabQueries: 1,
          actionCalls: 4,
          hashOperations: 1,
          proxySettingsReads: 1,
          alarmGets: 1,
          alarmCreates: 1,
        };

        Chai.expect(pickCounts(first.counts, keys)).to.deep.equal(expected);
        Chai.expect(pickCounts(second.counts, keys)).to.deep.equal(expected);

      });

  Mocha.it('opens popup and settings with one RPC and no action writes',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        await harness.callRpc('getPopupState', {
          tabUrl: 'https://audit.example/',
        });
        Chai.expect(pickCounts(harness.counts, [
          'runtimeRpcs',
          'storageGets',
          'hashOperations',
          'actionCalls',
        ])).to.deep.equal({
          runtimeRpcs: 1,
          storageGets: 1,
          hashOperations: 1,
          actionCalls: 0,
        });

        harness.resetCounts();
        await harness.callRpc('getState');
        Chai.expect(pickCounts(harness.counts, [
          'runtimeRpcs',
          'storageGets',
          'hashOperations',
          'actionCalls',
          'alarmGets',
        ])).to.deep.equal({
          runtimeRpcs: 1,
          storageGets: 1,
          hashOperations: 1,
          actionCalls: 0,
          alarmGets: 2,
        });

        Chai.expect(await measurePageInitialization('popup')).to.deep.equal({
          rpcCalls: 1,
          tabQueries: 1,
        });
        Chai.expect(await measurePageInitialization('options')).to.deep.equal({
          rpcCalls: 1,
          tabQueries: 0,
        });

      });

  Mocha.it('keeps active-tab refreshes event driven and storage-read only',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        await harness.activateTab(2);
        Chai.expect(pickCounts(harness.counts, [
          'storageGets',
          'storageSets',
          'tabGets',
          'actionCalls',
          'hashOperations',
        ])).to.deep.equal({
          storageGets: 1,
          storageSets: 0,
          tabGets: 1,
          actionCalls: 4,
          hashOperations: 1,
        });

        harness.resetCounts();
        await harness.updateTab(2, {
          url: 'https://changed.example/',
          status: 'complete',
        });
        Chai.expect(pickCounts(harness.counts, [
          'storageGets',
          'storageSets',
          'tabQueries',
          'tabGets',
          'hashOperations',
        ])).to.deep.equal({
          storageGets: 1,
          storageSets: 0,
          tabQueries: 0,
          tabGets: 0,
          hashOperations: 1,
        });

      });

  Mocha.it('batches each current-site mode mutation into one state write',
      async function() {

        const harness = await createRuntimeHarness();
        for (const mode of ['proxy', 'direct', 'auto']) {
          harness.resetCounts();
          const result = await harness.callRpc('updatePopupDraft', {
            tabUrl: 'https://audit.example/',
            draft: {siteMode: mode, siteScope: 'host'},
          });
          Chai.expect(result.popupState.mode).to.equal(mode);
          Chai.expect(pickCounts(harness.counts, [
            'runtimeRpcs',
            'storageGets',
            'storageSets',
          ])).to.deep.equal({
            runtimeRpcs: 1,
            storageGets: 3,
            storageSets: 1,
          });
        }

      });

  Mocha.it('runs the complete durable pipeline for changed PAC content',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        harness.setDownloadResult(
            harness.createDownloadResult(CHANGED_RAW_PAC),
        );
        const result = await harness.callRpc('runPeriodicUpdateNow', {
          applyIfSafe: true,
        });

        Chai.expect(result).to.include({
          ok: true,
          downloadStatus: 'success',
          cookStatus: 'success',
        });
        Chai.expect(result.autoApply).to.include({
          status: 'applied',
          applied: true,
        });
        Chai.expect(pickCounts(harness.counts, [
          'indexedDbReads',
          'indexedDbWrites',
          'storageGets',
          'storageSets',
          'tabGets',
          'pacDownloads',
          'pacCooks',
          'hashOperations',
          'proxySettingsWrites',
        ])).to.deep.equal({
          indexedDbReads: 2,
          indexedDbWrites: 2,
          storageGets: 25,
          storageSets: 13,
          tabGets: 1,
          pacDownloads: 1,
          pacCooks: 1,
          hashOperations: 7,
          proxySettingsWrites: 1,
        });

      });

  Mocha.it('does not rewrite, recook, or reapply identical PAC content',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        harness.setDownloadResult(harness.createDownloadResult(RAW_PAC));
        const result = await harness.callRpc('runPeriodicUpdateNow', {
          applyIfSafe: true,
        });

        Chai.expect(result).to.include({
          ok: true,
          downloadStatus: 'success',
          cookStatus: 'not_modified',
        });
        Chai.expect(result.autoApply).to.include({
          status: 'unchanged',
          applied: false,
        });
        Chai.expect(pickCounts(harness.counts, [
          'storageGets',
          'storageSets',
          'indexedDbReads',
          'indexedDbWrites',
          'tabGets',
          'pacCooks',
          'hashOperations',
          'proxySettingsReads',
          'proxySettingsWrites',
        ])).to.deep.equal({
          storageGets: 18,
          storageSets: 7,
          indexedDbReads: 2,
          indexedDbWrites: 0,
          tabGets: 1,
          pacCooks: 0,
          hashOperations: 5,
          proxySettingsReads: 1,
          proxySettingsWrites: 0,
        });

      });

  Mocha.it('rebuilds a missing cooked artifact instead of trusting metadata',
      async function() {

        const harness = await createRuntimeHarness();
        harness.dropCookedArtifact();
        harness.resetCounts();
        harness.setDownloadResult(harness.createDownloadResult(RAW_PAC));
        const result = await harness.audit.executePeriodicUpdatePipeline({
          trigger: 'audit',
          applyIfSafe: false,
        });

        Chai.expect(result).to.include({ok: true, cookStatus: 'success'});
        Chai.expect(harness.counts.pacCooks).to.equal(1);
        Chai.expect(harness.counts.indexedDbWrites).to.equal(1);
        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);

      });

  Mocha.it('reports stale when state changes during unchanged-artifact check',
      async function() {

        const harness = await createRuntimeHarness();
        const gate = harness.blockCookedArtifactRead();
        const cook = harness.audit.cookPacAndPersist({
          providerKey: 'Антизапрет',
        });
        await gate.started;
        await harness.context.mv3State.savePacMods({
          torBrowser: {enabled: false},
        });
        gate.release();
        const result = await cook;

        Chai.expect(result).to.include({
          ok: true,
          status: 'not_modified',
        });
        Chai.expect(result.stale.stale).to.equal(true);
        Chai.expect(result.stale.reasons).to.include('PAC modifiers changed');

      });

  Mocha.it('does not reapply unchanged PAC after external proxy takeover',
      async function() {

        const harness = await createRuntimeHarness();
        harness.setProxyDetails({
          levelOfControl: 'controlled_by_other_extensions',
          value: {mode: 'direct'},
        });
        harness.resetCounts();
        harness.setDownloadResult(harness.createDownloadResult(RAW_PAC));
        const result = await harness.audit.executePeriodicUpdatePipeline({
          trigger: 'audit',
          applyIfSafe: true,
        });

        Chai.expect(result.autoApply).to.include({
          allowed: false,
          status: 'skipped',
        });
        Chai.expect(harness.counts.proxySettingsReads).to.equal(1);
        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);

      });

  Mocha.it('clears both PAC artifacts and refreshes status without proxy writes',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        await harness.callRpc('clearPacCache');
        await harness.callRpc('clearCookedPacCache');

        Chai.expect(pickCounts(harness.counts, [
          'runtimeRpcs',
          'storageSets',
          'indexedDbWrites',
          'proxySettingsWrites',
        ])).to.deep.equal({
          runtimeRpcs: 2,
          storageSets: 2,
          indexedDbWrites: 2,
          proxySettingsWrites: 0,
        });
        Chai.expect(harness.getState().pacCache.rawPacSha256).to.equal(null);
        Chai.expect(harness.getState().cookedPacCache.cookedPacSha256)
            .to.equal(null);

      });

  Mocha.it('refreshes durable control and action state after external change',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        await harness.changeProxyDetails({
          levelOfControl: 'controlled_by_other_extensions',
          value: {mode: 'direct'},
        });

        Chai.expect(pickCounts(harness.counts, [
          'proxySettingsReads',
          'proxySettingsWrites',
          'storageSets',
          'actionCalls',
        ])).to.deep.equal({
          proxySettingsReads: 1,
          proxySettingsWrites: 0,
          storageSets: 2,
          actionCalls: 4,
        });
        Chai.expect(harness.getState().proxyControl).to.include({
          controlledByThisExtension: false,
          canControl: false,
        });

      });

});
