'use strict';

const Assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');
const Settings = require('../background/settings-control');
const Ui = require('../pages/shared/ui-runtime');
const Popup = require('../pages/popup');
const Options = require('../pages/options');

const sourceRoot = Path.resolve(__dirname, '..');

function capabilities(overrides = {}) {

  return Object.assign({
    apiVersion: 2,
    browser: 'FIREFOX',
    manifestVersion: 3,
    runtimeModel: 'BACKGROUND_EVENT_PAGE',
    runtimeState: 'OFF',
    durableIntent: 'OFF',
    recoveryStatus: 'OFF',
    recoveryFailureCode: null,
    privateWindowAccess: 'GRANTED',
    routingImplemented: true,
    activationSupported: true,
    providerDatasetImplemented: true,
    providerDatasetAvailable: true,
  }, overrides);

}

function settingsResult(revision = 0, patch = null) {

  const settings = Settings.createDefaultSettings();
  if (patch) {
    patch(settings);
  }
  return {revision, settings};

}

function siteState(overrides = {}) {

  return Object.assign({
    schemaVersion: 1,
    revision: 0,
    target: {
      controllable: true,
      host: 'sub.example.com',
      reasonCode: null,
    },
    route: {mode: 'AUTO', scope: 'DOMAIN', pattern: '*.example.com'},
    patterns: {
      exact: 'sub.example.com',
      wildcard: '*.example.com',
      wildcardAvailable: true,
    },
    proxyCandidateAvailable: true,
  }, overrides);

}

function operationalResult(overrides = {}) {

  return Object.assign({
    schemaVersion: 1,
    health: {
      status: 'UNKNOWN', code: null, checkedAt: null, candidateType: null,
    },
    diagnostics: {
      schemaVersion: 1,
      generatedAt: 1000,
      extensionVersion: '0.0.4.0',
      browserName: 'Firefox',
      browserVersion: '154.0.1',
      runtimeState: 'OFF',
      durableIntent: 'OFF',
      recoveryStatus: 'OFF',
      recoveryFailureCode: null,
      controlLevel: 'controllable_by_this_extension',
      datasetAvailable: true,
      datasetVersion: 'public-v1',
      configuredProxyCount: 4,
      enabledProxyCount: 0,
      proxyTypes: ['HTTPS', 'SOCKS5'],
      privateWindowAccess: 'GRANTED',
      notificationsAvailable: true,
    },
  }, overrides);

}

function popupController(options) {

  return Popup.createController(Object.assign({
    getActiveTabUrl: async () => 'https://sub.example.com/private',
  }, options));

}

function failure(code) {

  const error = new Error('synthetic secret-bearing detail');
  error.code = code;
  return error;

}

function deferred() {

  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return {promise, resolve};

}

