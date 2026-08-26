'use strict';


const boot = Object.freeze({
  id: crypto.randomUUID(),
  startedAt: Date.now(),
});
const proxyErrors = [];

function toHex(bytes) {

  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0'))
      .join('');

}

async function sha256(value) {

  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));

}

function sanitizeError(error) {

  const rawMessage = String(error && error.message || error || 'Unknown error');
  const dataIndex = rawMessage.toLowerCase().indexOf('data:');
  const message = dataIndex === -1 ? rawMessage :
    `${rawMessage.slice(0, dataIndex)}[data URI redacted]`;
  return {
    category: /private|incognito/i.test(message) ? 'private-access' :
      /pac|proxy/i.test(message) ? 'proxy-or-pac' : 'other',
    message,
    name: String(error && error.name || 'Error'),
  };

}

function assertInteger(value, name, minimum, maximum) {

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the accepted test range.`);
  }

}

function assertHost(value, name) {

  if (!/^[a-z0-9.-]+$/u.test(value)) {
    throw new TypeError(`${name} is not a synthetic test hostname.`);
  }

}

function assertProxyResult(value) {

  if (!/^(?:DIRECT|(?:(?:PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5) 127\.0\.0\.1:\d+)(?:; (?:(?:PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5) 127\.0\.0\.1:\d+))*)$/u
      .test(value)) {
    throw new TypeError('proxyResult is outside the accepted local test form.');
  }

}

function makePac(options) {

  const targetBytes = options.targetBytes || 0;
  assertInteger(targetBytes, 'targetBytes', 0, 16 * 1024 * 1024);
  assertHost(options.directHost, 'directHost');
  assertHost(options.proxyHost, 'proxyHost');
  assertHost(options.providerHost, 'providerHost');
  assertProxyResult(options.proxyResult);
  assertProxyResult(options.defaultResult);

  const fillerToken = '__DETERMINISTIC_PROVIDER_DATA__';
  const basePac = [
    "'use strict';",
    `var providerData = ${JSON.stringify(fillerToken)};`,
    'function providerLikeMatch(host) {',
    '  var score = 0;',
    '  for (var i = 0; i < 3; ++i) { score += i; }',
    '  return score === 3 && /(?:^|\\.)qa\\.test$/.test(host);',
    '}',
    'function providerDnsWorks() {',
    "  return dnsResolve('localhost') !== null;",
    '}',
    'function FindProxyForURL(url, host) {',
    `  if (host === ${JSON.stringify(options.directHost)}) return 'DIRECT';`,
    `  if (host === ${JSON.stringify(options.proxyHost)}) ` +
      `return ${JSON.stringify(options.proxyResult)};`,
    `  if (host === ${JSON.stringify(options.providerHost)} && ` +
      'providerLikeMatch(host) && providerDnsWorks()) return \'DIRECT\';',
    '  if (providerData.length < 0 || url.length < 0) return \'DIRECT\';',
    `  return ${JSON.stringify(options.defaultResult)};`,
    '}',
  ].join('\n');
  const baseBytes = new TextEncoder().encode(basePac).byteLength -
    fillerToken.length;
  if (targetBytes && targetBytes < baseBytes) {
    throw new RangeError(`targetBytes must be at least ${baseBytes}.`);
  }
  const fillerLength = targetBytes ? targetBytes - baseBytes : 0;
  const fillerPattern = 'domain.qa.test/route:proxy; direct,regex?dns=1 ';
  const filler = fillerPattern.repeat(
      Math.ceil(fillerLength / fillerPattern.length),
  ).slice(0, fillerLength);
  const pac = basePac.replace(fillerToken, filler);
  return pac;

}

function encodeBase64Utf8(value) {

  const bytes = new TextEncoder().encode(value);
  const chunkSize = 32766;
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let binary = '';
    for (const byte of chunk) {
      binary += String.fromCharCode(byte);
    }
    chunks.push(btoa(binary));
  }
  return chunks.join('');

}

function encodePac(pac, encoding) {

  const prefix = 'data:application/x-ns-proxy-autoconfig;charset=utf-8';
  if (encoding === 'percent') {
    return `${prefix},${encodeURIComponent(pac)}`;
  }
  if (encoding === 'base64') {
    return `${prefix};base64,${encodeBase64Utf8(pac)}`;
  }
  if (encoding === 'malformed') {
    return `${prefix};base64,%%%not-base64%%%`;
  }
  throw new TypeError('Unknown PAC data-URI encoding.');

}

async function describeSettings() {

  const details = await browser.proxy.settings.get({});
  const value = details && details.value || {};
  const autoConfigUrl = typeof value.autoConfigUrl === 'string' ?
    value.autoConfigUrl : '';
  return {
    autoConfigUrlLength: autoConfigUrl.length,
    autoConfigUrlSha256: autoConfigUrl ? await sha256(autoConfigUrl) : null,
    levelOfControl: details.levelOfControl || null,
    proxyType: value.proxyType || null,
  };

}

async function setPac(message) {

  proxyErrors.length = 0;
  const pac = message.rawPac === 'syntax-invalid' ?
    'function FindProxyForURL(url, host) {' :
    message.rawPac === 'missing-function' ?
      "function NotFindProxyForURL() { return 'DIRECT'; }" :
      makePac(message.options);
  const dataUri = encodePac(pac, message.encoding);
  const metadata = {
    encodedLength: dataUri.length,
    encodedSha256: await sha256(dataUri),
    encoding: message.encoding,
    rawBytes: new TextEncoder().encode(pac).byteLength,
    rawSha256: await sha256(pac),
  };
  const startedAt = performance.now();
  let result;
  try {
    result = await browser.proxy.settings.set({
      value: {
        autoConfigUrl: dataUri,
        proxyType: 'autoConfig',
      },
    });
  } catch (error) {
    return {
      ...metadata,
      setAccepted: false,
      setElapsedMs: Math.round(performance.now() - startedAt),
      setError: sanitizeError(error),
      setResult: null,
      settings: await describeSettings(),
    };
  }
  return {
    ...metadata,
    setAccepted: true,
    setElapsedMs: Math.round(performance.now() - startedAt),
    setResult: result,
    settings: await describeSettings(),
  };

}

browser.proxy.onError.addListener((error) => {

  const sanitized = sanitizeError(error);
  proxyErrors.push({
    category: sanitized.category,
    messageLength: sanitized.message.length,
    messageSha256Promise: sha256(sanitized.message),
    name: sanitized.name,
  });

});

browser.runtime.onMessage.addListener(async (message) => {

  try {
    switch (message && message.command) {
      case 'clear':
        return {
          ok: true,
          result: await browser.proxy.settings.clear({}),
          settings: await describeSettings(),
        };
      case 'errors':
        return {
          errors: await Promise.all(proxyErrors.map(async (entry) => ({
            category: entry.category,
            messageLength: entry.messageLength,
            messageSha256: await entry.messageSha256Promise,
            name: entry.name,
          }))),
          ok: true,
        };
      case 'reload':
        browser.runtime.reload();
        return {ok: true};
      case 'setPac':
        return {ok: true, result: await setPac(message)};
      case 'status':
        return {
          boot,
          incognitoAllowed: await browser.extension.isAllowedIncognitoAccess(),
          ok: true,
          settings: await describeSettings(),
        };
      default:
        throw new TypeError('Unknown native PAC feasibility command.');
    }
  } catch (error) {
    return {
      error: sanitizeError(error),
      ok: false,
    };
  }

});
