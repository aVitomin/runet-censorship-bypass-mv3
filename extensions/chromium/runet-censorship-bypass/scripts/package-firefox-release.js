'use strict';

const Assert = require('node:assert');
const ChildProcess = require('node:child_process');
const Crypto = require('node:crypto');
const Fs = require('node:fs');
const Path = require('node:path');
const Templates = require('../src/templates-data');

const PROJECT_ROOT = Path.resolve(__dirname, '..');
const REPOSITORY_ROOT = Path.resolve(PROJECT_ROOT, '..', '..', '..');
const FIREFOX_BUILD_ROOT = Path.join(
    PROJECT_ROOT,
    'build',
    'extension-firefox-mv3',
);
const RELEASE_ROOT = Path.join(PROJECT_ROOT, 'dist', 'firefox-release');
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function compareNames(left, right) {

  return left < right ? -1 : left > right ? 1 : 0;

}

function makeCrc32Table() {

  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;

}

const CRC32_TABLE = makeCrc32Table();

function crc32(bytes) {

  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;

}

function normalizeArchiveName(value) {

  if (typeof value !== 'string' || value === '' || value.includes('\\') ||
      value.startsWith('/') || value.includes('\0')) {
    throw new TypeError('Archive entry name is invalid.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' ||
      segment === '..')) {
    throw new TypeError('Archive entry path is invalid.');
  }
  return value;

}

function createDeterministicZip(entries) {

  if (!Array.isArray(entries) || entries.length < 1) {
    throw new TypeError('At least one archive entry is required.');
  }
  const normalized = entries.map((entry) => {
    const name = normalizeArchiveName(entry && entry.name);
    const data = Buffer.from(entry.data);
    const mode = entry.mode === 0o100755 ? 0o100755 : 0o100644;
    return Object.freeze({data, mode, name});
  }).sort((left, right) => compareNames(left.name, right.name));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].name === normalized[index].name) {
      throw new TypeError('Archive entry names must be unique.');
    }
  }
  if (normalized.length > 0xffff) {
    throw new RangeError('ZIP64 entry counts are not supported.');
  }

  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of normalized) {
    const name = Buffer.from(entry.name, 'utf8');
    if (name.length > 0xffff || entry.data.length > 0xffffffff) {
      throw new RangeError('ZIP64 entry sizes are not supported.');
    }
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + entry.data.length;
    if (localOffset > 0xffffffff) {
      throw new RangeError('ZIP64 archive sizes are not supported.');
    }
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > 0xffffffff ||
      localOffset + centralDirectory.length > 0xffffffff) {
    throw new RangeError('ZIP64 archive sizes are not supported.');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);

}

function listDirectoryEntries(root) {

  const resolvedRoot = Path.resolve(root);
  const entries = [];
  function visit(relativeDirectory) {

    const directory = Path.join(resolvedRoot, relativeDirectory);
    for (const item of Fs.readdirSync(directory, {withFileTypes: true})) {
      const relativePath = Path.join(relativeDirectory, item.name);
      const absolutePath = Path.join(resolvedRoot, relativePath);
      if (item.isSymbolicLink()) {
        throw new Error(`Release input cannot contain symlinks: ${relativePath}`);
      }
      if (item.isDirectory()) {
        visit(relativePath);
      } else if (item.isFile()) {
        entries.push(Object.freeze({
          data: Fs.readFileSync(absolutePath),
          mode: 0o100644,
          name: relativePath.split(Path.sep).join('/'),
        }));
      } else {
        throw new Error(`Unsupported release input: ${relativePath}`);
      }
    }

  }
  visit('');
  return entries.sort((left, right) => compareNames(left.name, right.name));

}

function runGit(args) {

  const result = ChildProcess.spawnSync('git', args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error('Git command failed while creating the source archive.');
  }
  return result.stdout;

}

function assertCleanTrackedTree() {

  const status = runGit(['status', '--porcelain=v1', '--untracked-files=normal']);
  if (status !== '') {
    throw new Error('Firefox release packaging requires a clean tracked tree.');
  }

}

