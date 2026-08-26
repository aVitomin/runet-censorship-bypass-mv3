#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MIN_VERSION_AGE_MS = 168 * 60 * 60 * 1000;
export const AUTHORITATIVE_PACKAGE = 'extensions/chromium/runet-censorship-bypass';
export const QUARANTINED_PACKAGE = 'extensions/chromium/runet-censorship-bypass/src/extension-common/pages/options';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedPackageRoots = new Map([
  [AUTHORITATIVE_PACKAGE, { quarantined: false }],
  [QUARANTINED_PACKAGE, { quarantined: true }],
]);
const ignoredDirectories = new Set([
  '.git',
  '.local',
  '.tmp',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const directSections = ['dependencies', 'devDependencies', 'optionalDependencies'];
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const integrityPattern = /^(?:sha512|sha384|sha256|sha1)-[A-Za-z0-9+/]+={0,2}$/u;
const acceptedLifecyclePackages = new Map([
  ['node_modules/fsevents', { name: 'fsevents', version: '2.3.3', optional: true }],
]);

export class SupplyChainVerificationError extends Error {
  constructor(errors) {
    super(errors.join(os.EOL));
    this.name = 'SupplyChainVerificationError';
    this.errors = errors;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function readJson(absolutePath, relativePath, errors) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    errors.push(`${relativePath}: invalid JSON (${error.message})`);
    return null;
  }
}

function inventoryPackageRoots(rootDirectory) {
  const inventory = new Map();

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          walk(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || (entry.name !== 'package.json' && entry.name !== 'package-lock.json')) {
        continue;
      }
      const relativeDirectory = toPosix(path.relative(rootDirectory, directory)) || '.';
      const record = inventory.get(relativeDirectory) ?? { manifest: false, lockfile: false };
      record[entry.name === 'package.json' ? 'manifest' : 'lockfile'] = true;
      inventory.set(relativeDirectory, record);
    }
  }

  walk(rootDirectory);
  return inventory;
}

function packageNameFromLockPath(lockPath) {
  const segments = lockPath.split('/');
  const marker = segments.lastIndexOf('node_modules');
  if (marker < 0 || marker + 1 >= segments.length) {
    return null;
  }
  const first = segments[marker + 1];
  if (!first.startsWith('@')) {
    return first;
  }
  const second = segments[marker + 2];
  return second ? `${first}/${second}` : null;
}

function validRegistryTarballPath(pathname, version) {
  const segments = decodeURIComponent(pathname).split('/').filter(Boolean);
  let packageName;
  let separator;
  let filename;
  if (segments.length === 3) {
    [packageName, separator, filename] = segments;
  } else if (segments.length === 4 && segments[0].startsWith('@')) {
    packageName = `${segments[0]}/${segments[1]}`;
    [, , separator, filename] = segments;
  } else {
    return false;
  }
  const basename = packageName.split('/').at(-1);
  return packageNamePattern.test(packageName)
    && separator === '-'
    && filename === `${basename}-${version}.tgz`;
}

function validIntegrity(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && value.trim().split(/\s+/u).every((token) => integrityPattern.test(token));
}

