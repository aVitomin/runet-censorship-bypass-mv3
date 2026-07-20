'use strict';

/* global mv3Hash, mv3Providers */

(function(exports) {

  // IndexedDB artifact storage supports provider PACs larger than storage.local.
  const MAX_PAC_BYTES = 16 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 30000;

  function createError(code, message, details) {

    return {
      code,
      message,
      details: details === undefined ? null : details,
    };

  }

  function getHeader(headers, name) {

    return headers && headers.get(name) || null;

  }

  function parseContentLength(value) {

    if (!value) {
      return null;
    }
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;

  }

  function validatePacText(text) {

    if (!text || !text.trim()) {
      return createError('PAC_INVALID', 'PAC response is empty.');
    }
    if (!/FindProxyForURL/i.test(text)) {
      return createError(
          'PAC_INVALID',
          'PAC response does not contain FindProxyForURL.',
      );
    }
    return null;

  }

  function createHeaders(cache) {

    const headers = {};
    if (cache && cache.lastModified) {
      headers['If-Modified-Since'] = cache.lastModified;
    }
    if (cache && cache.etag) {
      headers['If-None-Match'] = cache.etag;
    }
    return headers;

  }

  function createTimeoutError() {

    const error = new Error('PAC download timed out.');
    error.name = 'AbortError';
    return error;

  }

  function runCleanup(callback) {

    try {
      Promise.resolve(callback()).catch(() => undefined);
    } catch (err) {
      // Cleanup must not replace the primary download result.
    }

  }

  function createDownloadDeadline() {

    const controller = typeof AbortController === 'undefined' ?
      null :
      new AbortController();
    let activeReader = null;
    let ifAbortRequested = false;
    let ifReaderCancelled = false;
    let ifTimedOut = false;
    let rejectTimeout;
    const timeoutPromise = new Promise((resolve, reject) => {
      rejectTimeout = reject;
    });

    const cancelReader = () => {
      if (
        !activeReader ||
        typeof activeReader.cancel !== 'function'
      ) {
        return;
      }
      if (ifReaderCancelled) {
        return;
      }
      ifReaderCancelled = true;
      runCleanup(() => activeReader.cancel());
    };
    const abort = () => {
      if (controller && !ifAbortRequested) {
        ifAbortRequested = true;
        runCleanup(() => controller.abort());
      }
      cancelReader();
    };
    const timeoutId = setTimeout(() => {
      ifTimedOut = true;
      abort();
      rejectTimeout(createTimeoutError());
    }, FETCH_TIMEOUT_MS);

    return {
      abort,
      clear() {

        clearTimeout(timeoutId);
        activeReader = null;

      },
      setReader(reader) {

        activeReader = reader;
        ifReaderCancelled = false;
        if (ifTimedOut) {
          cancelReader();
        }

      },
      signal: controller && controller.signal,
      throwIfTimedOut() {

        if (ifTimedOut) {
          throw createTimeoutError();
        }

      },
      wait(promise) {

        return Promise.race([promise, timeoutPromise]);

      },
    };

  }

  async function fetchWithDeadline(url, cache) {

    const deadline = createDownloadDeadline();
    const options = {
      headers: createHeaders(cache),
      cache: 'no-cache',
    };
    if (deadline.signal) {
      options.signal = deadline.signal;
    }
    try {
      const response = await deadline.wait(fetch(url, options));
      return {deadline, response};
    } catch (err) {
      deadline.clear();
      throw err;
    }

  }

  function cancelResponseBody(response, deadline) {

    deadline.abort();
    if (
      response &&
      response.body &&
      typeof response.body.cancel === 'function'
    ) {
      runCleanup(() => response.body.cancel());
    }

  }

  function normalizeByteChunk(value) {

    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw createError(
        'PAC_DOWNLOAD_FAILED',
        'PAC response body could not be read.',
    );

  }

  function assertBodySize(byteLength) {

    if (byteLength > MAX_PAC_BYTES) {
      throw createError(
          'PAC_TOO_LARGE',
          'PAC response is larger than the MV3 cache limit.',
          {contentLength: byteLength, maxPacBytes: MAX_PAC_BYTES},
      );
    }

  }

  function decodeUtf8(decoder, bytes, options) {

    try {
      return decoder.decode(bytes, options);
    } catch (err) {
      throw createError(
          'PAC_INVALID_UTF8',
          'PAC response is not valid UTF-8.',
      );
    }

  }

  async function readStreamBody(response, deadline) {

    const decoder = new TextDecoder('utf-8', {fatal: true});
    const segments = [];
    const parts = [];
    let byteLength = 0;
    let ifDone = false;
    let reader = null;
    // Batch tiny decoded chunks, then join each representation only once.
    const appendDecoded = (text) => {
      if (!text) {
        return;
      }
      parts.push(text);
      if (parts.length >= 1024) {
        segments.push(parts.join(''));
        parts.length = 0;
      }
    };
    try {
      reader = response.body.getReader();
      deadline.setReader(reader);
      while (!ifDone) {
        const item = await deadline.wait(reader.read());
        if (!item || item.done) {
          ifDone = true;
          continue;
        }
        const chunk = normalizeByteChunk(item.value);
        const nextLength = byteLength + chunk.byteLength;
        assertBodySize(nextLength);
        byteLength = nextLength;
        appendDecoded(decodeUtf8(decoder, chunk, {stream: true}));
      }
      appendDecoded(decodeUtf8(decoder));
      if (parts.length > 0) {
        segments.push(parts.join(''));
        parts.length = 0;
      }
      const rawPacData = segments.join('');
      segments.length = 0;
      return {
        rawPacData,
        actualLength: byteLength,
      };
    } catch (err) {
      deadline.abort();
      throw err;
    } finally {
      deadline.setReader(null);
      if (reader && typeof reader.releaseLock === 'function') {
        runCleanup(() => reader.releaseLock());
      }
    }

  }

  async function readResponseBody(response, deadline) {

    // Body-bearing Chromium fetch responses expose a byte ReadableStream.
    // Buffering text/arrayBuffer fallbacks could allocate past the byte limit.
    if (
      !response ||
      !response.body ||
      typeof response.body.getReader !== 'function'
    ) {
      cancelResponseBody(response, deadline);
      throw createError(
          'PAC_BODY_UNAVAILABLE',
          'PAC response body is not available as a byte stream.',
      );
    }
    return readStreamBody(response, deadline);

  }

  function createFailure(providerKey, url, error, metadata = {}) {

    return Object.assign({
      ok: false,
      status: 'error',
      providerKey,
      url,
      error,
    }, metadata);

  }

  function isCustomProvider(provider) {

    return provider.type === 'custom' ||
      mv3Providers.isCustomProviderKey(provider.key);

  }

  function isTrustedBuiltInDataUrl(provider, url) {

    if (provider.type !== 'builtIn') {
      return false;
    }
    const builtIn = mv3Providers.getProviderByKey(provider.key);
    return Boolean(
        builtIn &&
        builtIn.readOnly &&
        builtIn.urls.includes(url) &&
        String(url).startsWith('data:'),
    );

  }

  function hasReusableRawArtifact(providerKey, url, cache) {

    return Boolean(
        cache &&
        cache.providerKey === providerKey &&
        cache.url === url &&
        typeof cache.artifactRef === 'string' &&
        cache.artifactRef &&
        typeof cache.rawPacSha256 === 'string' &&
        cache.rawPacSha256 &&
        (cache.etag || cache.lastModified),
    );

  }

  function validateDownloadUrl(url, ifResponseUrl) {

    try {
      mv3Providers.normalizeCustomPacUrl(url);
      return null;
    } catch (err) {
      return createError(
          ifResponseUrl ?
            'PAC_RESPONSE_URL_REJECTED' :
            'PAC_SOURCE_URL_REJECTED',
          ifResponseUrl ?
            'PAC response URL is not allowed.' :
            'PAC source URL is not allowed.',
      );
    }

  }

  async function downloadUrl(provider, url, cache) {

    const providerKey = provider.key;
    const ifCustom = isCustomProvider(provider);
    const ifTrustedData = isTrustedBuiltInDataUrl(provider, url);
    const failureUrl = ifCustom || ifTrustedData ? null : url;
    const reusableCache = hasReusableRawArtifact(providerKey, url, cache) ?
      cache :
      null;
    if (!ifTrustedData) {
      const sourceUrlError = validateDownloadUrl(url, false);
      if (sourceUrlError) {
        return createFailure(providerKey, null, sourceUrlError);
      }
    }

    let accepted = null;
    let deadline = null;
    try {
      const download = await fetchWithDeadline(url, reusableCache);
      const response = download.response;
      deadline = download.deadline;

      if (!ifTrustedData) {
        const responseUrlError = validateDownloadUrl(
            response && response.url,
            true,
        );
        if (responseUrlError) {
          cancelResponseBody(response, deadline);
          return createFailure(providerKey, null, responseUrlError);
        }
      }

      const lastModified = getHeader(response.headers, 'Last-Modified');
      const etag = getHeader(response.headers, 'ETag');
      const contentLength = parseContentLength(
          getHeader(response.headers, 'Content-Length'),
      );

      if (response.status === 304) {
        if (!reusableCache) {
          cancelResponseBody(response, deadline);
          return createFailure(
              providerKey,
              failureUrl,
              createError(
                  'PAC_CACHE_MISSING',
                  'PAC server returned 304 without a reusable raw artifact.',
              ),
          );
        }
        return {
          ok: true,
          status: 'not_modified',
          providerKey,
          url,
          httpStatus: response.status,
          lastModified,
          etag,
          contentLength,
        };
      }

      if (!response.ok) {
        cancelResponseBody(response, deadline);
        return createFailure(
            providerKey,
            failureUrl,
            createError(
                'PAC_DOWNLOAD_FAILED',
                `PAC download failed with HTTP ${response.status}.`,
                {httpStatus: response.status},
            ),
            {
              httpStatus: response.status,
              lastModified,
              etag,
              contentLength,
            },
        );
      }

      if (contentLength !== null && contentLength > MAX_PAC_BYTES) {
        cancelResponseBody(response, deadline);
        return createFailure(
            providerKey,
            failureUrl,
            createError(
                'PAC_TOO_LARGE',
                'PAC response is larger than the MV3 cache limit.',
                {contentLength, maxPacBytes: MAX_PAC_BYTES},
            ),
        );
      }

      const body = await readResponseBody(response, deadline);
      deadline.throwIfTimedOut();
      const validationError = validatePacText(body.rawPacData);
      if (validationError) {
        return createFailure(providerKey, failureUrl, validationError);
      }

      accepted = {
        ok: true,
        status: 'success',
        providerKey,
        url,
        httpStatus: response.status,
        rawPacData: body.rawPacData,
        lastModified,
        etag,
        contentLength: body.actualLength,
      };
    } catch (err) {
      const ifTimeout = err && err.name === 'AbortError';
      const ifSafeBodyError = err && [
        'PAC_BODY_UNAVAILABLE',
        'PAC_INVALID_UTF8',
        'PAC_TOO_LARGE',
      ].includes(err.code);
      return createFailure(
          providerKey,
          failureUrl,
          ifSafeBodyError ? err : createError(
            ifTimeout ? 'PAC_TIMEOUT' : 'PAC_DOWNLOAD_FAILED',
            ifTimeout ? 'PAC download timed out.' : 'PAC download failed.',
          ),
      );
    } finally {
      if (deadline) {
        deadline.clear();
      }
    }

    accepted.sha256 = await mv3Hash.sha256Hex(accepted.rawPacData);
    return accepted;

  }

  function resolveProvider(providerOrKey) {

    if (
      providerOrKey &&
      typeof providerOrKey === 'object' &&
      typeof providerOrKey.key === 'string' &&
      Array.isArray(providerOrKey.urls)
    ) {
      return {
        key: providerOrKey.key,
        urls: providerOrKey.urls.slice(),
        type: providerOrKey.type || (
          mv3Providers.isCustomProviderKey(providerOrKey.key) ?
            'custom' :
            'builtIn'
        ),
      };
    }
    return mv3Providers.getProviderByKey(providerOrKey);

  }

  async function downloadPac(providerOrKey, cache) {

    const provider = resolveProvider(providerOrKey);
    const providerKey = provider ? provider.key : String(providerOrKey || '');
    if (!provider) {
      return createFailure(
          providerKey,
          null,
          createError('PROVIDER_NOT_FOUND', 'PAC provider was not found.'),
      );
    }

    let lastFailure = null;
    for (const url of provider.urls) {
      const result = await downloadUrl(provider, url, cache);
      if (result.ok) {
        return result;
      }
      lastFailure = result;
    }
    return lastFailure || createFailure(
        providerKey,
        null,
        createError('PAC_DOWNLOAD_FAILED', 'PAC provider has no URLs.'),
    );

  }

  exports.mv3PacDownload = Object.freeze({
    MAX_PAC_BYTES,
    downloadPac,
  });

})(self);
