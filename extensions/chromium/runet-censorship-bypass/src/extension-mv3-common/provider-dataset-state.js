'use strict';

(function publishProviderDatasetState(root, factory) {

  const providerDatasetState = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = providerDatasetState;
    return;
  }
  root.mv3ProviderDatasetState = providerDatasetState;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const ACTIONS = Object.freeze({
    ACTIVATE_CANDIDATE: 'ACTIVATE_CANDIDATE',
    KEEP_ACTIVE: 'KEEP_ACTIVE',
    USE_PREVIOUS_LKG: 'USE_PREVIOUS_LKG',
    USE_PACKAGED_BASELINE: 'USE_PACKAGED_BASELINE',
    FAIL_CLOSED: 'FAIL_CLOSED',
    OFF: 'OFF',
  });
  const ELIGIBLE_TRUST = Object.freeze([
    'PACKAGED_TRUSTED',
    'REMOTE_AUTHENTICATED',
  ]);
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;

  function hasValidIdentity(value) {

    const identity = value && value.dataset && value.dataset.identity;
    return Boolean(
        identity &&
        typeof identity.providerKey === 'string' &&
        identity.providerKey.length &&
        typeof identity.datasetVersion === 'string' &&
        identity.datasetVersion.length &&
        typeof identity.artifactSha256 === 'string' &&
        SHA256_PATTERN.test(identity.artifactSha256),
    );

  }

  function isVerified(value) {

    return Boolean(
        value &&
        value.ok === true &&
        value.status === 'VERIFIED' &&
        value.activationEligible === true &&
        value.usable !== false &&
        ELIGIBLE_TRUST.includes(value.trust) &&
        hasValidIdentity(value),
    );

  }

  function datasetRef(verification, providerKey) {

    if (!isVerified(verification)) {
      return null;
    }
    const identity = verification.dataset.identity;
    if (identity.providerKey !== providerKey) {
      return null;
    }
    return {
      providerKey: identity.providerKey,
      datasetVersion: identity.datasetVersion,
      artifactSha256: identity.artifactSha256,
      trust: verification.trust,
    };

  }

  function candidateRejection(candidate, providerKey) {

    if (!candidate) {
      return null;
    }
    if (candidate.ok !== true) {
      return candidate.code || 'CANDIDATE_REJECTED';
    }
    if (candidate.usable === false) {
      return candidate.code || 'CANDIDATE_NOT_USABLE';
    }
    if (candidate.activationEligible !== true) {
      return 'UNAUTHENTICATED_REMOTE_CANDIDATE';
    }
    if (!isVerified(candidate)) {
      return candidate.code || 'CANDIDATE_NOT_USABLE';
    }
    if (candidate.dataset.identity.providerKey !== providerKey) {
      return 'PROVIDER_KEY_MISMATCH';
    }
    return null;

  }

  function planDatasetActivation({
    protectionIntended,
    providerKey,
    active,
    previousLkg,
    packagedBaseline,
    candidate,
  } = {}) {

    if (protectionIntended !== true) {
      return {kind: ACTIONS.OFF};
    }
    if (typeof providerKey !== 'string' ||
        !PROVIDER_KEY_PATTERN.test(providerKey)) {
      return {
        kind: ACTIONS.FAIL_CLOSED,
        code: 'INVALID_PROVIDER_KEY',
        candidateRejection: null,
      };
    }
    const activeRef = datasetRef(active, providerKey);
    const previousLkgRef = datasetRef(previousLkg, providerKey);
    const packagedRef = datasetRef(packagedBaseline, providerKey);
    const candidateRef = datasetRef(candidate, providerKey);
    if (candidateRef) {
      return {
        kind: ACTIONS.ACTIVATE_CANDIDATE,
        selected: candidateRef,
        previousLkg: activeRef || previousLkgRef,
      };
    }
    const rejection = candidateRejection(candidate, providerKey);
    if (activeRef) {
      return {
        kind: ACTIONS.KEEP_ACTIVE,
        selected: activeRef,
        previousLkg: previousLkgRef,
        candidateRejection: rejection,
      };
    }
    if (previousLkgRef) {
      return {
        kind: ACTIONS.USE_PREVIOUS_LKG,
        selected: previousLkgRef,
        candidateRejection: rejection,
      };
    }
    if (packagedRef && packagedBaseline.trust === 'PACKAGED_TRUSTED') {
      return {
        kind: ACTIONS.USE_PACKAGED_BASELINE,
        selected: packagedRef,
        candidateRejection: rejection,
      };
    }
    return {
      kind: ACTIONS.FAIL_CLOSED,
      code: 'NO_USABLE_PROVIDER_DATASET',
      candidateRejection: rejection,
    };

  }

  return Object.freeze({
    ACTIONS,
    planDatasetActivation,
  });

});
