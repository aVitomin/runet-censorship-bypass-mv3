'use strict';

const Assert = require('node:assert');
const Routing = require('../../extension-mv3-common/routing-contract');
const Adapter = require('../background/routing-adapter');

const DIRECT_DECISION = Object.freeze({
  kind: Routing.KINDS.DIRECT,
  source: Routing.SOURCES.EXPLICIT_DIRECT,
});

function candidate(id, type, host, port, overrides = {}) {

  return Object.assign({
    id,
    type,
    host,
    port,
    proxyDNS: type === 'SOCKS4' || type === 'SOCKS5',
    authRef: null,
    failoverTimeoutSeconds: null,
  }, overrides);

}

function proxyDecision(candidates, fallback = Routing.FALLBACKS.FAIL_CLOSED) {

  return {
    kind: Routing.KINDS.PROXY,
    source: Routing.SOURCES.EXPLICIT_PROXY,
    candidates,
    fallback,
  };

}

function adapterForDecision(decision, options = {}) {

  return Adapter.createAdapter({
    initialState: Adapter.STATES.READY,
    decideRoute: options.decideRoute || ((value) => value),
    routingInputForRequest: options.routingInputForRequest || (() => decision),
    authorizations: options.authorizations,
  });

}

describe('Firefox fail-closed routing adapter', function() {

  it('leaves ordinary traffic alone while durable runtime is OFF', function() {

    const adapter = Adapter.createAdapter();

    Assert.strictEqual(adapter.runtimeState, Adapter.STATES.OFF);
    Assert.strictEqual(adapter.onProxyRequest({requestId: 'off'}), undefined);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'off'}), {
      cancel: false,
    });
    Assert.strictEqual(adapter.authorizationCount(), 0);

  });

  it('distinguishes OFF from a true top-level-null Direct route', function() {

    const adapter = adapterForDecision(DIRECT_DECISION);

    Assert.strictEqual(adapter.onProxyRequest({requestId: 'direct'}), null);
    Assert.strictEqual(adapter.authorizationCount(), 1);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'direct'}), {
      cancel: false,
    });
    Assert.strictEqual(adapter.authorizationCount(), 0);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'direct'}), {
      cancel: true,
    });

  });

  it('maps an ordinary provider Direct decision to top-level null', function() {

    const adapter = adapterForDecision({
      kind: Routing.KINDS.DIRECT,
      source: Routing.SOURCES.PROVIDER_DEFAULT,
    });

    Assert.strictEqual(
        adapter.onProxyRequest({requestId: 'provider-direct'}),
        null,
    );
    Assert.deepStrictEqual(
        adapter.onBeforeRequest({requestId: 'provider-direct'}),
        {cancel: false},
    );

  });

  it('does not authorize Direct after a fail-closed proxy candidate', function() {

    const decision = proxyDecision([
      candidate('one', 'HTTPS', 'proxy-one.test', 443),
    ]);
    const adapter = adapterForDecision(decision);

    Assert.deepStrictEqual(Adapter.convertDecision(decision), {
      proxyResult: [
        {type: 'https', host: 'proxy-one.test', port: 443},
        null,
      ],
      callbackBudget: 1,
    });
    Assert.deepStrictEqual(
        adapter.onProxyRequest({requestId: 'proxy'}),
        [{type: 'https', host: 'proxy-one.test', port: 443}, null],
    );
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'proxy'}), {
      cancel: false,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'proxy'}), {
      cancel: true,
    });

  });

  it('budgets each ordered proxy callback and cancels terminal fallback', function() {

    const adapter = adapterForDecision(proxyDecision([
      candidate('one', 'HTTP', 'proxy-one.test', 8080),
      candidate('two', 'SOCKS5', '127.0.0.1', 9050, {
        failoverTimeoutSeconds: 4,
      }),
    ]));

    Assert.deepStrictEqual(adapter.onProxyRequest({requestId: 'failover'}), [
      {type: 'http', host: 'proxy-one.test', port: 8080},
      {
        type: 'socks',
        host: '127.0.0.1',
        port: 9050,
        proxyDNS: true,
        failoverTimeout: 4,
      },
      null,
    ]);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'failover'}), {
      cancel: false,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'failover'}), {
      cancel: false,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'failover'}), {
      cancel: true,
    });

  });

  it('strips only proxy Direct fallback after validating every candidate',
      function() {

        const decision = proxyDecision([
          candidate('one', 'HTTP', 'proxy-one.test', 8080),
          candidate('two', 'SOCKS4', '127.0.0.1', 9150),
        ], Routing.FALLBACKS.DIRECT);
        const adapter = adapterForDecision(decision);

        Assert.deepStrictEqual(Adapter.convertDecision(decision), {
          proxyResult: [
            {type: 'http', host: 'proxy-one.test', port: 8080},
            {type: 'socks4', host: '127.0.0.1', port: 9150, proxyDNS: true},
            null,
          ],
          callbackBudget: 2,
          degradationCode:
            Adapter.DEGRADATION_CODES.PROXY_DIRECT_FALLBACK_STRIPPED,
        });
        Assert.deepStrictEqual(
            adapter.onProxyRequest({requestId: 'fallback'}),
            [
              {type: 'http', host: 'proxy-one.test', port: 8080},
              {type: 'socks4', host: '127.0.0.1', port: 9150, proxyDNS: true},
              null,
            ],
        );
        Assert.strictEqual(adapter.authorizationCount(), 1);
        Assert.deepStrictEqual(
            adapter.onBeforeRequest({requestId: 'fallback'}),
            {cancel: false},
        );
        Assert.deepStrictEqual(
            adapter.onBeforeRequest({requestId: 'fallback'}),
            {cancel: false},
        );
        Assert.strictEqual(adapter.authorizationCount(), 0);
        Assert.deepStrictEqual(
            adapter.onBeforeRequest({requestId: 'fallback'}),
            {cancel: true},
        );

      });

  it('gives one provider proxy one callback without terminal Direct', function() {

    const decision = {
      kind: Routing.KINDS.PROXY,
      source: Routing.SOURCES.PROVIDER_DEFAULT,
      candidates: [candidate('provider', 'HTTPS', 'provider.test', 443)],
      fallback: Routing.FALLBACKS.DIRECT,
    };
    const adapter = adapterForDecision(decision);

    Assert.deepStrictEqual(Adapter.convertDecision(decision), {
      proxyResult: [
        {type: 'https', host: 'provider.test', port: 443},
        null,
      ],
      callbackBudget: 1,
      degradationCode:
        Adapter.DEGRADATION_CODES.PROXY_DIRECT_FALLBACK_STRIPPED,
    });
    Assert.deepStrictEqual(adapter.onProxyRequest({requestId: 'provider'}), [
      {type: 'https', host: 'provider.test', port: 443},
      null,
    ]);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'provider'}), {
      cancel: false,
    });
    Assert.strictEqual(adapter.authorizationCount(), 0);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'provider'}), {
      cancel: true,
    });

  });

  it('cancels missing and malformed authorization markers', function() {

    const malformed = new Map([['bad', '1']]);
    const adapter = adapterForDecision(DIRECT_DECISION, {
      authorizations: malformed,
    });

    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'missing'}), {
      cancel: true,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'bad'}), {
      cancel: true,
    });
    Assert.strictEqual(malformed.has('bad'), false);

  });

  it('does not evict an active authorization when the map cap is reached', function() {

    const adapter = adapterForDecision(DIRECT_DECISION);
    for (let index = 0; index < Adapter.MAX_AUTHORIZATIONS; index += 1) {
      adapter.onProxyRequest({requestId: `active-${index}`});
    }

    Assert.strictEqual(adapter.authorizationCount(), Adapter.MAX_AUTHORIZATIONS);
    Assert.deepStrictEqual(adapter.onProxyRequest({requestId: 'overflow'}), {
      type: 'direct',
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'overflow'}), {
      cancel: true,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'active-0'}), {
      cancel: false,
    });

  });

  it('cleans an authorization defensively on terminal events', function() {

    const adapter = adapterForDecision(DIRECT_DECISION);
    adapter.onProxyRequest({requestId: 'terminal'});
    Assert.strictEqual(adapter.authorizationCount(), 1);

    adapter.onRequestTerminal({requestId: 'terminal'});

    Assert.strictEqual(adapter.authorizationCount(), 0);
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'terminal'}), {
      cancel: true,
    });

  });

  it('fails closed before authorization for invalid or auth-dependent candidates', function() {

    for (const invalid of [
      candidate('bad-host', 'HTTP', 'https://proxy.test', 8080),
      candidate('bad-port', 'HTTP', 'proxy.test', 0),
      candidate('needs-auth', 'HTTPS', 'proxy.test', 443, {authRef: 'secret'}),
      Object.assign(
          candidate('credential', 'HTTP', 'proxy.test', 8080),
          {password: 'x'},
      ),
    ]) {
      const adapter = adapterForDecision(proxyDecision(
          [invalid],
          Routing.FALLBACKS.DIRECT,
      ));
      Assert.deepStrictEqual(adapter.onProxyRequest({requestId: invalid.id}), {
        type: 'direct',
      });
      Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: invalid.id}), {
        cancel: true,
      });
      Assert.strictEqual(adapter.authorizationCount(), 0);
    }

  });

  it('fails closed for empty, malformed, and core FAIL_CLOSED decisions',
      function() {

        for (const decision of [
          proxyDecision([], Routing.FALLBACKS.DIRECT),
          {
            kind: Routing.KINDS.PROXY,
            source: Routing.SOURCES.PROVIDER_DEFAULT,
            candidates: 'not-an-array',
            fallback: Routing.FALLBACKS.DIRECT,
          },
          {
            kind: Routing.KINDS.FAIL_CLOSED,
            source: Routing.SOURCES.ROUTING_INPUT,
            code: 'NO_VALID_ROUTE',
          },
        ]) {
          const adapter = adapterForDecision(decision);
          Assert.deepStrictEqual(
              adapter.onProxyRequest({requestId: 'closed'}),
              {type: 'direct'},
          );
          Assert.deepStrictEqual(
              adapter.onBeforeRequest({requestId: 'closed'}),
              {cancel: true},
          );
          Assert.strictEqual(adapter.authorizationCount(), 0);
        }

      });

  it('fails closed when route selection throws or returns async state', function() {

    for (const decideRoute of [
      () => {

        throw new Error('injected routing failure');

      },
      () => Promise.resolve(DIRECT_DECISION),
    ]) {
      const adapter = adapterForDecision(null, {decideRoute});
      Assert.deepStrictEqual(adapter.onProxyRequest({requestId: 'failure'}), {
        type: 'direct',
      });
      Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'failure'}), {
        cancel: true,
      });
      Assert.strictEqual(adapter.authorizationCount(), 0);
    }

  });

  it('cancels in INITIALIZING and FAILED without routing authorization', function() {

    for (const state of [Adapter.STATES.INITIALIZING, Adapter.STATES.FAILED]) {
      const adapter = Adapter.createAdapter({initialState: state});
      Assert.deepStrictEqual(adapter.onProxyRequest({requestId: state}), {
        type: 'direct',
      });
      Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: state}), {
        cancel: true,
      });
      Assert.strictEqual(adapter.authorizationCount(), 0);
    }

  });

  it('catches synchronous guard state failures and cancels', function() {

    const brokenMap = {
      delete() {},
      get() {

        throw new Error('injected lookup failure');

      },
      get size() {

        return 0;

      },
    };
    const adapter = adapterForDecision(DIRECT_DECISION, {
      authorizations: brokenMap,
    });

    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'fault'}), {
      cancel: true,
    });
    Assert.strictEqual(adapter.authorizationCount(), 0);

  });

  it('starts every recreated event-page adapter with no authorization', function() {

    const first = adapterForDecision(DIRECT_DECISION);
    first.onProxyRequest({requestId: 'old-request'});
    const recreated = adapterForDecision(DIRECT_DECISION);

    Assert.strictEqual(first.authorizationCount(), 1);
    Assert.strictEqual(recreated.authorizationCount(), 0);
    Assert.deepStrictEqual(
        recreated.onBeforeRequest({requestId: 'old-request'}),
        {cancel: true},
    );

  });

  it('preserves shared candidate order and Firefox type mapping', function() {

    const input = {
      hostname: 'protected.test',
      rules: {proxy: ['protected.test']},
      candidateGroups: {
        configured: {
          own: [candidate('own', 'HTTPS', 'own.test', 8443)],
          localTor: [candidate('tor', 'SOCKS5', '127.0.0.1', 9050)],
          torBrowser: [candidate('browser', 'SOCKS4', '127.0.0.1', 9150)],
          warp: [candidate('warp', 'HTTP', '127.0.0.1', 40000)],
        },
      },
    };
    const adapter = Adapter.createAdapter({
      initialState: Adapter.STATES.READY,
      routingInputForRequest: () => input,
    });

    Assert.deepStrictEqual(adapter.onProxyRequest({requestId: 'ordered'}), [
      {type: 'https', host: 'own.test', port: 8443},
      {type: 'socks', host: '127.0.0.1', port: 9050, proxyDNS: true},
      {type: 'socks4', host: '127.0.0.1', port: 9150, proxyDNS: true},
      {type: 'http', host: '127.0.0.1', port: 40000},
      null,
    ]);

  });

  it('keeps authorizations isolated by exact request ID under concurrency', function() {

    const adapter = Adapter.createAdapter({
      initialState: Adapter.STATES.READY,
      decideRoute: (value) => value,
      routingInputForRequest(details) {

        return details.requestId === 'direct' ?
          DIRECT_DECISION :
          proxyDecision([candidate('proxy', 'HTTP', 'proxy.test', 8080)]);

      },
    });
    adapter.onProxyRequest({requestId: 'proxy'});
    adapter.onProxyRequest({requestId: 'direct'});

    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'unknown'}), {
      cancel: true,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'direct'}), {
      cancel: false,
    });
    Assert.deepStrictEqual(adapter.onBeforeRequest({requestId: 'proxy'}), {
      cancel: false,
    });
    Assert.strictEqual(adapter.authorizationCount(), 0);

  });

  it('clears every ephemeral authorization for OFF/Clear reconciliation',
      function() {

        const adapter = adapterForDecision(DIRECT_DECISION);
        adapter.onProxyRequest({requestId: 'first'});
        adapter.onProxyRequest({requestId: 'second'});
        Assert.strictEqual(adapter.authorizationCount(), 2);

        adapter.clearAllAuthorizations();

        Assert.strictEqual(adapter.authorizationCount(), 0);
        Assert.deepStrictEqual(
            adapter.onBeforeRequest({requestId: 'first'}),
            {cancel: true},
        );

      });

});
