'use strict';

/* eslint-env node */

const Assert = require('assert');
const Fs = require('fs');
const Path = require('path');
const {loadBackgroundModules} = require('./background-modules');

const MV3_SOURCE_ROOT = Path.resolve(__dirname, '..');
const PACKAGED_MV3_ROOT = Path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'build',
    'extension-chromium-mv3',
);

function getRuntimeIconData() {

  loadBackgroundModules();
  const actionStatus = global.mv3ActionStatus;
  const active = {
    controllable: true,
    mode: 'auto',
    proxyApplied: true,
    proxyControl: {
      controlsPac: true,
      controlledByThisExtension: true,
      levelOfControl: 'controlled_by_this_extension',
    },
  };
  return {
    paths: actionStatus.getRuntimeIconPaths(),
    variants: {
      active: actionStatus.getIconPath(active),
      off: actionStatus.getIconPath({
        proxyApplied: false,
        proxyControl: {
          controlsPac: false,
          canControl: true,
          levelOfControl: 'controllable_by_this_extension',
        },
      }),
      external: actionStatus.getIconPath({
        proxyApplied: false,
        proxyControl: {
          controlsPac: false,
          canControl: false,
          levelOfControl: 'controlled_by_other_extensions',
        },
      }),
      busy: actionStatus.getIconPath(Object.assign({}, active, {
        operation: 'apply',
      })),
      warning: actionStatus.getIconPath(Object.assign({}, active, {
        pacStale: true,
      })),
      loading: actionStatus.getIconPath({loading: true}),
    },
  };

}

function resolveExactCase(root, resourcePath) {

  let current = root;
  for (const segment of resourcePath.split('/')) {
    Assert.ok(Fs.existsSync(current), `Missing icon parent: ${current}`);
    const entries = Fs.readdirSync(current);
    Assert.ok(
        entries.includes(segment),
        `Missing or case-mismatched runtime icon: ${resourcePath}`,
    );
    current = Path.join(current, segment);
  }
  return current;

}

function assertExtensionRelativePath(resourcePath) {

  Assert.strictEqual(typeof resourcePath, 'string');
  Assert.ok(resourcePath.length > 0, 'Runtime icon paths must not be empty.');
  Assert.ok(!Path.posix.isAbsolute(resourcePath), resourcePath);
  Assert.ok(!Path.win32.isAbsolute(resourcePath), resourcePath);
  Assert.ok(!resourcePath.includes('\\'), resourcePath);
  Assert.ok(!/^file:/i.test(resourcePath), resourcePath);
  Assert.strictEqual(Path.posix.normalize(resourcePath), resourcePath);

}

function readPngSize(filePath) {

  const data = Fs.readFileSync(filePath);
  Assert.ok(
      data.length >= 24 &&
      data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
      `Runtime icon is not a valid PNG: ${filePath}`,
  );
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };

}

function verifyRuntimeIcons(root) {

  const iconData = getRuntimeIconData();
  const resolvedByPath = new Map();
  for (const resourcePath of iconData.paths) {
    assertExtensionRelativePath(resourcePath);
    const resolved = resolveExactCase(root, resourcePath);
    Assert.ok(Fs.statSync(resolved).isFile(), `Runtime icon is not a file: ${resolved}`);
    resolvedByPath.set(resourcePath, resolved);
  }
  for (const paths of Object.values(iconData.variants)) {
    for (const [declaredSize, resourcePath] of Object.entries(paths)) {
      const size = readPngSize(resolvedByPath.get(resourcePath));
      Assert.deepStrictEqual(
          size,
          {width: Number(declaredSize), height: Number(declaredSize)},
          `Runtime icon size does not match its setIcon map: ${resourcePath}`,
      );
    }
  }
  const packagedIcons = Fs.readdirSync(Path.join(root, 'icons'))
      .filter((fileName) => fileName.toLowerCase().endsWith('.png'))
      .sort();
  const referencedIcons = iconData.paths
      .map((resourcePath) => Path.posix.basename(resourcePath))
      .sort();
  Assert.deepStrictEqual(
      packagedIcons,
      referencedIcons,
      'The icon directory must contain only referenced runtime assets.',
  );
  return iconData.paths;

}

if (require.main === module) {
  const sourcePaths = verifyRuntimeIcons(MV3_SOURCE_ROOT);
  const packagedPaths = verifyRuntimeIcons(PACKAGED_MV3_ROOT);
  Assert.deepStrictEqual(packagedPaths, sourcePaths);
  for (const resourcePath of packagedPaths) {
    console.log(`Verified packaged runtime icon: ${resourcePath}`);
  }
}

module.exports = {
  PACKAGED_MV3_ROOT,
  MV3_SOURCE_ROOT,
  getRuntimeIconData,
  verifyRuntimeIcons,
};
