#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseMetadataPath = 'docs/release-current.json';
const expectedCoreDocs = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'docs/user/INSTALLATION.md',
  'docs/user/USER_GUIDE.md',
  'docs/user/TROUBLESHOOTING.md',
  'docs/user/PRIVACY_AND_SECURITY.md',
  'docs/development/DEVELOPMENT.md',
  'docs/development/ARCHITECTURE.md',
  'docs/development/TESTING.md',
  'docs/development/RELEASE_PROCESS.md',
  'docs/legacy/UPSTREAM_README.md',
  'docs/maintainers/DOCUMENTATION_MAP.md',
  '.github/workflows/mv3.yml',
  releaseMetadataPath,
  'scripts/verify-docs.mjs',
];
const expectedReadmeNavigation = [
  'docs/README.md',
  'docs/user/INSTALLATION.md',
  'docs/user/USER_GUIDE.md',
  'docs/user/TROUBLESHOOTING.md',
  'docs/user/PRIVACY_AND_SECURITY.md',
  'docs/development/DEVELOPMENT.md',
  'docs/development/ARCHITECTURE.md',
  'docs/development/TESTING.md',
  'docs/development/RELEASE_PROCESS.md',
  'docs/legacy/UPSTREAM_README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
];

const errors = [];
const externalUrls = new Set();
let relativeLinksScanned = 0;
let imagesScanned = 0;
let localImagesScanned = 0;

function addError(file, line, target, reason) {
  errors.push({ file, line, target, reason });
}

function trackedMarkdownFiles() {
  return trackedFiles(['*.md']);
}

function trackedFiles(pathspecs) {
  const result = spawnSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed for ${pathspecs.join(', ')}: ${result.stderr.trim()}`);
  }
  return result.stdout.split('\0').filter(Boolean).sort();
}

function withoutCode(text) {
  let inFence = false;
  let fenceMarker = '';
  return text.split(/(?<=\n)/u).map((line) => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/u);
    if (fence) {
      const marker = fence[1][0];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      return line.replace(/[^\n]/gu, ' ');
    }
    if (inFence) {
      return line.replace(/[^\n]/gu, ' ');
    }
    return line.replace(/`[^`\n]*`/gu, (value) => ' '.repeat(value.length));
  }).join('');
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) {
      line += 1;
    }
  }
  return line;
}

function extractLinks(text) {
  const sanitized = withoutCode(text);
  const links = [];
  const occupied = [];
  const patterns = [
    {
      regex: /(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^()\s]|\([^()\n]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/gu,
      build: (match) => ({ target: match[2] ?? match[3], image: match[1] === '!' }),
    },
    {
      regex: /^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gmu,
      build: (match) => ({ target: match[1] ?? match[2], image: false }),
    },
    {
      regex: /\b(href|src)\s*=\s*(["'])(.*?)\2/giu,
      build: (match) => ({ target: match[3], image: match[1].toLowerCase() === 'src' }),
    },
    {
      regex: /<(https?:\/\/[^>\s]+)>/giu,
      build: (match) => ({ target: match[1], image: false }),
    },
    {
      regex: /https?:\/\/[^\s<>"']+/giu,
      build: (match) => ({ target: match[0].replace(/[)\],.;:]+$/gu, ''), image: false }),
    },
  ];

  for (const { regex, build } of patterns) {
    for (const match of sanitized.matchAll(regex)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some(([usedStart, usedEnd]) => start >= usedStart && start < usedEnd)) {
        continue;
      }
      const link = build(match);
      links.push({
        ...link,
        line: lineNumberAt(sanitized, start),
      });
      occupied.push([start, end]);
    }
  }
  return links;
}

function githubSlug(value) {
  return value
    .replace(/<[^>]*>/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/gu, '-');
}

const anchorCache = new Map();

function markdownAnchors(absolutePath) {
  if (anchorCache.has(absolutePath)) {
    return anchorCache.get(absolutePath);
  }
  const text = fs.readFileSync(absolutePath, 'utf8');
  const lines = withoutCode(text).split(/\r?\n/u);
  const anchors = new Set();
  const duplicateCounts = new Map();

  function addHeading(value) {
    const base = githubSlug(value);
    if (!base) {
      return;
    }
    const duplicateCount = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, duplicateCount + 1);
    anchors.add(duplicateCount === 0 ? base : `${base}-${duplicateCount}`);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const atx = lines[index].match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
    if (atx) {
      addHeading(atx[1]);
    } else if (index + 1 < lines.length && /^\s{0,3}(?:=+|-+)\s*$/u.test(lines[index + 1]) && lines[index].trim()) {
      addHeading(lines[index].trim());
    }
    for (const explicit of lines[index].matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/giu)) {
      anchors.add(explicit[1]);
    }
  }
  anchorCache.set(absolutePath, anchors);
  return anchors;
}

