'use strict';

const Assert = require('node:assert');
const OffState = require('../background/off-state');
const ProxyControl = require('../background/proxy-control');

function floor(port = 55001) {

  return {
    proxyType: 'manual',
    http: '',
    httpProxyAll: false,
    ssl: '',
    socks: `127.0.0.1:${port}`,
    socksVersion: 5,
    proxyDNS: true,
    passthrough: '',
    autoConfigUrl: '',
  };

}

function durable(floorIdentity = null) {

  return {schemaVersion: 2, intent: 'OFF', floorIdentity};

}

function makeStorage(initialValue, events = []) {

  const values = initialValue === undefined ? {} : {
    [OffState.STORAGE_KEY]: initialValue,
  };
  return {
    values,
    async get(key) {

      events.push('storage-get');
      return key in values ? {[key]: values[key]} : {};

    },
    async set(update) {

      events.push('storage-set');
      Object.assign(values, JSON.parse(JSON.stringify(update)));

    },
  };

}

function makeProxySettings(initialLive, options = {}, events = []) {

  let live = initialLive;
  const calls = {clear: 0, get: 0, set: 0};
  return {
    calls,
    get live() {

      return live;

    },
    api: {
      async clear() {

        calls.clear += 1;
        events.push('proxy-clear');
        if (options.clearError) {
          throw options.clearError;
        }
        live = options.afterClear || {
          levelOfControl: 'controllable_by_this_extension',
          value: {proxyType: 'none'},
        };

      },
      async get() {

        calls.get += 1;
        events.push('proxy-get');
        if (options.getError) {
          throw options.getError;
        }
        return live;

      },
      async set(update) {

        calls.set += 1;
        events.push('proxy-set');
        if (options.setError) {
          throw options.setError;
        }
        live = options.afterSet || {
          levelOfControl: 'controlled_by_this_extension',
          value: JSON.parse(JSON.stringify(update.value)),
        };

      },
    },
  };

}

function makeController(options = {}) {

  const events = options.events || [];
  const storage = options.storage || makeStorage(durable(), events);
  const proxy = options.proxy || makeProxySettings({
    levelOfControl: 'controllable_by_this_extension',
    value: {proxyType: 'none'},
  }, {}, events);
  let ephemeralClears = 0;
  const controller = ProxyControl.createController({
    proxySettings: proxy.api,
    storageArea: storage,
    isPrivateAccessAllowed: async () => {
      events.push('private-access');
      if (options.privateAccessError) {
        throw options.privateAccessError;
      }
      return options.privateAccess !== false;
    },
    clearEphemeralState() {

      events.push('ephemeral-clear');
      ephemeralClears += 1;
      if (options.ephemeralError) {
        throw options.ephemeralError;
      }

    },
  });
  return {
    controller,
    events,
    get ephemeralClears() {

      return ephemeralClears;

    },
    proxy,
    storage,
  };

}

