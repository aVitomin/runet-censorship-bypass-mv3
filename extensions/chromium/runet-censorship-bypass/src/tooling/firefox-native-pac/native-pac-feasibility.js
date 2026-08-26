'use strict';


const Assert = require('assert');
const ChildProcess = require('child_process');
const Crypto = require('crypto');
const Fs = require('fs');
const Http = require('http');
const Https = require('https');
const Net = require('net');
const Os = require('os');
const Path = require('path');
const Puppeteer = require('puppeteer-core');

const FIXTURE_ROOT = Path.resolve(
    __dirname,
    'fixtures',
    'native-pac-extension',
);
const FIREFOX_TIMEOUT_MS = 30 * 1000;
const PAC_LOAD_TIMEOUT_MS = Number(
    process.env.FIREFOX_PAC_TIMEOUT_MS || 15 * 1000,
);
const EVENT_PAGE_IDLE_WAIT_MS = 35 * 1000;
const HOSTS = Object.freeze({
  control: 'control.qa.test',
  direct: 'direct.qa.test',
  provider: 'provider.qa.test',
  proxy: 'proxy.qa.test',
  route: 'route.qa.test',
});
const SIZE_CASES = Object.freeze([
  {label: 'tiny', bytes: 0},
  {label: '1 MiB', bytes: 1 * 1024 * 1024},
  {label: '8 MiB', bytes: 8 * 1024 * 1024},
  {label: '11.6 MiB', bytes: Math.round(11.6 * 1024 * 1024)},
  {label: 'near 16 MiB', bytes: 16 * 1024 * 1024 - 1024},
]);

function delay(milliseconds) {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));

}

function sha256File(filePath) {

  return Crypto.createHash('sha256').update(Fs.readFileSync(filePath))
      .digest('hex');

}

function safeError(error) {

  const raw = String(error && error.message || error || 'Unknown error');
  const dataIndex = raw.toLowerCase().indexOf('data:');
  return {
    message: dataIndex === -1 ? raw :
      `${raw.slice(0, dataIndex)}[data URI redacted]`,
    name: String(error && error.name || 'Error'),
  };

}

function listen(server) {

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

}

function closeServer(server) {

  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    } else if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });

}

function trackSocket(sockets, socket) {

  sockets.add(socket);
  socket.on('error', () => {});
  socket.once('close', () => sockets.delete(socket));

}

function destroySockets(sockets) {

  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();

}

function sendText(response, body) {

  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Content-Length': String(bytes.length),
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(bytes);

}

async function createHttpResponder(kind, traffic) {

  const sockets = new Set();
  const marker = `${kind}-marker`;
  const server = Http.createServer((request, response) => {
    traffic.push({kind, method: request.method, url: request.url});
    request.resume();
    sendText(response, marker);
  });
  server.on('connection', (socket) => trackSocket(sockets, socket));
  return {
    kind,
    marker,
    port: await listen(server),
    server,
    sockets,
  };

}

async function createControlServer() {

  const sockets = new Set();
  const server = Http.createServer((request, response) => {
    request.resume();
    const body = Buffer.from([
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>Control</title></head>',
      '<body>Native PAC feasibility control</body></html>',
    ].join(''), 'utf8');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Connection': 'close',
      'Content-Length': String(body.length),
      'Content-Type': 'text/html; charset=utf-8',
    });
    response.end(body);
  });
  server.on('connection', (socket) => trackSocket(sockets, socket));
  return {port: await listen(server), server, sockets};

}

function resolveOpenSslExecutable() {

  const override = String(process.env.OPENSSL_BIN || '').trim();
  const candidates = override ? [override] : process.platform === 'win32' ? [
    process.env.PROGRAMFILES && Path.join(
        process.env.PROGRAMFILES,
        'Git',
        'usr',
        'bin',
        'openssl.exe',
    ),
    process.env.PROGRAMFILES && Path.join(
        process.env.PROGRAMFILES,
        'Git',
        'mingw64',
        'bin',
        'openssl.exe',
    ),
    'openssl',
  ] : ['openssl'];
  return candidates.filter(Boolean).find((candidate) => {
    if (Path.isAbsolute(candidate) && !Fs.existsSync(candidate)) {
      return false;
    }
    return ChildProcess.spawnSync(candidate, ['version'], {
      stdio: 'ignore',
      windowsHide: true,
    }).status === 0;
  }) || null;

}

