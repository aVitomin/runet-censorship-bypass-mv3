'use strict';


const Assert = require('assert');
const Crypto = require('crypto');
const Fs = require('fs');
const Http = require('http');
const Os = require('os');
const Path = require('path');
const Puppeteer = require('puppeteer-core');

const PACKAGED_MV3_ROOT = Path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    'build',
    'extension-chromium-mv3',
);
const SERVICE_WORKER_PATH = '/background/service-worker.js';
const TEST_HOSTS = Object.freeze({
  auto: 'auto.qa.test',
  authA: 'auth-a.qa.test',
  authB: 'auth-b.qa.test',
  authMismatch: 'auth-mismatch.qa.test',
  authPasswordless: 'auth-passwordless.qa.test',
  authWrong: 'auth-wrong.qa.test',
  direct: 'direct.qa.test',
  origin401: 'origin-401.qa.test',
  proxy: 'proxy.qa.test',
});
const CHROME_TIMEOUT_MS = 20 * 1000;
const AUTH_FAILURE_TIMEOUT_MS = 8 * 1000;

function resolveChromeExecutable() {

  const override = String(process.env.CHROME_BIN || '').trim();
  if (override) {
    Assert.ok(
        Fs.existsSync(override) && Fs.statSync(override).isFile(),
        `CHROME_BIN does not name an installed Chrome executable: ${override}`,
    );
    return override;
  }

  const candidates = process.platform === 'win32' ? [
    process.env.PROGRAMFILES && Path.join(
        process.env.PROGRAMFILES,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
    ),
    process.env['PROGRAMFILES(X86)'] && Path.join(
        process.env['PROGRAMFILES(X86)'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
    ),
    process.env.LOCALAPPDATA && Path.join(
        process.env.LOCALAPPDATA,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
    ),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  const executable = candidates
      .filter(Boolean)
      .find((candidate) =>
        Fs.existsSync(candidate) && Fs.statSync(candidate).isFile(),
      );
  Assert.ok(
      executable,
      'Google Chrome Stable was not found. Set CHROME_BIN explicitly; ' +
      'this test never downloads a browser.',
  );
  return executable;

}

function assertBuiltExtension() {

  const manifestPath = Path.join(PACKAGED_MV3_ROOT, 'manifest.json');
  Assert.ok(
      Fs.existsSync(manifestPath),
      'Missing built MV3 extension. Run npm run build:mv3 first: ' +
      PACKAGED_MV3_ROOT,
  );
  const manifest = JSON.parse(Fs.readFileSync(manifestPath, 'utf8'));
  Assert.strictEqual(manifest.manifest_version, 3);
  Assert.strictEqual(
      manifest.background && manifest.background.service_worker,
      SERVICE_WORKER_PATH.slice(1),
  );

}

function delay(milliseconds) {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));

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

  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  });

}

function sendText(response, body, contentType = 'text/plain; charset=utf-8') {

  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Connection': 'close',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': contentType,
  });
  response.end(body);

}

function createCredentialCanary(label) {

  const username = `qa-${label}-${Crypto.randomBytes(8).toString('hex')}`;
  const password = `qa-${label}-${Crypto.randomBytes(24).toString('base64url')}`;
  const basicPayload = Buffer.from(`${username}:${password}`).toString('base64');
  return Object.freeze({
    authorization: `Basic ${basicPayload}`,
    basicPayload,
    password,
    reusableValue: `${username}:${password}`,
    username,
  });

}

function getCredentialCanaries(credentials) {

  return Object.values(credentials).flatMap((credential) => [
    credential.password,
    credential.reusableValue,
    credential.basicPayload,
    credential.authorization,
  ]);

}

