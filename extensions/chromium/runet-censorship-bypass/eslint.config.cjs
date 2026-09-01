'use strict';

const js = require('@eslint/js');
const google = require('eslint-config-google');
const globals = require('globals');

const googleRules = {...google.rules};
delete googleRules['require-jsdoc'];
delete googleRules['valid-jsdoc'];

module.exports = [
  {
    name: 'project/ignores',
    ignores: [
      '**/build/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/vendor/**',
    ],
  },
  {
    name: 'project/mv3',
    files: [
      'src/extension-chromium-mv3/**/*.js',
      'src/extension-firefox-mv3/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2017,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.es2015,
        chrome: 'writable',
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...googleRules,

      // Preserve the ESLint 7 recommended-rule contract. Evaluate newer
      // correctness rules separately from this tooling-only migration.
      'no-loss-of-precision': 'off',
      'no-nonoctal-decimal-escape': 'off',
      'no-unsafe-optional-chaining': 'off',
      'no-useless-backreference': 'off',
      'no-constant-binary-expression': 'off',
      'no-empty-static-block': 'off',
      'no-new-native-nonconstructor': 'off',
      'no-unused-private-class-members': 'off',
      'no-unassigned-vars': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      'no-inner-declarations': 'error',

      strict: ['error', 'global'],
      'no-console': 'off',
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
      }],
      'padded-blocks': 'off',
      'max-len': ['error', 100, 2, {
        ignoreUrls: true,
        ignoreComments: false,
        ignoreRegExpLiterals: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
      }],
    },
  },
  {
    name: 'project/firefox-runtime-compatibility',
    files: ['src/extension-firefox-mv3/background/**/*.js'],
    languageOptions: {
      globals: {
        globalThis: 'readonly',
        module: 'readonly',
      },
    },
  },
  {
    name: 'project/mv3-node-tests',
    files: [
      'src/extension-chromium-mv3/test/**/*.js',
      'src/extension-firefox-mv3/test/**/*.js',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        Crypto: 'off',
      },
    },
  },
  {
    name: 'project/mv3-mocha-tests',
    files: [
      'src/extension-chromium-mv3/test/**/*.js',
      'src/extension-firefox-mv3/test/**/*.test.js',
    ],
    ignores: [
      'src/extension-chromium-mv3/test/background-modules.js',
      'src/extension-chromium-mv3/test/generate-action-icons.js',
      'src/extension-chromium-mv3/test/runtime-performance-harness.js',
      'src/extension-chromium-mv3/test/verify-runtime-icons.js',
    ],
    languageOptions: {
      globals: globals.mocha,
    },
  },
];
