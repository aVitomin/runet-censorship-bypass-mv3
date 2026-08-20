'use strict';

const Chai = require('chai');
const Mocha = require('mocha');
const {createChromeApiStub} = require('../../../tools/legacy-test-stubs');

Mocha.describe('Legacy Chrome API test stub', function () {

  Mocha.it('resets runtime calls, errors, and replaced proxy methods', function () {

    const stub = createChromeApiStub({manifest: {version: '1.2.3.4'}});
    const originalSet = stub.chrome.proxy.settings.set;

    Chai.expect(stub.chrome.runtime.getManifest()).to.deep.equal({version: '1.2.3.4'});
    Chai.expect(stub.chrome.runtime.getManifest.callCount).to.equal(1);
    stub.chrome.runtime.lastError = {message: 'runtime failure'};
    stub.chrome.extension.lastError = {message: 'extension failure'};
    stub.chrome.proxy.settings.set = function() {};

    stub.reset();

    Chai.expect(stub.chrome.runtime.getManifest.notCalled).to.be.true;
    Chai.expect(stub.chrome.runtime.lastError).to.equal(null);
    Chai.expect(stub.chrome.extension.lastError).to.equal(null);
    Chai.expect(stub.chrome.proxy.settings.set).to.equal(originalSet);
    Chai.expect(stub.chrome.runtime.getManifest()).to.deep.equal({version: '1.2.3.4'});

  });

  Mocha.it('implements deterministic proxy settings callbacks and state', function () {

    const initial = {
      levelOfControl: 'controlled_by_this_extension',
      value: {mode: 'pac_script'},
    };
    const replacement = {value: {mode: 'direct'}};
    const stub = createChromeApiStub({proxySettings: initial});
    let current;
    let callbackArgs;

    stub.chrome.proxy.settings.get({}, (details) => {
      current = details;
    });
    Chai.expect(current).to.deep.equal(initial);

    stub.chrome.proxy.settings.set(replacement, (...args) => {
      callbackArgs = args;
    });
    Chai.expect(callbackArgs).to.deep.equal([]);
    stub.chrome.proxy.settings.get({}, (details) => {
      current = details;
    });
    Chai.expect(current).to.deep.equal(replacement);

    stub.chrome.proxy.settings.clear({}, (...args) => {
      callbackArgs = args;
    });
    Chai.expect(callbackArgs).to.deep.equal([]);
    stub.chrome.proxy.settings.get({}, (details) => {
      current = details;
    });
    Chai.expect(current).to.equal(undefined);
    Chai.expect(stub.chrome.proxy.settings.get.callCount).to.equal(3);
    Chai.expect(stub.chrome.proxy.settings.set.callCount).to.equal(1);
    Chai.expect(stub.chrome.proxy.settings.clear.callCount).to.equal(1);

  });

  Mocha.it('isolates webRequest event listeners and clears them on reset', function () {

    const stub = createChromeApiStub();
    const event = stub.chrome.webRequest.onAuthRequired;
    const details = {requestId: 'request-1'};
    const seen = [];
    const listener = (value) => {

      seen.push(value);
      return {cancel: false};

    };

    event.addListener(listener, {urls: ['<all_urls>']}, ['blocking']);
    Chai.expect(event.hasListener(listener)).to.be.true;
    Chai.expect(event.listenerCount).to.equal(1);
    Chai.expect(event.trigger(details)).to.deep.equal([{cancel: false}]);
    Chai.expect(seen).to.deep.equal([details]);

    event.removeListener(listener);
    Chai.expect(event.hasListener(listener)).to.be.false;
    Chai.expect(event.trigger(details)).to.deep.equal([]);
    event.addListener(listener);
    stub.reset();
    Chai.expect(event.listenerCount).to.equal(0);
    Chai.expect(event.addListener.notCalled).to.be.true;
    Chai.expect(event.trigger.notCalled).to.be.true;

  });

  Mocha.it('produces identical results across consecutive stub lifecycles', function () {

    const runLifecycle = () => {

      const stub = createChromeApiStub();
      let callbackCount = 0;
      stub.chrome.runtime.getManifest();
      stub.chrome.proxy.settings.set({value: {mode: 'direct'}}, () => {
        callbackCount += 1;
      });
      stub.chrome.webRequest.onCompleted.addListener(() => callbackCount);
      const snapshot = {
        callbackCount,
        manifestCalls: stub.chrome.runtime.getManifest.callCount,
        setCalls: stub.chrome.proxy.settings.set.callCount,
        listenerCount: stub.chrome.webRequest.onCompleted.listenerCount,
      };
      stub.reset();
      snapshot.reset = {
        manifestCalls: stub.chrome.runtime.getManifest.callCount,
        setCalls: stub.chrome.proxy.settings.set.callCount,
        listenerCount: stub.chrome.webRequest.onCompleted.listenerCount,
      };
      return snapshot;

    };

    Chai.expect(runLifecycle()).to.deep.equal(runLifecycle());

  });

});
