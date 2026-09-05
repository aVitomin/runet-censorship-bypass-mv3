'use strict';

const Assert = require('node:assert');
const ChildProcess = require('node:child_process');
const Fs = require('node:fs');
const Http = require('node:http');
const Net = require('node:net');
const Os = require('node:os');
const Path = require('node:path');

const MANUAL_PROXY_MARKER = 'FIREFOX_SKELETON_MANUAL_PROXY';
const projectRoot = Path.resolve(__dirname, '..', '..', '..');
const packageRoot = Path.join(projectRoot, 'build', 'extension-firefox-mv3');

function delay(milliseconds) {

  return new Promise((resolve) => setTimeout(resolve, milliseconds));

}

function resolveFirefox() {

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
    Fs.existsSync(candidate) && Fs.statSync(candidate).isFile());
  Assert.ok(executable, 'Firefox was not found. Set FIREFOX_BIN explicitly.');
  return executable;

}

function firefoxVersion(executable) {

  const result = ChildProcess.spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  Assert.strictEqual(result.status, 0, result.stderr);
  return String(result.stdout || result.stderr).trim();

}

function listen(server) {

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

}

function closeServer(server) {

  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

}

async function unusedPort() {

  const server = Net.createServer();
  await listen(server);
  const port = server.address().port;
  await closeServer(server);
  return port;

}

function safeRemoveTemporary(directory, prefix) {

  const resolved = Path.resolve(directory);
  const expectedParent = Path.resolve(Os.tmpdir()).toLowerCase();
  Assert.ok(
      Path.dirname(resolved).toLowerCase() === expectedParent &&
      Path.basename(resolved).startsWith(prefix),
      `Unexpected temporary directory: ${resolved}`,
  );
  Fs.rmSync(resolved, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });

}

function makeInstrumentedExtension(collectorPort) {

  const directory = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-firefox-skeleton-extension-'),
  );
  Fs.cpSync(packageRoot, directory, {recursive: true});
  const manifestPath = Path.join(directory, 'manifest.json');
  const manifest = JSON.parse(Fs.readFileSync(manifestPath, 'utf8'));
  manifest.permissions.push('alarms');
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.background.scripts.push('test-observer.js');
  Fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const collectorUrl = `http://127.0.0.1:${collectorPort}/boot`;
  Fs.writeFileSync(Path.join(directory, 'test-observer.js'), [
    '\'use strict\';',
    'browser.alarms.onAlarm.addListener(() => {});',
    'browser.alarms.create(\'lifecycle-wake\', {delayInMinutes: 1});',
    '(async () => {',
    '  const initialization = await',
    '    globalThis.rucbFirefoxSkeletonRuntime.whenReady();',
    '  const stored = await browser.storage.local.get(',
    '    globalThis.rucbFirefoxOffState.STORAGE_KEY,',
    '  );',
    '  const state = stored[globalThis.rucbFirefoxOffState.STORAGE_KEY];',
    `  await fetch(${JSON.stringify(collectorUrl)}, {`,
    '    method: \'POST\',',
    '    headers: {\'content-type\': \'application/json\'},',
    '    body: JSON.stringify({',
    '      bootId: globalThis.rucbFirefoxSkeletonRuntime.bootId,',
    '      initialization,',
    '      state,',
    '    }),',
    '  });',
    '})();',
  ].join('\n'));
  Fs.writeFileSync(Path.join(directory, 'probe.html'), [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>Firefox skeleton lifecycle probe</title>',
    '<body></body>',
    '<script src="probe.js"></script>',
  ].join('\n'));
  Fs.writeFileSync(Path.join(directory, 'probe.js'), [
    '\'use strict\';',
    '(async () => {',
    '  const capabilities = await browser.runtime.sendMessage({',
    '    type: \'firefox.capabilities.get\',',
    '  });',
    '  const background = browser.extension.getBackgroundPage();',
    '  await background.rucbFirefoxSkeletonRuntime.whenReady();',
    '  document.body.textContent = JSON.stringify({',
    '    bootId: background.rucbFirefoxSkeletonRuntime.bootId,',
    '    capabilities,',
    '  });',
    '})().catch((error) => {',
    '  document.body.textContent = JSON.stringify({error: String(error)});',
    '});',
  ].join('\n'));
  return directory;

}

