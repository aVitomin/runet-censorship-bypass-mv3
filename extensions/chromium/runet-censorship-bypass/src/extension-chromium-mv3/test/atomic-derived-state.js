'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Fs = require('fs');
const Mocha = require('mocha');
const Path = require('path');
const Vm = require('vm');
const {createRuntimeHarness} = require('./runtime-performance-harness');

function clone(value) {

  return JSON.parse(JSON.stringify(value));

}

function getHostRules(state) {

  return state.pacMods.exceptions.concat(state.pacMods.rules);

}

function createGate() {

  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {markStarted, promise, release, started};

}

Mocha.describe('MV3 atomic derived-state callers', function() {

  Mocha.it('retains concurrent popup rules for different hosts',
      async function() {

        const harness = await createRuntimeHarness();
        await Promise.all([
          harness.callRpc('updatePopupDraft', {
            tabUrl: 'https://audit.example/path',
            draft: {siteMode: 'direct'},
          }),
          harness.callRpc('updatePopupDraft', {
            tabUrl: 'https://background.example/path',
            draft: {siteMode: 'direct'},
          }),
        ]);

        const patterns = getHostRules(harness.getState())
            .filter((rule) => rule.enabled && rule.action === 'DIRECT')
            .map((rule) => rule.pattern);
        Chai.expect(patterns).to.include.members([
          'audit.example',
          'background.example',
        ]);

      });

  Mocha.it('retains concurrent custom-provider additions', async function() {

    const harness = await createRuntimeHarness();
    const results = await Promise.all([
      harness.callRpc('addCustomPacProvider', {
        label: 'First provider',
        urls: ['https://first-provider.example/proxy.pac'],
      }),
      harness.callRpc('addCustomPacProvider', {
        label: 'Second provider',
        urls: ['https://second-provider.example/proxy.pac'],
      }),
    ]);
    const state = harness.getState();

    Chai.expect(state.customPacProviders.map((provider) => provider.label))
        .to.include.members(['First provider', 'Second provider']);
    Chai.expect(new Set(
        state.customPacProviders.map((provider) => provider.key),
    ).size).to.equal(2);
    Chai.expect(results.map((result) => result.provider.key))
        .to.have.length(2);

  });

  Mocha.it('merges concurrent custom-provider updates in call order',
      async function() {

        const harness = await createRuntimeHarness();
        const added = await harness.callRpc('addCustomPacProvider', {
          label: 'Original provider',
          urls: ['https://provider-update.example/proxy.pac'],
        });
        const key = added.provider.key;

        await Promise.all([
          harness.callRpc('updateCustomPacProvider', {
            key,
            label: 'Renamed provider',
          }),
          harness.callRpc('updateCustomPacProvider', {
            key,
            enabled: false,
          }),
        ]);

        const provider = harness.getState().customPacProviders
            .find((item) => item.key === key);
        Chai.expect(provider).to.include({
          label: 'Renamed provider',
          enabled: false,
        });

      });

  Mocha.it('orders provider selection before a concurrent deletion',
      async function() {

        const harness = await createRuntimeHarness();
        const added = await harness.callRpc('addCustomPacProvider', {
          label: 'Temporary provider',
          urls: ['https://provider-delete.example/proxy.pac'],
        });
        const key = added.provider.key;

        await Promise.all([
          harness.callRpc('setCurrentPacProvider', {providerKey: key}),
          harness.callRpc('deleteCustomPacProvider', {key}),
        ]);

        const state = harness.getState();
        Chai.expect(state.currentPacProviderKey).to.equal(null);
        Chai.expect(state.customPacProviders.some((item) => item.key === key))
            .to.equal(false);

      });

  Mocha.it('rejects provider selection queued after provider deletion',
      async function() {

        const harness = await createRuntimeHarness();
        const added = await harness.callRpc('addCustomPacProvider', {
          label: 'Temporary provider',
          urls: ['https://provider-delete.example/proxy.pac'],
        });
        const key = added.provider.key;
        const previousProviderKey = harness.getState().currentPacProviderKey;

        const deletion = harness.callRpc('deleteCustomPacProvider', {key});
        const selection = harness.callRpc('setCurrentPacProvider', {
          providerKey: key,
        }).catch((err) => err);
        const [, error] = await Promise.all([deletion, selection]);

        Chai.expect(error).to.deep.include({
          code: 'INVALID_PARAMS',
          message: 'Unknown PAC provider.',
        });
        Chai.expect(harness.getState().currentPacProviderKey)
            .to.equal(previousProviderKey);

      });

  Mocha.it('uses the latest periodic interval when committing completion',
      async function() {

        const harness = await createRuntimeHarness();
        const gate = createGate();
        const successfulUpdateAt = 1000;
        const update = harness.context.mv3PeriodicUpdate.runUpdate({
          trigger: 'manual',
          async execute() {

            gate.markStarted();
            await gate.promise;
            return {
              ok: true,
              status: 'success',
              providerKey: 'Антизапрет',
              successfulUpdateAt,
            };

          },
        });
        await gate.started;
        await harness.context.mv3State.setPeriodicUpdateInterval(60);
        gate.release();
        await update;

        Chai.expect(harness.getState().periodicUpdate).to.include({
          intervalMinutes: 60,
          nextRunAt: successfulUpdateAt + 60 * 60 * 1000,
        });

      });

  Mocha.it('preserves a newer periodic disable when committing completion',
      async function() {

        const harness = await createRuntimeHarness();
        const gate = createGate();
        const update = harness.context.mv3PeriodicUpdate.runUpdate({
          trigger: 'manual',
          async execute() {

            gate.markStarted();
            await gate.promise;
            return {
              ok: true,
              status: 'success',
              providerKey: 'Антизапрет',
              successfulUpdateAt: 1000,
            };

          },
        });
        await gate.started;
        await harness.context.mv3PeriodicUpdate.setEnabled(false);
        gate.release();
        await update;

        Chai.expect(harness.getState().periodicUpdate).to.include({
          enabled: false,
          nextRunAt: null,
        });

      });

  Mocha.it('claims the periodic in-flight operation before its first read',
      async function() {

        const harness = await createRuntimeHarness();
        const gate = createGate();
        let executions = 0;
        const first = harness.context.mv3PeriodicUpdate.runUpdate({
          trigger: 'manual',
          async execute() {

            executions += 1;
            gate.markStarted();
            await gate.promise;
            return {ok: true, status: 'success'};

          },
        });
        const second = await harness.context.mv3PeriodicUpdate.runUpdate({
          trigger: 'manual',
          async execute() {

            executions += 1;
            return {ok: true, status: 'success'};

          },
        });
        await gate.started;
        gate.release();
        await first;

        Chai.expect(second).to.deep.include({
          ok: false,
          status: 'error',
          trigger: 'manual',
        });
        Chai.expect(executions).to.equal(1);

      });

  Mocha.it('does not let a stale health-check completion undo a reset',
      async function() {

        const fetchGate = createGate();
        const harness = await createRuntimeHarness({
          async fetch() {

            fetchGate.markStarted();
            await fetchGate.promise;
            throw new Error('Synthetic inconclusive health check.');

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
        await harness.context.mv3State.setProxyApplyState({status: 'applied'});

        const check = harness.callRpc('checkProxyHealth', {
          tabUrl: 'https://audit.example/path',
        });
        await fetchGate.started;
        Chai.expect(harness.getState().proxyHealth.status).to.equal('checking');
        await harness.context.mv3State.resetProxyHealth();
        fetchGate.release();
        const result = await check;

        Chai.expect(result.status).to.equal('inconclusive');
        Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');

      });

  Mocha.it('rechecks fill-missing migration against the latest durable state',
      async function() {

        const harness = await createRuntimeHarness();
        const gate = createGate();
        let durableState = {
          currentPacProviderKey: null,
          pacUpdatePeriodInMinutes: 12,
          pacMods: clone(harness.context.mv3PacMods.DEFAULT_PAC_MODS),
          notificationPrefs: {
            pacError: true,
            extError: true,
            noControl: true,
          },
          legacyMigration: {},
        };
        const fakeState = {
          async loadState() {

            return clone(durableState);

          },
          async setLegacyMigrationState(patch) {

            durableState.legacyMigration = Object.assign(
                {},
                durableState.legacyMigration,
                clone(patch),
            );
            return clone(durableState.legacyMigration);

          },
          async updateStateAtomically(mutator) {

            const patch = mutator(clone(durableState));
            durableState = Object.assign({}, durableState, clone(patch));
            return clone(durableState);

          },
        };
        const fakeAudit = {
          async runAudit() {

            gate.markStarted();
            await gate.promise;
            return {
              detected: true,
              proposedMigration: {
                applyValues: {currentPacProviderKey: 'Антизапрет'},
                cannotMigrate: [],
                warnings: [],
              },
            };

          },
          sanitizeValue(value) {

            return value;

          },
        };
        const context = Vm.createContext({
          JSON,
          Object,
          Promise,
          TypeError,
          mv3LegacyMigrationAudit: fakeAudit,
          mv3PacMods: harness.context.mv3PacMods,
          mv3State: fakeState,
        });
        context.self = context;
        const sourcePath = Path.resolve(
            __dirname,
            '..',
            'background',
            'legacy-migration-apply.js',
        );
        Vm.runInContext(Fs.readFileSync(sourcePath, 'utf8'), context, {
          filename: sourcePath,
        });

        const apply = context.mv3LegacyMigrationApply.applyLegacyMigration({
          strategy: 'fillMissing',
          fields: ['currentPacProviderKey'],
        });
        await gate.started;
        durableState.currentPacProviderKey = 'onlyOwnSites';
        gate.release();
        const result = await apply;

        Chai.expect(result).to.deep.include({ok: true, status: 'partial'});
        Chai.expect(durableState.currentPacProviderKey).to.equal('onlyOwnSites');
        Chai.expect(result.appliedFields).to.deep.equal([]);
        Chai.expect(result.skippedFields.some((item) =>
          item.field === 'currentPacProviderKey',
        )).to.equal(true);

      });

});
