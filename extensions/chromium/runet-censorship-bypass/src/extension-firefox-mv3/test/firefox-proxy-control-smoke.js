'use strict';

const Assert = require('node:assert');
const ChildProcess = require('node:child_process');
const Fs = require('node:fs');
const Http = require('node:http');
const Os = require('node:os');
const Path = require('node:path');
const Smoke = require('./firefox-lifecycle-smoke');

const EXTENSION_ID = 'firefox-mv3-skeleton@runet-censorship-bypass.invalid';
const MANUAL_PROXY_MARKER = 'FIREFOX_PROXY_CONTROL_PREVIOUS_MANUAL';
const projectRoot = Path.resolve(__dirname, '..', '..', '..');
const packageRoot = Path.join(projectRoot, 'build', 'extension-firefox-mv3');

function localIpv4() {

  for (const addresses of Object.values(Os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }
  throw new Error('A local non-loopback IPv4 address is required.');

}

function floor(port) {

  return {
    proxyType: 'manual',
    http: '',
    httpProxyAll: false,
    ssl: '',
    socks: `127.0.0.1:${port}`,
    socksVersion: 5,
    proxyDNS: true,
    passthrough: '',
    autoConfigUrl: '',
  };

}

async function highUnusedPort() {

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await Smoke.unusedPort();
    if (port >= 49152) {
      return port;
    }
  }
  throw new Error('Could not obtain a high externally prevalidated port.');

}

function makeInstrumentedExtension() {

  const directory = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-firefox-control-extension-'),
  );
  Fs.cpSync(packageRoot, directory, {recursive: true});
  Fs.writeFileSync(Path.join(directory, 'control.html'), [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<title>Firefox proxy control smoke</title>',
    '<body></body>',
    '<script src="control.js"></script>',
  ].join('\n'));
  Fs.writeFileSync(Path.join(directory, 'control.js'), [
    '\'use strict\';',
    '(async () => {',
    '  const parameters = new URLSearchParams(location.search);',
    '  const action = parameters.get(\'action\');',
    '  const background = browser.extension.getBackgroundPage();',
    '  await background.rucbFirefoxSkeletonRuntime.whenReady();',
    '  const OffState = background.rucbFirefoxOffState;',
    '  const ProxyControl = background.rucbFirefoxProxyControl;',
    '  const counters = {clear: 0, get: 0, set: 0};',
    '  const proxySettings = {',
    '    clear(value) {',
    '      counters.clear += 1;',
    '      return browser.proxy.settings.clear(value);',
    '    },',
    '    get(value) {',
    '      counters.get += 1;',
    '      return browser.proxy.settings.get(value);',
    '    },',
    '    set(value) {',
    '      counters.set += 1;',
    '      return browser.proxy.settings.set(value);',
    '    },',
    '  };',
    '  const controller = ProxyControl.createController({',
    '    proxySettings,',
    '    storageArea: browser.storage.local,',
    '    isPrivateAccessAllowed: () =>',
    '      browser.extension.isAllowedIncognitoAccess(),',
    '  });',
    '  const port = Number(parameters.get(\'port\'));',
    '  const floorIdentity = {',
    '    proxyType: \'manual\',',
    '    http: \'\',',
    '    httpProxyAll: false,',
    '    ssl: \'\',',
    '    socks: `127.0.0.1:${port}`,',
    '    socksVersion: 5,',
    '    proxyDNS: true,',
    '    passthrough: \'\',',
    '    autoConfigUrl: \'\',',
    '  };',
    '  let result;',
    '  if (action === \'status\') {',
    '    const stored = await browser.storage.local.get(OffState.STORAGE_KEY);',
    '    result = {',
    '      durable: stored[OffState.STORAGE_KEY],',
    '      live: await browser.proxy.settings.get({}),',
    '      privateAccess: await browser.extension.isAllowedIncognitoAccess(),',
    '    };',
    '  } else if (action === \'persist-v1\') {',
    '    await browser.storage.local.set({',
    '      [OffState.STORAGE_KEY]: {schemaVersion: 1, intent: \'OFF\'},',
    '    });',
    '    result = {persisted: true};',
    '  } else if (action === \'acquire\') {',
    '    result = await controller.acquirePrevalidatedFloor({',
    '      floorIdentity,',
    '      portPrevalidated: true,',
    '    });',
    '  } else if (action === \'clear-rpc\') {',
    '    result = await browser.runtime.sendMessage({',
    '      type: \'firefox.activation.clear\',',
    '    });',
    '  } else if (action === \'set-unrelated\') {',
    '    await proxySettings.set({value: {',
    '      proxyType: \'manual\',',
    '      http: `127.0.0.1:${Number(parameters.get(\'manualPort\'))}`,',
    '      httpProxyAll: true,',
    '      ssl: \'\',',
    '      socks: \'\',',
    '      socksVersion: 5,',
    '      proxyDNS: false,',
    '      passthrough: \'\',',
    '      autoConfigUrl: \'\',',
    '    }});',
    '    result = {set: true};',
    '  } else if (action === \'restore-floor\') {',
    '    await proxySettings.set({value: floorIdentity});',
    '    result = {set: true};',
    '  } else {',
    '    throw new Error(`Unknown action: ${action}`);',
    '  }',
    '  document.body.textContent = JSON.stringify({counters, result});',
    '})().catch((error) => {',
    '  document.body.textContent = JSON.stringify({error: String(error)});',
    '});',
  ].join('\n'));
  return directory;

}