function exactCaseExists(absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (!relative || relative === '.') {
    return { exists: true, exactCase: true };
  }
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { exists: false, exactCase: false };
  }
  let cursor = repoRoot;
  for (const segment of relative.split(path.sep)) {
    if (!fs.existsSync(cursor) || !fs.statSync(cursor).isDirectory()) {
      return { exists: false, exactCase: false };
    }
    const entries = fs.readdirSync(cursor);
    if (!entries.includes(segment)) {
      const caseInsensitiveMatch = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());
      return { exists: Boolean(caseInsensitiveMatch), exactCase: false };
    }
    cursor = path.join(cursor, segment);
  }
  return { exists: fs.existsSync(cursor), exactCase: true };
}

function decodeTarget(target) {
  const unescaped = target.replace(/\\([() ])/gu, '$1');
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

function checkLocalTarget(file, line, rawTarget, image) {
  const decoded = decodeTarget(rawTarget.trim());
  const hashIndex = decoded.indexOf('#');
  const queryIndex = decoded.indexOf('?');
  const splitCandidates = [hashIndex, queryIndex].filter((index) => index >= 0);
  const splitAt = splitCandidates.length ? Math.min(...splitCandidates) : decoded.length;
  const pathname = decoded.slice(0, splitAt);
  const fragment = hashIndex >= 0 ? decoded.slice(hashIndex + 1).split('?')[0] : '';

  if (/^[a-z][a-z0-9+.-]*:/iu.test(pathname) || pathname.startsWith('//')) {
    return;
  }
  relativeLinksScanned += 1;
  if (image) {
    localImagesScanned += 1;
  }
  if (path.isAbsolute(pathname)) {
    addError(file, line, rawTarget, 'repository links must be relative, not filesystem-absolute');
    return;
  }

  const sourceAbsolutePath = path.join(repoRoot, file);
  const targetAbsolutePath = pathname
    ? path.resolve(path.dirname(sourceAbsolutePath), pathname)
    : sourceAbsolutePath;
  const targetRelativePath = path.relative(repoRoot, targetAbsolutePath);
  if (targetRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelativePath)) {
    addError(file, line, rawTarget, 'relative link escapes the repository');
    return;
  }

  const caseResult = exactCaseExists(targetAbsolutePath);
  if (!caseResult.exists) {
    addError(file, line, rawTarget, 'relative target does not exist');
    return;
  }
  if (!caseResult.exactCase) {
    addError(file, line, rawTarget, 'relative target uses incorrect filename case');
    return;
  }
  if (fragment && fs.statSync(targetAbsolutePath).isFile() && path.extname(targetAbsolutePath).toLowerCase() === '.md') {
    const normalizedFragment = decodeTarget(fragment).toLowerCase();
    if (!markdownAnchors(targetAbsolutePath).has(normalizedFragment)) {
      addError(file, line, rawTarget, 'Markdown heading anchor does not exist');
    }
  }
}