function containsTextValue(value, needle, ancestors = new Set()) {

  if (typeof value === 'string') {
    return needle !== '' && value.includes(needle);
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const result = Array.isArray(value) ?
    value.some((item) => containsTextValue(item, needle, ancestors)) :
    Object.values(value).some((item) =>
      containsTextValue(item, needle, ancestors),
    );
  ancestors.delete(value);
  return result;

}

function containsCredentialCanary(value, credentialCanaries) {

  return credentialCanaries.some((canary) =>
    canary && containsTextValue(value, canary),
  );

}

function assertNoCredentialCanary(value, credentialCanaries, surface) {

  Assert.strictEqual(
      containsCredentialCanary(value, credentialCanaries),
      false,
      `${surface}: a reusable proxy credential canary was exposed.`,
  );

}

function redactCredentialCanaries(value, credentialCanaries) {

  let text = String(value || '');
  credentialCanaries.forEach((canary) => {
    if (canary) {
      text = text.split(canary).join('[credential-redacted]');
    }
  });
  return text;

}

function createSafeError(error, credentialCanaries) {

  const safeError = new Error(redactCredentialCanaries(
      error && error.message || error,
      credentialCanaries,
  ));
  safeError.stack = redactCredentialCanaries(
      error && error.stack || safeError.stack,
      credentialCanaries,
  );
  return safeError;

}

function classifyAuthorization(value, expected, knownAlternatives = []) {

  if (!value) {
    return 'none';
  }
  if (expected && value === expected) {
    return 'expected';
  }
  if (knownAlternatives.includes(value)) {
    return 'known-wrong';
  }
  return 'unexpected';

}

async function createReceiver(kind, traffic) {

  const marker = `${kind}-receiver`;
  const server = Http.createServer((request, response) => {
    traffic.push({
      kind,
      method: request.method,
      url: request.url,
    });
    request.resume();
    sendText(response, marker);
  });
  server.on('connect', (request, socket) => {
    traffic.push({
      kind,
      method: 'CONNECT',
      url: request.url,
    });
    socket.end();
  });
  return {
    kind,
    marker,
    port: await listen(server),
    server,
  };

}

async function createAuthenticatedProxy(options) {

  const marker = `${options.kind}-authenticated-receiver`;
  const realm = `rucb-${options.kind}`;
  const server = Http.createServer((request, response) => {
    const auth = classifyAuthorization(
        request.headers['proxy-authorization'],
        options.expectedAuthorization,
        options.knownAuthorizations,
    );
    options.traffic.push({
      auth,
      kind: options.kind,
      method: request.method,
      url: request.url,
    });
    request.resume();
    if (options.acceptExpected === true && auth === 'expected') {
      sendText(response, marker);
      return;
    }
    response.writeHead(407, {
      'Connection': 'close',
      'Content-Length': '0',
      'Proxy-Authenticate': `Basic realm="${realm}"`,
    });
    response.end();
  });
  server.on('connect', (request, socket) => {
    options.traffic.push({
      auth: classifyAuthorization(
          request.headers['proxy-authorization'],
          options.expectedAuthorization,
          options.knownAuthorizations,
      ),
      kind: options.kind,
      method: 'CONNECT',
      url: request.url,
    });
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return {
    kind: options.kind,
    marker,
    port: await listen(server),
    server,
  };

}

async function createUnauthorizedOrigin(traffic, knownAuthorizations) {

  const kind = 'origin-401';
  const server = Http.createServer((request, response) => {
    traffic.push({
      authorization: classifyAuthorization(
          request.headers.authorization,
          null,
          knownAuthorizations,
      ),
      kind,
      method: request.method,
      proxyAuthorization: classifyAuthorization(
          request.headers['proxy-authorization'],
          null,
          knownAuthorizations,
      ),
      url: request.url,
    });
    request.resume();
    response.writeHead(401, {
      'Connection': 'close',
      'Content-Length': '0',
      'WWW-Authenticate': 'Basic realm="rucb-origin-401"',
    });
    response.end();
  });
  return {
    kind,
    port: await listen(server),
    server,
  };

}

async function createPacServer(providerProxyPort, authRoutes) {

  const pacData = [
    'function FindProxyForURL(url, host) {',
    ...authRoutes.map((route) =>
      `  if (host === ${JSON.stringify(route.host)}) ` +
        `return ${JSON.stringify(route.result)};`,
    ),
    `  return "PROXY 127.0.0.1:${providerProxyPort}";`,
    '}',
  ].join('\n');
  const server = Http.createServer((request, response) => {
    if (request.url !== '/provider.pac') {
      response.writeHead(404, {'Connection': 'close'});
      response.end();
      return;
    }
    request.resume();
    sendText(response, pacData, 'application/x-ns-proxy-autoconfig');
  });
  return {
    port: await listen(server),
    server,
  };

}

async function createInfrastructure() {

  const traffic = [];
  const credentials = Object.freeze({
    proxyA: createCredentialCanary('proxy-a'),
    proxyB: createCredentialCanary('proxy-b'),
    wrongConfigured: createCredentialCanary('wrong-configured'),
    wrongExpected: createCredentialCanary('wrong-expected'),
  });
  const credentialCanaries = getCredentialCanaries(credentials);
  const knownAuthorizations = Object.values(credentials)
      .map((credential) => credential.authorization);
  const origin = await createReceiver('origin', traffic);
  const providerProxy = await createReceiver('provider-proxy', traffic);
  const explicitProxy = await createReceiver('explicit-proxy', traffic);
  const helperProxy = await createReceiver('helper-proxy', traffic);
  const authProxyA = await createAuthenticatedProxy({
    acceptExpected: true,
    expectedAuthorization: credentials.proxyA.authorization,
    kind: 'auth-proxy-a',
    knownAuthorizations,
    traffic,
  });
  const authProxyB = await createAuthenticatedProxy({
    acceptExpected: true,
    expectedAuthorization: credentials.proxyB.authorization,
    kind: 'auth-proxy-b',
    knownAuthorizations,
    traffic,
  });
  const authMismatch = await createAuthenticatedProxy({
    acceptExpected: false,
    expectedAuthorization: null,
    kind: 'auth-mismatch',
    knownAuthorizations,
    traffic,
  });
  const authPasswordless = await createAuthenticatedProxy({
    acceptExpected: false,
    expectedAuthorization: null,
    kind: 'auth-passwordless',
    knownAuthorizations,
    traffic,
  });
  const authWrong = await createAuthenticatedProxy({
    acceptExpected: true,
    expectedAuthorization: credentials.wrongExpected.authorization,
    kind: 'auth-wrong',
    knownAuthorizations,
    traffic,
  });
  const unauthorizedOrigin = await createUnauthorizedOrigin(
      traffic,
      knownAuthorizations,
  );
  const pac = await createPacServer(providerProxy.port, [
    {host: TEST_HOSTS.authA, result: `PROXY 127.0.0.1:${authProxyA.port}`},
    {host: TEST_HOSTS.authB, result: `PROXY 127.0.0.1:${authProxyB.port}`},
    {
      host: TEST_HOSTS.authMismatch,
      result: `PROXY 127.0.0.1:${authMismatch.port}`,
    },
    {
      host: TEST_HOSTS.authPasswordless,
      result: `PROXY 127.0.0.1:${authPasswordless.port}`,
    },
    {host: TEST_HOSTS.authWrong, result: `PROXY 127.0.0.1:${authWrong.port}`},
    {host: TEST_HOSTS.origin401, result: 'DIRECT'},
  ]);
  return {
    authMismatch,
    authPasswordless,
    authProxyA,
    authProxyB,
    authWrong,
    credentialCanaries,
    credentials,
    explicitProxy,
    helperProxy,
    origin,
    pac,
    providerProxy,
    traffic,
    unauthorizedOrigin,
  };

}

async function closeInfrastructure(infrastructure) {

  if (!infrastructure) {
    return;
  }
  await Promise.all([
    infrastructure.authMismatch,
    infrastructure.authPasswordless,
    infrastructure.authProxyA,
    infrastructure.authProxyB,
    infrastructure.authWrong,
    infrastructure.pac,
    infrastructure.explicitProxy,
    infrastructure.helperProxy,
    infrastructure.providerProxy,
    infrastructure.origin,
    infrastructure.unauthorizedOrigin,
  ].map((endpoint) => closeServer(endpoint.server)));

}

function addDiagnostic(diagnostics, prefix, value, credentialCanaries) {

  if (containsCredentialCanary(value, credentialCanaries)) {
    diagnostics.push(`${prefix}: credential canary was present.`);
    return;
  }
  diagnostics.push(`${prefix}: ${value}`);

}

function attachWorkerDiagnostics(
    worker,
    diagnostics,
    monitoredWorkers,
    credentialCanaries,
) {

  if (!worker || monitoredWorkers.has(worker)) {
    return;
  }
  monitoredWorkers.add(worker);
  worker.on('error', (error) => {
    addDiagnostic(
        diagnostics,
        'service worker exception',
        error.message || error,
        credentialCanaries,
    );
  });
  worker.on('console', (message) => {
    const type = message.type();
    const text = message.text();
    if (
      ['error', 'assert'].includes(type) ||
      (type === 'warn' && /error|exception|failed/i.test(text))
    ) {
      addDiagnostic(
          diagnostics,
          `service worker console ${type}`,
          text,
          credentialCanaries,
      );
    }
  });

}

function attachPageDiagnostics(page, diagnostics, credentialCanaries) {

  page.on('pageerror', (error) => {
    addDiagnostic(
        diagnostics,
        'extension page exception',
        error.message || error,
        credentialCanaries,
    );
  });
  page.on('console', (message) => {
    if (['error', 'assert'].includes(message.type())) {
      addDiagnostic(
          diagnostics,
          `extension page console ${message.type()}`,
          message.text(),
          credentialCanaries,
      );
    }
  });

}

function attachCredentialLeakGuard(page, diagnostics, credentialCanaries) {

  const inspect = (surface, value) => {
    if (containsCredentialCanary(value, credentialCanaries)) {
      diagnostics.push(`${surface}: credential canary was present.`);
    }
  };
  page.on('pageerror', (error) =>
    inspect('browser page exception', error.message || error),
  );
  page.on('console', (message) =>
    inspect('browser page console', message.text()),
  );

}

function isExtensionWorkerTarget(target) {

  return target.type() === 'service_worker' &&
    target.url().startsWith('chrome-extension://') &&
    target.url().endsWith(SERVICE_WORKER_PATH);

}

async function launchExtension(
    chromeExecutable,
    profilePath,
    credentialCanaries,
) {

  const diagnostics = [];
  const monitoredWorkers = new WeakSet();
  console.log('Chrome smoke: launching Chrome Stable.');
  const browser = await Puppeteer.launch({
    args: [
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-features=HttpsFirstBalancedModeAutoEnable',
      '--disable-gpu',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
      '--host-resolver-rules=' + [
        `MAP ${TEST_HOSTS.auto} 127.0.0.1`,
        `MAP ${TEST_HOSTS.authA} 127.0.0.1`,
        `MAP ${TEST_HOSTS.authB} 127.0.0.1`,
        `MAP ${TEST_HOSTS.authMismatch} 127.0.0.1`,
        `MAP ${TEST_HOSTS.authPasswordless} 127.0.0.1`,
        `MAP ${TEST_HOSTS.authWrong} 127.0.0.1`,
        `MAP ${TEST_HOSTS.proxy} 127.0.0.1`,
        `MAP ${TEST_HOSTS.direct} 127.0.0.1`,
        `MAP ${TEST_HOSTS.origin401} 127.0.0.1`,
      ].join(','),
    ],
    enableExtensions: true,
    executablePath: chromeExecutable,
    headless: true,
    userDataDir: profilePath,
  });
  const monitorTarget = async (target) => {
    if (!isExtensionWorkerTarget(target)) {
      return;
    }
    try {
      attachWorkerDiagnostics(
          await target.worker(),
          diagnostics,
          monitoredWorkers,
          credentialCanaries,
      );
    } catch (error) {
      diagnostics.push(
          `service worker diagnostics failed: ${error.message || error}`,
      );
    }
  };
  browser.on('targetcreated', monitorTarget);
  for (const target of browser.targets()) {
    await monitorTarget(target);
  }

  console.log('Chrome smoke: installing unpacked RUCB.');
  const extensionId = await browser.installExtension(PACKAGED_MV3_ROOT);
  console.log(`Chrome smoke: installed RUCB ${extensionId}.`);
  const workerTarget = await browser.waitForTarget(
      (target) => target.type() === 'service_worker' &&
        target.url() ===
          `chrome-extension://${extensionId}${SERVICE_WORKER_PATH}`,
      {timeout: CHROME_TIMEOUT_MS},
  );
  const worker = await workerTarget.worker();
  Assert.ok(worker, 'The MV3 service worker target is not attachable.');
  attachWorkerDiagnostics(
      worker,
      diagnostics,
      monitoredWorkers,
      credentialCanaries,
  );
  return {
    browser,
    credentialCanaries,
    diagnostics,
    extensionId,
  };

}

async function openExtensionPage(session) {

  const page = await session.browser.newPage();
  attachPageDiagnostics(
      page,
      session.diagnostics,
      session.credentialCanaries,
  );
  await page.goto(
      `chrome-extension://${session.extensionId}/pages/options/index.html`,
      {waitUntil: 'domcontentloaded'},
  );
  await page.waitForFunction(
      () => window.mv3Rpc &&
        typeof window.mv3Rpc.callBackground === 'function',
      {timeout: CHROME_TIMEOUT_MS},
  );
  return page;

}

async function callRpc(page, method, params = {}) {

  const response = await page.evaluate(async (request) => {
    try {
      return {
        ok: true,
        result: await window.mv3Rpc.callBackground(
            request.method,
            request.params,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error && error.code || 'RPC_FAILED',
          message: error && error.message || String(error),
        },
      };
    }
  }, {method, params});
  if (!response.ok) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }
  return response.result;

}

async function readProxySettings(page) {

  return page.evaluate(() => new Promise((resolve, reject) => {
    chrome.proxy.settings.get({}, (details) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      const value = details && details.value || {};
      const pacScript = value.pacScript || {};
      resolve({
        hasPacData: typeof pacScript.data === 'string' &&
          pacScript.data.length > 0,
        levelOfControl: details && details.levelOfControl,
        mandatory: pacScript.mandatory,
        mode: value.mode,
      });
    });
  }));

}

async function readAppliedPacData(page) {

  return page.evaluate(() => new Promise((resolve, reject) => {
    chrome.proxy.settings.get({}, (details) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      const value = details && details.value || {};
      const pacScript = value.pacScript || {};
      resolve(typeof pacScript.data === 'string' ? pacScript.data : '');
    });
  }));

}

