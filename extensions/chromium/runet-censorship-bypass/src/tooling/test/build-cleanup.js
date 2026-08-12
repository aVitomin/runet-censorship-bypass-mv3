'use strict';

/* eslint-env node, mocha */

const Assert = require('assert');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const {createBuildCleanup} = require('../../../build-cleanup');

describe('Build cleanup', function() {

  let projectRoot;
  let cleanup;

  beforeEach(function() {

    projectRoot = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'runet-cleanup-'));
    cleanup = createBuildCleanup(projectRoot);

  });

  afterEach(function() {

    Fs.rmSync(projectRoot, {recursive: true, force: true});

  });

  it('removes the expected build directory', function() {

    Fs.mkdirSync(cleanup.paths.buildRoot);

    cleanup.cleanBuild();

    Assert.strictEqual(Fs.existsSync(cleanup.paths.buildRoot), false);

  });

  it('removes nested build contents', function() {

    const nestedFile = Path.join(
        cleanup.paths.buildRoot,
        'extension-full',
        'nested',
        'output.js',
    );
    Fs.mkdirSync(Path.dirname(nestedFile), {recursive: true});
    Fs.writeFileSync(nestedFile, 'generated');

    cleanup.cleanBuild();

    Assert.strictEqual(Fs.existsSync(nestedFile), false);
    Assert.strictEqual(Fs.existsSync(cleanup.paths.buildRoot), false);

  });

  it('succeeds when the output directory is missing', function() {

    Assert.doesNotThrow(() => cleanup.cleanChromiumMv3());

  });

  it('can run repeatedly', function() {

    Fs.mkdirSync(cleanup.paths.chromiumMv3Root, {recursive: true});

    Assert.doesNotThrow(() => cleanup.cleanChromiumMv3());
    Assert.doesNotThrow(() => cleanup.cleanChromiumMv3());

  });

  it('rejects paths outside the build root', function() {

    const outsideFile = Path.join(projectRoot, 'outside', 'keep.txt');
    Fs.mkdirSync(Path.dirname(outsideFile));
    Fs.writeFileSync(outsideFile, 'keep');

    Assert.throws(
        () => cleanup.removeOutput(Path.dirname(outsideFile)),
        /outside the build root/,
    );
    Assert.strictEqual(Fs.readFileSync(outsideFile, 'utf8'), 'keep');

  });

  it('rejects unlisted paths inside the build root', function() {

    const unlistedFile = Path.join(
        cleanup.paths.buildRoot,
        'extension-full',
        'keep.txt',
    );
    Fs.mkdirSync(Path.dirname(unlistedFile), {recursive: true});
    Fs.writeFileSync(unlistedFile, 'keep');

    Assert.throws(
        () => cleanup.removeOutput(Path.dirname(unlistedFile)),
        /not an allowed output root/,
    );
    Assert.strictEqual(Fs.readFileSync(unlistedFile, 'utf8'), 'keep');

  });

  it('rejects the project root', function() {

    const sentinel = Path.join(projectRoot, 'keep.txt');
    Fs.writeFileSync(sentinel, 'keep');

    Assert.throws(
        () => cleanup.removeOutput(projectRoot),
        /cannot be the project root/,
    );
    Assert.strictEqual(Fs.readFileSync(sentinel, 'utf8'), 'keep');

  });

  it('rejects empty and filesystem-root paths', function() {

    Assert.throws(
        () => cleanup.removeOutput(''),
        /must be a non-empty path/,
    );
    Assert.throws(
        () => cleanup.removeOutput(Path.parse(projectRoot).root),
        /cannot be a filesystem root/,
    );

  });

  it('preserves the normal MV2 then MV3 build sequence', function() {

    cleanup.cleanBuild();
    const mv2Output = Path.join(
        cleanup.paths.buildRoot,
        'extension-full',
        'manifest.json',
    );
    Fs.mkdirSync(Path.dirname(mv2Output), {recursive: true});
    Fs.writeFileSync(mv2Output, 'mv2');

    Fs.mkdirSync(cleanup.paths.chromiumMv3Root, {recursive: true});
    cleanup.cleanChromiumMv3();
    const mv3Output = Path.join(cleanup.paths.chromiumMv3Root, 'manifest.json');
    Fs.mkdirSync(Path.dirname(mv3Output), {recursive: true});
    Fs.writeFileSync(mv3Output, 'mv3');

    Assert.strictEqual(Fs.readFileSync(mv2Output, 'utf8'), 'mv2');
    Assert.strictEqual(Fs.readFileSync(mv3Output, 'utf8'), 'mv3');

  });

});