function sectionObject(document, section) {
  const value = document?.[section];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sortedKeys(value) {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function sameKeys(left, right) {
  const leftKeys = sortedKeys(left);
  const rightKeys = sortedKeys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((value, index) => value === rightKeys[index]);
}

export function directSelectionsFromDocuments(manifest, lockfile, { requireExactPins = true } = {}) {
  const errors = [];
  const selections = new Map();
  const lockPackages = lockfile?.packages;
  const lockRoot = lockPackages?.[''];
  if (!lockRoot || typeof lockRoot !== 'object') {
    throw new SupplyChainVerificationError(['package-lock.json: packages[""] is required']);
  }

  for (const section of directSections) {
    const manifestDependencies = sectionObject(manifest, section);
    const lockDependencies = sectionObject(lockRoot, section);
    if (!sameKeys(manifestDependencies, lockDependencies)) {
      errors.push(`package-lock.json: root ${section} package set does not match package.json`);
    }
    for (const [name, specifier] of Object.entries(manifestDependencies)) {
      if (!packageNamePattern.test(name)) {
        errors.push(`package.json: unsupported package identity in ${section}`);
        continue;
      }
      if (requireExactPins && !exactVersionPattern.test(specifier)) {
        errors.push(`package.json: ${name} in ${section} must use an exact version pin`);
        continue;
      }
      if (selections.has(name)) {
        errors.push(`package.json: ${name} appears in more than one direct dependency section`);
        continue;
      }
      const selected = lockPackages[`node_modules/${name}`];
      if (!selected || typeof selected.version !== 'string') {
        errors.push(`package-lock.json: selected version for ${name} is required`);
        continue;
      }
      if (requireExactPins && selected.version !== specifier) {
        errors.push(`package-lock.json: selected version for ${name} must equal package.json ${specifier}`);
        continue;
      }
      selections.set(name, { name, version: selected.version, section });
    }
  }

  if (errors.length > 0) {
    throw new SupplyChainVerificationError(errors);
  }
  return selections;
}

function validateAuthoritativeDocuments(manifest, lockfile, errors) {
  if (!Number.isInteger(lockfile?.lockfileVersion) || lockfile.lockfileVersion < 2) {
    errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: lockfileVersion 2 or newer is required`);
    return { selections: new Map(), packageCount: 0, lifecyclePackages: [] };
  }
  if (!lockfile.packages || typeof lockfile.packages !== 'object') {
    errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: packages map is required`);
    return { selections: new Map(), packageCount: 0, lifecyclePackages: [] };
  }

  let selections = new Map();
  try {
    selections = directSelectionsFromDocuments(manifest, lockfile);
  } catch (error) {
    if (error instanceof SupplyChainVerificationError) {
      errors.push(...error.errors.map((message) => `${AUTHORITATIVE_PACKAGE}/${message}`));
    } else {
      throw error;
    }
  }

  const lifecyclePackages = [];
  for (const [lockPath, entry] of Object.entries(lockfile.packages)) {
    if (lockPath === '') {
      continue;
    }
    const name = packageNameFromLockPath(lockPath);
    const identity = name && entry?.version ? `${name}@${entry.version}` : lockPath;
    if (!name || !packageNamePattern.test(name) || typeof entry?.version !== 'string') {
      errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: invalid package entry ${lockPath}`);
      continue;
    }
    if (entry.link === true) {
      errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: link source is not allowed for ${identity}`);
    }
    if (typeof entry.resolved !== 'string' || entry.resolved === '') {
      errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: resolved registry source is required for ${identity}`);
    } else {
      try {
        const resolved = new URL(entry.resolved);
        if (resolved.protocol !== 'https:'
          || resolved.origin !== 'https://registry.npmjs.org'
          || resolved.username
          || resolved.password
          || resolved.search
          || resolved.hash
          || !validRegistryTarballPath(resolved.pathname, entry.version)) {
          errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: unexpected registry source for ${identity}`);
        }
      } catch {
        errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: malformed registry source for ${identity}`);
      }
    }
    if (!validIntegrity(entry.integrity)) {
      errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: valid integrity is required for ${identity}`);
    }
    if (entry.hasInstallScript !== undefined && typeof entry.hasInstallScript !== 'boolean') {
      errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: malformed lifecycle metadata for ${identity}`);
    }
    if (entry.hasInstallScript === true) {
      const accepted = acceptedLifecyclePackages.get(lockPath);
      if (!accepted
        || accepted.name !== name
        || accepted.version !== entry.version
        || entry.optional !== accepted.optional) {
        errors.push(`${AUTHORITATIVE_PACKAGE}/package-lock.json: unexpected lifecycle-install metadata for ${identity}`);
      } else {
        lifecyclePackages.push(identity);
      }
    }
  }

  return {
    selections,
    packageCount: Math.max(0, Object.keys(lockfile.packages).length - 1),
    lifecyclePackages: lifecyclePackages.sort(),
  };
}

export function inspectRepository(rootDirectory = repoRoot) {
  const errors = [];
  const inventory = inventoryPackageRoots(rootDirectory);

  for (const [directory, record] of inventory) {
    if (!expectedPackageRoots.has(directory)) {
      errors.push(`${directory}: unexpected package manifest or lockfile; dependency review is required`);
    }
    if (record.manifest !== record.lockfile) {
      errors.push(`${directory}: package.json and package-lock.json must both be present`);
    }
  }
  for (const directory of expectedPackageRoots.keys()) {
    const record = inventory.get(directory);
    if (!record?.manifest || !record?.lockfile) {
      errors.push(`${directory}: expected package.json and package-lock.json are missing`);
    }
  }

  const documents = new Map();
  for (const [directory, policy] of expectedPackageRoots) {
    const manifestPath = path.join(rootDirectory, directory, 'package.json');
    const lockfilePath = path.join(rootDirectory, directory, 'package-lock.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(lockfilePath)) {
      continue;
    }
    const manifest = readJson(manifestPath, `${directory}/package.json`, errors);
    const lockfile = readJson(lockfilePath, `${directory}/package-lock.json`, errors);
    if (manifest && lockfile) {
      documents.set(directory, { manifest, lockfile, ...policy });
    }
  }

  const authoritative = documents.get(AUTHORITATIVE_PACKAGE);
  let authoritativeSummary = { selections: new Map(), packageCount: 0, lifecyclePackages: [] };
  if (authoritative) {
    authoritativeSummary = validateAuthoritativeDocuments(
      authoritative.manifest,
      authoritative.lockfile,
      errors,
    );
  }

  if (errors.length > 0) {
    throw new SupplyChainVerificationError(errors);
  }
  return {
    inventory: [...inventory.keys()].sort(),
    documents,
    directSelections: authoritativeSummary.selections,
    packageCount: authoritativeSummary.packageCount,
    lifecyclePackages: authoritativeSummary.lifecyclePackages,
    quarantinedPackages: [QUARANTINED_PACKAGE],
  };
}

export function changedDirectSelections(currentManifest, currentLockfile, baseManifest, baseLockfile) {
  const current = directSelectionsFromDocuments(currentManifest, currentLockfile);
  const base = directSelectionsFromDocuments(baseManifest, baseLockfile, { requireExactPins: false });
  return [...current.values()]
    .filter((selection) => base.get(selection.name)?.version !== selection.version)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function registryPublicationTime(name, version) {
  const endpoint = `https://registry.npmjs.org/${encodeURIComponent(name)}`;
  let response;
  try {
    response = await fetch(endpoint, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'runet-censorship-bypass-supply-chain-verifier',
      },
    });
  } catch (error) {
    throw new Error(`registry request failed (${error.name})`);
  }
  if (!response.ok) {
    throw new Error(`registry request failed (HTTP ${response.status})`);
  }
  let packument;
  try {
    packument = await response.json();
  } catch {
    throw new Error('registry returned malformed JSON');
  }
  return packument?.time?.[version];
}

