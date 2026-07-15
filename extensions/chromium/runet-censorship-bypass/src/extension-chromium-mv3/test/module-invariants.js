'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Fs = require('fs');
const Mocha = require('mocha');
const Path = require('path');
const {loadBackgroundModules} = require('./background-modules');

const SERVICE_WORKER_SOURCE = Fs.readFileSync(
    Path.resolve(__dirname, '..', 'background', 'service-worker.js'),
    'utf8',
);
const PAGE_RPC_CLIENT_PATH = Path.resolve(
    __dirname,
    '..',
    'pages',
    'shared',
    'rpc-client.js',
);
const PAGE_CONSUMER_SOURCE = [
  Path.resolve(__dirname, '..', 'pages', 'options', 'index.js'),
  Path.resolve(__dirname, '..', 'pages', 'popup', 'index.js'),
  Path.resolve(__dirname, '..', 'pages', 'shared', 'placeholder-page.js'),
].map((filename) => Fs.readFileSync(filename, 'utf8')).join('\n');

const SELF_TEST_EXPORTS = Object.freeze([
  'mv3PacMods',
  'mv3Providers',
  'mv3PeriodicUpdate',
  'mv3ProxyAuth',
  'mv3ProxyHealth',
  'mv3ProxySettings',
  'mv3ActionStatus',
  'mv3PacCook',
  'mv3PacArtifacts',
  'mv3State',
  'mv3LegacyMigrationAudit',
  'mv3LegacyMigrationApply',
]);

