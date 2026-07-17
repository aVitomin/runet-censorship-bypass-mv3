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
