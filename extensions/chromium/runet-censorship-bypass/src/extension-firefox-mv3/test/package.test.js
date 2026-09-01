'use strict';

const Assert = require('node:assert');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const {EXPECTED_FILES, verifyPackage} = require('./verify-package');

const sourceRoot = Path.resolve(__dirname, '..');

function makePackage() {

  const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'firefox-skeleton-package-'));
  for (const relativePath of EXPECTED_FILES) {
    const target = Path.join(root, relativePath);
    Fs.mkdirSync(Path.dirname(target), {recursive: true});
    Fs.copyFileSync(Path.join(sourceRoot, relativePath), target);
  }
  return root;

}

describe('Firefox MV3 package verifier', function() {

  let packageRoot;

  afterEach(function() {

    if (packageRoot) {
      Fs.rmSync(packageRoot, {recursive: true, force: true});
      packageRoot = null;
    }

  });

  it('accepts only the exact inert package', function() {

    packageRoot = makePackage();
    const result = verifyPackage(packageRoot, sourceRoot);

    Assert.deepStrictEqual(result.files, [...EXPECTED_FILES]);

  });

  it('rejects an unexpected packaged artifact', function() {

    packageRoot = makePackage();
    Fs.writeFileSync(Path.join(packageRoot, 'debug.log'), 'not runtime');

    Assert.throws(() => verifyPackage(packageRoot, sourceRoot));

  });

  it('rejects a routing permission in the package manifest', function() {

    packageRoot = makePackage();
    const manifestPath = Path.join(packageRoot, 'manifest.json');
    const manifest = JSON.parse(Fs.readFileSync(manifestPath, 'utf8'));
    manifest.permissions.push('proxy');
    Fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    Assert.throws(() => verifyPackage(packageRoot, sourceRoot));

  });

});