describe('Firefox production UI controllers', function() {

  it('renders OFF as Enable without claiming active protection', function() {

    const view = Popup.presentation(capabilities());

    Assert.strictEqual(view.kind, 'OFF');
    Assert.strictEqual(view.action, 'ENABLE');
    Assert.notStrictEqual(view.titleKey, 'popupStateActive');

  });

  it('renders INITIALIZING without an unsafe action', function() {

    const view = Popup.presentation(capabilities({
      runtimeState: 'INITIALIZING',
      recoveryStatus: 'INITIALIZING',
    }));

    Assert.strictEqual(view.kind, 'INITIALIZING');
    Assert.strictEqual(view.action, 'NONE');

  });

  it('renders READY as ACTIVE only after runtime readiness', function() {

    const view = Popup.presentation(capabilities({
      runtimeState: 'READY', durableIntent: 'ON', recoveryStatus: 'ACTIVE',
    }));

    Assert.strictEqual(view.kind, 'ACTIVE');
    Assert.strictEqual(view.action, 'DISABLE');

  });

  it('distinguishes a recovered READY session', function() {

    const view = Popup.presentation(capabilities({
      runtimeState: 'READY', durableIntent: 'ON', recoveryStatus: 'RECOVERED',
    }));

    Assert.strictEqual(view.kind, 'RECOVERED');
    Assert.strictEqual(view.titleKey, 'popupStateRecovered');

  });

  it('renders control loss as external and permits safe Disable', function() {

    const view = Popup.presentation(capabilities({
      runtimeState: 'FAILED',
      durableIntent: 'ON',
      recoveryStatus: 'BLOCKED_CONTROL_LOSS',
    }));

    Assert.strictEqual(view.kind, 'EXTERNAL');
    Assert.strictEqual(view.action, 'DISABLE');

  });

  it('never shows ACTIVE when private access is denied', function() {

    const view = Popup.presentation(capabilities({
      runtimeState: 'READY',
      durableIntent: 'ON',
      recoveryStatus: 'ACTIVE',
      privateWindowAccess: 'DENIED',
    }));

    Assert.strictEqual(view.kind, 'BLOCKED');
    Assert.strictEqual(view.helpKey, 'popupHelpPrivateBlocked');

  });

  it('runs Apply then refreshes capabilities', async function() {

    const calls = [];
    const controller = popupController({rpc: {async call(message) {

      calls.push(message);
      if (message.type === 'firefox.activation.apply') {
        return {intent: 'ON', status: 'ACTIVE'};
      }
      if (message.type === 'firefox.site.get') {
        return siteState();
      }
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      return capabilities({
        runtimeState: calls.length > 1 ? 'READY' : 'OFF',
        durableIntent: calls.length > 1 ? 'ON' : 'OFF',
        recoveryStatus: calls.length > 1 ? 'ACTIVE' : 'OFF',
      });

    }}});
    Assert.strictEqual(await controller.apply(), true);

    Assert.deepStrictEqual(calls.map((item) => item.type), [
      'firefox.activation.apply',
      'firefox.capabilities.get',
      'firefox.site.get',
      'firefox.operational.get',
    ]);
    Assert.strictEqual(controller.snapshot().capabilities.runtimeState, 'READY');

  });

  it('runs Clear then refreshes to OFF', async function() {

    const calls = [];
    const controller = popupController({rpc: {async call(message) {

      calls.push(message.type);
      if (message.type === 'firefox.capabilities.get') return capabilities();
      if (message.type === 'firefox.site.get') return siteState();
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      return {intent: 'OFF', status: 'OFF'};

    }}});

    Assert.strictEqual(await controller.clear(), true);
    Assert.deepStrictEqual(calls, [
      'firefox.activation.clear', 'firefox.capabilities.get',
      'firefox.site.get', 'firefox.operational.get',
    ]);
    Assert.strictEqual(controller.snapshot().capabilities.runtimeState, 'OFF');

  });

  it('locks duplicate popup operations while one is pending', async function() {

    const gate = deferred();
    let calls = 0;
    const controller = popupController({rpc: {async call(message) {

      calls += 1;
      if (message.type === 'firefox.activation.apply') {
        await gate.promise;
        return {intent: 'ON', status: 'ACTIVE'};
      }
      if (message.type === 'firefox.site.get') return siteState();
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      return capabilities({
        runtimeState: 'READY', durableIntent: 'ON', recoveryStatus: 'ACTIVE',
      });

    }}});
    const first = controller.apply();
    Assert.strictEqual(await controller.apply(), false);
    gate.resolve();
    Assert.strictEqual(await first, true);
    Assert.strictEqual(calls, 4);

  });

  it('maps unknown popup failures to generic sanitized state', async function() {

    const controller = popupController({rpc: {async call() {

      throw new Error('private URL and raw browser detail');

    }}});

    Assert.strictEqual(await controller.refresh(), false);
    Assert.strictEqual(controller.snapshot().errorCode, 'UI_RPC_FAILED');
    Assert.strictEqual(Popup.userErrorKey('UNEXPECTED'), 'popupErrorGeneric');

  });

  it('rejects malformed capability responses', function() {

    Assert.throws(
        () => Ui.validateCapabilities({runtimeState: 'READY'}),
        (error) => error.code === 'UI_RPC_FAILED',
    );

  });

  it('validates a minimal secret-free current-site response', function() {

    const value = Popup.validateSiteState(siteState());
    Assert.strictEqual(value.target.host, 'sub.example.com');
    Assert.strictEqual(value.route.mode, 'AUTO');
    Assert.deepStrictEqual(Object.keys(value).sort(), [
      'patterns', 'proxyCandidateAvailable', 'revision', 'route',
      'schemaVersion', 'target',
    ]);
    Assert.deepStrictEqual(Object.keys(value.target).sort(), [
      'controllable', 'host', 'reasonCode',
    ]);
    Assert.strictEqual(Object.hasOwn(value, 'tabUrl'), false);
    Assert.throws(
        () => Popup.validateSiteState(Object.assign(siteState(), {
          unexpectedTabData: 'must-not-cross-the-response-boundary',
        })),
        (error) => error.code === 'UI_RPC_FAILED',
    );

  });

  it('distinguishes pending site changes from the applied route', function() {

    const site = siteState();
    Assert.strictEqual(Popup.isDraftDirty(site, {
      mode: 'AUTO', scope: 'DOMAIN',
    }), false);
    Assert.strictEqual(Popup.isDraftDirty(site, {
      mode: 'DIRECT', scope: 'HOST',
    }), true);

  });

  it('persists the current-site draft before production Apply', async function() {

    const calls = [];
    const controller = popupController({rpc: {async call(message) {

      calls.push(message);
      if (message.type === 'firefox.site.replace') {
        return siteState({
          revision: 1,
          route: {
            mode: message.mode,
            scope: message.scope,
            pattern: 'sub.example.com',
          },
        });
      }
      if (message.type === 'firefox.activation.apply') {
        return {intent: 'ON', status: 'ACTIVE'};
      }
      if (message.type === 'firefox.site.get') {
        return siteState({
          revision: calls.some((item) =>
            item.type === 'firefox.site.replace') ? 1 : 0,
          route: calls.some((item) =>
            item.type === 'firefox.site.replace') ?
            {mode: 'DIRECT', scope: 'HOST', pattern: 'sub.example.com'} :
            {mode: 'AUTO', scope: 'DOMAIN', pattern: '*.example.com'},
        });
      }
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      return capabilities({
        runtimeState: calls.some((item) =>
          item.type === 'firefox.activation.apply') ? 'READY' : 'OFF',
        durableIntent: calls.some((item) =>
          item.type === 'firefox.activation.apply') ? 'ON' : 'OFF',
        recoveryStatus: calls.some((item) =>
          item.type === 'firefox.activation.apply') ? 'ACTIVE' : 'OFF',
      });

    }}});
    await controller.refresh();
    Assert.strictEqual(await controller.apply({
      mode: 'DIRECT', scope: 'HOST',
    }), true);
    Assert.deepStrictEqual(calls.map((item) => item.type), [
      'firefox.capabilities.get',
      'firefox.site.get',
      'firefox.operational.get',
      'firefox.site.replace',
      'firefox.activation.apply',
      'firefox.capabilities.get',
      'firefox.site.get',
      'firefox.operational.get',
    ]);
    Assert.deepStrictEqual(calls[3], {
      type: 'firefox.site.replace',
      tabUrl: 'https://sub.example.com/private',
      expectedRevision: 0,
      mode: 'DIRECT',
      scope: 'HOST',
    });

  });

  it('shows external-control loss distinctly from generic blocked state',
      function() {

        const view = Popup.presentation(capabilities({
          runtimeState: 'FAILED',
          durableIntent: 'OFF',
          recoveryStatus: 'BLOCKED_CONTROL_LOSS',
          recoveryFailureCode: 'CONTROL_LOSS',
        }));
        Assert.strictEqual(view.kind, 'EXTERNAL');
        Assert.strictEqual(view.titleKey, 'popupStateExternal');

      });

  it('permits options editing only in complete durable OFF', function() {

    Assert.strictEqual(Options.editableFromCapabilities(capabilities()), true);
    for (const value of [
      capabilities({runtimeState: 'READY', durableIntent: 'ON',
        recoveryStatus: 'ACTIVE'}),
      capabilities({runtimeState: 'INITIALIZING',
        recoveryStatus: 'INITIALIZING'}),
      capabilities({runtimeState: 'FAILED', durableIntent: 'ON',
        recoveryStatus: 'BLOCKED_PRIVATE_ACCESS'}),
      capabilities({recoveryStatus: 'OFF_RECONCILIATION_FAILED'}),
    ]) {
      Assert.strictEqual(Options.editableFromCapabilities(value), false);
    }

  });

  it('preserves rule text for background-authoritative normalization', function() {

    Assert.deepStrictEqual(
        Options.parseRuleLines(' Example.COM. \n\n*.Example.org '),
        ['Example.COM.', '*.Example.org'],
    );

  });

  it('encodes password KEEP without a password value', function() {

    Assert.deepStrictEqual(
        Options.credentialPayload(
            {mode: 'KEEP', username: 'user'}, 'KEEP', 'user', 'ignored',
        ),
        {mode: 'KEEP', username: 'user'},
    );

  });

  it('encodes explicit password replacement and clear', function() {

    Assert.deepStrictEqual(
        Options.credentialPayload(null, 'SET', 'user', 'new-value'),
        {mode: 'SET', username: 'user', password: 'new-value'},
    );
    Assert.deepStrictEqual(
        Options.credentialPayload(
            {mode: 'KEEP', username: 'user'}, 'NONE', '', '',
        ),
        {mode: 'NONE'},
    );

  });

  it('validates proxy host, port, type, and identifier locally', function() {

    const valid = {
      id: 'fixture', type: 'HTTPS', host: 'proxy.example', port: 443,
      proxyDNS: false, failoverTimeoutSeconds: null,
    };
    Assert.strictEqual(Options.validateCandidate(valid, true), valid);
    for (const invalid of [
      Object.assign({}, valid, {host: ''}),
      Object.assign({}, valid, {port: 0}),
      Object.assign({}, valid, {port: 65536}),
      Object.assign({}, valid, {type: 'DIRECT'}),
      Object.assign({}, valid, {id: ''}),
    ]) {
      Assert.throws(() => Options.validateCandidate(invalid, true));
    }

  });

  it('loads capabilities, settings, and exact revision', async function() {

    const rpc = {async call(message) {

      return message.type === 'firefox.capabilities.get' ?
        capabilities() : message.type === 'firefox.settings.get' ?
          settingsResult(7) : operationalResult();

    }};
    const controller = Options.createController({rpc});

    Assert.strictEqual(await controller.load(), true);
    Assert.strictEqual(controller.snapshot().revision, 7);
    Assert.strictEqual(controller.snapshot().editable, true);

  });

  it('saves with the exact loaded revision', async function() {

    const calls = [];
    const rpc = {async call(message) {

      calls.push(message);
      if (message.type === 'firefox.capabilities.get') return capabilities();
      if (message.type === 'firefox.settings.get') return settingsResult(3);
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      return settingsResult(4, (settings) => {
        settings.flags.noDirect = true;
      });

    }};
    const controller = Options.createController({rpc});
    await controller.load();
    const next = Settings.createDefaultSettings();
    next.flags.noDirect = true;

    Assert.strictEqual(await controller.save(next), true);
    Assert.strictEqual(calls[3].expectedRevision, 3);
    Assert.strictEqual(calls[3].settings.flags.noDirect, true);
    Assert.strictEqual(controller.snapshot().revision, 4);

  });

  it('reloads instead of overwriting on revision conflict', async function() {

    let settingsReads = 0;
    const rpc = {async call(message) {

      if (message.type === 'firefox.capabilities.get') return capabilities();
      if (message.type === 'firefox.settings.get') {
        settingsReads += 1;
        return settingsResult(settingsReads === 1 ? 1 : 2, (settings) => {
          settings.flags.noDirect = settingsReads > 1;
        });
      }
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      throw failure('SETTINGS_REVISION_CONFLICT');

    }};
    const controller = Options.createController({rpc});
    await controller.load();

    Assert.strictEqual(
        await controller.save(Settings.createDefaultSettings()),
        false,
    );
    Assert.strictEqual(controller.snapshot().notice, 'REVISION_CONFLICT');
    Assert.strictEqual(controller.snapshot().revision, 2);
    Assert.strictEqual(controller.snapshot().settings.flags.noDirect, true);

  });

  it('never sends settings writes while active', async function() {

    const calls = [];
    const rpc = {async call(message) {

      calls.push(message.type);
      if (message.type === 'firefox.capabilities.get') {
        return capabilities({
          runtimeState: 'READY', durableIntent: 'ON', recoveryStatus: 'ACTIVE',
        });
      }
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      return settingsResult();

    }};
    const controller = Options.createController({rpc});
    await controller.load();

    Assert.strictEqual(
        await controller.save(Settings.createDefaultSettings()),
        false,
    );
    Assert.strictEqual(calls.includes('firefox.settings.replace'), false);

  });

  it('locks duplicate option saves while one is pending', async function() {

    const gate = deferred();
    let replaceCalls = 0;
    const rpc = {async call(message) {

      if (message.type === 'firefox.capabilities.get') return capabilities();
      if (message.type === 'firefox.settings.get') return settingsResult();
      if (message.type === 'firefox.operational.get') {
        return operationalResult();
      }
      replaceCalls += 1;
      await gate.promise;
      return settingsResult(1);

    }};
    const controller = Options.createController({rpc});
    await controller.load();
    const first = controller.save(Settings.createDefaultSettings());
    Assert.strictEqual(
        await controller.save(Settings.createDefaultSettings()),
        false,
    );
    gate.resolve();
    Assert.strictEqual(await first, true);
    Assert.strictEqual(replaceCalls, 1);

  });

  it('rejects malformed settings responses without rendering them', function() {

    Assert.throws(
        () => Options.validateSettingsResult({revision: 0, settings: {}}),
        (error) => error.code === 'UI_RPC_FAILED',
    );
    const secretBearing = settingsResult();
    secretBearing.settings.ownProxies.push({
      id: 'unexpected-secret',
      enabled: true,
      type: 'HTTP',
      host: 'proxy.example',
      port: 8080,
      proxyDNS: false,
      failoverTimeoutSeconds: null,
      useAsDirectReplacement: false,
      credentials: {
        mode: 'KEEP',
        username: 'fixture',
        password: 'must-not-enter-ui-state',
      },
    });
    Assert.throws(
        () => Options.validateSettingsResult(secretBearing),
        (error) => error.code === 'UI_RPC_FAILED',
    );

  });

  it('validates only the fixed sanitized operational schema', function() {

    const value = Ui.validateOperationalStatus(operationalResult());
    Assert.strictEqual(value.health.status, 'UNKNOWN');
    Assert.deepStrictEqual(value.diagnostics.proxyTypes, ['HTTPS', 'SOCKS5']);
    const malformed = operationalResult();
    malformed.diagnostics = Object.assign({}, malformed.diagnostics, {
      proxyEndpoint: 'must-not-enter-diagnostics',
    });
    Assert.throws(
        () => Ui.validateOperationalStatus(malformed),
        (error) => error.code === 'UI_RPC_FAILED',
    );
    const unknownHealth = operationalResult();
    unknownHealth.health = Object.assign({}, unknownHealth.health, {
      code: 'UNTRUSTED_HEALTH_TEXT',
    });
    Assert.throws(
        () => Ui.validateOperationalStatus(unknownHealth),
        (error) => error.code === 'UI_RPC_FAILED',
    );
    const unknownRecovery = operationalResult();
    unknownRecovery.diagnostics = Object.assign(
        {}, unknownRecovery.diagnostics, {recoveryStatus: 'UNTRUSTED_STATE'},
    );
    Assert.throws(
        () => Ui.validateOperationalStatus(unknownRecovery),
        (error) => error.code === 'UI_RPC_FAILED',
    );

  });

  it('exports diagnostics without credentials, URLs, hashes, or floor data',
      function() {

        const exported = JSON.parse(Options.diagnosticsExport(
            operationalResult(),
        ));
        Assert.deepStrictEqual(Object.keys(exported).sort(),
            [...Ui.DIAGNOSTIC_KEYS].sort());
        for (const forbidden of [
          'credentials', 'password', 'authRef', 'tabUrl', 'targetOrigin',
          'proxyEndpoint', 'datasetHash', 'floorIdentity',
        ]) {
          Assert.strictEqual(Object.hasOwn(exported, forbidden), false);
        }

      });

  it('runs popup health for the exact transient tab URL then refreshes',
      async function() {

        const calls = [];
        const controller = popupController({rpc: {async call(message) {

          calls.push(message);
          if (message.type === 'firefox.capabilities.get') {
            return capabilities({
              runtimeState: 'READY', durableIntent: 'ON',
              recoveryStatus: 'ACTIVE',
            });
          }
          if (message.type === 'firefox.site.get') {
            return siteState({
              route: {
                mode: 'PROXY', scope: 'HOST', pattern: 'sub.example.com',
              },
            });
          }
          if (message.type === 'firefox.health.check') {
            return {
              status: 'OK', code: null, checkedAt: 1001,
              candidateType: 'ownProxy',
            };
          }
          return operationalResult();

        }}});
        await controller.refresh();
        Assert.strictEqual(await controller.checkHealth(), true);
        const request = calls.find((message) =>
          message.type === 'firefox.health.check');
        Assert.deepStrictEqual(request, {
          type: 'firefox.health.check',
          tabUrl: 'https://sub.example.com/private',
        });

      });

  it('runs the Maintenance health check without caller-controlled config',
      async function() {

        const calls = [];
        const rpc = {async call(message) {

          calls.push(message);
          if (message.type === 'firefox.capabilities.get') {
            return capabilities({
              runtimeState: 'READY', durableIntent: 'ON',
              recoveryStatus: 'ACTIVE',
            });
          }
          if (message.type === 'firefox.settings.get') {
            return settingsResult();
          }
          if (message.type === 'firefox.health.check') {
            return {
              status: 'INCONCLUSIVE', code: 'HEALTH_TARGET_REQUIRED',
              checkedAt: 1001, candidateType: null,
            };
          }
          return operationalResult();

        }};
        const controller = Options.createController({rpc});
        await controller.load();
        Assert.strictEqual(await controller.checkHealth(), true);
        Assert.deepStrictEqual(calls.find((message) =>
          message.type === 'firefox.health.check'), {
          type: 'firefox.health.check',
        });

      });

  it('falls back to the message key without throwing', function() {

    const browserApi = {i18n: {getMessage() {

      return '';

    }}};
    Assert.strictEqual(Ui.translate(browserApi, 'missingMessage'),
        'missingMessage');
    Assert.strictEqual(Ui.translate({}, 'missingMessage'), 'missingMessage');

  });

  it('keeps English and Russian catalogs complete and distinct', function() {

    const catalogs = ['en', 'ru'].map((language) => JSON.parse(
        Fs.readFileSync(
            Path.join(sourceRoot, '_locales', language, 'messages.json'),
            'utf8',
        ),
    ));
    Assert.deepStrictEqual(
        Object.keys(catalogs[0]).sort(), Object.keys(catalogs[1]).sort(),
    );
    Assert.ok(Object.values(catalogs[0]).every((entry) => entry.message));
    Assert.ok(Object.values(catalogs[1]).every((entry) => entry.message));
    Assert.notStrictEqual(
        catalogs[0].popupStateActive.message,
        catalogs[1].popupStateActive.message,
    );

  });

  it('defines every static and generated UI message in both catalogs', function() {

    const catalogs = ['en', 'ru'].map((language) => JSON.parse(
        Fs.readFileSync(
            Path.join(sourceRoot, '_locales', language, 'messages.json'),
            'utf8',
        ),
    ));
    const sources = [
      'pages/popup/index.js',
      'pages/options/index.js',
    ].map((relative) => Fs.readFileSync(
        Path.join(sourceRoot, relative), 'utf8',
    )).join('\n');
    const used = new Set(Array.from(
        sources.matchAll(/\bt\('([^']+)'/g),
        (match) => match[1],
    ));
    for (const key of [
      'credentialKEEP',
      'credentialNONE',
      'credentialSET',
      'flagNoDirect',
      'flagOwnProxiesOnlyForOwnSites',
      'flagReplaceDirectWithProxy',
      'flagUseProviderProxies',
      'popupPillOFF',
      'popupPillACTIVE',
      'popupPillRECOVERED',
      'popupPillINITIALIZING',
      'popupPillBLOCKED',
      'popupPillEXTERNAL',
      'popupModeAUTO',
      'popupModePROXY',
      'popupModeDIRECT',
      'healthCode_HEALTH_CHECK_FAILED',
      'healthCode_HEALTH_CHECK_INTERRUPTED',
      'healthCode_HEALTH_CHECK_SUPERSEDED',
      'healthCode_HEALTH_CHECK_TIMEOUT',
      'healthCode_HEALTH_NOT_ACTIVE',
      'healthCode_HEALTH_PROXY_CANDIDATE_UNAVAILABLE',
      'healthCode_HEALTH_PROXY_RULE_REQUIRED',
      'healthCode_HEALTH_TARGET_REQUIRED',
    ]) {
      used.add(key);
    }
    for (const key of used) {
      Assert.ok(catalogs[0][key] && catalogs[0][key].message, `en:${key}`);
      Assert.ok(catalogs[1][key] && catalogs[1][key].message, `ru:${key}`);
    }

  });

  it('uses text-only DOM construction and never embeds stored passwords', function() {

    const sources = [
      'pages/shared/ui-runtime.js',
      'pages/popup/index.js',
      'pages/options/index.js',
    ].map((relative) => Fs.readFileSync(
        Path.join(sourceRoot, relative), 'utf8',
    )).join('\n');
    for (const forbidden of [
      'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'console.',
      'setAttribute(\'value\'', 'setAttribute("value"',
    ]) {
      Assert.strictEqual(sources.includes(forbidden), false, forbidden);
    }
    Assert.match(sources, /fieldNewPassword', 'password', '', 'password'/);

  });

});
