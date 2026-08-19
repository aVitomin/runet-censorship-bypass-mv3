'use strict';


const Chai = require('chai');
const Mocha = require('mocha');
const Fs = require('fs');
const Path = require('path');
const {
  getExpectedActionIcons,
  renderActionIcon,
} = require('./generate-action-icons');
const {
  MV3_SOURCE_ROOT,
  getRuntimeIconData,
  verifyRuntimeIcons,
} = require('./verify-runtime-icons');

function getPngChunkTypes(data) {

  const types = [];
  let offset = 8;
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    types.push(type);
    offset += length + 12;
  }
  Chai.expect(offset).to.equal(data.length);
  return types;

}

Mocha.describe('MV3 runtime action icons', function() {

  Mocha.it('enumerates extension-relative runtime icons present in source',
      function() {

        Chai.expect(verifyRuntimeIcons(MV3_SOURCE_ROOT)).to.deep.equal(
            getExpectedActionIcons().map(({fileName}) => `icons/${fileName}`),
        );
        Chai.expect(getExpectedActionIcons()).to.have.length(32);

      });

  Mocha.it('selects the expected size map for every icon state',
      function() {

        const iconData = getRuntimeIconData();
        Chai.expect(Object.keys(iconData.variants)).to.deep.equal([
          'active',
          'off',
          'external',
          'busy',
          'warning',
          'loading',
        ]);
        Chai.expect(iconData.variants.active).to.include({
          16: 'icons/action-active-16.png',
          128: 'icons/action-active-128.png',
        });
        Chai.expect(iconData.variants.off).to.include({
          16: 'icons/action-off-16.png',
          38: 'icons/action-off-38.png',
        });
        Chai.expect(Object.keys(iconData.variants.loading).map(Number))
            .to.deep.equal([16, 19, 20, 32, 38]);
        Chai.expect(Object.keys(iconData.variants.active).map(Number))
            .to.deep.equal([16, 19, 20, 32, 38, 48, 128]);

      });

  Mocha.it('keeps every checked-in PNG equal to deterministic generation',
      function() {

        for (const icon of getExpectedActionIcons()) {
          const stored = Fs.readFileSync(
              Path.join(MV3_SOURCE_ROOT, 'icons', icon.fileName),
          );
          Chai.expect(stored.equals(renderActionIcon(
              icon.variant,
              icon.size,
          )), icon.fileName).to.equal(true);
        }

      });

  Mocha.it('uses metadata-free RGBA PNGs with only required chunks',
      function() {

        for (const icon of getExpectedActionIcons()) {
          const stored = Fs.readFileSync(
              Path.join(MV3_SOURCE_ROOT, 'icons', icon.fileName),
          );
          Chai.expect(stored[24], `${icon.fileName} bit depth`).to.equal(8);
          Chai.expect(stored[25], `${icon.fileName} color type`).to.equal(6);
          Chai.expect(
              getPngChunkTypes(stored),
              `${icon.fileName} chunks`,
          ).to.deep.equal(['IHDR', 'IDAT', 'IEND']);
        }

      });

});