async function execute(client, script, args = [], context = 'content') {

  await client.command('Marionette:SetContext', {value: context});
  return Smoke.webdriverValue(await client.command('WebDriver:ExecuteScript', {
    args,
    filename: 'firefox-proxy-control-smoke.js',
    line: 1,
    newSandbox: false,
    script,
  }));

}

async function executeAsync(client, script, args = [], context = 'content') {

  await client.command('Marionette:SetContext', {value: context});
  return Smoke.webdriverValue(
      await client.command('WebDriver:ExecuteAsyncScript', {
        args,
        filename: 'firefox-proxy-control-smoke.js',
        line: 1,
        newSandbox: false,
        script,
      }),
  );

}

function allInPageScript() {

  return [
    'const all = selector => {',
    '  const matches = [];',
    '  const visit = root => {',
    '    matches.push(...root.querySelectorAll(selector));',
    '    for (const element of root.querySelectorAll(\'*\')) {',
    '      if (element.shadowRoot) visit(element.shadowRoot);',
    '    }',
    '  };',
    '  visit(document);',
    '  return matches;',
    '};',
  ].join('\n');

}

async function openAddonDetails(client, handle) {

  await client.command('WebDriver:SwitchToWindow', {handle});
  await client.command('Marionette:SetContext', {value: 'content'});
  try {
    await client.command('WebDriver:Navigate', {url: 'about:addons'});
  } catch (error) {
    if (!/navigation timed out/i.test(error.message)) {
      throw error;
    }
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await execute(client, [
      allInPageScript(),
      'const card = all(\'addon-card\').find(item =>',
      '  item.getAttribute(\'addon-id\') === arguments[0]);',
      'if (!card) {',
      '  const category = all(\'button\').find(item =>',
      '    /extensions|расширения/i.test(',
      '      (item.getAttribute(\'title\') || \'\') + \' \' +',
      '      (item.textContent || \'\')',
      '    )',
      '  );',
      '  if (category) category.click();',
      '  return false;',
      '}',
      'const queue = [card];',
      'let link = null;',
      'while (queue.length && !link) {',
      '  const root = queue.shift();',
      '  link = root.querySelector?.(\'.addon-name-link\') ||',
      '    root.querySelector?.(\'[action="expand"]\');',
      '  for (const element of root.querySelectorAll?.(\'*\') || []) {',
      '    if (element.shadowRoot) queue.push(element.shadowRoot);',
      '  }',
      '}',
      '(link || card).click();',
      'return true;',
    ].join('\n'), [EXTENSION_ID]);
    if (result) {
      await Smoke.delay(300);
      return;
    }
    await Smoke.delay(100);
  }
  throw new Error('Add-on details were not available.');

}

async function setPrivateAccess(client, handle, granted) {

  await openAddonDetails(client, handle);
  const result = await execute(client, [
    allInPageScript(),
    'const target = all(\'input[name="private-browsing"]\').find(input =>',
    '  input.value === (arguments[0] ? \'1\' : \'0\'));',
    'if (!target) return false;',
    'target.click();',
    'return true;',
  ].join('\n'), [granted]);
  Assert.strictEqual(result, true, 'Private-access control unavailable.');
  await Smoke.delay(800);

}

async function addonState(client) {

  const state = await executeAsync(client, [
    'const done = arguments[arguments.length - 1];',
    'const {AddonManager} = ChromeUtils.importESModule(',
    '  \'resource://gre/modules/AddonManager.sys.mjs\'',
    ');',
    'AddonManager.getAddonByID(arguments[0]).then(addon => done({',
    '  exists: Boolean(addon),',
    '  isActive: addon?.isActive === true,',
    '  userDisabled: addon?.userDisabled === true,',
    '}), error => done({error: String(error)}));',
  ].join('\n'), [EXTENSION_ID], 'chrome');
  await client.command('Marionette:SetContext', {value: 'content'});
  return state;

}

