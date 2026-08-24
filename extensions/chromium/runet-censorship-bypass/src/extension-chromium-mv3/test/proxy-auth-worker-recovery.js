'use strict';


const Chai = require('chai');
const Crypto = require('crypto');
const Mocha = require('mocha');
const {createRuntimeHarness} = require('./runtime-performance-harness');

const AUTH_HOST = 'proxy.example';
const AUTH_PORT = 8443;
const SESSION_STORAGE_KEY = 'mv3ProxyAuthAttempts';

function createSecret(label) {

  return `${label}-${Crypto.randomBytes(24).toString('base64url')}`;

}

function createProxy(host, port, username, password) {

  return {
    enabled: true,
    host,
    note: 'Proxy auth retry test',
    password,
    port,
    type: 'PROXY',
    username,
    useAsDirectReplacement: false,
  };

}

function createAuthState(harness, proxies, enabled = true) {

  return {
    proxyAuth: {enabled},
    pacMods: harness.context.mv3PacMods.normalizePacMods({ownProxies: proxies}),
  };

}

function createDetails(requestId, host = AUTH_HOST, port = AUTH_PORT) {

  return {
    challenger: {host, port},
    isProxy: true,
    requestId,
  };

}

function getAuthEntries(harness) {

  const session = harness.getSessionStorage();
  return session[SESSION_STORAGE_KEY] || [];

}

function hasCredentials(result) {

  return Boolean(result && result.response && result.response.authCredentials);

}

async function authorize(harness, state, details) {

  return harness.context.mv3ProxyAuth.handleProxyAuthRequired(details, state);

}

