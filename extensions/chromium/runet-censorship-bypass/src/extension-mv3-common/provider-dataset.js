'use strict';

(function publishProviderDataset(root, factory) {

  const providerDataset = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = providerDataset;
    return;
  }
  root.mv3ProviderDataset = providerDataset;

})(typeof globalThis === 'object' ? globalThis : this, function() {

  const SCHEMA_VERSION = 1;
  const ROUTE_TABLE_VERSION = 1;
  const PAYLOAD_FORMAT = 'HOST_BUCKETS_V1';
  const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
  const MAX_RULES = 750000;
  const MAX_BUCKETS = 36;
  const MAX_SOURCE_REVISIONS = 32;
  const TRUST = Object.freeze({
    PACKAGED_TRUSTED: 'PACKAGED_TRUSTED',
    REMOTE_AUTHENTICATED: 'REMOTE_AUTHENTICATED',
    REMOTE_UNAUTHENTICATED: 'REMOTE_UNAUTHENTICATED',
  });
  const ROUTE_REFS = Object.freeze([
    'PROVIDER_DIRECT',
    'PROVIDER_PROXY',
  ]);
  const ENVELOPE_FIELDS = Object.freeze([
    'artifactByteCount',
    'artifactSha256',
    'datasetVersion',
    'generatedAt',
    'providerKey',
    'routeTableVersion',
    'ruleCount',
    'schemaVersion',
    'sourceRevisions',
  ]);
  const SOURCE_REVISION_FIELDS = Object.freeze([
    'revision',
    'sourceId',
  ]);
  const PAYLOAD_FIELDS = Object.freeze([
    'buckets',
    'format',
  ]);
  const BUCKET_FIELDS = Object.freeze([
    'key',
    'rules',
  ]);
  const RULE_FIELDS = Object.freeze([
    'host',
    'routeRef',
  ]);
  const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
  const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,127})$/;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  const BUCKET_KEY_PATTERN = /^[a-z0-9]$/;
  const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

  function verificationError(code) {

    const error = new TypeError(code);
    error.code = code;
    return error;

  }

  function reject(error) {

    return Object.freeze({
      ok: false,
      status: 'REJECTED',
      code: error && error.code ?
        error.code :
        'DATASET_VERIFICATION_FAILED',
    });

  }

  function isPlainObject(value) {

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;

  }

  function requireExactObject(value, fields) {

    if (!isPlainObject(value)) {
      throw verificationError('INVALID_FIELD_TYPE');
    }
    const keys = Object.keys(value);
    if (keys.some((key) => !fields.includes(key))) {
      throw verificationError('UNKNOWN_FIELD');
    }
    if (fields.some((field) =>
      !Object.prototype.hasOwnProperty.call(value, field))) {
      throw verificationError('MISSING_REQUIRED_FIELD');
    }

  }

  function requireIdentifier(value, code) {

    if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
      throw verificationError(code);
    }
    return value;

  }

  function requireVersion(value) {

    if (typeof value !== 'string' || !VERSION_PATTERN.test(value)) {
      throw verificationError('INVALID_DATASET_VERSION');
    }
    return value;

  }

  function requireTimestamp(value) {

    if (typeof value !== 'string') {
      throw verificationError('INVALID_GENERATED_TIMESTAMP');
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString() !== value) {
      throw verificationError('INVALID_GENERATED_TIMESTAMP');
    }
    return value;

  }

  function requirePositiveInteger(value, code) {

    if (!Number.isSafeInteger(value) || value < 1) {
      throw verificationError(code);
    }
    return value;

  }

  function validateSourceRevisions(value) {

    if (!Array.isArray(value) || !value.length ||
        value.length > MAX_SOURCE_REVISIONS) {
      throw verificationError('INVALID_SOURCE_REVISIONS');
    }
    return value.map((sourceRevision) => {
      requireExactObject(sourceRevision, SOURCE_REVISION_FIELDS);
      const sourceId = requireIdentifier(
          sourceRevision.sourceId,
          'INVALID_SOURCE_ID',
      );
      if (typeof sourceRevision.revision !== 'string' ||
          !sourceRevision.revision.length ||
          sourceRevision.revision.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(sourceRevision.revision)) {
        throw verificationError('INVALID_SOURCE_REVISION');
      }
      return {sourceId, revision: sourceRevision.revision};
    });

  }

  function validateEnvelope(value) {

    requireExactObject(value, ENVELOPE_FIELDS);
    if (value.schemaVersion !== SCHEMA_VERSION) {
      throw verificationError('UNSUPPORTED_SCHEMA_VERSION');
    }
    if (value.routeTableVersion !== ROUTE_TABLE_VERSION) {
      throw verificationError('UNSUPPORTED_ROUTE_TABLE_VERSION');
    }
    const providerKey = requireIdentifier(
        value.providerKey,
        'INVALID_PROVIDER_KEY',
    );
    const datasetVersion = requireVersion(value.datasetVersion);
    const generatedAt = requireTimestamp(value.generatedAt);
    const sourceRevisions = validateSourceRevisions(value.sourceRevisions);
    const ruleCount = requirePositiveInteger(
        value.ruleCount,
        'INVALID_RULE_COUNT',
    );
    if (ruleCount > MAX_RULES) {
      throw verificationError('TOO_MANY_RULES');
    }
    const artifactByteCount = requirePositiveInteger(
        value.artifactByteCount,
        'INVALID_ARTIFACT_BYTE_COUNT',
    );
    if (artifactByteCount > MAX_ARTIFACT_BYTES) {
      throw verificationError('ARTIFACT_TOO_LARGE');
    }
    if (typeof value.artifactSha256 !== 'string' ||
        !SHA256_PATTERN.test(value.artifactSha256)) {
      throw verificationError('INVALID_ARTIFACT_SHA256');
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      providerKey,
      datasetVersion,
      generatedAt,
      sourceRevisions,
      ruleCount,
      artifactByteCount,
      artifactSha256: value.artifactSha256,
      routeTableVersion: ROUTE_TABLE_VERSION,
    };

  }

  function validateTrust(value) {

    if (!Object.values(TRUST).includes(value)) {
      throw verificationError('INVALID_ARTIFACT_TRUST');
    }
    return value;

  }

  function isValidHost(value) {

    if (typeof value !== 'string' || value.length > 253 ||
        value !== value.toLowerCase() || value.endsWith('.')) {
      return false;
    }
    const labels = value.split('.');
    return labels.length >= 2 && labels.every((label) =>
      label.length <= 63 && HOST_LABEL_PATTERN.test(label));

  }

  function validateRule(rule, bucketKey) {

    requireExactObject(rule, RULE_FIELDS);
    if (!isValidHost(rule.host) || !rule.host.startsWith(bucketKey)) {
      throw verificationError('INVALID_HOST');
    }
    if (typeof rule.routeRef !== 'string' ||
        !ROUTE_REFS.includes(rule.routeRef)) {
      throw verificationError('INVALID_ROUTE_REFERENCE');
    }
    return {host: rule.host, routeRef: rule.routeRef};

  }

  function validatePayload(value, declaredRuleCount) {

    requireExactObject(value, PAYLOAD_FIELDS);
    if (value.format !== PAYLOAD_FORMAT) {
      throw verificationError('UNSUPPORTED_PAYLOAD_FORMAT');
    }
    if (!Array.isArray(value.buckets) || !value.buckets.length ||
        value.buckets.length > MAX_BUCKETS) {
      throw verificationError('MALFORMED_BUCKET_STRUCTURE');
    }
    const seenHosts = new Set();
    let previousBucketKey = '';
    let actualRuleCount = 0;
    const buckets = value.buckets.map((bucket) => {
      requireExactObject(bucket, BUCKET_FIELDS);
      if (typeof bucket.key !== 'string' ||
          !BUCKET_KEY_PATTERN.test(bucket.key)) {
        throw verificationError('MALFORMED_BUCKET_STRUCTURE');
      }
      if (previousBucketKey && bucket.key <= previousBucketKey) {
        throw verificationError('UNSORTED_BUCKETS');
      }
      previousBucketKey = bucket.key;
      if (!Array.isArray(bucket.rules) || !bucket.rules.length) {
        throw verificationError('MALFORMED_BUCKET_STRUCTURE');
      }
      let previousHost = '';
      const rules = bucket.rules.map((rule) => {
        const normalized = validateRule(rule, bucket.key);
        if (previousHost && normalized.host <= previousHost) {
          if (normalized.host === previousHost) {
            throw verificationError('DUPLICATE_RULE');
          }
          throw verificationError('UNSORTED_RULES');
        }
        previousHost = normalized.host;
        if (seenHosts.has(normalized.host)) {
          throw verificationError('DUPLICATE_RULE');
        }
        seenHosts.add(normalized.host);
        actualRuleCount += 1;
        if (actualRuleCount > MAX_RULES) {
          throw verificationError('TOO_MANY_RULES');
        }
        return normalized;
      });
      return {key: bucket.key, rules};
    });
    if (actualRuleCount !== declaredRuleCount) {
      throw verificationError('RULE_COUNT_MISMATCH');
    }
    return {format: PAYLOAD_FORMAT, buckets};

  }

  function copyExactBytes(value) {

    if (!(value instanceof Uint8Array)) {
      throw verificationError('UNSUPPORTED_ARTIFACT_BYTES');
    }
    if (!value.byteLength) {
      throw verificationError('EMPTY_ARTIFACT');
    }
    if (value.byteLength > MAX_ARTIFACT_BYTES) {
      throw verificationError('ARTIFACT_TOO_LARGE');
    }
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    return copy;

  }

  function decodePayload(bytes) {

    if (typeof TextDecoder !== 'function') {
      throw verificationError('UTF8_DECODER_UNAVAILABLE');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (_error) {
      throw verificationError('INVALID_UTF8');
    }
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw verificationError('MALFORMED_JSON');
    }

  }

  async function verifyProviderDataset({
    envelope,
    artifactBytes,
    sha256,
    trust,
  } = {}) {

    try {
      const normalizedEnvelope = validateEnvelope(envelope);
      const normalizedTrust = validateTrust(trust);
      if (typeof sha256 !== 'function') {
        throw verificationError('SHA256_IMPLEMENTATION_REQUIRED');
      }
      const exactBytes = copyExactBytes(artifactBytes);
      if (exactBytes.byteLength !== normalizedEnvelope.artifactByteCount) {
        throw verificationError('ARTIFACT_BYTE_COUNT_MISMATCH');
      }
      let actualSha256;
      try {
        const hashInput = new Uint8Array(exactBytes.byteLength);
        hashInput.set(exactBytes);
        actualSha256 = await sha256(hashInput);
      } catch (_error) {
        throw verificationError('SHA256_COMPUTATION_FAILED');
      }
      if (typeof actualSha256 !== 'string' ||
          !SHA256_PATTERN.test(actualSha256.toLowerCase())) {
        throw verificationError('INVALID_COMPUTED_SHA256');
      }
      if (actualSha256.toLowerCase() !==
          normalizedEnvelope.artifactSha256) {
        throw verificationError('ARTIFACT_SHA256_MISMATCH');
      }
      const payload = validatePayload(
          decodePayload(exactBytes),
          normalizedEnvelope.ruleCount,
      );
      const activationEligible = normalizedTrust !==
        TRUST.REMOTE_UNAUTHENTICATED;
      return Object.freeze({
        ok: true,
        status: 'VERIFIED',
        trust: normalizedTrust,
        activationEligible,
        dataset: Object.freeze({
          identity: Object.freeze({
            providerKey: normalizedEnvelope.providerKey,
            datasetVersion: normalizedEnvelope.datasetVersion,
            artifactSha256: normalizedEnvelope.artifactSha256,
          }),
          envelope: normalizedEnvelope,
          payload,
        }),
      });
    } catch (error) {
      return reject(error);
    }

  }

  return Object.freeze({
    LIMITS: Object.freeze({
      MAX_ARTIFACT_BYTES,
      MAX_BUCKETS,
      MAX_RULES,
      MAX_SOURCE_REVISIONS,
    }),
    PAYLOAD_FORMAT,
    ROUTE_REFS,
    ROUTE_TABLE_VERSION,
    SCHEMA_VERSION,
    TRUST,
    verifyProviderDataset,
  });

});
