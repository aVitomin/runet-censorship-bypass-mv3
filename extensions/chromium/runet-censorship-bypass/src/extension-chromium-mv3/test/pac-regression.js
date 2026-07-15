'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const vm = require('vm');
const {loadBackgroundModules} = require('./background-modules');

const PROVIDER = Object.freeze({key: 'test-provider'});
const PROVIDER_PROXY_RESULT = 'PROXY 192.0.2.10:8080';
const PROVIDER_MIXED_RESULT = [
  PROVIDER_PROXY_RESULT,
  'DIRECT',
  'SOCKS5 192.0.2.11:1080',
].join('; ');

function createProviderPac(proxyResult) {

  return [
    'function FindProxyForURL(url, host) {',
    '  if (host === "provider-proxy.test") {',
    `    return ${JSON.stringify(proxyResult)};`,
    '  }',
    '  return "DIRECT";',
    '}',
  ].join('\n');

}

const RAW_PROVIDER_PAC = createProviderPac(PROVIDER_PROXY_RESULT);

async function cook(pacMods, rawPacData = RAW_PROVIDER_PAC) {

  return global.mv3PacCook.cookPac({
    rawPacData,
    pacMods,
    provider: PROVIDER,
    sourceRawPacSha256: 'raw-test-sha256',
  });

}

function evaluatePac(cookedPacData, host) {

  const context = {};
  vm.createContext(context);
  vm.runInContext(cookedPacData, context);
  const findProxyForUrl = context.FindProxyForURL;
  return findProxyForUrl(`https://${host}/`, host);

}

function ownProxy(host, port) {

  return {
    enabled: true,
    type: 'HTTPS',
    host,
    port,
  };

}

