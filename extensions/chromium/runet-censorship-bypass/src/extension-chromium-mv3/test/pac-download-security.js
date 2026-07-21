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
  const response = {
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
      if (typeof options.text === 'function') {
        return options.text();
      }
      return options.body === undefined ? PAC_TEXT : options.body;

    },
  };
  const ifStreamProvided = Object.prototype.hasOwnProperty.call(
      options,
      'stream',
  );
  if (ifStreamProvided) {
    if (options.stream) {
      response.body = options.stream;
    }
  } else if (![204, 205, 304].includes(status)) {
    const body = options.body === undefined ? PAC_TEXT : options.body;
    response.body = createControlledBody([
      body instanceof Uint8Array ? body : encodeText(body),
    ], tracker);
  }
  if (typeof options.arrayBuffer === 'function') {
    response.arrayBuffer = options.arrayBuffer;
  }
  return response;

}

function encodeText(value) {

  return new TextEncoder().encode(value);

}

function createReadGate(value) {

  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {
    ifGate: true,
    markStarted,
    promise,
    release,
    started,
    value,
  };

}

function createControlledBody(steps, tracker = {}, options = {}) {

  let ifCancelled = false;
  let nextStepIndex = 0;
  let pendingGate = null;
  const releasePendingGate = () => {
    if (pendingGate) {
      pendingGate.release();
      pendingGate = null;
    }
  };
  const cancel = (counter, error) => {
    tracker[counter] = (tracker[counter] || 0) + 1;
    ifCancelled = true;
    releasePendingGate();
    return error ? Promise.reject(error) : Promise.resolve();
  };
  return {
    cancel() {

      return cancel('bodyCancelCalls', options.bodyCancelError);

    },
    getReader() {

      tracker.getReaderCalls = (tracker.getReaderCalls || 0) + 1;
      return {
        cancel() {

          return cancel('readerCancelCalls', options.readerCancelError);

        },
        read() {

          tracker.readCalls = (tracker.readCalls || 0) + 1;
          if (typeof options.onRead === 'function') {
            options.onRead(tracker.readCalls, nextStepIndex);
          }
          if (ifCancelled) {
            return Promise.resolve({done: true});
          }
          if (nextStepIndex >= steps.length) {
            return Promise.resolve({done: true});
          }
          const step = steps[nextStepIndex++];
          if (step instanceof Error) {
            return Promise.reject(step);
          }
          if (!step || step.ifGate !== true) {
            return Promise.resolve({done: false, value: step});
          }
          pendingGate = step;
          step.markStarted();
          return step.promise.then(() => {
            pendingGate = null;
            return ifCancelled ?
              {done: true} :
              {done: false, value: step.value};
          });

        },
        releaseLock() {

          tracker.releaseLockCalls = (tracker.releaseLockCalls || 0) + 1;
          if (options.releaseLockError) {
            throw options.releaseLockError;
          }

        },
      };

    },
  };

}

function createPacBytes(byteLength) {

  const prefix = encodeText(PAC_TEXT);
  if (byteLength < prefix.byteLength) {
    throw new RangeError('Synthetic PAC byte length is too small.');
  }
  const bytes = new Uint8Array(byteLength);
  bytes.fill(32);
  bytes.set(prefix);
  return bytes;

}

function createPacBytesWithMultibyte(byteLength) {

  const bytes = createPacBytes(byteLength);
  const multiByte = encodeText('Ж');
  bytes.set(multiByte, byteLength - multiByte.byteLength);
  return bytes;

}

function createPacWithByteSuffix(suffix) {

  const prefix = encodeText(`${PAC_TEXT}\n// `);
  const bytes = new Uint8Array(prefix.byteLength + suffix.length);
  bytes.set(prefix);
  bytes.set(suffix, prefix.byteLength);
  return bytes;

}

function createReusableCache(providerKey, url) {

  return {
    providerKey,
    url: url || 'https://cached.example/proxy.pac',
    artifactRef: 'raw:synthetic-existing-artifact',
    rawPacSha256: 'synthetic-existing-sha256',
    etag: 'synthetic-etag',
  };

}