async function openPopupPage(session) {

  const page = await session.browser.newPage();
  attachPageDiagnostics(
      page,
      session.diagnostics,
      session.credentialCanaries,
  );
  await page.goto(
      `chrome-extension://${session.extensionId}/pages/popup/index.html`,
      {waitUntil: 'domcontentloaded'},
  );
  await page.waitForFunction(
      () => document.getElementById('popup-root') &&
        document.getElementById('popup-root').getAttribute('aria-busy') ===
          'false',
      {timeout: CHROME_TIMEOUT_MS},
  );
  return page;

}

function assertProxyControl(details) {

  Assert.deepStrictEqual(details, {
    hasPacData: true,
    levelOfControl: 'controlled_by_this_extension',
    mandatory: false,
    mode: 'pac_script',
  });

}

async function waitForProxyOff(page) {

  const deadline = Date.now() + CHROME_TIMEOUT_MS;
  let details = null;
  while (Date.now() < deadline) {
    details = await readProxySettings(page);
    if (
      details.levelOfControl === 'controllable_by_this_extension' &&
      details.mode !== 'pac_script'
    ) {
      return details;
    }
    await delay(100);
  }
  Assert.strictEqual(details.levelOfControl, 'controllable_by_this_extension');
  Assert.notStrictEqual(details.mode, 'pac_script');
  return details;

}

