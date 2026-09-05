'use strict';
/* global require */

(function publishFirefoxActivationController(root, factory) {

  const datasetRuntime = typeof module === 'object' && module.exports ?
    require('./dataset-runtime') : root.rucbFirefoxDatasetRuntime;
  const offState = typeof module === 'object' && module.exports ?
    require('./off-state') : root.rucbFirefoxOffState;
  const proxyControl = typeof module === 'object' && module.exports ?
    require('./proxy-control') : root.rucbFirefoxProxyControl;
  const api = factory(datasetRuntime, offState, proxyControl);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxActivationController = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(DatasetRuntime, OffState, ProxyControl) {

      const PREPARED_KEYS = Object.freeze([
        'datasetIdentity',
        'datasetStore',
        'floorIdentity',
        'portPrevalidated',
        'providerKey',
        'resolveCredentials',
        'routingBaseInputForRequest',
        'routingDescriptor',
      ]);
      const RECOVERY_KEYS = Object.freeze([
        'datasetStore',
        'resolveCredentials',
        'routingBaseInputForRequest',
        'routingDescriptor',
      ]);
      const RESULTS = Object.freeze({
        ACTIVE: 'ACTIVE',
        OFF: 'OFF',
        RECOVERED: 'RECOVERED',
      });
      const RECOVERY_STATUS = Object.freeze({
        ACTIVE: 'ACTIVE',
        BLOCKED_PRIVATE_ACCESS: 'BLOCKED_PRIVATE_ACCESS',
        FAILED: 'FAILED',
        INITIALIZING: 'INITIALIZING',
        OFF: 'OFF',
        OFF_RECONCILIATION_FAILED: 'OFF_RECONCILIATION_FAILED',
        RECOVERED: 'RECOVERED',
      });
      const ERRORS = Object.freeze({
        ACTIVATION_ALREADY_ACTIVE: 'ACTIVATION_ALREADY_ACTIVE',
        ACTIVATION_INTERRUPTED: 'ACTIVATION_INTERRUPTED',
        ACTIVATION_ROLLBACK_FAILED: 'ACTIVATION_ROLLBACK_FAILED',
        BOOT_NOT_READY: 'BOOT_NOT_READY',
        DATASET_IDENTITY_MISMATCH: 'DATASET_IDENTITY_MISMATCH',
        DATASET_INITIALIZATION_FAILED: 'DATASET_INITIALIZATION_FAILED',
        DATASET_NOT_READY: 'DATASET_NOT_READY',
        DURABLE_OFF_PERSIST_FAILED: 'DURABLE_OFF_PERSIST_FAILED',
        DURABLE_ON_PERSIST_FAILED: 'DURABLE_ON_PERSIST_FAILED',
        DURABLE_STATE_UNAVAILABLE: 'DURABLE_STATE_UNAVAILABLE',
        EPHEMERAL_CLEAR_FAILED: 'EPHEMERAL_CLEAR_FAILED',
        INVALID_CONTROLLER_DEPENDENCIES: 'INVALID_CONTROLLER_DEPENDENCIES',
        INVALID_PREPARED_ACTIVATION: 'INVALID_PREPARED_ACTIVATION',
        INVALID_RECOVERY_RESULT: 'INVALID_RECOVERY_RESULT',
        RECOVERY_FACTORY_FAILED: 'RECOVERY_FACTORY_FAILED',
        RECOVERY_FLOOR_MISMATCH: 'RECOVERY_FLOOR_MISMATCH',
        RECOVERY_UNAVAILABLE: 'RECOVERY_UNAVAILABLE',
        ROUTING_DESCRIPTOR_MISMATCH: 'ROUTING_DESCRIPTOR_MISMATCH',
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

      function sameDatasetIdentity(leftValue, rightValue) {

        function identityFields(value) {

          return value && typeof value === 'object' ? {
            providerKey: value.providerKey,
            datasetVersion: value.datasetVersion,
            artifactSha256: value.artifactSha256,
          } : value;

        }
        const left = OffState.canonicalizeDatasetIdentity(
            identityFields(leftValue),
        );
        const right = OffState.canonicalizeDatasetIdentity(
            identityFields(rightValue),
        );
        return Boolean(left && right &&
          OffState.DATASET_IDENTITY_KEYS.every((key) =>
            left[key] === right[key]));

      }

      function sameRoutingDescriptor(leftValue, rightValue) {

        const left = OffState.canonicalizeRoutingDescriptor(leftValue);
        const right = OffState.canonicalizeRoutingDescriptor(rightValue);
        return Boolean(left && right &&
          OffState.ROUTING_DESCRIPTOR_KEYS.every((key) =>
            left[key] === right[key]));

      }

      function validatePreparedActivation(value) {

        try {
          if (!hasExactKeys(value, PREPARED_KEYS) ||
              value.portPrevalidated !== true ||
              !value.datasetStore ||
              typeof value.datasetStore.loadVerifications !== 'function' ||
              !isSynchronousCallable(value.routingBaseInputForRequest) ||
              !isSynchronousCallable(value.resolveCredentials)) {
            return null;
          }
          const floorIdentity = ProxyControl.canonicalizeFloorIdentity(
              value.floorIdentity,
          );
          const datasetIdentity = OffState.canonicalizeDatasetIdentity(
              value.datasetIdentity,
          );
          const routingDescriptor = OffState.canonicalizeRoutingDescriptor(
              value.routingDescriptor,
          );
          if (!floorIdentity || !datasetIdentity || !routingDescriptor ||
              value.providerKey !== datasetIdentity.providerKey) {
            return null;
          }
          return Object.freeze({
            datasetIdentity: Object.freeze(datasetIdentity),
            datasetStore: value.datasetStore,
            floorIdentity: Object.freeze(floorIdentity),
            portPrevalidated: true,
            providerKey: datasetIdentity.providerKey,
            resolveCredentials: value.resolveCredentials,
            routingBaseInputForRequest: value.routingBaseInputForRequest,
            routingDescriptor: Object.freeze(routingDescriptor),
          });
        } catch (_error) {
          return null;
        }

      }

      function validateRecoveryResult(value) {

        try {
          if (!hasExactKeys(value, RECOVERY_KEYS) || !value.datasetStore ||
              typeof value.datasetStore.loadVerifications !== 'function' ||
              !isSynchronousCallable(value.routingBaseInputForRequest) ||
              !isSynchronousCallable(value.resolveCredentials)) {
            return null;
          }
          const routingDescriptor = OffState.canonicalizeRoutingDescriptor(
              value.routingDescriptor,
          );
          if (!routingDescriptor) {
            return null;
          }
          return Object.freeze({
            datasetStore: value.datasetStore,
            resolveCredentials: value.resolveCredentials,
            routingBaseInputForRequest: value.routingBaseInputForRequest,
            routingDescriptor: Object.freeze(routingDescriptor),
          });
        } catch (_error) {
          return null;
        }

      }

      function createController(options = {}) {

        const floorControl = options.proxyControl;
        const routingAdapter = options.routingAdapter;
        const proxyAuth = options.proxyAuth;
        const storageArea = options.storageArea;
        const createDatasetRuntime = options.createDatasetRuntime ||
          DatasetRuntime.createRuntime;
        const recoveryFactory = options.recoveryFactory;
        const afterFloorAcquired = options.afterFloorAcquired;
        const afterDurableOnPersisted = options.afterDurableOnPersisted;
        if (!floorControl ||
            typeof floorControl.acquirePrevalidatedFloor !== 'function' ||
            typeof floorControl.checkPrivateAccess !== 'function' ||
            typeof floorControl.clearFloor !== 'function' ||
            typeof floorControl.inspectOwnedFloor !== 'function' ||
            !routingAdapter ||
            typeof routingAdapter.clearAllAuthorizations !== 'function' ||
            !proxyAuth || typeof proxyAuth.clearAllAttempts !== 'function' ||
            !storageArea || typeof storageArea.get !== 'function' ||
            typeof storageArea.set !== 'function' ||
            typeof createDatasetRuntime !== 'function' ||
            (recoveryFactory !== undefined &&
              typeof recoveryFactory !== 'function') ||
            (afterFloorAcquired !== undefined &&
              typeof afterFloorAcquired !== 'function') ||
            (afterDurableOnPersisted !== undefined &&
              typeof afterDurableOnPersisted !== 'function')) {
          throw new TypeError(ERRORS.INVALID_CONTROLLER_DEPENDENCIES);
        }

        let activeSession = null;
        let durableState = null;
        let runtimeState = DatasetRuntime.STATES.INITIALIZING;
        let recoveryStatus = RECOVERY_STATUS.INITIALIZING;
        let failureCode = null;
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

        function setUnavailable(code, status = RECOVERY_STATUS.FAILED) {

          activeSession = null;
          runtimeState = DatasetRuntime.STATES.FAILED;
          recoveryStatus = status;
          failureCode = code;

        }

        function setOff(state, status = RECOVERY_STATUS.OFF, code = null) {

          activeSession = null;
          durableState = state;
          runtimeState = DatasetRuntime.STATES.OFF;
          recoveryStatus = status;
          failureCode = code;

        }

        function publishSession(runtime, resolveCredentials, status) {

          activeSession = Object.freeze({
            datasetRuntime: runtime,
            resolveCredentials,
          });
          runtimeState = DatasetRuntime.STATES.READY;
          recoveryStatus = status;
          failureCode = null;

        }

        function currentRuntimeState() {

          const session = activeSession;
          if (!session) {
            return runtimeState;
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

        async function buildExactRuntime(input) {

          let runtime;
          try {
            runtime = createDatasetRuntime({
              protectionIntended: true,
              providerKey: input.providerKey,
              store: input.datasetStore,
              baseInputForRequest: input.routingBaseInputForRequest,
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
          if (!initialized ||
              initialized.state !== DatasetRuntime.STATES.READY ||
              runtime.getState() !== DatasetRuntime.STATES.READY) {
            return errorResult(
                initialized && initialized.failureCode ?
                  initialized.failureCode : ERRORS.DATASET_NOT_READY,
            );
          }
          if (!sameDatasetIdentity(initialized.selected, input.datasetIdentity)) {
            return errorResult(ERRORS.DATASET_IDENTITY_MISMATCH);
          }
          return {ok: true, runtime, selected: initialized.selected};

        }

        async function rollback(code) {

          activeSession = null;
          runtimeState = DatasetRuntime.STATES.INITIALIZING;
          clearEphemeralState();
          try {
            durableState = await OffState.writeOffState(
                storageArea,
                durableState && durableState.floorIdentity || null,
            );
          } catch (_error) {
            // The exact proxy-control Clear below makes the same durable OFF
            // transition before releasing the floor and may still recover it.
          }
          let cleared;
          try {
            cleared = await floorControl.clearFloor();
          } catch (_error) {
            cleared = null;
          }
          if (!cleared || cleared.ok !== true) {
            if (cleared && cleared.durableState) {
              durableState = cleared.durableState;
            }
            setUnavailable(ERRORS.ACTIVATION_ROLLBACK_FAILED);
            return errorResult(ERRORS.ACTIVATION_ROLLBACK_FAILED, {
              cause: {code},
              floorRetained: true,
            });
          }
          setOff(cleared.durableState || OffState.canonicalOffState());
          return errorResult(code, {
            rollback: {ok: true, status: cleared.status},
          });

        }

        async function persistOn(prepared) {

          try {
            return await OffState.writeOnState(storageArea, {
              floorIdentity: prepared.floorIdentity,
              providerKey: prepared.providerKey,
              datasetIdentity: prepared.datasetIdentity,
              routingDescriptor: prepared.routingDescriptor,
            });
          } catch (_error) {
            return null;
          }

        }

        async function activatePreparedNow(input) {

          if (activeSession) {
            return errorResult(ERRORS.ACTIVATION_ALREADY_ACTIVE);
          }
          if (!durableState || durableState.intent !== OffState.OFF ||
              runtimeState !== DatasetRuntime.STATES.OFF) {
            return errorResult(ERRORS.BOOT_NOT_READY);
          }
          const prepared = validatePreparedActivation(input);
          if (!prepared) {
            return errorResult(ERRORS.INVALID_PREPARED_ACTIVATION);
          }
          const exactRuntime = await buildExactRuntime(prepared);
          if (!exactRuntime.ok) {
            return exactRuntime;
          }

          let acquired;
          try {
            acquired = await floorControl.acquirePrevalidatedFloor({
              floorIdentity: prepared.floorIdentity,
              portPrevalidated: true,
            });
          } catch (_error) {
            setUnavailable(ProxyControl.ERRORS.PROXY_SET_FAILED);
            return errorResult(ProxyControl.ERRORS.PROXY_SET_FAILED);
          }
          if (!acquired || acquired.ok !== true) {
            const code = acquired && acquired.error && acquired.error.code ?
              acquired.error.code : ProxyControl.ERRORS.PROXY_SET_FAILED;
            if (acquired && acquired.durableState) {
              durableState = acquired.durableState;
              runtimeState = DatasetRuntime.STATES.INITIALIZING;
              recoveryStatus = RECOVERY_STATUS.INITIALIZING;
              return rollback(code);
            }
            return errorResult(code);
          }
          durableState = acquired.durableState ||
            OffState.canonicalOffState(prepared.floorIdentity);
          runtimeState = DatasetRuntime.STATES.INITIALIZING;
          recoveryStatus = RECOVERY_STATUS.INITIALIZING;

          try {
            if (afterFloorAcquired) {
              await afterFloorAcquired();
            }
            const persistedOn = await persistOn(prepared);
            if (!persistedOn) {
              return rollback(ERRORS.DURABLE_ON_PERSIST_FAILED);
            }
            durableState = persistedOn;
            if (afterDurableOnPersisted) {
              await afterDurableOnPersisted();
            }
            if (exactRuntime.runtime.getState() !==
                DatasetRuntime.STATES.READY) {
              return rollback(ERRORS.DATASET_NOT_READY);
            }
            if (!clearEphemeralState()) {
              return rollback(ERRORS.EPHEMERAL_CLEAR_FAILED);
            }
            publishSession(
                exactRuntime.runtime,
                prepared.resolveCredentials,
                RECOVERY_STATUS.ACTIVE,
            );
            return {
              ok: true,
              status: RESULTS.ACTIVE,
              dataset: exactRuntime.selected,
            };
          } catch (_error) {
            return rollback(ERRORS.ACTIVATION_INTERRUPTED);
          }

        }

        async function transitionLostFloorToOff() {

          try {
            const next = await OffState.writeOffState(storageArea, null);
            clearEphemeralState();
            setOff(next);
            return true;
          } catch (_error) {
            setUnavailable(ERRORS.DURABLE_OFF_PERSIST_FAILED);
            return false;
          }

        }

        async function recoverOnState(state) {

          const privateAccess = await floorControl.checkPrivateAccess();
          const owned = await floorControl.inspectOwnedFloor(
              state.floorIdentity,
          );
          if (!owned || owned.ok !== true) {
            if (owned && owned.error &&
                owned.error.code === ProxyControl.ERRORS.OWNERSHIP_MISMATCH) {
              const transitioned = await transitionLostFloorToOff();
              return errorResult(transitioned ?
                ERRORS.RECOVERY_FLOOR_MISMATCH :
                ERRORS.DURABLE_OFF_PERSIST_FAILED, {
                transitionedToOff: transitioned,
              });
            }
            const code = owned && owned.error && owned.error.code ?
              owned.error.code : ProxyControl.ERRORS.PROXY_READ_FAILED;
            setUnavailable(code);
            return errorResult(code, {floorRetained: true});
          }
          if (!privateAccess || privateAccess.ok !== true) {
            const code = privateAccess && privateAccess.error &&
              privateAccess.error.code ===
                ProxyControl.ERRORS.PRIVATE_ACCESS_REQUIRED ?
              RECOVERY_STATUS.BLOCKED_PRIVATE_ACCESS :
              ProxyControl.ERRORS.PRIVATE_ACCESS_CHECK_FAILED;
            setUnavailable(code, code === RECOVERY_STATUS.BLOCKED_PRIVATE_ACCESS ?
              RECOVERY_STATUS.BLOCKED_PRIVATE_ACCESS :
              RECOVERY_STATUS.FAILED);
            return errorResult(code, {floorRetained: true});
          }
          if (typeof recoveryFactory !== 'function') {
            setUnavailable(ERRORS.RECOVERY_UNAVAILABLE);
            return errorResult(ERRORS.RECOVERY_UNAVAILABLE, {
              floorRetained: true,
            });
          }

          let recovered;
          try {
            recovered = validateRecoveryResult(await recoveryFactory(
                OffState.canonicalOnState(state),
            ));
          } catch (_error) {
            setUnavailable(ERRORS.RECOVERY_FACTORY_FAILED);
            return errorResult(ERRORS.RECOVERY_FACTORY_FAILED, {
              floorRetained: true,
            });
          }
          if (!recovered) {
            setUnavailable(ERRORS.INVALID_RECOVERY_RESULT);
            return errorResult(ERRORS.INVALID_RECOVERY_RESULT, {
              floorRetained: true,
            });
          }
          if (!sameRoutingDescriptor(
              recovered.routingDescriptor,
              state.routingDescriptor,
          )) {
            setUnavailable(ERRORS.ROUTING_DESCRIPTOR_MISMATCH);
            return errorResult(ERRORS.ROUTING_DESCRIPTOR_MISMATCH, {
              floorRetained: true,
            });
          }
          const exactRuntime = await buildExactRuntime({
            datasetIdentity: state.datasetIdentity,
            datasetStore: recovered.datasetStore,
            providerKey: state.providerKey,
            routingBaseInputForRequest: recovered.routingBaseInputForRequest,
          });
          if (!exactRuntime.ok) {
            setUnavailable(exactRuntime.error.code);
            return errorResult(exactRuntime.error.code, {floorRetained: true});
          }
          if (!clearEphemeralState()) {
            setUnavailable(ERRORS.EPHEMERAL_CLEAR_FAILED);
            return errorResult(ERRORS.EPHEMERAL_CLEAR_FAILED, {
              floorRetained: true,
            });
          }
          publishSession(
              exactRuntime.runtime,
              recovered.resolveCredentials,
              RECOVERY_STATUS.RECOVERED,
          );
          return {
            ok: true,
            status: RESULTS.RECOVERED,
            dataset: exactRuntime.selected,
          };

        }

        async function initializeFromDurableNow() {

          if (activeSession &&
              currentRuntimeState() === DatasetRuntime.STATES.READY) {
            return {ok: true, status: recoveryStatus};
          }
          activeSession = null;
          runtimeState = DatasetRuntime.STATES.INITIALIZING;
          recoveryStatus = RECOVERY_STATUS.INITIALIZING;
          failureCode = null;
          clearEphemeralState();
          let state;
          try {
            state = await OffState.initialize(storageArea);
          } catch (_error) {
            durableState = null;
            setUnavailable(ERRORS.DURABLE_STATE_UNAVAILABLE);
            return errorResult(ERRORS.DURABLE_STATE_UNAVAILABLE);
          }
          durableState = state;
          if (state.intent === OffState.ON) {
            return recoverOnState(state);
          }
          let reconciliation;
          try {
            reconciliation = await floorControl.reconcileOffOnStartup();
          } catch (_error) {
            reconciliation = null;
          }
          if (reconciliation && reconciliation.durableState) {
            durableState = reconciliation.durableState;
          }
          if (!reconciliation || reconciliation.ok !== true) {
            const code = reconciliation && reconciliation.error &&
              reconciliation.error.code ? reconciliation.error.code :
              ProxyControl.ERRORS.PROXY_CLEAR_FAILED;
            setOff(
                durableState || state,
                RECOVERY_STATUS.OFF_RECONCILIATION_FAILED,
                code,
            );
            return errorResult(code, {intent: OffState.OFF});
          }
          setOff(reconciliation.durableState || state);
          return {ok: true, status: RESULTS.OFF};

        }

        async function clearNow() {

          let state = durableState;
          if (!state) {
            try {
              state = await OffState.initialize(storageArea);
            } catch (_error) {
              return errorResult(ERRORS.DURABLE_STATE_UNAVAILABLE);
            }
          }
          let persistedOff;
          try {
            persistedOff = await OffState.writeOffState(
                storageArea,
                state.floorIdentity || null,
            );
          } catch (_error) {
            return errorResult(ERRORS.DURABLE_OFF_PERSIST_FAILED);
          }
          durableState = persistedOff;
          activeSession = null;
          runtimeState = DatasetRuntime.STATES.INITIALIZING;
          recoveryStatus = RECOVERY_STATUS.INITIALIZING;
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
            if (cleared && cleared.durableState) {
              durableState = cleared.durableState;
            }
            setOff(durableState, RECOVERY_STATUS.OFF_RECONCILIATION_FAILED,
                code);
            return errorResult(code, {floorRetained: true});
          }
          setOff(cleared.durableState || OffState.canonicalOffState());
          if (!ephemeralCleared) {
            return errorResult(ERRORS.EPHEMERAL_CLEAR_FAILED);
          }
          return {ok: true, status: cleared.status};

        }

        function snapshot() {

          return Object.freeze({
            runtimeState: currentRuntimeState(),
            active: activeSession !== null,
            durableIntent: durableState ? durableState.intent : null,
            recoveryStatus,
            failureCode,
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
          initializeFromDurable() {

            return enqueue(initializeFromDurableNow);

          },
          resolveCredentials,
          routingInputForRequest,
          snapshot,
        });

      }

      return Object.freeze({
        ERRORS,
        PREPARED_KEYS,
        RECOVERY_KEYS,
        RECOVERY_STATUS,
        RESULTS,
        createController,
        sameDatasetIdentity,
        sameRoutingDescriptor,
        validatePreparedActivation,
        validateRecoveryResult,
      });

    });
