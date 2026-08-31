'use strict';


const Chai = require('chai');
const Mocha = require('mocha');
const vm = require('vm');
const {loadBackgroundModules} = require('./background-modules');
const Routing = require('../../extension-mv3-common/routing-contract');

const PROVIDER = Object.freeze({key: 'routing-contract-provider'});
const PROVIDER_PROXY = 'PROXY 192.0.2.10:8080';
const PROVIDER_SOCKS = 'SOCKS5 192.0.2.11:1080';
const OWN = 'HTTPS own-proxy.test:8443';
const SECOND_OWN = 'SOCKS4 second-own.test:1080';
const LOCAL_TOR = 'SOCKS5 127.0.0.1:9050';
const TOR_BROWSER = 'SOCKS5 127.0.0.1:9150';
const WARP_SOCKS = 'SOCKS5 127.0.0.1:40000';
const WARP_HTTPS = 'HTTPS 127.0.0.1:40000';

function createProviderPac(result) {

  return [
    'function FindProxyForURL() {',
    `  return ${JSON.stringify(result)};`,
    '}',
  ].join('\n');

}

async function cook(pacMods, providerResult) {

  return global.mv3PacCook.cookPac({
    rawPacData: createProviderPac(providerResult),
    pacMods,
    provider: PROVIDER,
    sourceRawPacSha256: 'routing-contract-fixture',
  });

}

function evaluatePac(cookedPacData, host) {

  const context = {};
  vm.createContext(context);
  vm.runInContext(cookedPacData, context);
  const findProxyForUrl = context.FindProxyForURL;
  return findProxyForUrl(`https://${host}/`, host);

}

function parseEndpoint(value) {

  if (value.startsWith('[')) {
    const closingBracket = value.indexOf(']');
    return {
      host: value.slice(1, closingBracket),
      port: Number(value.slice(closingBracket + 2)),
    };
  }
  const colonIndex = value.lastIndexOf(':');
  return {
    host: value.slice(0, colonIndex),
    port: Number(value.slice(colonIndex + 1)),
  };

}

function candidateFromPacToken(token) {

  const separatorIndex = token.indexOf(' ');
  const pacType = token.slice(0, separatorIndex).toUpperCase();
  const endpoint = parseEndpoint(token.slice(separatorIndex + 1));
  const type = pacType === 'PROXY' ? 'HTTP' : pacType;
  return {
    id: `${type.toLowerCase()}:${endpoint.host}:${endpoint.port}`,
    type,
    host: endpoint.host,
    port: endpoint.port,
    proxyDNS: false,
    authRef: null,
    failoverTimeoutSeconds: null,
  };

}

function parsePacRoute(value) {

  const tokens = String(value || '')
      .split(/\s*;\s*/g)
      .map((token) => token.trim())
      .filter(Boolean);
  return {
    candidates: tokens
        .filter((token) => token.toUpperCase() !== 'DIRECT')
        .map(candidateFromPacToken),
    hasDirect: tokens.some((token) => token.toUpperCase() === 'DIRECT'),
  };

}

function providerDecision(providerResult, source) {

  const route = parsePacRoute(providerResult);
  if (!route.candidates.length && !route.hasDirect) {
    return {kind: 'EMPTY', source};
  }
  if (!route.candidates.length) {
    return {kind: Routing.KINDS.DIRECT, source};
  }
  return {
    kind: Routing.KINDS.PROXY,
    source,
    candidates: route.candidates,
    fallback: route.hasDirect ?
      Routing.FALLBACKS.DIRECT :
      Routing.FALLBACKS.FAIL_CLOSED,
  };

}

function decisionFromPacResult(value, source) {

  const route = parsePacRoute(value);
  if (!route.candidates.length && !route.hasDirect) {
    return {
      kind: Routing.KINDS.FAIL_CLOSED,
      source,
      code: 'NO_VALID_ROUTE',
    };
  }
  if (!route.candidates.length) {
    return {kind: Routing.KINDS.DIRECT, source};
  }
  return {
    kind: Routing.KINDS.PROXY,
    source,
    candidates: route.candidates,
    fallback: route.hasDirect ?
      Routing.FALLBACKS.DIRECT :
      Routing.FALLBACKS.FAIL_CLOSED,
  };

}

