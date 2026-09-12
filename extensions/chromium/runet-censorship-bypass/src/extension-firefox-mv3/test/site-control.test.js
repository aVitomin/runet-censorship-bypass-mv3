'use strict';

const Assert = require('node:assert');
const SiteControl = require('../background/site-control');
const Settings = require('../background/settings-control');

function createSettingsController(options = {}) {

  let revision = options.revision || 0;
  let settings = options.settings || Settings.createDefaultSettings();
  const calls = [];
  return {
    calls,
    async get() {

      calls.push({kind: 'get'});
      return {revision, settings: JSON.parse(JSON.stringify(settings))};

    },
    async replace(expectedRevision, next) {

      calls.push({kind: 'replace', expectedRevision, next});
      if (expectedRevision !== revision) {
        const error = new Error('SETTINGS_REVISION_CONFLICT');
        error.code = 'SETTINGS_REVISION_CONFLICT';
        throw error;
      }
      revision += 1;
      settings = JSON.parse(JSON.stringify(next));
      return {revision, settings: JSON.parse(JSON.stringify(settings))};

    },
  };

}

describe('Firefox current-site settings control', function() {

  it('accepts only HTTP(S) tabs and returns only a normalized host', function() {

    Assert.deepStrictEqual(
        SiteControl.targetFromUrl('https://Sub.Example.COM./private?q=secret'),
        {controllable: true, host: 'sub.example.com', reasonCode: null},
    );
    for (const value of [
      'about:config',
      'moz-extension://fixture/options.html',
      'file:///tmp/private',
      'https://user:secret@example.com/',
      'not a URL',
    ]) {
      Assert.strictEqual(
          SiteControl.targetFromUrl(value).controllable,
          false,
          value,
      );
    }

  });

  it('uses public-suffix and private-suffix domain scopes', function() {

    Assert.deepStrictEqual(
        SiteControl.patternsForHost('a.b.example.co.uk'),
        {
          exact: 'a.b.example.co.uk',
          wildcard: '*.example.co.uk',
          wildcardAvailable: true,
        },
    );
    Assert.strictEqual(
        SiteControl.patternsForHost('site.github.io').wildcard,
        '*.site.github.io',
    );
    Assert.strictEqual(
        SiteControl.patternsForHost('localhost').wildcardAvailable,
        false,
    );

  });

  it('reports Direct precedence before Proxy for conflicting legacy settings',
      function() {

        const settings = Settings.createDefaultSettings();
        const patterns = SiteControl.patternsForHost('sub.example.com');
        settings.rules.direct = ['*.example.com'];
        settings.rules.proxy = ['sub.example.com'];
        Assert.deepStrictEqual(SiteControl.routeForSettings(settings, patterns), {
          mode: 'DIRECT', scope: 'DOMAIN', pattern: '*.example.com',
        });
        settings.rules.proxy = [];
        Assert.deepStrictEqual(
            SiteControl.routeForSettings(settings, patterns),
            {mode: 'DIRECT', scope: 'DOMAIN', pattern: '*.example.com'},
        );

      });

  it('reports Auto with the safe domain scope by default', function() {

    const settings = Settings.createDefaultSettings();
    Assert.deepStrictEqual(
        SiteControl.routeForSettings(
            settings,
            SiteControl.patternsForHost('sub.example.com'),
        ),
        {mode: 'AUTO', scope: 'DOMAIN', pattern: '*.example.com'},
    );

  });

  it('replaces only managed Direct/Proxy patterns and preserves whitelist',
      function() {

        const settings = Settings.createDefaultSettings();
        settings.rules.direct = ['sub.example.com', '*.example.com', 'other'];
        settings.rules.proxy = ['sub.example.com', '*.example.com', 'proxy'];
        settings.rules.whitelist = ['*.example.com'];
        const patterns = SiteControl.patternsForHost('sub.example.com');
        const next = SiteControl.applyRoute(
            settings, patterns, 'PROXY', 'DOMAIN',
        );

        Assert.deepStrictEqual(next.rules.direct, ['other']);
        Assert.deepStrictEqual(next.rules.proxy, ['proxy', '*.example.com']);
        Assert.deepStrictEqual(next.rules.whitelist, ['*.example.com']);
        Assert.deepStrictEqual(settings.rules.direct, [
          'sub.example.com', '*.example.com', 'other',
        ]);

      });

  it('Auto removes the managed override without inventing provider state',
      function() {

        const settings = Settings.createDefaultSettings();
        settings.rules.proxy = ['*.example.com'];
        const next = SiteControl.applyRoute(
            settings,
            SiteControl.patternsForHost('www.example.com'),
            'AUTO',
            'DOMAIN',
        );
        Assert.deepStrictEqual(next.rules.proxy, []);
        Assert.deepStrictEqual(next.rules.direct, []);

      });

  it('counts only candidates enabled for explicit Proxy rules', function() {

    const settings = Settings.createDefaultSettings();
    Assert.strictEqual(SiteControl.proxyCandidateCount(settings), 0);
    settings.localTor.useForProxyRules = true;
    settings.torBrowser.useForProxyRules = true;
    settings.warp.useForProxyRules = true;
    settings.ownProxies.push({enabled: true}, {enabled: false});
    Assert.strictEqual(SiteControl.proxyCandidateCount(settings), 5);

  });

  it('returns an uncontrollable tab without returning a URL', async function() {

    const settingsController = createSettingsController();
    const controller = SiteControl.createController({settingsController});
    const result = await controller.get('about:preferences');

    Assert.deepStrictEqual(result.target, {
      controllable: false,
      host: '',
      reasonCode: 'UNSUPPORTED_PAGE',
    });
    Assert.strictEqual(result.route, null);
    Assert.strictEqual(result.patterns, null);
    Assert.strictEqual(JSON.stringify(result).includes('about:'), false);

  });

  it('persists an exact-host route through the settings controller',
      async function() {

        const settings = Settings.createDefaultSettings();
        settings.localTor.useForProxyRules = true;
        const settingsController = createSettingsController({
          revision: 4,
          settings,
        });
        const controller = SiteControl.createController({settingsController});
        const result = await controller.replace({
          tabUrl: 'https://sub.example.com/path?not-returned=1',
          expectedRevision: 4,
          mode: 'PROXY',
          scope: 'HOST',
        });

        Assert.strictEqual(result.revision, 5);
        Assert.deepStrictEqual(result.route, {
          mode: 'PROXY', scope: 'HOST', pattern: 'sub.example.com',
        });
        Assert.deepStrictEqual(
            settingsController.calls.at(-1).next.rules.proxy,
            ['sub.example.com'],
        );

      });

  it('rejects Proxy mode before persistence when no candidate exists',
      async function() {

        const settingsController = createSettingsController();
        const controller = SiteControl.createController({settingsController});
        await Assert.rejects(
            controller.replace({
              tabUrl: 'https://example.com/',
              expectedRevision: 0,
              mode: 'PROXY',
              scope: 'HOST',
            }),
            (error) => error.code ===
              SiteControl.ERRORS.SITE_PROXY_CANDIDATE_UNAVAILABLE,
        );
        Assert.strictEqual(
            settingsController.calls.some((call) => call.kind === 'replace'),
            false,
        );

      });

  it('rejects stale revisions and malformed site mutations', async function() {

    const settingsController = createSettingsController({revision: 2});
    const controller = SiteControl.createController({settingsController});
    await Assert.rejects(
        controller.replace({
          tabUrl: 'https://example.com/',
          expectedRevision: 1,
          mode: 'DIRECT',
          scope: 'HOST',
        }),
        (error) => error.code === 'SETTINGS_REVISION_CONFLICT',
    );
    await Assert.rejects(
        controller.replace({
          tabUrl: 'https://example.com/',
          expectedRevision: 2,
          mode: 'DIRECT',
          scope: 'EVERYWHERE',
        }),
        (error) => error.code === SiteControl.ERRORS.SITE_REQUEST_MALFORMED,
    );

  });

  it('serializes concurrent site writes so one stale revision fails',
      async function() {

        const settingsController = createSettingsController();
        const controller = SiteControl.createController({settingsController});
        const request = {
          tabUrl: 'https://example.com/',
          expectedRevision: 0,
          mode: 'DIRECT',
          scope: 'HOST',
        };
        const results = await Promise.allSettled([
          controller.replace(request), controller.replace(request),
        ]);

        Assert.strictEqual(results[0].status, 'fulfilled');
        Assert.strictEqual(results[1].status, 'rejected');
        Assert.strictEqual(results[1].reason.code,
            'SETTINGS_REVISION_CONFLICT');

      });

});
