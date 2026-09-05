'use strict';
/* global require */

(function publishFirefoxProxyControl(root, factory) {

  const offState = typeof module === 'object' && module.exports ?
    require('./off-state') : root.rucbFirefoxOffState;
  const api = factory(offState, root.crypto);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxProxyControl = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(OffState, defaultCrypto) {

      const CONTROLLED_BY_THIS_EXTENSION = 'controlled_by_this_extension';
      const RESULTS = Object.freeze({
        ACQUIRED: 'ACQUIRED',
        ALREADY_CLEAR: 'ALREADY_CLEAR',
        CLEARED: 'CLEARED',
        OWNED: 'OWNED',
      });
      const ERRORS = Object.freeze({
        EPHEMERAL_CLEAR_FAILED: 'EPHEMERAL_CLEAR_FAILED',
        FLOOR_IDENTITY_PERSIST_FAILED: 'FLOOR_IDENTITY_PERSIST_FAILED',
        INVALID_FLOOR_IDENTITY: 'INVALID_FLOOR_IDENTITY',
        OWNERSHIP_MISMATCH: 'OWNERSHIP_MISMATCH',
        PORT_PREVALIDATION_REQUIRED: 'PORT_PREVALIDATION_REQUIRED',
        PRIVATE_ACCESS_CHECK_FAILED: 'PRIVATE_ACCESS_CHECK_FAILED',
        PRIVATE_ACCESS_REQUIRED: 'PRIVATE_ACCESS_REQUIRED',
        PROXY_CLEAR_FAILED: 'PROXY_CLEAR_FAILED',
        PROXY_READ_FAILED: 'PROXY_READ_FAILED',
        PROXY_SET_FAILED: 'PROXY_SET_FAILED',
        RELEASE_NOT_CONFIRMED: 'RELEASE_NOT_CONFIRMED',
        STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
      });

      function errorResult(code, durableState) {

        const result = {ok: false, error: {code}};
        if (durableState) {
          result.durableState = durableState;
        }
        return result;

      }

      function successResult(status, durableState) {

        return {ok: true, status, durableState};

      }

      function canonicalizeFloorIdentity(value) {

        return OffState.canonicalizeFloorIdentity(value);

      }

      function sameFloorIdentity(left, right) {

        const canonicalLeft = canonicalizeFloorIdentity(left);
        const canonicalRight = canonicalizeFloorIdentity(right);
        if (!canonicalLeft || !canonicalRight) {
          return false;
        }
        return OffState.FLOOR_KEYS.every((key) =>
          canonicalLeft[key] === canonicalRight[key]);

      }

      function canonicalizeLiveFloorIdentity(value) {

        const direct = canonicalizeFloorIdentity(value);
        if (direct) {
          return direct;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            value.autoLogin !== false ||
            Object.keys(value).length !== OffState.FLOOR_KEYS.length + 1) {
          return null;
        }
        const withoutAutoLogin = {};
        for (const key of OffState.FLOOR_KEYS) {
          if (!Object.prototype.hasOwnProperty.call(value, key)) {
            return null;
          }
          withoutAutoLogin[key] = value[key];
        }
        return canonicalizeFloorIdentity(withoutAutoLogin);

      }

      function isExactOwnedFloor(liveSettings, persistedFloorIdentity) {

        return Boolean(
            liveSettings && typeof liveSettings === 'object' &&
            !Array.isArray(liveSettings) &&
            liveSettings.levelOfControl === CONTROLLED_BY_THIS_EXTENSION &&
            sameFloorIdentity(
                canonicalizeLiveFloorIdentity(liveSettings.value),
                persistedFloorIdentity,
            ),
        );

      }

      function generateHighPortCandidate(cryptoSource = defaultCrypto) {

        if (!cryptoSource || typeof cryptoSource.getRandomValues !== 'function') {
          throw new TypeError('CRYPTO_RANDOM_UNAVAILABLE');
        }
        const words = new Uint16Array(1);
        cryptoSource.getRandomValues(words);
        const span = OffState.MAX_FLOOR_PORT - OffState.MIN_FLOOR_PORT + 1;
        return OffState.MIN_FLOOR_PORT + (words[0] % span);

      }

      function createController(options = {}) {

        const proxySettings = options.proxySettings;
        const storageArea = options.storageArea;
        const isPrivateAccessAllowed = options.isPrivateAccessAllowed;
        const clearEphemeralState = options.clearEphemeralState || (() => {});
        let operationQueue = Promise.resolve();

        function enqueue(operation) {

          const result = operationQueue.then(operation, operation);
          operationQueue = result.catch(() => {});
          return result;

        }

        function validDependencies() {

          return Boolean(
              proxySettings && typeof proxySettings.get === 'function' &&
              typeof proxySettings.set === 'function' &&
              typeof proxySettings.clear === 'function' &&
              storageArea && typeof storageArea.get === 'function' &&
              typeof storageArea.set === 'function',
          );

        }

        async function initializeState() {

          if (!validDependencies()) {
            return errorResult(ERRORS.STORAGE_UNAVAILABLE,
                OffState.canonicalState());
          }
          try {
            const durableState = await OffState.initialize(storageArea);
            return {ok: true, durableState};
          } catch (_error) {
            return errorResult(ERRORS.STORAGE_UNAVAILABLE,
                OffState.canonicalState());
          }

        }

        async function persistFloorIdentity(floorIdentity) {

          try {
            return await OffState.writeOffState(storageArea, floorIdentity);
          } catch (_error) {
            return null;
          }

        }

        function clearEphemeral() {

          try {
            clearEphemeralState();
            return true;
          } catch (_error) {
            return false;
          }

        }

        async function readLiveSettings(durableState) {

          try {
            return {ok: true, live: await proxySettings.get({})};
          } catch (_error) {
            return errorResult(ERRORS.PROXY_READ_FAILED, durableState);
          }

        }

        async function checkPrivateAccessNow() {

          if (typeof isPrivateAccessAllowed !== 'function') {
            return errorResult(ERRORS.PRIVATE_ACCESS_CHECK_FAILED);
          }
          try {
            if (await isPrivateAccessAllowed() !== true) {
              return errorResult(ERRORS.PRIVATE_ACCESS_REQUIRED);
            }
          } catch (_error) {
            return errorResult(ERRORS.PRIVATE_ACCESS_CHECK_FAILED);
          }
          return {ok: true};

        }

        async function inspectOwnedFloorNow(value) {

          const floorIdentity = canonicalizeFloorIdentity(value);
          if (!floorIdentity) {
            return errorResult(ERRORS.INVALID_FLOOR_IDENTITY);
          }
          const liveResult = await readLiveSettings();
          if (!liveResult.ok) {
            return liveResult;
          }
          if (!isExactOwnedFloor(liveResult.live, floorIdentity)) {
            return errorResult(ERRORS.OWNERSHIP_MISMATCH);
          }
          return {
            ok: true,
            status: RESULTS.OWNED,
            floorIdentity,
          };

        }

        async function acquirePrevalidatedFloorNow(request) {

          const floorIdentity = canonicalizeFloorIdentity(
              request && request.floorIdentity,
          );
          if (!floorIdentity) {
            return errorResult(ERRORS.INVALID_FLOOR_IDENTITY);
          }
          if (!request || request.portPrevalidated !== true) {
            return errorResult(ERRORS.PORT_PREVALIDATION_REQUIRED);
          }
          const privateAccess = await checkPrivateAccessNow();
          if (!privateAccess.ok) {
            return privateAccess;
          }
          const durableState = await persistFloorIdentity(floorIdentity);
          if (!durableState) {
            return errorResult(ERRORS.FLOOR_IDENTITY_PERSIST_FAILED);
          }
          if (!clearEphemeral()) {
            return errorResult(ERRORS.EPHEMERAL_CLEAR_FAILED, durableState);
          }
          try {
            await proxySettings.set({value: floorIdentity});
          } catch (_error) {
            return errorResult(ERRORS.PROXY_SET_FAILED, durableState);
          }
          const liveResult = await readLiveSettings(durableState);
          if (!liveResult.ok) {
            return liveResult;
          }
          if (!isExactOwnedFloor(liveResult.live, floorIdentity)) {
            return errorResult(ERRORS.OWNERSHIP_MISMATCH, durableState);
          }
          return successResult(RESULTS.ACQUIRED, durableState);

        }

        async function clearFloorNow() {

          const initialized = await initializeState();
          if (!initialized.ok) {
            clearEphemeral();
            return initialized;
          }
          const persisted = initialized.durableState.floorIdentity;
          const durableState = await persistFloorIdentity(persisted);
          if (!durableState) {
            clearEphemeral();
            return errorResult(ERRORS.FLOOR_IDENTITY_PERSIST_FAILED,
                initialized.durableState);
          }
          if (!clearEphemeral()) {
            return errorResult(ERRORS.EPHEMERAL_CLEAR_FAILED, durableState);
          }
          if (persisted === null) {
            return successResult(RESULTS.ALREADY_CLEAR, durableState);
          }
          const liveResult = await readLiveSettings(durableState);
          if (!liveResult.ok) {
            return liveResult;
          }
          if (!isExactOwnedFloor(liveResult.live, persisted)) {
            return errorResult(ERRORS.OWNERSHIP_MISMATCH, durableState);
          }
          try {
            await proxySettings.clear({});
          } catch (_error) {
            return errorResult(ERRORS.PROXY_CLEAR_FAILED, durableState);
          }
          const confirmed = await readLiveSettings(durableState);
          if (!confirmed.ok) {
            return confirmed;
          }
          if (isExactOwnedFloor(confirmed.live, persisted)) {
            return errorResult(ERRORS.RELEASE_NOT_CONFIRMED, durableState);
          }
          const clearedState = await persistFloorIdentity(null);
          if (!clearedState) {
            return errorResult(ERRORS.FLOOR_IDENTITY_PERSIST_FAILED,
                durableState);
          }
          return successResult(RESULTS.CLEARED, clearedState);

        }

        return Object.freeze({
          acquirePrevalidatedFloor(request) {

            return enqueue(() => acquirePrevalidatedFloorNow(request));

          },
          clearFloor() {

            return enqueue(clearFloorNow);

          },
          checkPrivateAccess() {

            return enqueue(checkPrivateAccessNow);

          },
          inspectOwnedFloor(floorIdentity) {

            return enqueue(() => inspectOwnedFloorNow(floorIdentity));

          },
          reconcileOffOnStartup() {

            return enqueue(clearFloorNow);

          },
        });

      }

      return Object.freeze({
        CONTROLLED_BY_THIS_EXTENSION,
        ERRORS,
        RESULTS,
        canonicalizeFloorIdentity,
        canonicalizeLiveFloorIdentity,
        createController,
        generateHighPortCandidate,
        isExactOwnedFloor,
        sameFloorIdentity,
      });

    });
