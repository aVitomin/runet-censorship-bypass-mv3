'use strict';

const Assert = require('node:assert');
const ChildProcess = require('node:child_process');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');
const Templates = require('../src/templates-data');
const FirefoxRelease = require('./package-firefox-release');

const PROJECT_ROOT = Path.resolve(__dirname, '..');
const REPOSITORY_ROOT = Path.resolve(PROJECT_ROOT, '..', '..', '..');
const BUILD_ROOT = Path.join(PROJECT_ROOT, 'build', 'extension-chromium-mv3');
const RELEASE_ROOT = Path.join(PROJECT_ROOT, 'dist', 'chromium-release');

function runGit(args) {

  const result = ChildProcess.spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error('Git command failed while creating the Chromium release.');
  }
  return result.stdout.trim();

}

function assertCleanTrackedTree() {

  if (runGit(['status', '--porcelain=v1', '--untracked-files=normal']) !== '') {
    throw new Error('Chromium release packaging requires a clean tracked tree.');
  }

}

function runChromiumBuild() {

  for (const args of [
    ['./node_modules/gulp/bin/gulp.js', 'buildChromiumMv3'],
    ['./src/extension-chromium-mv3/test/verify-runtime-icons.js'],
    ['./src/extension-chromium-mv3/test/verify-package-integrity.js'],
  ]) {
    const result = ChildProcess.spawnSync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error('Chromium release build failed.');
    }
  }

}

function releaseIdentity() {

  const manifest = JSON.parse(Fs.readFileSync(
      Path.join(BUILD_ROOT, 'manifest.json'),
      'utf8',
  ));
  const expectedVersion = `0.0.${Templates.contexts.chromiumMv3.storeVersion}`;
  const expectedVersionName = `0.0.${Templates.contexts.chromiumMv3.version}`;
  Assert.strictEqual(manifest.version, expectedVersion);
  Assert.strictEqual(manifest.version_name, expectedVersionName);
  const shortSha = runGit(['rev-parse', '--short=7', 'HEAD']);
  Assert.match(shortSha, /^[0-9a-f]{7}$/u);
  return Object.freeze({shortSha, version: manifest.version});

}

function createRelease() {

  const identity = releaseIdentity();
  const filename = [
    'runet-censorship-bypass-mv3',
    identity.version,
    identity.shortSha,
  ].join('-') + '.zip';
  const archive = FirefoxRelease.createDeterministicZip(
      FirefoxRelease.listDirectoryEntries(BUILD_ROOT),
  );
  const sha256 = Crypto.createHash('sha256').update(archive).digest('hex');
  return Object.freeze({archive, filename, sha256, ...identity});

}

function writeRelease(release) {

  if (Fs.existsSync(RELEASE_ROOT) && Fs.readdirSync(RELEASE_ROOT).length !== 0) {
    throw new Error('Chromium release output already exists; refusing overwrite.');
  }
  Fs.mkdirSync(RELEASE_ROOT, {recursive: true});
  Fs.writeFileSync(
      Path.join(RELEASE_ROOT, release.filename),
      release.archive,
      {flag: 'wx'},
  );
  const checksumName = `${release.filename}.sha256.txt`;
  Fs.writeFileSync(
      Path.join(RELEASE_ROOT, checksumName),
      `${release.sha256}  ${release.filename}\n`,
      {flag: 'wx'},
  );
  return checksumName;

}

function main() {

  assertCleanTrackedTree();
  const verifyRebuild = process.argv.slice(2).includes('--verify-rebuild');
  if (verifyRebuild) {
    runChromiumBuild();
  }
  const first = createRelease();
  if (verifyRebuild) {
    runChromiumBuild();
    const second = createRelease();
    Assert.deepStrictEqual(first.archive, second.archive,
        'Chromium release ZIP is not deterministic.');
    Assert.strictEqual(first.sha256, second.sha256);
  }
  const checksumName = writeRelease(first);
  console.log(JSON.stringify({
    deterministicRebuilds: verifyRebuild ? 2 : 1,
    outputDirectory: Path.relative(REPOSITORY_ROOT, RELEASE_ROOT)
        .split(Path.sep).join('/'),
    release: {
      checksumFilename: checksumName,
      filename: first.filename,
      sha256: first.sha256,
      size: first.archive.length,
    },
    version: first.version,
  }, null, 2));

}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.message ? error.message : 'Release build failed.');
    process.exitCode = 1;
  }
}