async function setAddonEnabled(client, handle, enabled) {

  await openAddonDetails(client, handle);
  const before = await addonState(client);
  if (before.isActive === enabled) {
    return;
  }
  const clicked = await execute(client, [
    allInPageScript(),
    'const target = all(\'[action="toggle-disabled"]\')[0] ||',
    '  all(\'[role="switch"]\')[0] || all(\'.toggle-button\')[0];',
    'if (!target) return false;',
    'target.click();',
    'return true;',
  ].join('\n'));
  Assert.strictEqual(clicked, true, 'Add-on enable control unavailable.');
  await Smoke.delay(1000);
  Assert.strictEqual((await addonState(client)).isActive, enabled);

}

async function control(client, handle, origin, action, parameters = {}) {

  await client.command('WebDriver:SwitchToWindow', {handle});
  const query = new URLSearchParams(Object.assign({
    action,
    nonce: String(Date.now()),
  }, parameters));
  await Smoke.navigate(client, `${origin}/control.html?${query}`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const text = String(await Smoke.bodyText(client) || '').trim();
    if (text) {
      const result = JSON.parse(text);
      Assert.strictEqual('error' in result, false, result.error);
      return result;
    }
    await Smoke.delay(100);
  }
  throw new Error(`Timed out waiting for control action ${action}.`);

}

async function expectManualProxy(client, handle, targetUrl, proxyRequests,
    originRequests, phase) {

  const beforeOrigin = originRequests.length;
  await client.command('WebDriver:SwitchToWindow', {handle});
  await Smoke.navigate(client, `${targetUrl}/${phase}?nonce=${Date.now()}`);
  Assert.strictEqual(await Smoke.bodyText(client), MANUAL_PROXY_MARKER);
  Assert.ok(
      proxyRequests.some((url) => url.includes(`/${phase}?`)),
      phase,
  );
  Assert.strictEqual(originRequests.length, beforeOrigin, phase);

}

async function expectFloorBlocked(client, handle, targetUrl, proxyRequests,
    originRequests, phase) {

  const beforeOrigin = originRequests.length;
  await client.command('WebDriver:SwitchToWindow', {handle});
  try {
    await Smoke.navigate(client, `${targetUrl}/${phase}?nonce=${Date.now()}`);
  } catch (_error) {
    // A network error is expected from the closed SOCKS endpoint.
  }
  await Smoke.delay(200);
  Assert.strictEqual(
      proxyRequests.some((url) => url.includes(`/${phase}?`)),
      false,
      phase,
  );
  Assert.strictEqual(originRequests.length, beforeOrigin, phase);

}