function createTlsMaterial() {

  const executable = resolveOpenSslExecutable();
  if (!executable) {
    return null;
  }
  const temporaryPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-firefox-pac-tls-'),
  );
  const certificatePath = Path.join(temporaryPath, 'certificate.pem');
  const privateKeyPath = Path.join(temporaryPath, 'private-key.pem');
  const result = ChildProcess.spawnSync(executable, [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-sha256',
    '-nodes',
    '-days',
    '2',
    '-keyout',
    privateKeyPath,
    '-out',
    certificatePath,
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  if (result.status !== 0) {
    Fs.rmSync(temporaryPath, {force: true, recursive: true});
    return null;
  }
  return {
    certificate: Fs.readFileSync(certificatePath),
    privateKey: Fs.readFileSync(privateKeyPath),
    temporaryPath,
  };

}

async function createHttpsResponder(kind, traffic, tlsMaterial) {

  if (!tlsMaterial) {
    return null;
  }
  const sockets = new Set();
  const marker = `${kind}-marker`;
  const server = Https.createServer({
    cert: tlsMaterial.certificate,
    key: tlsMaterial.privateKey,
    minVersion: 'TLSv1.2',
  }, (request, response) => {
    traffic.push({kind, method: request.method, url: request.url});
    request.resume();
    sendText(response, marker);
  });
  server.on('connection', (socket) => trackSocket(sockets, socket));
  return {
    kind,
    marker,
    port: await listen(server),
    server,
    sockets,
  };

}

async function createSocksResponder(kind, traffic, originPort) {

  const sockets = new Set();
  const marker = `${kind}-tunnel`;
  const server = Net.createServer((client) => {
    trackSocket(sockets, client);
    let buffer = Buffer.alloc(0);
    let stage = 'version';
    const pending = [];
    const connectUpstream = (remaining) => {
      stage = 'connecting';
      const upstream = Net.connect({host: '127.0.0.1', port: originPort});
      trackSocket(sockets, upstream);
      upstream.once('connect', () => {
        traffic.push({kind, method: marker, url: null});
        if (remaining.length) {
          upstream.write(remaining);
        }
        for (const pendingChunk of pending) {
          upstream.write(pendingChunk);
        }
        stage = 'tunnel';
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once('error', () => client.destroy());
    };
    client.on('data', (chunk) => {
      if (stage === 'connecting') {
        pending.push(chunk);
        return;
      }
      if (stage === 'tunnel') {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'version' && buffer.length) {
        stage = buffer[0] === 5 ? 'socks5-greeting' :
          buffer[0] === 4 ? 'socks4-request' : 'invalid';
      }
      if (stage === 'socks5-greeting') {
        if (buffer.length < 2 + buffer[1]) {
          return;
        }
        const length = 2 + buffer[1];
        buffer = buffer.subarray(length);
        client.write(Buffer.from([5, 0]));
        stage = 'socks5-request';
      }
      if (stage === 'socks5-request') {
        if (buffer.length < 5) {
          return;
        }
        const type = buffer[3];
        const addressLength = type === 1 ? 4 : type === 4 ? 16 :
          type === 3 ? 1 + buffer[4] : -1;
        if (addressLength < 0 || buffer.length < 4 + addressLength + 2) {
          return;
        }
        const requestLength = 4 + addressLength + 2;
        const remaining = buffer.subarray(requestLength);
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        connectUpstream(remaining);
      }
      if (stage === 'socks4-request') {
        if (buffer.length < 9) {
          return;
        }
        let terminator = buffer.indexOf(0, 8);
        if (terminator === -1) {
          return;
        }
        const ifSocks4a = buffer[4] === 0 && buffer[5] === 0 &&
          buffer[6] === 0 && buffer[7] !== 0;
        if (ifSocks4a) {
          terminator = buffer.indexOf(0, terminator + 1);
          if (terminator === -1) {
            return;
          }
        }
        const remaining = buffer.subarray(terminator + 1);
        client.write(Buffer.from([0, 90, 0, 0, 127, 0, 0, 1]));
        connectUpstream(remaining);
      }
      if (stage === 'invalid') {
        client.destroy();
      }
    });
  });
  return {
    kind,
    marker,
    port: await listen(server),
    server,
    sockets,
  };

}

async function createInfrastructure() {

  const traffic = [];
  const tlsMaterial = createTlsMaterial();
  const control = await createControlServer();
  const origin = await createHttpResponder('origin', traffic);
  const manualProxy = await createHttpResponder('manual-proxy', traffic);
  const proxyA = await createHttpResponder('pac-proxy-a', traffic);
  const proxyB = await createHttpResponder('pac-proxy-b', traffic);
  const httpsProxy = await createHttpsResponder(
      'pac-https-proxy',
      traffic,
      tlsMaterial,
  );
  const socks = await createSocksResponder('pac-socks', traffic, origin.port);
  return {
    control,
    httpsProxy,
    manualProxy,
    origin,
    proxyA,
    proxyB,
    socks,
    tlsMaterial,
    traffic,
  };

}

async function closeInfrastructure(infrastructure) {

  const services = [
    infrastructure.control,
    infrastructure.origin,
    infrastructure.manualProxy,
    infrastructure.proxyA,
    infrastructure.proxyB,
    infrastructure.httpsProxy,
    infrastructure.socks,
  ].filter(Boolean);
  for (const service of services) {
    destroySockets(service.sockets);
    await closeServer(service.server);
  }
  if (infrastructure.tlsMaterial) {
    Fs.rmSync(infrastructure.tlsMaterial.temporaryPath, {
      force: true,
      recursive: true,
    });
  }

}

function resolveFirefoxExecutable() {

  const override = String(process.env.FIREFOX_BIN || '').trim();
  const candidates = override ? [override] : process.platform === 'win32' ? [
    process.env.PROGRAMFILES && Path.join(
        process.env.PROGRAMFILES,
        'Mozilla Firefox',
        'firefox.exe',
    ),
    process.env['PROGRAMFILES(X86)'] && Path.join(
        process.env['PROGRAMFILES(X86)'],
        'Mozilla Firefox',
        'firefox.exe',
    ),
  ] : process.platform === 'darwin' ? [
    '/Applications/Firefox.app/Contents/MacOS/firefox',
  ] : ['/usr/bin/firefox'];
  const executable = candidates.filter(Boolean).find((candidate) =>
    Fs.existsSync(candidate) && Fs.statSync(candidate).isFile(),
  );
  Assert.ok(executable, 'Firefox was not found. Set FIREFOX_BIN explicitly.');
  return executable;

}

function readFirefoxVersion(executable) {

  const result = ChildProcess.spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(result.stdout || result.stderr || '').trim() || 'unknown';

}

function makeProfilePreferences(infrastructure, privateAccess) {

  return {
    'browser.shell.checkDefaultBrowser': false,
    'extensions.allowPrivateBrowsingByDefault': privateAccess,
    'network.dns.localDomains': Object.values(HOSTS).join(','),
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': infrastructure.manualProxy.port,
    'network.proxy.no_proxies_on': HOSTS.control,
    'network.proxy.share_proxy_settings': true,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': infrastructure.manualProxy.port,
    'network.proxy.type': 1,
  };

}

async function launchFirefox(executable, infrastructure) {

  const profilePath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-firefox-native-pac-'),
  );
  const browser = await Puppeteer.launch({
    acceptInsecureCerts: true,
    browser: 'firefox',
    executablePath: executable,
    extraPrefsFirefox: makeProfilePreferences(
        infrastructure,
        false,
    ),
    headless: true,
    protocolTimeout: PAC_LOAD_TIMEOUT_MS,
    userDataDir: profilePath,
  });
  return {browser, profilePath};

}

async function installFixture(browser, allowPrivateBrowsing) {

  const response = await browser.connection.send('webExtension.install', {
    extensionData: {path: FIXTURE_ROOT, type: 'path'},
    'moz:allowPrivateBrowsing': allowPrivateBrowsing,
  });
  Assert.ok(
      response && response.result && response.result.extension,
      'Firefox WebDriver BiDi returned no installed extension ID.',
  );
  return response.result.extension;

}

async function openControlPage(browser, infrastructure) {

  const page = await browser.newPage();
  await page.goto(
      `http://${HOSTS.control}:${infrastructure.control.port}/control`,
      {
    timeout: FIREFOX_TIMEOUT_MS,
    waitUntil: 'domcontentloaded',
      },
  );
  await page.waitForFunction(
      () => document.documentElement.dataset.rucbBridge === 'ready',
      {timeout: FIREFOX_TIMEOUT_MS},
  );
  return page;

}

async function sendControl(page, message) {

  return page.evaluate(async (payload) => {
    const requestId = `${Date.now()}-${Math.random()}`;
    document.documentElement.dataset.rucbRequest = JSON.stringify(payload);
    document.documentElement.dataset.rucbRequestId = requestId;
    window.dispatchEvent(new CustomEvent('rucb-native-pac-request'));
    await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(
          () => reject(new Error('Native PAC control response timed out.')),
          30000,
      );
      const onResponse = () => {
        if (document.documentElement.dataset.rucbResponseId !== requestId) {
          return;
        }
        clearTimeout(timeoutId);
        window.removeEventListener('rucb-native-pac-response', onResponse);
        resolve();
      };
      window.addEventListener('rucb-native-pac-response', onResponse);
    });
    return JSON.parse(document.documentElement.dataset.rucbResponse);
  }, message);

}