async function waitForExternalProxyControl(page) {

  const deadline = Date.now() + CHROME_TIMEOUT_MS;
  let details = null;
  while (Date.now() < deadline) {
    details = await readProxySettings(page);
    if (
      details.levelOfControl === 'controlled_by_other_extensions' &&
      details.mode === 'fixed_servers'
    ) {
      return details;
    }
    await delay(100);
  }
  Assert.strictEqual(details.levelOfControl, 'controlled_by_other_extensions');
  Assert.strictEqual(details.mode, 'fixed_servers');
  return details;

}

function createProxyOwnerHelper() {

  const helperPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-mv3-owner-helper-'),
  );
  Fs.writeFileSync(
      Path.join(helperPath, 'manifest.json'),
      JSON.stringify({
        background: {service_worker: 'worker.js'},
        manifest_version: 3,
        name: 'RUCB Chrome smoke proxy owner',
        permissions: ['proxy'],
        version: '1.0.0',
      }),
      'utf8',
  );
  Fs.writeFileSync(
      Path.join(helperPath, 'worker.js'),
      '\'use strict\';\nchrome.runtime.onInstalled.addListener(() => undefined);\n',
      'utf8',
  );
  Fs.writeFileSync(
      Path.join(helperPath, 'control.html'),
      '<!doctype html><meta charset="utf-8"><script src="control.js"></script>',
      'utf8',
  );
  Fs.writeFileSync(
      Path.join(helperPath, 'control.js'),
      [
        '\'use strict\';',
        'window.proxyOwner = {',
        '  get() {',
        '    return new Promise((resolve, reject) => {',
        '      chrome.proxy.settings.get({}, (details) => {',
        '        if (chrome.runtime.lastError) {',
        '          reject(new Error(chrome.runtime.lastError.message));',
        '          return;',
        '        }',
        '        resolve(details);',
        '      });',
        '    });',
        '  },',
        '  release() {',
        '    return new Promise((resolve, reject) => {',
        '      chrome.proxy.settings.clear({scope: \'regular\'}, () => {',
        '        if (chrome.runtime.lastError) {',
        '          reject(new Error(chrome.runtime.lastError.message));',
        '          return;',
        '        }',
        '        resolve();',
        '      });',
        '    });',
        '  },',
        '  takeOver(port) {',
        '    return new Promise((resolve, reject) => {',
        '      chrome.proxy.settings.set({',
        '        scope: \'regular\',',
        '        value: {',
        '          mode: \'fixed_servers\',',
        '          rules: {',
        '            bypassList: [\'<-loopback>\'],',
        '            singleProxy: {',
        '              host: \'127.0.0.1\',',
        '              port,',
        '              scheme: \'http\',',
        '            },',
        '          },',
        '        },',
        '      }, () => {',
        '        if (chrome.runtime.lastError) {',
        '          reject(new Error(chrome.runtime.lastError.message));',
        '          return;',
        '        }',
        '        resolve();',
        '      });',
        '    });',
        '  },',
        '};',
      ].join('\n'),
      'utf8',
  );
  return helperPath;

}

async function openProxyOwnerHelper(browser, helperPath) {

  const extensionId = await browser.installExtension(helperPath);
  const page = await browser.newPage();
  await page.goto(
      `chrome-extension://${extensionId}/control.html`,
      {waitUntil: 'domcontentloaded'},
  );
  await page.waitForFunction(
      () => window.proxyOwner && typeof window.proxyOwner.takeOver === 'function',
      {timeout: CHROME_TIMEOUT_MS},
  );
  return {extensionId, page};

}

function removeProxyOwnerHelper(helperPath) {

  const temporaryRoot = Path.resolve(Os.tmpdir());
  const resolved = Path.resolve(helperPath);
  Assert.strictEqual(Path.dirname(resolved), temporaryRoot);
  Assert.ok(Path.basename(resolved).startsWith('rucb-mv3-owner-helper-'));
  Fs.rmSync(resolved, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });

}

async function waitForProxyControl(page) {

  const deadline = Date.now() + CHROME_TIMEOUT_MS;
  let details = null;
  while (Date.now() < deadline) {
    details = await readProxySettings(page);
    if (
      details.hasPacData === true &&
      details.levelOfControl === 'controlled_by_this_extension' &&
      details.mandatory === false &&
      details.mode === 'pac_script'
    ) {
      return details;
    }
    await delay(100);
  }
  assertProxyControl(details);
  return details;

}

