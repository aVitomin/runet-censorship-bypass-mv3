'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const {loadBackgroundModules} = require('./background-modules');

function clone(value) {

  return JSON.parse(JSON.stringify(value));

}

function createStorage({blockReads = false, failedWriteNumbers = []} = {}) {

  let values = {};
  let ifReadsBlocked = blockReads;
  let blockedReads = [];
  let readNumber = 0;
  let writeNumber = 0;
  const failedWrites = new Set(failedWriteNumbers);
  const writes = [];

  function createResult(keysOrDefaults) {

    if (!keysOrDefaults) {
      return clone(values);
    }
    return Object.keys(keysOrDefaults).reduce((result, key) => {
      result[key] = Object.prototype.hasOwnProperty.call(values, key) ?
        clone(values[key]) :
        clone(keysOrDefaults[key]);
      return result;
    }, {});

  }

  return {
    async get(keysOrDefaults) {

      readNumber += 1;
      const result = createResult(keysOrDefaults);
      if (!ifReadsBlocked) {
        return result;
      }
      return new Promise((resolve) => {
        blockedReads.push(() => resolve(result));
      });

    },
    async set(patch) {

      writeNumber += 1;
      if (failedWrites.has(writeNumber)) {
        throw new Error('Synthetic state write failure.');
      }
      values = Object.assign({}, values, clone(patch));
      writes.push(clone(patch.mv3State));

    },
    releaseReads() {

      ifReadsBlocked = false;
      const ready = blockedReads;
      blockedReads = [];
      ready.forEach((release) => release());

    },
    getStoredState() {

      return clone(values.mv3State);

    },
    getReadCount() {

      return readNumber;

    },
    getWrites() {

      return clone(writes);

    },
  };

}

