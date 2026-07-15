'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Fs = require('fs');
const Mocha = require('mocha');
const Path = require('path');
const Vm = require('vm');
const {loadBackgroundModules} = require('./background-modules');

const PAC_TEXT = 'function FindProxyForURL() { return "DIRECT"; }';
const SERVICE_WORKER_SOURCE = Fs.readFileSync(
    Path.resolve(__dirname, '..', 'background', 'service-worker.js'),
    'utf8',
);

function createCustomProvider(urls) {

  return {
    key: 'custom:redirect-test-provider',
    type: 'custom',
    urls: urls.slice(),
  };

}

function createResponse(url, options = {}) {

  const status = options.status === undefined ? 200 : options.status;
  const tracker = options.tracker || {};
  return {
    url,
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {

        return options.headers && options.headers[name] || null;

      },
    },
    async text() {

      tracker.textCalls = (tracker.textCalls || 0) + 1;
      return options.body === undefined ? PAC_TEXT : options.body;

    },
  };

}

async function withResponses(responses, callback) {

  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async function(url, options) {

    calls.push({url, options});
    const response = responses[calls.length - 1];
    if (response instanceof Error) {
      throw response;
    }
    if (!response) {
      throw new Error('Unexpected PAC fetch.');
    }
    return response;

  };
  try {
    return await callback(calls);
  } finally {
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
  }

}

function getDownloadPacAndPersist() {

  const start = SERVICE_WORKER_SOURCE.indexOf(
      'async function downloadPacAndPersist',
  );
  const end = SERVICE_WORKER_SOURCE.indexOf(
      '\nasync function cookPacAndPersist',
      start,
  );
  Chai.expect(start).to.be.at.least(0);
  Chai.expect(end).to.be.greaterThan(start);
  return Vm.runInThisContext(`(${SERVICE_WORKER_SOURCE.slice(start, end)})`);

}

async function runPersistenceFlow(result, existingPacCache) {

  const provider = createCustomProvider([
    'https://origin.example/proxy.pac',
  ]);
  const names = [
    'createPacDownloadState',
    'getProviderForState',
    'mv3PacArtifacts',
    'mv3PacDownload',
    'mv3State',
  ];
  const descriptors = new Map(
      names.map((name) => [name, Object.getOwnPropertyDescriptor(global, name)]),
  );
  const artifactWrites = [];
  const cacheWrites = [];
  const downloadStates = [];

  global.createPacDownloadState = (status, value) =>
    Object.assign({status}, value);
  global.getProviderForState = () => provider;
  global.mv3PacArtifacts = {
    async putRawPacArtifact(value) {

      artifactWrites.push(value);
      return value;

    },
  };
  global.mv3PacDownload = {
    async downloadPac() {

      return result;

    },
  };
  global.mv3State = {
    async loadState() {

      return {
        currentPacProviderKey: provider.key,
        pacCache: existingPacCache,
      };

    },
    async setPacDownloadState(value) {

      downloadStates.push(value);
      return value;

    },
    async setPacCache(value) {

      cacheWrites.push(value);
      return value;

    },
  };

  try {
    const persisted = await getDownloadPacAndPersist()({
      providerKey: provider.key,
      force: true,
    });
    return {artifactWrites, cacheWrites, downloadStates, persisted};
  } finally {
    descriptors.forEach((descriptor, name) => {
      if (descriptor) {
        Object.defineProperty(global, name, descriptor);
      } else {
        delete global[name];
      }
    });
  }

}

