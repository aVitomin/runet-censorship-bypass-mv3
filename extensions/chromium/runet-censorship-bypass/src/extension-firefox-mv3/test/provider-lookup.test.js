'use strict';

const Assert = require('node:assert');
const Lookup = require('../background/provider-lookup');
const {
  Dataset,
  artifact,
  payload,
  sha256,
} = require('./dataset-test-helpers');

async function build(buckets) {

  const input = artifact({payload: payload(buckets)});
  const verification = await Dataset.verifyProviderDataset(Object.assign(
      {},
      input,
      {sha256},
  ));
  Assert.strictEqual(verification.ok, true, verification.code);
  return Lookup.buildLookup(verification);

}

function fixedWidthHost(width) {

  const labels = [];
  let remaining = width;
  while (remaining > 63) {
    const labelLength = Math.min(63, remaining - 2);
    labels.push('x'.repeat(labelLength));
    remaining -= labelLength + 1;
  }
  labels.push('x'.repeat(remaining));
  return labels.join('.');

}

describe('Firefox HOST_BUCKETS_V1 lookup', function() {

  it('matches a base domain', async function() {

    const lookup = await build([{
      width: 12,
      routeRef: 'PROVIDER_PROXY',
      hosts: 'beta.example',
    }]);

    Assert.deepStrictEqual(lookup.lookup('beta.example'), {
      kind: 'PROVIDER_PROXY',
    });

  });

  it('matches the same rule as a subdomain suffix', async function() {

    const lookup = await build([{
      width: 12,
      routeRef: 'PROVIDER_PROXY',
      hosts: 'beta.example',
    }]);

    Assert.deepStrictEqual(lookup.lookup('deep.sub.beta.example'), {
      kind: 'PROVIDER_PROXY',
    });

  });

  it('does not confuse a label suffix with a domain suffix', async function() {

    const lookup = await build([{
      width: 12,
      routeRef: 'PROVIDER_PROXY',
      hosts: 'beta.example',
    }]);

    Assert.deepStrictEqual(lookup.lookup('notbeta.example'), {kind: 'MISS'});

  });

  it('returns the fixed route class attached to the matching bucket',
      async function() {

        const lookup = await build([
          {
            width: 10,
            routeRef: 'PROVIDER_DIRECT',
            hosts: 'alpha.test',
          },
          {
            width: 10,
            routeRef: 'PROVIDER_PROXY',
            hosts: 'proxy.test',
          },
        ]);

        Assert.deepStrictEqual(lookup.lookup('alpha.test'), {
          kind: 'PROVIDER_DIRECT',
        });
        Assert.deepStrictEqual(lookup.lookup('proxy.test'), {
          kind: 'PROVIDER_PROXY',
        });

      });

  it('selects across different fixed widths without linear rule scans',
      async function() {

        const lookup = await build([
          {width: 3, routeRef: 'PROVIDER_PROXY', hosts: 'a.b'},
          {width: 13, routeRef: 'PROVIDER_DIRECT', hosts: 'alpha.example'},
        ]);

        Assert.deepStrictEqual(lookup.lookup('x.a.b'), {
          kind: 'PROVIDER_PROXY',
        });
        Assert.deepStrictEqual(lookup.lookup('alpha.example'), {
          kind: 'PROVIDER_DIRECT',
        });

      });

  it('supports the longest schema-valid synthetic hostname width',
      async function() {

        const longest = fixedWidthHost(Dataset.LIMITS.MAX_HOST_LENGTH);
        const lookup = await build([{
          width: longest.length,
          routeRef: 'PROVIDER_PROXY',
          hosts: longest,
        }]);

        Assert.strictEqual(longest.length, 253);
        Assert.deepStrictEqual(lookup.lookup(longest), {
          kind: 'PROVIDER_PROXY',
        });

      });

  it('preserves the provider comparator rule that a TLD-only suffix is not a match',
      async function() {

        const lookup = await build([{
          width: 2,
          routeRef: 'PROVIDER_PROXY',
          hosts: 'ua',
        }]);

        Assert.deepStrictEqual(lookup.lookup('example.ua'), {kind: 'MISS'});

      });

  it('returns a legitimate MISS distinctly from lookup failure',
      async function() {

        const lookup = await build([{
          width: 12,
          routeRef: 'PROVIDER_PROXY',
          hosts: 'beta.example',
        }]);

        Assert.deepStrictEqual(lookup.lookup('ordinary.example'), {
          kind: 'MISS',
        });
        Assert.deepStrictEqual(lookup.lookup(null), {
          kind: 'FAILURE',
          code: 'INVALID_LOOKUP_HOSTNAME',
        });
        Assert.deepStrictEqual(lookup.lookup('bad/host'), {
          kind: 'FAILURE',
          code: 'INVALID_LOOKUP_HOSTNAME',
        });

      });

  it('normalizes case and an absolute trailing dot', async function() {

    const lookup = await build([{
      width: 12,
      routeRef: 'PROVIDER_PROXY',
      hosts: 'beta.example',
    }]);

    Assert.deepStrictEqual(lookup.lookup('BETA.EXAMPLE.'), {
      kind: 'PROVIDER_PROXY',
    });

  });

  it('refuses an object that did not pass the common verifier', function() {

    Assert.throws(
        () => Lookup.buildLookup({ok: true, dataset: {payload: {}}}),
        /INVALID_VERIFIED_DATASET/,
    );

  });

  it('detects malformed fixed-width state instead of returning MISS', function() {

    Assert.throws(
        () => Lookup.fixedBucketContains('abc', 2, 'ab'),
        /MALFORMED_LOOKUP_INDEX/,
    );

  });

});