Mocha.describe('MV3 PAC routing regressions', function() {

  Mocha.before(function() {

    loadBackgroundModules();

  });

  Mocha.it('keeps exact-host rules exact and wildcard rules domain-wide', async function() {

    const exact = await cook({
      ownProxies: [ownProxy('own.example', 443)],
      exceptions: [{pattern: 'api.example.com', action: 'PROXY'}],
    });
    const wildcard = await cook({
      ownProxies: [ownProxy('own.example', 443)],
      exceptions: [{pattern: '*.example.com', action: 'PROXY'}],
    });

    Chai.expect(evaluatePac(exact.cookedPacData, 'api.example.com'))
        .to.equal('HTTPS own.example:443');
    Chai.expect(evaluatePac(exact.cookedPacData, 'sub.api.example.com'))
        .not.to.include('own.example');
    Chai.expect(evaluatePac(wildcard.cookedPacData, 'example.com'))
        .to.equal('HTTPS own.example:443');
    Chai.expect(evaluatePac(wildcard.cookedPacData, 'sub.example.com'))
        .to.equal('HTTPS own.example:443');

  });

  Mocha.it('preserves the exact provider proxy result with safe defaults', async function() {

    const result = await cook({
      ownProxies: [ownProxy('own.example', 443)],
    });
    const defaults = global.mv3PacMods.normalizePacMods({});

    Chai.expect(defaults).to.include({
      usePacScriptProxies: true,
      ownProxiesOnlyForOwnSites: true,
      replaceDirectWithProxy: false,
      noDirect: false,
    });
    Chai.expect(evaluatePac(result.cookedPacData, 'provider-proxy.test'))
        .to.equal(PROVIDER_PROXY_RESULT);

  });

  Mocha.it('preserves the exact provider Direct result with no manual rule',
      async function() {

        const result = await cook({});

        Chai.expect(evaluatePac(result.cookedPacData, 'provider-direct.test'))
            .to.equal('DIRECT');

      });

  Mocha.it('lets an explicit Proxy rule override the provider result', async function() {

    const result = await cook({
      ownProxies: [ownProxy('explicit-proxy.test', 8443)],
      exceptions: [{pattern: 'provider-proxy.test', action: 'PROXY'}],
    });

    Chai.expect(evaluatePac(result.cookedPacData, 'provider-proxy.test'))
        .to.equal('HTTPS explicit-proxy.test:8443');

  });

  Mocha.it('lets an explicit Direct rule override the provider result', async function() {

    const result = await cook({
      exceptions: [{pattern: 'provider-proxy.test', action: 'DIRECT'}],
    });

    Chai.expect(evaluatePac(result.cookedPacData, 'provider-proxy.test'))
        .to.equal('DIRECT');

  });

  Mocha.it('restores the exact provider result after a manual rule returns to Auto',
      async function() {

        const manualMods = {
          ownProxies: [ownProxy('explicit-proxy.test', 8443)],
          exceptions: [{pattern: 'provider-proxy.test', action: 'PROXY'}],
        };
        const manual = await cook(manualMods);
        const auto = await cook(Object.assign({}, manualMods, {exceptions: []}));

        Chai.expect(evaluatePac(manual.cookedPacData, 'provider-proxy.test'))
            .to.equal('HTTPS explicit-proxy.test:8443');
        Chai.expect(evaluatePac(auto.cookedPacData, 'provider-proxy.test'))
            .to.equal(PROVIDER_PROXY_RESULT);

      });

  Mocha.it('does not broaden enabled candidates onto provider-Direct traffic',
      async function() {

        const cases = {
          ownProxy: {
            ownProxies: [ownProxy('own-proxy.test', 8443)],
          },
          tor: {
            localTor: {enabled: true},
          },
          warp: {
            warp: {
              enabled: true,
              proxyString: 'HTTPS warp-proxy.test:8443',
            },
          },
        };
        const actual = {};
        for (const [name, pacMods] of Object.entries(cases)) {
          const result = await cook(Object.assign({
            ownProxiesOnlyForOwnSites: true,
          }, pacMods));
          actual[name] = evaluatePac(
              result.cookedPacData,
              'provider-direct.test',
          );
        }

        Object.entries(actual).forEach(([name, result]) => {
          Chai.expect(result, name).to.equal('DIRECT');
        });

      });

  Mocha.it('gives explicit Direct precedence over explicit Proxy', async function() {

    const result = await cook({
      ownProxies: [ownProxy('own.example', 443)],
      exceptions: [
        {pattern: 'conflict.example', action: 'PROXY'},
        {pattern: 'conflict.example', action: 'DIRECT'},
      ],
    });

    Chai.expect(evaluatePac(result.cookedPacData, 'conflict.example'))
        .to.equal('DIRECT');

  });

  Mocha.it('rejects an explicit Proxy rule with no usable candidate', async function() {

    const result = await cook({
      exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
    });

    Chai.expect(result.ok).to.equal(false);
    Chai.expect(result.error.code).to.equal('PROXY_RULE_NO_CANDIDATE');

  });

  Mocha.it('preserves multiple candidate order without Direct or provider fallback',
      async function() {

        const result = await cook({
          ownProxies: [
            ownProxy('first.example', 443),
            {
              enabled: true,
              type: 'SOCKS5',
              host: 'second.example',
              port: 1080,
            },
          ],
          localTor: {enabled: true},
          warp: {enabled: true},
          exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
        });
        const routed = evaluatePac(result.cookedPacData, 'proxy.example');

        Chai.expect(routed).to.equal([
          'HTTPS first.example:443',
          'SOCKS5 second.example:1080',
          'SOCKS5 127.0.0.1:9050',
          'SOCKS5 127.0.0.1:40000',
          'HTTPS 127.0.0.1:40000',
        ].join('; '));
        Chai.expect(routed).not.to.include('DIRECT');
        Chai.expect(routed).not.to.include('provider.example');

      });

  Mocha.it('strips structured credentials from cooked PAC', async function() {

    const password = ['test', 'credential'].join('-');
    const result = await cook({
      ownProxies: [{
        enabled: true,
        type: 'HTTPS',
        host: 'credential-proxy.example',
        port: 443,
        username: 'test-user',
        password,
      }],
      exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
    });

    Chai.expect(result.ok).to.equal(true);
    Chai.expect(result.cookedPacData).not.to.include(password);
    Chai.expect(result.cookedPacData).not.to.include('test-user@');
    Chai.expect(evaluatePac(result.cookedPacData, 'proxy.example'))
        .to.equal('HTTPS credential-proxy.example:443');

  });

  Mocha.it('synthesizes Direct only for an empty provider result', async function() {

    const result = await cook({}, createProviderPac(''));

    Chai.expect(evaluatePac(result.cookedPacData, 'provider-proxy.test'))
        .to.equal('DIRECT');

  });

  Mocha.it('removes Direct without altering provider proxy candidate order',
      async function() {

        const result = await cook(
            {noDirect: true},
            createProviderPac(PROVIDER_MIXED_RESULT),
        );

        Chai.expect(result.ok).to.equal(true);
        Chai.expect(evaluatePac(result.cookedPacData, 'provider-direct.test'))
            .to.equal('');
        Chai.expect(evaluatePac(result.cookedPacData, 'provider-proxy.test'))
            .to.equal([
              PROVIDER_PROXY_RESULT,
              'SOCKS5 192.0.2.11:1080',
            ].join('; '));

      });

  async function cookWithDirectReplacement() {

    return cook({
      ownProxies: [{
        enabled: true,
        type: 'HTTPS',
        host: 'direct-replacement.test',
        port: 8443,
        useAsDirectReplacement: true,
      }],
      replaceDirectWithProxy: true,
    });

  }

  Mocha.it('replaces a provider Direct result exactly once when opted in',
      async function() {

        const result = await cookWithDirectReplacement();

        Chai.expect(evaluatePac(result.cookedPacData, 'provider-direct.test'))
            .to.equal('HTTPS direct-replacement.test:8443');

      });

  Mocha.it('does not alter a provider Proxy result during Direct replacement',
      async function() {

        const result = await cookWithDirectReplacement();

        Chai.expect(evaluatePac(result.cookedPacData, 'provider-proxy.test'))
            .to.equal(PROVIDER_PROXY_RESULT);

      });

});
