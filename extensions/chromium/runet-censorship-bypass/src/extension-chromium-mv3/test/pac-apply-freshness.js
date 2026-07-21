'use strict';

/* eslint-env node, mocha */

const {expect} = require('chai');

const {
  CHANGED_RAW_PAC,
  createRuntimeHarness,
} = require('./runtime-performance-harness');

function createRpcPacMods(harness, patch) {

  const state = harness.getState();
  return Object.assign(
      harness.context.mv3PacMods.serializePacModsForRpc(
          state.pacMods,
          state.pacModsRevision,
      ),
      patch,
  );

}

function expectStaleWithoutProxyWrite(harness, result) {

  expect(result).to.deep.include({
    ok: false,
    status: 'stale',
    applied: false,
  });
  expect(result.error).to.deep.equal({
    code: 'PAC_APPLY_STALE',
    message:
      'PAC application was superseded by newer PAC settings or an operation.',
    details: null,
  });
  expect(harness.counts.proxySettingsWrites).to.equal(0);

}

describe('PAC apply freshness', () => {
  it('keeps a popup PAC workflow stale after clear during download', async () => {
    const harness = await createRuntimeHarness();
    await harness.context.mv3State.clearPacCache();
    harness.resetCounts();
    const download = harness.blockPacDownload();

    const popupApply = harness.callRpc('applyPopupChanges', {
      tabUrl: 'https://audit.example/',
      operation: 'apply',
      draft: {},
    });
    await download.started;
    const clearResult = await harness.callRpc('clearProxy');
    download.release();

    const result = await popupApply;

    expect(clearResult).to.include({ok: true, status: 'cleared'});
    expect(result).to.include({ok: false, status: 'stale'});
    expect(harness.counts.proxySettingsWrites).to.equal(0);
    expect(harness.counts.proxySettingsClears).to.equal(1);
    expect(harness.getProxyDetails().value.mode).to.equal('direct');
    expect(harness.getState().proxyApply.status).to.equal('cleared');
    expect(result.popupState.proxyApplyStatus).to.equal('cleared');
    expect(harness.getActionState().setIcon.path[128])
        .to.include('default-grayscale-128.png');
    expect(harness.getActionState().setTitle.title)
        .to.include('Proxy: system');
  });

  it('keeps a popup PAC workflow stale after clear during cooking', async () => {
    const harness = await createRuntimeHarness();
    await harness.context.mv3State.clearPacCache();
    harness.setDownloadResult(harness.createDownloadResult(CHANGED_RAW_PAC));
    harness.resetCounts();
    const cook = harness.blockPacCook();

    const popupApply = harness.callRpc('applyPopupChanges', {
      tabUrl: 'https://audit.example/',
      operation: 'apply',
      draft: {},
    });
    await cook.started;
    const clearResult = await harness.callRpc('clearProxy');
    cook.release();

    const result = await popupApply;

    expect(clearResult).to.include({ok: true, status: 'cleared'});
    expect(result).to.include({ok: false, status: 'stale'});
    expect(harness.counts.proxySettingsWrites).to.equal(0);
    expect(harness.getProxyDetails().value.mode).to.equal('direct');
    expect(harness.getState().proxyApply.status).to.equal('cleared');
  });

  it('keeps a PAC apply stale after clear during artifact loading', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const artifactRead = harness.blockCookedArtifactRead();

    const oldApply = harness.audit.applyCookedPacAndPersist({});
    await artifactRead.started;
    const clear = harness.audit.clearProxyAndPersist();
    artifactRead.release();

    const [result, clearResult] = await Promise.all([oldApply, clear]);

    expect(clearResult).to.include({ok: true, status: 'cleared'});
    expect(result).to.include({ok: false, status: 'stale'});
    expect(harness.counts.proxySettingsWrites).to.equal(0);
    expect(harness.getProxyDetails().value.mode).to.equal('direct');
    expect(harness.getState().proxyApply.status).to.equal('cleared');
  });

  it('lets a fresh popup apply succeed after a failed stale workflow', async () => {
    const harness = await createRuntimeHarness();
    await harness.context.mv3State.clearPacCache();
    harness.setDownloadResult({
      ok: false,
      status: 'error',
      providerKey: 'Антизапрет',
      error: {
        code: 'PAC_DOWNLOAD_FAILED',
        message: 'Synthetic stale download failure.',
        details: null,
      },
      warnings: [],
    });
    harness.resetCounts();
    const download = harness.blockPacDownload();

    const staleApply = harness.callRpc('applyPopupChanges', {
      tabUrl: 'https://audit.example/',
      operation: 'apply',
      draft: {},
    });
    await download.started;
    await harness.callRpc('clearProxy');
    download.release();
    const staleResult = await staleApply;

    harness.setDownloadResult(harness.createDownloadResult(CHANGED_RAW_PAC));
    const freshResult = await harness.callRpc('applyPopupChanges', {
      tabUrl: 'https://audit.example/',
      operation: 'apply',
      draft: {},
    });

    expect(staleResult).to.include({ok: false, status: 'stale'});
    expect(freshResult).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(1);
    expect(harness.getState().proxyApply.status).to.equal('applied');
    expect(harness.getProxyDetails().value.mode).to.equal('pac_script');
  });

  it('reproduces and blocks an old provider apply after provider selection changes', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const cookedArtifactRead = harness.blockCookedArtifactRead();
    const previousProxyApply = harness.getState().proxyApply;

    const oldApply = harness.audit.applyCookedPacAndPersist({});
    await cookedArtifactRead.started;

    await harness.context.mv3State.setCurrentPacProvider('onlyOwnSites');
    cookedArtifactRead.release();

    const result = await oldApply;

    expectStaleWithoutProxyWrite(harness, result);
    expect(harness.getState().currentPacProviderKey).to.equal('onlyOwnSites');
    expect(harness.getState().proxyApply).to.deep.equal(previousProxyApply);
    const popupState = await harness.callRpc('getPopupState', {
      tabUrl: 'https://audit.example/',
    });
    expect(popupState.proxyApplyStatus).to.equal('applied');
    expect(harness.counts.actionCalls).to.equal(0);
  });

  it('does not apply an old provider PAC when selection changes during download', async () => {
    const harness = await createRuntimeHarness();
    harness.setDownloadResult(harness.createDownloadResult(CHANGED_RAW_PAC));
    const download = harness.blockPacDownload();

    const pipeline = harness.audit.executePeriodicUpdatePipeline({
      trigger: 'freshness-test',
      applyIfSafe: true,
    });
    await download.started;
    await harness.callRpc('setCurrentPacProvider', {
      providerKey: 'onlyOwnSites',
    });
    download.release();

    const result = await pipeline;

    expect(result).to.include({ok: false, status: 'skipped'});
    expect(result.error.code).to.equal('PAC_APPLY_STALE');
    expect(harness.counts.proxySettingsWrites).to.equal(0);
    expect(harness.getState().currentPacProviderKey).to.equal('onlyOwnSites');
  });

  it('does not apply a cooked PAC after modifiers change during cooking', async () => {
    const harness = await createRuntimeHarness();
    harness.setDownloadResult(harness.createDownloadResult(CHANGED_RAW_PAC));
    const cook = harness.blockPacCook();

    const pipeline = harness.audit.executePeriodicUpdatePipeline({
      trigger: 'freshness-test',
      applyIfSafe: true,
    });
    await cook.started;
    await harness.callRpc('setPacMods', {
      pacMods: createRpcPacMods(harness, {
        torBrowser: {enabled: false},
      }),
    });
    cook.release();

    const result = await pipeline;

    expect(result).to.include({ok: false, status: 'skipped'});
    expect(result.error.code).to.equal('PAC_APPLY_STALE');
    expect(harness.counts.proxySettingsWrites).to.equal(0);
  });

  it('lets proxy clear supersede an apply paused immediately before set', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const proxyControlRead = harness.blockProxySettingsRead(2);

    const oldApply = harness.audit.applyCookedPacAndPersist({});
    await proxyControlRead.started;
    const clear = harness.audit.clearProxyAndPersist();
    proxyControlRead.release();

    const [applyResult, clearResult] = await Promise.all([oldApply, clear]);

    expectStaleWithoutProxyWrite(harness, applyResult);
    expect(clearResult).to.include({ok: true, status: 'cleared'});
    expect(harness.counts.proxySettingsClears).to.equal(1);
    expect(harness.getState().proxyApply.status).to.equal('cleared');
  });

  it('lets clear win while an old settings.set callback is pending', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const setCallback = harness.blockProxySettingsSetCallback();

    const oldApply = harness.audit.applyCookedPacAndPersist({});
    await setCallback.started;
    const clear = harness.audit.clearProxyAndPersist();
    setCallback.release();

    const [applyResult, clearResult] = await Promise.all([oldApply, clear]);

    expect(applyResult).to.include({ok: false, status: 'stale'});
    expect(clearResult).to.include({ok: true, status: 'cleared'});
    expect(harness.counts.proxySettingsWrites).to.equal(1);
    expect(harness.counts.proxySettingsClears).to.equal(1);
    expect(harness.getState().proxyApply.status).to.equal('cleared');
    expect(harness.getProxyDetails().value.mode).to.equal('direct');
  });

  it('applies only the newer PAC when an older apply finishes preparation later', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const oldArtifactRead = harness.blockCookedArtifactRead();

    const oldApply = harness.audit.applyCookedPacAndPersist({});
    await oldArtifactRead.started;
    const newCook = await harness.installPacVersion({
      rawPacData: CHANGED_RAW_PAC,
    });
    const newApply = harness.audit.applyCookedPacAndPersist({});
    oldArtifactRead.release();

    const [oldResult, newResult] = await Promise.all([oldApply, newApply]);

    expect(oldResult).to.include({ok: false, status: 'stale'});
    expect(newResult).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(1);
    expect(harness.getProxySettingsSetValues()[0].pacScript.data)
        .to.equal(newCook.cookedPacData);
    expect(harness.getState().proxyApply).to.include({
      status: 'applied',
      cookedPacSha256: newCook.cookedPacSha256,
    });
  });

  it('rejects an old set callback after a newer apply is requested', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const oldSetCallback = harness.blockProxySettingsSetCallback();

    const oldApply = harness.audit.applyCookedPacAndPersist({});
    await oldSetCallback.started;
    const newCook = await harness.installPacVersion({
      rawPacData: CHANGED_RAW_PAC,
    });
    const newApply = harness.audit.applyCookedPacAndPersist({});
    oldSetCallback.release();

    const [oldResult, newResult] = await Promise.all([oldApply, newApply]);

    expect(oldResult).to.include({ok: false, status: 'stale'});
    expect(newResult).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(2);
    expect(harness.getState().proxyApply).to.include({
      status: 'applied',
      cookedPacSha256: newCook.cookedPacSha256,
    });
    expect(harness.getProxySettingsSetValues()[1].pacScript.data)
        .to.equal(newCook.cookedPacData);
  });

  it('blocks external proxy takeover at the final control read', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const proxyControlRead = harness.blockProxySettingsRead(2);

    const apply = harness.audit.applyCookedPacAndPersist({});
    await proxyControlRead.started;
    harness.setProxyDetails({
      levelOfControl: 'controlled_by_other_extensions',
      value: {mode: 'direct'},
    });
    proxyControlRead.release();

    const result = await apply;

    expect(result).to.include({ok: false, status: 'error'});
    expect(result.error.code).to.equal('PROXY_NOT_CONTROLLABLE');
    expect(harness.counts.proxySettingsWrites).to.equal(0);
    expect(harness.getState().proxyApply.status).to.equal('error');
  });

  it('records takeover during a pending set safely and later recovers', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const setCallback = harness.blockProxySettingsSetCallback();

    const apply = harness.audit.applyCookedPacAndPersist({});
    await setCallback.started;
    harness.setProxyDetails({
      levelOfControl: 'controlled_by_other_extensions',
      value: {mode: 'direct'},
    });
    setCallback.release();

    const takeoverResult = await apply;

    expect(takeoverResult).to.include({ok: false, status: 'error'});
    expect(takeoverResult.error.code).to.equal('PROXY_CONTROL_LOST');
    expect(harness.getState().proxyControl).to.include({
      controlledByThisExtension: false,
      canControl: false,
    });
    expect(harness.getState().proxyApply).to.include({
      status: 'error',
      levelOfControl: 'controlled_by_other_extensions',
    });

    harness.setProxyDetails({
      levelOfControl: 'controllable_by_this_extension',
      value: {mode: 'direct'},
    });
    const recovered = await harness.audit.applyCookedPacAndPersist({});

    expect(recovered).to.include({ok: true, status: 'applied'});
    expect(harness.getState().proxyApply.status).to.equal('applied');
    expect(harness.counts.proxySettingsWrites).to.equal(2);
  });

  it('rejects apply when a newer raw artifact becomes current before set', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const proxyControlRead = harness.blockProxySettingsRead(2);

    const apply = harness.audit.applyCookedPacAndPersist({});
    await proxyControlRead.started;
    harness.setDownloadResult(harness.createDownloadResult(CHANGED_RAW_PAC));
    const download = await harness.audit.downloadPacAndPersist({});
    expect(download).to.include({ok: true, status: 'success'});
    proxyControlRead.release();

    const result = await apply;

    expectStaleWithoutProxyWrite(harness, result);
    expect(harness.getState().pacCache.rawPacSha256)
        .to.equal(download.pacCache.rawPacSha256);
  });

  it('rejects apply when the cooked artifact is cleared before set', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const proxyControlRead = harness.blockProxySettingsRead(2);

    const apply = harness.audit.applyCookedPacAndPersist({});
    await proxyControlRead.started;
    await harness.audit.clearCookedPacCacheAndArtifacts();
    proxyControlRead.release();

    const result = await apply;

    expectStaleWithoutProxyWrite(harness, result);
    expect(harness.getState().cookedPacCache.cookedPacSha256).to.equal(null);
  });

  it('lets state reset invalidate an apply without restoring old status', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const proxyControlRead = harness.blockProxySettingsRead(2);

    const apply = harness.audit.applyCookedPacAndPersist({});
    await proxyControlRead.started;
    await harness.audit.RPC_METHODS.resetMv3State();
    proxyControlRead.release();

    const result = await apply;

    expectStaleWithoutProxyWrite(harness, result);
    expect(harness.getState().currentPacProviderKey).to.equal(null);
    expect(harness.getState().proxyApply.status).to.equal('idle');
  });

  it('does not invalidate apply for language or notification changes', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const cookedArtifactRead = harness.blockCookedArtifactRead();

    const apply = harness.audit.applyCookedPacAndPersist({});
    await cookedArtifactRead.started;
    await harness.callRpc('setUiLanguage', {language: 'ru'});
    await harness.callRpc('setNotificationPrefs', {
      prefs: {pacError: false},
    });
    cookedArtifactRead.release();

    const result = await apply;

    expect(result).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(1);
    expect(harness.getState().uiLanguage).to.equal('ru');
    expect(harness.getState().notificationPrefs.pacError).to.equal(false);
  });

  it('excludes credential contents from freshness and stale responses', async () => {
    const originalSecret = ['original', 'freshness', 'fixture'].join('-');
    const replacementSecret = ['replacement', 'freshness', 'fixture'].join('-');
    const harness = await createRuntimeHarness({
      pacMods: {
        ownProxies: [{
          enabled: true,
          type: 'HTTPS',
          host: 'proxy.example',
          port: 8443,
          username: 'first-user',
          password: originalSecret,
        }],
        torBrowser: {enabled: true},
      },
    });
    harness.resetCounts();
    const artifactRead = harness.blockCookedArtifactRead();
    const fingerprintBefore = harness.audit.createPacApplyFingerprint(
        harness.getState(),
    );

    const apply = harness.audit.applyCookedPacAndPersist({});
    await artifactRead.started;
    const model = await harness.callRpc('getPacMods');
    model.ownProxies[0].username = 'second-user';
    model.ownProxies[0].password = replacementSecret;
    delete model.ownProxies[0].credentialRef;
    delete model.ownProxies[0].hasCredentials;
    delete model.ownProxies[0].hasPassword;
    await harness.callRpc('setPacMods', {pacMods: model});
    const removalModel = await harness.callRpc('getPacMods');
    removalModel.ownProxies[0].password = '';
    delete removalModel.ownProxies[0].credentialRef;
    delete removalModel.ownProxies[0].hasCredentials;
    delete removalModel.ownProxies[0].hasPassword;
    await harness.callRpc('setPacMods', {pacMods: removalModel});
    const fingerprintAfter = harness.audit.createPacApplyFingerprint(
        harness.getState(),
    );
    artifactRead.release();

    const result = await apply;
    const serializedFingerprints = JSON.stringify([
      fingerprintBefore,
      fingerprintAfter,
    ]);

    expect(result).to.include({ok: true, status: 'applied'});
    expect(fingerprintAfter).to.deep.equal(fingerprintBefore);
    expect(serializedFingerprints.includes(originalSecret)).to.equal(false);
    expect(serializedFingerprints.includes(replacementSecret)).to.equal(false);
    expect(serializedFingerprints.includes('first-user')).to.equal(false);
    expect(serializedFingerprints.includes('second-user')).to.equal(false);
    expect(harness.getState().pacMods.ownProxies[0].password).to.equal('');
  });

  it('does not invalidate apply for note-only PAC metadata changes', async () => {
    const harness = await createRuntimeHarness({
      pacMods: {
        ownProxies: [{
          enabled: true,
          type: 'HTTPS',
          host: 'proxy.example',
          port: 8443,
          note: 'before proxy note',
        }],
        whitelist: [{
          pattern: 'whitelist.example',
          enabled: true,
          note: 'before whitelist note',
        }],
        rules: [{
          pattern: 'rule.example',
          action: 'DIRECT',
          enabled: true,
          note: 'before rule note',
        }],
        torBrowser: {enabled: true},
      },
    });
    harness.resetCounts();
    const artifactRead = harness.blockCookedArtifactRead();
    const fingerprintBefore = harness.audit.createPacApplyFingerprint(
        harness.getState(),
    );

    const apply = harness.audit.applyCookedPacAndPersist({});
    await artifactRead.started;
    const model = await harness.callRpc('getPacMods');
    model.ownProxies[0].note = 'after proxy note';
    model.whitelist[0].note = 'after whitelist note';
    model.rules[0].note = 'after rule note';
    await harness.callRpc('setPacMods', {pacMods: model});
    const fingerprintAfter = harness.audit.createPacApplyFingerprint(
        harness.getState(),
    );
    artifactRead.release();

    const result = await apply;

    expect(result).to.include({ok: true, status: 'applied'});
    expect(fingerprintAfter).to.deep.equal(fingerprintBefore);
    expect(harness.counts.proxySettingsWrites).to.equal(1);
  });

  it('coalesces identical concurrent applies into one current write', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const artifactRead = harness.blockCookedArtifactRead();

    const first = harness.audit.applyCookedPacAndPersist({});
    await artifactRead.started;
    const second = harness.audit.applyCookedPacAndPersist({});
    artifactRead.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).to.include({ok: false, status: 'stale'});
    expect(secondResult).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(1);
  });

  it('keeps two identical concurrent refreshes conflict-free', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const download = harness.blockPacDownload();

    const first = harness.audit.executePeriodicUpdatePipeline({
      trigger: 'first-identical-refresh',
      applyIfSafe: true,
    });
    await download.started;
    const second = harness.audit.executePeriodicUpdatePipeline({
      trigger: 'second-identical-refresh',
      applyIfSafe: true,
    });
    download.release();

    const results = await Promise.all([first, second]);

    expect(results[0]).to.include({ok: false, status: 'skipped'});
    expect(results[0].error.code).to.equal('PAC_APPLY_STALE');
    expect(results[1]).to.include({
      ok: true,
      cookStatus: 'not_modified',
    });
    expect(results[1].autoApply).to.include({
      status: 'unchanged',
      applied: false,
    });
    expect(harness.counts.proxySettingsWrites).to.equal(0);
    expect(harness.counts.pacCooks).to.equal(0);
  });

  it('allows a valid apply after a stale operation', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    const artifactRead = harness.blockCookedArtifactRead();

    const staleApply = harness.audit.applyCookedPacAndPersist({});
    await artifactRead.started;
    await harness.context.mv3State.setCurrentPacProvider('onlyOwnSites');
    artifactRead.release();
    expectStaleWithoutProxyWrite(harness, await staleApply);

    await harness.context.mv3State.setCurrentPacProvider('Антизапрет');
    const validApply = await harness.audit.applyCookedPacAndPersist({});

    expect(validApply).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(1);
  });

  it('continues the apply queue after settings.set rejects', async () => {
    const harness = await createRuntimeHarness();
    harness.resetCounts();
    harness.failNextProxySettingsSet('Synthetic proxy set rejection.');

    const failed = await harness.audit.applyCookedPacAndPersist({});
    const recovered = await harness.audit.applyCookedPacAndPersist({});

    expect(failed).to.include({ok: false, status: 'error'});
    expect(failed.error.code).to.equal('PROXY_SET_FAILED');
    expect(recovered).to.include({ok: true, status: 'applied'});
    expect(harness.counts.proxySettingsWrites).to.equal(2);
    expect(harness.getState().proxyApply.status).to.equal('applied');
  });

  it('reconstructs freshness from durable state after worker restart', async () => {
    const firstWorker = await createRuntimeHarness();
    await firstWorker.audit.applyCookedPacAndPersist({});
    const durableState = firstWorker.getState();

    const restartedWorker = await createRuntimeHarness({
      initialState: durableState,
    });
    restartedWorker.resetCounts();
    const result = await restartedWorker.audit.applyCookedPacAndPersist({});

    expect(result).to.include({ok: true, status: 'applied'});
    expect(restartedWorker.counts.proxySettingsWrites).to.equal(1);
    expect(restartedWorker.getState().proxyApply.cookedPacSha256)
        .to.equal(durableState.cookedPacCache.cookedPacSha256);
  });

  it('keeps a pre-restart workflow stale after a durable clear', async () => {
    const firstWorker = await createRuntimeHarness();
    const oldWorkflow = await firstWorker.audit.beginPacWorkflow();
    const durableState = firstWorker.getState();

    const restartedWorker = await createRuntimeHarness({
      initialState: durableState,
    });
    restartedWorker.resetCounts();
    const clear = await restartedWorker.audit.clearProxyAndPersist();
    const stale = await restartedWorker.audit.applyCookedPacAndPersist(
        {},
        oldWorkflow,
    );
    const fresh = await restartedWorker.audit.applyCookedPacAndPersist({});

    expect(clear).to.include({ok: true, status: 'cleared'});
    expect(stale).to.include({ok: false, status: 'stale'});
    expect(fresh).to.include({ok: true, status: 'applied'});
    expect(restartedWorker.counts.proxySettingsClears).to.equal(1);
    expect(restartedWorker.counts.proxySettingsWrites).to.equal(1);
  });
});