Mocha.describe('MV3 proxy-auth worker retry recovery', function() {

  Mocha.it('allows two matching responses and rejects the third',
      async function() {

        const secret = createSecret('normal-limit');
        const harness = await createRuntimeHarness();
        const state = createAuthState(harness, [
          createProxy(AUTH_HOST, AUTH_PORT, 'retry-user', secret),
        ]);
        const details = createDetails('normal-limit-request');

        const first = await authorize(harness, state, details);
        const second = await authorize(harness, state, details);
        const third = await authorize(harness, state, details);

        Chai.expect(hasCredentials(first)).to.equal(true);
        Chai.expect(hasCredentials(second)).to.equal(true);
        Chai.expect(hasCredentials(third)).to.equal(false);
        Chai.expect(third.response.cancel).to.equal(true);
        Chai.expect(third.event.type).to.equal('retry_limit');
        Chai.expect(getAuthEntries(harness)).to.deep.equal([{
          challengerKey: `${AUTH_HOST}:${AUTH_PORT}`,
          count: 2,
          requestId: details.requestId,
          updatedAt: getAuthEntries(harness)[0].updatedAt,
        }]);

      });

  Mocha.it('preserves the count across worker recreation but not a new session',
      async function() {

        const secret = createSecret('worker-restart');
        const firstHarness = await createRuntimeHarness();
        const firstState = createAuthState(firstHarness, [
          createProxy(AUTH_HOST, AUTH_PORT, 'restart-user', secret),
        ]);
        const details = createDetails('worker-restart-request');
        Chai.expect(hasCredentials(
            await authorize(firstHarness, firstState, details),
        )).to.equal(true);

        const restartedHarness = await createRuntimeHarness({
          initialSessionStorage: firstHarness.getSessionStorage(),
        });
        const restartedState = createAuthState(restartedHarness, [
          createProxy(AUTH_HOST, AUTH_PORT, 'restart-user', secret),
        ]);
        const second = await authorize(restartedHarness, restartedState, details);
        const third = await authorize(restartedHarness, restartedState, details);
        Chai.expect(hasCredentials(second)).to.equal(true);
        Chai.expect(hasCredentials(third)).to.equal(false);
        Chai.expect(third.event.type).to.equal('retry_limit');

        const newSessionHarness = await createRuntimeHarness();
        const newSessionState = createAuthState(newSessionHarness, [
          createProxy(AUTH_HOST, AUTH_PORT, 'restart-user', secret),
        ]);
        Chai.expect(hasCredentials(
            await authorize(newSessionHarness, newSessionState, details),
        )).to.equal(true);

      });

  Mocha.it('completion clears only the completed request', async function() {

    const secret = createSecret('completion');
    const harness = await createRuntimeHarness();
    const state = createAuthState(harness, [
      createProxy(AUTH_HOST, AUTH_PORT, 'completion-user', secret),
    ]);
    await authorize(harness, state, createDetails('completed-request'));
    await authorize(harness, state, createDetails('concurrent-request'));

    harness.events.webCompleted.dispatch({requestId: 'completed-request'});
    await harness.waitForAsyncWork();

    Chai.expect(getAuthEntries(harness).map((entry) => entry.requestId))
        .to.deep.equal(['concurrent-request']);
    const writesAfterCleanup = harness.counts.storageSets;
    harness.events.webCompleted.dispatch({requestId: 'untracked-request'});
    await harness.waitForAsyncWork();
    Chai.expect(harness.counts.storageSets).to.equal(writesAfterCleanup);

  });

  Mocha.it('error completion clears only the failed request', async function() {

    const secret = createSecret('error-completion');
    const harness = await createRuntimeHarness();
    const state = createAuthState(harness, [
      createProxy(AUTH_HOST, AUTH_PORT, 'error-user', secret),
    ]);
    await authorize(harness, state, createDetails('failed-request'));
    await authorize(harness, state, createDetails('surviving-request'));

    harness.events.webError.dispatch({
      error: 'net::ERR_ABORTED',
      requestId: 'failed-request',
    });
    await harness.waitForAsyncWork();

    Chai.expect(getAuthEntries(harness).map((entry) => entry.requestId))
        .to.deep.equal(['surviving-request']);

  });

  Mocha.it('expires stale retry state before evaluating a new attempt',
      async function() {

        const clock = {now: 2000000};
        const harness = await createRuntimeHarness({
          clock,
          initialSessionStorage: {
            [SESSION_STORAGE_KEY]: [{
              challengerKey: `${AUTH_HOST}:${AUTH_PORT}`,
              count: 2,
              requestId: 'expired-request',
              updatedAt: clock.now - 10 * 60 * 1000 - 1,
            }],
          },
        });
        const state = createAuthState(harness, [
          createProxy(
              AUTH_HOST,
              AUTH_PORT,
              'expiry-user',
              createSecret('expiry'),
          ),
        ]);

        const result = await authorize(
            harness,
            state,
            createDetails('expired-request'),
        );
        Chai.expect(hasCredentials(result)).to.equal(true);
        Chai.expect(getAuthEntries(harness)[0].count).to.equal(1);
        Chai.expect(getAuthEntries(harness)[0].updatedAt).to.equal(clock.now);

      });

  Mocha.it('isolates request IDs and normalized challenger endpoints',
      async function() {

        const secret = createSecret('isolation');
        const harness = await createRuntimeHarness();
        const state = createAuthState(harness, [
          createProxy(AUTH_HOST, AUTH_PORT, 'isolation-user', secret),
          createProxy('other-proxy.example', 9443, 'other-user', secret),
        ]);
        const firstRequest = createDetails('first-request');
        const secondRequest = createDetails('second-request');
        const otherEndpoint = createDetails(
            'first-request',
            'OTHER-PROXY.EXAMPLE',
            9443,
        );

        await authorize(harness, state, firstRequest);
        await authorize(harness, state, secondRequest);
        await authorize(harness, state, otherEndpoint);

        const entries = getAuthEntries(harness);
        Chai.expect(entries).to.have.length(3);
        Chai.expect(entries.map((entry) =>
          `${entry.requestId}|${entry.challengerKey}`,
        ).sort()).to.deep.equal([
          'first-request|other-proxy.example:9443',
          `first-request|${AUTH_HOST}:${AUTH_PORT}`,
          `second-request|${AUTH_HOST}:${AUTH_PORT}`,
        ]);

      });

  Mocha.it('serializes concurrent challenges so only two receive credentials',
      async function() {

        const harness = await createRuntimeHarness();
        const state = createAuthState(harness, [
          createProxy(
              AUTH_HOST,
              AUTH_PORT,
              'concurrent-user',
              createSecret('concurrent'),
          ),
        ]);
        const details = createDetails('concurrent-limit-request');
        const results = await Promise.all([
          authorize(harness, state, details),
          authorize(harness, state, details),
          authorize(harness, state, details),
        ]);

        Chai.expect(results.filter(hasCredentials)).to.have.length(2);
        Chai.expect(results.filter((result) => result.response.cancel))
            .to.have.length(1);
        Chai.expect(getAuthEntries(harness)[0].count).to.equal(2);

      });

  Mocha.it('cancels safely on session reads or writes without leaking errors',
      async function() {

        const secret = createSecret('storage-failure');
        const username = 'storage-failure-user';
        const harness = await createRuntimeHarness();
        const state = createAuthState(harness, [
          createProxy(AUTH_HOST, AUTH_PORT, username, secret),
        ]);
        const details = createDetails('storage-failure-request');

        harness.failNextSessionStorageGet(`read-${secret}`);
        const readFailure = await authorize(harness, state, details);
        harness.failNextSessionStorageSet(`write-${secret}`);
        const writeFailure = await authorize(harness, state, details);
        const serialized = JSON.stringify([readFailure.event, writeFailure.event]);

        Chai.expect(hasCredentials(readFailure)).to.equal(false);
        Chai.expect(readFailure.response.cancel).to.equal(true);
        Chai.expect(readFailure.event.type).to.equal('error');
        Chai.expect(hasCredentials(writeFailure)).to.equal(false);
        Chai.expect(writeFailure.response.cancel).to.equal(true);
        Chai.expect(writeFailure.event.type).to.equal('error');
        Chai.expect(serialized.includes(secret)).to.equal(false);
        Chai.expect(serialized.includes(username)).to.equal(false);
        Chai.expect(getAuthEntries(harness)).to.deep.equal([]);

      });

  Mocha.it('clears retry state through the explicit auth reset RPC',
      async function() {

        const harness = await createRuntimeHarness();
        const state = createAuthState(harness, [
          createProxy(
              AUTH_HOST,
              AUTH_PORT,
              'reset-user',
              createSecret('reset'),
          ),
        ]);
        await authorize(harness, state, createDetails('reset-request'));
        Chai.expect(getAuthEntries(harness)).to.have.length(1);

        await harness.callRpc('clearProxyAuthEvents');
        Chai.expect(getAuthEntries(harness)).to.deep.equal([]);

      });

  Mocha.it('stores only minimal retry metadata and preserves rejection behavior',
      async function() {

        const secret = createSecret('metadata');
        const username = 'metadata-user';
        const basicToken = Buffer.from(`${username}:${secret}`).toString('base64');
        const harness = await createRuntimeHarness();
        const state = createAuthState(harness, [
          createProxy(AUTH_HOST, AUTH_PORT, username, secret),
          createProxy('passwordless.example', 8080, '', ''),
        ]);
        const matching = await authorize(
            harness,
            state,
            createDetails('metadata-request'),
        );
        const nonProxy = await authorize(harness, state, {
          challenger: {host: AUTH_HOST, port: AUTH_PORT},
          isProxy: false,
          requestId: 'origin-auth',
        });
        const mismatch = await authorize(
            harness,
            state,
            createDetails('mismatch', AUTH_HOST, 9444),
        );
        const passwordless = await authorize(
            harness,
            state,
            createDetails('passwordless', 'passwordless.example', 8080),
        );
        const entries = getAuthEntries(harness);
        const serializedSession = JSON.stringify(entries);
        const serializedEvents = JSON.stringify([
          matching.event,
          nonProxy.event,
          mismatch.event,
          passwordless.event,
        ]);

        Chai.expect(entries).to.have.length(1);
        Chai.expect(Object.keys(entries[0]).sort()).to.deep.equal([
          'challengerKey',
          'count',
          'requestId',
          'updatedAt',
        ]);
        Chai.expect(serializedSession.includes(secret)).to.equal(false);
        Chai.expect(serializedSession.includes(username)).to.equal(false);
        Chai.expect(serializedSession.includes(basicToken)).to.equal(false);
        Chai.expect(serializedEvents.includes(secret)).to.equal(false);
        Chai.expect(nonProxy.event.type).to.equal('non_proxy_ignored');
        Chai.expect(mismatch.event.type).to.equal('missing_credentials');
        Chai.expect(passwordless.event.type).to.equal('missing_credentials');
        Chai.expect(hasCredentials(nonProxy)).to.equal(false);
        Chai.expect(hasCredentials(mismatch)).to.equal(false);
        Chai.expect(hasCredentials(passwordless)).to.equal(false);

      });

});