function candidatesFromPacStrings(values) {

  return values.filter(Boolean).map(candidateFromPacToken);

}

function torPacString(config) {

  return config.enabled ?
    `${config.type} ${config.host}:${config.port}` :
    '';

}

function candidateGroupsFromPacMods(pacMods) {

  const mods = global.mv3PacMods.normalizePacMods(pacMods);
  const own = mods.ownProxies
      .filter((proxy) => proxy.enabled)
      .map((proxy) => global.mv3PacMods.proxyEntryToPacString(proxy));
  const localTor = mods.localTor.enabled ?
    [torPacString(mods.localTor)] :
    [];
  const torBrowser = mods.torBrowser.enabled ?
    [torPacString(mods.torBrowser)] :
    [];
  const warp = mods.warp.enabled ?
    global.mv3PacMods.splitProxyString(mods.warp.proxyString) :
    [];
  const replacementOwn = mods.ownProxies
      .filter((proxy) => proxy.enabled && proxy.useAsDirectReplacement)
      .map((proxy) => global.mv3PacMods.proxyEntryToPacString(proxy));
  const replacementLocalTor = mods.localTor.enabled &&
    mods.localTor.useAsDirectReplacement ?
    [torPacString(mods.localTor)] :
    [];
  const replacementTorBrowser = mods.torBrowser.enabled &&
    mods.torBrowser.useAsDirectReplacement ?
    [torPacString(mods.torBrowser)] :
    [];
  const replacementWarp = mods.warp.enabled &&
    mods.warp.useAsDirectReplacement ?
    global.mv3PacMods.splitProxyString(mods.warp.proxyString) :
    [];
  return {
    configured: {
      own: candidatesFromPacStrings(own),
      localTor: candidatesFromPacStrings(localTor),
      torBrowser: candidatesFromPacStrings(torBrowser),
      warp: candidatesFromPacStrings(warp),
    },
    onion: {
      own: [],
      localTor: mods.localTor.enabled && mods.localTor.useForOnion ?
        candidatesFromPacStrings(localTor) :
        [],
      torBrowser: mods.torBrowser.enabled && mods.torBrowser.useForOnion ?
        candidatesFromPacStrings(torBrowser) :
        [],
      warp: [],
    },
    directReplacement: {
      own: candidatesFromPacStrings(replacementOwn),
      localTor: candidatesFromPacStrings(replacementLocalTor),
      torBrowser: candidatesFromPacStrings(replacementTorBrowser),
      warp: candidatesFromPacStrings(replacementWarp),
    },
  };

}

function coreInput(testCase) {

  const mods = global.mv3PacMods.normalizePacMods(testCase.pacMods);
  const rules = mods.exceptions.concat(mods.rules);
  return {
    hostname: testCase.host,
    rules: {
      direct: rules.filter((rule) => rule.action === 'DIRECT'),
      proxy: rules.filter((rule) => rule.action === 'PROXY'),
      whitelist: mods.whitelist,
    },
    candidateGroups: candidateGroupsFromPacMods(mods),
    provider: providerDecision(
        testCase.providerResult,
        testCase.providerSource,
    ),
    flags: {
      useProviderProxies: mods.usePacScriptProxies,
      ownProxiesOnlyForOwnSites: mods.ownProxiesOnlyForOwnSites,
      replaceDirectWithProxy: mods.replaceDirectWithProxy,
      noDirect: mods.noDirect,
    },
  };

}

function ownProxy(
    host = 'own-proxy.test',
    port = 8443,
    type = 'HTTPS',
    useAsDirectReplacement = false,
) {

  return {
    enabled: true,
    type,
    host,
    port,
    useAsDirectReplacement,
  };

}

function explicitRule(pattern, action) {

  return {pattern, action, enabled: true};

}

