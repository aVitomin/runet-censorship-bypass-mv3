import assert from 'node:assert/strict';
import test from 'node:test';
import {planForPaths} from './required-checks.mjs';

const project = '.\\extensions\\chromium\\runet-censorship-bypass';

test('keeps documentation-only work focused', () => {
  const plan = planForPaths([
    'docs/development/TESTING.md',
    '.agents/skills/pac-regression/SKILL.md',
  ]);
  assert.deepEqual(plan.skills, []);
  assert.deepEqual(plan.checks, [
    'node .\\scripts\\verify-docs.mjs',
    'git diff --check',
  ]);
});

test('selects Firefox security checks without Chromium checks', () => {
  const plan = planForPaths([
    'extensions/chromium/runet-censorship-bypass/' +
      'src/extension-firefox-mv3/background/event-page.js',
  ]);
  assert.deepEqual(plan.skills, ['mv3-security-review']);
  assert.ok(plan.checks.includes(`npm --prefix ${project} run verify:firefox`));
  assert.ok(!plan.checks.includes(`npm --prefix ${project} run verify:mv3`));
});

test('selects both targets for shared routing', () => {
  const plan = planForPaths([
    'extensions/chromium/runet-censorship-bypass/' +
      'src/extension-mv3-common/routing-contract.js',
  ]);
  assert.deepEqual(plan.skills, ['mv3-security-review', 'pac-regression']);
  assert.ok(plan.checks.includes(`npm --prefix ${project} run verify`));
  assert.ok(plan.checks.includes(`npm --prefix ${project} run test:firefox`));
});

test('selects supply-chain review for dependency and workflow changes', () => {
  const plan = planForPaths([
    '.github/workflows/mv3.yml',
    'extensions/chromium/runet-censorship-bypass/package-lock.json',
  ]);
  assert.deepEqual(plan.skills, ['dependency-review']);
  assert.ok(plan.checks.includes('node .\\scripts\\verify-supply-chain.mjs'));
});

test('selects dual-browser release checks', () => {
  const plan = planForPaths(['docs/development/RELEASE_PROCESS.md']);
  assert.deepEqual(plan.skills, ['release-candidate']);
  assert.ok(plan.checks.includes(`npm --prefix ${project} run release:chromium`));
  assert.ok(plan.checks.includes(`npm --prefix ${project} run release:firefox`));
});