function routeUrl(infrastructure, host, label) {

  return `http://${host}:${infrastructure.origin.port}/` +
    `${encodeURIComponent(label)}?nonce=${Crypto.randomUUID()}`;

}

async function requestMarker(browser, url, timeout = FIREFOX_TIMEOUT_MS) {

  const page = await browser.newPage();
  try {
    await page.goto(url, {timeout, waitUntil: 'domcontentloaded'});
    return {
      marker: await page.evaluate(() => document.body.textContent.trim()),
      ok: true,
    };
  } catch (error) {
    return {error: safeError(error), marker: null, ok: false};
  } finally {
    await page.close().catch(() => {});
  }

}

async function waitForMarker(browser, urlFactory, expected, timeout) {

  const startedAt = Date.now();
  let lastResult = null;
  let attempt = 0;
  while (Date.now() - startedAt < timeout) {
    lastResult = await requestMarker(browser, urlFactory(attempt), 15 * 1000);
    if (lastResult.ok && lastResult.marker === expected) {
      return {
        attempts: attempt + 1,
        elapsedMs: Date.now() - startedAt,
        marker: lastResult.marker,
        ok: true,
      };
    }
    ++attempt;
    await delay(250);
  }
  return {
    attempts: attempt,
    elapsedMs: Date.now() - startedAt,
    lastResult,
    ok: false,
  };

}

