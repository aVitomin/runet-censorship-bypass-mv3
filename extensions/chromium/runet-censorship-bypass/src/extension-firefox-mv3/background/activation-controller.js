'use strict';
/* global require */

(function publishFirefoxActivationController(root, factory) {

  const datasetRuntime = typeof module === 'object' && module.exports ?
    require('./dataset-runtime') : root.rucbFirefoxDatasetRuntime;
  const proxyControl = typeof module === 'object' && module.exports ?
    require('./proxy-control') : root.rucbFirefoxProxyControl;
  const api = factory(datasetRuntime, proxyControl);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxActivationController = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(DatasetRuntime, ProxyControl) {

      const PREPARED_KEYS = Object.freeze([
        'datasetStore',
        'floorIdentity',
        'portPrevalidated',
        'providerKey',
        'resolveCredentials',
        'routingBaseInputForRequest',
      ]);
      const PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
      const RESULTS = Object.freeze({ACTIVE: 'ACTIVE'});
      const ERRORS = Object.freeze({
        ACTIVATION_ALREADY_ACTIVE: 'ACTIVATION_ALREADY_ACTIVE',
        ACTIVATION_INTERRUPTED: 'ACTIVATION_INTERRUPTED',
        ACTIVATION_ROLLBACK_FAILED: 'ACTIVATION_ROLLBACK_FAILED',
        DATASET_INITIALIZATION_FAILED: 'DATASET_INITIALIZATION_FAILED',
        DATASET_NOT_READY: 'DATASET_NOT_READY',
        EPHEMERAL_CLEAR_FAILED: 'EPHEMERAL_CLEAR_FAILED',
        INVALID_CONTROLLER_DEPENDENCIES: 'INVALID_CONTROLLER_DEPENDENCIES',
        INVALID_PREPARED_ACTIVATION: 'INVALID_PREPARED_ACTIVATION',
      });

      function hasExactKeys(value, expected) {

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false;
        }
        const actual = Object.keys(value).sort();
        const required = [...expected].sort();
        return actual.length === required.length &&
          actual.every((key, index) => key === required[index]);

      }

      function errorResult(code, extras = null) {

        return Object.assign({ok: false, error: {code}}, extras || {});

      }

      function isSynchronousCallable(value) {

        return typeof value === 'function' &&
          Object.prototype.toString.call(value) !== '[object AsyncFunction]';

      }

      function validatePreparedActivation(value) {

        try {
          if (!hasExactKeys(value, PREPARED_KEYS) ||
              value.portPrevalidated !== true ||
              typeof value.providerKey !== 'string' ||
              !PROVIDER_KEY_PATTERN.test(value.providerKey) ||
              !value.datasetStore ||
              typeof value.datasetStore.loadVerifications !== 'function' ||
              !isSynchronousCallable(value.routingBaseInputForRequest) ||
              !isSynchronousCallable(value.resolveCredentials)) {
            return null;
          }
          const floorIdentity = ProxyControl.canonicalizeFloorIdentity(
              value.floorIdentity,
          );
          if (!floorIdentity) {
            return null;
          }
          return Object.freeze({
            datasetStore: value.datasetStore,
            floorIdentity: Object.freeze(floorIdentity),
            portPrevalidated: true,
            providerKey: value.providerKey,
            resolveCredentials: value.resolveCredentials,
            routingBaseInputForRequest: value.routingBaseInputForRequest,
          });
        } catch (_error) {
          return null;
        }

      }

      function createController(options = {}) {

        const floorControl = options.proxyControl;
        const routingAdapter = options.routingAdapter;
        const proxyAuth = options.proxyAuth;
        const createDatasetRuntime = options.createDatasetRuntime ||
          DatasetRuntime.createRuntime;
        const afterFloorAcquired = options.afterFloorAcquired;
        if (!floorControl ||
            typeof floorControl.acquirePrevalidatedFloor !== 'function' ||
            typeof floorControl.clearFloor !== 'function' ||
            !routingAdapter ||
            typeof routingAdapter.clearAllAuthorizations !== 'function' ||
            !proxyAuth || typeof proxyAuth.clearAllAttempts !== 'function' ||
            typeof createDatasetRuntime !== 'function' ||
            (afterFloorAcquired !== undefined &&
              typeof afterFloorAcquired !== 'function')) {
          throw new TypeError(ERRORS.INVALID_CONTROLLER_DEPENDENCIES);
        }

        let activeSession = null;
        let operationQueue = Promise.resolve();

        function enqueue(operation) {

          const result = operationQueue.then(operation, operation);
          operationQueue = result.catch(() => {});
          return result;

        }

        function clearEphemeralState() {

          let cleared = true;
          try {
            routingAdapter.clearAllAuthorizations();
          } catch (_error) {
            cleared = false;
          }
          try {
            proxyAuth.clearAllAttempts();
          } catch (_error) {
            cleared = false;
          }
          return cleared;

        }

        function currentRuntimeState() {

          const session = activeSession;
          if (!session) {
            return DatasetRuntime.STATES.OFF;
          }
          try {
            return session.datasetRuntime.getState() ===
              DatasetRuntime.STATES.READY ?
              DatasetRuntime.STATES.READY : DatasetRuntime.STATES.FAILED;
          } catch (_error) {
            return DatasetRuntime.STATES.FAILED;
          }

        }

        function routingInputForRequest(details) {

          const session = activeSession;
          if (!session || currentRuntimeState() !== DatasetRuntime.STATES.READY) {
            throw new TypeError('FIREFOX_ACTIVATION_SESSION_UNAVAILABLE');
          }
          return session.datasetRuntime.routingInputForRequest(details);

        }

        function resolveCredentials(authRef) {

          const session = activeSession;
          if (!session || currentRuntimeState() !== DatasetRuntime.STATES.READY) {
            return null;
          }
          try {
            return session.resolveCredentials(authRef);
          } catch (_error) {
            return null;
          }

        }

        async function rollback(code) {

          activeSession = null;
          clearEphemeralState();
          let cleared;
          try {
            cleared = await floorControl.clearFloor();
          } catch (_error) {
            cleared = null;
          }
          if (!cleared || cleared.ok !== true) {
            return errorResult(ERRORS.ACTIVATION_ROLLBACK_FAILED, {
              cause: {code},
              floorRetained: true,
            });
          }
          return errorResult(code, {
            rollback: {ok: true, status: cleared.status},
          });

        }

        async function activatePreparedNow(input) {

          if (activeSession) {
            return errorResult(ERRORS.ACTIVATION_ALREADY_ACTIVE);
          }
          const prepared = validatePreparedActivation(input);
          if (!prepared) {
            return errorResult(ERRORS.INVALID_PREPARED_ACTIVATION);
          }

          let runtime;
          try {
            runtime = createDatasetRuntime({
              protectionIntended: true,
              providerKey: prepared.providerKey,
              store: prepared.datasetStore,
              baseInputForRequest: prepared.routingBaseInputForRequest,
            });
          } catch (_error) {
            return errorResult(ERRORS.DATASET_INITIALIZATION_FAILED);
          }
          if (!runtime || typeof runtime.initialize !== 'function' ||
              typeof runtime.getState !== 'function' ||
              typeof runtime.routingInputForRequest !== 'function') {
            return errorResult(ERRORS.DATASET_INITIALIZATION_FAILED);
          }

          let initialized;
          try {
            initialized = await runtime.initialize();
          } catch (_error) {
            return errorResult(ERRORS.DATASET_INITIALIZATION_FAILED);
          }
          let initializedReady = false;
          try {
            initializedReady = Boolean(initialized) &&
              initialized.state === DatasetRuntime.STATES.READY &&
              runtime.getState() === DatasetRuntime.STATES.READY;
          } catch (_error) {
            initializedReady = false;
          }
          if (!initializedReady) {
            const code = initialized && initialized.failureCode ?
              initialized.failureCode : ERRORS.DATASET_NOT_READY;
            return errorResult(code);
          }

          let acquired;
          try {
            acquired = await floorControl.acquirePrevalidatedFloor({
              floorIdentity: prepared.floorIdentity,
              portPrevalidated: true,
            });
          } catch (_error) {
            return errorResult(ProxyControl.ERRORS.PROXY_SET_FAILED);
          }
          if (!acquired || acquired.ok !== true) {
            const code = acquired && acquired.error && acquired.error.code ?
              acquired.error.code : ProxyControl.ERRORS.PROXY_SET_FAILED;
            return errorResult(code);
          }

          try {
            if (afterFloorAcquired) {
              await afterFloorAcquired();
            }
            if (runtime.getState() !== DatasetRuntime.STATES.READY) {
              return rollback(ERRORS.DATASET_NOT_READY);
            }
            if (!clearEphemeralState()) {
              return rollback(ERRORS.EPHEMERAL_CLEAR_FAILED);
            }
            activeSession = Object.freeze({
              datasetRuntime: runtime,
              resolveCredentials: prepared.resolveCredentials,
            });
            return {
              ok: true,
              status: RESULTS.ACTIVE,
              dataset: initialized.selected || null,
            };
          } catch (_error) {
            return rollback(ERRORS.ACTIVATION_INTERRUPTED);
          }

        }

        async function clearNow() {

          activeSession = null;
          const ephemeralCleared = clearEphemeralState();
          let cleared;
          try {
            cleared = await floorControl.clearFloor();
          } catch (_error) {
            cleared = null;
          }
          if (!cleared || cleared.ok !== true) {
            const code = cleared && cleared.error && cleared.error.code ?
              cleared.error.code : ProxyControl.ERRORS.PROXY_CLEAR_FAILED;
            return errorResult(code, {floorRetained: true});
          }
          if (!ephemeralCleared) {
            return errorResult(ERRORS.EPHEMERAL_CLEAR_FAILED);
          }
          return {ok: true, status: cleared.status};

        }

        function snapshot() {

          return Object.freeze({
            runtimeState: currentRuntimeState(),
            active: activeSession !== null,
          });

        }

        return Object.freeze({
          activatePrepared(input) {

            return enqueue(() => activatePreparedNow(input));

          },
          clear() {

            return enqueue(clearNow);

          },
          currentRuntimeState,
          resolveCredentials,
          routingInputForRequest,
          snapshot,
        });

      }

      return Object.freeze({
        ERRORS,
        PREPARED_KEYS,
        RESULTS,
        createController,
        validatePreparedActivation,
      });

    });