async function configureExtension(page, infrastructure) {

  const reset = await callRpc(page, 'resetMv3State');
  Assert.strictEqual(reset.ok, true);
  const added = await callRpc(page, 'addCustomPacProvider', {
    description: 'Chrome Stable MV3 browser smoke provider',
    enabled: true,
    label: 'Chrome Stable smoke',
    urls: [`http://127.0.0.1:${infrastructure.pac.port}/provider.pac`],
  });
  Assert.strictEqual(added.ok, true);
  const providerKey = added.provider.key;
  const selected = await callRpc(page, 'setCurrentPacProvider', {providerKey});
  Assert.strictEqual(selected.currentPacProviderKey, providerKey);

  const pacMods = await callRpc(page, 'getPacMods');
  const createOwnProxy = (endpoint, note, credentials = null) => ({
    enabled: true,
    host: '127.0.0.1',
    note,
    password: credentials ? credentials.password : '',
    port: endpoint.port,
    type: 'PROXY',
    username: credentials ? credentials.username : '',
    useAsDirectReplacement: false,
  });
  pacMods.ownProxies = [
    createOwnProxy(
        infrastructure.explicitProxy,
        'Chrome Stable MV3 browser smoke proxy',
    ),
    createOwnProxy(
        infrastructure.authProxyA,
        'Chrome Stable authenticated proxy A',
        infrastructure.credentials.proxyA,
    ),
    createOwnProxy(
        infrastructure.authProxyB,
        'Chrome Stable authenticated proxy B',
        infrastructure.credentials.proxyB,
    ),
    createOwnProxy(
        infrastructure.authPasswordless,
        'Chrome Stable passwordless proxy',
    ),
    createOwnProxy(
        infrastructure.authWrong,
        'Chrome Stable wrong-credential proxy',
        infrastructure.credentials.wrongConfigured,
    ),
  ];
  pacMods.localTor.enabled = false;
  pacMods.torBrowser.enabled = false;
  pacMods.warp.enabled = false;
  pacMods.usePacScriptProxies = true;
  pacMods.ownProxiesOnlyForOwnSites = true;
  pacMods.replaceDirectWithProxy = false;
  pacMods.noDirect = false;
  pacMods.whitelist = [];
  pacMods.exceptions = [];
  pacMods.rules = [
    {
      action: 'PROXY',
      enabled: true,
      note: 'Chrome Stable MV3 browser smoke',
      pattern: TEST_HOSTS.proxy,
    },
    {
      action: 'DIRECT',
      enabled: true,
      note: 'Chrome Stable MV3 browser smoke',
      pattern: TEST_HOSTS.direct,
    },
  ];
  const saved = await callRpc(page, 'setPacMods', {pacMods});
  Assert.strictEqual(saved.ok, true);

  const downloaded = await callRpc(page, 'downloadPac', {providerKey});
  Assert.strictEqual(downloaded.ok, true);
  Assert.strictEqual(downloaded.status, 'success');
  const cooked = await callRpc(page, 'cookPac', {providerKey});
  Assert.strictEqual(cooked.ok, true);
  Assert.strictEqual(cooked.status, 'success');
  const applied = await callRpc(page, 'applyCookedPac');
  Assert.strictEqual(applied.ok, true);
  Assert.strictEqual(applied.status, 'applied');
  assertProxyControl(await waitForProxyControl(page));

}

async function assertRoute(session, infrastructure, scenario) {

  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const trafficStart = infrastructure.traffic.length;
  const page = await session.browser.newPage();
  attachCredentialLeakGuard(
      page,
      session.diagnostics,
      session.credentialCanaries,
  );
  try {
    await page.setCacheEnabled(false);
    const response = await page.goto(
        `http://${scenario.host}:${infrastructure.origin.port}/` +
          `chrome-smoke?token=${token}`,
        {
          timeout: CHROME_TIMEOUT_MS,
          waitUntil: 'domcontentloaded',
        },
    );
    Assert.ok(response, `${scenario.name}: Chrome returned no response.`);
    Assert.strictEqual(await response.text(), scenario.marker);
    await delay(100);
  } finally {
    await page.close();
  }
  const hits = infrastructure.traffic
      .slice(trafficStart)
      .filter((entry) => entry.url.includes(token));
  Assert.deepStrictEqual(
      hits.map((entry) => entry.kind),
      [scenario.expectedReceiver],
      `${scenario.name}: request reached an unintended receiver: ` +
        JSON.stringify(hits),
  );

}

async function clearProxyAuthEvents(page) {

  const status = await callRpc(page, 'clearProxyAuthEvents');
  Assert.deepStrictEqual(status.lastEvents, []);
  return status;

}

async function waitForProxyAuthEvent(page, type, port) {

  const deadline = Date.now() + CHROME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await callRpc(page, 'getProxyAuthStatus');
    const event = status.lastEvents.slice().reverse().find((candidate) =>
      candidate.type === type && String(candidate.port) === String(port),
    );
    if (event) {
      return {event, status};
    }
    await delay(100);
  }
  Assert.fail(`Proxy auth event ${type} was not observed for the test endpoint.`);

}

function getTrafficForToken(infrastructure, trafficStart, token) {

  return infrastructure.traffic
      .slice(trafficStart)
      .filter((entry) => entry.url.includes(token));

}

async function navigateForAuthScenario(
    session,
    host,
    originPort,
    options = {},
) {

  const token = `${Date.now()}-${Crypto.randomBytes(8).toString('hex')}`;
  const page = await session.browser.newPage();
  attachCredentialLeakGuard(
      page,
      session.diagnostics,
      session.credentialCanaries,
  );
  let errorMessage = null;
  let responseBody = null;
  let responseStatus = null;
  try {
    await page.setCacheEnabled(false);
    const response = await page.goto(
        `http://${host}:${originPort}/chrome-auth-smoke?token=${token}`,
        {
          timeout: options.timeout || CHROME_TIMEOUT_MS,
          waitUntil: 'domcontentloaded',
        },
    );
    if (response) {
      responseStatus = response.status();
      responseBody = await response.text().catch(() => null);
    }
  } catch (error) {
    assertNoCredentialCanary(
        error && error.stack || error,
        session.credentialCanaries,
        `${options.name || 'auth scenario'} thrown error`,
    );
    errorMessage = redactCredentialCanaries(
        error && error.message || error,
        session.credentialCanaries,
    );
  } finally {
    await delay(200);
    await page.close();
  }
  return {
    errorMessage,
    responseBody,
    responseStatus,
    token,
  };

}

