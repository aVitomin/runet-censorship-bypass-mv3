'use strict';

const Crypto = require('node:crypto');
const Dataset = require('../../extension-mv3-common/provider-dataset');

const PROVIDER_KEY = 'synthetic-provider';

function sha256(bytes) {

  return Crypto.createHash('sha256').update(bytes).digest('hex');

}

function countRules(payload) {

  return payload.buckets.reduce((total, bucket) =>
    total + bucket.hosts.length / bucket.width, 0);

}

function payload(buckets = null) {

  return {
    format: Dataset.PAYLOAD_FORMAT,
    buckets: buckets || [{
      width: 12,
      routeRef: 'PROVIDER_PROXY',
      hosts: 'beta.example',
    }],
  };

}

function artifact(options = {}) {

  const artifactPayload = options.payload || payload();
  const artifactBytes = options.artifactBytes ||
    Buffer.from(JSON.stringify(artifactPayload), 'utf8');
  return {
    envelope: Object.assign({
      schemaVersion: Dataset.SCHEMA_VERSION,
      providerKey: options.providerKey || PROVIDER_KEY,
      datasetVersion: options.datasetVersion || '2026.09.01-test.1',
      generatedAt: '2026-09-01T00:00:00.000Z',
      sourceRevisions: [{
        sourceId: 'synthetic-source',
        revision: 'fixture-only',
      }],
      ruleCount: countRules(artifactPayload),
      artifactByteCount: artifactBytes.byteLength,
      artifactSha256: sha256(artifactBytes),
      routeTableVersion: Dataset.ROUTE_TABLE_VERSION,
    }, options.envelopeOverrides),
    artifactBytes,
    trust: options.trust || Dataset.TRUST.PACKAGED_TRUSTED,
  };

}

function copy(value) {

  if (value === null || value === undefined) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  return structuredClone(value);

}

function memoryBackend() {

  const artifacts = new Map();
  const pointers = new Map();
  const commits = [];
  return {
    artifacts,
    pointers,
    commits,
    async readArtifact(artifactSha256) {

      return copy(artifacts.get(artifactSha256) || null);

    },
    async readPointers(providerKey) {

      return copy(pointers.get(providerKey) || null);

    },
    async commit(nextArtifact, nextPointers) {

      artifacts.set(nextArtifact.artifactSha256, copy(nextArtifact));
      pointers.set(nextPointers.providerKey, copy(nextPointers));
      commits.push({
        artifactSha256: nextArtifact.artifactSha256,
        pointers: copy(nextPointers),
      });

    },
  };

}

module.exports = Object.freeze({
  Dataset,
  PROVIDER_KEY,
  artifact,
  memoryBackend,
  payload,
  sha256,
});
