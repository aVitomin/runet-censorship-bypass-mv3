'use strict';

/* eslint-env node */

const Crypto = require('crypto');
const Path = require('path');

const BACKGROUND_DIRECTORY = Path.resolve(__dirname, '..', 'background');
const BACKGROUND_FILES = Object.freeze([
  'pac-artifacts.js',
  'pac-mods.js',
  'site-scope.js',
  'proxy-health.js',
  'pac-providers.js',
  'state.js',
  'action-status.js',
  'legacy-migration-audit.js',
  'legacy-migration-apply.js',
  'periodic-update.js',
  'hash.js',
  'pac-download.js',
  'pac-cook.js',
  'proxy-auth.js',
  'proxy-settings.js',
]);
const BACKGROUND_EXPORTS = Object.freeze([
  'mv3PacArtifacts',
  'mv3PacMods',
  'mv3SiteScope',
  'mv3ProxyHealth',
  'mv3Providers',
  'mv3State',
  'mv3ActionStatus',
  'mv3LegacyMigrationAudit',
  'mv3LegacyMigrationApply',
  'mv3PeriodicUpdate',
  'mv3Hash',
  'mv3PacDownload',
  'mv3PacCook',
  'mv3ProxyAuth',
  'mv3ProxySettings',
]);

function loadBackgroundModules() {

  BACKGROUND_EXPORTS.forEach((name) => delete global[name]);
  global.self = global;
  global.tldts = require('tldts');
  if (!global.crypto) {
    global.crypto = Crypto.webcrypto;
  }
  BACKGROUND_FILES.forEach((file) => {
    const filename = Path.join(BACKGROUND_DIRECTORY, file);
    delete require.cache[require.resolve(filename)];
    require(filename);
  });
  return global;

}

module.exports = {
  BACKGROUND_DIRECTORY,
  loadBackgroundModules,
};