async function assertAuthenticatedProxyRoute(
    session,
    optionsPage,
    infrastructure,
    scenario,
) {

  await clearProxyAuthEvents(optionsPage);
  const trafficStart = infrastructure.traffic.length;
  const result = await navigateForAuthScenario(
      session,
      scenario.host,
      infrastructure.origin.port,
      {name: scenario.name},
  );
  Assert.strictEqual(result.errorMessage, null, `${scenario.name}: request failed.`);
  Assert.strictEqual(result.responseStatus, 200);
  Assert.strictEqual(result.responseBody, scenario.endpoint.marker);
  const hits = getTrafficForToken(
      infrastructure,
      trafficStart,
      result.token,
  );
  Assert.deepStrictEqual(
      hits.map((entry) => entry.kind),
      [scenario.endpoint.kind, scenario.endpoint.kind],
      `${scenario.name}: request reached an unintended receiver.`,
  );
  Assert.deepStrictEqual(
      hits.map((entry) => entry.auth),
      ['none', 'expected'],
      `${scenario.name}: expected unauthenticated 407 then authenticated retry.`,
  );
  const observed = await waitForProxyAuthEvent(
      optionsPage,
      'provided',
      scenario.endpoint.port,
  );
  assertNoCredentialCanary(
      observed,
      session.credentialCanaries,
      `${scenario.name} auth status`,
  );
  return hits.map((entry) => entry.auth);

}

async function assertOrigin401Ignored(
    session,
    optionsPage,
    infrastructure,
) {

  await clearProxyAuthEvents(optionsPage);
  const trafficStart = infrastructure.traffic.length;
  const result = await navigateForAuthScenario(
      session,
      TEST_HOSTS.origin401,
      infrastructure.unauthorizedOrigin.port,
      {
        name: 'ordinary origin 401',
        timeout: AUTH_FAILURE_TIMEOUT_MS,
      },
  );
  Assert.notStrictEqual(
      result.responseStatus,
      200,
      'Ordinary origin 401 unexpectedly succeeded.',
  );
  const hits = getTrafficForToken(
      infrastructure,
      trafficStart,
      result.token,
  );
  Assert.ok(hits.length >= 1, 'Ordinary origin 401 reached no receiver.');
  Assert.ok(
      hits.every((entry) => entry.kind === infrastructure.unauthorizedOrigin.kind),
      'Ordinary origin 401 reached a proxy receiver.',
  );
  Assert.ok(
      hits.every((entry) =>
        entry.authorization === 'none' && entry.proxyAuthorization === 'none',
      ),
      'Ordinary origin 401 received an authorization credential.',
  );
  const observed = await waitForProxyAuthEvent(
      optionsPage,
      'non_proxy_ignored',
      infrastructure.unauthorizedOrigin.port,
  );
  assertNoCredentialCanary(
      [result.errorMessage, observed],
      session.credentialCanaries,
      'ordinary origin 401 observations',
  );
  return {
    errorMessage: result.errorMessage,
    receiverEvidence: hits.map((entry) => ({
      authorization: entry.authorization,
      proxyAuthorization: entry.proxyAuthorization,
    })),
  };

}

async function assertNoCredentialProxyFailure(
    session,
    optionsPage,
    infrastructure,
    scenario,
) {

  await clearProxyAuthEvents(optionsPage);
  const trafficStart = infrastructure.traffic.length;
  const result = await navigateForAuthScenario(
      session,
      scenario.host,
      infrastructure.origin.port,
      {name: scenario.name, timeout: AUTH_FAILURE_TIMEOUT_MS},
  );
  Assert.notStrictEqual(
      result.responseStatus,
      200,
      `${scenario.name}: challenge unexpectedly succeeded.`,
  );
  const hits = getTrafficForToken(
      infrastructure,
      trafficStart,
      result.token,
  );
  Assert.ok(hits.length >= 1, `${scenario.name}: proxy received no request.`);
  Assert.ok(
      hits.every((entry) => entry.kind === scenario.endpoint.kind),
      `${scenario.name}: request reached an unintended receiver or DIRECT.`,
  );
  Assert.ok(
      hits.every((entry) => entry.auth === 'none'),
      `${scenario.name}: a configured credential was reused.`,
  );
  const observed = await waitForProxyAuthEvent(
      optionsPage,
      'missing_credentials',
      scenario.endpoint.port,
  );
  assertNoCredentialCanary(
      [result.errorMessage, observed],
      session.credentialCanaries,
      `${scenario.name} observations`,
  );
  return {
    errorMessage: result.errorMessage,
    receiverEvidence: hits.map((entry) => entry.auth),
  };

}

async function assertWrongCredentialsStop(
    session,
    optionsPage,
    infrastructure,
) {

  await clearProxyAuthEvents(optionsPage);
  const trafficStart = infrastructure.traffic.length;
  const result = await navigateForAuthScenario(
      session,
      TEST_HOSTS.authWrong,
      infrastructure.origin.port,
      {
        name: 'wrong credentials retry limit',
        timeout: AUTH_FAILURE_TIMEOUT_MS,
      },
  );
  Assert.notStrictEqual(
      result.responseStatus,
      200,
      'Wrong proxy credentials unexpectedly succeeded.',
  );
  const hits = getTrafficForToken(
      infrastructure,
      trafficStart,
      result.token,
  );
  Assert.ok(hits.length >= 2, 'Wrong credential proxy did not receive a retry.');
  Assert.ok(hits.length <= 3, 'Wrong credential proxy challenge loop was unbounded.');
  Assert.strictEqual(hits[0].auth, 'none');
  Assert.ok(
      hits.slice(1).every((entry) => entry.auth === 'known-wrong'),
      'Wrong credential proxy received an unknown reusable credential.',
  );
  Assert.ok(
      hits.slice(1).length <= 2,
      'RUCB supplied credentials beyond the current retry limit.',
  );
  Assert.ok(
      hits.every((entry) => entry.kind === infrastructure.authWrong.kind),
      'Wrong credential request reached an unintended receiver or DIRECT.',
  );
  const observed = await waitForProxyAuthEvent(
      optionsPage,
      'retry_limit',
      infrastructure.authWrong.port,
  );
  Assert.strictEqual(observed.status.retryLimit, 2);
  assertNoCredentialCanary(
      [result.errorMessage, observed],
      session.credentialCanaries,
      'wrong credential observations',
  );
  return {
    errorMessage: result.errorMessage,
    receiverEvidence: hits.map((entry) => entry.auth),
  };

}