function pacOptions(infrastructure, overrides = {}) {

  return {
    defaultResult: 'DIRECT',
    directHost: HOSTS.direct,
    providerHost: HOSTS.provider,
    proxyHost: HOSTS.route,
    proxyResult: `PROXY 127.0.0.1:${infrastructure.proxyA.port}`,
    targetBytes: 0,
    ...overrides,
  };

}

async function setAndObserve(options) {

  process.stderr.write(`Firefox native PAC: apply ${options.label}\n`);
  const response = await sendControl(options.controlPage, {
    command: 'setPac',
    encoding: options.encoding,
    options: options.pac,
  });
  if (!response.ok || !response.result.setAccepted) {
    const error = response.ok ? response.result.setError : response.error;
    process.stderr.write(
        `Firefox native PAC: set failed ${options.label} ` +
        `(${error.category})\n`,
    );
    return {response, routing: null};
  }
  const routing = await waitForMarker(
      options.browser,
      (attempt) => routeUrl(
          options.infrastructure,
          options.host || HOSTS.route,
          `${options.label}-${attempt}`,
      ),
      options.expectedMarker,
      options.timeout || PAC_LOAD_TIMEOUT_MS,
  );
  process.stderr.write(
      `Firefox native PAC: route ${options.label} ` +
      `${routing.ok ? 'PASS' : 'FAIL'} ` +
      `(raw=${response.result.rawBytes}, encoded=` +
      `${response.result.encodedLength})\n`,
  );
  return {response, routing};

}