async function withFakeTimers(callback) {

  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextTimerId = 1;
  global.setTimeout = (handler) => {
    const timerId = nextTimerId++;
    timers.set(timerId, handler);
    return timerId;
  };
  global.clearTimeout = (timerId) => timers.delete(timerId);
  try {
    return await callback({
      fireAll() {

        const pending = Array.from(timers.values());
        timers.clear();
        pending.forEach((handler) => handler());

      },
      pendingCount() {

        return timers.size;

      },
    });
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }

}

async function withAbortController(AbortControllerClass, callback) {

  const originalAbortController = global.AbortController;
  global.AbortController = AbortControllerClass;
  try {
    return await callback();
  } finally {
    global.AbortController = originalAbortController;
  }

}

async function withUnhandledRejectionTracker(callback) {

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await callback();
    await new Promise((resolve) => setImmediate(resolve));
    return {result, unhandled};
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

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
    'beginPacWorkflow',
    'createPacDownloadState',
    'getFreshPacWorkflowState',
    'getProviderForState',
    'mv3PacArtifacts',
    'mv3PacDownload',
    'mv3State',
    'savePacWorkflowStatePatch',
  ];
  const descriptors = new Map(
      names.map((name) => [name, Object.getOwnPropertyDescriptor(global, name)]),
  );
  const artifactWrites = [];
  const cacheWrites = [];
  const downloadStates = [];
  const existingCookedPacCache = {
    providerKey: provider.key,
    artifactRef: 'cooked:synthetic-existing-artifact',
    cookedPacSha256: 'synthetic-existing-cooked-sha256',
  };
  const workflow = {generation: 1};
  const state = {
    currentPacProviderKey: provider.key,
    pacCache: existingPacCache,
    cookedPacCache: existingCookedPacCache,
    pacWorkflowGeneration: workflow.generation,
  };

  global.beginPacWorkflow = async () => workflow;
  global.createPacDownloadState = (status, value) =>
    Object.assign({status}, value);
  global.getFreshPacWorkflowState = async () => state;
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

      return state;

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
  global.savePacWorkflowStatePatch = async (currentWorkflow, patch) => {
    Chai.expect(currentWorkflow).to.equal(workflow);
    if (patch.pacDownload) {
      downloadStates.push(patch.pacDownload);
    }
    if (patch.pacCache) {
      cacheWrites.push(patch.pacCache);
    }
    Object.assign(state, patch);
    return state;
  };

  try {
    const persisted = await getDownloadPacAndPersist()({
      providerKey: provider.key,
      force: true,
    });
    return {
      artifactWrites,
      cacheWrites,
      downloadStates,
      existingCookedPacCache,
      persisted,
    };
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
      createResponse('file:///temporary/proxy.pac', {
        tracker,
        stream: createControlledBody([encodeText(PAC_TEXT)], tracker),
      }),
    ], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider(['https://origin.example/proxy.pac']),
      );

      Chai.expect(result.error).to.have.property(
          'code',
          'PAC_RESPONSE_URL_REJECTED',
      );
      Chai.expect(tracker.textCalls || 0).to.equal(0);
      Chai.expect(tracker.getReaderCalls || 0).to.equal(0);
      Chai.expect(tracker.bodyCancelCalls).to.equal(1);
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

  Mocha.it('rejects 304 without a reusable raw artifact',
      async function() {

        const tracker = {};
        const requestedUrl = 'https://not-modified.example/proxy.pac';
        const response = createResponse(requestedUrl, {
          status: 304,
        });
        await withFakeTimers(async function(clock) {
          await withResponses([response], async function() {
            const result = await global.mv3PacDownload.downloadPac(
                createCustomProvider([requestedUrl]),
            );

            Chai.expect(result).to.deep.include({
              ok: false,
              status: 'error',
            });
            Chai.expect(result.error).to.deep.equal({
              code: 'PAC_CACHE_MISSING',
              message: 'PAC server returned 304 without a reusable raw artifact.',
              details: null,
            });
            Chai.expect(result).not.to.have.property('sha256');
            Chai.expect(tracker.getReaderCalls || 0).to.equal(0);
            Chai.expect(clock.pendingCount()).to.equal(0);
          });
        });

      });

  Mocha.it('accepts 304 only with a provider-matched raw artifact identity',
      async function() {

        const requestedUrl = 'https://not-modified.example/proxy.pac';
        const provider = createCustomProvider([requestedUrl]);
        const cache = createReusableCache(provider.key, requestedUrl);
        const response = createResponse(requestedUrl, {status: 304});

        await withFakeTimers(async function(clock) {
          await withResponses([response], async function(calls) {
            const result = await global.mv3PacDownload.downloadPac(
                provider,
                cache,
            );

            Chai.expect(result).to.include({
              ok: true,
              status: 'not_modified',
              httpStatus: 304,
            });
            Chai.expect(calls[0].options.headers['If-None-Match'])
                .to.equal(cache.etag);
            Chai.expect(clock.pendingCount()).to.equal(0);
          });
        });

      });

  Mocha.it('times out and cancels a streamed body that never completes',
      async function() {

        const tracker = {};
        const bodyGate = createReadGate(encodeText(PAC_TEXT));
        const requestedUrl = 'https://stream-timeout.example/proxy.pac';
        const existingPacCache = createReusableCache(
            'custom:redirect-test-provider',
        );
        const response = createResponse(requestedUrl, {
          stream: createControlledBody([bodyGate], tracker),
        });

        await withFakeTimers(async function(clock) {
          await withResponses([response], async function() {
            const pending = global.mv3PacDownload.downloadPac(
                createCustomProvider([requestedUrl]),
            );
            await bodyGate.started;
            clock.fireAll();
            const result = await pending;
            const flow = await runPersistenceFlow(result, existingPacCache);

            Chai.expect(result.error).to.deep.equal({
              code: 'PAC_TIMEOUT',
              message: 'PAC download timed out.',
              details: null,
            });
            Chai.expect(result).not.to.have.property('rawPacData');
            Chai.expect(result).not.to.have.property('sha256');
            Chai.expect(tracker.readerCancelCalls).to.equal(1);
            Chai.expect(tracker.releaseLockCalls).to.equal(1);
            Chai.expect(flow.artifactWrites).to.deep.equal([]);
            Chai.expect(flow.cacheWrites).to.deep.equal([]);
            Chai.expect(flow.existingCookedPacCache.cookedPacSha256)
                .to.equal('synthetic-existing-cooked-sha256');
            Chai.expect(flow.downloadStates.map((state) => state.status))
                .to.deep.equal(['downloading', 'error']);
            Chai.expect(clock.pendingCount()).to.equal(0);
          });
        });

      });

  Mocha.it('times out between streamed body chunks', async function() {

    const tracker = {};
    const remainderGate = createReadGate(encodeText('URL() { return "DIRECT"; }'));
    const requestedUrl = 'https://stream-pause.example/proxy.pac';
    const response = createResponse(requestedUrl, {
      stream: createControlledBody([
        encodeText('function FindProxyFor'),
        remainderGate,
      ], tracker),
    });

    await withFakeTimers(async function(clock) {
      await withResponses([response], async function() {
        const pending = global.mv3PacDownload.downloadPac(
            createCustomProvider([requestedUrl]),
        );
        await remainderGate.started;
        clock.fireAll();
        const result = await pending;

        Chai.expect(result.error).to.have.property('code', 'PAC_TIMEOUT');
        Chai.expect(tracker.readerCancelCalls).to.equal(1);
      });
    });

  });

  Mocha.it('keeps a reader rejection sanitized and permits a later download',
      async function() {

        const tracker = {};
        const requestedUrl = 'https://reader-rejection.example/proxy.pac';
        await withResponses([
          createResponse(requestedUrl, {
            stream: createControlledBody([
              new Error('synthetic reader failure'),
            ], tracker, {
              releaseLockError: new Error('synthetic release failure'),
            }),
          }),
          createResponse(requestedUrl),
        ], async function() {
          const rejected = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );
          const recovered = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect(rejected.error).to.deep.equal({
            code: 'PAC_DOWNLOAD_FAILED',
            message: 'PAC download failed.',
            details: null,
          });
          Chai.expect(JSON.stringify(rejected))
              .not.to.include('synthetic reader failure');
          Chai.expect(JSON.stringify(rejected))
              .not.to.include('synthetic release failure');
          Chai.expect(tracker.readerCancelCalls).to.equal(1);
          Chai.expect(tracker.releaseLockCalls).to.equal(1);
          Chai.expect(recovered).to.include({ok: true, status: 'success'});
        });

      });

  Mocha.it('keeps timeout primary when reader cancellation rejects',
      async function() {

        const tracker = {};
        const bodyGate = createReadGate(encodeText(PAC_TEXT));
        const requestedUrl = 'https://cancel-rejection.example/proxy.pac';
        await withFakeTimers(async function(clock) {
          const tracked = await withUnhandledRejectionTracker(
              async function() {

                return withResponses([
                  createResponse(requestedUrl, {
                    stream: createControlledBody([bodyGate], tracker, {
                      readerCancelError: new Error(
                          'synthetic cancellation failure',
                      ),
                    }),
                  }),
                  createResponse(requestedUrl),
                ], async function() {
                  const pending = global.mv3PacDownload.downloadPac(
                      createCustomProvider([requestedUrl]),
                  );
                  await bodyGate.started;
                  clock.fireAll();
                  const rejected = await pending;
                  const recovered = await global.mv3PacDownload.downloadPac(
                      createCustomProvider([requestedUrl]),
                  );
                  return {rejected, recovered};
                });

              },
          );

          Chai.expect(tracked.result.rejected.error).to.have.property(
              'code',
              'PAC_TIMEOUT',
          );
          Chai.expect(JSON.stringify(tracked.result.rejected))
              .not.to.include('synthetic cancellation failure');
          Chai.expect(tracker.readerCancelCalls).to.equal(1);
          Chai.expect(tracked.result.recovered)
              .to.include({ok: true, status: 'success'});
          Chai.expect(tracked.unhandled).to.deep.equal([]);
          Chai.expect(clock.pendingCount()).to.equal(0);
        });

      });

  Mocha.it('keeps timeout primary when abort cleanup rejects',
      async function() {

        class RejectingAbortController {

          constructor() {

            this.signal = {aborted: false};

          }

          abort() {

            this.signal.aborted = true;
            return Promise.reject(new Error('synthetic abort failure'));

          }

        }

        const tracker = {};
        const bodyGate = createReadGate(encodeText(PAC_TEXT));
        const requestedUrl = 'https://abort-rejection.example/proxy.pac';
        await withAbortController(
            RejectingAbortController,
            async function() {

              await withFakeTimers(async function(clock) {
                const tracked = await withUnhandledRejectionTracker(
                    async function() {

                      return withResponses([
                        createResponse(requestedUrl, {
                          stream: createControlledBody([bodyGate], tracker),
                        }),
                      ], async function() {
                        const pending = global.mv3PacDownload.downloadPac(
                            createCustomProvider([requestedUrl]),
                        );
                        await bodyGate.started;
                        clock.fireAll();
                        return pending;
                      });

                    },
                );

                Chai.expect(tracked.result.error).to.have.property(
                    'code',
                    'PAC_TIMEOUT',
                );
                Chai.expect(JSON.stringify(tracked.result))
                    .not.to.include('synthetic abort failure');
                Chai.expect(tracked.unhandled).to.deep.equal([]);
                Chai.expect(clock.pendingCount()).to.equal(0);
              });

            },
        );

      });

  Mocha.it('honors timeout after the final chunk before validation',
      async function() {

        const tracker = {};
        const requestedUrl = 'https://final-chunk-timeout.example/proxy.pac';
        await withFakeTimers(async function(clock) {
          const stream = createControlledBody(
              [encodeText(PAC_TEXT)],
              tracker,
              {
                onRead(readCalls) {

                  if (readCalls === 2) {
                    clock.fireAll();
                  }

                },
              },
          );
          await withResponses([
            createResponse(requestedUrl, {stream}),
          ], async function() {
            const result = await global.mv3PacDownload.downloadPac(
                createCustomProvider([requestedUrl]),
            );

            Chai.expect(result.error).to.have.property('code', 'PAC_TIMEOUT');
            Chai.expect(result).not.to.have.property('rawPacData');
            Chai.expect(result).not.to.have.property('sha256');
            Chai.expect(tracker.readerCancelCalls).to.equal(1);
            Chai.expect(clock.pendingCount()).to.equal(0);
          });
        });

      });

  Mocha.it('rejects oversized chunked data without a declared length',
      async function() {

        const tracker = {};
        const existingPacCache = {
          providerKey: 'custom:redirect-test-provider',
          artifactRef: 'raw:existing-valid-artifact',
          rawPacSha256: 'existing-valid-sha256',
        };
        const requestedUrl = 'https://chunked-size.example/proxy.pac';
        const response = createResponse(requestedUrl, {
          stream: createControlledBody([
            createPacBytes(global.mv3PacDownload.MAX_PAC_BYTES),
            new Uint8Array([32]),
          ], tracker),
        });
        let rejected;
        await withResponses([response], async function() {
          rejected = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );
        });
        const flow = await runPersistenceFlow(rejected, existingPacCache);

        Chai.expect(rejected.error).to.deep.equal({
          code: 'PAC_TOO_LARGE',
          message: 'PAC response is larger than the MV3 cache limit.',
          details: {
            contentLength: global.mv3PacDownload.MAX_PAC_BYTES + 1,
            maxPacBytes: global.mv3PacDownload.MAX_PAC_BYTES,
          },
        });
        Chai.expect(rejected).not.to.have.property('rawPacData');
        Chai.expect(tracker.readerCancelCalls).to.equal(1);
        Chai.expect(flow.artifactWrites).to.deep.equal([]);
        Chai.expect(flow.cacheWrites).to.deep.equal([]);
        Chai.expect(flow.persisted).to.deep.include({
          ok: false,
          status: 'error',
        });
        Chai.expect(existingPacCache.rawPacSha256)
            .to.equal('existing-valid-sha256');
      });

  Mocha.it('rejects a false small length when actual bytes exceed the limit',
      async function() {

        const tracker = {};
        const requestedUrl = 'https://false-size.example/proxy.pac';
        const response = createResponse(requestedUrl, {
          headers: {'Content-Length': '1'},
          stream: createControlledBody([
            createPacBytes(global.mv3PacDownload.MAX_PAC_BYTES + 1),
          ], tracker),
        });
        await withResponses([response], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect(result.error).to.have.property('code', 'PAC_TOO_LARGE');
          Chai.expect(result.error.details.contentLength)
              .to.equal(global.mv3PacDownload.MAX_PAC_BYTES + 1);
          Chai.expect(tracker.readerCancelCalls).to.equal(1);
        });

      });

  Mocha.it('rejects a declared oversized body before acquiring a reader',
      async function() {

        const tracker = {};
        const requestedUrl = 'https://declared-size.example/proxy.pac';
        const response = createResponse(requestedUrl, {
          headers: {
            'Content-Length': String(
                global.mv3PacDownload.MAX_PAC_BYTES + 1,
            ),
          },
          stream: createControlledBody(
              [encodeText(PAC_TEXT)],
              tracker,
              {
                bodyCancelError: new Error('synthetic body cancel failure'),
              },
          ),
        });
        const tracked = await withUnhandledRejectionTracker(async function() {

          return withResponses([response], async function() {
            return global.mv3PacDownload.downloadPac(
                createCustomProvider([requestedUrl]),
            );
          });

        });

        Chai.expect(tracked.result.error)
            .to.have.property('code', 'PAC_TOO_LARGE');
        Chai.expect(JSON.stringify(tracked.result))
            .not.to.include('synthetic body cancel failure');
        Chai.expect(tracker.getReaderCalls || 0).to.equal(0);
        Chai.expect(tracker.bodyCancelCalls).to.equal(1);
        Chai.expect(tracked.unhandled).to.deep.equal([]);

      });

  Mocha.it('accepts multibyte content exactly at the byte limit',
      async function() {

        const requestedUrl = 'https://exact-size.example/proxy.pac';
        const bytes = createPacBytesWithMultibyte(
            global.mv3PacDownload.MAX_PAC_BYTES,
        );
        const tracker = {};
        const response = createResponse(requestedUrl, {
          stream: createControlledBody([
            bytes.subarray(0, 17),
            bytes.subarray(17),
          ], tracker),
        });
        await withResponses([response], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect({
            ok: result.ok,
            status: result.status,
            contentLength: result.contentLength,
          }).to.deep.equal({
            ok: true,
            status: 'success',
            contentLength: global.mv3PacDownload.MAX_PAC_BYTES,
          });
          Chai.expect(
              Boolean(
                  result.rawPacData &&
                  result.rawPacData.startsWith('function FindProxyForURL') &&
                  result.rawPacData.endsWith('Ж'),
              ),
          ).to.equal(true);
          Chai.expect(tracker.releaseLockCalls).to.equal(1);
        });

      });

  Mocha.it('rejects multibyte content one byte over the byte limit',
      async function() {

        const requestedUrl = 'https://one-byte-over.example/proxy.pac';
        const response = createResponse(requestedUrl, {
          stream: createControlledBody([
            createPacBytesWithMultibyte(
                global.mv3PacDownload.MAX_PAC_BYTES + 1,
            ),
          ]),
        });
        await withResponses([response], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect(result.error).to.deep.equal({
            code: 'PAC_TOO_LARGE',
            message: 'PAC response is larger than the MV3 cache limit.',
            details: {
              contentLength: global.mv3PacDownload.MAX_PAC_BYTES + 1,
              maxPacBytes: global.mv3PacDownload.MAX_PAC_BYTES,
            },
          });
        });

      });

  Mocha.it('decodes multi-byte UTF-8 split across chunk boundaries',
      async function() {

        const requestedUrl = 'https://utf8-split.example/proxy.pac';
        const prefix = `${PAC_TEXT}\n// `;
        const suffix = ' split';
        const multiByte = encodeText('Ж');
        const expected = `${prefix}Ж${suffix}`;
        const response = createResponse(requestedUrl, {
          stream: createControlledBody([
            encodeText(prefix),
            multiByte.subarray(0, 1),
            multiByte.subarray(1),
            encodeText(suffix),
          ]),
        });
        await withResponses([response], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect(result).to.include({ok: true, status: 'success'});
          Chai.expect(result.rawPacData === expected).to.equal(true);
          Chai.expect(result.contentLength).to.equal(encodeText(expected).byteLength);
        });

      });

  Mocha.it('rejects an incomplete multibyte sequence at EOF',
      async function() {

        const tracker = {};
        const requestedUrl = 'https://utf8-incomplete.example/proxy.pac';
        const bytes = createPacWithByteSuffix([0xe2, 0x82]);
        const existingPacCache = createReusableCache(
            'custom:redirect-test-provider',
        );
        let rejected;
        await withResponses([
          createResponse(requestedUrl, {
            stream: createControlledBody([
              bytes.subarray(0, bytes.byteLength - 1),
              bytes.subarray(bytes.byteLength - 1),
            ], tracker),
          }),
        ], async function() {
          rejected = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );
        });
        const flow = await runPersistenceFlow(rejected, existingPacCache);

        Chai.expect(rejected.error).to.deep.equal({
          code: 'PAC_INVALID_UTF8',
          message: 'PAC response is not valid UTF-8.',
          details: null,
        });
        Chai.expect(rejected).not.to.have.property('rawPacData');
        Chai.expect(rejected).not.to.have.property('sha256');
        Chai.expect(tracker.releaseLockCalls).to.equal(1);
        Chai.expect(flow.artifactWrites).to.deep.equal([]);
        Chai.expect(flow.cacheWrites).to.deep.equal([]);
        Chai.expect(existingPacCache.rawPacSha256)
            .to.equal('synthetic-existing-sha256');
        Chai.expect(flow.existingCookedPacCache).to.deep.equal({
          providerKey: 'custom:redirect-test-provider',
          artifactRef: 'cooked:synthetic-existing-artifact',
          cookedPacSha256: 'synthetic-existing-cooked-sha256',
        });
        Chai.expect(flow.downloadStates.map((state) => state.status))
            .to.deep.equal(['downloading', 'error']);
      });

  Mocha.it('rejects malformed UTF-8 continuation bytes', async function() {

    const tracker = {};
    const requestedUrl = 'https://utf8-malformed.example/proxy.pac';
    const bytes = createPacWithByteSuffix([0xe2, 0x28, 0xa1]);
    await withResponses([
      createResponse(requestedUrl, {
        stream: createControlledBody([bytes], tracker),
      }),
    ], async function() {
      const result = await global.mv3PacDownload.downloadPac(
          createCustomProvider([requestedUrl]),
      );

      Chai.expect(result.error).to.deep.equal({
        code: 'PAC_INVALID_UTF8',
        message: 'PAC response is not valid UTF-8.',
        details: null,
      });
      Chai.expect(result).not.to.have.property('rawPacData');
      Chai.expect(result).not.to.have.property('sha256');
      Chai.expect(tracker.readerCancelCalls).to.equal(1);
    });

  });

  Mocha.it('continues to the next fallback after a body timeout',
      async function() {

        const bodyGate = createReadGate(encodeText(PAC_TEXT));
        const firstUrl = 'https://slow-fallback.example/proxy.pac';
        const secondUrl = 'https://valid-fallback.example/proxy.pac';
        await withFakeTimers(async function(clock) {
          await withResponses([
            createResponse(firstUrl, {
              stream: createControlledBody([bodyGate]),
            }),
            createResponse(secondUrl, {
              stream: createControlledBody([encodeText(PAC_TEXT)]),
            }),
          ], async function(calls) {
            const pending = global.mv3PacDownload.downloadPac(
                createCustomProvider([firstUrl, secondUrl]),
            );
            await bodyGate.started;
            clock.fireAll();
            const result = await pending;

            Chai.expect(calls.map((call) => call.url))
                .to.deep.equal([firstUrl, secondUrl]);
            Chai.expect(calls[0].options.signal)
                .not.to.equal(calls[1].options.signal);
            Chai.expect(result).to.include({
              ok: true,
              status: 'success',
              url: secondUrl,
            });
            Chai.expect(clock.pendingCount()).to.equal(0);
          });
        });

      });

  Mocha.it('continues to the next fallback after invalid UTF-8',
      async function() {

        const firstUrl = 'https://invalid-utf8-fallback.example/proxy.pac';
        const secondUrl = 'https://valid-utf8-fallback.example/proxy.pac';
        const malformed = createPacWithByteSuffix([0xe2, 0x28, 0xa1]);
        await withResponses([
          createResponse(firstUrl, {
            stream: createControlledBody([malformed]),
          }),
          createResponse(secondUrl),
        ], async function(calls) {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([firstUrl, secondUrl]),
          );

          Chai.expect(calls.map((call) => call.url))
              .to.deep.equal([firstUrl, secondUrl]);
          Chai.expect(result).to.include({
            ok: true,
            status: 'success',
            url: secondUrl,
          });
        });

      });

  Mocha.it('returns one sanitized failure after every fallback is rejected',
      async function() {

        const firstUrl = [
          'https://first-failure.example/proxy.pac',
          '?token=first-private#first-fragment',
        ].join('');
        const secondUrl = [
          'https://second-failure.example/proxy.pac',
          '?token=second-private#second-fragment',
        ].join('');
        const oversizedHeaders = {
          'Content-Length': String(global.mv3PacDownload.MAX_PAC_BYTES + 1),
        };
        await withResponses([
          createResponse(firstUrl, {
            headers: oversizedHeaders,
            stream: createControlledBody([encodeText(PAC_TEXT)]),
          }),
          createResponse(secondUrl, {
            headers: oversizedHeaders,
            stream: createControlledBody([encodeText(PAC_TEXT)]),
          }),
        ], async function(calls) {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([firstUrl, secondUrl]),
          );
          const serialized = JSON.stringify(result);

          Chai.expect(calls).to.have.length(2);
          Chai.expect(result).to.deep.include({
            ok: false,
            status: 'error',
            url: null,
          });
          Chai.expect(result.error).to.have.property('code', 'PAC_TOO_LARGE');
          [
            'first-private',
            'first-fragment',
            'second-private',
            'second-fragment',
          ].forEach((secret) => Chai.expect(serialized).not.to.include(secret));
        });

      });

  Mocha.it('rejects response-like objects without a byte stream',
      async function() {

        const requestedUrl = 'https://no-stream.example/proxy.pac';
        const tracker = {};
        await withResponses([
          createResponse(requestedUrl, {
            tracker,
            stream: null,
            async arrayBuffer() {

              tracker.arrayBufferCalls = (tracker.arrayBufferCalls || 0) + 1;
              return encodeText(PAC_TEXT).buffer;

            },
          }),
        ], async function() {
          const result = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect(result.error).to.deep.equal({
            code: 'PAC_BODY_UNAVAILABLE',
            message: 'PAC response body is not available as a byte stream.',
            details: null,
          });
          Chai.expect(tracker.arrayBufferCalls || 0).to.equal(0);
          Chai.expect(tracker.textCalls || 0).to.equal(0);
        });

      });

  Mocha.it('allows a later download after an oversized response',
      async function() {

        const requestedUrl = 'https://recovery.example/proxy.pac';
        const oversizedResponse = createResponse(requestedUrl, {
          headers: {
            'Content-Length': String(
                global.mv3PacDownload.MAX_PAC_BYTES + 1,
            ),
          },
          stream: createControlledBody([encodeText(PAC_TEXT)]),
        });
        const validResponse = createResponse(requestedUrl, {
          stream: createControlledBody([encodeText(PAC_TEXT)]),
        });
        await withResponses([
          oversizedResponse,
          validResponse,
        ], async function() {
          const rejected = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );
          const recovered = await global.mv3PacDownload.downloadPac(
              createCustomProvider([requestedUrl]),
          );

          Chai.expect(rejected.error).to.have.property('code', 'PAC_TOO_LARGE');
          Chai.expect(recovered).to.include({ok: true, status: 'success'});
        });

      });

  Mocha.it('does not let one timed-out stream cancel a concurrent download',
      async function() {

        const slowGate = createReadGate(encodeText(PAC_TEXT));
        const slowUrl = 'https://concurrent-slow.example/proxy.pac';
        const validUrl = 'https://concurrent-valid.example/proxy.pac';
        await withFakeTimers(async function(clock) {
          await withResponses([
            createResponse(slowUrl, {
              stream: createControlledBody([slowGate]),
            }),
            createResponse(validUrl, {
              stream: createControlledBody([encodeText(PAC_TEXT)]),
            }),
          ], async function() {
            const slowDownload = global.mv3PacDownload.downloadPac(
                createCustomProvider([slowUrl]),
            );
            await slowGate.started;
            const validDownload = global.mv3PacDownload.downloadPac(
                createCustomProvider([validUrl]),
            );
            const validResult = await validDownload;
            Chai.expect(clock.pendingCount()).to.equal(1);
            clock.fireAll();
            const slowResult = await slowDownload;

            Chai.expect(validResult).to.include({ok: true, status: 'success'});
            Chai.expect(slowResult.error).to.have.property('code', 'PAC_TIMEOUT');
            Chai.expect(clock.pendingCount()).to.equal(0);
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

  Mocha.it('does not expose a built-in data PAC in a failure', async function() {

    const provider = global.mv3Providers.getProviderByKey('onlyOwnSites');
    await withResponses([
      createResponse(provider.urls[0], {body: 'invalid synthetic PAC'}),
    ], async function() {
      const result = await global.mv3PacDownload.downloadPac(provider);
      const serialized = JSON.stringify(result);

      Chai.expect(result).to.deep.include({
        ok: false,
        status: 'error',
        url: null,
      });
      Chai.expect(result.error).to.have.property('code', 'PAC_INVALID');
      Chai.expect(serialized).not.to.include(provider.urls[0]);
      Chai.expect(serialized).not.to.include('invalid synthetic PAC');
    });

  });

});