async function assertCredentialRedaction(
    session,
    optionsPage,
    infrastructure,
    observedErrors,
) {

  const rpcSurfaces = await Promise.all([
    callRpc(optionsPage, 'getState'),
    callRpc(optionsPage, 'getPacMods'),
    callRpc(optionsPage, 'getProxyAuthStatus'),
    callRpc(optionsPage, 'testProxyAuthConfig'),
  ]);
  assertNoCredentialCanary(
      rpcSurfaces,
      session.credentialCanaries,
      'RPC response models',
  );

  const pacData = await readAppliedPacData(optionsPage);
  Assert.ok(pacData, 'Applied PAC data was unavailable for redaction review.');
  assertNoCredentialCanary(
      pacData,
      session.credentialCanaries,
      'applied PAC data',
  );
  Object.values(infrastructure.credentials).forEach((credential) => {
    Assert.strictEqual(
        pacData.includes(credential.username),
        false,
        'Applied PAC data exposed an own-proxy username.',
    );
  });

  await optionsPage.evaluate(() => {
    window.location.hash = 'proxy-methods';
  });
  await optionsPage.waitForFunction(
      () => document.querySelectorAll('[name="proxy.password"]').length >= 5,
      {timeout: CHROME_TIMEOUT_MS},
  );
  const optionsDom = await optionsPage.evaluate(() => ({
    html: document.documentElement.outerHTML,
    inputValues: Array.from(document.querySelectorAll('input'))
        .map((input) => input.value),
    passwordValues: Array.from(
        document.querySelectorAll('[name="proxy.password"]'),
    ).map((input) => input.value),
    text: document.documentElement.textContent,
  }));
  assertNoCredentialCanary(
      optionsDom,
      session.credentialCanaries,
      'options DOM',
  );
  Assert.ok(
      optionsDom.passwordValues.every((value) => value === ''),
      'Options rendered a stored proxy password.',
  );

  const popupPage = await openPopupPage(session);
  try {
    const popupDom = await popupPage.evaluate(() => ({
      html: document.documentElement.outerHTML,
      inputValues: Array.from(document.querySelectorAll('input'))
          .map((input) => input.value),
      text: document.documentElement.textContent,
    }));
    assertNoCredentialCanary(
        popupDom,
        session.credentialCanaries,
        'popup DOM',
    );
    Object.values(infrastructure.credentials).forEach((credential) => {
      Assert.strictEqual(
          containsTextValue(popupDom, credential.username),
          false,
          'Popup DOM exposed an own-proxy username.',
      );
    });
  } finally {
    await popupPage.close();
  }

  assertNoCredentialCanary(
      [session.diagnostics, observedErrors, infrastructure.traffic],
      session.credentialCanaries,
      'diagnostics, errors, or receiver logs',
  );
  Object.values(infrastructure.credentials).forEach((credential) => {
    Assert.strictEqual(
        containsTextValue(session.diagnostics, credential.username),
        false,
        'Extension diagnostics exposed an own-proxy username.',
    );
  });

}

function assertNoSeriousDiagnostics(diagnostics) {

  Assert.deepStrictEqual(
      diagnostics,
      [],
      'Unexpected extension startup/runtime diagnostics: ' +
        diagnostics.join('\n'),
  );

}

function removeProfile(profilePath) {

  const temporaryRoot = Path.resolve(Os.tmpdir());
  const resolvedProfile = Path.resolve(profilePath);
  Assert.strictEqual(Path.dirname(resolvedProfile), temporaryRoot);
  Assert.ok(Path.basename(resolvedProfile).startsWith('rucb-mv3-smoke-'));
  Fs.rmSync(resolvedProfile, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 100,
  });

}