const FIXTURES = Object.freeze([
  {
    name: 'explicit Direct ignores provider flags',
    host: 'explicit.test',
    pacMods: {
      exceptions: [explicitRule('explicit.test', 'DIRECT')],
      noDirect: true,
      replaceDirectWithProxy: true,
    },
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: Routing.SOURCES.EXPLICIT_DIRECT,
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'explicit Proxy ignores provider flags and has no Direct fallback',
    host: 'explicit.test',
    pacMods: {
      ownProxies: [ownProxy()],
      exceptions: [explicitRule('explicit.test', 'PROXY')],
      noDirect: true,
      replaceDirectWithProxy: true,
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: OWN,
  },
  {
    name: 'explicit Proxy without candidates fails closed',
    host: 'explicit.test',
    pacMods: {
      exceptions: [explicitRule('explicit.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedError: 'PROXY_RULE_NO_CANDIDATE',
  },
  {
    name: 'whitelist miss remains Direct despite provider flags',
    host: 'outside.test',
    pacMods: {
      whitelist: ['inside.test'],
      noDirect: true,
      replaceDirectWithProxy: true,
    },
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: Routing.SOURCES.WHITELIST_MISS,
    expectedPacResult: 'DIRECT',
  },
  {
    name: '.onion uses local Tor before provider policy',
    host: 'hidden-service.onion',
    pacMods: {
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      noDirect: true,
      replaceDirectWithProxy: true,
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: Routing.SOURCES.ONION,
    expectedPacResult: LOCAL_TOR,
  },
  {
    name: 'provider match returns the provider proxy',
    host: 'provider-match.test',
    pacMods: {},
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: 'PROVIDER_MATCH',
    expectedPacResult: PROVIDER_PROXY,
  },
  {
    name: 'provider miss returns Direct',
    host: 'provider-miss.test',
    pacMods: {},
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_MISS',
    expectedSource: 'PROVIDER_MISS',
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'empty provider result synthesizes Direct',
    host: 'provider-empty.test',
    pacMods: {},
    providerResult: '',
    providerSource: 'PROVIDER_EMPTY',
    expectedSource: 'PROVIDER_EMPTY',
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'provider proxy chain preserves ordered candidates',
    host: 'provider-chain.test',
    pacMods: {},
    providerResult: `${PROVIDER_PROXY}; ${PROVIDER_SOCKS}`,
    providerSource: 'PROVIDER_PROXY_CHAIN',
    expectedSource: 'PROVIDER_PROXY_CHAIN',
    expectedPacResult: `${PROVIDER_PROXY}; ${PROVIDER_SOCKS}`,
  },
  {
    name: 'noDirect removes only provider Direct',
    host: 'provider-chain.test',
    pacMods: {noDirect: true},
    providerResult: `${PROVIDER_PROXY}; DIRECT; ${PROVIDER_SOCKS}`,
    providerSource: 'PROVIDER_PROXY_CHAIN',
    expectedSource: 'PROVIDER_PROXY_CHAIN',
    expectedPacResult: `${PROVIDER_PROXY}; ${PROVIDER_SOCKS}`,
  },
  {
    name: 'replaceDirectWithProxy replaces provider Direct',
    host: 'provider-direct.test',
    pacMods: {
      ownProxies: [ownProxy(
          'own-proxy.test',
          8443,
          'HTTPS',
          true,
      )],
      replaceDirectWithProxy: true,
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: 'PROVIDER_DIRECT',
    expectedPacResult: OWN,
  },
  {
    name: 'own-sites-only does not broaden configured candidates',
    host: 'provider-direct.test',
    pacMods: {
      ownProxies: [ownProxy()],
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      warp: {enabled: true},
      ownProxiesOnlyForOwnSites: true,
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: 'PROVIDER_DIRECT',
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'disabled own-sites-only prepends the complete candidate list',
    host: 'provider-direct.test',
    pacMods: {
      ownProxies: [ownProxy()],
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      warp: {enabled: true},
      ownProxiesOnlyForOwnSites: false,
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: 'PROVIDER_DIRECT',
    expectedPacResult: [
      OWN,
      LOCAL_TOR,
      WARP_SOCKS,
      WARP_HTTPS,
      'DIRECT',
    ].join('; '),
  },
  {
    name: 'explicit Proxy orders own, local Tor, then WARP candidates',
    host: 'explicit.test',
    pacMods: {
      ownProxies: [
        ownProxy(),
        ownProxy('second-own.test', 1080, 'SOCKS4'),
      ],
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      warp: {enabled: true},
      exceptions: [explicitRule('explicit.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: [
      OWN,
      SECOND_OWN,
      LOCAL_TOR,
      WARP_SOCKS,
      WARP_HTTPS,
    ].join('; '),
  },
  {
    name: 'explicit Proxy orders own, Tor Browser, then WARP candidates',
    host: 'explicit.test',
    pacMods: {
      ownProxies: [ownProxy()],
      torBrowser: {enabled: true},
      warp: {enabled: true},
      exceptions: [explicitRule('explicit.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: [
      OWN,
      TOR_BROWSER,
      WARP_SOCKS,
      WARP_HTTPS,
    ].join('; '),
  },
  {
    name: 'Direct rule wins a combined precedence conflict',
    host: 'precedence.onion',
    pacMods: {
      ownProxies: [ownProxy()],
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      whitelist: ['different.test'],
      exceptions: [
        explicitRule('precedence.onion', 'PROXY'),
        explicitRule('precedence.onion', 'DIRECT'),
      ],
    },
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: Routing.SOURCES.EXPLICIT_DIRECT,
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'Proxy rule wins before whitelist and .onion handling',
    host: 'precedence.onion',
    pacMods: {
      ownProxies: [ownProxy()],
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      whitelist: ['different.test'],
      exceptions: [explicitRule('precedence.onion', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: `${OWN}; ${LOCAL_TOR}`,
  },
  {
    name: 'whitelist miss wins before .onion handling',
    host: 'outside.onion',
    pacMods: {
      localTor: {enabled: true},
      torBrowser: {enabled: false},
      whitelist: ['inside.test'],
    },
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: Routing.SOURCES.WHITELIST_MISS,
    expectedPacResult: 'DIRECT',
  },
  {
    name: '.onion without onion candidates uses provider policy',
    host: 'no-tor.onion',
    pacMods: {},
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: 'PROVIDER_MATCH',
    expectedPacResult: PROVIDER_PROXY,
  },
  {
    name: 'broad candidates precede provider candidates',
    host: 'provider-match.test',
    pacMods: {
      ownProxies: [ownProxy()],
      torBrowser: {enabled: true},
      warp: {enabled: true},
      ownProxiesOnlyForOwnSites: false,
    },
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: 'PROVIDER_MATCH',
    expectedPacResult: [
      OWN,
      TOR_BROWSER,
      WARP_SOCKS,
      WARP_HTTPS,
      PROVIDER_PROXY,
    ].join('; '),
  },
  {
    name: 'Direct replacement orders own, local Tor, then WARP',
    host: 'provider-direct.test',
    pacMods: {
      ownProxies: [ownProxy(
          'own-proxy.test',
          8443,
          'HTTPS',
          true,
      )],
      localTor: {
        enabled: true,
        useAsDirectReplacement: true,
      },
      torBrowser: {enabled: false},
      warp: {
        enabled: true,
        useAsDirectReplacement: true,
      },
      replaceDirectWithProxy: true,
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DIRECT',
    expectedSource: 'PROVIDER_DIRECT',
    expectedPacResult: [
      OWN,
      LOCAL_TOR,
      WARP_SOCKS,
      WARP_HTTPS,
    ].join('; '),
  },
  {
    name: 'disabled provider proxies synthesize Direct',
    host: 'provider-match.test',
    pacMods: {usePacScriptProxies: false},
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: 'PROVIDER_MATCH',
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'disabled provider proxies with noDirect fail closed',
    host: 'provider-match.test',
    pacMods: {
      usePacScriptProxies: false,
      noDirect: true,
    },
    providerResult: PROVIDER_PROXY,
    providerSource: 'PROVIDER_MATCH',
    expectedSource: 'PROVIDER_MATCH',
    expectedPacResult: '',
  },
  {
    name: 'exact host Proxy rule does not match a child host',
    host: 'child.exact.test',
    pacMods: {
      ownProxies: [ownProxy()],
      exceptions: [explicitRule('exact.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DEFAULT',
    expectedSource: 'PROVIDER_DEFAULT',
    expectedPacResult: 'DIRECT',
  },
  {
    name: 'wildcard Proxy rule matches its base host',
    host: 'wildcard.test',
    pacMods: {
      ownProxies: [ownProxy()],
      exceptions: [explicitRule('*.wildcard.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DEFAULT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: OWN,
  },
  {
    name: 'wildcard Proxy rule matches a child host',
    host: 'child.wildcard.test',
    pacMods: {
      ownProxies: [ownProxy()],
      exceptions: [explicitRule('*.wildcard.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DEFAULT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: OWN,
  },
  {
    name: 'legacy leading-star suffix behavior stays compatible',
    host: 'child.legacy.test',
    pacMods: {
      ownProxies: [ownProxy()],
      exceptions: [explicitRule('*legacy.test', 'PROXY')],
    },
    providerResult: 'DIRECT',
    providerSource: 'PROVIDER_DEFAULT',
    expectedSource: Routing.SOURCES.EXPLICIT_PROXY,
    expectedPacResult: OWN,
  },
]);

Mocha.describe('browser-neutral routing contract', function() {

  Mocha.before(function() {

    loadBackgroundModules();

  });

  FIXTURES.forEach((testCase) => {
    Mocha.it(`matches Chromium PAC: ${testCase.name}`, async function() {

      const cooked = await cook(testCase.pacMods, testCase.providerResult);
      const coreDecision = Routing.decideRoute(coreInput(testCase));
      if (testCase.expectedError) {
        Chai.expect(cooked.ok).to.equal(false);
        Chai.expect(cooked.error.code).to.equal(testCase.expectedError);
        Chai.expect(coreDecision).to.deep.equal({
          kind: Routing.KINDS.FAIL_CLOSED,
          source: testCase.expectedSource,
          code: testCase.expectedError,
        });
        return;
      }

      Chai.expect(cooked.ok).to.equal(true);
      const pacResult = evaluatePac(cooked.cookedPacData, testCase.host);
      Chai.expect(pacResult).to.equal(testCase.expectedPacResult);
      const pacDecision = decisionFromPacResult(
          pacResult,
          testCase.expectedSource,
      );
      Chai.expect(coreDecision).to.deep.equal(pacDecision);

    });
  });

  Mocha.it('fails closed when a candidate contains credential fields', function() {

    const decision = Routing.decideRoute({
      hostname: 'credential-field.test',
      rules: {
        proxy: [explicitRule('credential-field.test', 'PROXY')],
      },
      candidateGroups: {
        configured: {
          own: [{
            id: 'own:0',
            type: 'HTTPS',
            host: 'proxy.test',
            port: 443,
            username: '',
          }],
        },
      },
    });

    Chai.expect(decision).to.deep.equal({
      kind: Routing.KINDS.FAIL_CLOSED,
      source: Routing.SOURCES.ROUTING_INPUT,
      code: 'CREDENTIAL_VALUE_FORBIDDEN',
    });
    Chai.expect(decision).not.to.have.any.keys('candidates', 'username');

  });

  Mocha.it('returns no ambiguous result for invalid routing input', function() {

    Chai.expect(Routing.decideRoute({hostname: ''})).to.deep.equal({
      kind: Routing.KINDS.FAIL_CLOSED,
      source: Routing.SOURCES.ROUTING_INPUT,
      code: 'INVALID_HOSTNAME',
    });

  });

  Mocha.it('fails closed without an explicit provider result', function() {

    Chai.expect(Routing.decideRoute({
      hostname: 'provider-default.test',
    })).to.deep.equal({
      kind: Routing.KINDS.FAIL_CLOSED,
      source: Routing.SOURCES.ROUTING_INPUT,
      code: 'MISSING_PROVIDER_RESULT',
    });

  });

});