async function runDeniedPrivateAccess(executable, infrastructure) {

  const launched = await launchFirefox(executable, infrastructure);
  let extensionId = null;
  try {
    const manual = await requestMarker(
        launched.browser,
        routeUrl(infrastructure, HOSTS.route, 'denied-manual-before'),
    );
    extensionId = await installFixture(launched.browser, false);
    const controlPage = await openControlPage(launched.browser, infrastructure);
    const statusBefore = await sendControl(controlPage, {command: 'status'});
    const setResponse = await sendControl(controlPage, {
      command: 'setPac',
      encoding: 'percent',
      options: pacOptions(infrastructure),
    });
    const statusAfter = await sendControl(controlPage, {command: 'status'});
    const routeAfter = await requestMarker(
        launched.browser,
        routeUrl(infrastructure, HOSTS.route, 'denied-manual-after'),
    );
    return {
      incognitoAllowed: statusBefore.incognitoAllowed,
      manualBefore: manual,
      routeAfter,
      setResponse,
      settingsAfter: statusAfter.settings,
      settingsBefore: statusBefore.settings,
    };
  } finally {
    if (extensionId) {
      await launched.browser.uninstallExtension(extensionId).catch(() => {});
    }
    await launched.browser.close().catch(() => {});
    Fs.rmSync(launched.profilePath, {force: true, recursive: true});
  }

}

async function testSizeMatrix(context) {

  const results = [];
  for (const sizeCase of SIZE_CASES) {
    for (const encoding of ['percent', 'base64']) {
      const result = await setAndObserve({
        browser: context.browser,
        controlPage: context.controlPage,
        encoding,
        expectedMarker: context.infrastructure.proxyA.marker,
        infrastructure: context.infrastructure,
        label: `size-${sizeCase.label}-${encoding}`,
        pac: pacOptions(context.infrastructure, {targetBytes: sizeCase.bytes}),
      });
      results.push({
        encodedLength: result.response.ok ?
          result.response.result.encodedLength : null,
        encodedSha256: result.response.ok ?
          result.response.result.encodedSha256 : null,
        encoding,
        error: result.response.ok ? result.response.result.setError || null :
          result.response.error,
        label: sizeCase.label,
        loadElapsedMs: result.routing && result.routing.elapsedMs,
        rawBytes: result.response.ok ? result.response.result.rawBytes :
          sizeCase.bytes,
        rawSha256: result.response.ok ? result.response.result.rawSha256 : null,
        routing: result.routing,
        setElapsedMs: result.response.ok ?
          result.response.result.setElapsedMs : null,
        setAccepted: result.response.ok ?
          result.response.result.setAccepted : false,
        setResult: result.response.ok ? result.response.result.setResult : null,
      });
    }
  }
  return results;

}

async function testTransportCeiling(context) {

  const results = {};
  for (const encoding of ['percent', 'base64']) {
    let accepted = 1024;
    let rejected = 1024 * 1024;
    const attempts = [];
    while (rejected - accepted > 1024) {
      const targetBytes = Math.floor((accepted + rejected) / 2048) * 1024;
      const result = await setAndObserve({
        browser: context.browser,
        controlPage: context.controlPage,
        encoding,
        expectedMarker: context.infrastructure.proxyA.marker,
        infrastructure: context.infrastructure,
        label: `ceiling-${encoding}-${targetBytes}`,
        pac: pacOptions(context.infrastructure, {targetBytes}),
      });
      const ifAccepted = Boolean(result.routing && result.routing.ok);
      attempts.push({
        encodedLength: result.response.ok ?
          result.response.result.encodedLength : null,
        rawBytes: targetBytes,
        routingAccepted: ifAccepted,
        setAccepted: result.response.ok && result.response.result.setAccepted,
      });
      if (ifAccepted) {
        accepted = targetBytes;
      } else {
        rejected = targetBytes;
      }
    }
    results[encoding] = {
      attempts,
      largestAcceptedRawBytes: accepted,
      smallestRejectedRawBytes: rejected,
    };
  }
  return results;

}

async function testDynamicReplacement(context) {

  const pacA = pacOptions(context.infrastructure);
  const first = await setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'percent',
    expectedMarker: context.infrastructure.proxyA.marker,
    infrastructure: context.infrastructure,
    label: 'dynamic-a',
    pac: pacA,
  });
  const same = await setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'percent',
    expectedMarker: context.infrastructure.proxyA.marker,
    infrastructure: context.infrastructure,
    label: 'dynamic-a-same',
    pac: pacA,
  });
  const pacB = pacOptions(context.infrastructure, {
    directHost: HOSTS.route,
    proxyHost: HOSTS.proxy,
    proxyResult: `PROXY 127.0.0.1:${context.infrastructure.proxyB.port}`,
  });
  const second = await setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'base64',
    expectedMarker: context.infrastructure.origin.marker,
    infrastructure: context.infrastructure,
    label: 'dynamic-b',
    pac: pacB,
  });
  return {first, same, second};

}