async function runSmoke() {

  assertBuiltExtension();
  const chromeExecutable = resolveChromeExecutable();
  const profilePath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-mv3-smoke-'),
  );
  const helperPath = createProxyOwnerHelper();
  let browser = null;
  let infrastructure = null;
  let chromeVersion = '';
  const observedErrors = [];
  try {
    infrastructure = await createInfrastructure();
    let session = await launchExtension(
        chromeExecutable,
        profilePath,
        infrastructure.credentialCanaries,
    );
    console.log('Chrome smoke: loaded RUCB for initial routing checks.');
    browser = session.browser;
    chromeVersion = await browser.version();
    const optionsPage = await openExtensionPage(session);
    await configureExtension(optionsPage, infrastructure);
    console.log('Chrome smoke: applied synthetic PAC configuration.');
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'provider-proxy',
      host: TEST_HOSTS.auto,
      marker: infrastructure.providerProxy.marker,
      name: 'Auto provider policy',
    });
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'explicit-proxy',
      host: TEST_HOSTS.proxy,
      marker: infrastructure.explicitProxy.marker,
      name: 'explicit Proxy rule',
    });
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'origin',
      host: TEST_HOSTS.direct,
      marker: infrastructure.origin.marker,
      name: 'explicit Direct rule',
    });
    const authAEvidence = await assertAuthenticatedProxyRoute(
        session,
        optionsPage,
        infrastructure,
        {
          endpoint: infrastructure.authProxyA,
          host: TEST_HOSTS.authA,
          name: 'authenticated HTTP proxy A',
        },
    );
    await assertCredentialRedaction(
        session,
        optionsPage,
        infrastructure,
        observedErrors,
    );
    console.log(
        `Chrome smoke 407: proxy A ${authAEvidence.join(' -> ')}.`,
    );
    assertNoSeriousDiagnostics(session.diagnostics);
    const firstExtensionId = session.extensionId;
    await optionsPage.close();
    await browser.close();
    browser = null;

    console.log('Chrome smoke: verifying applied PAC after browser restart.');
    session = await launchExtension(
        chromeExecutable,
        profilePath,
        infrastructure.credentialCanaries,
    );
    browser = session.browser;
    Assert.strictEqual(
        session.extensionId,
        firstExtensionId,
        'The unpacked extension ID changed across the profile restart.',
    );
    const restartedOptionsPage = await openExtensionPage(session);
    assertProxyControl(await waitForProxyControl(restartedOptionsPage));
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'explicit-proxy',
      host: TEST_HOSTS.proxy,
      marker: infrastructure.explicitProxy.marker,
      name: 'restart recovery Proxy rule',
    });
    const authBEvidence = await assertAuthenticatedProxyRoute(
        session,
        restartedOptionsPage,
        infrastructure,
        {
          endpoint: infrastructure.authProxyB,
          host: TEST_HOSTS.authB,
          name: 'authenticated HTTP proxy B after restart',
        },
    );
    const origin401Evidence = await assertOrigin401Ignored(
        session,
        restartedOptionsPage,
        infrastructure,
    );
    const mismatchEvidence = await assertNoCredentialProxyFailure(
        session,
        restartedOptionsPage,
        infrastructure,
        {
          endpoint: infrastructure.authMismatch,
          host: TEST_HOSTS.authMismatch,
          name: 'mismatched proxy challenger',
        },
    );
    const passwordlessEvidence = await assertNoCredentialProxyFailure(
        session,
        restartedOptionsPage,
        infrastructure,
        {
          endpoint: infrastructure.authPasswordless,
          host: TEST_HOSTS.authPasswordless,
          name: 'passwordless configured proxy',
        },
    );
    const wrongEvidence = await assertWrongCredentialsStop(
        session,
        restartedOptionsPage,
        infrastructure,
    );
    observedErrors.push(
        origin401Evidence.errorMessage,
        mismatchEvidence.errorMessage,
        passwordlessEvidence.errorMessage,
        wrongEvidence.errorMessage,
    );
    await assertCredentialRedaction(
        session,
        restartedOptionsPage,
        infrastructure,
        observedErrors,
    );
    console.log(
        `Chrome smoke 407: proxy B after restart ${authBEvidence.join(' -> ')}.`,
    );
    console.log(
        'Chrome smoke 407: origin 401 credentials ' +
          `${origin401Evidence.receiverEvidence[0].authorization}/` +
          `${origin401Evidence.receiverEvidence[0].proxyAuthorization}.`,
    );
    console.log(
        'Chrome smoke 407: mismatched/passwordless ' +
          `${mismatchEvidence.receiverEvidence.join(' -> ')}/` +
          `${passwordlessEvidence.receiverEvidence.join(' -> ')}.`,
    );
    console.log(
        `Chrome smoke 407: wrong credentials ` +
          `${wrongEvidence.receiverEvidence.join(' -> ')} then retry limit.`,
    );
    assertNoSeriousDiagnostics(session.diagnostics);

    console.log('Chrome smoke: installing temporary proxy-owner extension.');
    const helper = await openProxyOwnerHelper(browser, helperPath);
    console.log('Chrome smoke: exercising proxy ownership takeover and release.');
    await helper.page.evaluate(
        (port) => window.proxyOwner.takeOver(port),
        infrastructure.helperProxy.port,
    );
    await waitForExternalProxyControl(restartedOptionsPage);
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'helper-proxy',
      host: TEST_HOSTS.proxy,
      marker: infrastructure.helperProxy.marker,
      name: 'external owner takeover',
    });

    const cleared = await callRpc(restartedOptionsPage, 'clearProxy');
    Assert.deepStrictEqual(
        {
          cleanupStatus: cleared.cleanupStatus,
          ok: cleared.ok,
          status: cleared.status,
        },
        {cleanupStatus: 'deferred', ok: true, status: 'cleared'},
    );
    const helperControl = await helper.page.evaluate(() =>
      window.proxyOwner.get(),
    );
    Assert.strictEqual(helperControl.levelOfControl, 'controlled_by_this_extension');
    Assert.strictEqual(helperControl.value.mode, 'fixed_servers');
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'helper-proxy',
      host: TEST_HOSTS.proxy,
      marker: infrastructure.helperProxy.marker,
      name: 'deferred Clear preserves external owner',
    });

    await helper.page.evaluate(() => window.proxyOwner.release());
    await helper.page.close();
    await waitForProxyOff(restartedOptionsPage);
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'origin',
      host: TEST_HOSTS.proxy,
      marker: infrastructure.origin.marker,
      name: 'ownership release keeps RUCB off',
    });
    await restartedOptionsPage.close();

    await browser.close();
    browser = null;
    console.log('Chrome smoke: verifying deferred Clear after browser restart.');
    session = await launchExtension(
        chromeExecutable,
        profilePath,
        infrastructure.credentialCanaries,
    );
    browser = session.browser;
    Assert.strictEqual(session.extensionId, firstExtensionId);
    const clearedRestartPage = await openExtensionPage(session);
    await waitForProxyOff(clearedRestartPage);
    await assertRoute(session, infrastructure, {
      expectedReceiver: 'origin',
      host: TEST_HOSTS.proxy,
      marker: infrastructure.origin.marker,
      name: 'deferred Clear survives restart',
    });
    assertNoSeriousDiagnostics(session.diagnostics);
    await clearedRestartPage.close();
    console.log(`Chrome Stable MV3 smoke passed with ${chromeVersion}.`);
    console.log(
        'Verified Auto -> provider proxy, Proxy -> explicit proxy, ' +
        'Direct -> origin, restart recovery -> explicit proxy, and ' +
        'external takeover -> deferred Clear -> direct after release/restart. ' +
        'Verified real HTTP 407 auth, durable credentials, 401/mismatch/' +
        'passwordless rejection, retry limiting, and credential redaction.',
    );
  } catch (error) {
    throw createSafeError(
        error,
        infrastructure && infrastructure.credentialCanaries || [],
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    try {
      await closeInfrastructure(infrastructure);
    } finally {
      try {
        removeProfile(profilePath);
      } finally {
        removeProxyOwnerHelper(helperPath);
      }
    }
  }

}

if (require.main === module) {
  runSmoke().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
  });
}

module.exports = {
  PACKAGED_MV3_ROOT,
  resolveChromeExecutable,
  runSmoke,
};
