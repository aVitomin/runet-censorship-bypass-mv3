'use strict';
/* global require */

(function publishFirefoxDatasetPromotion(root, factory) {

  const dataset = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/provider-dataset') :
    root.mv3ProviderDataset;
  const productConfig = typeof module === 'object' && module.exports ?
    require('./product-config') : root.rucbFirefoxProductConfig;
  const api = factory(dataset, productConfig);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxDatasetPromotion = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(Dataset, ProductConfig) {

      const JOURNAL_SCHEMA_VERSION = 1;
      const JOURNAL_STATUS = 'PREPARED';
      const JOURNAL_KEYS = Object.freeze([
        'newConfig',
        'oldActiveArtifactSha256',
        'oldConfig',
        'oldPreviousLkgArtifactSha256',
        'providerKey',
        'schemaVersion',
        'sequence',
        'stagedArtifactSha256',
        'status',
      ]);
      const ERRORS = Object.freeze({
        ALREADY_INSTALLED: 'DATASET_PROMOTION_ALREADY_INSTALLED',
        CONFIGURATION_INVALID: 'DATASET_PROMOTION_CONFIGURATION_INVALID',
        DATASET_STORE_FAILED: 'DATASET_PROMOTION_DATASET_STORE_FAILED',
        INVALID_DEPENDENCIES: 'INVALID_DATASET_PROMOTION_DEPENDENCIES',
        NO_STAGED_CANDIDATE: 'NO_STAGED_AUTHENTICATED_DATASET',
        OFF_REQUIRED: 'DATASET_PROMOTION_REQUIRES_OFF',
        POINTER_STATE_INVALID: 'DATASET_PROMOTION_POINTER_STATE_INVALID',
        PROVIDER_MISMATCH: 'DATASET_PROMOTION_PROVIDER_MISMATCH',
        RECOVERY_REQUIRED: 'DATASET_PROMOTION_RECOVERY_REQUIRED',
        SEQUENCE_INVALID: 'DATASET_PROMOTION_SEQUENCE_INVALID',
        STORAGE_FAILED: 'DATASET_PROMOTION_STORAGE_FAILED',
      });
      const SHA256_PATTERN = /^[a-f0-9]{64}$/;

      function promotionError(code) {

        const error = new TypeError(code);
        error.code = code;
        return error;

      }

      function exactKeys(value, keys) {

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false;
        }
        const actual = Object.keys(value).sort();
        const expected = [...keys].sort();
        return actual.length === expected.length &&
          actual.every((key, index) => key === expected[index]);

      }

      function sameIdentity(left, right) {

        return Boolean(left && right &&
          left.providerKey === right.providerKey &&
          left.datasetVersion === right.datasetVersion &&
          left.artifactSha256 === right.artifactSha256);

      }

      function sameConfig(left, right) {

        try {
          return JSON.stringify(
              ProductConfig.canonicalProductConfig(left).config,
          ) === JSON.stringify(
              ProductConfig.canonicalProductConfig(right).config,
          );
        } catch (_error) {
          return false;
        }

      }

      function canonicalJournal(value) {

        if (!exactKeys(value, JOURNAL_KEYS) ||
            value.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
            value.status !== JOURNAL_STATUS ||
            typeof value.providerKey !== 'string' ||
            !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
            typeof value.stagedArtifactSha256 !== 'string' ||
            !SHA256_PATTERN.test(value.stagedArtifactSha256) ||
            !(value.oldActiveArtifactSha256 === null ||
              SHA256_PATTERN.test(value.oldActiveArtifactSha256)) ||
            !(value.oldPreviousLkgArtifactSha256 === null ||
              SHA256_PATTERN.test(value.oldPreviousLkgArtifactSha256))) {
          throw promotionError(ERRORS.RECOVERY_REQUIRED);
        }
        const oldConfig = ProductConfig.canonicalProductConfig(
            value.oldConfig,
        ).config;
        const newConfig = ProductConfig.canonicalProductConfig(
            value.newConfig,
        ).config;
        if (oldConfig.providerKey !== value.providerKey ||
            newConfig.providerKey !== value.providerKey ||
            JSON.stringify(oldConfig.routingDescriptor) !==
              JSON.stringify(newConfig.routingDescriptor) ||
            oldConfig.datasetIdentity.artifactSha256 ===
              value.stagedArtifactSha256 ||
            newConfig.datasetIdentity.artifactSha256 !==
              value.stagedArtifactSha256) {
          throw promotionError(ERRORS.RECOVERY_REQUIRED);
        }
        return Object.freeze(Object.assign({}, value, {oldConfig, newConfig}));

      }

      function createController(options = {}) {

        const storageArea = options.storageArea;
        const datasetStore = options.datasetStore;
        const sha256 = options.sha256;
        const activationSnapshot = options.activationSnapshot;
        const providerKey = options.providerKey;
        if (!storageArea || typeof storageArea.get !== 'function' ||
            typeof storageArea.set !== 'function' ||
            typeof storageArea.remove !== 'function' || !datasetStore ||
            typeof datasetStore.loadStaged !== 'function' ||
            typeof datasetStore.loadVerifications !== 'function' ||
            typeof datasetStore.promoteStagedExact !== 'function' ||
            typeof sha256 !== 'function' ||
            typeof activationSnapshot !== 'function' ||
            typeof providerKey !== 'string') {
          throw promotionError(ERRORS.INVALID_DEPENDENCIES);
        }
        let queue = Promise.resolve();

        function enqueue(operation) {

          const result = queue.then(operation, operation);
          queue = result.catch(() => undefined);
          return result;

        }

        async function readStorage() {

          try {
            const stored = await storageArea.get([
              ProductConfig.CONFIG_STORAGE_KEY,
              ProductConfig.DATASET_PROMOTION_STORAGE_KEY,
              ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY,
            ]);
            if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
              throw new TypeError('invalid storage result');
            }
            return stored;
          } catch (_error) {
            throw promotionError(ERRORS.STORAGE_FAILED);
          }

        }

        async function writeConfig(config) {

          try {
            await storageArea.set({
              [ProductConfig.CONFIG_STORAGE_KEY]: config,
            });
          } catch (_error) {
            throw promotionError(ERRORS.STORAGE_FAILED);
          }

        }

        async function removeJournal() {

          try {
            await storageArea.remove(
                ProductConfig.DATASET_PROMOTION_STORAGE_KEY,
            );
          } catch (_error) {
            throw promotionError(ERRORS.STORAGE_FAILED);
          }

        }

        async function pointerPhase(journal) {

          let verifications;
          let staged;
          try {
            [verifications, staged] = await Promise.all([
              datasetStore.loadVerifications(journal.providerKey),
              datasetStore.loadStaged(journal.providerKey),
            ]);
          } catch (_error) {
            throw promotionError(ERRORS.DATASET_STORE_FAILED);
          }
          const pointers = verifications && verifications.pointers;
          if (!pointers || staged === null || staged === undefined) {
            throw promotionError(ERRORS.POINTER_STATE_INVALID);
          }
          const oldDatasetAvailable = [
            verifications.active,
            verifications.previousLkg,
            verifications.packagedBaseline,
          ].some((verification) => verification &&
            verification.ok === true && sameIdentity(
              verification.dataset.identity,
              journal.oldConfig.datasetIdentity,
          ));
          const authenticatedStateMatches =
            pointers.highestAuthenticatedSequence === journal.sequence &&
            pointers.highestAuthenticatedArtifactSha256 ===
              journal.stagedArtifactSha256;
          const oldPhase =
            authenticatedStateMatches &&
            pointers.activeArtifactSha256 === journal.oldActiveArtifactSha256 &&
            pointers.previousLkgArtifactSha256 ===
              journal.oldPreviousLkgArtifactSha256 &&
            staged.ok === true && staged.status === 'STAGED' &&
            staged.sequence === journal.sequence &&
            staged.verification.dataset.identity.artifactSha256 ===
              journal.stagedArtifactSha256 &&
            oldDatasetAvailable && sameIdentity(
                staged.verification.dataset.identity,
                journal.newConfig.datasetIdentity,
            );
          const newPhase =
            authenticatedStateMatches && oldDatasetAvailable &&
            pointers.activeArtifactSha256 === journal.stagedArtifactSha256 &&
            pointers.previousLkgArtifactSha256 ===
              journal.oldConfig.datasetIdentity.artifactSha256 &&
            staged.ok === true && staged.status === 'EMPTY' &&
            verifications.active && verifications.active.ok === true &&
            verifications.active.trust === Dataset.TRUST.REMOTE_AUTHENTICATED &&
            sameIdentity(
                verifications.active.dataset.identity,
                journal.newConfig.datasetIdentity,
            );
          if (oldPhase === newPhase) {
            throw promotionError(ERRORS.POINTER_STATE_INVALID);
          }
          return oldPhase ? 'OLD' : 'NEW';

        }

        async function recoverNow() {

          const stored = await readStorage();
          const rawJournal = stored[ProductConfig.DATASET_PROMOTION_STORAGE_KEY];
          if (rawJournal === undefined) {
            return Object.freeze({ok: true, status: 'NO_RECOVERY_NEEDED'});
          }
          let journal;
          try {
            journal = canonicalJournal(rawJournal);
            const verified = await Promise.all([
              ProductConfig.verifyProductConfig(journal.oldConfig, sha256),
              ProductConfig.verifyProductConfig(journal.newConfig, sha256),
            ]);
            journal = Object.freeze(Object.assign({}, journal, {
              oldConfig: verified[0].config,
              newConfig: verified[1].config,
            }));
          } catch (_error) {
            throw promotionError(ERRORS.RECOVERY_REQUIRED);
          }
          if (journal.providerKey !== providerKey) {
            throw promotionError(ERRORS.PROVIDER_MISMATCH);
          }
          const phase = await pointerPhase(journal);
          const target = phase === 'OLD' ? journal.oldConfig : journal.newConfig;
          if (!sameConfig(stored[ProductConfig.CONFIG_STORAGE_KEY], target)) {
            await writeConfig(target);
          }
          await removeJournal();
          return Object.freeze({
            ok: true,
            status: phase === 'OLD' ? 'ROLLED_BACK' : 'ROLLED_FORWARD',
          });

        }

        async function installNow() {

          await recoverNow();
          const activation = activationSnapshot();
          if (!activation || activation.active === true ||
              activation.durableIntent !== 'OFF' ||
              activation.runtimeState !== 'OFF') {
            throw promotionError(ERRORS.OFF_REQUIRED);
          }
          const stored = await readStorage();
          if (stored[ProductConfig.SETTINGS_TRANSACTION_STORAGE_KEY] !==
              undefined) {
            throw promotionError(ERRORS.CONFIGURATION_INVALID);
          }
          let verifiedConfig;
          try {
            verifiedConfig = await ProductConfig.verifyProductConfig(
                stored[ProductConfig.CONFIG_STORAGE_KEY],
                sha256,
            );
          } catch (_error) {
            throw promotionError(ERRORS.CONFIGURATION_INVALID);
          }
          const oldConfig = verifiedConfig.config;
          if (oldConfig.providerKey !== providerKey) {
            throw promotionError(ERRORS.PROVIDER_MISMATCH);
          }
          let staged;
          try {
            staged = await datasetStore.loadStaged(providerKey);
          } catch (_error) {
            throw promotionError(ERRORS.DATASET_STORE_FAILED);
          }
          if (!staged || staged.ok !== true || staged.status !== 'STAGED' ||
              !staged.verification || staged.verification.ok !== true ||
              staged.verification.trust !==
                Dataset.TRUST.REMOTE_AUTHENTICATED) {
            throw promotionError(ERRORS.NO_STAGED_CANDIDATE);
          }
          const identity = staged.verification.dataset.identity;
          if (identity.providerKey !== providerKey) {
            throw promotionError(ERRORS.PROVIDER_MISMATCH);
          }
          if (!Number.isSafeInteger(staged.sequence) || staged.sequence < 1 ||
              staged.pointers.highestAuthenticatedSequence !== staged.sequence ||
              staged.pointers.highestAuthenticatedArtifactSha256 !==
                identity.artifactSha256) {
            throw promotionError(ERRORS.SEQUENCE_INVALID);
          }
          if (sameIdentity(identity, oldConfig.datasetIdentity)) {
            throw promotionError(ERRORS.ALREADY_INSTALLED);
          }
          let currentVerifications;
          try {
            currentVerifications = await datasetStore.loadVerifications(
                providerKey,
            );
          } catch (_error) {
            throw promotionError(ERRORS.DATASET_STORE_FAILED);
          }
          if (![currentVerifications.active,
            currentVerifications.previousLkg,
            currentVerifications.packagedBaseline,
          ].some((verification) => verification &&
            verification.ok === true && sameIdentity(
              verification.dataset.identity,
              oldConfig.datasetIdentity,
          ))) {
            throw promotionError(ERRORS.DATASET_STORE_FAILED);
          }
          const newConfig = (await ProductConfig.verifyProductConfig(
              Object.assign({}, oldConfig, {datasetIdentity: identity}),
              sha256,
          )).config;
          const journal = canonicalJournal({
            schemaVersion: JOURNAL_SCHEMA_VERSION,
            status: JOURNAL_STATUS,
            providerKey,
            sequence: staged.sequence,
            stagedArtifactSha256: identity.artifactSha256,
            oldActiveArtifactSha256: staged.pointers.activeArtifactSha256,
            oldPreviousLkgArtifactSha256:
              staged.pointers.previousLkgArtifactSha256,
            oldConfig,
            newConfig,
          });
          try {
            await storageArea.set({
              [ProductConfig.DATASET_PROMOTION_STORAGE_KEY]: journal,
            });
          } catch (_error) {
            throw promotionError(ERRORS.STORAGE_FAILED);
          }
          let promoted;
          try {
            promoted = await datasetStore.promoteStagedExact({
              providerKey,
              stagedArtifactSha256: identity.artifactSha256,
              stagedSequence: staged.sequence,
              currentDatasetIdentity: oldConfig.datasetIdentity,
            });
          } catch (_error) {
            try {
              await recoverNow();
            } catch (_recoveryError) {
              throw promotionError(ERRORS.RECOVERY_REQUIRED);
            }
            throw promotionError(ERRORS.DATASET_STORE_FAILED);
          }
          if (!promoted || promoted.ok !== true) {
            try {
              await recoverNow();
            } catch (_error) {
              throw promotionError(ERRORS.RECOVERY_REQUIRED);
            }
            throw promotionError(ERRORS.DATASET_STORE_FAILED);
          }
          try {
            await writeConfig(newConfig);
            await removeJournal();
          } catch (_error) {
            try {
              await recoverNow();
            } catch (_recoveryError) {
              throw promotionError(ERRORS.RECOVERY_REQUIRED);
            }
          }
          return Object.freeze({ok: true, status: 'INSTALLED'});

        }

        return Object.freeze({
          initialize: () => enqueue(async () => {
            try {
              return await recoverNow();
            } catch (error) {
              return Object.freeze({
                ok: false,
                status: 'RECOVERY_REQUIRED',
                code: error && error.code ? error.code : ERRORS.RECOVERY_REQUIRED,
              });
            }
          }),
          install: () => enqueue(installNow),
        });

      }

      return Object.freeze({
        ERRORS,
        JOURNAL_SCHEMA_VERSION,
        JOURNAL_STATUS,
        canonicalJournal,
        createController,
      });

    });
