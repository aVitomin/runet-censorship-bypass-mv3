'use strict';

(function(exports) {

  const MAX_CUSTOM_PROVIDER_URLS = 10;
  const MAX_CUSTOM_PROVIDER_LABEL_LENGTH = 80;
  const MAX_CUSTOM_PROVIDER_DESCRIPTION_LENGTH = 500;
  const CUSTOM_PROVIDER_KEY_PATTERN = /^custom:[a-z0-9][a-z0-9-]{7,80}$/;

  // Keep this metadata in sync with the legacy provider list where practical.
  const BUILT_IN_PROVIDERS = Object.freeze([
    {
      key: 'Антизапрет',
      label: 'Antizapret',
      description: 'Main PAC script from the Antizapret project.',
      urls: Object.freeze([
        'https://e.cen.rodeo:8443/proxy.pac',
        'https://antizapret.prostovpn.org:8443/proxy.pac',
        'https://antizapret.prostovpn.org:18443/proxy.pac',
        'https://antizapret.prostovpn.org/proxy.pac',
      ]),
      order: 0,
    },
    {
      key: 'Антицензорити',
      label: 'Anticensority',
      description: 'Alternative PAC script from the extension authors.',
      urls: Object.freeze([
        'https://anticensority.github.io/generated-pac-scripts/anticensority.pac',
        'https://raw.githubusercontent.com/anticensority/generated-pac-scripts/master/anticensority.pac',
      ]),
      order: 1,
    },
    {
      key: 'onlyOwnSites',
      label: 'Only own sites and only own proxies',
      description: 'Placeholder provider for manually configured own sites.',
      urls: Object.freeze([
        'data:application/x-ns-proxy-autoconfig,function%20FindProxyForURL%28%29%7B%20return%20%22DIRECT%22%3B%20%7D',
      ]),
      order: 99,
    },
  ]);

  function createValidationError(code, message) {

    const error = new TypeError(message);
    error.code = code;
    return error;

  }

  function isObject(value) {

    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);

  }

  function sanitizeDisplayText(value) {

    return Array.from(String(value || ''))
        .map((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127 ? ' ' : character;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim();

  }

  function normalizeDisplayText(value, fieldName, maxLength, ifRequired) {

    const text = sanitizeDisplayText(value);
    if (ifRequired && !text) {
      throw createValidationError(
          'CUSTOM_PROVIDER_LABEL_REQUIRED',
          'Custom provider name is required.',
      );
    }
    if (text.length > maxLength) {
      throw createValidationError(
          `CUSTOM_PROVIDER_${fieldName.toUpperCase()}_TOO_LONG`,
          `Custom provider ${fieldName} is too long.`,
      );
    }
    return text;

  }

  function isLocalHttpHost(hostname) {

    const host = String(hostname || '').toLowerCase();
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);

  }

  function normalizeCustomPacUrl(value) {

    const text = String(value || '').trim();
    let parsed;
    try {
      parsed = new URL(text);
    } catch (err) {
      throw createValidationError(
          'CUSTOM_PROVIDER_URL_INVALID',
          'Custom PAC URL is invalid.',
      );
    }
    const ifHttps = parsed.protocol === 'https:';
    const ifLocalHttp = parsed.protocol === 'http:' &&
      isLocalHttpHost(parsed.hostname);
    if (!ifHttps && !ifLocalHttp) {
      throw createValidationError(
          'CUSTOM_PROVIDER_URL_SCHEME',
          'Custom PAC URLs must use HTTPS, except localhost testing URLs.',
      );
    }
    if (parsed.username || parsed.password) {
      throw createValidationError(
          'CUSTOM_PROVIDER_URL_CREDENTIALS',
          'Custom PAC URLs must not contain credentials.',
      );
    }
    return parsed.toString();

  }

  function normalizeCustomPacUrls(value) {

    const values = Array.isArray(value) ? value :
      String(value || '').split(/\r?\n/g);
    const populated = values.map((item) => String(item || '').trim())
        .filter(Boolean);
    if (!populated.length) {
      throw createValidationError(
          'CUSTOM_PROVIDER_URL_REQUIRED',
          'At least one custom PAC URL is required.',
      );
    }
    if (populated.length > MAX_CUSTOM_PROVIDER_URLS) {
      throw createValidationError(
          'CUSTOM_PROVIDER_TOO_MANY_URLS',
          `A custom provider may have at most ${MAX_CUSTOM_PROVIDER_URLS} URLs.`,
      );
    }
    return Array.from(new Set(populated.map(normalizeCustomPacUrl)));

  }

  function normalizeTimestamp(value, fallback) {

    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;

  }

  function isBuiltInProviderKey(providerKey) {

    return BUILT_IN_PROVIDERS.some((provider) => provider.key === providerKey);

  }

  function isCustomProviderKey(providerKey) {

    return CUSTOM_PROVIDER_KEY_PATTERN.test(String(providerKey || '')) &&
      !isBuiltInProviderKey(providerKey);

  }

  function validateCustomProvider(value, options = {}) {

    const source = isObject(value) ? value : {};
    const key = String(options.key || source.key || '');
    if (!isCustomProviderKey(key)) {
      throw createValidationError(
          'CUSTOM_PROVIDER_KEY_INVALID',
          'Custom provider key is invalid or collides with a built-in provider.',
      );
    }
    const now = normalizeTimestamp(options.now, Date.now());
    const createdAt = normalizeTimestamp(
        options.createdAt === undefined ? source.createdAt : options.createdAt,
        now,
    );
    return {
      key,
      label: normalizeDisplayText(
          source.label,
          'label',
          MAX_CUSTOM_PROVIDER_LABEL_LENGTH,
          true,
      ),
      description: normalizeDisplayText(
          source.description,
          'description',
          MAX_CUSTOM_PROVIDER_DESCRIPTION_LENGTH,
          false,
      ),
      urls: normalizeCustomPacUrls(source.urls),
      enabled: source.enabled !== false,
      createdAt,
      updatedAt: now,
    };

  }

  function normalizeCustomProviders(value) {

    if (!Array.isArray(value)) {
      return [];
    }
    const seenKeys = new Set();
    const providers = [];
    value.forEach((item) => {
      try {
        const stableTimestamp = normalizeTimestamp(
            item && item.updatedAt,
            normalizeTimestamp(item && item.createdAt, 0),
        );
        const provider = validateCustomProvider(item, {
          now: stableTimestamp,
          createdAt: item && item.createdAt,
        });
        if (!seenKeys.has(provider.key)) {
          seenKeys.add(provider.key);
          providers.push(provider);
        }
      } catch (err) {
        // Invalid legacy or damaged entries are excluded from the active registry.
      }
    });
    return providers;

  }

  function cloneBuiltInProvider(provider) {

    return {
      key: provider.key,
      label: provider.label,
      description: provider.description,
      urls: provider.urls.slice(),
      enabled: true,
      order: provider.order,
      type: 'builtIn',
      readOnly: true,
    };

  }

  function cloneCustomProvider(provider) {

    return Object.assign({}, provider, {
      urls: provider.urls.slice(),
      order: null,
      type: 'custom',
      readOnly: false,
    });

  }

  function getBuiltInProviders() {

    return BUILT_IN_PROVIDERS
        .slice()
        .sort((left, right) => left.order - right.order)
        .map(cloneBuiltInProvider);

  }

  function getPacProviders(customProviders = [], options = {}) {

    const custom = normalizeCustomProviders(customProviders)
        .filter((provider) => options.includeDisabled === true || provider.enabled)
        .sort((left, right) =>
          left.label.localeCompare(right.label) ||
          left.key.localeCompare(right.key),
        )
        .map(cloneCustomProvider);
    return getBuiltInProviders().concat(custom);

  }

  function getProviderByKey(providerKey, customProviders = [], options = {}) {

    const provider = getPacProviders(customProviders, options)
        .find((item) => item.key === providerKey);
    return provider || null;

  }

  function hasProvider(providerKey, customProviders = [], options = {}) {

    return Boolean(getProviderByKey(providerKey, customProviders, options));

  }

  function getRandomProviderId() {

    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const values = crypto.getRandomValues(new Uint32Array(4));
      return Array.from(values).map((value) => value.toString(16)).join('-');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  }

  function createCustomProviderKey(customProviders = [], preferredId) {

    const existing = new Set(
        normalizeCustomProviders(customProviders).map((provider) => provider.key),
    );
    const rawId = String(preferredId || getRandomProviderId()).toLowerCase();
    let id = rawId.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
    if (id.length < 8) {
      id = `${id}-provider`;
    }
    id = id.slice(0, 72).replace(/-+$/g, '');
    let key = `custom:${id}`;
    let suffix = 2;
    while (existing.has(key) || isBuiltInProviderKey(key)) {
      key = `custom:${id.slice(0, 68)}-${suffix}`;
      suffix += 1;
    }
    return key;

  }

  function selfTest() {

    const key = 'custom:test-provider-0001';
    const valid = validateCustomProvider({
      label: ' Test PAC ',
      urls: [
        'https://example.com/proxy.pac',
        'https://example.com/proxy.pac',
      ],
    }, {key, now: 100});
    const localhost = validateCustomProvider({
      label: 'Local PAC',
      urls: ['http://127.0.0.1:8765/proxy.pac'],
    }, {key: 'custom:local-provider-01', now: 100});
    const rejectedSchemes = ['file:', 'javascript:', 'data:', 'chrome:']
        .every((scheme) => {
          try {
            validateCustomProvider({
              label: 'Bad PAC',
              urls: [`${scheme}//example.test/proxy.pac`],
            }, {key: 'custom:invalid-provider-01'});
            return false;
          } catch (err) {
            return err instanceof TypeError;
          }
        });
    let builtInCollisionRejected = false;
    try {
      validateCustomProvider({
        label: 'Collision',
        urls: ['https://example.com/proxy.pac'],
      }, {key: 'Антизапрет'});
    } catch (err) {
      builtInCollisionRejected = err.code === 'CUSTOM_PROVIDER_KEY_INVALID';
    }
    const merged = getPacProviders([valid]);
    const disabled = Object.assign({}, valid, {enabled: false});
    return {
      validHttpsAccepted: valid.urls[0] === 'https://example.com/proxy.pac',
      localhostHttpAccepted:
        localhost.urls[0] === 'http://127.0.0.1:8765/proxy.pac',
      duplicateUrlsRemoved: valid.urls.length === 1,
      invalidSchemesRejected: rejectedSchemes,
      builtInCollisionRejected,
      builtInsAreReadOnly:
        getBuiltInProviders().every((provider) => provider.readOnly),
      mergedListIncludesCustom:
        merged.some((provider) => provider.key === key && !provider.readOnly),
      disabledCustomHiddenByDefault:
        !getPacProviders([disabled]).some((provider) => provider.key === key),
      disabledCustomAvailableForManagement:
        getPacProviders([disabled], {includeDisabled: true})
            .some((provider) => provider.key === key),
      customKeyStable:
        createCustomProviderKey([], 'stable-provider-id') ===
        'custom:stable-provider-id',
    };

  }

  exports.mv3Providers = Object.freeze({
    MAX_CUSTOM_PROVIDER_URLS,
    MAX_CUSTOM_PROVIDER_LABEL_LENGTH,
    MAX_CUSTOM_PROVIDER_DESCRIPTION_LENGTH,
    getBuiltInProviders,
    getPacProviders,
    getProviderByKey,
    hasProvider,
    isBuiltInProviderKey,
    isCustomProviderKey,
    validateCustomProvider,
    normalizeCustomProviders,
    createCustomProviderKey,
    selfTest,
  });

})(self);