function listTrackedSourceEntries(prefix) {

  const output = runGit(['ls-files', '--stage', '-z']);
  const entries = [];
  for (const record of output.split('\0')) {
    if (!record) {
      continue;
    }
    const match = /^(100644|100755) [0-9a-f]+ \d\t(.+)$/s.exec(record);
    if (!match) {
      throw new Error('Source archive contains an unsupported Git entry.');
    }
    const relativePath = match[2];
    const absolutePath = Path.resolve(REPOSITORY_ROOT, relativePath);
    const relativeCheck = Path.relative(REPOSITORY_ROOT, absolutePath);
    if (relativeCheck.startsWith('..') || Path.isAbsolute(relativeCheck)) {
      throw new Error('Tracked source path escapes the repository.');
    }
    entries.push(Object.freeze({
      data: Fs.readFileSync(absolutePath),
      mode: match[1] === '100755' ? 0o100755 : 0o100644,
      name: `${prefix}/${relativePath.split(Path.sep).join('/')}`,
    }));
  }
  return entries;

}

function sha256(bytes) {

  return Crypto.createHash('sha256').update(bytes).digest('hex');

}

function releaseVersion() {

  const manifestPath = Path.join(FIREFOX_BUILD_ROOT, 'manifest.json');
  const manifest = JSON.parse(Fs.readFileSync(manifestPath, 'utf8'));
  const expected = `0.0.${Templates.contexts.chromiumMv3.storeVersion}`;
  Assert.strictEqual(manifest.version, expected,
      'Firefox version must follow the repository release version.');
  return manifest.version;

}

function createReleaseBuffers() {

  const version = releaseVersion();
  const base = `runet-censorship-bypass-firefox-${version}`;
  const xpiName = `${base}.xpi`;
  const sourceName = `${base}-source.zip`;
  const xpi = createDeterministicZip(listDirectoryEntries(FIREFOX_BUILD_ROOT));
  const source = createDeterministicZip(listTrackedSourceEntries(
      `runet-censorship-bypass-mv3-${version}-source`,
  ));
  const xpiSha256 = sha256(xpi);
  const sourceSha256 = sha256(source);
  return Object.freeze({
    files: Object.freeze(new Map([
      [xpiName, xpi],
      [`${xpiName}.sha256`, Buffer.from(`${xpiSha256}  ${xpiName}\n`)],
      [sourceName, source],
      [`${sourceName}.sha256`,
        Buffer.from(`${sourceSha256}  ${sourceName}\n`)],
    ])),
    sourceName,
    sourceSha256,
    version,
    xpiName,
    xpiSha256,
  });

}

function runFirefoxBuild() {

  for (const args of [
    ['./node_modules/gulp/bin/gulp.js', 'buildFirefoxMv3'],
    ['./src/extension-firefox-mv3/test/verify-package.js'],
  ]) {
    const result = ChildProcess.spawnSync(process.execPath, args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error('Firefox release build failed.');
    }
  }

}

function compareReleaseBuffers(left, right) {

  Assert.deepStrictEqual([...left.files.keys()], [...right.files.keys()]);
  for (const [name, bytes] of left.files) {
    Assert.deepStrictEqual(bytes, right.files.get(name),
        `Non-deterministic release artifact: ${name}`);
  }

}

function writeReleaseBuffers(release) {

  if (Fs.existsSync(RELEASE_ROOT) &&
      Fs.readdirSync(RELEASE_ROOT).length !== 0) {
    throw new Error('Firefox release output already exists; refusing overwrite.');
  }
  Fs.mkdirSync(RELEASE_ROOT, {recursive: true});
  for (const [name, bytes] of release.files) {
    Fs.writeFileSync(Path.join(RELEASE_ROOT, name), bytes, {flag: 'wx'});
  }

}

function main() {

  assertCleanTrackedTree();
  const verifyRebuild = process.argv.slice(2).includes('--verify-rebuild');
  if (verifyRebuild) {
    runFirefoxBuild();
  }
  const first = createReleaseBuffers();
  if (verifyRebuild) {
    runFirefoxBuild();
    compareReleaseBuffers(first, createReleaseBuffers());
  }
  writeReleaseBuffers(first);
  console.log(JSON.stringify({
    deterministicRebuilds: verifyRebuild ? 2 : 1,
    outputDirectory: Path.relative(REPOSITORY_ROOT, RELEASE_ROOT)
        .split(Path.sep).join('/'),
    sourceArchive: {
      filename: first.sourceName,
      sha256: first.sourceSha256,
      size: first.files.get(first.sourceName).length,
    },
    version: first.version,
    xpi: {
      filename: first.xpiName,
      sha256: first.xpiSha256,
      size: first.files.get(first.xpiName).length,
    },
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

module.exports = Object.freeze({
  compareReleaseBuffers,
  crc32,
  createDeterministicZip,
  listDirectoryEntries,
  normalizeArchiveName,
});
