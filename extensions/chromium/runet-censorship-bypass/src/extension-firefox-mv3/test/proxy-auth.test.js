'use strict';

const Assert = require('node:assert');
const Routing = require('../../extension-mv3-common/routing-contract');
const Adapter = require('../background/routing-adapter');
const ProxyAuth = require('../background/proxy-auth');

const FIXTURE_CREDENTIALS = Object.freeze({
  username: 'fixture-user',
  password: 'fixture-password',
});

function candidate(id, host, port, authRef = null) {

  return {
    id,
    type: 'HTTP',
    host,
    port,
    proxyDNS: false,
    authRef,
    failoverTimeoutSeconds: null,
  };

}

function decision(candidates) {

  return {
    kind: Routing.KINDS.PROXY,
    source: Routing.SOURCES.EXPLICIT_PROXY,
    candidates,
    fallback: Routing.FALLBACKS.FAIL_CLOSED,
  };

}

function fixture(options = {}) {

  let state = options.state || Adapter.STATES.READY;
  const decisions = options.decisions || {
    request: decision([
      candidate('authenticated', 'proxy.test', 8080, 'fixture-auth'),
    ]),
  };
  const routingAdapter = Adapter.createAdapter({
    runtimeStateForRequest: () => state,
    decideRoute: (value) => value,
    routingInputForRequest: (details) => decisions[details.requestId],
  });
  const proxyAuth = ProxyAuth.createHandler({
    routingAdapter,
    resolveCredentials: options.resolveCredentials ||
      (() => FIXTURE_CREDENTIALS),
    attempts: options.attempts,
  });
  return {
    proxyAuth,
    routingAdapter,
    setState(value) {

      state = value;

    },
  };

}

function select(fixtureValue, requestId = 'request', host = 'proxy.test',
    port = 8080) {

  fixtureValue.routingAdapter.onProxyRequest({requestId});
  return fixtureValue.routingAdapter.onBeforeRequest({
    requestId,
    proxyInfo: {type: 'http', host, port},
  });

}

function challenge(requestId = 'request', host = 'proxy.test', port = 8080,
    overrides = {}) {

  return Object.assign({
    requestId,
    isProxy: true,
    challenger: {host, port},
  }, overrides);

}

