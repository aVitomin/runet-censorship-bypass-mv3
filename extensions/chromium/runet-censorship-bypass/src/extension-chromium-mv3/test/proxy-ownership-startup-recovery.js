'use strict';


const Crypto = require('crypto');
const Chai = require('chai');
const Mocha = require('mocha');
const {createRuntimeHarness} = require('./runtime-performance-harness');

const SYSTEM_PROXY_DETAILS = Object.freeze({
  levelOfControl: 'controllable_by_this_extension',
  value: {mode: 'system'},
});

function sha256(text) {

  return Crypto.createHash('sha256').update(text).digest('hex');

}

async function createAppliedState(options = {}) {

  const harness = await createRuntimeHarness(options);
  return harness.getState();

}

function restartAppliedState(state, options = {}) {

  return createRuntimeHarness(Object.assign({
    initialProxyDetails: SYSTEM_PROXY_DETAILS,
    initialState: state,
    pacMods: state.pacMods,
  }, options));

}

function createTorPacMods() {

  return {
    torBrowser: {enabled: true, port: 9150},
    exceptions: [{
      pattern: 'audit.example',
      action: 'PROXY',
      enabled: true,
    }],
  };

}

Mocha.describe('MV3 startup proxy-ownership recovery', function() {
  Mocha.it('restores an applied PAC when live system proxy is controllable',
      async function() {

        const state = await createAppliedState();
        const harness = await restartAppliedState(state);

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(1);
        Chai.expect(harness.getProxyDetails().levelOfControl)
            .to.equal('controlled_by_this_extension');
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('pac_script');
        Chai.expect(harness.getState().proxyApply.status).to.equal('applied');

      });

  Mocha.it('restores the exact current artifact without downloading or cooking',
      async function() {

        const state = await createAppliedState();
        const harness = await restartAppliedState(state);
        const values = harness.getProxySettingsSetValues();

        Chai.expect(values).to.have.length(1);
        Chai.expect(sha256(values[0].pacScript.data))
            .to.equal(state.proxyApply.cookedPacSha256);
        Chai.expect(state.proxyApply.cookedPacSha256)
            .to.equal(state.cookedPacCache.cookedPacSha256);
        Chai.expect(harness.counts.pacDownloads).to.equal(0);
        Chai.expect(harness.counts.pacCooks).to.equal(0);

      });

  Mocha.it('does not restore persisted cleared intent', async function() {

    const state = await createAppliedState();
    state.proxyApply.status = 'cleared';
    state.proxyApply.clearedAt = state.proxyApply.appliedAt + 1;
    const harness = await restartAppliedState(state);

    Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
    Chai.expect(harness.getProxyDetails().value.mode).to.equal('system');
    Chai.expect(harness.getState().proxyApply.status).to.equal('cleared');

  });

  Mocha.it('clears a live RUCB PAC for persisted cleared intent on startup',
      async function() {

        const state = await createAppliedState();
        state.proxyApply.status = 'cleared';
        state.proxyApply.clearedAt = state.proxyApply.appliedAt + 1;
        const harness = await createRuntimeHarness({
          initialProxyDetails: {
            levelOfControl: 'controlled_by_this_extension',
            value: {
              mode: 'pac_script',
              pacScript: {data: 'resurfaced PAC', mandatory: false},
            },
          },
          initialState: state,
          pacMods: state.pacMods,
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.counts.proxySettingsClears).to.equal(1);
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('direct');
        Chai.expect(harness.getState().proxyApply.status).to.equal('cleared');

      });

  Mocha.it('defers startup Clear under external ownership and reconciles release',
      async function() {

        const state = await createAppliedState();
        state.proxyApply.status = 'cleared';
        state.proxyApply.clearedAt = state.proxyApply.appliedAt + 1;
        const harness = await createRuntimeHarness({
          initialProxyDetails: {
            levelOfControl: 'controlled_by_other_extensions',
            value: {mode: 'fixed_servers'},
          },
          initialState: state,
          pacMods: state.pacMods,
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.counts.proxySettingsClears).to.equal(0);

        await harness.changeProxyDetails({
          levelOfControl: 'controlled_by_this_extension',
          value: {
            mode: 'pac_script',
            pacScript: {data: 'resurfaced PAC', mandatory: false},
          },
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.counts.proxySettingsClears).to.equal(1);
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('direct');
        Chai.expect(harness.getState().proxyApply.status).to.equal('cleared');

      });

  Mocha.it('finishes interrupted legacy clearing intent on startup',
      async function() {

        const state = await createAppliedState();
        state.proxyApply.status = 'clearing';
        state.proxyApply.clearedAt = null;
        const harness = await createRuntimeHarness({
          initialProxyDetails: {
            levelOfControl: 'controlled_by_this_extension',
            value: {
              mode: 'pac_script',
              pacScript: {data: 'resurfaced PAC', mandatory: false},
            },
          },
          initialState: state,
          pacMods: state.pacMods,
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.counts.proxySettingsClears).to.equal(1);
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('direct');
        Chai.expect(harness.getState().proxyApply.status).to.equal('cleared');
        Chai.expect(harness.getState().proxyApply.clearedAt).to.be.a('number');

      });

  Mocha.it('does not restore without a previous successful Apply',
      async function() {

        const state = await createAppliedState();
        state.proxyApply = {status: 'idle'};
        const harness = await restartAppliedState(state);

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('system');
        Chai.expect(harness.getState().proxyApply.status).to.equal('idle');

      });

  Mocha.it('rejects mismatched applied PAC provenance', async function() {

    const state = await createAppliedState();
    state.proxyApply.cookedPacSha256 = 'stale-applied-pac-sha256';
    const harness = await restartAppliedState(state);

    Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
    Chai.expect(harness.getProxyDetails().value.mode).to.equal('system');
    Chai.expect(harness.getState().proxyApply.cookedPacSha256)
        .to.equal('stale-applied-pac-sha256');

  });

  Mocha.it('never takes control from another extension', async function() {

    const state = await createAppliedState();
    const harness = await restartAppliedState(state, {
      initialProxyDetails: {
        levelOfControl: 'controlled_by_other_extensions',
        value: {mode: 'fixed_servers'},
      },
    });

    Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
    Chai.expect(harness.getProxyDetails().levelOfControl)
        .to.equal('controlled_by_other_extensions');
    Chai.expect(harness.getState().proxyControl.canControl).to.equal(false);

  });

  Mocha.it('does not write proxy settings when policy makes them uncontrollable',
      async function() {

        const state = await createAppliedState();
        const harness = await restartAppliedState(state, {
          initialProxyDetails: {
            levelOfControl: 'not_controllable',
            value: {mode: 'system'},
          },
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.getState().proxyControl.levelOfControl)
            .to.equal('not_controllable');

      });

  Mocha.it('does not redundantly reapply while already controlling the PAC',
      async function() {

        const state = await createAppliedState();
        const harness = await createRuntimeHarness({
          initialState: state,
          pacMods: state.pacMods,
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.getState().proxyControl.controlledByThisExtension)
            .to.equal(true);

      });

  Mocha.it('does not reapply on worker restart or duplicate startup events',
      async function() {

        const state = await createAppliedState();
        const first = await restartAppliedState(state);
        const second = await createRuntimeHarness({
          initialProxyDetails: first.getProxyDetails(),
          initialState: first.getState(),
          pacMods: first.getState().pacMods,
        });

        second.events.startup.dispatch();
        second.events.startup.dispatch();
        await second.callRpc('getState');

        Chai.expect(first.counts.proxySettingsWrites).to.equal(1);
        Chai.expect(second.counts.proxySettingsWrites).to.equal(0);

      });

  Mocha.it('lets Clear during startup reconciliation win', async function() {

    const state = await createAppliedState();
    let clear;
    const harness = await restartAppliedState(state, {
      onProxySettingsRead(context) {

        clear = context.__runtimeAudit.RPC_METHODS.clearProxy();

      },
    });
    const result = await clear;

    Chai.expect(result).to.include({ok: true, status: 'cleared'});
    Chai.expect(harness.getState().proxyApply.status).to.equal('cleared');
    Chai.expect(harness.getProxyDetails().value.mode).to.equal('system');
    Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
    Chai.expect(harness.counts.proxySettingsClears).to.equal(0);

  });

  Mocha.it('lets a newer manual Apply supersede startup restoration',
      async function() {

        const state = await createAppliedState();
        let manualApply;
        const harness = await restartAppliedState(state, {
          onProxySettingsRead(context) {

            manualApply = context.__runtimeAudit.RPC_METHODS.applyCookedPac({});

          },
        });
        const result = await manualApply;

        Chai.expect(result).to.include({ok: true, status: 'applied'});
        Chai.expect(harness.counts.proxySettingsWrites).to.equal(1);
        Chai.expect(harness.getState().pacWorkflowGeneration)
            .to.equal(state.pacWorkflowGeneration + 1);
        Chai.expect(harness.getState().proxyApply.status).to.equal('applied');

      });

  Mocha.it('invalidates restoration when proxy configuration changes',
      async function() {

        const state = await createAppliedState();
        let configurationChange;
        const harness = await restartAppliedState(state, {
          onProxySettingsRead(context) {

            const model = context.mv3PacMods.serializePacModsForRpc(
                state.pacMods,
                state.pacModsRevision,
            );
            model.exceptions = [{
              pattern: 'configuration-change.example',
              action: 'DIRECT',
              enabled: true,
            }];
            configurationChange =
              context.__runtimeAudit.RPC_METHODS.setPacMods({pacMods: model});

          },
        });
        await configurationChange;

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.getState().pacWorkflowGeneration)
            .to.equal(state.pacWorkflowGeneration + 1);
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('system');

      });

  Mocha.it('records a failed restoration without claiming success',
      async function() {

        const state = await createAppliedState();
        const harness = await restartAppliedState(state, {
          initialProxySettingsSetError: 'Synthetic startup restoration failure.',
        });

        Chai.expect(harness.counts.proxySettingsWrites).to.equal(1);
        Chai.expect(harness.getState().proxyApply.status).to.equal('error');
        Chai.expect(harness.getState().proxyApply.error.code)
            .to.equal('PROXY_SET_FAILED');
        Chai.expect(harness.getState().proxyControl.controlledByThisExtension)
            .to.equal(false);
        Chai.expect(harness.getProxyDetails().value.mode).to.equal('system');
        Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');
        Chai.expect(harness.getAlarms().filter((alarm) =>
          alarm.name === harness.context.mv3ProxyHealth.ALARM_NAME,
        )).to.have.length(0);

      });

  Mocha.it('makes the existing health supervisor relevant after restoration',
      async function() {

        const state = await createAppliedState({pacMods: createTorPacMods()});
        state.proxyHealth.targetOrigin = 'https://audit.example';
        const harness = await restartAppliedState(state, {
          initialSessionStorage: {},
        });
        const health = harness.getState().proxyHealth;

        Chai.expect(health).to.include({
          status: 'unknown',
          candidateType: 'torBrowser',
          candidateEndpoint: '127.0.0.1:9150',
          targetOrigin: 'https://audit.example',
        });
        Chai.expect(health.nextCheckAt).to.be.a('number');
        Chai.expect(harness.counts.proxySettingsWrites).to.equal(1);

      });

  Mocha.it('schedules exactly one normal startup health alarm after restoration',
      async function() {

        const state = await createAppliedState({pacMods: createTorPacMods()});
        state.proxyHealth.targetOrigin = 'https://audit.example';
        const harness = await restartAppliedState(state, {
          initialSessionStorage: {},
        });
        const alarmName = harness.context.mv3ProxyHealth.ALARM_NAME;
        const healthAlarms = harness.getAlarms().filter((alarm) =>
          alarm.name === alarmName,
        );

        Chai.expect(healthAlarms).to.have.length(1);
        Chai.expect(harness.getAlarmCreateCount(alarmName)).to.equal(1);
        Chai.expect(healthAlarms[0].scheduledTime)
            .to.equal(harness.getState().proxyHealth.nextCheckAt);

      });
});
