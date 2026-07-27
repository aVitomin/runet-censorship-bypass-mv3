'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Fs = require('fs');
const Mocha = require('mocha');
const Path = require('path');
const {loadBackgroundModules} = require('./background-modules');

const MV3_DIRECTORY = Path.resolve(__dirname, '..');
const CATALOGS = Object.freeze(['en', 'ru'].reduce((catalogs, language) => {
  catalogs[language] = JSON.parse(Fs.readFileSync(
      Path.join(MV3_DIRECTORY, '_locales', language, 'messages.json'),
      'utf8',
  ));
  return catalogs;
}, {}));
const ACTION_TITLE_KEYS = Object.freeze([
  'actionTitleLoading',
  'actionTitleExternal',
  'actionTitleApplying',
  'actionTitleClearing',
  'actionTitleRefreshing',
  'actionTitleChecking',
  'actionTitleOff',
  'actionTitleStale',
  'actionTitleError',
  'actionTitleControlError',
  'actionTitleHealthWarning',
  'actionTitleActiveAuto',
  'actionTitleActiveProxy',
  'actionTitleActiveDirect',
  'actionTitleActiveUnavailable',
]);

function createActiveStatus(patch = {}) {

  return Object.assign({
    controllable: true,
    mode: 'auto',
    proxyApplied: true,
    proxyApplyStatus: 'applied',
    pacDownloadStatus: 'success',
    pacCookStatus: 'success',
    pacStale: false,
    proxyControl: {
      checkedAt: 1,
      levelOfControl: 'controlled_by_this_extension',
      canControl: true,
      controlledByThisExtension: true,
      controlsPac: true,
    },
    proxyHealth: {status: 'unknown'},
    autoUpdate: {status: 'scheduled'},
  }, patch);

}

function createOffStatus(patch = {}) {

  return createActiveStatus(Object.assign({
    proxyApplied: false,
    proxyApplyStatus: 'cleared',
    proxyControl: {
      checkedAt: 1,
      levelOfControl: 'controllable_by_this_extension',
      canControl: true,
      controlledByThisExtension: false,
      controlsPac: false,
    },
  }, patch));

}

function createExternalStatus(patch = {}) {

  return createOffStatus(Object.assign({
    proxyControl: {
      checkedAt: 1,
      levelOfControl: 'controlled_by_other_extensions',
      canControl: false,
      controlledByThisExtension: false,
      controlsPac: false,
    },
  }, patch));

}

function applyPriorityState(status, name) {

  const next = Object.assign({}, status);
  if (name === 'external') {
    next.proxyControl = createExternalStatus().proxyControl;
  } else if (name === 'busy') {
    next.operation = 'clear';
  } else if (name === 'controlError') {
    next.proxyControl = {
      checkedAt: 1,
      levelOfControl: null,
      canControl: false,
      controlledByThisExtension: false,
      controlsPac: false,
      error: {code: 'PROXY_READ_FAILED'},
    };
  } else if (name === 'loading') {
    next.loading = true;
  } else if (name === 'off') {
    Object.assign(next, createOffStatus());
  } else if (name === 'error') {
    next.error = 'failed';
  } else if (name === 'stale') {
    next.pacStale = true;
  } else if (name === 'healthWarning') {
    next.proxyHealth = {status: 'error'};
  } else if (name === 'unsupported') {
    next.controllable = false;
  } else if (name === 'direct') {
    next.mode = 'direct';
  }
  return next;

}

function relativeLuminance(hex) {

  const values = hex.match(/[0-9a-f]{2}/ig).map((value) =>
    Number.parseInt(value, 16) / 255,
  );
  return values.reduce((luminance, value, index) => {
    const channel = value <= 0.04045 ?
      value / 12.92 :
      ((value + 0.055) / 1.055) ** 2.4;
    return luminance + channel * [0.2126, 0.7152, 0.0722][index];
  }, 0);

}

function contrastRatio(first, second) {

  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    Math.max(firstLuminance, secondLuminance) + 0.05
  ) / (
    Math.min(firstLuminance, secondLuminance) + 0.05
  );

}

