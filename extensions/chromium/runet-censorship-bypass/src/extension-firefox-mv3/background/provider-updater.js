'use strict';
/* global require */

(function publishFirefoxProviderUpdater(root, factory) {

  const dataset = typeof module === 'object' && module.exports ?
    require('../../extension-mv3-common/provider-dataset') :
    root.mv3ProviderDataset;
  const api = factory(dataset, root);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }
  root.rucbFirefoxProviderUpdater = api;

})(typeof globalThis === 'object' ? globalThis : this,
    function(Dataset, root) {

      const MANIFEST_SCHEMA_VERSION = 1;
      const MAX_MANIFEST_BYTES = 256 * 1024;
      const MAX_SIGNATURE_BYTES = 64;
      const MAX_REDIRECTS = 3;
      const DEFAULT_DEADLINE_MS = 15000;
      const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
      const ARTIFACT_PATH_PATTERN =
        /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,511})$/;
      const MANIFEST_FIELDS = Object.freeze([
        'artifactPath',
        'envelope',
        'keyId',
        'providerKey',
        'schemaVersion',
        'sequence',
      ]);
      const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);

      function updaterError(code) {

        const error = new TypeError(code);
        error.code = code;
        return error;

      }

      function rejection(error) {

        return Object.freeze({
          ok: false,
          status: 'REJECTED',
          code: error && error.code ? error.code : 'UPDATE_REJECTED',
        });

      }

      function isPlainObject(value) {

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return false;
        }
        const prototype = Object.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;

      }

      function requireExactObject(value, fields, code) {

        if (!isPlainObject(value)) {
          throw updaterError(code);
        }
        const keys = Object.keys(value);
        if (keys.length !== fields.length ||
            keys.some((key) => !fields.includes(key))) {
          throw updaterError(code);
        }

      }

      function requireIdentifier(value, code) {

        if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
          throw updaterError(code);
        }
        return value;

      }

      function copyBytes(value, code) {

        let source;
        if (value instanceof Uint8Array) {
          source = value;
        } else if (value instanceof ArrayBuffer) {
          source = new Uint8Array(value);
        } else {
          throw updaterError(code);
        }
        const copy = new Uint8Array(source.byteLength);
        copy.set(source);
        return copy;

      }

      function decodeManifest(bytes) {

        if (typeof TextDecoder !== 'function') {
          throw updaterError('UTF8_DECODER_UNAVAILABLE');
        }
        if (bytes.byteLength >= 3 && bytes[0] === 0xef &&
            bytes[1] === 0xbb && bytes[2] === 0xbf) {
          throw updaterError('MANIFEST_UTF8_BOM_REJECTED');
        }
        let text;
        try {
          text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch (_error) {
          throw updaterError('INVALID_MANIFEST_UTF8');
        }
        try {
          return JSON.parse(text);
        } catch (_error) {
          throw updaterError('MALFORMED_UPDATE_MANIFEST');
        }

      }

      function validateArtifactPath(value) {

        if (typeof value !== 'string' ||
            !ARTIFACT_PATH_PATTERN.test(value) ||
            value.startsWith('/') || value.includes('//') ||
            value.split('/').some((part) => part === '.' || part === '..')) {
          throw updaterError('INVALID_ARTIFACT_PATH');
        }
        return value;

      }

      function validateManifest(value, expectedProviderKey) {

        requireExactObject(value, MANIFEST_FIELDS, 'INVALID_UPDATE_MANIFEST');
        if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
          throw updaterError('UNSUPPORTED_UPDATE_MANIFEST_SCHEMA');
        }
        const providerKey = requireIdentifier(
            value.providerKey,
            'INVALID_UPDATE_PROVIDER_KEY',
        );
        if (providerKey !== expectedProviderKey) {
          throw updaterError('UPDATE_PROVIDER_KEY_MISMATCH');
        }
        const keyId = requireIdentifier(value.keyId, 'INVALID_UPDATE_KEY_ID');
        if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) {
          throw updaterError('INVALID_AUTHENTICATED_SEQUENCE');
        }
        if (!isPlainObject(value.envelope) ||
            value.envelope.providerKey !== providerKey) {
          throw updaterError('UPDATE_ENVELOPE_PROVIDER_MISMATCH');
        }
        return Object.freeze({
          schemaVersion: MANIFEST_SCHEMA_VERSION,
          providerKey,
          sequence: value.sequence,
          keyId,
          artifactPath: validateArtifactPath(value.artifactPath),
          envelope: value.envelope,
        });

      }

      function validateHttpsUrl(value, code) {

        let url;
        try {
          url = new URL(value);
        } catch (_error) {
          throw updaterError(code);
        }
        if (url.protocol !== 'https:' || url.username || url.password ||
            url.hash || url.search) {
          throw updaterError(code);
        }
        return url;

      }

      function sameOriginUrl(value, origin, code) {

        const url = validateHttpsUrl(value, code);
        if (url.origin !== origin) {
          throw updaterError(code);
        }
        return url;

      }

      async function readBoundedResponse(response, maximumBytes, sizeCode) {

        const lengthValue = response.headers &&
          typeof response.headers.get === 'function' ?
          response.headers.get('content-length') : null;
        if (lengthValue !== null) {
          const declared = Number(lengthValue);
          if (!Number.isSafeInteger(declared) || declared < 0 ||
              declared > maximumBytes) {
            throw updaterError(sizeCode);
          }
        }
        if (!response.body || typeof response.body.getReader !== 'function') {
          throw updaterError('STREAMING_RESPONSE_REQUIRED');
        }
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const part = await reader.read();
          if (part.done) {
            break;
          }
          const chunk = copyBytes(part.value, 'INVALID_RESPONSE_BYTES');
          total += chunk.byteLength;
          if (total > maximumBytes) {
            try {
              await reader.cancel();
            } catch (_error) {
              // The size rejection remains authoritative if cancellation fails.
            }
            throw updaterError(sizeCode);
          }
          chunks.push(chunk);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        chunks.forEach((chunk) => {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        });
        return bytes;

      }

      function createUpdater(options = {}) {

        const fetchImpl = options.fetchImpl;
        const cryptoSubtle = options.cryptoSubtle;
        const trustedPublicKeys = options.trustedPublicKeys;
        const store = options.store;
        const sha256 = options.sha256;
        const AbortControllerImpl = options.AbortController ||
          root.AbortController;
        const deadlineMs = options.deadlineMs === undefined ?
          DEFAULT_DEADLINE_MS : options.deadlineMs;
        if (typeof fetchImpl !== 'function') {
          throw updaterError('FETCH_IMPLEMENTATION_REQUIRED');
        }
        if (!cryptoSubtle || typeof cryptoSubtle.importKey !== 'function' ||
            typeof cryptoSubtle.verify !== 'function') {
          throw updaterError('ED25519_WEBCRYPTO_REQUIRED');
        }
        if (!(trustedPublicKeys instanceof Map)) {
          throw updaterError('TRUSTED_PUBLIC_KEYS_REQUIRED');
        }
        if (!store || typeof store.stageAuthenticatedCandidate !== 'function') {
          throw updaterError('DATASET_STORE_REQUIRED');
        }
        if (typeof sha256 !== 'function') {
          throw updaterError('SHA256_IMPLEMENTATION_REQUIRED');
        }
        if (typeof AbortControllerImpl !== 'function' ||
            !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 ||
            deadlineMs > 120000) {
          throw updaterError('INVALID_UPDATE_DEADLINE');
        }

        async function fetchBounded(initialUrl, origin, maximumBytes,
            sizeCode, signal) {

          let current = sameOriginUrl(initialUrl, origin, 'UNSAFE_UPDATE_URL');
          for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
            let response;
            try {
              response = await fetchImpl.call(null, current.href, {
                cache: 'no-store',
                credentials: 'omit',
                method: 'GET',
                redirect: 'manual',
                referrerPolicy: 'no-referrer',
                signal,
              });
            } catch (error) {
              if (signal.aborted) {
                throw updaterError('UPDATE_TIMEOUT');
              }
              throw updaterError('UPDATE_FETCH_FAILED');
            }
            if (!response || !Number.isInteger(response.status)) {
              throw updaterError('INVALID_UPDATE_RESPONSE');
            }
            if (REDIRECT_STATUSES.includes(response.status)) {
              if (redirects === MAX_REDIRECTS) {
                throw updaterError('TOO_MANY_UPDATE_REDIRECTS');
              }
              const location = response.headers &&
                typeof response.headers.get === 'function' ?
                response.headers.get('location') : null;
              if (!location) {
                throw updaterError('UNREADABLE_UPDATE_REDIRECT');
              }
              let redirected;
              try {
                redirected = new URL(location, current);
              } catch (_error) {
                throw updaterError('UNSAFE_UPDATE_REDIRECT');
              }
              current = sameOriginUrl(
                  redirected.href,
                  origin,
                  'UNSAFE_UPDATE_REDIRECT',
              );
              continue;
            }
            if (response.status !== 200 || response.redirected === true) {
              throw updaterError('UPDATE_HTTP_STATUS_REJECTED');
            }
            if (response.url) {
              const reported = sameOriginUrl(
                  response.url,
                  origin,
                  'UNSAFE_FINAL_UPDATE_URL',
              );
              if (reported.href !== current.href) {
                throw updaterError('UNEXPECTED_UPDATE_REDIRECT');
              }
            }
            return Object.freeze({
              bytes: await readBoundedResponse(
                  response,
                  maximumBytes,
                  sizeCode,
              ),
              finalUrl: current,
            });
          }
          throw updaterError('TOO_MANY_UPDATE_REDIRECTS');

        }

        async function verifyManifestSignature(manifestBytes, signatureBytes,
            keyId) {

          const rawKey = trustedPublicKeys.get(keyId);
          if (!(rawKey instanceof Uint8Array) || rawKey.byteLength !== 32) {
            throw updaterError('UNKNOWN_UPDATE_KEY_ID');
          }
          let publicKey;
          try {
            publicKey = await cryptoSubtle.importKey(
                'raw',
                copyBytes(rawKey, 'INVALID_UPDATE_PUBLIC_KEY'),
                {name: 'Ed25519'},
                false,
                ['verify'],
            );
          } catch (_error) {
            throw updaterError('ED25519_UNAVAILABLE');
          }
          let valid;
          try {
            valid = await cryptoSubtle.verify(
                {name: 'Ed25519'},
                publicKey,
                signatureBytes,
                manifestBytes,
            );
          } catch (_error) {
            throw updaterError('ED25519_VERIFICATION_FAILED');
          }
          if (valid !== true) {
            throw updaterError('INVALID_UPDATE_SIGNATURE');
          }

        }

        async function runUpdate({manifestUrl, providerKey} = {}, signal) {

          const expectedProviderKey = requireIdentifier(
              providerKey,
              'INVALID_UPDATE_PROVIDER_KEY',
          );
          const initialManifestUrl = validateHttpsUrl(
              manifestUrl,
              'UNSAFE_MANIFEST_URL',
          );
          const origin = initialManifestUrl.origin;
          const manifestResponse = await fetchBounded(
              initialManifestUrl.href,
              origin,
              MAX_MANIFEST_BYTES,
              'UPDATE_MANIFEST_TOO_LARGE',
              signal,
          );
          const untrustedManifest = decodeManifest(manifestResponse.bytes);
          const untrustedKeyId = requireIdentifier(
              untrustedManifest && untrustedManifest.keyId,
              'INVALID_UPDATE_KEY_ID',
          );
          const signatureUrl = new URL(manifestResponse.finalUrl.href);
          signatureUrl.pathname += '.sig';
          const signatureResponse = await fetchBounded(
              signatureUrl.href,
              origin,
              MAX_SIGNATURE_BYTES,
              'INVALID_UPDATE_SIGNATURE_SIZE',
              signal,
          );
          if (signatureResponse.bytes.byteLength !== MAX_SIGNATURE_BYTES) {
            throw updaterError('INVALID_UPDATE_SIGNATURE_SIZE');
          }
          await verifyManifestSignature(
              manifestResponse.bytes,
              signatureResponse.bytes,
              untrustedKeyId,
          );
          const manifest = validateManifest(
              untrustedManifest,
              expectedProviderKey,
          );
          if (manifest.keyId !== untrustedKeyId) {
            throw updaterError('UPDATE_KEY_ID_MISMATCH');
          }
          const artifactUrl = new URL(
              manifest.artifactPath,
              manifestResponse.finalUrl,
          );
          sameOriginUrl(
              artifactUrl.href,
              origin,
              'UNSAFE_ARTIFACT_URL',
          );
          const artifactResponse = await fetchBounded(
              artifactUrl.href,
              origin,
              Dataset.LIMITS.MAX_ARTIFACT_BYTES,
              'ARTIFACT_TOO_LARGE',
              signal,
          );
          const verification = await Dataset.verifyProviderDataset({
            envelope: manifest.envelope,
            artifactBytes: artifactResponse.bytes,
            sha256,
            trust: Dataset.TRUST.REMOTE_AUTHENTICATED,
          });
          if (!verification.ok || verification.activationEligible !== true ||
              verification.dataset.identity.providerKey !==
                expectedProviderKey) {
            throw updaterError(
                verification.code || 'REMOTE_DATASET_VERIFICATION_FAILED',
            );
          }
          return store.stageAuthenticatedCandidate({
            envelope: manifest.envelope,
            artifactBytes: artifactResponse.bytes,
            sequence: manifest.sequence,
          });

        }

        async function fetchAndStage(input) {

          const controller = new AbortControllerImpl();
          let timer = null;
          try {
            return await Promise.race([
              runUpdate(input, controller.signal),
              new Promise((_resolve, reject) => {
                timer = root.setTimeout(() => {
                  controller.abort();
                  reject(updaterError('UPDATE_TIMEOUT'));
                }, deadlineMs);
              }),
            ]);
          } catch (error) {
            return rejection(error);
          } finally {
            if (timer !== null) {
              root.clearTimeout(timer);
            }
          }

        }

        return Object.freeze({fetchAndStage});

      }

      return Object.freeze({
        DEFAULT_DEADLINE_MS,
        MANIFEST_SCHEMA_VERSION,
        MAX_MANIFEST_BYTES,
        MAX_REDIRECTS,
        MAX_SIGNATURE_BYTES,
        createUpdater,
        validateManifest,
      });

    });
