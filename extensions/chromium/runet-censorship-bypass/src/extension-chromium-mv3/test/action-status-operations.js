'use strict';


const Chai = require('chai');
const Mocha = require('mocha');
const {
  CHANGED_RAW_PAC,
  createRuntimeHarness,
} = require('./runtime-performance-harness');

function expectAction(harness, badgeText, titlePart) {

  const action = harness.getActionState();
  Chai.expect(action.setBadgeText.text).to.equal(badgeText);
  Chai.expect(action.setTitle.title).to.include(titlePart);

}

Mocha.describe('MV3 authoritative operation action status', function() {

  Mocha.it('shows normal Apply only while its real workflow is pending',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        const gate = harness.blockProxySettingsSetCallback();
        const applying = harness.callRpc('applyPopupChanges', {
          tabUrl: 'https://audit.example/',
          operation: 'apply',
          draft: {},
        });
        await gate.started;

        expectAction(harness, '…', 'Applying changes');
        Chai.expect(harness.counts.actionCalls).to.equal(4);
        gate.release();
        const result = await applying;

        Chai.expect(result).to.include({ok: true, status: 'applied'});
        expectAction(harness, 'A', 'Current site: Auto');
        Chai.expect(harness.counts.actionCalls).to.equal(8);

      });

  Mocha.it('shows Clear while pending and authoritative Off afterward',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        const gate = harness.blockProxySettingsRead();
        const clearing = harness.callRpc('clearProxy');
        await gate.started;

        expectAction(harness, '…', 'Turning off extension proxy');
        Chai.expect(harness.counts.actionCalls).to.equal(4);
        gate.release();
        const result = await clearing;

        Chai.expect(result).to.include({ok: true, status: 'cleared'});
        expectAction(harness, 'OFF', 'Extension proxy is off');
        Chai.expect(harness.counts.actionCalls).to.equal(8);

      });

  Mocha.it('shows periodic refresh activity without changing route meaning',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        harness.setDownloadResult(
            harness.createDownloadResult(CHANGED_RAW_PAC),
        );
        const gate = harness.blockProxySettingsSetCallback();
        const refreshing = harness.callRpc('runPeriodicUpdateNow', {
          applyIfSafe: true,
        });
        await gate.started;

        expectAction(harness, '…', 'Updating routing data');
        Chai.expect(harness.counts.actionCalls).to.equal(4);
        gate.release();
        const result = await refreshing;

        Chai.expect(result).to.include({ok: true, status: 'success'});
        expectAction(harness, 'A', 'Current site: Auto');
        Chai.expect(harness.counts.actionCalls).to.equal(8);

      });

  Mocha.it('keeps Apply above its nested health check', async function() {

    let releaseFetch;
    let markFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchGate = new Promise((resolve) => {
      releaseFetch = resolve;
    });
    const harness = await createRuntimeHarness({
      async fetch() {

        markFetchStarted();
        await fetchGate;
        return {body: null};

      },
    });
    await harness.context.mv3State.savePacMods({
      localTor: {enabled: true},
      exceptions: [{
        pattern: 'audit.example',
        action: 'PROXY',
        enabled: true,
      }],
    });
    harness.resetCounts();

    const applying = harness.callRpc('applyPopupChanges', {
      tabUrl: 'https://audit.example/',
      operation: 'apply',
      draft: {},
    });
    await fetchStarted;

    expectAction(harness, '…', 'Applying changes');
    releaseFetch();
    const result = await applying;

    Chai.expect(result).to.include({ok: true, status: 'applied'});
    expectAction(harness, 'P', 'Current site: Proxy');
    Chai.expect(harness.counts.actionCalls).to.equal(8);

  });

  Mocha.it('keeps Clear above an older Apply until Clear finishes',
      async function() {

        const harness = await createRuntimeHarness();
        harness.resetCounts();
        const gate = harness.blockProxySettingsSetCallback();
        const applying = harness.callRpc('applyPopupChanges', {
          tabUrl: 'https://audit.example/',
          operation: 'apply',
          draft: {},
        });
        await gate.started;
        expectAction(harness, '…', 'Applying changes');

        const clearing = harness.callRpc('clearProxy');
        await harness.waitForActionCalls(5);
        expectAction(harness, '…', 'Turning off extension proxy');

        gate.release();
        const [applyResult, clearResult] = await Promise.all([
          applying,
          clearing,
        ]);
        Chai.expect(applyResult).to.include({ok: false, status: 'stale'});
        Chai.expect(clearResult).to.include({ok: true, status: 'cleared'});
        expectAction(harness, 'OFF', 'Extension proxy is off');
        Chai.expect(harness.counts.actionCalls).to.equal(9);
        Chai.expect(harness.getActionCalls()
            .filter((call) => call.method === 'setTitle')
            .map((call) => call.params.title)).to.deep.equal([
          'Applying changes…',
          'Turning off extension proxy…',
          'Extension proxy is off. Chromium uses system proxy settings.',
        ]);

      });

  Mocha.it('clears a recoverable Apply warning after a successful retry',
      async function() {

        const harness = await createRuntimeHarness();
        harness.failNextProxySettingsSet('synthetic apply failure');
        const failed = await harness.callRpc('applyPopupChanges', {
          tabUrl: 'https://audit.example/',
          operation: 'apply',
          draft: {},
        });

        Chai.expect(failed).to.include({ok: false, status: 'error'});
        expectAction(harness, '!', 'operation needs attention');
        const retry = await harness.callRpc('applyPopupChanges', {
          tabUrl: 'https://audit.example/',
          operation: 'apply',
          draft: {},
        });

        Chai.expect(retry).to.include({ok: true, status: 'applied'});
        expectAction(harness, 'A', 'Current site: Auto');

      });

  Mocha.it('does not reconstruct abandoned durable operations as busy',
      async function() {

        const seed = await createRuntimeHarness();
        const initialState = seed.getState();
        initialState.pacDownload = {status: 'downloading'};
        initialState.pacCook = {status: 'cooking'};
        initialState.proxyApply.status = 'applying';
        initialState.proxyHealth = {
          status: 'checking',
          lastErrorCode: 'SECRET_CODE',
          lastErrorMessage: 'secret message',
        };
        const harness = await createRuntimeHarness({initialState});
        expectAction(harness, '!', 'operation needs attention');

        const popup = await harness.callRpc('getPopupState', {
          tabUrl: 'https://audit.example/',
        });
        Chai.expect(popup).to.include({
          pacDownloadStatus: 'error',
          pacCookStatus: 'error',
          proxyApplyStatus: 'error',
        });
        Chai.expect(popup.proxyHealth).to.include({status: 'unknown'});
        Chai.expect(JSON.stringify(popup)).to.not.include('SECRET_CODE');
        Chai.expect(JSON.stringify(popup)).to.not.include('secret message');

        const options = await harness.callRpc('getState');
        Chai.expect(options).to.deep.nested.include({
          'state.pacDownload.status': 'error',
          'state.pacCook.status': 'error',
          'state.proxyApply.status': 'error',
          'reliability.proxyHealth.status': 'unknown',
        });
        Chai.expect(JSON.stringify(options)).to.not.include('SECRET_CODE');
        Chai.expect(JSON.stringify(options)).to.not.include('secret message');

      });

});