describe('Firefox fail-closed proxy control', function() {

  it('accepts only the exact canonical high-port floor identity', function() {

    Assert.deepStrictEqual(
        ProxyControl.canonicalizeFloorIdentity(floor(49152)),
        floor(49152),
    );
    for (const invalid of [
      null,
      floor(49151),
      floor(65536),
      Object.assign(floor(), {socks: '127.0.0.1:0'}),
      Object.assign(floor(), {socks: '127.0.0.1:1080'}),
      Object.assign(floor(), {socks: 'localhost:55001'}),
      Object.assign(floor(), {proxyDNS: false}),
      Object.assign(floor(), {extra: true}),
    ]) {
      Assert.strictEqual(
          ProxyControl.canonicalizeFloorIdentity(invalid),
          null,
      );
    }

  });

  it('generates a candidate only through cryptographic random bytes', function() {

    let calls = 0;
    const cryptoSource = {
      getRandomValues(words) {

        calls += 1;
        words[0] = 16383;
        return words;

      },
    };
    Assert.strictEqual(
        ProxyControl.generateHighPortCandidate(cryptoSource),
        65535,
    );
    Assert.strictEqual(calls, 1);
    Assert.throws(
        () => ProxyControl.generateHighPortCandidate({}),
        /CRYPTO_RANDOM_UNAVAILABLE/,
    );

  });

  it('requires control level and exact live floor identity for ownership',
      function() {

        const identity = floor();
        Assert.strictEqual(ProxyControl.isExactOwnedFloor({
          levelOfControl: 'controlled_by_this_extension',
          value: Object.assign({autoLogin: false}, identity),
        }, identity), true);
        Assert.strictEqual(ProxyControl.isExactOwnedFloor({
          levelOfControl: 'controllable_by_this_extension',
          value: identity,
        }, identity), false);
        Assert.strictEqual(ProxyControl.isExactOwnedFloor({
          levelOfControl: 'controlled_by_this_extension',
          value: floor(55002),
        }, identity), false);
        Assert.strictEqual(ProxyControl.isExactOwnedFloor({
          levelOfControl: 'controlled_by_this_extension',
          value: Object.assign({autoLogin: true}, identity),
        }, identity), false);

      });

  it('acquires only a caller-prevalidated floor after private access',
      async function() {

        const fixture = makeController({events: []});
        const result = await fixture.controller.acquirePrevalidatedFloor({
          floorIdentity: floor(),
          portPrevalidated: true,
        });

        Assert.strictEqual(result.ok, true);
        Assert.strictEqual(result.status, 'ACQUIRED');
        Assert.deepStrictEqual(fixture.events, [
          'private-access',
          'storage-set',
          'ephemeral-clear',
          'proxy-set',
          'proxy-get',
        ]);
        Assert.deepStrictEqual(
            fixture.storage.values[OffState.STORAGE_KEY],
            durable(floor()),
        );
        Assert.strictEqual(fixture.proxy.calls.set, 1);

      });

  it('rejects acquisition without explicit external port prevalidation',
      async function() {

        const fixture = makeController();
        const result = await fixture.controller.acquirePrevalidatedFloor({
          floorIdentity: floor(),
        });

        Assert.deepStrictEqual(result, {
          ok: false,
          error: {code: 'PORT_PREVALIDATION_REQUIRED'},
        });
        Assert.strictEqual(fixture.proxy.calls.set, 0);
        Assert.deepStrictEqual(fixture.events, []);

      });

  it('denies acquisition without private access before storage or proxy writes',
      async function() {

        const fixture = makeController({privateAccess: false});
        const result = await fixture.controller.acquirePrevalidatedFloor({
          floorIdentity: floor(),
          portPrevalidated: true,
        });

        Assert.deepStrictEqual(result, {
          ok: false,
          error: {code: 'PRIVATE_ACCESS_REQUIRED'},
        });
        Assert.deepStrictEqual(fixture.events, ['private-access']);
        Assert.strictEqual(fixture.proxy.calls.set, 0);

      });

  it('retains cleanup identity when the proxy write fails', async function() {

    const events = [];
    const proxy = makeProxySettings({
      levelOfControl: 'controllable_by_this_extension',
      value: {proxyType: 'none'},
    }, {setError: new Error('set failed')}, events);
    const fixture = makeController({events, proxy});
    const result = await fixture.controller.acquirePrevalidatedFloor({
      floorIdentity: floor(),
      portPrevalidated: true,
    });

    Assert.strictEqual(result.error.code, 'PROXY_SET_FAILED');
    Assert.deepStrictEqual(
        fixture.storage.values[OffState.STORAGE_KEY],
        durable(floor()),
    );

  });

  it('clears an exact owned floor and removes identity only after confirmation',
      async function() {

        const events = [];
        const identity = floor();
        const previous = {
          levelOfControl: 'controllable_by_this_extension',
          value: {proxyType: 'manual', http: '127.0.0.1:58001'},
        };
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controlled_by_this_extension',
          value: identity,
        }, {afterClear: previous}, events);
        const fixture = makeController({events, proxy, storage});
        const result = await fixture.controller.clearFloor();

        Assert.strictEqual(result.ok, true);
        Assert.strictEqual(result.status, 'CLEARED');
        Assert.deepStrictEqual(fixture.events, [
          'storage-get',
          'storage-set',
          'ephemeral-clear',
          'proxy-get',
          'proxy-clear',
          'proxy-get',
          'storage-set',
        ]);
        Assert.deepStrictEqual(
            fixture.storage.values[OffState.STORAGE_KEY],
            durable(),
        );
        Assert.strictEqual(fixture.proxy.live, previous);

      });

  it('does not clear an exact value without extension ownership',
      async function() {

        const identity = floor();
        const events = [];
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controllable_by_this_extension',
          value: identity,
        }, {}, events);
        const fixture = makeController({events, proxy, storage});
        const result = await fixture.controller.clearFloor();

        Assert.strictEqual(result.error.code, 'OWNERSHIP_MISMATCH');
        Assert.strictEqual(proxy.calls.clear, 0);
        Assert.deepStrictEqual(
            storage.values[OffState.STORAGE_KEY],
            durable(identity),
        );

      });

  it('does not clear a different extension-controlled setting', async function() {

    const identity = floor();
    const events = [];
    const storage = makeStorage(durable(identity), events);
    const proxy = makeProxySettings({
      levelOfControl: 'controlled_by_this_extension',
      value: floor(55002),
    }, {}, events);
    const fixture = makeController({events, proxy, storage});
    const result = await fixture.controller.clearFloor();

    Assert.strictEqual(result.error.code, 'OWNERSHIP_MISMATCH');
    Assert.strictEqual(proxy.calls.clear, 0);

  });

  it('does not clear an unrelated manual proxy', async function() {

    const identity = floor();
    const events = [];
    const storage = makeStorage(durable(identity), events);
    const proxy = makeProxySettings({
      levelOfControl: 'controlled_by_this_extension',
      value: {
        proxyType: 'manual',
        http: '127.0.0.1:58001',
        httpProxyAll: true,
        ssl: '',
        socks: '',
        socksVersion: 5,
        proxyDNS: false,
        passthrough: '',
        autoConfigUrl: '',
      },
    }, {}, events);
    const fixture = makeController({events, proxy, storage});
    const result = await fixture.controller.clearFloor();

    Assert.strictEqual(result.error.code, 'OWNERSHIP_MISMATCH');
    Assert.strictEqual(proxy.calls.clear, 0);

  });

  it('Clear never consults private access and remains available after revoke',
      async function() {

        const identity = floor();
        const events = [];
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controlled_by_this_extension',
          value: identity,
        }, {}, events);
        const fixture = makeController({
          events,
          privateAccessError: new Error('private denied'),
          proxy,
          storage,
        });
        const result = await fixture.controller.clearFloor();

        Assert.strictEqual(result.status, 'CLEARED');
        Assert.strictEqual(events.includes('private-access'), false);
        Assert.strictEqual(proxy.calls.clear, 1);

      });

  it('startup OFF reconciliation clears a resurrected exact floor',
      async function() {

        const identity = floor();
        const events = [];
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controlled_by_this_extension',
          value: identity,
        }, {}, events);
        const fixture = makeController({events, proxy, storage});
        const result = await fixture.controller.reconcileOffOnStartup();

        Assert.strictEqual(result.status, 'CLEARED');
        Assert.strictEqual(proxy.calls.set, 0);
        Assert.strictEqual(proxy.calls.clear, 1);
        Assert.deepStrictEqual(storage.values[OffState.STORAGE_KEY], durable());

      });

  it('startup OFF reconciliation never reacquires from persisted identity',
      async function() {

        const identity = floor();
        const events = [];
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controllable_by_this_extension',
          value: {proxyType: 'manual', http: '127.0.0.1:58001'},
        }, {}, events);
        const fixture = makeController({events, proxy, storage});
        const result = await fixture.controller.reconcileOffOnStartup();

        Assert.strictEqual(result.error.code, 'OWNERSHIP_MISMATCH');
        Assert.strictEqual(proxy.calls.set, 0);
        Assert.strictEqual(proxy.calls.clear, 0);
        Assert.deepStrictEqual(
            storage.values[OffState.STORAGE_KEY],
            durable(identity),
        );

      });

  it('normalizes malformed persisted identity without touching live settings',
      async function() {

        const malformed = durable(Object.assign(
            floor(),
            {socks: '127.0.0.1:1'},
        ));
        const events = [];
        const storage = makeStorage(malformed, events);
        const proxy = makeProxySettings({
          levelOfControl: 'controlled_by_this_extension',
          value: floor(),
        }, {}, events);
        const fixture = makeController({events, proxy, storage});
        const result = await fixture.controller.reconcileOffOnStartup();

        Assert.strictEqual(result.status, 'ALREADY_CLEAR');
        Assert.strictEqual(proxy.calls.get, 0);
        Assert.strictEqual(proxy.calls.clear, 0);
        Assert.deepStrictEqual(storage.values[OffState.STORAGE_KEY], durable());

      });

  it('retains identity when Clear fails so a later boot can reconcile',
      async function() {

        const identity = floor();
        const events = [];
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controlled_by_this_extension',
          value: identity,
        }, {clearError: new Error('clear failed')}, events);
        const fixture = makeController({events, proxy, storage});
        const result = await fixture.controller.clearFloor();

        Assert.strictEqual(result.error.code, 'PROXY_CLEAR_FAILED');
        Assert.deepStrictEqual(
            storage.values[OffState.STORAGE_KEY],
            durable(identity),
        );

      });

  it('reconciles a crash after persistence and proxy set on the next context',
      async function() {

        const identity = floor();
        const events = [];
        const storage = makeStorage(durable(identity), events);
        const proxy = makeProxySettings({
          levelOfControl: 'controlled_by_this_extension',
          value: identity,
        }, {}, events);
        const recreated = makeController({events, proxy, storage});
        const result = await recreated.controller.reconcileOffOnStartup();

        Assert.strictEqual(result.status, 'CLEARED');
        Assert.strictEqual(recreated.ephemeralClears, 1);
        Assert.deepStrictEqual(storage.values[OffState.STORAGE_KEY], durable());

      });

  it('serializes concurrent control operations', async function() {

    const fixture = makeController();
    const first = fixture.controller.clearFloor();
    const second = fixture.controller.clearFloor();
    const results = await Promise.all([first, second]);

    Assert.deepStrictEqual(results.map((result) => result.status), [
      'ALREADY_CLEAR',
      'ALREADY_CLEAR',
    ]);
    Assert.strictEqual(fixture.ephemeralClears, 2);

  });

});
