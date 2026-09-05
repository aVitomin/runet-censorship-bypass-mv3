'use strict';

const Assert = require('node:assert');
const Fs = require('node:fs');
const Path = require('node:path');

const EXPECTED_FILES = Object.freeze([
  'background/common/provider-dataset-state.js',
  'background/common/provider-dataset.js',
  'background/common/routing-contract.js',
  'background/dataset-runtime.js',
  'background/dataset-store.js',
  'background/event-page.js',
  'background/off-state.js',
  'background/provider-lookup.js',
  'background/proxy-auth.js',
  'background/proxy-control.js',
  'background/routing-adapter.js',
  'manifest.json',
]);
const FORBIDDEN_RUNTIME_TEXT = Object.freeze([
  'XMLHttpRequest',
  'fetch(',
  'BEGIN PRIVATE KEY',
  'extension-chromium-mv3',
  'BEGIN PAC',
  'FindProxyForURL',
  'eval(',
  'Function(',
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
    const sourcePath = relativePath.startsWith('background/common/') ?
      Path.resolve(
          sourceRoot,
          '..',
          'extension-mv3-common',
          Path.basename(relativePath),
      ) :
      Path.join(sourceRoot, relativePath);
    const source = Fs.readFileSync(sourcePath);
    Assert.deepStrictEqual(packaged, source, `Changed package bytes: ${relativePath}`);
  }

  const manifest = JSON.parse(Fs.readFileSync(
      Path.join(packageRoot, 'manifest.json'),
      'utf8',
  ));
  Assert.strictEqual(manifest.manifest_version, 3);
  Assert.deepStrictEqual(manifest.permissions, [
    'storage',
    'proxy',
    'webRequest',
    'webRequestBlocking',
  ]);
  Assert.strictEqual(manifest.background.persistent, false);
  Assert.deepStrictEqual(manifest.background.scripts, [
    'background/common/routing-contract.js',
    'background/common/provider-dataset.js',
    'background/common/provider-dataset-state.js',
    'background/off-state.js',
    'background/proxy-control.js',
    'background/dataset-store.js',
    'background/provider-lookup.js',
    'background/dataset-runtime.js',
    'background/routing-adapter.js',
    'background/proxy-auth.js',
    'background/event-page.js',
  ]);
  Assert.strictEqual('service_worker' in manifest.background, false);
  Assert.deepStrictEqual(manifest.host_permissions, ['<all_urls>']);

  const runtimeText = EXPECTED_FILES
      .filter((file) => file.endsWith('.js'))
      .map((file) => Fs.readFileSync(Path.join(packageRoot, file), 'utf8'))
      .join('\n');
  for (const forbidden of FORBIDDEN_RUNTIME_TEXT) {
    Assert.strictEqual(runtimeText.includes(forbidden), false, forbidden);
  }
  const eventPageText = Fs.readFileSync(
      Path.join(packageRoot, 'background', 'event-page.js'),
      'utf8',
  );
  Assert.strictEqual(eventPageText.includes('proxy.settings.set'), false);
  Assert.strictEqual(eventPageText.includes('acquirePrevalidatedFloor('), false);
  Assert.strictEqual(
      eventPageText.includes('type === \'firefox.activation.apply\''),
      true,
  );
  Assert.strictEqual(
      eventPageText.includes('errorResponse(\'ACTIVATION_NOT_IMPLEMENTED\')'),
      true,
  );

  return Object.freeze({files});

}

if (require.main === module) {
  const projectRoot = Path.resolve(__dirname, '..', '..', '..');
  const result = verifyPackage(
      Path.join(projectRoot, 'build', 'extension-firefox-mv3'),
      Path.join(projectRoot, 'src', 'extension-firefox-mv3'),
  );
  console.log(
      `Verified OFF-only Firefox MV3 control package: ${result.files.length} files.`,
  );
}

module.exports = Object.freeze({EXPECTED_FILES, listFiles, verifyPackage});
