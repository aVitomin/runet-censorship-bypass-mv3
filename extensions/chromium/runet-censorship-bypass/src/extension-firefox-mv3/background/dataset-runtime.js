'use strict';
/* global require */

(function publishFirefoxDatasetRuntime(root, factory) {

  const routing = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/routing-contract') :
    root.mv3RoutingContract;
  const datasetState = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/provider-dataset-state') :
    root.mv3ProviderDatasetState;
  const providerLookup = typeof module === 'object' && module.exports ?
    require('./provider-lookup') : root.rucbFirefoxProviderLookup;
  const api = factory(routing, datasetState, providerLookup);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxDatasetRuntime = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(Routing, DatasetState, ProviderLookup) {

      const STATES = Object.freeze({
        OFF: 'OFF',
        INITIALIZING: 'INITIALIZING',
        READY: 'READY',
        FAILED: 'FAILED',
      });

      function runtimeError(code) {

        const error = new TypeError(code);
        error.code = code;
        return error;

      }

      function matchingVerification(stored, selected) {

        if (!selected) {
          return null;
        }
        return [
          stored.active,
          stored.previousLkg,
          stored.packagedBaseline,
        ].find((verification) => verification && verification.ok === true &&
          verification.dataset.identity.artifactSha256 ===
            selected.artifactSha256 &&
          verification.dataset.identity.providerKey === selected.providerKey) ||
          null;

      }

      function requestHostname(details, baseInput) {

        if (baseInput && typeof baseInput.hostname === 'string') {
          return ProviderLookup.normalizeHostname(baseInput.hostname);
        }
        if (!details || typeof details.url !== 'string') {
          throw runtimeError('REQUEST_HOSTNAME_UNAVAILABLE');
        }
        try {
          return ProviderLookup.normalizeHostname(new URL(details.url).hostname);
        } catch (_error) {
          throw runtimeError('REQUEST_HOSTNAME_UNAVAILABLE');
        }

      }

      function providerDecision(resolution, baseInput) {

        const source = resolution.kind === ProviderLookup.KINDS.MISS ?
          'PROVIDER_DATASET_MISS' : 'PROVIDER_DATASET';
        if (resolution.kind === ProviderLookup.KINDS.FAILURE) {
          return {
            kind: Routing.KINDS.FAIL_CLOSED,
            source: 'PROVIDER_DATASET',
            code: resolution.code || 'PROVIDER_LOOKUP_FAILED',
          };
        }
        if (resolution.kind === ProviderLookup.KINDS.PROVIDER_PROXY) {
          return {
            kind: Routing.KINDS.PROXY,
            source,
            candidates: Array.isArray(baseInput.providerCandidates) ?
              baseInput.providerCandidates : [],
            fallback: baseInput.providerFallback || Routing.FALLBACKS.DIRECT,
          };
        }
        if (resolution.kind === ProviderLookup.KINDS.PROVIDER_DIRECT ||
            resolution.kind === ProviderLookup.KINDS.MISS) {
          return {kind: Routing.KINDS.DIRECT, source};
        }
        return {
          kind: Routing.KINDS.FAIL_CLOSED,
          source: 'PROVIDER_DATASET',
          code: 'INVALID_PROVIDER_LOOKUP_RESULT',
        };

      }

      function createRuntime(options = {}) {

        const protectionIntended = options.protectionIntended === true;
        const providerKey = options.providerKey;
        const store = options.store;
        const baseInputForRequest = options.baseInputForRequest;
        const buildLookup = options.buildLookup || ProviderLookup.buildLookup;
        let state = protectionIntended ? STATES.INITIALIZING : STATES.OFF;
        let failureCode = null;
        let selected = null;
        let lookupIndex = null;
        let initialization;

        async function initializeUnchecked() {

          if (state === STATES.OFF) {
            return snapshot();
          }
          if (!store || typeof store.loadVerifications !== 'function') {
            throw runtimeError('DATASET_STORE_UNAVAILABLE');
          }
          const stored = await store.loadVerifications(providerKey, {
            firstUsableOnly: true,
          });
          const plan = DatasetState.planDatasetActivation({
            protectionIntended: true,
            providerKey,
            active: stored.active,
            previousLkg: stored.previousLkg,
            packagedBaseline: stored.packagedBaseline,
            candidate: null,
          });
          if (plan.kind === DatasetState.ACTIONS.FAIL_CLOSED) {
            throw runtimeError(plan.code || 'NO_USABLE_PROVIDER_DATASET');
          }
          const verification = matchingVerification(stored, plan.selected);
          if (!verification) {
            throw runtimeError('SELECTED_DATASET_UNAVAILABLE');
          }
          const nextLookup = buildLookup(verification);
          if (!nextLookup || typeof nextLookup.lookup !== 'function') {
            throw runtimeError('DATASET_INDEX_BUILD_FAILED');
          }
          lookupIndex = nextLookup;
          selected = Object.freeze({
            providerKey: plan.selected.providerKey,
            datasetVersion: plan.selected.datasetVersion,
            artifactSha256: plan.selected.artifactSha256,
            source: plan.kind,
          });
          state = STATES.READY;
          return snapshot();

        }

        function initialize() {

          if (!initialization) {
            initialization = initializeUnchecked().catch((error) => {
              lookupIndex = null;
              selected = null;
              state = STATES.FAILED;
              failureCode = error && error.code ?
                error.code : 'DATASET_INITIALIZATION_FAILED';
              return snapshot();
            });
          }
          return initialization;

        }

        function getState() {

          return state;

        }

        function snapshot() {

          return Object.freeze({
            state,
            failureCode,
            selected,
          });

        }

        function resolveProvider(rawHostname) {

          if (state !== STATES.READY || !lookupIndex) {
            return Object.freeze({
              kind: ProviderLookup.KINDS.FAILURE,
              code: state === STATES.FAILED ?
                failureCode : 'PROVIDER_DATASET_NOT_READY',
            });
          }
          try {
            return lookupIndex.lookup(rawHostname);
          } catch (_error) {
            return Object.freeze({
              kind: ProviderLookup.KINDS.FAILURE,
              code: 'PROVIDER_LOOKUP_FAILED',
            });
          }

        }

        function routingInputForRequest(details) {

          if (state !== STATES.READY || !lookupIndex) {
            throw runtimeError('PROVIDER_DATASET_NOT_READY');
          }
          const baseInput = typeof baseInputForRequest === 'function' ?
            baseInputForRequest(details) : {};
          if (!baseInput || typeof baseInput !== 'object' ||
              Array.isArray(baseInput)) {
            throw runtimeError('INVALID_ROUTING_BASE_INPUT');
          }
          const hostname = requestHostname(details, baseInput);
          const provider = providerDecision(
              resolveProvider(hostname),
              baseInput,
          );
          const input = Object.assign({}, baseInput, {hostname, provider});
          delete input.providerCandidates;
          delete input.providerFallback;
          return input;

        }

        return Object.freeze({
          getState,
          initialize,
          resolveProvider,
          routingInputForRequest,
          snapshot,
        });

      }

      return Object.freeze({
        STATES,
        createRuntime,
      });

    });