export async function verifyPublicationAges(selections, {
  reviewTime = new Date(),
  getPublicationTime = registryPublicationTime,
} = {}) {
  const reviewTimestamp = reviewTime instanceof Date
    ? reviewTime.getTime()
    : Date.parse(reviewTime);
  if (!Number.isFinite(reviewTimestamp)) {
    throw new SupplyChainVerificationError(['review time is invalid']);
  }

  const errors = [];
  const results = [];
  for (const selection of [...selections].sort((left, right) => left.name.localeCompare(right.name))) {
    let publicationValue;
    try {
      publicationValue = await getPublicationTime(selection.name, selection.version);
    } catch (error) {
      errors.push(`${selection.name}@${selection.version}: publication metadata unavailable (${error.message})`);
      continue;
    }
    if (typeof publicationValue !== 'string' || !Number.isFinite(Date.parse(publicationValue))) {
      errors.push(`${selection.name}@${selection.version}: publication timestamp is missing or malformed`);
      continue;
    }
    const publicationTimestamp = Date.parse(publicationValue);
    const ageMilliseconds = reviewTimestamp - publicationTimestamp;
    if (ageMilliseconds < MIN_VERSION_AGE_MS) {
      const ageHours = Math.floor(ageMilliseconds / (60 * 60 * 1000));
      errors.push(`${selection.name}@${selection.version}: selected version is ${ageHours} hours old; 168 full hours are required`);
      continue;
    }
    results.push({
      ...selection,
      publicationTime: publicationValue,
      ageHours: Math.floor(ageMilliseconds / (60 * 60 * 1000)),
    });
  }

  if (errors.length > 0) {
    throw new SupplyChainVerificationError(errors);
  }
  return results;
}

