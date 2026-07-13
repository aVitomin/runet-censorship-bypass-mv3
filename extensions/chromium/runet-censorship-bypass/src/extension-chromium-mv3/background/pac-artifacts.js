'use strict';

(function(exports) {

  const BACKEND = 'indexeddb';
  const DB_NAME = 'mv3PacArtifacts';
  const DB_VERSION = 1;
  const RAW_STORE = 'rawPacArtifacts';
  const COOKED_STORE = 'cookedPacArtifacts';

  let dbPromise = null;

  function createError(code, message, details) {

    return {
      code,
      message,
      details: details === undefined ? null : details,
    };

  }

  function createArtifactRef(kind, providerKey, sha256) {

    return `${kind}:${encodeURIComponent(providerKey)}:${sha256}`;

  }

  function normalizeError(err, code, message) {

    if (err && err.code && err.message) {
      return err;
    }
    return createError(code, err && err.message ? err.message : message);

  }

  function requestToPromise(request, code, message) {

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(createError(
          code,
          request.error && request.error.message || message,
      ));
    });

  }

  function transactionToPromise(transaction, code, message) {

    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(createError(
          code,
          transaction.error && transaction.error.message || message,
      ));
      transaction.onerror = () => reject(createError(
          code,
          transaction.error && transaction.error.message || message,
      ));
    });

  }

  function openDb() {

    if (dbPromise) {
      return dbPromise;
    }
    if (typeof indexedDB === 'undefined') {
      dbPromise = Promise.reject(createError(
          'PAC_ARTIFACT_STORE_FAILED',
          'IndexedDB is unavailable in this extension context.',
      ));
      return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        [RAW_STORE, COOKED_STORE].forEach((storeName) => {
          if (!db.objectStoreNames.contains(storeName)) {
            const store = db.createObjectStore(storeName, {keyPath: 'artifactRef'});
            store.createIndex('providerKey', 'providerKey', {unique: false});
          }
        });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(createError(
          'PAC_ARTIFACT_STORE_FAILED',
          request.error && request.error.message || 'Failed to open PAC artifacts DB.',
      ));
      request.onblocked = () => reject(createError(
          'PAC_ARTIFACT_STORE_FAILED',
          'PAC artifacts DB upgrade was blocked.',
      ));
    });
    return dbPromise;

  }

  async function runStore(storeName, mode, callback, code, message) {

    try {
      const db = await openDb();
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const completePromise = transactionToPromise(transaction, code, message);
      const result = await callback(store);
      await completePromise;
      return result;
    } catch (err) {
      throw normalizeError(err, code, message);
    }

  }

  function assertArtifactInput(value, name) {

    if (!value || typeof value !== 'object') {
      throw createError(
          'VALIDATION_ERROR',
          `${name} must be an object.`,
      );
    }

  }

  function getTextSize(text) {

    if (typeof TextEncoder === 'undefined') {
      return text.length;
    }
    return new TextEncoder().encode(text).byteLength;

  }

  function summarizeRawArtifact(artifact) {

    if (!artifact) {
      return null;
    }
    return {
      artifactRef: artifact.artifactRef,
      providerKey: artifact.providerKey,
      url: artifact.url,
      fetchedAt: artifact.fetchedAt,
      rawPacSha256: artifact.rawPacSha256,
      rawPacSize: artifact.rawPacSize,
      lastModified: artifact.lastModified,
      etag: artifact.etag,
    };

  }

  function summarizeCookedArtifact(artifact) {

    if (!artifact) {
      return null;
    }
    return {
      artifactRef: artifact.artifactRef,
      providerKey: artifact.providerKey,
      cookedAt: artifact.cookedAt,
      sourceRawPacSha256: artifact.sourceRawPacSha256,
      pacModsSha256: artifact.pacModsSha256,
      cookedPacSha256: artifact.cookedPacSha256,
      cookedPacSize: artifact.cookedPacSize,
      warnings: artifact.warnings || [],
    };

  }

  async function putRawPacArtifact(input) {

    assertArtifactInput(input, 'raw PAC artifact');
    const artifactRef = createArtifactRef(
        'raw',
        input.providerKey,
        input.rawPacSha256,
    );
    const artifact = {
      artifactRef,
      providerKey: input.providerKey,
      url: input.url || null,
      rawPacData: input.rawPacData,
      rawPacSha256: input.rawPacSha256,
      rawPacSize: input.contentLength || getTextSize(input.rawPacData || ''),
      fetchedAt: input.fetchedAt || Date.now(),
      lastModified: input.lastModified || null,
      etag: input.etag || null,
      updatedAt: Date.now(),
    };

    await runStore(
        RAW_STORE,
        'readwrite',
        (store) => requestToPromise(
            store.put(artifact),
            'PAC_ARTIFACT_STORE_FAILED',
            'Failed to store raw PAC artifact.',
        ),
        'PAC_ARTIFACT_STORE_FAILED',
        'Failed to store raw PAC artifact.',
    );
    return summarizeRawArtifact(artifact);

  }

  async function getRawPacArtifact({providerKey, sha256}) {

    const artifactRef = createArtifactRef('raw', providerKey, sha256);
    return runStore(
        RAW_STORE,
        'readonly',
        (store) => requestToPromise(
            store.get(artifactRef),
            'PAC_ARTIFACT_READ_FAILED',
            'Failed to read raw PAC artifact.',
        ),
        'PAC_ARTIFACT_READ_FAILED',
        'Failed to read raw PAC artifact.',
    );

  }

  async function getLatestRawPacArtifact({providerKey}) {

    const artifacts = await runStore(
        RAW_STORE,
        'readonly',
        (store) => requestToPromise(
            store.index('providerKey').getAll(providerKey),
            'PAC_ARTIFACT_READ_FAILED',
            'Failed to read raw PAC artifacts.',
        ),
        'PAC_ARTIFACT_READ_FAILED',
        'Failed to read raw PAC artifacts.',
    );
    return artifacts.reduce((latest, artifact) => {
      if (!latest || artifact.fetchedAt > latest.fetchedAt) {
        return artifact;
      }
      return latest;
    }, null);

  }

  async function deleteRawPacArtifact({providerKey, sha256}) {

    const artifactRef = createArtifactRef('raw', providerKey, sha256);
    await runStore(
        RAW_STORE,
        'readwrite',
        (store) => requestToPromise(
            store.delete(artifactRef),
            'PAC_ARTIFACT_DELETE_FAILED',
            'Failed to delete raw PAC artifact.',
        ),
        'PAC_ARTIFACT_DELETE_FAILED',
        'Failed to delete raw PAC artifact.',
    );

  }

  async function putCookedPacArtifact(input) {

    assertArtifactInput(input, 'cooked PAC artifact');
    const artifactRef = createArtifactRef(
        'cooked',
        input.providerKey,
        input.cookedPacSha256,
    );
    const artifact = {
      artifactRef,
      providerKey: input.providerKey,
      cookedPacData: input.cookedPacData,
      cookedPacSha256: input.cookedPacSha256,
      cookedPacSize: input.cookedPacSize || getTextSize(input.cookedPacData || ''),
      sourceRawPacSha256: input.sourceRawPacSha256,
      pacModsSha256: input.pacModsSha256,
      cookedAt: input.cookedAt || Date.now(),
      warnings: Array.isArray(input.warnings) ? input.warnings : [],
      updatedAt: Date.now(),
    };

    await runStore(
        COOKED_STORE,
        'readwrite',
        (store) => requestToPromise(
            store.put(artifact),
            'PAC_ARTIFACT_STORE_FAILED',
            'Failed to store cooked PAC artifact.',
        ),
        'PAC_ARTIFACT_STORE_FAILED',
        'Failed to store cooked PAC artifact.',
    );
    return summarizeCookedArtifact(artifact);

  }

  async function getCookedPacArtifact({providerKey, sha256}) {

    const artifactRef = createArtifactRef('cooked', providerKey, sha256);
    return runStore(
        COOKED_STORE,
        'readonly',
        (store) => requestToPromise(
            store.get(artifactRef),
            'PAC_ARTIFACT_READ_FAILED',
            'Failed to read cooked PAC artifact.',
        ),
        'PAC_ARTIFACT_READ_FAILED',
        'Failed to read cooked PAC artifact.',
    );

  }

  async function getLatestCookedPacArtifact({providerKey}) {

    const artifacts = await runStore(
        COOKED_STORE,
        'readonly',
        (store) => requestToPromise(
            store.index('providerKey').getAll(providerKey),
            'PAC_ARTIFACT_READ_FAILED',
            'Failed to read cooked PAC artifacts.',
        ),
        'PAC_ARTIFACT_READ_FAILED',
        'Failed to read cooked PAC artifacts.',
    );
    return artifacts.reduce((latest, artifact) => {
      if (!latest || artifact.cookedAt > latest.cookedAt) {
        return artifact;
      }
      return latest;
    }, null);

  }

  async function deleteCookedPacArtifact({providerKey, sha256}) {

    const artifactRef = createArtifactRef('cooked', providerKey, sha256);
    await runStore(
        COOKED_STORE,
        'readwrite',
        (store) => requestToPromise(
            store.delete(artifactRef),
            'PAC_ARTIFACT_DELETE_FAILED',
            'Failed to delete cooked PAC artifact.',
        ),
        'PAC_ARTIFACT_DELETE_FAILED',
        'Failed to delete cooked PAC artifact.',
    );

  }

  async function clearStore(storeName, providerKey) {

    if (!providerKey) {
      await runStore(
          storeName,
          'readwrite',
          (store) => requestToPromise(
              store.clear(),
              'PAC_ARTIFACT_DELETE_FAILED',
              'Failed to clear PAC artifacts.',
          ),
          'PAC_ARTIFACT_DELETE_FAILED',
          'Failed to clear PAC artifacts.',
      );
      return;
    }

    const artifacts = await runStore(
        storeName,
        'readonly',
        (store) => requestToPromise(
            store.index('providerKey').getAll(providerKey),
            'PAC_ARTIFACT_READ_FAILED',
            'Failed to read PAC artifacts.',
        ),
        'PAC_ARTIFACT_READ_FAILED',
        'Failed to read PAC artifacts.',
    );
    await runStore(
        storeName,
        'readwrite',
        (store) => Promise.all(artifacts.map((artifact) => requestToPromise(
            store.delete(artifact.artifactRef),
            'PAC_ARTIFACT_DELETE_FAILED',
            'Failed to delete PAC artifact.',
        ))),
        'PAC_ARTIFACT_DELETE_FAILED',
        'Failed to delete PAC artifacts.',
    );

  }

  async function clearPacArtifacts({providerKey} = {}) {

    await clearStore(RAW_STORE, providerKey || null);
    await clearStore(COOKED_STORE, providerKey || null);

  }

  function getStatus() {

    return {
      backend: BACKEND,
      dbName: DB_NAME,
      schemaVersion: DB_VERSION,
    };

  }

  function selfTest() {

    const rawRef = createArtifactRef('raw', 'provider key', 'abc123');
    const cookedRef = createArtifactRef('cooked', 'provider key', 'def456');
    return {
      backendIsIndexedDb: BACKEND === 'indexeddb',
      rawRefIncludesKind: rawRef.startsWith('raw:'),
      cookedRefIncludesKind: cookedRef.startsWith('cooked:'),
      rawSummaryDropsData: !Object.prototype.hasOwnProperty.call(
          summarizeRawArtifact({
            artifactRef: rawRef,
            providerKey: 'provider key',
            rawPacData: 'function FindProxyForURL(){}',
            rawPacSha256: 'abc123',
          }),
          'rawPacData',
      ),
      cookedSummaryDropsData: !Object.prototype.hasOwnProperty.call(
          summarizeCookedArtifact({
            artifactRef: cookedRef,
            providerKey: 'provider key',
            cookedPacData: 'function FindProxyForURL(){}',
            cookedPacSha256: 'def456',
          }),
          'cookedPacData',
      ),
    };

  }

  exports.mv3PacArtifacts = Object.freeze({
    BACKEND,
    getStatus,
    putRawPacArtifact,
    getRawPacArtifact,
    getLatestRawPacArtifact,
    deleteRawPacArtifact,
    putCookedPacArtifact,
    getCookedPacArtifact,
    getLatestCookedPacArtifact,
    deleteCookedPacArtifact,
    clearPacArtifacts,
    selfTest,
  });

})(self);
