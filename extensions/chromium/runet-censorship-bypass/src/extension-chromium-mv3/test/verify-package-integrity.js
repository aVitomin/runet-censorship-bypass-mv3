'use strict';

/* eslint-env node, mocha */

const Assert = require('assert');
const Fs = require('fs');
const Path = require('path');

const PACKAGED_MV3_ROOT = Path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'build',
    'extension-chromium-mv3',
);

const ALLOWED_RUNTIME_DIRECTORIES = new Set([
  'background/vendor/tldts/dist',
]);

const FORBIDDEN_DIRECTORIES = new Set([
  '.git',
  '.github',
  '.idea',
  '.tmp',
  '.vscode',
  '__tests__',
  'browser-profile',
  'browser-profiles',
  'build',
  'coverage',
  'dist',
  'fixture',
  'fixtures',
  'log',
  'logs',
  'netlog',
  'netlogs',
  'node_modules',
  'profile',
  'profiles',
  'temp',
  'test',
  'tests',
  'tmp',
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.bak',
  '.crx',
  '.key',
  '.log',
  '.map',
  '.markdown',
  '.md',
  '.orig',
  '.p12',
  '.pem',
  '.pfx',
  '.rej',
  '.swo',
  '.swp',
  '.temp',
  '.tmp',
  '.xpi',
  '.zip',
]);

const FORBIDDEN_FILES = new Set([
  '.ds_store',
  '.editorconfig',
  '.env',
  '.gitattributes',
  '.gitignore',
  'desktop.ini',
  'thumbs.db',
]);

function isLicenseFile(fileName) {

  return /^(?:copying|licen[cs]e|notice)(?:[._-].*)?$/i.test(fileName);

}

function getForbiddenDirectoryReason(relativePath) {

  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  if (ALLOWED_RUNTIME_DIRECTORIES.has(normalized)) {
    return null;
  }
  const directoryName = normalized.split('/').filter(Boolean).pop() || '';
  if (FORBIDDEN_DIRECTORIES.has(directoryName)) {
    return `repository-only directory: ${directoryName}`;
  }
  return null;

}

function getForbiddenReason(relativePath) {

  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const fileName = parts[parts.length - 1] || '';
  const lowerFileName = fileName.toLowerCase();

  for (let index = 0; index < parts.length - 1; index += 1) {
    const directoryPath = parts.slice(0, index + 1).join('/');
    const reason = getForbiddenDirectoryReason(directoryPath);
    if (reason) {
      return reason;
    }
  }

  if (isLicenseFile(fileName)) {
    return null;
  }
  if (FORBIDDEN_FILES.has(lowerFileName) || lowerFileName.startsWith('.git')) {
    return `repository or editor metadata: ${fileName}`;
  }
  if (/^net-?log(?:\.|-|_|$)/i.test(fileName)) {
    return `network log: ${fileName}`;
  }
  if (fileName.endsWith('~')) {
    return `temporary editor file: ${fileName}`;
  }

  const extension = Path.extname(lowerFileName);
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    return `repository-only file type: ${extension}`;
  }
  return null;

}

function listPackageEntries(root) {

  const entries = [];

  function visit(directory, relativeDirectory = '') {

    const children = Fs.readdirSync(directory, {withFileTypes: true})
        .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relativePath = relativeDirectory ?
        `${relativeDirectory}/${child.name}` : child.name;
      const absolutePath = Path.join(directory, child.name);
      if (child.isSymbolicLink()) {
        entries.push({path: relativePath, reason: 'symbolic link'});
      } else if (child.isDirectory()) {
        const reason = getForbiddenDirectoryReason(relativePath);
        if (reason) {
          entries.push({path: relativePath, reason});
        } else {
          visit(absolutePath, relativePath);
        }
      } else if (child.isFile()) {
        entries.push({path: relativePath, reason: getForbiddenReason(relativePath)});
      } else {
        entries.push({path: relativePath, reason: 'unsupported filesystem entry'});
      }
    }

  }

  visit(root);
  return entries;

}

function verifyPackageIntegrity(root) {

  Assert.ok(Fs.existsSync(root), `Missing MV3 package directory: ${root}`);
  Assert.ok(Fs.statSync(root).isDirectory(), `Not a directory: ${root}`);
  const entries = listPackageEntries(root);
  const forbidden = entries.filter(({reason}) => reason);
  if (forbidden.length > 0) {
    const details = forbidden
        .map(({path, reason}) => `- ${path} (${reason})`)
        .join('\n');
    throw new Error(`Forbidden MV3 package entries:\n${details}`);
  }
  return entries.length;

}

if (typeof describe === 'function') {
  describe('MV3 package integrity', function() {

    it('rejects repository-only QA and audit documents', function() {

      const paths = [
        'ACTION_STATUS_BROWSER_QA.md',
        'PAC_FAILURE_BROWSER_QA.md',
        'PERFORMANCE_AUDIT.md',
        'docs/architecture-audit.markdown',
      ];
      for (const relativePath of paths) {
        Assert.ok(getForbiddenReason(relativePath), relativePath);
      }

    });

    it('rejects tests, logs, profiles, source maps, and metadata', function() {

      const paths = [
        'test/pac-fixture.js',
        'fixtures/provider.pac',
        'logs/browser.log',
        'browser-profile/Default/Preferences',
        'pages/popup/index.js.map',
        'pages/dist/runtime.js',
        '.git/config',
        '.vscode/settings.json',
        'NetLog.json',
        'temporary.tmp',
      ];
      for (const relativePath of paths) {
        Assert.ok(getForbiddenReason(relativePath), relativePath);
      }

    });

    it('allows the required tldts runtime distribution', function() {

      Assert.strictEqual(
          getForbiddenReason('background/vendor/tldts/dist/index.umd.min.js'),
          null,
      );

    });

    it('allows required license files', function() {

      Assert.strictEqual(getForbiddenReason('vendor/LICENSE'), null);
      Assert.strictEqual(getForbiddenReason('vendor/LICENSE.md'), null);
      Assert.strictEqual(getForbiddenReason('NOTICE.txt'), null);

    });

  });
}

if (require.main === module) {
  const fileCount = verifyPackageIntegrity(PACKAGED_MV3_ROOT);
  console.log(`Verified MV3 package integrity: ${fileCount} files.`);
}

module.exports = {
  getForbiddenDirectoryReason,
  getForbiddenReason,
  listPackageEntries,
  PACKAGED_MV3_ROOT,
  verifyPackageIntegrity,
};
