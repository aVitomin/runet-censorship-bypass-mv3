'use strict';


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

  it('succeeds when the output directory is missing', function() {

    Assert.doesNotThrow(() => cleanup.cleanChromiumMv3());

  });

  it('can run repeatedly', function() {

    Fs.mkdirSync(cleanup.paths.chromiumMv3Root, {recursive: true});

    Assert.doesNotThrow(() => cleanup.cleanChromiumMv3());
    Assert.doesNotThrow(() => cleanup.cleanChromiumMv3());

  });

  it('cleans the Firefox MV3 output without changing Chromium MV3', function() {

    const chromiumManifest = Path.join(
        cleanup.paths.chromiumMv3Root,
        'manifest.json',
    );
    const firefoxManifest = Path.join(
        cleanup.paths.firefoxMv3Root,
        'manifest.json',
    );
    Fs.mkdirSync(Path.dirname(chromiumManifest), {recursive: true});
    Fs.mkdirSync(Path.dirname(firefoxManifest), {recursive: true});
    Fs.writeFileSync(chromiumManifest, 'chromium');
    Fs.writeFileSync(firefoxManifest, 'firefox');

    cleanup.cleanFirefoxMv3();

    Assert.strictEqual(Fs.readFileSync(chromiumManifest, 'utf8'), 'chromium');
    Assert.strictEqual(Fs.existsSync(firefoxManifest), false);

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
        Path.dirname(cleanup.paths.chromiumMv3Root),
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

});