function gitJson(baseSha, relativePath) {
  try {
    const content = execFileSync('git', ['show', `${baseSha}:${relativePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(content);
  } catch {
    throw new SupplyChainVerificationError([
      `${relativePath}: unable to read the PR base version; dependency age review cannot continue`,
    ]);
  }
}

async function main() {
  if (process.argv.length > 2) {
    throw new SupplyChainVerificationError(['verify-supply-chain.mjs accepts no command-line bypasses']);
  }
  const summary = inspectRepository(repoRoot);
  console.log(`Supply-chain static verification passed: ${summary.packageCount} authoritative lock packages, ${summary.directSelections.size} exact direct pins.`);
  console.log(`Accepted authoritative lifecycle baseline: ${summary.lifecyclePackages.join(', ') || 'none present'}.`);
  console.log(`Quarantined package root (not installed or trusted as baseline): ${QUARANTINED_PACKAGE}.`);

  const baseSha = (process.env.SUPPLY_CHAIN_BASE_SHA ?? '').trim();
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && !baseSha) {
    throw new SupplyChainVerificationError(['pull_request verification requires SUPPLY_CHAIN_BASE_SHA']);
  }
  if (baseSha) {
    if (!/^[0-9a-f]{40}$/u.test(baseSha)) {
      throw new SupplyChainVerificationError(['SUPPLY_CHAIN_BASE_SHA must be a lowercase 40-character Git SHA']);
    }
    const authoritative = summary.documents.get(AUTHORITATIVE_PACKAGE);
    const baseManifest = gitJson(baseSha, `${AUTHORITATIVE_PACKAGE}/package.json`);
    const baseLockfile = gitJson(baseSha, `${AUTHORITATIVE_PACKAGE}/package-lock.json`);
    const changedSelections = changedDirectSelections(
      authoritative.manifest,
      authoritative.lockfile,
      baseManifest,
      baseLockfile,
    );
    if (changedSelections.length === 0) {
      console.log('Dependency age verification passed: no newly selected direct versions; registry was not queried.');
    } else {
      const ages = await verifyPublicationAges(changedSelections);
      console.log(`Dependency age verification passed for ${ages.length} newly selected direct version(s): ${ages.map((item) => `${item.name}@${item.version} (${item.ageHours}h)`).join(', ')}.`);
    }
  } else {
    console.log('Dependency age verification not requested: no PR base SHA was supplied.');
  }
  console.log('These checks are defense-in-depth gates, not proof that a dependency is safe.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof SupplyChainVerificationError) {
      console.error(`Supply-chain verification failed with ${error.errors.length} error(s):`);
      for (const message of error.errors) {
        console.error(`- ${message}`);
      }
    } else {
      console.error(`Supply-chain verification failed: ${error.message}`);
    }
    process.exitCode = 1;
  });
}
