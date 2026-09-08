'use strict';

const Assert = require('node:assert');
const Fs = require('node:fs');
const Os = require('node:os');
const Path = require('node:path');
const Release = require('../../../scripts/package-firefox-release');

describe('Firefox deterministic release packaging', function() {

  let temporaryRoot;

  afterEach(function() {

    if (temporaryRoot) {
      Fs.rmSync(temporaryRoot, {recursive: true, force: true});
      temporaryRoot = null;
    }

  });

  it('uses the standard CRC-32 value', function() {

    Assert.strictEqual(
        Release.crc32(Buffer.from('123456789')),
        0xcbf43926,
    );

  });

  it('creates byte-identical sorted ZIP archives', function() {

    const entries = [
      {name: 'z.txt', data: Buffer.from('last')},
      {name: 'a.txt', data: Buffer.from('first')},
    ];
    const first = Release.createDeterministicZip(entries);
    const second = Release.createDeterministicZip([...entries].reverse());

    Assert.deepStrictEqual(first, second);
    Assert.strictEqual(first.readUInt32LE(0), 0x04034b50);
    const nameLength = first.readUInt16LE(26);
    Assert.strictEqual(first.subarray(30, 30 + nameLength).toString(), 'a.txt');
    Assert.strictEqual(first.readUInt32LE(first.length - 22), 0x06054b50);

  });

  it('rejects duplicate and path-traversal entries', function() {

    Assert.throws(() => Release.createDeterministicZip([
      {name: 'same', data: Buffer.from('one')},
      {name: 'same', data: Buffer.from('two')},
    ]));
    Assert.throws(() => Release.createDeterministicZip([
      {name: '../outside', data: Buffer.from('bad')},
    ]));

  });

  it('collects only sorted regular files from the package tree', function() {

    temporaryRoot = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'firefox-release-'));
    Fs.mkdirSync(Path.join(temporaryRoot, 'nested'));
    Fs.writeFileSync(Path.join(temporaryRoot, 'z.txt'), 'z');
    Fs.writeFileSync(Path.join(temporaryRoot, 'nested', 'a.txt'), 'a');

    const entries = Release.listDirectoryEntries(temporaryRoot);
    Assert.deepStrictEqual(
        entries.map((entry) => entry.name),
        ['nested/a.txt', 'z.txt'],
    );

  });

});
