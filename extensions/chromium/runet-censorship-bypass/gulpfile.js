'use strict';

const gulp = require('gulp');
const buildCleanup = require('./build-cleanup');
const through = require('through2');
const PluginError = require('plugin-error');

const PluginName = 'Template literals';

const templatePlugin = (context) => through.obj(function(file, encoding, cb) {

  const suffixes = ['.tmpl.json', 'tmpl.js'];
  if ( suffixes.some( (suff) => file.path.endsWith(suff) ) ) {

    const originalPath = file.path;
    file.path = file.path.replace(new RegExp(`tmpl.([^.]+)$`), '$1');

    if (file.isStream()) {
      return cb(new PluginError(PluginName, 'Streams are not supported!'));
    } else if (file.isBuffer()) {

      const {keys, values} = Object.keys(context).reduce( (acc, key) => {

        const value = context[key];
        acc.keys.push(key);
        acc.values.push(value);
        return acc;

      }, { keys: [], values: [] });
      try {
        const rendered =
          (new Function(...keys, 'return `' + String(file.contents) + '`;'))(
              ...values,
          );
        file.contents = Buffer.from(rendered.replace(
            '__ANTICENSORITY_PAC_URLS__',
            JSON.stringify(context.anticensorityPacUrls, null, 2),
        ));
      } catch(e) {
        e.message += '\nIN FILE: ' + originalPath;
        return cb(new PluginError(PluginName, e));
      }
    }

  }
  cb(null, file);

});


const contexts = require('./src/templates-data').contexts;
const chromiumMv3Dst = './build/extension-chromium-mv3';
const firefoxMv3Dst = './build/extension-firefox-mv3';
const chromiumMv3RuntimeSrc = [
  './src/extension-chromium-mv3/**/*',
  '!./src/extension-chromium-mv3/test',
  '!./src/extension-chromium-mv3/test/',
  '!./src/extension-chromium-mv3/test/**/*',
  '!./src/extension-chromium-mv3/**/AGENTS.md',
];
const chromiumMv3CommonSrc = './src/extension-common/pages/lib/**/*';
const firefoxMv3RuntimeSrc = [
  './src/extension-firefox-mv3/manifest.json',
  './src/extension-firefox-mv3/background/off-state.js',
  './src/extension-firefox-mv3/background/proxy-control.js',
  './src/extension-firefox-mv3/background/dataset-store.js',
  './src/extension-firefox-mv3/background/provider-updater.js',
  './src/extension-firefox-mv3/background/dataset-promotion.js',
  './src/extension-firefox-mv3/background/provider-lookup.js',
  './src/extension-firefox-mv3/background/dataset-runtime.js',
  './src/extension-firefox-mv3/background/routing-adapter.js',
  './src/extension-firefox-mv3/background/proxy-auth.js',
  './src/extension-firefox-mv3/background/product-config.js',
  './src/extension-firefox-mv3/background/production-provider.js',
  './src/extension-firefox-mv3/background/settings-control.js',
  './src/extension-firefox-mv3/background/activation-controller.js',
  './src/extension-firefox-mv3/background/event-page.js',
  './src/extension-firefox-mv3/pages/shared/ui-runtime.js',
  './src/extension-firefox-mv3/pages/shared/ui-tokens.css',
  './src/extension-firefox-mv3/pages/popup/index.html',
  './src/extension-firefox-mv3/pages/popup/index.js',
  './src/extension-firefox-mv3/pages/popup/popup.css',
  './src/extension-firefox-mv3/pages/options/index.html',
  './src/extension-firefox-mv3/pages/options/index.js',
  './src/extension-firefox-mv3/pages/options/options.css',
  './src/extension-firefox-mv3/_locales/en/messages.json',
  './src/extension-firefox-mv3/_locales/ru/messages.json',
  './src/extension-firefox-mv3/provider/anticensority-hosts-v1.data',
  './src/extension-firefox-mv3/provider/anticensority-hosts-v1.envelope.json',
];
const firefoxMv3CommonSrc = [
  './src/extension-mv3-common/routing-contract.js',
  './src/extension-mv3-common/provider-dataset.js',
  './src/extension-mv3-common/provider-dataset-state.js',
];
const firefoxSrc = './src/extension-firefox/**/*';
const chromiumMv3TldtsSrc = [
  './node_modules/tldts/dist/index.umd.min.js',
  './node_modules/tldts/LICENSE',
];

const cleanChromiumMv3 = function(cb) {

  buildCleanup.cleanChromiumMv3();
  return cb();

};

const copyChromiumMv3 = function(cb) {

  gulp.src(
      chromiumMv3RuntimeSrc,
      {encoding: false},
  )
    .pipe(templatePlugin(contexts.chromiumMv3))
    .pipe(gulp.dest(chromiumMv3Dst))
    .on('end', cb);

};

const copyChromiumMv3Common = function(cb) {

  gulp.src(
      chromiumMv3CommonSrc,
      {base: './src/extension-common', encoding: false},
  )
    .pipe(gulp.dest(chromiumMv3Dst))
    .on('end', cb);

};

const copyChromiumMv3Tldts = function(cb) {

  gulp.src(chromiumMv3TldtsSrc, {
    base: './node_modules/tldts',
    encoding: false,
  })
    .pipe(gulp.dest(`${chromiumMv3Dst}/background/vendor/tldts`))
    .on('end', cb);

};

const cleanFirefoxMv3 = function(cb) {

  buildCleanup.cleanFirefoxMv3();
  return cb();

};

const copyFirefoxMv3 = function(cb) {

  gulp.src(firefoxMv3RuntimeSrc, {
    base: './src/extension-firefox-mv3',
    encoding: false,
  })
    .pipe(gulp.dest(firefoxMv3Dst))
    .on('end', cb);

};

const copyFirefoxMv3Common = function(cb) {

  gulp.src(firefoxMv3CommonSrc, {
    base: './src/extension-mv3-common',
    encoding: false,
  })
    .pipe(gulp.dest(`${firefoxMv3Dst}/background/common`))
    .on('end', cb);

};

const buildChromiumMv3 = gulp.series(
    cleanChromiumMv3,
    gulp.parallel(
        copyChromiumMv3,
        copyChromiumMv3Common,
        copyChromiumMv3Tldts,
    ),
);
const buildFirefoxMv3 = gulp.series(
    cleanFirefoxMv3,
    gulp.parallel(copyFirefoxMv3, copyFirefoxMv3Common),
);

module.exports = {
  buildChromiumMv3,
  buildFirefoxMv3,
  buildMv3: buildChromiumMv3,
};