Mocha.describe('MV3 background module invariants', function() {

  Mocha.before(function() {

    loadBackgroundModules();
    global.window = global;
    delete global.mv3Rpc;
    delete require.cache[require.resolve(PAGE_RPC_CLIENT_PATH)];
    require(PAGE_RPC_CLIENT_PATH);

  });

  SELF_TEST_EXPORTS.forEach((exportName) => {
    Mocha.it(`${exportName} passes its embedded checks`, function() {

      const checks = global[exportName].selfTest();
      const failures = Object.entries(checks)
          .filter((entry) => entry[1] !== true)
          .map((entry) => entry[0]);
      Chai.expect(Object.keys(checks), `${exportName} check count`).not.to.be.empty;
      Chai.expect(failures, `${exportName} failed checks`).to.deep.equal([]);

    });
  });

  Mocha.it('accepts only the documented refresh interval boundaries', function() {

    Chai.expect(global.mv3PeriodicUpdate.validateInterval(1)).to.equal(1);
    Chai.expect(global.mv3PeriodicUpdate.validateInterval(24 * 60))
        .to.equal(24 * 60);
    Chai.expect(() => global.mv3PeriodicUpdate.validateInterval(0))
        .to.throw(TypeError);
    Chai.expect(() => global.mv3PeriodicUpdate.validateInterval(24 * 60 + 1))
        .to.throw(TypeError);

  });

  Mocha.it('rejects remote HTTP and credential-bearing custom PAC URLs', function() {

    const validateUrl = (url, key) => global.mv3Providers.validateCustomProvider({
      label: 'Test PAC',
      urls: [url],
    }, {key});
    let remoteHttpError;
    let credentialError;
    const credentialUrl = [
      'https://user:',
      'synthetic-password',
      '@pac.example/proxy.pac',
    ].join('');
    try {
      validateUrl(
          'http://pac.example/proxy.pac',
          'custom:remote-http-provider',
      );
    } catch (err) {
      remoteHttpError = err;
    }
    try {
      validateUrl(
          credentialUrl,
          'custom:credential-provider',
      );
    } catch (err) {
      credentialError = err;
    }

    Chai.expect(remoteHttpError).to.have.property(
        'code',
        'CUSTOM_PROVIDER_URL_SCHEME',
    );
    Chai.expect(credentialError).to.have.property(
        'code',
        'CUSTOM_PROVIDER_URL_CREDENTIALS',
    );

  });

  Mocha.it('sanitizes every nested service-worker RPC response', function() {

    const rawBody = 'function FindProxyForURL(){return "DIRECT";}';
    const cookedBody = `${rawBody}\n// cooked`;
    const credentialUrl = [
      'https://rpc-user:',
      'synthetic-password',
      '@pac.example/proxy.pac?token=private',
    ].join('');
    const sanitized = global.mv3State.sanitizeRpcValue({
      ok: true,
      result: {
        rawPacData: rawBody,
        nested: [{
          cookedPacData: cookedBody,
          rawPacPreview: rawBody.slice(0, 12),
          cookedPacPreview: cookedBody.slice(0, 12),
          url: credentialUrl,
        }],
        pacCache: {
          rawPacSha256: 'raw-sha',
          rawPacSize: rawBody.length,
        },
        proxyControl: {
          rawValue: {
            mode: 'pac_script',
            pacScript: {
              data: cookedBody,
              mandatory: false,
            },
          },
        },
      },
    });
    const serialized = JSON.stringify(sanitized);

    Chai.expect(SERVICE_WORKER_SOURCE).to.match(
        /sendResponse\(mv3State\.sanitizeRpcValue\(response\)\)/,
    );
    Chai.expect(serialized).not.to.include(rawBody);
    Chai.expect(serialized).not.to.include(cookedBody);
    Chai.expect(serialized).not.to.include('synthetic-password');
    Chai.expect(sanitized.result.nested[0]).not.to.have.any.keys(
        'rawPacData',
        'cookedPacData',
        'rawPacPreview',
        'cookedPacPreview',
    );
    Chai.expect(sanitized.result.nested[0].url)
        .to.equal('https://***@pac.example/proxy.pac?token=private');
    Chai.expect(sanitized.result.pacCache).to.deep.equal({
      rawPacSha256: 'raw-sha',
      rawPacSize: rawBody.length,
    });
    Chai.expect(sanitized.result.proxyControl.rawValue.pacScript)
        .to.deep.equal({mandatory: false});

  });

  Mocha.it('keeps reduced PAC metadata usable in page consumers', function() {

    const customUrl = 'https://pac.example/private.pac?token=private#fragment';
    const builtInUrl = [
      'https://diagnostic-user:',
      'synthetic-password',
      '@pac.example/proxy.pac?token=private#fragment',
    ].join('');
    const formatUrl = global.mv3Rpc.formatPacSourceUrlForDiagnostics;
    const builtIn = global.mv3Providers.getBuiltInProviders()
        .find((provider) => provider.key === 'Антизапрет');
    const custom = global.mv3Providers.validateCustomProvider({
      label: 'Private test provider',
      urls: [customUrl],
    }, {key: 'custom:test-provider-0001'});

    Chai.expect(PAGE_CONSUMER_SOURCE).not.to.match(
        /\b(?:rawPacData|cookedPacData|rawPacPreview|cookedPacPreview)\b/,
    );
    Chai.expect(builtIn).to.include({
      label: 'Antizapret',
      readOnly: true,
      type: 'builtIn',
    });
    Chai.expect(builtIn.urls).not.to.be.empty;
    Chai.expect(formatUrl(builtIn.urls[0], builtIn.key))
        .to.equal(builtIn.urls[0]);
    Chai.expect(custom.urls).to.deep.equal([customUrl]);
    Chai.expect(formatUrl(customUrl, 'custom:test-provider-0001'))
        .to.equal('[custom provider URL hidden]');
    Chai.expect(formatUrl(builtInUrl, 'Антизапрет'))
        .to.equal('https://pac.example/proxy.pac');
    Chai.expect(formatUrl('https://pac.example/proxy.pac', 'Антизапрет'))
        .to.equal('https://pac.example/proxy.pac');
    Chai.expect(formatUrl('data:text/plain,DIRECT', 'onlyOwnSites'))
        .to.equal('[non-network PAC source]');

  });

  Mocha.it('applies non-empty PAC text with the current non-mandatory policy',
      async function() {

        const originalChrome = global.chrome;
        const setCalls = [];
        global.chrome = {
          runtime: {lastError: null},
          proxy: {
            settings: {
              get(options, callback) {

                callback({levelOfControl: 'controllable_by_this_extension'});

              },
              set(details, callback) {

                setCalls.push(details);
                callback();

              },
            },
          },
        };

        try {
          let emptyError;
          try {
            await global.mv3ProxySettings.applyPacScript({cookedPacData: '  '});
          } catch (err) {
            emptyError = err;
          }
          Chai.expect(emptyError).to.have.property('code', 'VALIDATION_ERROR');
          Chai.expect(setCalls).to.be.empty;

          const malformedPac = 'function FindProxyForURL(url, host) {';
          await global.mv3ProxySettings.applyPacScript({
            cookedPacData: malformedPac,
          });

          Chai.expect(setCalls).to.deep.equal([{
            value: {
              mode: 'pac_script',
              pacScript: {
                mandatory: false,
                data: malformedPac,
              },
            },
            scope: 'regular',
          }]);
        } finally {
          if (originalChrome === undefined) {
            delete global.chrome;
          } else {
            global.chrome = originalChrome;
          }
        }

      });

  Mocha.it('makes a selected migration idempotent and leaves its plan intact', function() {

    const password = ['migration', 'credential'].join('-');
    const desiredPacMods = global.mv3PacMods.normalizePacMods({
      ownProxies: [{
        type: 'HTTPS',
        host: 'proxy.example',
        port: 443,
        username: 'migration-user',
        password,
      }],
    });
    const plan = {
      detected: true,
      proposedMigration: {
        canMigrate: {
          pacMods: global.mv3PacMods.redactPacMods(desiredPacMods),
        },
        applyValues: {pacMods: desiredPacMods},
        cannotMigrate: [],
        warnings: [],
      },
    };
    const originalPlan = JSON.stringify(plan);
    const currentState = {
      currentPacProviderKey: null,
      pacUpdatePeriodInMinutes: 12,
      pacMods: global.mv3PacMods.normalizePacMods({}),
      notificationPrefs: {
        pacError: true,
        extError: true,
        noControl: true,
      },
    };
    const first = global.mv3LegacyMigrationApply.createApplyPlan({
      plan,
      currentState,
      strategy: 'overwriteSelected',
      fields: ['pacMods'],
    });
    const second = global.mv3LegacyMigrationApply.createApplyPlan({
      plan,
      currentState: Object.assign({}, currentState, first.patch),
      strategy: 'overwriteSelected',
      fields: ['pacMods'],
    });

    Chai.expect(first.ok).to.equal(true);
    Chai.expect(first.appliedFields).to.deep.equal(['pacMods']);
    Chai.expect(first.patch).not.to.have.property('proxyApply');
    Chai.expect(second.ok).to.equal(true);
    Chai.expect(second.appliedFields).to.deep.equal([]);
    Chai.expect(second.patch).to.deep.equal({});
    Chai.expect(JSON.stringify(plan)).to.equal(originalPlan);

  });

});