Mocha.describe('MV3 action presentation model', function() {

  let previousChrome;

  Mocha.beforeEach(function() {

    previousChrome = global.chrome;
    delete global.chrome;
    loadBackgroundModules();

  });

  Mocha.afterEach(function() {

    if (previousChrome === undefined) {
      delete global.chrome;
    } else {
      global.chrome = previousChrome;
    }

  });

  Mocha.it('derives the complete icon, badge, and title matrix', function() {

    const cases = [
      [{loading: true}, 'loading', 'loading', '…', 'loading'],
      [createOffStatus(), 'off', 'off', 'OFF', 'off'],
      [createExternalStatus(), 'external', 'external', 'EXT', 'external'],
      [createActiveStatus(), 'auto', 'active', 'A', 'auto'],
      [createActiveStatus({mode: 'proxy'}), 'proxy', 'active', 'P', 'proxy'],
      [createActiveStatus({mode: 'direct'}), 'direct', 'active', 'D', 'direct'],
      [
        createActiveStatus({controllable: false}),
        'unsupported',
        'active',
        '',
        'auto',
      ],
      [
        createActiveStatus({operation: 'apply'}),
        'busy',
        'busy',
        '…',
        'busy',
      ],
      [
        createActiveStatus({operation: 'clear'}),
        'busy',
        'busy',
        '…',
        'busy',
      ],
      [
        createActiveStatus({operation: 'refresh'}),
        'busy',
        'busy',
        '…',
        'busy',
      ],
      [
        createActiveStatus({operation: 'check'}),
        'busy',
        'busy',
        '…',
        'busy',
      ],
      [
        createActiveStatus({proxyApplyStatus: 'error'}),
        'error',
        'warning',
        '!',
        'warning',
      ],
      [
        createActiveStatus({pacStale: true}),
        'stale',
        'warning',
        '!',
        'warning',
      ],
      [
        createActiveStatus({proxyHealth: {status: 'error'}}),
        'healthWarning',
        'warning',
        '!',
        'warning',
      ],
      [
        createOffStatus({
          proxyControl: {
            checkedAt: 1,
            levelOfControl: null,
            canControl: false,
            controlledByThisExtension: false,
            controlsPac: false,
            error: {code: 'PROXY_READ_FAILED'},
          },
        }),
        'controlError',
        'warning',
        '!',
        'warning',
      ],
      [
        {lifecycle: 'reconstructing'},
        'loading',
        'loading',
        '…',
        'loading',
      ],
    ];
    for (const [status, kind, iconState, badgeText, badgeTone] of cases) {
      const view = global.mv3ActionStatus.deriveActionViewModel(status);
      Chai.expect(view, kind).to.include({
        kind,
        iconState,
        badgeText,
        badgeTone,
      });
      Chai.expect(view.title, kind).to.be.a('string').and.not.equal('');
      Chai.expect(view.fingerprint, kind).to.be.a('string').and.not.equal('');
    }

  });

  Mocha.it('applies the explicit state-priority ordering', function() {

    const external = global.mv3ActionStatus.deriveActionViewModel(
        createExternalStatus({
          operation: 'apply',
          pacStale: true,
          error: 'failed',
          proxyHealth: {status: 'error'},
        }),
    );
    Chai.expect(external.kind).to.equal('external');

    const busy = global.mv3ActionStatus.deriveActionViewModel(
        createOffStatus({
          operation: 'clear',
          pacStale: true,
          error: 'failed',
        }),
    );
    Chai.expect(busy.kind).to.equal('busy');

    const off = global.mv3ActionStatus.deriveActionViewModel(
        createOffStatus({
          pacStale: true,
          error: 'failed',
          proxyHealth: {status: 'error'},
        }),
    );
    Chai.expect(off.kind).to.equal('off');

    const error = global.mv3ActionStatus.deriveActionViewModel(
        createActiveStatus({
          error: 'failed',
          pacStale: true,
          proxyHealth: {status: 'error'},
        }),
    );
    Chai.expect(error.kind).to.equal('error');

    const stale = global.mv3ActionStatus.deriveActionViewModel(
        createActiveStatus({
          pacStale: true,
          proxyHealth: {status: 'error'},
        }),
    );
    Chai.expect(stale.kind).to.equal('stale');

  });

  Mocha.it('directly verifies every pair in the state-priority ordering',
      function() {

        const priorities = [
          'external',
          'busy',
          'controlError',
          'loading',
          'off',
          'error',
          'stale',
          'healthWarning',
          'unsupported',
          'direct',
        ];
        for (let high = 0; high < priorities.length; high += 1) {
          for (let low = high + 1; low < priorities.length; low += 1) {
            const status = applyPriorityState(
                applyPriorityState(createActiveStatus(), priorities[low]),
                priorities[high],
            );
            Chai.expect(
                global.mv3ActionStatus.deriveActionViewModel(status).kind,
                `${priorities[high]} must outrank ${priorities[low]}`,
            ).to.equal(priorities[high]);
          }
        }

      });

  Mocha.it('shows route badges only for a live extension-controlled PAC',
      function() {

        for (const mode of ['auto', 'proxy', 'direct']) {
          Chai.expect(global.mv3ActionStatus.deriveActionViewModel(
              createOffStatus({mode}),
          ).badgeText).to.equal('OFF');
          Chai.expect(global.mv3ActionStatus.deriveActionViewModel(
              createExternalStatus({mode}),
          ).badgeText).to.equal('EXT');
        }
        Chai.expect(global.mv3ActionStatus.deriveActionViewModel(
            createActiveStatus({mode: 'direct', controllable: false}),
        ).badgeText).to.equal('');
        Chai.expect(global.mv3ActionStatus.deriveActionViewModel(
            createActiveStatus({
              proxyApplied: false,
              proxyControl: Object.assign(
                  {},
                  createActiveStatus().proxyControl,
                  {controlsPac: true},
              ),
            }),
        ).badgeText).to.equal('A');
        Chai.expect(global.mv3ActionStatus.deriveActionViewModel(
            createActiveStatus({
              proxyControl: Object.assign(
                  {},
                  createExternalStatus().proxyControl,
                  {
                    controlledByThisExtension: true,
                    controlsPac: true,
                  },
              ),
            }),
        ).badgeText).to.equal('A');

      });

  Mocha.it('uses stable secret-free fingerprints and titles', function() {

    const secret = [
      'host.example',
      'user-name',
      'p@ssword',
      'https://provider.example/path?token=value#fragment',
      'artifact-identifier',
      'workflow-generation-93',
    ].join('|');
    const status = createActiveStatus({
      host: secret,
      selectedProvider: secret,
      selectedProviderLabel: secret,
      error: secret,
      proxyHealth: {
        status: 'error',
        candidateEndpoint: secret,
        lastErrorMessage: secret,
      },
    });
    const first = global.mv3ActionStatus.deriveActionViewModel(status);
    const second = global.mv3ActionStatus.deriveActionViewModel(
        JSON.parse(JSON.stringify(status)),
    );
    Chai.expect(first.fingerprint).to.equal(second.fingerprint);
    Chai.expect(`${first.title}|${first.badgeText}|${first.fingerprint}`)
        .to.not.include(secret);
    Chai.expect(first.badgeText.length).to.be.at.most(4);

  });

  Mocha.it('keeps every badge palette entry readable with white text',
      function() {

        const statuses = [
          createActiveStatus(),
          createActiveStatus({mode: 'proxy'}),
          createActiveStatus({mode: 'direct'}),
          createOffStatus(),
          createExternalStatus(),
          createActiveStatus({operation: 'apply'}),
          createActiveStatus({pacStale: true}),
        ];
        for (const status of statuses) {
          const view = global.mv3ActionStatus.deriveActionViewModel(status);
          Chai.expect(
              contrastRatio(view.badgeTextColor, view.badgeColor),
              `${view.badgeTone} contrast`,
          ).to.be.at.least(4.5);
        }

      });

  Mocha.it('keeps English and Russian action titles complete and natural',
      function() {

        for (const key of ACTION_TITLE_KEYS) {
          Chai.expect(CATALOGS.en[key], `English ${key}`).to.be.an('object');
          Chai.expect(CATALOGS.ru[key], `Russian ${key}`).to.be.an('object');
          Chai.expect(
              Object.keys(CATALOGS.en[key].placeholders || {}).sort(),
              `${key} placeholders`,
          ).to.deep.equal(
              Object.keys(CATALOGS.ru[key].placeholders || {}).sort(),
          );
          Chai.expect(CATALOGS.ru[key].message).to.not.match(
              /\b(?:Extension proxy|Current site|Open the extension)\b/,
          );
          Chai.expect(CATALOGS.en[key].message.length).to.be.at.most(140);
          Chai.expect(CATALOGS.ru[key].message.length).to.be.at.most(150);
        }
        for (const oldKey of [
          'actionTitleSite',
          'actionTitleMode',
          'actionTitleProxy',
          'actionTitleSystem',
        ]) {
          Chai.expect(CATALOGS.en[oldKey]).to.equal(undefined);
          Chai.expect(CATALOGS.ru[oldKey]).to.equal(undefined);
        }

      });

  Mocha.it('uses each selected locale for every meaningful title state',
      function() {

        const states = [
          [{loading: true}, 'actionTitleLoading'],
          [createExternalStatus(), 'actionTitleExternal'],
          [createActiveStatus({operation: 'apply'}), 'actionTitleApplying'],
          [createActiveStatus({operation: 'clear'}), 'actionTitleClearing'],
          [createActiveStatus({operation: 'refresh'}), 'actionTitleRefreshing'],
          [createActiveStatus({operation: 'check'}), 'actionTitleChecking'],
          [createOffStatus(), 'actionTitleOff'],
          [createActiveStatus({pacStale: true}), 'actionTitleStale'],
          [createActiveStatus({error: 'failed'}), 'actionTitleError'],
          [
            createOffStatus({
              proxyControl: {
                checkedAt: 1,
                levelOfControl: null,
                canControl: false,
                controlledByThisExtension: false,
                controlsPac: false,
                error: {code: 'PROXY_READ_FAILED'},
              },
            }),
            'actionTitleControlError',
          ],
          [
            createActiveStatus({proxyHealth: {status: 'error'}}),
            'actionTitleHealthWarning',
          ],
          [createActiveStatus(), 'actionTitleActiveAuto'],
          [createActiveStatus({mode: 'proxy'}), 'actionTitleActiveProxy'],
          [createActiveStatus({mode: 'direct'}), 'actionTitleActiveDirect'],
          [
            createActiveStatus({controllable: false}),
            'actionTitleActiveUnavailable',
          ],
        ];
        for (const language of ['en', 'ru']) {
          global.chrome = {
            i18n: {
              getMessage(key) {

                return CATALOGS[language][key] &&
                  CATALOGS[language][key].message || '';

              },
            },
          };
          for (const [status, key] of states) {
            Chai.expect(
                global.mv3ActionStatus.formatTitle(status),
                `${language} ${key}`,
            ).to.equal(CATALOGS[language][key].message);
          }
        }

      });

});
