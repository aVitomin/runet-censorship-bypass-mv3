'use strict';

const Assert = require('node:assert');
const {renderTemplate} = require('../../../gulpfile');

describe('Build template renderer', function() {

  it('replaces only named scalar placeholders', function() {

    Assert.strictEqual(
        renderTemplate('v${version}/${build}', {version: '4.00', build: 4}),
        'v4.00/4',
    );

  });

  it('normalizes tracked CRLF templates like the historical renderer', function() {

    Assert.strictEqual(renderTemplate('a\r\nb\r\n', {}), 'a\nb\n');

  });

  it('rejects unknown and expression-like placeholders', function() {

    Assert.throws(
        () => renderTemplate('${missing}', {}),
        /Unknown template value/,
    );
    Assert.throws(
        () => renderTemplate('${version.toString()}', {version: '4.00'}),
        /Malformed or unsupported template expression/,
    );

  });

  it('rejects non-scalar context values', function() {

    Assert.throws(
        () => renderTemplate('${value}', {value: {unsafe: true}}),
        /must be scalar/,
    );

  });

});
