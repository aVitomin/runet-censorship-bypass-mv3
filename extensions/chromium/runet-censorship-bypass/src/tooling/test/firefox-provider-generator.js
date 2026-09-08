'use strict';

const Assert = require('node:assert');
const Crypto = require('node:crypto');
const Dataset = require('../../extension-mv3-common/provider-dataset');
const Generator = require('../firefox-provider/generate-provider-dataset');

function syntheticPac() {

  const inputs = {
    IPS: {},
    HOSTNAMES: {
      12: 'beta.example',
      13: 'alpha.example',
    },
    MASKED_SUBNETS: [],
  };
  return Buffer.from([
    '// Updated: 2026-09-08 00:00:00 +0000',
    "const CUSTOM_PROXIES = 'HTTPS localhost:18611; PROXY localhost:18613; " +
      "SOCKS5 localhost:18615; SOCKS4 localhost:18617; SOCKS localhost:18619';",
    "const TOR_PROXIES = 'SOCKS5 localhost:9150; SOCKS5 localhost:9050';",
    `const inputs = ${JSON.stringify(inputs)};`,
    'const maskedAddrMaskAddrPairs = inputs.MASKED_SUBNETS;',
  ].join('\n'));

}

function options(sourceBytes) {

  return {
    sourceBytes,
    sourceSha256: Generator.sha256(sourceBytes),
    sourceRevision: 'a'.repeat(40),
    generatorRevision: 'b'.repeat(40),
    datasetVersion: 'synthetic.1',
  };

}

function streamingResponse(url, chunks, options = {}) {

  let index = 0;
  return {
    status: options.status === undefined ? 200 : options.status,
    redirected: false,
    url,
    headers: {
      get(name) {

        if (name.toLowerCase() === 'location') {
          return options.location || null;
        }
        if (name.toLowerCase() === 'content-length') {
          return options.contentLength || null;
        }
        return null;

      },
    },
    body: {
      getReader() {

        return {
          async read() {

            if (index >= chunks.length) {
              return {done: true};
            }
            return {done: false, value: chunks[index++]};

          },
          async cancel() {},
        };

      },
    },
  };

}

describe('Firefox provider dataset generator', function() {

  it('generates identical strict artifacts from identical PAC bytes',
      async function() {

        const source = syntheticPac();
        const first = await Generator.generateFromPacBytes(options(source));
        const second = await Generator.generateFromPacBytes(options(source));
        Assert.deepStrictEqual(first.artifactBytes, second.artifactBytes);
        Assert.deepStrictEqual(first.envelope, second.envelope);
        Assert.strictEqual(first.envelope.ruleCount, 2);
        Assert.strictEqual(JSON.parse(first.artifactBytes).format,
            Dataset.PAYLOAD_FORMAT);

      });

  it('rejects source hash, non-host rules, and changed proxy policy',
      async function() {

        const source = syntheticPac();
        await Assert.rejects(
            () => Generator.generateFromPacBytes(Object.assign(
                options(source),
                {sourceSha256: 'c'.repeat(64)},
            )),
            (error) => error.code === 'SOURCE_SHA256_MISMATCH',
        );
        const nonHost = Buffer.from(source.toString().replace(
            '"IPS":{}',
            '"IPS":{"127.0.0.1":true}',
        ));
        await Assert.rejects(
            () => Generator.generateFromPacBytes(options(nonHost)),
            (error) => error.code === 'UNSUPPORTED_NON_HOST_RULES',
        );
        const policy = Buffer.from(source.toString().replace(
            'SOCKS localhost:18619',
            'SOCKS localhost:18621',
        ));
        await Assert.rejects(
            () => Generator.generateFromPacBytes(options(policy)),
            (error) => error.code === 'PROVIDER_PROXY_POLICY_CHANGED',
        );

      });

  it('creates detached Ed25519 signatures over exact manifest bytes',
      function() {

        const pair = Crypto.generateKeyPairSync('ed25519');
        const manifest = Buffer.from('{"synthetic":true}\n');
        const signature = Generator.signManifestBytes(
            manifest,
            pair.privateKey.export({format: 'pem', type: 'pkcs8'}),
        );
        Assert.strictEqual(signature.byteLength, 64);
        Assert.strictEqual(
            Crypto.verify(null, manifest, pair.publicKey, signature),
            true,
        );
        Assert.strictEqual(
            Crypto.verify(
                null,
                Buffer.from('{"synthetic":false}\n'),
                pair.publicKey,
                signature,
            ),
            false,
        );

      });

  it('downloads only bounded exact same-origin HTTPS bytes', async function() {

    const url = 'https://example.test/provider.pac';
    const expected = Uint8Array.from([1, 2, 3, 4]);
    const received = await Generator.downloadSource(url, async (requested) => {

      Assert.strictEqual(requested, url);
      return streamingResponse(url, [expected.subarray(0, 2),
        expected.subarray(2)]);

    });
    Assert.deepStrictEqual(received, expected);
    await Assert.rejects(
        () => Generator.downloadSource('http://example.test/provider.pac'),
        (error) => error.code === 'SOURCE_URL_INVALID',
    );
    await Assert.rejects(
        () => Generator.downloadSource(url, async () => streamingResponse(
            url,
            [],
            {status: 302, location: 'https://other.test/provider.pac'},
        )),
        (error) => error.code === 'SOURCE_REDIRECT_ORIGIN_CHANGED',
    );

  });

  it('enforces the source limit while streaming', async function() {

    const url = 'https://example.test/provider.pac';
    const full = new Uint8Array(Generator.MAX_SOURCE_BYTES);
    await Assert.rejects(
        () => Generator.downloadSource(url, async () => streamingResponse(
            url,
            [full, Uint8Array.of(1)],
        )),
        (error) => error.code === 'INVALID_SOURCE_SIZE',
    );

  });

  it('contains no PAC evaluation or dynamic code execution', function() {

    const source = require('node:fs').readFileSync(
        require.resolve('../firefox-provider/generate-provider-dataset'),
        'utf8',
    );
    Assert.strictEqual(source.includes('eval('), false);
    Assert.strictEqual(source.includes('Function('), false);
    Assert.strictEqual(source.includes('vm.'), false);

  });

});
