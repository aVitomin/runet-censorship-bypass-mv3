'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const {createRuntimeHarness} = require('./runtime-performance-harness');

const NOW = 100 * 60 * 60 * 1000;
const TARGET_URL = 'https://audit.example/health';

function clone(value) {

  return JSON.parse(JSON.stringify(value));

}

function createGate() {

  let release;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {markStarted, promise, release, started};

}

function getHealthAlarm(harness) {

  return harness.getAlarms().find((alarm) =>
    alarm.name === harness.context.mv3ProxyHealth.ALARM_NAME,
  ) || null;

}

function createTorPacMods(port = 9150) {

  const ifBrowserTor = port === 9150;
  return {
    localTor: {enabled: !ifBrowserTor, port},
    torBrowser: {enabled: ifBrowserTor, port},
    exceptions: [{
      pattern: 'audit.example',
      action: 'PROXY',
      enabled: true,
    }],
  };

}

function createOwnProxyPacMods(secret = '') {

  return {
    ownProxies: [{
      enabled: true,
      type: 'HTTPS',
      host: 'proxy.example',
      port: 8443,
      username: secret ? 'health-user' : '',
      password: secret,
    }],
    exceptions: [{
      pattern: 'audit.example',
      action: 'PROXY',
      enabled: true,
    }],
  };

}

async function createSeed(options = {}) {

  const clock = options.clock || {now: NOW};
  const pacMods = options.pacMods || createTorPacMods();
  const harness = await createRuntimeHarness({clock, pacMods});
  const state = harness.getState();
  const candidate = harness.context.mv3ProxyHealth.getCandidateSummary(
      state.pacMods,
  );
  const sessionStorage = harness.getSessionStorage();
  const sessionId = sessionStorage[
      harness.context.mv3ProxyHealth.SESSION_STORAGE_KEY
  ];
  return {candidate, clock, harness, pacMods, sessionId, sessionStorage, state};

}

function createHealth(seed, status, at, overrides = {}) {

  const ifOk = status === 'ok';
  const ifError = status === 'error';
  return Object.assign({
    status,
    lastCheckedAt: at,
    lastSuccessAt: ifOk ? at : null,
    lastErrorAt: ifError ? at : null,
    lastErrorCode: ifError ? 'net::ERR_PROXY_CONNECTION_FAILED' : null,
    lastErrorMessage: ifError ? 'net::ERR_PROXY_CONNECTION_FAILED' : null,
    lastErrorUrl: ifError ? 'audit.example' : null,
    candidateType: seed.candidate.type,
    candidateProxyType: seed.candidate.proxyType,
    candidateEndpoint: seed.candidate.endpoint,
    candidateKey: seed.candidate.key,
    candidateRevision: seed.state.pacModsRevision,
    targetOrigin: 'https://audit.example',
    sessionId: seed.sessionId,
    checkSequence: 7,
    retryStep: 0,
    nextCheckAt: null,
  }, overrides);

}

async function restartSeed(seed, options = {}) {

  const state = clone(seed.state);
  if (options.proxyHealth !== undefined) {
    state.proxyHealth = clone(options.proxyHealth);
  }
  return createRuntimeHarness({
    clock: seed.clock,
    fetch: options.fetch,
    initialAlarms: options.initialAlarms || [],
    initialSessionStorage: options.newBrowserSession ?
      {} :
      seed.sessionStorage,
    initialState: state,
    pacMods: state.pacMods,
  });

}

function createInjectedProbe(clock) {

  const probe = {
    calls: [],
    harness: null,
    result: 'success',
    async fetch(url) {

      probe.calls.push({
        candidate: clone(probe.harness.getState().proxyHealth),
        url,
      });
      if (probe.result === 'failure') {
        await probe.harness.audit.recordProxyHealthFailure({
          error: 'net::ERR_PROXY_CONNECTION_FAILED',
          timeStamp: clock.now,
          url,
        });
        throw new Error('Injected proxy failure.');
      }
      return {body: null};

    },
  };
  return probe;

}

async function runDueAutomaticCheck(harness, clock) {

  const health = harness.getState().proxyHealth;
  clock.now = health.nextCheckAt;
  return harness.audit.runAutomaticProxyHealthCheck({trigger: 'test'});

}