function profilePreferences(marionettePort, proxyPort) {

  const preferences = {
    'app.normandy.enabled': false,
    'app.update.auto': false,
    'app.update.background.enabled': false,
    'app.update.checkInstallTime': false,
    'app.update.disabledForTesting': true,
    'app.update.enabled': false,
    'app.update.service.enabled': false,
    'app.update.url': 'http://127.0.0.1:9/disabled',
    'browser.aboutwelcome.enabled': false,
    'browser.discovery.enabled': false,
    'browser.safebrowsing.downloads.enabled': false,
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    'browser.search.update': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.page': 0,
    'datareporting.healthreport.uploadEnabled': false,
    'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
    'dom.push.enabled': false,
    'extensions.allowPrivateBrowsingByDefault': false,
    'extensions.blocklist.enabled': false,
    'extensions.systemAddon.update.enabled': false,
    'extensions.update.enabled': false,
    'marionette.enabled': true,
    'marionette.port': marionettePort,
    'media.gmp-manager.updateEnabled': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': proxyPort,
    'network.proxy.no_proxies_on': '127.0.0.1,localhost',
    'network.proxy.share_proxy_settings': true,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': proxyPort,
    'network.proxy.type': 1,
    'toolkit.telemetry.enabled': false,
    'toolkit.telemetry.unified': false,
  };
  return `${Object.entries(preferences).map(([name, value]) =>
    `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
  ).join(Os.EOL)}${Os.EOL}`;

}

class MarionetteClient {

  constructor(socket) {

    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.greeting = new Promise((resolve, reject) => {
      this.resolveGreeting = resolve;
      this.rejectGreeting = reject;
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('Marionette closed.')));

  }

  onData(chunk) {

    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const colon = this.buffer.indexOf(58);
      if (colon < 0) {
        return;
      }
      const length = Number(this.buffer.subarray(0, colon).toString('ascii'));
      const start = colon + 1;
      if (!Number.isInteger(length) || this.buffer.length < start + length) {
        return;
      }
      const message = JSON.parse(
          this.buffer.subarray(start, start + length).toString('utf8'),
      );
      this.buffer = this.buffer.subarray(start + length);
      if (!Array.isArray(message)) {
        this.resolveGreeting(message);
      } else if (message[0] === 1 && this.pending.has(message[1])) {
        const pending = this.pending.get(message[1]);
        this.pending.delete(message[1]);
        if (message[2]) {
          pending.reject(new Error(message[2].message || String(message[2])));
        } else {
          pending.resolve(message[3]);
        }
      }
    }

  }

  fail(error) {

    this.rejectGreeting(error);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();

  }

  command(name, parameters = {}) {

    const id = this.nextId++;
    const json = JSON.stringify([0, id, name, parameters]);
    const frame = `${Buffer.byteLength(json, 'utf8')}:${json}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {reject, resolve});
      this.socket.write(frame, 'utf8', (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });

  }

  close() {

    this.socket.destroy();

  }

}

async function connectMarionette(port) {

  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const candidate = Net.createConnection({host: '127.0.0.1', port});
        candidate.once('connect', () => resolve(candidate));
        candidate.once('error', reject);
      });
      const client = new MarionetteClient(socket);
      await client.greeting;
      return client;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`Marionette did not start: ${lastError}`);

}

function webdriverValue(result) {

  return result && typeof result === 'object' && 'value' in result ?
    result.value : result;

}

async function navigate(client, url) {

  await client.command('WebDriver:Navigate', {url});

}

