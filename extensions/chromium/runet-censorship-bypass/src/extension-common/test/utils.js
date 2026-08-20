'use strict';

const Chai = require('chai');
const Mocha = require('mocha');
const {createChromeApiStub} = require('../../../tools/legacy-test-stubs');

const CachelessRequire = require('../../../tools/cacheless-require')(module);

Mocha.describe('window.utils', function () {

  const initApis = '../00-init-apis.js';
  let chromeStub;

  Mocha.beforeEach(function() {

    chromeStub = createChromeApiStub();
    global.chrome = chromeStub.chrome;
    global.chrome.runtime.getManifest.returns({version: '0.0.0.0'});
    global.window = {chrome: global.chrome};

  });

  Mocha.it('is exported as global', function () {

    CachelessRequire(initApis);
    Chai.expect(window.utils, 'to be exported as global').to.exist;
    Chai.expect(window.apis.version.ifMini, 'to be marked as not MINI version by default').to.be.false;

  });

  Mocha.afterEach(function() {

    chromeStub.reset();
    chromeStub = null;
    delete global.window;
    delete global.chrome;

  });

});