async function main() {

  Assert.strictEqual(Fs.existsSync(packageRoot), true, 'Run build:firefox first.');
  const firefox = Smoke.resolveFirefox();
  const localAddress = localIpv4();
  const originRequests = [];
  const proxyRequests = [];
  const origin = Http.createServer((request, response) => {
    originRequests.push(request.url);
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end('UNEXPECTED_PROTECTED_ORIGIN');
  });
  const previousProxy = Http.createServer((request, response) => {
    proxyRequests.push(request.url);
    response.writeHead(200, {'content-type': 'text/plain'});
    response.end(MANUAL_PROXY_MARKER);
  });
  await new Promise((resolve, reject) => {
    origin.once('error', reject);
    origin.listen(0, '0.0.0.0', resolve);
  });
  await Smoke.listen(previousProxy);
  const targetUrl = `http://${localAddress}:${origin.address().port}`;
  const extensionDirectory = makeInstrumentedExtension();
  const profileDirectory = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), 'rucb-firefox-control-profile-'),
  );
  const marionettePort = await Smoke.unusedPort();
  Fs.writeFileSync(
      Path.join(profileDirectory, 'user.js'),
      Smoke.profilePreferences(marionettePort, previousProxy.address().port),
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
  const checks = [];
  function checked(name) {

    checks.push(name);

  }
  try {
    client = await Smoke.connectMarionette(marionettePort);
    await client.command('WebDriver:NewSession', {
      capabilities: {
        alwaysMatch: {pageLoadStrategy: 'normal'},
        firstMatch: [{}],
      },
    });
    const handles = Smoke.webdriverValue(
        await client.command('WebDriver:GetWindowHandles'),
    );
    const handle = handles[handles.length - 1];
    await client.command('WebDriver:SwitchToWindow', {handle});
    await client.command('WebDriver:SetTimeouts', {
      implicit: 0,
      pageLoad: 15000,
      script: 15000,
    });

    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests, 'before',
    );
    await client.command('Addon:Install', {
      allowPrivateBrowsing: false,
      path: packageRoot,
      temporary: true,
    });
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'production-off',
    );
    checked('production package starts OFF without proxy acquisition');
    await client.command('Addon:Uninstall', {id: EXTENSION_ID});
    await client.command('Addon:Install', {
      allowPrivateBrowsing: false,
      path: extensionDirectory,
      temporary: true,
    });
    const extension = await Smoke.extensionOrigin(client);
    const port = await highUnusedPort();

    await control(client, handle, extension, 'persist-v1');
    await setAddonEnabled(client, handle, false);
    await setAddonEnabled(client, handle, true);
    let status = await control(client, handle, extension, 'status');
    Assert.deepStrictEqual(status.result.durable, {
      schemaVersion: 2,
      intent: 'OFF',
      floorIdentity: null,
    });
    checked('schema v1 OFF migrates to schema v2 OFF');

    const denied = await control(client, handle, extension, 'acquire', {port});
    Assert.strictEqual(denied.result.error.code, 'PRIVATE_ACCESS_REQUIRED');
    Assert.strictEqual(denied.counters.set, 0);
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'denied-acquire',
    );
    checked('private denial prevents proxy.settings.set');

    await setPrivateAccess(client, handle, true);
    const acquired = await control(client, handle, extension, 'acquire', {port});
    if (!acquired.result.ok) {
      const acquisitionStatus = await control(
          client,
          handle,
          extension,
          'status',
      );
      throw new Error(JSON.stringify({acquired, acquisitionStatus}));
    }
    Assert.strictEqual(
        acquired.result.status,
        'ACQUIRED',
        JSON.stringify(acquired),
    );
    Assert.strictEqual(acquired.counters.set, 1);
    await expectFloorBlocked(
        client, handle, targetUrl, proxyRequests, originRequests,
        'acquired-floor',
    );
    checked('test-only prevalidated acquisition owns exact floor');

    await control(client, handle, extension, 'set-unrelated', {
      manualPort: previousProxy.address().port,
      port,
    });
    const mismatch = await control(
        client, handle, extension, 'clear-rpc', {port},
    );
    Assert.strictEqual(mismatch.result.error.code, 'OWNERSHIP_MISMATCH');
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'mismatch-not-cleared',
    );
    checked('ownership mismatch does not clear unrelated manual setting');
    await control(client, handle, extension, 'restore-floor', {port});
    const restoredClear = await control(
        client, handle, extension, 'clear-rpc', {port},
    );
    Assert.strictEqual(restoredClear.result.result.status, 'CLEARED');
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'exact-clear',
    );
    checked('exact Clear restores previous manual proxy');

    const acquiredForRevoke = await control(
        client, handle, extension, 'acquire', {port},
    );
    Assert.strictEqual(acquiredForRevoke.result.status, 'ACQUIRED');
    await setPrivateAccess(client, handle, false);
    const revokedClear = await control(
        client, handle, extension, 'clear-rpc', {port},
    );
    Assert.ok(
        ['CLEARED', 'ALREADY_CLEAR'].includes(
            revokedClear.result.result.status,
        ),
        JSON.stringify(revokedClear),
    );
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'clear-after-revoke',
    );
    checked('Clear succeeds after private-access revocation');

    await setPrivateAccess(client, handle, true);
    const acquiredForRestart = await control(
        client, handle, extension, 'acquire', {port},
    );
    Assert.strictEqual(acquiredForRestart.result.status, 'ACQUIRED');
    await setAddonEnabled(client, handle, false);
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'disabled-restores-manual',
    );
    checked('disable restores previous manual proxy');
    await setPrivateAccess(client, handle, false);
    await setAddonEnabled(client, handle, true);
    status = await control(client, handle, extension, 'status');
    Assert.deepStrictEqual(status.result.durable, {
      schemaVersion: 2,
      intent: 'OFF',
      floorIdentity: null,
    });
    Assert.strictEqual(status.result.privateAccess, false);
    await expectManualProxy(
        client, handle, targetUrl, proxyRequests, originRequests,
        'reenable-reconciled-off',
    );
    checked('OFF startup clears resurrected exact floor while private denied');

    Assert.strictEqual(originRequests.length, 0);
    checked('protected origin contacts remain zero');
    Assert.strictEqual(checks.length, 10);
    console.log(JSON.stringify({
      checks,
      firefox: Smoke.firefoxVersion(firefox),
      floorIdentity: floor(port),
      install: 'temporary instrumented copy of exact tracked package sources',
      manualProxyMarkerRequests: proxyRequests.length,
      protectedOriginContacts: originRequests.length,
      privateRevocationCycles: 2,
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
      await Smoke.waitForExit(child, 10000);
    } catch (_error) {
      child.kill();
      await Smoke.waitForExit(child, 5000).catch(() => {});
    }
    await Smoke.closeServer(origin);
    await Smoke.closeServer(previousProxy);
    Smoke.safeRemoveTemporary(
        extensionDirectory,
        'rucb-firefox-control-extension-',
    );
    Smoke.safeRemoveTemporary(profileDirectory, 'rucb-firefox-control-profile-');
  }

}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
