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
  // The pinned production-scale input occupies 80 hostname-width buckets
  // (widths 2 through 131, with gaps). A 128-bucket ceiling leaves bounded
  // growth room without making bucket metadata or index setup unbounded.
  const MAX_BUCKETS = 128;
  const MAX_HOST_LENGTH = 253;
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
    'hosts',
    'routeRef',
    'width',
  ]);
  const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
  const VERSION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,127})$/;
  const SHA256_PATTERN = /^[a-f0-9]{64}$/;
  // These are provider lookup suffixes, not executable text or values passed
  // to a URL parser. The pinned source includes underscores and a few inert
  // non-DNS lookup characters, so the rigid grammar mirrors its comparator
  // inputs while excluding whitespace, controls, delimiters, and code syntax.
  const HOST_SUFFIX_PATTERN = /^[a-z0-9._&\\-]+$/;

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

    if (typeof value !== 'string' || !value.length ||
        value.length > MAX_HOST_LENGTH || value !== value.toLowerCase() ||
        !HOST_SUFFIX_PATTERN.test(value)) {
      return false;
    }
    const absolute = value.endsWith('.');
    const labels = (absolute ? value.slice(0, -1) : value).split('.');
    return labels.length >= 1 && labels.every((label) =>
      label.length >= 1 && label.length <= 63);

  }

  function fixedBucketsOverlap(left, right, width) {

    let leftOffset = 0;
    let rightOffset = 0;
    while (leftOffset < left.length && rightOffset < right.length) {
      const leftHost = left.slice(leftOffset, leftOffset + width);
      const rightHost = right.slice(rightOffset, rightOffset + width);
      if (leftHost === rightHost) {
        return true;
      }
      if (leftHost < rightHost) {
        leftOffset += width;
      } else {
        rightOffset += width;
      }
    }
    return false;

  }

  function validateBucketHosts(hosts, width) {

    // `hosts` is one concatenated, lexicographically sorted sequence. Every
    // entry has exactly `width` characters, matching the provider's compact
    // fixed-width lookup representation without per-rule JSON object cost.
    if (typeof hosts !== 'string' || !hosts.length ||
        hosts.length % width !== 0) {
      throw verificationError('MALFORMED_BUCKET_STRUCTURE');
    }
    let previousHost = '';
    const ruleCount = hosts.length / width;
    for (let offset = 0; offset < hosts.length; offset += width) {
      const host = hosts.slice(offset, offset + width);
      if (!isValidHost(host)) {
        throw verificationError('INVALID_HOST');
      }
      if (previousHost && host <= previousHost) {
        if (host === previousHost) {
          throw verificationError('DUPLICATE_RULE');
        }
        throw verificationError('UNSORTED_RULES');
      }
      previousHost = host;
    }
    return ruleCount;

  }

  function validatePayload(value, declaredRuleCount) {

    requireExactObject(value, PAYLOAD_FIELDS);
    if (value.format !== PAYLOAD_FORMAT) {
      throw verificationError('UNSUPPORTED_PAYLOAD_FORMAT');
    }
    if (!Array.isArray(value.buckets) || !value.buckets.length) {
      throw verificationError('MALFORMED_BUCKET_STRUCTURE');
    }
    if (value.buckets.length > MAX_BUCKETS) {
      throw verificationError('TOO_MANY_BUCKETS');
    }
    const bucketsByWidth = new Map();
    let previousWidth = 0;
    let previousRouteIndex = -1;
    let actualRuleCount = 0;
    const buckets = value.buckets.map((bucket) => {
      requireExactObject(bucket, BUCKET_FIELDS);
      if (!Number.isSafeInteger(bucket.width) || bucket.width < 1 ||
          bucket.width > MAX_HOST_LENGTH) {
        throw verificationError('MALFORMED_BUCKET_STRUCTURE');
      }
      const routeIndex = ROUTE_REFS.indexOf(bucket.routeRef);
      if (routeIndex === -1) {
        throw verificationError('INVALID_ROUTE_REFERENCE');
      }
      if (bucket.width < previousWidth ||
          (bucket.width === previousWidth &&
           routeIndex <= previousRouteIndex)) {
        throw verificationError('UNSORTED_BUCKETS');
      }
      previousWidth = bucket.width;
      previousRouteIndex = routeIndex;
      const ruleCount = validateBucketHosts(bucket.hosts, bucket.width);
      const sameWidthBuckets = bucketsByWidth.get(bucket.width) || [];
      for (const existingHosts of sameWidthBuckets) {
        if (fixedBucketsOverlap(existingHosts, bucket.hosts, bucket.width)) {
          throw verificationError('DUPLICATE_RULE');
        }
      }
      sameWidthBuckets.push(bucket.hosts);
      bucketsByWidth.set(bucket.width, sameWidthBuckets);
      actualRuleCount += ruleCount;
      if (actualRuleCount > MAX_RULES) {
        throw verificationError('TOO_MANY_RULES');
      }
      return {
        width: bucket.width,
        routeRef: bucket.routeRef,
        hosts: bucket.hosts,
      };
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
      MAX_HOST_LENGTH,
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