async function testProviderLike(context) {

  return setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'percent',
    expectedMarker: context.infrastructure.origin.marker,
    host: HOSTS.provider,
    infrastructure: context.infrastructure,
    label: 'provider-like-dns',
    pac: pacOptions(context.infrastructure),
  });

}

async function testCandidates(context) {

  const closedServer = Net.createServer();
  const closedPort = await listen(closedServer);
  await closeServer(closedServer);
  const multiple = await setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'percent',
    expectedMarker: context.infrastructure.proxyB.marker,
    infrastructure: context.infrastructure,
    label: 'ordered-proxy-failover',
    pac: pacOptions(context.infrastructure, {
      proxyResult: `PROXY 127.0.0.1:${closedPort}; ` +
        `PROXY 127.0.0.1:${context.infrastructure.proxyB.port}`,
    }),
  });
  const socks5 = await setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'percent',
    expectedMarker: context.infrastructure.origin.marker,
    infrastructure: context.infrastructure,
    label: 'socks5',
    pac: pacOptions(context.infrastructure, {
      proxyResult: `SOCKS5 127.0.0.1:${context.infrastructure.socks.port}`,
    }),
  });
  const socks = await setAndObserve({
    browser: context.browser,
    controlPage: context.controlPage,
    encoding: 'percent',
    expectedMarker: context.infrastructure.origin.marker,
    infrastructure: context.infrastructure,
    label: 'socks',
    pac: pacOptions(context.infrastructure, {
      proxyResult: `SOCKS 127.0.0.1:${context.infrastructure.socks.port}`,
    }),
  });
  let https = {skipped: 'OpenSSL was unavailable for a local TLS proxy.'};
  if (context.infrastructure.httpsProxy) {
    https = await setAndObserve({
      browser: context.browser,
      controlPage: context.controlPage,
      encoding: 'percent',
      expectedMarker: context.infrastructure.httpsProxy.marker,
      infrastructure: context.infrastructure,
      label: 'https-proxy',
      pac: pacOptions(context.infrastructure, {
        proxyResult: `HTTPS 127.0.0.1:${context.infrastructure.httpsProxy.port}`,
      }),
    });
  }

  const originHitsBefore = context.infrastructure.traffic.filter(
      (entry) => entry.kind === 'origin',
  ).length;
  const noDirectSet = await sendControl(context.controlPage, {
    command: 'setPac',
    encoding: 'percent',
    options: pacOptions(context.infrastructure, {
      proxyResult: `PROXY 127.0.0.1:${closedPort}`,
    }),
  });
  const noDirectRoute = await requestMarker(
      context.browser,
      routeUrl(context.infrastructure, HOSTS.route, 'no-direct-fallback'),
      8 * 1000,
  );
  const originHitsAfter = context.infrastructure.traffic.filter(
      (entry) => entry.kind === 'origin',
  ).length;
  return {
    https,
    multiple,
    noDirect: {
      browserResult: noDirectRoute,
      originFallbackObserved: originHitsAfter !== originHitsBefore,
      setResponse: noDirectSet,
    },
    socks,
    socks5,
  };

}

async function testPacErrors(context) {

  const scenarios = [
    {encoding: 'percent', rawPac: 'syntax-invalid'},
    {encoding: 'percent', rawPac: 'missing-function'},
    {encoding: 'malformed', rawPac: null},
  ];
  const results = [];
  for (const scenario of scenarios) {
    const setResponse = await sendControl(context.controlPage, {
      command: 'setPac',
      encoding: scenario.encoding,
      options: pacOptions(context.infrastructure),
      rawPac: scenario.rawPac,
    });
    await delay(750);
    const route = await requestMarker(
        context.browser,
        routeUrl(
            context.infrastructure,
            HOSTS.route,
            `error-${scenario.rawPac || scenario.encoding}`,
        ),
        8 * 1000,
    );
    const errors = await sendControl(context.controlPage, {command: 'errors'});
    results.push({
      errors: errors.errors,
      route,
      scenario,
      setResponse,
    });
  }
  return results;

}

