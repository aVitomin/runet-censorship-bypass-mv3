'use strict';

/* eslint-env node, mocha */

const Chai = require('chai');
const Mocha = require('mocha');
const {
  SHARED_SOURCE_ROOT,
  getRuntimeIconData,
  verifyRuntimeIcons,
} = require('./verify-runtime-icons');

Mocha.describe('MV3 runtime action icons', function() {

  Mocha.it('enumerates extension-relative runtime icons present in source',
      function() {

        Chai.expect(verifyRuntimeIcons(SHARED_SOURCE_ROOT)).to.deep.equal([
          'icons/default-128.png',
          'icons/default-grayscale-128.png',
        ]);

      });

  Mocha.it('selects the expected size map for applied and inactive status',
      function() {

        const iconData = getRuntimeIconData();
        Chai.expect(iconData.variants).to.deep.equal({
          applied: {
            128: 'icons/default-128.png',
          },
          inactive: {
            128: 'icons/default-grayscale-128.png',
          },
        });

      });

});
