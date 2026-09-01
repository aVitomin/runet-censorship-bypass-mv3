'use strict';
/* global require */

(function publishFirefoxDatasetStore(root, factory) {

  const dataset = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/provider-dataset') :
    root.mv3ProviderDataset;
  const datasetState = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/provider-dataset-state') :
    root.mv3ProviderDatasetState;
  const api = factory(dataset, datasetState);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxDatasetStore = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(Dataset, DatasetState) {

      const DATABASE_NAME = 'rucb-firefox-provider-datasets-v1';
      const DATABASE_VERSION = 1;
      const POINTER_SCHEMA_VERSION = 1;
      const ARTIFACT_STORE = 'artifacts';
      const POINTER_STORE = 'providerPointers';
      const SHA256_PATTERN = /^[a-f0-9]{64}$/;
      const PROVIDER_KEY_PATTERN =
        /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
      const POINTER_FIELDS = Object.freeze([
        'activeArtifactSha256',
        'packagedBaselineArtifactSha256',
        'previousLkgArtifactSha256',
      ]);
      const POINTER_RECORD_FIELDS = Object.freeze([
        'activeArtifactSha256',
        'packagedBaselineArtifactSha256',
        'previousLkgArtifactSha256',
        'providerKey',
        'schemaVersion',
      ]);
      const ARTIFACT_RECORD_FIELDS = Object.freeze([
        'artifactBytes',
        'artifactSha256',
        'envelope',
        'providerKey',
        'trust',
      ]);

      function storeError(code) {

        const error = new TypeError(code);
        error.code = code;
        return error;

      }

      function rejection(code) {

        return Object.freeze({
          ok: false,
          status: 'REJECTED',
          code,
        });

      }

      function isProviderKey(value) {

        return typeof value === 'string' && PROVIDER_KEY_PATTERN.test(value);

      }

      function isSha256(value) {

        return typeof value === 'string' && SHA256_PATTERN.test(value);

      }

      function emptyPointers(providerKey) {

        if (!isProviderKey(providerKey)) {
          throw storeError('INVALID_PROVIDER_KEY');
        }
        return {
          schemaVersion: POINTER_SCHEMA_VERSION,
          providerKey,
          activeArtifactSha256: null,
          previousLkgArtifactSha256: null,
          packagedBaselineArtifactSha256: null,
        };

      }

      function normalizePointers(value, providerKey) {

        const normalized = emptyPointers(providerKey);
        const corruptions = {};
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== POINTER_RECORD_FIELDS.length ||
            Object.keys(value).some((key) =>
              !POINTER_RECORD_FIELDS.includes(key)) ||
            value.schemaVersion !== POINTER_SCHEMA_VERSION ||
            value.providerKey !== providerKey) {
          POINTER_FIELDS.forEach((field) => {
            corruptions[field] = value !== null && value !== undefined;
          });
          return {pointers: normalized, corruptions};
        }
        for (const field of POINTER_FIELDS) {
          const pointer = value[field];
          if (pointer === null || pointer === undefined) {
            normalized[field] = null;
          } else if (isSha256(pointer)) {
            normalized[field] = pointer;
          } else {
            corruptions[field] = true;
          }
        }
        return {pointers: normalized, corruptions};

      }

      function copyBytes(value) {

        let source;
        if (value instanceof Uint8Array) {
          source = value;
        } else if (value instanceof ArrayBuffer) {
          source = new Uint8Array(value);
        } else {
          throw storeError('UNSUPPORTED_ARTIFACT_BYTES');
        }
        const copy = new Uint8Array(source.byteLength);
        copy.set(source);
        return copy;

      }

      function artifactRecord(verification, artifactBytes) {

        const identity = verification.dataset.identity;
        return {
          artifactSha256: identity.artifactSha256,
          providerKey: identity.providerKey,
          trust: verification.trust,
          envelope: verification.dataset.envelope,
          artifactBytes: copyBytes(artifactBytes),
        };

      }

      function sameBytes(leftValue, rightValue) {

        const left = copyBytes(leftValue);
        const right = copyBytes(rightValue);
        if (left.byteLength !== right.byteLength) {
          return false;
        }
        for (let index = 0; index < left.byteLength; index += 1) {
          if (left[index] !== right[index]) {
            return false;
          }
        }
        return true;

      }

      function sameArtifact(left, right) {

        return Boolean(
            left && right &&
            left.artifactSha256 === right.artifactSha256 &&
            left.providerKey === right.providerKey &&
            left.trust === right.trust &&
            JSON.stringify(left.envelope) === JSON.stringify(right.envelope) &&
            sameBytes(left.artifactBytes, right.artifactBytes),
        );

      }

      function createIndexedDbBackend(indexedDb, options = {}) {

        if (!indexedDb || typeof indexedDb.open !== 'function') {
          throw storeError('INDEXED_DB_UNAVAILABLE');
        }
        const databaseName = options.databaseName || DATABASE_NAME;
        let databasePromise;

        function openDatabase() {

          if (!databasePromise) {
            databasePromise = new Promise((resolve, reject) => {
              const request = indexedDb.open(databaseName, DATABASE_VERSION);
              request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(ARTIFACT_STORE)) {
                  database.createObjectStore(ARTIFACT_STORE, {
                    keyPath: 'artifactSha256',
                  });
                }
                if (!database.objectStoreNames.contains(POINTER_STORE)) {
                  database.createObjectStore(POINTER_STORE, {
                    keyPath: 'providerKey',
                  });
                }
              };
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(
                  request.error || storeError('INDEXED_DB_OPEN_FAILED'),
              );
              request.onblocked = () => reject(
                  storeError('INDEXED_DB_OPEN_BLOCKED'),
              );
            });
          }
          return databasePromise;

        }

        async function read(storeName, key) {

          const database = await openDatabase();
          return new Promise((resolve, reject) => {
            const transaction = database.transaction(storeName, 'readonly');
            const request = transaction.objectStore(storeName).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(
                request.error || storeError('INDEXED_DB_READ_FAILED'),
            );
            transaction.onabort = () => reject(
                transaction.error || storeError('INDEXED_DB_READ_ABORTED'),
            );
          });

        }

        async function commit(nextArtifact, nextPointers) {

          const database = await openDatabase();
          return new Promise((resolve, reject) => {
            const transaction = database.transaction(
                [ARTIFACT_STORE, POINTER_STORE],
                'readwrite',
            );
            const artifacts = transaction.objectStore(ARTIFACT_STORE);
            const pointers = transaction.objectStore(POINTER_STORE);
            let failure = null;
            const existingRequest = artifacts.get(
                nextArtifact.artifactSha256,
            );
            existingRequest.onsuccess = () => {
              try {
                const existing = existingRequest.result;
                if (existing && !sameArtifact(existing, nextArtifact)) {
                  failure = storeError('IMMUTABLE_ARTIFACT_CONFLICT');
                  transaction.abort();
                  return;
                }
                if (!existing) {
                  artifacts.add(nextArtifact);
                }
                pointers.put(nextPointers);
              } catch (error) {
                failure = error;
                transaction.abort();
              }
            };
            existingRequest.onerror = () => {
              failure = existingRequest.error ||
                storeError('INDEXED_DB_READ_FAILED');
              transaction.abort();
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => {};
            transaction.onabort = () => reject(
                failure || transaction.error ||
                storeError('INDEXED_DB_COMMIT_ABORTED'),
            );
          });

        }

        return Object.freeze({
          commit,
          readArtifact(artifactSha256) {

            return read(ARTIFACT_STORE, artifactSha256);

          },
          readPointers(providerKey) {

            return read(POINTER_STORE, providerKey);

          },
        });

      }

      function createStore({backend, sha256} = {}) {

        if (!backend || typeof backend.readArtifact !== 'function' ||
            typeof backend.readPointers !== 'function' ||
            typeof backend.commit !== 'function') {
          throw storeError('INVALID_DATASET_STORE_BACKEND');
        }
        if (typeof sha256 !== 'function') {
          throw storeError('SHA256_IMPLEMENTATION_REQUIRED');
        }

        async function verifyInput(input) {

          return Dataset.verifyProviderDataset(Object.assign({}, input, {
            sha256,
          }));

        }

        async function readPointerState(providerKey) {

          try {
            return normalizePointers(
                await backend.readPointers(providerKey),
                providerKey,
            );
          } catch (_error) {
            const normalized = normalizePointers(null, providerKey);
            POINTER_FIELDS.forEach((field) => {
              normalized.corruptions[field] = true;
            });
            return normalized;
          }

        }

        async function verifyStored(providerKey, artifactSha256, code) {

          if (!artifactSha256) {
            return null;
          }
          let record;
          try {
            record = await backend.readArtifact(artifactSha256);
          } catch (_error) {
            return rejection(`${code}_UNREADABLE`);
          }
          if (!record) {
            return rejection(`${code}_MISSING`);
          }
          try {
            if (!record || typeof record !== 'object' ||
                Array.isArray(record) ||
                Object.keys(record).length !== ARTIFACT_RECORD_FIELDS.length ||
                Object.keys(record).some((key) =>
                  !ARTIFACT_RECORD_FIELDS.includes(key)) ||
                record.providerKey !== providerKey ||
                record.artifactSha256 !== artifactSha256 ||
                !record.envelope ||
                record.envelope.providerKey !== providerKey ||
                record.envelope.artifactSha256 !== artifactSha256) {
              return rejection(`${code}_IDENTITY_MISMATCH`);
            }
            return verifyInput({
              envelope: record.envelope,
              artifactBytes: copyBytes(record.artifactBytes),
              trust: record.trust,
            });
          } catch (_error) {
            return rejection(`${code}_MALFORMED`);
          }

        }

        async function loadVerifications(providerKey, options = {}) {

          if (!isProviderKey(providerKey)) {
            throw storeError('INVALID_PROVIDER_KEY');
          }
          const pointerState = await readPointerState(providerKey);
          const roles = [
            ['active', 'activeArtifactSha256', 'ACTIVE_ARTIFACT'],
            ['previousLkg', 'previousLkgArtifactSha256', 'LKG_ARTIFACT'],
            [
              'packagedBaseline',
              'packagedBaselineArtifactSha256',
              'PACKAGED_BASELINE_ARTIFACT',
            ],
          ];
          const result = {pointers: pointerState.pointers};
          for (const [role, field, code] of roles) {
            if (pointerState.corruptions[field]) {
              result[role] = rejection(`${code}_POINTER_CORRUPT`);
            } else {
              result[role] = await verifyStored(
                  providerKey,
                  pointerState.pointers[field],
                  code,
              );
            }
            if (options.firstUsableOnly === true &&
                result[role] && result[role].ok === true) {
              break;
            }
          }
          roles.forEach(([role]) => {
            if (!Object.prototype.hasOwnProperty.call(result, role)) {
              result[role] = null;
            }
          });
          return result;

        }

        async function commitPackagedBaseline(input) {

          const verification = await verifyInput(input);
          if (!verification.ok ||
              verification.trust !== Dataset.TRUST.PACKAGED_TRUSTED) {
            return verification.ok ?
              rejection('PACKAGED_BASELINE_TRUST_REQUIRED') : verification;
          }
          const providerKey = verification.dataset.identity.providerKey;
          const current = await readPointerState(providerKey);
          const pointers = current.pointers;
          pointers.packagedBaselineArtifactSha256 =
            verification.dataset.identity.artifactSha256;
          await backend.commit(
              artifactRecord(verification, input.artifactBytes),
              pointers,
          );
          return verification;

        }

        async function activateCandidate(input) {

          const candidate = await verifyInput(input);
          const providerKey = input && input.envelope &&
            input.envelope.providerKey;
          if (!isProviderKey(providerKey)) {
            return candidate.ok ? rejection('INVALID_PROVIDER_KEY') : candidate;
          }
          const stored = await loadVerifications(providerKey);
          const plan = DatasetState.planDatasetActivation({
            protectionIntended: true,
            providerKey,
            active: stored.active,
            previousLkg: stored.previousLkg,
            packagedBaseline: stored.packagedBaseline,
            candidate,
          });
          if (plan.kind !== DatasetState.ACTIONS.ACTIVATE_CANDIDATE) {
            return Object.freeze({verification: candidate, plan});
          }
          if (candidate.trust !== Dataset.TRUST.REMOTE_AUTHENTICATED) {
            return Object.freeze({
              verification: candidate,
              plan: {
                kind: DatasetState.ACTIONS.KEEP_ACTIVE,
                selected: plan.previousLkg || null,
                candidateRejection: 'AUTHENTICATED_CANDIDATE_REQUIRED',
              },
            });
          }
          const pointers = stored.pointers;
          pointers.previousLkgArtifactSha256 = plan.previousLkg ?
            plan.previousLkg.artifactSha256 : null;
          pointers.activeArtifactSha256 =
            candidate.dataset.identity.artifactSha256;
          await backend.commit(
              artifactRecord(candidate, input.artifactBytes),
              pointers,
          );
          return Object.freeze({verification: candidate, plan});

        }

        return Object.freeze({
          activateCandidate,
          commitPackagedBaseline,
          loadVerifications,
        });

      }

      return Object.freeze({
        DATABASE_NAME,
        DATABASE_VERSION,
        POINTER_SCHEMA_VERSION,
        createIndexedDbBackend,
        createStore,
        emptyPointers,
        normalizePointers,
      });

    });