async function bodyText(client) {

  return webdriverValue(await client.command('WebDriver:ExecuteScript', {
    args: [],
    filename: 'firefox-skeleton-lifecycle-smoke.js',
    line: 1,
    newSandbox: true,
    script: 'return document.body.textContent;',
  }));

}

async function extensionOrigin(client) {

  await client.command('Marionette:SetContext', {value: 'chrome'});
  let preference;
  try {
    preference = webdriverValue(await client.command('WebDriver:ExecuteScript', {
      args: [],
      filename: 'firefox-skeleton-lifecycle-smoke.js',
      line: 1,
      newSandbox: false,
      script: [
        'return Services.prefs.getStringPref(',
        '  "extensions.webextensions.uuids"',
        ');',
      ].join('\n'),
    }));
  } finally {
    await client.command('Marionette:SetContext', {value: 'content'});
  }
  const uuids = JSON.parse(preference);
  const uuid = uuids['firefox-mv3-skeleton@runet-censorship-bypass.invalid'];
  Assert.strictEqual(typeof uuid, 'string', preference);
  return `moz-extension://${uuid}`;

}

async function readCapabilities(client, origin) {

  await navigate(client, `${origin}/probe.html`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const text = String(await bodyText(client) || '').trim();
    if (text) {
      const result = JSON.parse(text);
      Assert.strictEqual('error' in result, false, result.error);
      await navigate(client, 'about:blank');
      return result;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the extension RPC probe.');

}

async function waitForBoot(bootEvents, predicate, timeoutMilliseconds) {

  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const event = bootEvents.find(predicate);
    if (event) {
      return event;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for a Firefox event-page boot.');

}

async function waitForExit(child, timeoutMilliseconds) {

  if (child.exitCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMilliseconds).then(() => {
      throw new Error('Firefox exit timed out.');
    }),
  ]);

}

async function main() {

  Assert.strictEqual(Fs.existsSync(packageRoot), true, 'Run build:firefox first.');
  const firefox = resolveFirefox();
  const bootEvents = [];
  const proxyRequests = [];
  const collector = Http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/boot') {
        bootEvents.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }
      response.writeHead(204);
      response.end();
    });
  });
  const proxy = Http.createServer((request, response) => {
    proxyRequests.push(request.url);
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end(MANUAL_PROXY_MARKER);
  });
  await listen(collector);
  await listen(proxy);
  const extensionDirectory = makeInstrumentedExtension(collector.address().port);
  const profileDirectory = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-firefox-skeleton-profile-'),
  );
  const marionettePort = await unusedPort();
  Fs.writeFileSync(
      Path.join(profileDirectory, 'user.js'),
      profilePreferences(marionettePort, proxy.address().port),
  );
  const child = ChildProcess.spawn(firefox, [
    '-headless',
    '-no-remote',
    '-profile',
    profileDirectory,
    '-marionette',
    '-remote-allow-system-access',
    'about:blank',
  ], {
    env: Object.assign({}, process.env, {
      MOZ_CRASHREPORTER_DISABLE: '1',
      MOZ_DISABLE_NONLOCAL_CONNECTIONS: '1',
      MOZ_NO_REMOTE: '1',
    }),
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let client;
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8000);
  });
  try {
    client = await connectMarionette(marionettePort);
    await client.command('WebDriver:NewSession', {
      capabilities: {
        alwaysMatch: {pageLoadStrategy: 'normal'},
        firstMatch: [{}],
      },
    });
    const handles = webdriverValue(
        await client.command('WebDriver:GetWindowHandles'),
    );
    Assert.ok(Array.isArray(handles) && handles.length > 0, 'No Firefox window.');
    await client.command('WebDriver:SwitchToWindow', {
      handle: handles[handles.length - 1],
    });
    await client.command('WebDriver:SetTimeouts', {
      implicit: 0,
      pageLoad: 15000,
      script: 15000,
    });

    await navigate(client, 'http://manual-proxy-check.invalid/before-install');
    Assert.strictEqual(await bodyText(client), MANUAL_PROXY_MARKER);
    await client.command('Addon:Install', {
      allowPrivateBrowsing: false,
      path: packageRoot,
      temporary: true,
    });
    await delay(500);
    await navigate(
        client,
        'http://manual-proxy-check.invalid/after-production-install',
    );
    Assert.strictEqual(await bodyText(client), MANUAL_PROXY_MARKER);
    await client.command('Addon:Uninstall', {
      id: 'firefox-mv3-skeleton@runet-censorship-bypass.invalid',
    });
    await client.command('Addon:Install', {
      allowPrivateBrowsing: false,
      path: extensionDirectory,
      temporary: true,
    });
    const first = await waitForBoot(bootEvents, () => true, 15000);
    Assert.deepStrictEqual(first.state, {
      schemaVersion: 3,
      intent: 'OFF',
      floorIdentity: null,
    });
    const origin = await extensionOrigin(client);
    const firstRpc = await readCapabilities(client, origin);
    Assert.strictEqual(firstRpc.bootId, first.bootId);
    Assert.strictEqual(firstRpc.capabilities.result.runtimeState, 'OFF');
    Assert.strictEqual(firstRpc.capabilities.result.durableIntent, 'OFF');
    await navigate(client, 'http://manual-proxy-check.invalid/after-install');
    Assert.strictEqual(await bodyText(client), MANUAL_PROXY_MARKER);

    console.log('Waiting for automatic Firefox event-page idle recreation...');
    const second = await waitForBoot(
        bootEvents,
        (event) => event.bootId !== first.bootId,
        105000,
    );
    Assert.deepStrictEqual(second.state, {
      schemaVersion: 3,
      intent: 'OFF',
      floorIdentity: null,
    });
    const secondRpc = await readCapabilities(client, origin);
    Assert.strictEqual(secondRpc.bootId, second.bootId);
    Assert.strictEqual(secondRpc.capabilities.result.runtimeState, 'OFF');
    Assert.strictEqual(secondRpc.capabilities.result.durableIntent, 'OFF');
    await navigate(client, 'http://manual-proxy-check.invalid/after-recreation');
    Assert.strictEqual(await bodyText(client), MANUAL_PROXY_MARKER);

    const phases = [
      'before-install',
      'after-production-install',
      'after-install',
      'after-recreation',
    ];
    for (const phase of phases) {
      Assert.ok(proxyRequests.some((url) => url.includes(`/${phase}`)), phase);
    }
    console.log(JSON.stringify({
      firefox: firefoxVersion(firefox),
      firstBootId: first.bootId,
      recreatedBootId: second.bootId,
      runtimeState: secondRpc.capabilities.result.runtimeState,
      durableIntent: secondRpc.capabilities.result.durableIntent,
      privateWindowAccess: secondRpc.capabilities.result.privateWindowAccess,
      manualProxyChecks: phases.length,
      productionPackageInstalledSeparately: true,
    }, null, 2));
  } catch (error) {
    throw new Error(`${error && error.stack ? error.stack : error}\n${stderr}`);
  } finally {
    if (client) {
      try {
        await client.command('Marionette:Quit', {flags: ['eForceQuit']});
      } catch (_error) {
        // Firefox normally closes Marionette before replying.
      }
      client.close();
    }
    try {
      await waitForExit(child, 10000);
    } catch (_error) {
      child.kill();
      await waitForExit(child, 5000).catch(() => {});
    }
    await closeServer(collector);
    await closeServer(proxy);
    safeRemoveTemporary(
        extensionDirectory,
        'rucb-firefox-skeleton-extension-',
    );
    safeRemoveTemporary(profileDirectory, 'rucb-firefox-skeleton-profile-');
  }

}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  bodyText,
  closeServer,
  connectMarionette,
  delay,
  extensionOrigin,
  firefoxVersion,
  listen,
  navigate,
  profilePreferences,
  resolveFirefox,
  safeRemoveTemporary,
  unusedPort,
  waitForExit,
  webdriverValue,
});
