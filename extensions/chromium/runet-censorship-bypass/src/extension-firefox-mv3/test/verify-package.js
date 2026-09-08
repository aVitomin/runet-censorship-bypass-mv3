'use strict';

const Assert = require('node:assert');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');
const ProductionProvider = require('../background/production-provider');

const EXPECTED_FILES = Object.freeze([
  '_locales/en/messages.json',
  '_locales/ru/messages.json',
  'background/activation-controller.js',
  'background/common/provider-dataset-state.js',
  'background/common/provider-dataset.js',
  'background/common/routing-contract.js',
  'background/dataset-runtime.js',
  'background/dataset-store.js',
  'background/event-page.js',
  'background/off-state.js',
  'background/product-config.js',
  'background/production-provider.js',
  'background/provider-lookup.js',
  'background/provider-updater.js',
  'background/proxy-auth.js',
  'background/proxy-control.js',
  'background/routing-adapter.js',
  'background/settings-control.js',
  'manifest.json',
  'pages/options/index.html',
  'pages/options/index.js',
  'pages/options/options.css',
  'pages/popup/index.html',
  'pages/popup/index.js',
  'pages/popup/popup.css',
  'pages/shared/ui-runtime.js',
  'pages/shared/ui-tokens.css',
  'provider/anticensority-hosts-v1.envelope.json',
  'provider/anticensority-hosts-v1.json',
]);
const FORBIDDEN_RUNTIME_TEXT = Object.freeze([
  'XMLHttpRequest',
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
  Assert.strictEqual(manifest.default_locale, 'en');
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
    'background/provider-updater.js',
    'background/provider-lookup.js',
    'background/dataset-runtime.js',
    'background/routing-adapter.js',
    'background/proxy-auth.js',
    'background/product-config.js',
    'background/production-provider.js',
    'background/settings-control.js',
    'background/activation-controller.js',
    'background/event-page.js',
  ]);
  Assert.strictEqual('service_worker' in manifest.background, false);
  Assert.deepStrictEqual(manifest.host_permissions, ['<all_urls>']);
  Assert.deepStrictEqual(manifest.action, {
    default_title: '__MSG_popupTitle__',
    default_popup: 'pages/popup/index.html',
  });
  Assert.deepStrictEqual(manifest.options_ui, {
    page: 'pages/options/index.html',
    open_in_tab: true,
  });
  Assert.deepStrictEqual(manifest.content_security_policy, {
    extension_pages:
      'default-src \'self\'; script-src \'self\'; object-src \'none\'',
  });

  const runtimeText = EXPECTED_FILES
      .filter((file) => file.endsWith('.js'))
      .map((file) => Fs.readFileSync(Path.join(packageRoot, file), 'utf8'))
      .join('\n');
  for (const forbidden of FORBIDDEN_RUNTIME_TEXT) {
    Assert.strictEqual(runtimeText.includes(forbidden), false, forbidden);
  }
  for (const page of [
    'pages/shared/ui-runtime.js',
    'pages/popup/index.js',
    'pages/options/index.js',
  ]) {
    const source = Fs.readFileSync(Path.join(packageRoot, page), 'utf8');
    Assert.strictEqual(source.includes('innerHTML'), false, page);
    Assert.strictEqual(source.includes('http://'), false, page);
    Assert.strictEqual(source.includes('https://'), false, page);
    Assert.strictEqual(source.includes('console.'), false, page);
  }
  const eventPageText = Fs.readFileSync(
      Path.join(packageRoot, 'background', 'event-page.js'),
      'utf8',
  );
  Assert.strictEqual(eventPageText.includes('proxy.settings.set'), false);
  Assert.strictEqual(eventPageText.includes('acquireRandomFloor('), false);
  Assert.strictEqual(eventPageText.includes('activatePrepared('), true);
  Assert.strictEqual(eventPageText.includes('fetchAndStage'), false);
  Assert.strictEqual(eventPageText.includes('promoteStaged'), false);
  Assert.strictEqual(
      eventPageText.includes('type === \'firefox.activation.apply\''),
      true,
  );
  Assert.strictEqual(
      eventPageText.includes('createActivationFactory('),
      true,
  );
  Assert.strictEqual(
      eventPageText.includes('root.fetch(packagedUrl'),
      true,
  );
  Assert.strictEqual(eventPageText.includes('http://'), false);
  Assert.strictEqual(eventPageText.includes('https://'), false);

  const artifact = Fs.readFileSync(Path.join(
      packageRoot,
      ProductionProvider.ARTIFACT_PATH,
  ));
  const envelope = JSON.parse(Fs.readFileSync(Path.join(
      packageRoot,
      ProductionProvider.ENVELOPE_PATH,
  ), 'utf8'));
  Assert.strictEqual(
      Crypto.createHash('sha256').update(artifact).digest('hex'),
      ProductionProvider.ARTIFACT_SHA256,
  );
  Assert.strictEqual(artifact.byteLength,
      ProductionProvider.ARTIFACT_BYTE_COUNT);
  Assert.strictEqual(envelope.ruleCount, ProductionProvider.RULE_COUNT);
  Assert.strictEqual(envelope.artifactSha256,
      ProductionProvider.ARTIFACT_SHA256);
  const payload = JSON.parse(artifact);
  Assert.strictEqual(payload.format, 'HOST_BUCKETS_V1');
  Assert.strictEqual(payload.buckets.length, 80);
  Assert.strictEqual(JSON.stringify(payload).includes('FindProxyForURL'), false);

  return Object.freeze({files});

}

if (require.main === module) {
  const projectRoot = Path.resolve(__dirname, '..', '..', '..');
  const result = verifyPackage(
      Path.join(projectRoot, 'build', 'extension-firefox-mv3'),
      Path.join(projectRoot, 'src', 'extension-firefox-mv3'),
  );
  console.log(
      `Verified OFF-default Firefox MV3 control package: ${result.files.length} files.`,
  );
}

module.exports = Object.freeze({EXPECTED_FILES, listFiles, verifyPackage});
