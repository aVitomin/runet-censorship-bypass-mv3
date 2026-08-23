'use strict';


const Assert = require('assert');
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
  direct: 'direct.qa.test',
  proxy: 'proxy.qa.test',
});
const CHROME_TIMEOUT_MS = 20 * 1000;

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

async function createPacServer(providerProxyPort) {

  const pacData = [
    'function FindProxyForURL(url, host) {',
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
  const origin = await createReceiver('origin', traffic);
  const providerProxy = await createReceiver('provider-proxy', traffic);
  const explicitProxy = await createReceiver('explicit-proxy', traffic);
  const helperProxy = await createReceiver('helper-proxy', traffic);
  const pac = await createPacServer(providerProxy.port);
  return {
    explicitProxy,
    helperProxy,
    origin,
    pac,
    providerProxy,
    traffic,
  };

}

async function closeInfrastructure(infrastructure) {

  if (!infrastructure) {
    return;
  }
  await Promise.all([
    infrastructure.pac,
    infrastructure.explicitProxy,
    infrastructure.helperProxy,
    infrastructure.providerProxy,
    infrastructure.origin,
  ].map((endpoint) => closeServer(endpoint.server)));

}

function attachWorkerDiagnostics(worker, diagnostics, monitoredWorkers) {

  if (!worker || monitoredWorkers.has(worker)) {
    return;
  }
  monitoredWorkers.add(worker);
  worker.on('error', (error) => {
    diagnostics.push(`service worker exception: ${error.message || error}`);
  });
  worker.on('console', (message) => {
    const type = message.type();
    const text = message.text();
    if (
      ['error', 'assert'].includes(type) ||
      (type === 'warn' && /error|exception|failed/i.test(text))
    ) {
      diagnostics.push(`service worker console ${type}: ${text}`);
    }
  });

}

function attachPageDiagnostics(page, diagnostics) {

  page.on('pageerror', (error) => {
    diagnostics.push(`extension page exception: ${error.message || error}`);
  });
  page.on('console', (message) => {
    if (['error', 'assert'].includes(message.type())) {
      diagnostics.push(
          `extension page console ${message.type()}: ${message.text()}`,
      );
    }
  });

}

function isExtensionWorkerTarget(target) {

  return target.type() === 'service_worker' &&
    target.url().startsWith('chrome-extension://') &&
    target.url().endsWith(SERVICE_WORKER_PATH);

}

async function launchExtension(chromeExecutable, profilePath) {

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
        `MAP ${TEST_HOSTS.proxy} 127.0.0.1`,
        `MAP ${TEST_HOSTS.direct} 127.0.0.1`,
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
  attachWorkerDiagnostics(worker, diagnostics, monitoredWorkers);
  return {
    browser,
    diagnostics,
    extensionId,
  };

}

async function openExtensionPage(session) {

  const page = await session.browser.newPage();
  attachPageDiagnostics(page, session.diagnostics);
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
  pacMods.ownProxies = [{
    enabled: true,
    host: '127.0.0.1',
    note: 'Chrome Stable MV3 browser smoke proxy',
    password: '',
    port: infrastructure.explicitProxy.port,
    type: 'PROXY',
    username: '',
    useAsDirectReplacement: false,
  }];
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
  try {
    infrastructure = await createInfrastructure();
    let session = await launchExtension(chromeExecutable, profilePath);
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
    assertNoSeriousDiagnostics(session.diagnostics);
    const firstExtensionId = session.extensionId;
    await optionsPage.close();
    await browser.close();
    browser = null;

    console.log('Chrome smoke: verifying applied PAC after browser restart.');
    session = await launchExtension(chromeExecutable, profilePath);
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
    session = await launchExtension(chromeExecutable, profilePath);
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
        'external takeover -> deferred Clear -> direct after release/restart.',
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
