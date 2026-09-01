'use strict';

const Assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');

const EXPECTED_FILES = Object.freeze([
  'background/event-page.js',
  'background/off-state.js',
  'manifest.json',
]);
const FORBIDDEN_RUNTIME_TEXT = Object.freeze([
  'browser.proxy',
  'proxy.settings',
  'webRequest',
  'XMLHttpRequest',
  'fetch(',
  'BEGIN PRIVATE KEY',
  'extension-chromium-mv3',
  'provider-dataset',
]);

function listFiles(root) {

  const files = [];
  function visit(relativeDirectory) {

    const absoluteDirectory = Path.join(root, relativeDirectory);
    for (const entry of Fs.readdirSync(absoluteDirectory, {withFileTypes: true})) {
      const relativePath = Path.join(relativeDirectory, entry.name);
      Assert.strictEqual(entry.isSymbolicLink(), false, `Symlink: ${relativePath}`);
      if (entry.isDirectory()) {
        visit(relativePath);
      } else {
        Assert.strictEqual(entry.isFile(), true, `Non-file: ${relativePath}`);
        files.push(relativePath.split(Path.sep).join('/'));
      }
    }

  }
  visit('');
  return files.sort();

}

function verifyPackage(packageRoot, sourceRoot) {

  Assert.strictEqual(Fs.statSync(packageRoot).isDirectory(), true);
  const files = listFiles(packageRoot);
  Assert.deepStrictEqual(files, EXPECTED_FILES);

  for (const relativePath of files) {
    const packaged = Fs.readFileSync(Path.join(packageRoot, relativePath));
    const source = Fs.readFileSync(Path.join(sourceRoot, relativePath));
    Assert.deepStrictEqual(packaged, source, `Changed package bytes: ${relativePath}`);
  }

  const manifest = JSON.parse(Fs.readFileSync(
      Path.join(packageRoot, 'manifest.json'),
      'utf8',
  ));
  Assert.strictEqual(manifest.manifest_version, 3);
  Assert.deepStrictEqual(manifest.permissions, ['storage']);
  Assert.strictEqual(manifest.background.persistent, false);
  Assert.deepStrictEqual(manifest.background.scripts, [
    'background/off-state.js',
    'background/event-page.js',
  ]);
  Assert.strictEqual('service_worker' in manifest.background, false);
  Assert.strictEqual('host_permissions' in manifest, false);

  const runtimeText = EXPECTED_FILES
      .filter((file) => file.endsWith('.js'))
      .map((file) => Fs.readFileSync(Path.join(packageRoot, file), 'utf8'))
      .join('\n');
  for (const forbidden of FORBIDDEN_RUNTIME_TEXT) {
    Assert.strictEqual(runtimeText.includes(forbidden), false, forbidden);
  }

  return Object.freeze({files});

}

if (require.main === module) {
  const projectRoot = Path.resolve(__dirname, '..', '..', '..');
  const result = verifyPackage(
      Path.join(projectRoot, 'build', 'extension-firefox-mv3'),
      Path.join(projectRoot, 'src', 'extension-firefox-mv3'),
  );
  console.log(`Verified inert Firefox MV3 package: ${result.files.length} files.`);
}

module.exports = Object.freeze({EXPECTED_FILES, listFiles, verifyPackage});