function checkCurrentDocPolicies(file, text) {
  if (file.startsWith('docs/legacy/')) {
    return;
  }
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const policyWindow = `${line} ${lines[index + 1] ?? ''}`;
    const machinePath = line.match(/(?:[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|\/mnt\/|\/(?:Users|home)\/[^\s`"'<>]+)/u);
    if (machinePath) {
      addError(file, index + 1, machinePath[0], 'absolute developer-machine path is not allowed');
    }

    const mentionsRootNpmPackage = /(?:\b(?:repository-root|root)\s+npm\s+package\b|корнев\p{L}*\s+npm-пакет)/iu.test(policyWindow);
    const mentionsRootPackageJson = /(?:(?:root|корнев\p{L}*)[^\n]*package\.json|package\.json[^\n]*(?:root|корнев\p{L}*))/iu.test(line);
    const npmPackageClearlyAbsent = /(?:\bno\s+root\s+npm\s+package\b|\bthere\s+is\s+no\b|\bdoes\s+not\s+exist\b|\bremoved\b|\bdeleted\b|\bunsupported\b|\bremove\s*\(completed\)|нет|не\s+существует|удал\p{L}*)/iu.test(policyWindow);
    const packageJsonClearlyAbsent = /(?:\bremoved\b|\bdeleted\b|\bremove\s*\(completed\)|нет|не\s+существует|удал\p{L}*)/iu.test(line);
    if ((mentionsRootNpmPackage && !npmPackageClearlyAbsent) || (mentionsRootPackageJson && !packageJsonClearlyAbsent)) {
      addError(file, index + 1, 'root package.json', 'current docs imply that the removed root npm package exists');
    }

    const upstreamRelease = line.match(/https:\/\/github\.com\/anticensority\/runet-censorship-bypass\/releases\S*/iu);
    if (upstreamRelease) {
      addError(file, index + 1, upstreamRelease[0], 'current installation/release links must not point to upstream MV2 releases');
    }

    const developmentDefault = line.match(/(?:github\.com\/aVitomin\/runet-censorship-bypass-mv3\/(?:blob|tree)\/development|default\s+branch[^\n]*development|ветк\p{L}*\s+по\s+умолчанию[^\n]*development)/iu);
    if (developmentDefault) {
      addError(file, index + 1, developmentDefault[0], 'the current default branch is main, not development');
    }
  });
}

async function auditExternalLinks(urls) {
  const queue = [...urls].sort();
  const results = [];
  const workerCount = Math.min(6, queue.length);

  async function check(url) {
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        let response = await fetch(url, {
          method: 'HEAD',
          redirect: 'follow',
          signal: AbortSignal.timeout(10_000),
          headers: { 'User-Agent': 'runet-censorship-bypass-doc-audit' },
        });
        if ([400, 404, 405, 410, 501].includes(response.status)) {
          response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(10_000),
            headers: {
              'User-Agent': 'runet-censorship-bypass-doc-audit',
              Range: 'bytes=0-0',
            },
          });
        }
        const status = response.status;
        if (status >= 200 && status < 400) {
          return { url, classification: 'ok', status, finalUrl: response.url };
        }
        if (status === 401 || status === 403) {
          return { url, classification: 'bot-blocked-or-auth', status, finalUrl: response.url };
        }
        if (status === 429) {
          return { url, classification: 'rate-limited', status, finalUrl: response.url };
        }
        if (status === 404 || status === 410) {
          return { url, classification: 'confirmed-dead', status, finalUrl: response.url };
        }
        if (status === 408 || status === 425 || status >= 500) {
          lastError = `HTTP ${status}`;
          continue;
        }
        return { url, classification: 'other-client-error', status, finalUrl: response.url };
      } catch (error) {
        lastError = error.name === 'TimeoutError' ? 'timeout' : error.message;
      }
    }
    return { url, classification: 'transient-or-network-error', status: null, detail: lastError };
  }

  async function worker() {
    while (queue.length > 0) {
      const url = queue.shift();
      results.push(await check(url));
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  results.sort((left, right) => left.url.localeCompare(right.url));
  const counts = new Map();
  for (const result of results) {
    counts.set(result.classification, (counts.get(result.classification) ?? 0) + 1);
    if (result.classification !== 'ok') {
      const status = result.status === null ? result.detail : `HTTP ${result.status}`;
      console.log(`[external:${result.classification}] ${status} ${result.url}`);
    }
  }
  console.log(`External-link audit: ${results.length} unique URLs; ${[...counts.entries()].map(([key, value]) => `${key}=${value}`).join(', ')}.`);
}

for (const requiredPath of expectedCoreDocs) {
  const absolutePath = path.join(repoRoot, requiredPath);
  if (!fs.existsSync(absolutePath)) {
    addError(requiredPath, 1, requiredPath, 'expected core documentation file is missing');
  }
}

const markdownFiles = trackedMarkdownFiles();
for (const file of markdownFiles) {
  const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  checkCurrentDocPolicies(file, text);
  for (const link of extractLinks(text)) {
    if (link.image) {
      imagesScanned += 1;
    }
    if (/^https?:\/\//iu.test(link.target)) {
      externalUrls.add(link.target);
      continue;
    }
    checkLocalTarget(file, link.line, link.target, link.image);
  }
}

const additionalPolicyFiles = trackedFiles(['.github', releaseMetadataPath])
  .filter((file) => !markdownFiles.includes(file));
for (const file of additionalPolicyFiles) {
  checkCurrentDocPolicies(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'));
}

const readmePath = path.join(repoRoot, 'README.md');
if (fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, 'utf8');
  for (const target of expectedReadmeNavigation) {
    if (!readme.includes(`](${target})`)) {
      addError('README.md', 1, target, 'README documentation navigation link is missing');
    }
  }

  const metadataAbsolutePath = path.join(repoRoot, releaseMetadataPath);
  if (fs.existsSync(metadataAbsolutePath)) {
    let release;
    try {
      release = JSON.parse(fs.readFileSync(metadataAbsolutePath, 'utf8'));
    } catch (error) {
      addError(releaseMetadataPath, 1, releaseMetadataPath, `invalid JSON: ${error.message}`);
    }
    if (release) {
      const requiredFields = [
        'versionName',
        'tag',
        'releaseUrl',
        'targetCommit',
        'prerelease',
        'publishedAt',
        'zipFilename',
        'zipSize',
        'zipSha256',
        'checksumFilename',
      ];
      for (const field of requiredFields) {
        if (release[field] === undefined || release[field] === '') {
          addError(releaseMetadataPath, 1, field, 'current-release metadata field is missing');
        }
      }
      if (release.tag !== `v${release.versionName}`) {
        addError(releaseMetadataPath, 1, release.tag, 'release tag must equal v + versionName');
      }
      if (!/^[0-9a-f]{40}$/u.test(release.targetCommit ?? '')) {
        addError(releaseMetadataPath, 1, release.targetCommit, 'targetCommit must be a lowercase 40-character Git SHA');
      }
      if (!/^[0-9a-f]{64}$/u.test(release.zipSha256 ?? '')) {
        addError(releaseMetadataPath, 1, release.zipSha256, 'zipSha256 must be a lowercase SHA-256');
      }
      if (typeof release.prerelease !== 'boolean') {
        addError(releaseMetadataPath, 1, release.prerelease, 'prerelease must be a boolean');
      }
      if (!Number.isInteger(release.zipSize) || release.zipSize <= 0) {
        addError(releaseMetadataPath, 1, release.zipSize, 'zipSize must be a positive integer byte count');
      }
      if (Number.isNaN(Date.parse(release.publishedAt ?? ''))) {
        addError(releaseMetadataPath, 1, release.publishedAt, 'publishedAt must be a valid timestamp');
      }
      const expectedReleaseUrl = `https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/tag/${release.tag}`;
      if (release.releaseUrl !== expectedReleaseUrl) {
        addError(releaseMetadataPath, 1, release.releaseUrl, `releaseUrl must be ${expectedReleaseUrl}`);
      }
      const expectedAssetBase = `https://github.com/aVitomin/runet-censorship-bypass-mv3/releases/download/${release.tag}`;
      for (const assetUrl of [
        `${expectedAssetBase}/${release.zipFilename}`,
        `${expectedAssetBase}/${release.checksumFilename}`,
      ]) {
        if (!readme.includes(`](${assetUrl})`)) {
          addError('README.md', 1, assetUrl, 'README current-release asset link is missing or inconsistent');
        }
      }
      for (const [field, value] of [
        ['tag', release.tag],
        ['releaseUrl', release.releaseUrl],
        ['zipFilename', release.zipFilename],
        ['zipSha256', release.zipSha256],
        ['checksumFilename', release.checksumFilename],
      ]) {
        if (value && !readme.toLowerCase().includes(String(value).toLowerCase())) {
          addError('README.md', 1, value, `README current-release block does not match ${field} in ${releaseMetadataPath}`);
        }
      }
    }
  }
}

if (process.argv.includes('--audit-external')) {
  await auditExternalLinks(externalUrls);
}

if (errors.length > 0) {
  console.error(`Documentation integrity failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error.file}:${error.line}: ${error.target} — ${error.reason}`);
  }
  console.error(`Scanned ${markdownFiles.length} Markdown files, ${relativeLinksScanned} relative links, ${imagesScanned} images (${localImagesScanned} local), and ${externalUrls.size} unique external URLs.`);
  process.exit(1);
}

console.log(`Documentation integrity passed: ${markdownFiles.length} Markdown files, ${relativeLinksScanned} relative links, ${imagesScanned} images (${localImagesScanned} local), and ${externalUrls.size} unique external URLs.`);