Mocha.describe('MV3 PAC download redirect validation', function() {

  Mocha.beforeEach(function() {

    loadBackgroundModules();

  });

  Mocha.it('accepts an HTTPS to HTTPS redirect', async function() {

    const requestedUrl = 'https://origin.example/proxy.pac';
    const response = createResponse('https://cdn.example/proxy.pac');
    await withResponses([response], async function(calls) {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider([requestedUrl]),
      );

      Chai.expect(calls.map((call) => call.url)).to.deep.equal([requestedUrl]);
      Chai.expect(result).to.include({
        ok: true,
        status: 'success',
        url: requestedUrl,
        rawPacData: PAC_TEXT,
      });
    });

  });

  Mocha.it('accepts a loopback HTTP to loopback HTTP redirect', async function() {

    const requestedUrl = 'http://127.0.0.1:8765/proxy.pac';
    const response = createResponse('http://localhost:8765/redirected.pac');
    await withResponses([response], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider([requestedUrl]),
      );

      Chai.expect(result).to.include({ok: true, status: 'success'});
    });

  });

  Mocha.it('revalidates the requested URL before fetching', async function() {

    await withResponses([], async function(calls) {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider([
            'http://pac.example/proxy.pac?token=private#fragment',
          ]),
      );
      const serialized = JSON.stringify(result);

      Chai.expect(calls).to.deep.equal([]);
      Chai.expect(result.error).to.deep.equal({
        code: 'PAC_SOURCE_URL_REJECTED',
        message: 'PAC source URL is not allowed.',
        details: null,
      });
      Chai.expect(serialized).not.to.include('private');
      Chai.expect(serialized).not.to.include('fragment');
    });

  });

  Mocha.it('rejects an HTTPS redirect to external HTTP', async function() {

    const tracker = {};
    const response = createResponse('http://pac.example/proxy.pac', {tracker});
    await withResponses([response], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider(['https://origin.example/proxy.pac']),
      );

      Chai.expect(result).to.deep.include({
        ok: false,
        status: 'error',
        url: null,
      });
      Chai.expect(result.error).to.deep.equal({
        code: 'PAC_RESPONSE_URL_REJECTED',
        message: 'PAC response URL is not allowed.',
        details: null,
      });
      Chai.expect(tracker.textCalls || 0).to.equal(0);
    });

  });

  Mocha.it('rejects a loopback redirect to external HTTP', async function() {

    const tracker = {};
    const response = createResponse('http://pac.example/proxy.pac', {tracker});
    await withResponses([response], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider([
            'http://127.0.0.1:8765/proxy.pac',
          ]),
      );

      Chai.expect(result.error).to.have.property(
          'code',
          'PAC_RESPONSE_URL_REJECTED',
      );
      Chai.expect(tracker.textCalls || 0).to.equal(0);
    });

  });

  Mocha.it('rejects a credential-bearing redirect without leaking it',
      async function() {

        const requestedUrl = [
          'https://origin.example/proxy.pac',
          '?source=source-private#source-fragment',
        ].join('');
        const responseUrl = [
          'https://redirect-user:',
          'synthetic-password',
          '@pac.example/proxy.pac?token=private#secret-fragment',
        ].join('');
        await withResponses([createResponse(responseUrl)], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );
          const serialized = JSON.stringify(result);

          Chai.expect(result.error).to.deep.equal({
            code: 'PAC_RESPONSE_URL_REJECTED',
            message: 'PAC response URL is not allowed.',
            details: null,
          });
          [
            'redirect-user',
            'synthetic-password',
            'private',
            'secret-fragment',
            'source-private',
            'source-fragment',
          ].forEach((secret) => Chai.expect(serialized).not.to.include(secret));
        });

      });

  Mocha.it('sanitizes a fetch rejection that contains a redirect URL',
      async function() {

        const rejectedUrl = [
          'https://redirect-user:',
          'synthetic-password',
          '@pac.example/proxy.pac?token=private#secret-fragment',
        ].join('');
        await withResponses([
          new TypeError(`Failed to fetch ${rejectedUrl}`),
        ], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([
                'https://origin.example/proxy.pac?source=private#fragment',
              ]),
          );
          const serialized = JSON.stringify(result);

          Chai.expect(result.error).to.deep.equal({
            code: 'PAC_DOWNLOAD_FAILED',
            message: 'PAC download failed.',
            details: null,
          });
          [
            'redirect-user',
            'synthetic-password',
            'private',
            'secret-fragment',
            'fragment',
          ].forEach((secret) => Chai.expect(serialized).not.to.include(secret));
        });

      });

  Mocha.it('rejects a redirect to an unsupported protocol', async function() {

    const tracker = {};
    await withResponses([
      createResponse('file:///temporary/proxy.pac', {tracker}),
    ], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider(['https://origin.example/proxy.pac']),
      );

      Chai.expect(result.error).to.have.property(
          'code',
          'PAC_RESPONSE_URL_REJECTED',
      );
      Chai.expect(tracker.textCalls || 0).to.equal(0);
    });

  });

  Mocha.it('does not store a rejected response or replace its cached PAC',
      async function() {

        const tracker = {};
        const existingPacCache = {
          providerKey: 'custom:redirect-test-provider',
          rawArtifactId: 'raw:existing-valid-artifact',
          rawPacSha256: 'existing-valid-sha256',
        };
        let rejected;
        await withResponses([
          createResponse('http://pac.example/rejected.pac', {tracker}),
        ], async function() {
          rejected = await global.mv3PacDownload.downloadPac(
              createCustomProvider(['https://origin.example/proxy.pac']),
          );
        });

        const flow = await runPersistenceFlow(rejected, existingPacCache);

        Chai.expect(rejected).not.to.have.property('rawPacData');
        Chai.expect(tracker.textCalls || 0).to.equal(0);
        Chai.expect(flow.artifactWrites).to.deep.equal([]);
        Chai.expect(flow.cacheWrites).to.deep.equal([]);
        Chai.expect(existingPacCache).to.deep.equal({
          providerKey: 'custom:redirect-test-provider',
          rawArtifactId: 'raw:existing-valid-artifact',
          rawPacSha256: 'existing-valid-sha256',
        });
        Chai.expect(flow.persisted).to.deep.include({
          ok: false,
          status: 'error',
        });
      });

  Mocha.it('keeps valid non-redirect downloads working', async function() {

    const requestedUrl = 'https://origin.example/proxy.pac';
    await withResponses([
      createResponse(requestedUrl),
    ], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider([requestedUrl]),
      );

      Chai.expect(result).to.include({
        ok: true,
        status: 'success',
        url: requestedUrl,
        rawPacData: PAC_TEXT,
      });
    });

  });

  Mocha.it('continues to a valid fallback after rejecting a redirect',
      async function() {

        const firstUrl = 'https://first.example/proxy.pac';
        const secondUrl = 'https://second.example/proxy.pac';
        const firstTracker = {};
        await withResponses([
          createResponse('http://external.example/proxy.pac', {
            tracker: firstTracker,
          }),
          createResponse(secondUrl),
        ], async function(calls) {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([firstUrl, secondUrl]),
          );

          Chai.expect(calls.map((call) => call.url))
              .to.deep.equal([firstUrl, secondUrl]);
          Chai.expect(firstTracker.textCalls || 0).to.equal(0);
          Chai.expect(result).to.include({
            ok: true,
            status: 'success',
            url: secondUrl,
          });
        });

      });

  Mocha.it('keeps built-in fallback order under redirect validation',
      async function() {

        const provider = global.mv3Providers.getProviderByKey('Антизапрет');
        const firstTracker = {};
        await withResponses([
          createResponse('http://external.example/proxy.pac', {
            tracker: firstTracker,
          }),
          createResponse('https://fallback.example/proxy.pac'),
        ], async function(calls) {
          const result = await global.mv3PacDownload.downloadPac(provider);

          Chai.expect(calls.map((call) => call.url)).to.deep.equal(
              provider.urls.slice(0, 2),
          );
          Chai.expect(firstTracker.textCalls || 0).to.equal(0);
          Chai.expect(result).to.include({
            ok: true,
            status: 'success',
            url: provider.urls[1],
          });
        });

      });

  Mocha.it('keeps the built-in data PAC download working', async function() {

    const provider = global.mv3Providers.getProviderByKey('onlyOwnSites');
    await withResponses([
      createResponse(provider.urls[0]),
    ], async function() {
      const result = await global.mv3PacDownload.downloadPac(provider);

      Chai.expect(result).to.include({
        ok: true,
        status: 'success',
        url: provider.urls[0],
      });
    });

  });

});