Mocha.describe('MV3 state write serialization', function() {

  Mocha.afterEach(function() {

    delete global.mv3Storage;

  });

  Mocha.it('preserves two concurrent patches to different fields',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const writes = Promise.all([
          global.mv3State.saveStatePatch({uiLanguage: 'en'}),
          global.mv3State.saveStatePatch({lastPacUpdateStamp: 100}),
        ]);
        storage.releaseReads();
        await writes;

        Chai.expect(storage.getStoredState()).to.include({
          uiLanguage: 'en',
          lastPacUpdateStamp: 100,
        });

      });

  Mocha.it('preserves the order of multiple queued patches', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    const states = await Promise.all([
      global.mv3State.saveStatePatch({
        notificationPrefs: {pacError: false},
      }),
      global.mv3State.saveStatePatch({
        notificationPrefs: {extError: false},
      }),
      global.mv3State.saveStatePatch({
        notificationPrefs: {noControl: false},
      }),
    ]);

    Chai.expect(states.map((state) => state.notificationPrefs)).to.deep.equal([
      {pacError: false, extError: true, noControl: true},
      {pacError: false, extError: false, noControl: true},
      {pacError: false, extError: false, noControl: false},
    ]);
    Chai.expect(storage.getStoredState().notificationPrefs).to.deep.equal({
      pacError: false,
      extError: false,
      noControl: false,
    });

  });

  Mocha.it('rejects the caller when its storage write fails', async function() {

    const storage = createStorage({failedWriteNumbers: [1]});
    global.mv3Storage = storage;
    loadBackgroundModules();
    let writeError;

    try {
      await global.mv3State.saveStatePatch({uiLanguage: 'ru'});
    } catch (err) {
      writeError = err;
    }

    Chai.expect(writeError).to.be.an('error').with.property(
        'message',
        'Synthetic state write failure.',
    );

  });

  Mocha.it('continues queued writes after one storage write fails',
      async function() {

        const storage = createStorage({failedWriteNumbers: [1]});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const failed = global.mv3State.saveStatePatch({uiLanguage: 'ru'})
            .catch((err) => err);
        const recovered = global.mv3State.saveStatePatch({
          lastPacUpdateStamp: 200,
        });
        const [writeError, recoveredState] = await Promise.all([
          failed,
          recovered,
        ]);

        Chai.expect(writeError).to.be.an('error');
        Chai.expect(recoveredState.lastPacUpdateStamp).to.equal(200);
        Chai.expect(storage.getStoredState()).to.include({
          uiLanguage: 'auto',
          lastPacUpdateStamp: 200,
        });

      });

  Mocha.it('returns the state committed by the patch', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    const returnedState = await global.mv3State.saveStatePatch({
      uiLanguage: 'en',
    });

    Chai.expect(returnedState).to.deep.equal(storage.getStoredState());
    Chai.expect(returnedState.uiLanguage).to.equal('en');

  });

  Mocha.it('preserves unrelated fields across successful patches',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();

        await global.mv3State.saveStatePatch({uiLanguage: 'en'});
        const returnedState = await global.mv3State.saveStatePatch({
          lastPacUpdateStamp: 300,
        });

        Chai.expect(returnedState).to.include({
          uiLanguage: 'en',
          lastPacUpdateStamp: 300,
        });
        Chai.expect(storage.getStoredState()).to.include({
          uiLanguage: 'en',
          lastPacUpdateStamp: 300,
        });

      });

  Mocha.it('keeps existing single-write wrapper behavior', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    const prefs = await global.mv3State.setNotificationPrefs({
      pacError: false,
    });

    Chai.expect(prefs).to.deep.equal({
      pacError: false,
      extError: true,
      noControl: true,
    });
    Chai.expect(storage.getStoredState().notificationPrefs).to.deep.equal(prefs);

  });

  Mocha.it('batches PAC modifiers and proxy-health reset in one queued write',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();
        await global.mv3State.setProxyHealthState({
          status: 'error',
          lastErrorCode: 'ERR_PROXY_CONNECTION_FAILED',
        });
        const writesBefore = storage.getWrites().length;

        const state = await global.mv3State.savePacMods({
          torBrowser: {enabled: true},
        }, {resetProxyHealth: true});

        Chai.expect(storage.getWrites()).to.have.length(writesBefore + 1);
        Chai.expect(state.pacMods.torBrowser.enabled).to.equal(true);
        Chai.expect(state.proxyHealth).to.include({
          status: 'unknown',
          lastErrorCode: null,
        });
        Chai.expect(state).to.deep.equal(storage.getStoredState());

      });

  Mocha.it('serializes reset with patches in call order', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    await Promise.all([
      global.mv3State.saveStatePatch({uiLanguage: 'en'}),
      global.mv3State.resetState(),
      global.mv3State.saveStatePatch({lastPacUpdateStamp: 400}),
    ]);

    const writes = storage.getWrites();
    Chai.expect(writes[0].uiLanguage).to.equal('en');
    Chai.expect(writes[1].uiLanguage).to.equal('auto');
    Chai.expect(writes[2]).to.include({
      uiLanguage: 'auto',
      lastPacUpdateStamp: 400,
    });
    Chai.expect(storage.getStoredState()).to.include({
      uiLanguage: 'auto',
      lastPacUpdateStamp: 400,
    });

  });

  Mocha.it('orders a state read after an earlier queued patch', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    const patch = global.mv3State.saveStatePatch({uiLanguage: 'ru'});
    const read = global.mv3State.loadState();
    const [, loadedState] = await Promise.all([patch, read]);

    Chai.expect(loadedState.uiLanguage).to.equal('ru');

  });

  Mocha.it('retains concurrent proxy-auth events and counters in call order',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const events = Promise.all([
          global.mv3State.recordProxyAuthEvent({
            type: 'provided',
            at: 100,
            isProxy: true,
          }),
          global.mv3State.recordProxyAuthEvent({
            type: 'provided',
            at: 200,
            isProxy: true,
          }),
        ]);
        storage.releaseReads();
        await events;

        const proxyAuth = storage.getStoredState().proxyAuth;
        Chai.expect(proxyAuth.stats).to.include({
          challenges: 2,
          provided: 2,
        });
        Chai.expect(proxyAuth.lastEvents.map((event) => event.at))
            .to.deep.equal([100, 200]);

      });

  Mocha.it('trims concurrent proxy-auth events deterministically',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const events = Promise.all(new Array(22).fill(null).map((unused, index) =>
          global.mv3State.recordProxyAuthEvent({
            type: 'provided',
            at: index + 1,
            isProxy: true,
          }),
        ));
        storage.releaseReads();
        await events;

        const proxyAuth = storage.getStoredState().proxyAuth;
        Chai.expect(proxyAuth.stats).to.include({
          challenges: 22,
          provided: 22,
        });
        Chai.expect(proxyAuth.lastEvents.map((event) => event.at))
            .to.deep.equal(new Array(20).fill(null).map((unused, index) =>
              index + 3,
            ));

      });

  Mocha.it('lets an auth reset queued after an event clear that event',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const event = global.mv3State.recordProxyAuthEvent({
          type: 'provided',
          at: 100,
          isProxy: true,
        });
        const reset = global.mv3State.resetProxyAuthState();
        storage.releaseReads();
        await Promise.all([event, reset]);

        const proxyAuth = storage.getStoredState().proxyAuth;
        Chai.expect(proxyAuth.stats).to.include({
          challenges: 0,
          provided: 0,
        });
        Chai.expect(proxyAuth.lastEvents).to.deep.equal([]);

      });

  Mocha.it('keeps two concurrent atomic increments', async function() {

    const storage = createStorage({blockReads: true});
    global.mv3Storage = storage;
    loadBackgroundModules();

    const increments = Promise.all([
      global.mv3State.updateStateAtomically((state) => ({
        lastPacUpdateStamp: (state.lastPacUpdateStamp || 0) + 1,
      })),
      global.mv3State.updateStateAtomically((state) => ({
        lastPacUpdateStamp: (state.lastPacUpdateStamp || 0) + 1,
      })),
    ]);
    storage.releaseReads();
    const states = await increments;

    Chai.expect(states.map((state) => state.lastPacUpdateStamp))
        .to.deep.equal([1, 2]);
    Chai.expect(storage.getStoredState().lastPacUpdateStamp).to.equal(2);
    Chai.expect(storage.getReadCount()).to.equal(2);
    Chai.expect(storage.getWrites()).to.have.length(2);

  });

  Mocha.it('retains two atomic array appends in call order', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    await Promise.all([
      global.mv3State.updateStateAtomically((state) => ({
        legacyMigration: {
          warnings: state.legacyMigration.warnings.concat('first'),
        },
      })),
      global.mv3State.updateStateAtomically((state) => ({
        legacyMigration: {
          warnings: state.legacyMigration.warnings.concat('second'),
        },
      })),
    ]);

    Chai.expect(storage.getStoredState().legacyMigration.warnings)
        .to.deep.equal(['first', 'second']);

  });

  Mocha.it('preserves concurrent fields in the same nested state object',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const updates = Promise.all([
          global.mv3State.updateStateAtomically(() => ({
            periodicUpdate: {status: 'running'},
          })),
          global.mv3State.updateStateAtomically(() => ({
            periodicUpdate: {intervalMinutes: 60},
          })),
        ]);
        storage.releaseReads();
        await updates;

        Chai.expect(storage.getStoredState().periodicUpdate).to.include({
          status: 'running',
          intervalMinutes: 60,
          enabled: true,
        });

      });

  Mocha.it('orders an atomic remove before a later append', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();
    await global.mv3State.saveStatePatch({
      legacyMigration: {warnings: ['remove-me', 'keep-me']},
    });

    await Promise.all([
      global.mv3State.updateStateAtomically((state) => ({
        legacyMigration: {
          warnings: state.legacyMigration.warnings.filter(
              (warning) => warning !== 'remove-me',
          ),
        },
      })),
      global.mv3State.updateStateAtomically((state) => ({
        legacyMigration: {
          warnings: state.legacyMigration.warnings.concat('append-me'),
        },
      })),
    ]);

    Chai.expect(storage.getStoredState().legacyMigration.warnings)
        .to.deep.equal(['keep-me', 'append-me']);

  });

  Mocha.it('orders an atomic append before a later remove', async function() {

    const storage = createStorage({blockReads: true});
    global.mv3Storage = storage;
    loadBackgroundModules();

    const operations = Promise.all([
      global.mv3State.updateStateAtomically((state) => ({
        legacyMigration: {
          warnings: state.legacyMigration.warnings.concat('remove-me'),
        },
      })),
      global.mv3State.updateStateAtomically((state) => ({
        legacyMigration: {
          warnings: state.legacyMigration.warnings.filter(
              (warning) => warning !== 'remove-me',
          ),
        },
      })),
    ]);
    storage.releaseReads();
    await operations;

    Chai.expect(storage.getStoredState().legacyMigration.warnings)
        .to.deep.equal([]);

  });

  Mocha.it('derives from an explicit patch queued before it executes',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const explicit = global.mv3State.saveStatePatch({
          lastPacUpdateStamp: 40,
        });
        const derived = global.mv3State.updateStateAtomically((state) => ({
          lastPacUpdateStamp: state.lastPacUpdateStamp + 2,
        }));
        storage.releaseReads();
        const [, derivedState] = await Promise.all([explicit, derived]);

        Chai.expect(derivedState.lastPacUpdateStamp).to.equal(42);
        Chai.expect(storage.getStoredState().lastPacUpdateStamp).to.equal(42);

      });

  Mocha.it('returns a later explicit patch with the earlier derived state',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();

        const derived = global.mv3State.updateStateAtomically(() => ({
          lastPacUpdateStamp: 50,
        }));
        const explicit = global.mv3State.saveStatePatch({uiLanguage: 'ru'});
        const [, explicitState] = await Promise.all([derived, explicit]);

        Chai.expect(explicitState).to.include({
          lastPacUpdateStamp: 50,
          uiLanguage: 'ru',
        });

      });

  Mocha.it('rejects a failed atomic write and continues the queue',
      async function() {

        const storage = createStorage({failedWriteNumbers: [1]});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const failed = global.mv3State.updateStateAtomically(() => ({
          lastPacUpdateStamp: 60,
        })).catch((err) => err);
        const recovered = global.mv3State.updateStateAtomically((state) => ({
          lastPacUpdateStamp: (state.lastPacUpdateStamp || 0) + 1,
        }));
        const [error, recoveredState] = await Promise.all([failed, recovered]);

        Chai.expect(error).to.be.an('error').with.property(
            'message',
            'Synthetic state write failure.',
        );
        Chai.expect(recoveredState.lastPacUpdateStamp).to.equal(1);
        Chai.expect(storage.getStoredState().lastPacUpdateStamp).to.equal(1);

      });

  Mocha.it('continues atomic and explicit operations after an atomic failure',
      async function() {

        const storage = createStorage({failedWriteNumbers: [1]});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const failed = global.mv3State.updateStateAtomically(() => ({
          lastPacUpdateStamp: 60,
        })).catch((err) => err);
        const atomic = global.mv3State.updateStateAtomically((state) => ({
          lastPacUpdateStamp: state.lastPacUpdateStamp + 2,
        }));
        const explicit = global.mv3State.saveStatePatch({uiLanguage: 'ru'});
        const [error, atomicState, explicitState] = await Promise.all([
          failed,
          atomic,
          explicit,
        ]);

        Chai.expect(error).to.be.an('error');
        Chai.expect(atomicState.lastPacUpdateStamp).to.equal(2);
        Chai.expect(explicitState).to.include({
          lastPacUpdateStamp: 2,
          uiLanguage: 'ru',
        });

      });

  Mocha.it('preserves unrelated fields and returns the committed atomic state',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();
        await global.mv3State.saveStatePatch({uiLanguage: 'en'});

        const committed = await global.mv3State.updateStateAtomically(() => ({
          lastPacUpdateStamp: 70,
        }));

        Chai.expect(committed).to.deep.equal(storage.getStoredState());
        Chai.expect(committed).to.include({
          uiLanguage: 'en',
          lastPacUpdateStamp: 70,
        });

      });

  Mocha.it('does not write an explicit atomic no-op', async function() {

    const storage = createStorage();
    global.mv3Storage = storage;
    loadBackgroundModules();

    const state = await global.mv3State.updateStateAtomically(
        () => global.mv3State.ATOMIC_NO_CHANGE,
    );

    Chai.expect(state.uiLanguage).to.equal('auto');
    Chai.expect(storage.getReadCount()).to.equal(1);
    Chai.expect(storage.getWrites()).to.have.length(0);

  });

  Mocha.it('rejects nested and asynchronous atomic mutators without deadlock',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();

        const nested = await global.mv3State.updateStateAtomically(() => {
          global.mv3State.loadState();
          return {lastPacUpdateStamp: 80};
        }).catch((err) => err);
        let ifAsyncMutatorRan = false;
        const asynchronous = await global.mv3State.updateStateAtomically(
            async () => {

              ifAsyncMutatorRan = true;
              return {lastPacUpdateStamp: 81};

            },
        ).catch((err) => err);
        const recovered = await global.mv3State.updateStateAtomically(() => ({
          lastPacUpdateStamp: 82,
        }));

        Chai.expect(nested).to.be.an('error').with.property(
            'message',
            'State APIs cannot be called from an atomic state mutator.',
        );
        Chai.expect(asynchronous).to.be.an('error').with.property(
            'message',
            'atomic state mutator must return synchronously.',
        );
        Chai.expect(ifAsyncMutatorRan).to.equal(false);
        Chai.expect(recovered.lastPacUpdateStamp).to.equal(82);
        Chai.expect(storage.getWrites()).to.have.length(1);

      });

  Mocha.it('isolates mutator inputs, patches, and returned states',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();
        const callerPatch = {notificationPrefs: {pacError: false}};
        let mutationError;

        const committed = await global.mv3State.updateStateAtomically((state) => {
          try {
            state.notificationPrefs.pacError = false;
          } catch (err) {
            mutationError = err;
          }
          return callerPatch;
        });
        callerPatch.notificationPrefs.pacError = true;
        committed.notificationPrefs.extError = false;
        const durable = await global.mv3State.loadState();

        Chai.expect(mutationError).to.be.an('error');
        Chai.expect(durable.notificationPrefs).to.deep.equal({
          pacError: false,
          extError: true,
          noControl: true,
        });

      });

  Mocha.it('normalizes atomic patches and rejects ambiguous results',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();

        const normalized = await global.mv3State.updateStateAtomically(() => ({
          uiLanguage: 'unsupported',
        }));
        const empty = await global.mv3State.updateStateAtomically(() => ({}))
            .catch((err) => err);
        const invalid = await global.mv3State.updateStateAtomically(
            () => ({unknownStateField: true}),
        ).catch((err) => err);
        const fullState = await global.mv3State.updateStateAtomically(
            (state) => Object.assign({}, state),
        ).catch((err) => err);
        class AtomicPatch {
          constructor() {

            this.uiLanguage = 'en';

          }
        }
        const classPatch = await global.mv3State.updateStateAtomically(
            () => new AtomicPatch(),
        ).catch((err) => err);
        const thenable = await global.mv3State.updateStateAtomically(() =>
          Promise.resolve({uiLanguage: 'en'}),
        ).catch((err) => err);

        Chai.expect(normalized.uiLanguage).to.equal('auto');
        Chai.expect(empty).to.be.an('error');
        Chai.expect(invalid).to.be.an('error');
        Chai.expect(fullState).to.be.an('error').with.property(
            'message',
            'atomic state mutator must return a patch, not complete state.',
        );
        Chai.expect(classPatch).to.be.an('error').with.property(
            'message',
            'atomic state patch must be a plain object.',
        );
        Chai.expect(thenable).to.be.an('error').with.property(
            'message',
            'atomic state mutator must return synchronously.',
        );
        Chai.expect(storage.getWrites()).to.have.length(1);

      });

  Mocha.it('reconstructs atomic state after a worker module reload',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();
        await global.mv3State.updateStateAtomically(() => ({
          lastPacUpdateStamp: 90,
        }));

        loadBackgroundModules();
        const reloaded = await global.mv3State.loadState();

        Chai.expect(reloaded.lastPacUpdateStamp).to.equal(90);

      });

  Mocha.it('retains concurrent periodic events in call order', async function() {

    const storage = createStorage({blockReads: true});
    global.mv3Storage = storage;
    loadBackgroundModules();

    const events = Promise.all([
      global.mv3State.recordPeriodicUpdateEvent({
        type: 'first',
        at: 100,
      }),
      global.mv3State.recordPeriodicUpdateEvent({
        type: 'second',
        at: 200,
      }),
    ]);
    storage.releaseReads();
    await events;

    Chai.expect(storage.getStoredState().periodicUpdate.lastEvents)
        .to.deep.include.members([
          {type: 'first', at: 100, trigger: null, providerKey: null,
            status: null, message: null, error: null},
          {type: 'second', at: 200, trigger: null, providerKey: null,
            status: null, message: null, error: null},
        ]);
    Chai.expect(storage.getStoredState().periodicUpdate.lastEvents
        .map((event) => event.at)).to.deep.equal([100, 200]);

  });

  Mocha.it('orders auth reset with a later explicit enable change',
      async function() {

        const storage = createStorage({blockReads: true});
        global.mv3Storage = storage;
        loadBackgroundModules();

        const reset = global.mv3State.resetProxyAuthState();
        const disable = global.mv3State.setProxyAuthEnabled(false);
        storage.releaseReads();
        await Promise.all([reset, disable]);

        Chai.expect(storage.getStoredState().proxyAuth).to.include({
          enabled: false,
          status: 'idle',
        });

      });

  Mocha.it('does not deadlock a helper that reads before writing',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();

        const proxyAuth = await global.mv3State.resetProxyAuthState();

        Chai.expect(proxyAuth).to.include({enabled: true, status: 'ready'});

      });

  Mocha.it('reloads committed state without an in-memory snapshot',
      async function() {

        const storage = createStorage();
        global.mv3Storage = storage;
        loadBackgroundModules();
        await global.mv3State.saveStatePatch({uiLanguage: 'en'});

        loadBackgroundModules();
        const reloadedState = await global.mv3State.loadState();

        Chai.expect(reloadedState.uiLanguage).to.equal('en');

      });

});
