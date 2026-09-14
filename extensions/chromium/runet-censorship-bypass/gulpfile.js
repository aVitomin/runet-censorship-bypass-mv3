'use strict';

const gulp = require('gulp');
const buildCleanup = require('./build-cleanup');
const {Transform} = require('node:stream');

function renderTemplate(source, context) {

  if (typeof source !== 'string' || !context || typeof context !== 'object') {
    throw new TypeError('Template source and context are required.');
  }
  const rendered = source.replace(/\r\n/gu, '\n')
      .replace(/\$\{([A-Za-z][A-Za-z0-9]*)\}/gu,
      (token, key) => {
        if (!Object.prototype.hasOwnProperty.call(context, key)) {
          throw new Error(`Unknown template value: ${key}`);
        }
        const value = context[key];
        if (typeof value !== 'string' && typeof value !== 'number') {
          throw new TypeError(`Template value must be scalar: ${key}`);
        }
        return String(value);
      });
  if (rendered.includes('${')) {
    throw new Error('Malformed or unsupported template expression.');
  }
  return rendered;

}

const templatePlugin = (context) => new Transform({
  objectMode: true,
  transform(file, encoding, cb) {

  const suffixes = ['.tmpl.json', '.tmpl.js'];
  if ( suffixes.some( (suff) => file.path.endsWith(suff) ) ) {

    const originalPath = file.path;
    file.path = file.path.replace(/\.tmpl(?=\.[^.]+$)/u, '');

    if (file.isStream()) {
      return cb(new Error('Template streams are not supported.'));
    } else if (file.isBuffer()) {
      try {
        file.contents = Buffer.from(renderTemplate(String(file.contents), context));
      } catch(e) {
        e.message += '\nIN FILE: ' + originalPath;
        return cb(e);
      }
    }

  }
  cb(null, file);

  },
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
  './src/extension-firefox-mv3/background/provider-update-control.js',
  './src/extension-firefox-mv3/background/dataset-promotion.js',
  './src/extension-firefox-mv3/background/provider-lookup.js',
  './src/extension-firefox-mv3/background/dataset-runtime.js',
  './src/extension-firefox-mv3/background/routing-adapter.js',
  './src/extension-firefox-mv3/background/proxy-auth.js',
  './src/extension-firefox-mv3/background/product-config.js',
  './src/extension-firefox-mv3/background/production-provider.js',
  './src/extension-firefox-mv3/background/settings-control.js',
  './src/extension-firefox-mv3/background/site-control.js',
  './src/extension-firefox-mv3/background/activation-controller.js',
  './src/extension-firefox-mv3/background/operational-status.js',
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
const chromiumMv3TldtsSrc = [
  './node_modules/tldts/dist/index.umd.min.js',
  './node_modules/tldts/LICENSE',
];
const firefoxMv3TldtsSrc = chromiumMv3TldtsSrc;
const firefoxMv3IconSrc = [
  'active',
  'busy',
  'external',
  'loading',
  'off',
  'warning',
].flatMap((state) => [16, 19, 20, 32, 38].map((size) =>
  `./src/extension-chromium-mv3/icons/action-${state}-${size}.png`,
)).concat([
  './src/extension-chromium-mv3/icons/action-active-48.png',
  './src/extension-chromium-mv3/icons/action-active-128.png',
]);

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

const copyFirefoxMv3Tldts = function(cb) {

  gulp.src(firefoxMv3TldtsSrc, {
    base: './node_modules/tldts',
    encoding: false,
  })
    .pipe(gulp.dest(`${firefoxMv3Dst}/background/vendor/tldts`))
    .on('end', cb);

};

const copyFirefoxMv3Icons = function(cb) {

  gulp.src(firefoxMv3IconSrc, {
    base: './src/extension-chromium-mv3',
    encoding: false,
  })
    .pipe(gulp.dest(firefoxMv3Dst))
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
    gulp.parallel(
        copyFirefoxMv3,
        copyFirefoxMv3Common,
        copyFirefoxMv3Icons,
        copyFirefoxMv3Tldts,
    ),
);

module.exports = {
  buildChromiumMv3,
  buildFirefoxMv3,
  renderTemplate,
};