describe('Firefox request-scoped proxy authentication', function() {

  it('does not interfere while the durable runtime is OFF', function() {

    let resolverCalls = 0;
    const current = fixture({
      state: Adapter.STATES.OFF,
      resolveCredentials() {

        resolverCalls += 1;
        return FIXTURE_CREDENTIALS;

      },
    });

    Assert.strictEqual(current.proxyAuth.onAuthRequired(challenge()), undefined);
    Assert.strictEqual(resolverCalls, 0);
    Assert.strictEqual(current.proxyAuth.attemptCount(), 0);

  });

  it('cancels every challenge while INITIALIZING or FAILED', function() {

    for (const state of [Adapter.STATES.INITIALIZING, Adapter.STATES.FAILED]) {
      const current = fixture({state});
      Assert.deepStrictEqual(
          current.proxyAuth.onAuthRequired(challenge()),
          {cancel: true},
      );
    }

  });

  it('never answers an origin authentication challenge while active',
      function() {

        let resolverCalls = 0;
        const current = fixture({
          resolveCredentials() {

            resolverCalls += 1;
            return FIXTURE_CREDENTIALS;

          },
        });
        select(current);

        Assert.deepStrictEqual(current.proxyAuth.onAuthRequired(challenge(
            'request',
            'origin.test',
            80,
            {isProxy: false},
        )), {cancel: true});
        Assert.strictEqual(resolverCalls, 0);

      });

  it('requires the exact active request, selected proxy, and challenger',
      function() {

        const current = fixture();
        select(current);

        for (const details of [
          challenge('unknown'),
          challenge('request', 'proxy.test', 8081),
          challenge('request', 'other.test', 8080),
        ]) {
          Assert.deepStrictEqual(
              current.proxyAuth.onAuthRequired(details),
              {cancel: true},
          );
        }
        Assert.strictEqual(current.proxyAuth.attemptCount(), 0);
        Assert.strictEqual(current.routingAdapter.authorizationCount(), 0);

      });

  it('cancels missing, asynchronous, or failed credential resolution',
      function() {

        for (const resolveCredentials of [
          () => null,
          () => Promise.resolve(FIXTURE_CREDENTIALS),
          () => {

            throw new Error('injected resolver failure');

          },
        ]) {
          const current = fixture({resolveCredentials});
          select(current);
          Assert.deepStrictEqual(
              current.proxyAuth.onAuthRequired(challenge()),
              {cancel: true},
          );
          Assert.strictEqual(current.routingAdapter.authorizationCount(), 0);
          Assert.strictEqual(current.proxyAuth.attemptCount(), 0);
        }

      });

  it('adds exactly one callback before each credential response', function() {

    const current = fixture();
    Assert.deepStrictEqual(select(current), {cancel: false});
    Assert.strictEqual(current.routingAdapter.authorizationCount(), 0);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      Assert.deepStrictEqual(current.proxyAuth.onAuthRequired(challenge()), {
        authCredentials: FIXTURE_CREDENTIALS,
      });
      Assert.strictEqual(current.routingAdapter.authorizationCount(), 1);
      Assert.deepStrictEqual(current.routingAdapter.onBeforeRequest({
        requestId: 'request',
        proxyInfo: {type: 'http', host: 'proxy.test', port: 8080},
      }), {cancel: false});
      Assert.strictEqual(current.routingAdapter.authorizationCount(), 0);
    }
    Assert.strictEqual(current.proxyAuth.attemptCount(), 1);

  });

  it('permits wrong then correct credentials across three callbacks', function() {

    let resolverCalls = 0;
    const current = fixture({
      resolveCredentials() {

        resolverCalls += 1;
        return resolverCalls === 1 ? {
          username: 'fixture-wrong',
          password: 'fixture-wrong',
        } : FIXTURE_CREDENTIALS;

      },
    });
    let beforeRequestCallbacks = 0;
    Assert.deepStrictEqual(select(current), {cancel: false});
    beforeRequestCallbacks += 1;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = current.proxyAuth.onAuthRequired(challenge());
      Assert.ok(result.authCredentials);
      Assert.deepStrictEqual(current.routingAdapter.onBeforeRequest({
        requestId: 'request',
        proxyInfo: {type: 'http', host: 'proxy.test', port: 8080},
      }), {cancel: false});
      beforeRequestCallbacks += 1;
    }
    Assert.strictEqual(resolverCalls, 2);
    Assert.strictEqual(beforeRequestCallbacks, 3);

  });

  it('cancels attempt three without authorizing another callback', function() {

    const current = fixture();
    select(current);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      current.proxyAuth.onAuthRequired(challenge());
      current.routingAdapter.onBeforeRequest({
        requestId: 'request',
        proxyInfo: {type: 'http', host: 'proxy.test', port: 8080},
      });
    }

    Assert.deepStrictEqual(current.proxyAuth.onAuthRequired(challenge()), {
      cancel: true,
    });
    Assert.strictEqual(current.routingAdapter.authorizationCount(), 0);
    Assert.deepStrictEqual(current.routingAdapter.onBeforeRequest({
      requestId: 'request',
      proxyInfo: {type: 'http', host: 'proxy.test', port: 8080},
    }), {cancel: true});

  });

  it('isolates concurrent authRefs at the same endpoint by requestId',
      function() {

        const current = fixture({
          decisions: {
            first: decision([
              candidate('one', 'proxy.test', 8080, 'auth-one'),
            ]),
            second: decision([
              candidate('two', 'proxy.test', 8080, 'auth-two'),
            ]),
          },
          resolveCredentials(authRef) {

            return {
              username: `fixture-${authRef}`,
              password: `fixture-${authRef}`,
            };

          },
        });
        select(current, 'first');
        select(current, 'second');

        Assert.deepStrictEqual(
            current.proxyAuth.onAuthRequired(challenge('second')),
            {authCredentials: {
              username: 'fixture-auth-two',
              password: 'fixture-auth-two',
            }},
        );
        Assert.deepStrictEqual(
            current.proxyAuth.onAuthRequired(challenge('first')),
            {authCredentials: {
              username: 'fixture-auth-one',
              password: 'fixture-auth-one',
            }},
        );

      });

  it('supports closed A followed by authenticated B with three callbacks',
      function() {

        const current = fixture({
          decisions: {
            request: decision([
              candidate('closed', 'closed.test', 8001),
              candidate('authenticated', 'proxy.test', 8080, 'fixture-auth'),
            ]),
          },
        });
        Assert.deepStrictEqual(select(current, 'request', 'closed.test', 8001), {
          cancel: false,
        });
        Assert.deepStrictEqual(current.routingAdapter.onBeforeRequest({
          requestId: 'request',
          proxyInfo: {type: 'http', host: 'proxy.test', port: 8080},
        }), {cancel: false});
        Assert.deepStrictEqual(current.proxyAuth.onAuthRequired(challenge()), {
          authCredentials: FIXTURE_CREDENTIALS,
        });
        Assert.deepStrictEqual(current.routingAdapter.onBeforeRequest({
          requestId: 'request',
          proxyInfo: {type: 'http', host: 'proxy.test', port: 8080},
        }), {cancel: false});

      });

  it('cleans route and attempt metadata on terminal events and Clear', function() {

    const current = fixture();
    select(current);
    current.proxyAuth.onAuthRequired(challenge());
    Assert.strictEqual(current.routingAdapter.authContextCount(), 1);
    Assert.strictEqual(current.proxyAuth.attemptCount(), 1);

    current.routingAdapter.onRequestTerminal({requestId: 'request'});
    current.proxyAuth.onRequestTerminal({requestId: 'request'});
    Assert.strictEqual(current.routingAdapter.authorizationCount(), 0);
    Assert.strictEqual(current.routingAdapter.authContextCount(), 0);
    Assert.strictEqual(current.proxyAuth.attemptCount(), 0);

    select(current);
    current.proxyAuth.onAuthRequired(challenge());
    current.routingAdapter.clearAllAuthorizations();
    current.proxyAuth.clearAllAttempts();
    Assert.strictEqual(current.routingAdapter.authContextCount(), 0);
    Assert.strictEqual(current.proxyAuth.attemptCount(), 0);

  });

  it('starts a recreated event page with no request or auth metadata',
      function() {

        const first = fixture();
        select(first);
        first.proxyAuth.onAuthRequired(challenge());
        const recreated = fixture();

        Assert.strictEqual(recreated.routingAdapter.authorizationCount(), 0);
        Assert.strictEqual(recreated.routingAdapter.authContextCount(), 0);
        Assert.strictEqual(recreated.proxyAuth.attemptCount(), 0);
        Assert.deepStrictEqual(
            recreated.proxyAuth.onAuthRequired(challenge()),
            {cancel: true},
        );

      });

});
