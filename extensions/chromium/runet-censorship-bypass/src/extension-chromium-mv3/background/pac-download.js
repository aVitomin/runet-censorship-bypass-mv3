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

  async function fetchWithTimeout(url, cache) {

    if (typeof AbortController === 'undefined') {
      return fetch(url, {
        headers: createHeaders(cache),
        cache: 'no-cache',
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, {
        headers: createHeaders(cache),
        cache: 'no-cache',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

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
    const failureUrl = ifCustom ? null : url;
    const ifTrustedData = isTrustedBuiltInDataUrl(provider, url);
    if (!ifTrustedData) {
      const sourceUrlError = validateDownloadUrl(url, false);
      if (sourceUrlError) {
        return createFailure(providerKey, null, sourceUrlError);
      }
    }

    let response;
    try {
      response = await fetchWithTimeout(url, cache);
    } catch (err) {
      const ifTimeout = err && err.name === 'AbortError';
      return createFailure(
          providerKey,
          failureUrl,
          createError(
              ifTimeout ? 'PAC_TIMEOUT' : 'PAC_DOWNLOAD_FAILED',
              ifTimeout ? 'PAC download timed out.' : 'PAC download failed.',
          ),
      );
    }

    if (!ifTrustedData) {
      const responseUrlError = validateDownloadUrl(
          response && response.url,
          true,
      );
      if (responseUrlError) {
        return createFailure(providerKey, null, responseUrlError);
      }
    }

    const lastModified = getHeader(response.headers, 'Last-Modified');
    const etag = getHeader(response.headers, 'ETag');
    const contentLength = parseContentLength(getHeader(response.headers, 'Content-Length'));

    if (response.status === 304) {
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

    const rawPacData = await response.text();
    const actualLength = mv3Hash.getUtf8Length(rawPacData);
    if (actualLength > MAX_PAC_BYTES) {
      return createFailure(
          providerKey,
          failureUrl,
          createError(
              'PAC_TOO_LARGE',
              'PAC response is larger than the MV3 cache limit.',
              {contentLength: actualLength, maxPacBytes: MAX_PAC_BYTES},
          ),
      );
    }

    const validationError = validatePacText(rawPacData);
    if (validationError) {
      return createFailure(
          providerKey,
          failureUrl,
          validationError,
      );
    }

    return {
      ok: true,
      status: 'success',
      providerKey,
      url,
      httpStatus: response.status,
      rawPacData,
      sha256: await mv3Hash.sha256Hex(rawPacData),
      lastModified,
      etag,
      contentLength: contentLength === null ? actualLength : contentLength,
    };

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