async function runGrantedPrivateAccess(executable, infrastructure) {

  const launched = await launchFirefox(executable, infrastructure);
  let extensionId = null;
  let controlPage = null;
  try {
    const manualBefore = await requestMarker(
        launched.browser,
        routeUrl(infrastructure, HOSTS.route, 'manual-before-extension'),
    );
    extensionId = await installFixture(launched.browser, true);
    controlPage = await openControlPage(launched.browser, infrastructure);
    const statusBefore = await sendControl(controlPage, {command: 'status'});
    const dynamic = await testDynamicReplacement({
      browser: launched.browser,
      controlPage,
      infrastructure,
    });
    const sizeMatrix = await testSizeMatrix({
      browser: launched.browser,
      controlPage,
      infrastructure,
    });
    const transportCeiling = await testTransportCeiling({
      browser: launched.browser,
      controlPage,
      infrastructure,
    });
    const providerLike = await testProviderLike({
      browser: launched.browser,
      controlPage,
      infrastructure,
    });
    const directControl = await setAndObserve({
      browser: launched.browser,
      controlPage,
      encoding: 'percent',
      expectedMarker: infrastructure.origin.marker,
      host: HOSTS.direct,
      infrastructure,
      label: 'direct-over-manual-baseline',
      pac: pacOptions(infrastructure),
    });
    const proxyControl = await waitForMarker(
        launched.browser,
        (attempt) => routeUrl(
            infrastructure,
            HOSTS.route,
            `proxy-over-manual-baseline-${attempt}`,
        ),
        infrastructure.proxyA.marker,
        PAC_LOAD_TIMEOUT_MS,
    );
    const statusControlled = await sendControl(controlPage, {command: 'status'});

    const privateContext = await launched.browser.createBrowserContext();
    const privateRoute = await requestMarker(
        privateContext,
        routeUrl(infrastructure, HOSTS.route, 'private-window-route'),
    );
    await privateContext.close();

    await controlPage.close();
    controlPage = null;
    const eventPageIdleStarted = Date.now();
    await delay(EVENT_PAGE_IDLE_WAIT_MS);
    const eventPageRoute = await requestMarker(
        launched.browser,
        routeUrl(infrastructure, HOSTS.route, 'event-page-idle-route'),
    );
    controlPage = await openControlPage(launched.browser, infrastructure);
    const statusAfterIdle = await sendControl(controlPage, {command: 'status'});
    const eventPage = {
      bootChangedDuringIdle: statusControlled.boot.id !==
        statusAfterIdle.boot.id,
      bootBeforeIdle: statusControlled.boot,
      idleWaitMs: Date.now() - eventPageIdleStarted,
      route: eventPageRoute,
      statusAfterIdle,
    };

    const bootBeforeReload = statusAfterIdle.boot;
    await sendControl(controlPage, {command: 'reload'}).catch(() => {});
    await delay(2 * 1000);
    await controlPage.close().catch(() => {});
    controlPage = await openControlPage(launched.browser, infrastructure);
    const statusAfterReload = await sendControl(controlPage, {command: 'status'});
    const routeAfterReload = await requestMarker(
        launched.browser,
        routeUrl(infrastructure, HOSTS.route, 'extension-reload-route'),
    );
    const extensionReload = {
      bootChanged: bootBeforeReload.id !== statusAfterReload.boot.id,
      route: routeAfterReload,
      settings: statusAfterReload.settings,
    };

    const candidates = await testCandidates({
      browser: launched.browser,
      controlPage,
      infrastructure,
    });
    const errors = await testPacErrors({
      browser: launched.browser,
      controlPage,
      infrastructure,
    });

    await sendControl(controlPage, {
      command: 'setPac',
      encoding: 'percent',
      options: pacOptions(infrastructure),
    });
    const clearResponse = await sendControl(controlPage, {command: 'clear'});
    const manualAfterClear = await waitForMarker(
        launched.browser,
        (attempt) => routeUrl(
            infrastructure,
            HOSTS.route,
            `manual-after-clear-${attempt}`,
        ),
        infrastructure.manualProxy.marker,
        PAC_LOAD_TIMEOUT_MS,
    );
    return {
      candidates,
      clearResponse,
      directControl,
      dynamic,
      errors,
      eventPage,
      extensionReload,
      incognitoAllowed: statusBefore.incognitoAllowed,
      manualAfterClear,
      manualBefore,
      privateRoute,
      providerLike,
      proxyControl,
      sizeMatrix,
      statusBefore: statusBefore.settings,
      statusControlled: statusControlled.settings,
      transportCeiling,
    };
  } finally {
    if (controlPage) {
      await sendControl(controlPage, {command: 'clear'}).catch(() => {});
    }
    if (extensionId) {
      await launched.browser.uninstallExtension(extensionId).catch(() => {});
    }
    await launched.browser.close().catch(() => {});
    Fs.rmSync(launched.profilePath, {force: true, recursive: true});
  }

}

