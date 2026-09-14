#!/usr/bin/env node

import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const PROJECT = '.\\extensions\\chromium\\runet-censorship-bypass';

function add(set, ...values) {
  for (const value of values) {
    set.add(value);
  }
}

export function planForPaths(inputPaths) {
  const paths = [...new Set(inputPaths.map((value) =>
    String(value).replaceAll('\\', '/').replace(/^\.\//u, ''),
  ).filter(Boolean))].sort();
  const skills = new Set();
  const checks = new Set(['node .\\scripts\\verify-docs.mjs', 'git diff --check']);
  const notes = new Set();

  const chromium = paths.some((path) =>
    path.startsWith('extensions/chromium/runet-censorship-bypass/' +
      'src/extension-chromium-mv3/'));
  const firefox = paths.some((path) =>
    path.startsWith('extensions/chromium/runet-censorship-bypass/' +
      'src/extension-firefox-mv3/'));
  const shared = paths.some((path) =>
    path.startsWith('extensions/chromium/runet-censorship-bypass/' +
      'src/extension-mv3-common/') ||
    path.startsWith('extensions/chromium/runet-censorship-bypass/' +
      'src/extension-common/') ||
    /\/(?:gulpfile\.js|build-cleanup\.js|src\/templates-data\.js)$/u.test(path));
  const security = paths.some((path) =>
    /\/(?:background|provider)\//u.test(path) ||
    path.includes('/src/extension-mv3-common/') ||
    /manifest(?:\.tmpl)?\.json$/u.test(path));
  const pac = paths.some((path) =>
    path.startsWith('extensions/chromium/runet-censorship-bypass/src/') &&
    /(?:pac-|pac\.|routing-contract|site-scope)/u.test(path));
  const dependencies = paths.some((path) =>
    /(?:^|\/)(?:package(?:-lock)?\.json)$/u.test(path) ||
    path.startsWith('.github/workflows/') ||
    /\/vendor\//u.test(path));
  const release = paths.some((path) =>
    /(?:^|\/)(?:RELEASE_PROCESS|FIREFOX_RELEASE_BUILD)\.md$/u.test(path) ||
    /\/scripts\/package-(?:chromium|firefox)-release\.js$/u.test(path));

  if (chromium) {
    add(checks, `npm --prefix ${PROJECT} run verify:mv3`);
  }
  if (firefox) {
    add(checks, `npm --prefix ${PROJECT} run verify:firefox`);
  }
  if (shared) {
    add(checks, `npm --prefix ${PROJECT} run verify`);
    notes.add('Compare both built package trees with their baselines.');
  }
  if (security) {
    skills.add('mv3-security-review');
  }
  if (pac) {
    skills.add('pac-regression');
    add(checks,
        `npm --prefix ${PROJECT} run test:pac`,
        `npm --prefix ${PROJECT} run test:mv3`);
    if (paths.some((path) => path.includes('extension-mv3-common/'))) {
      add(checks, `npm --prefix ${PROJECT} run test:firefox`);
    }
  }
  if (dependencies) {
    skills.add('dependency-review');
    add(checks,
        'node .\\scripts\\verify-supply-chain.mjs',
        'node --test .\\scripts\\verify-supply-chain.test.mjs');
  }
  if (release) {
    skills.add('release-candidate');
    add(checks,
        `npm --prefix ${PROJECT} run verify`,
        `npm --prefix ${PROJECT} run release:chromium`,
        `npm --prefix ${PROJECT} run release:firefox`);
  }

  return Object.freeze({
    advisory: true,
    paths: Object.freeze(paths),
    skills: Object.freeze([...skills].sort()),
    checks: Object.freeze([...checks]),
    notes: Object.freeze([...notes]),
  });
}

function changedPaths() {
  const tracked = execFileSync('git', [
    'diff', '--name-only', '--diff-filter=ACMR', 'HEAD',
  ], {encoding: 'utf8'});
  const untracked = execFileSync('git', [
    'ls-files', '--others', '--exclude-standard',
  ], {encoding: 'utf8'});
  return `${tracked}\n${untracked}`.split(/\r?\n/u).filter(Boolean);
}

function main() {
  const paths = process.argv.slice(2);
  const plan = planForPaths(paths.length > 0 ? paths : changedPaths());
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
