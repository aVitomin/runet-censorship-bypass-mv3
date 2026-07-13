'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const vm = require('vm');
const {loadBackgroundModules} = require('./background-modules');

const PROVIDER = Object.freeze({key: 'test-provider'});
const RAW_PROVIDER_PAC = [
  'function FindProxyForURL(url, host) {',
  '  return "HTTPS provider.example:443; DIRECT";',
  '}',
].join('\n');
const RAW_DIRECT_PAC = [
  'function FindProxyForURL(url, host) {',
  '  return "DIRECT";',
  '}',
].join('\n');
const RAW_EMPTY_RESULT_PAC = [
  'function FindProxyForURL(url, host) {',
  '  return "";',
  '}',
].join('\n');
const RAW_INVALID_RESULT_PAC = [
  'function FindProxyForURL(url, host) {',
  '  return "INVALID";',
  '}',
].join('\n');
const RAW_THROWING_PAC = [
  'function FindProxyForURL(url, host) {',
  '  throw new Error("synthetic provider failure");',
  '}',
].join('\n');
const RAW_INITIALIZATION_THROW_PAC = [
  'throw new Error("synthetic initialization failure");',
  'function FindProxyForURL(url, host) { return "DIRECT"; }',
].join('\n');
const RAW_SYNTAX_ERROR_PAC = [
  'function FindProxyForURL(url, host) { return "DIRECT"; }',
  ')',
].join('\n');

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

  Mocha.it('leaves Auto/provider traffic on the provider with safe defaults', async function() {

    const result = await cook({
      ownProxies: [ownProxy('own.example', 443)],
    });
    const routed = evaluatePac(result.cookedPacData, 'auto.example');
    const defaults = global.mv3PacMods.normalizePacMods({});

    Chai.expect(routed).to.include('HTTPS provider.example:443');
    Chai.expect(routed).not.to.include('own.example');
    Chai.expect(defaults).to.include({
      usePacScriptProxies: true,
      ownProxiesOnlyForOwnSites: true,
      replaceDirectWithProxy: false,
      noDirect: false,
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

  Mocha.it('keeps explicit Proxy ahead of failing provider result paths',
      async function() {

        for (const rawPacData of [
          RAW_EMPTY_RESULT_PAC,
          RAW_INVALID_RESULT_PAC,
          RAW_THROWING_PAC,
        ]) {
          const result = await cook({
            ownProxies: [ownProxy('own.example', 443)],
            exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
          }, rawPacData);

          Chai.expect(result.ok).to.equal(true);
          Chai.expect(evaluatePac(result.cookedPacData, 'proxy.example'))
              .to.equal('HTTPS own.example:443');
        }

      });

  Mocha.it('characterizes Auto results without simulating Chromium fallback',
      async function() {

        const empty = await cook({}, RAW_EMPTY_RESULT_PAC);
        const invalid = await cook({}, RAW_INVALID_RESULT_PAC);
        const throwing = await cook({}, RAW_THROWING_PAC);

        Chai.expect(evaluatePac(empty.cookedPacData, 'auto.example'))
            .to.equal('DIRECT');
        Chai.expect(evaluatePac(invalid.cookedPacData, 'auto.example'))
            .to.equal('INVALID; DIRECT');
        Chai.expect(() => evaluatePac(throwing.cookedPacData, 'auto.example'))
            .to.throw('synthetic provider failure');

      });

  Mocha.it('cannot install the explicit wrapper after PAC initialization fails',
      async function() {

        const result = await cook({
          ownProxies: [ownProxy('own.example', 443)],
          exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
        }, RAW_INITIALIZATION_THROW_PAC);

        Chai.expect(result.ok).to.equal(true);
        Chai.expect(() => evaluatePac(result.cookedPacData, 'proxy.example'))
            .to.throw('synthetic initialization failure');

      });

  Mocha.it('accepts non-empty PAC text without pre-parsing its syntax',
      async function() {

        const syntaxError = await cook({}, RAW_SYNTAX_ERROR_PAC);

        Chai.expect(syntaxError.ok).to.equal(true);
        Chai.expect(() => evaluatePac(syntaxError.cookedPacData, 'auto.example'))
            .to.throw();

      });

  Mocha.it('characterizes malformed WARP candidate output for browser QA',
      async function() {

        const result = await cook({
          warp: {enabled: true, proxyString: 'INVALID'},
          exceptions: [{pattern: 'proxy.example', action: 'PROXY'}],
        });

        Chai.expect(result.ok).to.equal(true);
        Chai.expect(evaluatePac(result.cookedPacData, 'proxy.example'))
            .to.equal('INVALID');

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

  Mocha.it('removes Direct from a noDirect provider result', async function() {

    const result = await cook({noDirect: true}, RAW_DIRECT_PAC);

    Chai.expect(result.ok).to.equal(true);
    Chai.expect(evaluatePac(result.cookedPacData, 'direct.example'))
        .to.equal('');

  });

});