function evaluateDecision(report, infrastructure) {

  const granted = report.granted;
  const denied = report.denied;
  const transportCases = granted.sizeMatrix;
  const providerScale = transportCases.filter(
      (entry) => entry.label === '11.6 MiB',
  );
  const ceilings = Object.values(granted.transportCeiling);
  const requirements = {
    clearRestoresManual: granted.manualAfterClear.ok,
    directParity: granted.directControl.routing &&
      granted.directControl.routing.ok &&
      granted.directControl.routing.marker === infrastructure.origin.marker,
    dynamicReplacement: granted.dynamic.first.routing.ok &&
      granted.dynamic.second.routing.ok,
    eventPageIndependent: granted.eventPage.route.ok &&
      granted.eventPage.route.marker === infrastructure.proxyA.marker,
    extensionReloadPreservesPac: granted.extensionReload.route.ok &&
      granted.extensionReload.route.marker === infrastructure.proxyA.marker,
    nativeBase64: transportCases.some((entry) =>
      entry.label === 'tiny' && entry.encoding === 'base64' && entry.routing.ok,
    ),
    nativePercent: transportCases.some((entry) =>
      entry.label === 'tiny' && entry.encoding === 'percent' && entry.routing.ok,
    ),
    ownership: granted.statusControlled.levelOfControl ===
      'controlled_by_this_extension',
    privateDenied: denied.incognitoAllowed === false &&
      denied.setResponse.ok === true &&
      denied.setResponse.result.setAccepted === false &&
      denied.routeAfter.marker === infrastructure.manualProxy.marker,
    privateGranted: granted.incognitoAllowed === true &&
      granted.privateRoute.marker === infrastructure.proxyA.marker,
    providerLike: granted.providerLike.routing.ok,
    providerScale: providerScale.some((entry) => entry.routing && entry.routing.ok),
    practicalCeilingObserved: ceilings.length === 2 && ceilings.every(
        (entry) => entry.largestAcceptedRawBytes <
          entry.smallestRejectedRawBytes,
    ),
  };
  return {
    decision: Object.values(requirements).every(Boolean) ?
      'FIREFOX NATIVE PAC FEASIBLE' : 'FIREFOX NATIVE PAC NOT FEASIBLE',
    requirements,
  };

}

async function main() {

  Assert.ok(Fs.existsSync(Path.join(FIXTURE_ROOT, 'manifest.json')));
  const executable = resolveFirefoxExecutable();
  const infrastructure = await createInfrastructure();
  const report = {
    fixture: {
      manifestSha256: sha256File(Path.join(FIXTURE_ROOT, 'manifest.json')),
      path: Path.relative(process.cwd(), FIXTURE_ROOT).replaceAll('\\', '/'),
    },
    fullSignedExtensionRestart: 'DEFERRED',
    generatedAt: new Date().toISOString(),
  };
  try {
    process.stderr.write('Firefox native PAC: private-access denied path\n');
    report.denied = await runDeniedPrivateAccess(executable, infrastructure);
    process.stderr.write('Firefox native PAC: private-access granted path\n');
    report.granted = await runGrantedPrivateAccess(executable, infrastructure);
    report.browser = {
      executable,
      product: 'Firefox',
      version: readFirefoxVersion(executable),
    };
    report.assessment = evaluateDecision(report, infrastructure);
    if (process.env.FIREFOX_PAC_REPORT) {
      Fs.mkdirSync(Path.dirname(Path.resolve(process.env.FIREFOX_PAC_REPORT)), {
        recursive: true,
      });
      Fs.writeFileSync(
          Path.resolve(process.env.FIREFOX_PAC_REPORT),
          `${JSON.stringify(report, null, 2)}\n`,
          'utf8',
      );
    }
    if (process.env.FIREFOX_PAC_QUIET !== '1') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    if (report.assessment.decision !== 'FIREFOX NATIVE PAC FEASIBLE') {
      process.exitCode = 1;
    }
  } finally {
    await closeInfrastructure(infrastructure);
  }

}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({fatal: safeError(error)}, null, 2)}\n`);
  process.exitCode = 1;
});