Mocha.describe('MV3 proxy-health supervisor', function() {

  Mocha.it('keeps a fresh healthy startup result and schedules its TTL',
      async function() {

        const seed = await createSeed();
        const successAt = seed.clock.now - 10 * 60 * 1000;
        const harness = await restartSeed(seed, {
          newBrowserSession: true,
          proxyHealth: createHealth(seed, 'ok', successAt),
        });

        Chai.expect(harness.getState().proxyHealth.status).to.equal('ok');
        Chai.expect(getHealthAlarm(harness).when).to.equal(
            successAt + harness.context.mv3ProxyHealth.HEALTHY_TTL_MS,
        );

      });

  Mocha.it('makes an expired healthy startup result stale and neutral',
      async function() {

        const seed = await createSeed();
        const harness = await restartSeed(seed, {
          proxyHealth: createHealth(
              seed,
              'ok',
              seed.clock.now - 61 * 60 * 1000,
          ),
        });

        Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');
        Chai.expect(getHealthAlarm(harness).when).to.equal(
            seed.clock.now + harness.context.mv3ProxyHealth.STARTUP_DELAY_MS,
        );

      });

  Mocha.it('makes a previous-browser-session failure stale', async function() {

    const seed = await createSeed();
    const harness = await restartSeed(seed, {
      newBrowserSession: true,
      proxyHealth: createHealth(seed, 'error', seed.clock.now - 1000),
    });

    Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');
    Chai.expect(harness.getActionState().setBadgeText.text).not.to.equal('!');
    Chai.expect(getHealthAlarm(harness).when).to.equal(
        seed.clock.now + harness.context.mv3ProxyHealth.STARTUP_DELAY_MS,
    );

  });

  Mocha.it('schedules a no-result startup when a current target exists',
      async function() {

        const seed = await createSeed();
        const unknown = createHealth(seed, 'unknown', null, {
          candidateKey: null,
          candidateRevision: null,
          lastCheckedAt: null,
          sessionId: null,
        });
        const harness = await restartSeed(seed, {proxyHealth: unknown});

        Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');
        Chai.expect(getHealthAlarm(harness).when).to.equal(
            seed.clock.now + harness.context.mv3ProxyHealth.STARTUP_DELAY_MS,
        );

      });

  Mocha.it('runs the startup probe only after reconstruction and its delay',
      async function() {

        const seed = await createSeed();
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;

        Chai.expect(probe.calls).to.have.length(0);
        Chai.expect(harness.counts.proxySettingsReads).to.be.at.least(1);
        const result = await runDueAutomaticCheck(harness, seed.clock);
        Chai.expect(result.status).to.equal('ok');
        Chai.expect(probe.calls).to.have.length(1);

      });

  Mocha.it('retries a failure after one minute and recovers automatically',
      async function() {

        const seed = await createSeed();
        const probe = createInjectedProbe(seed.clock);
        probe.result = 'failure';
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;

        await runDueAutomaticCheck(harness, seed.clock);
        const failure = harness.getState().proxyHealth;
        Chai.expect(failure).to.include({status: 'error', retryStep: 0});
        Chai.expect(failure.nextCheckAt - failure.lastErrorAt).to.equal(
            60 * 1000,
        );
        probe.result = 'success';
        const result = await runDueAutomaticCheck(harness, seed.clock);
        Chai.expect(result.status).to.equal('ok');
        Chai.expect(harness.getState().proxyHealth).to.include({
          status: 'ok',
          retryStep: 0,
        });

      });

  Mocha.it('uses the complete 1/5/15/30/60-minute failure backoff',
      async function() {

        const seed = await createSeed();
        const probe = createInjectedProbe(seed.clock);
        probe.result = 'failure';
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;
        const delays = [];
        for (let index = 0; index < 5; ++index) {
          await runDueAutomaticCheck(harness, seed.clock);
          const health = harness.getState().proxyHealth;
          delays.push((health.nextCheckAt - health.lastErrorAt) / 60000);
        }

        Chai.expect(delays).to.deep.equal([1, 5, 15, 30, 60]);

      });

  Mocha.it('caps continued failed retries at 60 minutes', async function() {

    const seed = await createSeed();
    const probe = createInjectedProbe(seed.clock);
    probe.result = 'failure';
    const harness = await restartSeed(seed, {
      fetch: (...args) => probe.fetch(...args),
      proxyHealth: createHealth(seed, 'error', seed.clock.now - 1000, {
        nextCheckAt: seed.clock.now,
        retryStep: 4,
      }),
    });
    probe.harness = harness;

    await runDueAutomaticCheck(harness, seed.clock);
    const health = harness.getState().proxyHealth;
    Chai.expect(health.retryStep).to.equal(4);
    Chai.expect(health.nextCheckAt - health.lastErrorAt).to.equal(60 * 60000);

  });

  Mocha.it('lets manual success reset backoff and schedule the healthy TTL',
      async function() {

        const seed = await createSeed();
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'error', seed.clock.now - 1000, {
            nextCheckAt: seed.clock.now + 60 * 60000,
            retryStep: 4,
          }),
        });
        probe.harness = harness;

        const result = await harness.callRpc('checkProxyHealth', {
          tabUrl: TARGET_URL,
        });
        const health = harness.getState().proxyHealth;
        Chai.expect(result.status).to.equal('ok');
        Chai.expect(health.retryStep).to.equal(0);
        Chai.expect(health.nextCheckAt - health.lastSuccessAt).to.equal(
            60 * 60000,
        );

      });

  Mocha.it('refreshes a healthy result when its TTL alarm becomes due',
      async function() {

        const seed = await createSeed();
        const successAt = seed.clock.now - 59 * 60000;
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'ok', successAt),
        });
        probe.harness = harness;

        await runDueAutomaticCheck(harness, seed.clock);
        const health = harness.getState().proxyHealth;
        Chai.expect(health.lastSuccessAt).to.equal(seed.clock.now);
        Chai.expect(health.nextCheckAt).to.equal(
            seed.clock.now + 60 * 60000,
        );

      });

  Mocha.it('reconstructs one current retry alarm across worker restart',
      async function() {

        const seed = await createSeed();
        const nextCheckAt = seed.clock.now + 15 * 60000;
        const health = createHealth(seed, 'error', seed.clock.now - 1000, {
          nextCheckAt,
          retryStep: 2,
        });
        const first = await restartSeed(seed, {proxyHealth: health});
        const restarted = await restartSeed(seed, {
          initialAlarms: first.getAlarms(),
          proxyHealth: first.getState().proxyHealth,
        });

        Chai.expect(restarted.getAlarms().filter((alarm) =>
          alarm.name === restarted.context.mv3ProxyHealth.ALARM_NAME,
        )).to.have.length(1);
        Chai.expect(getHealthAlarm(restarted).when).to.equal(nextCheckAt);

      });

  Mocha.it('does not duplicate alarms on repeated startup events',
      async function() {

        const seed = await createSeed();
        const harness = await restartSeed(seed, {
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        const healthAlarmCreates = harness.counts.alarmCreates;
        harness.events.startup.dispatch();
        harness.events.startup.dispatch();
        await harness.waitForAsyncWork();
        await harness.waitForAsyncWork();

        Chai.expect(harness.getAlarms().filter((alarm) =>
          alarm.name === harness.context.mv3ProxyHealth.ALARM_NAME,
        )).to.have.length(1);
        Chai.expect(harness.counts.alarmCreates).to.equal(healthAlarmCreates);

      });

  Mocha.it('invalidates health on candidate change and schedules after apply',
      async function() {

        const seed = await createSeed();
        const harness = await restartSeed(seed, {
          proxyHealth: createHealth(seed, 'ok', seed.clock.now - 1000),
        });
        const nextMods = createTorPacMods(9250);
        await harness.callRpc('setPacMods', {pacMods: nextMods});
        Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');
        Chai.expect(getHealthAlarm(harness)).to.equal(null);

        await harness.installPacVersion({pacMods: nextMods});
        const applied = await harness.callRpc('applyCookedPac');
        Chai.expect(applied.status).to.equal('applied');
        Chai.expect(getHealthAlarm(harness).when).to.equal(
            seed.clock.now + harness.context.mv3ProxyHealth.STARTUP_DELAY_MS,
        );

      });

  Mocha.it('prevents an older automatic result from overwriting manual success',
      async function() {

        const seed = await createSeed();
        const firstProbe = createGate();
        let calls = 0;
        const harness = await restartSeed(seed, {
          fetch(url, init) {

            ++calls;
            if (calls > 1) {
              return Promise.resolve({body: null});
            }
            firstProbe.markStarted();
            return new Promise((resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                const error = new Error('Superseded automatic check.');
                error.name = 'AbortError';
                reject(error);
              });
            });

          },
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        seed.clock.now = harness.getState().proxyHealth.nextCheckAt;
        const automatic = harness.audit.runAutomaticProxyHealthCheck({
          trigger: 'test',
        });
        await firstProbe.started;
        const manual = harness.callRpc('checkProxyHealth', {tabUrl: TARGET_URL});
        const [, manualResult] = await Promise.all([automatic, manual]);

        Chai.expect(manualResult.status).to.equal('ok');
        Chai.expect(harness.getState().proxyHealth.status).to.equal('ok');
        Chai.expect(calls).to.equal(2);

      });

  Mocha.it('checks the configured Tor Browser 9150 candidate exactly',
      async function() {

        const seed = await createSeed({pacMods: createTorPacMods(9150)});
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;
        await runDueAutomaticCheck(harness, seed.clock);

        Chai.expect(probe.calls[0].candidate).to.include({
          candidateEndpoint: '127.0.0.1:9150',
          candidateType: 'torBrowser',
        });

      });

  Mocha.it('keeps configured 9050 isolated from Tor Browser 9150',
      async function() {

        const seed = await createSeed({pacMods: createTorPacMods(9050)});
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;
        await runDueAutomaticCheck(harness, seed.clock);
        const candidates = harness.context.mv3PacMods.getProxyRuleCandidates(
            harness.getState().pacMods,
        );

        Chai.expect(probe.calls[0].candidate).to.include({
          candidateEndpoint: '127.0.0.1:9050',
          candidateType: 'localTor',
        });
        Chai.expect(candidates.join(';')).not.to.include('9150');

      });

  Mocha.it('does not cross-contaminate Tor and own-proxy health',
      async function() {

        const ownSeed = await createSeed({pacMods: createOwnProxyPacMods()});
        const torSeed = await createSeed();
        const torHealth = createHealth(torSeed, 'ok', ownSeed.clock.now - 1000, {
          candidateRevision: ownSeed.state.pacModsRevision,
          targetOrigin: 'https://audit.example',
        });
        const harness = await restartSeed(ownSeed, {proxyHealth: torHealth});

        Chai.expect(harness.getState().proxyHealth).to.include({
          status: 'unknown',
          candidateType: 'ownProxy',
          candidateEndpoint: 'proxy.example:8443',
        });

      });

  Mocha.it('normalizes legacy beta1 health safely without a red warning',
      async function() {

        const seed = await createSeed();
        const harness = await restartSeed(seed, {
          proxyHealth: {
            status: 'error',
            lastCheckedAt: seed.clock.now - 1000,
            lastErrorAt: seed.clock.now - 1000,
            lastErrorCode: 'net::ERR_PROXY_CONNECTION_FAILED',
            candidateType: 'torBrowser',
            candidateEndpoint: '127.0.0.1:9150',
            targetOrigin: 'https://audit.example',
          },
        });
        const health = await harness.callRpc('getProxyHealth');

        Chai.expect(health.status).to.equal('unknown');
        Chai.expect(harness.getActionState().setBadgeText.text).not.to.equal('!');

      });

  Mocha.it('cancels health scheduling when no candidate remains',
      async function() {

        const seed = await createSeed();
        const state = clone(seed.state);
        state.pacMods = seed.harness.context.mv3PacMods.normalizePacMods({
          exceptions: [{
            pattern: 'audit.example',
            action: 'PROXY',
            enabled: true,
          }],
        });
        state.pacModsRevision += 1;
        state.proxyHealth = createHealth(seed, 'error', seed.clock.now - 1000);
        const harness = await createRuntimeHarness({
          clock: seed.clock,
          initialSessionStorage: seed.sessionStorage,
          initialState: state,
          pacMods: state.pacMods,
        });

        Chai.expect(harness.getState().proxyHealth.status).to.equal('unknown');
        Chai.expect(getHealthAlarm(harness)).to.equal(null);

      });

  Mocha.it('never changes PAC, proxy ownership, or A/P/D during health checks',
      async function() {

        const seed = await createSeed();
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;
        const before = harness.getState();
        harness.resetCounts();
        await runDueAutomaticCheck(harness, seed.clock);
        const after = harness.getState();

        Chai.expect(after.pacMods).to.deep.equal(before.pacMods);
        Chai.expect(after.proxyApply).to.deep.equal(before.proxyApply);
        Chai.expect(harness.counts.proxySettingsWrites).to.equal(0);
        Chai.expect(harness.counts.proxySettingsClears).to.equal(0);

      });

  Mocha.it('keeps own-proxy passwords out of health state and RPC/UI models',
      async function() {

        const secret = ['health', 'secret', 'fixture'].join('-');
        const seed = await createSeed({
          pacMods: createOwnProxyPacMods(secret),
        });
        const probe = createInjectedProbe(seed.clock);
        const harness = await restartSeed(seed, {
          fetch: (...args) => probe.fetch(...args),
          proxyHealth: createHealth(seed, 'unknown', null, {
            lastCheckedAt: null,
          }),
        });
        probe.harness = harness;
        await runDueAutomaticCheck(harness, seed.clock);
        const health = harness.getState().proxyHealth;
        const rpcHealth = await harness.callRpc('getProxyHealth');
        const settings = await harness.callRpc('getState');
        const serialized = JSON.stringify({
          health,
          rpcHealth,
          uiHealth: settings.reliability.proxyHealth,
        });

        Chai.expect(serialized).not.to.include(secret);
        Chai.expect(serialized).not.to.include('password');
        Chai.expect(health.candidateKey).to.equal(
            'ownProxy|HTTPS|proxy.example:8443',
        );

      });

});
