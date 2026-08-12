'use strict';

/* eslint-env node */

const Fs = require('node:fs');
const Path = require('node:path');

function resolveRequiredPath(value, label) {

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty path.`);
  }
  return Path.resolve(value);

}

function pathsEqual(left, right) {

  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;

}

function isWithin(parent, target) {

  const relative = Path.relative(parent, target);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${Path.sep}`) &&
    !Path.isAbsolute(relative)
  );

}

function rejectSymlinkedParents(projectRoot, target) {

  const relativeParent = Path.relative(projectRoot, Path.dirname(target));
  if (!relativeParent) {
    return;
  }

  let current = projectRoot;
  for (const part of relativeParent.split(Path.sep)) {
    current = Path.join(current, part);
    try {
      if (Fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Cleanup target has a symlinked parent: ${current}`);
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

}

function createBuildCleanup(projectRoot) {

  const resolvedProjectRoot = resolveRequiredPath(projectRoot, 'Project root');
  const filesystemRoot = Path.parse(resolvedProjectRoot).root;
  if (pathsEqual(resolvedProjectRoot, filesystemRoot)) {
    throw new Error('Project root cannot be a filesystem root.');
  }

  const buildRoot = Path.resolve(resolvedProjectRoot, 'build');
  const chromiumMv3Root = Path.resolve(
      buildRoot,
      'extension-chromium-mv3',
  );
  const allowedTargets = [buildRoot, chromiumMv3Root];

  function removeOutput(target) {

    const resolvedTarget = resolveRequiredPath(target, 'Cleanup target');
    const targetFilesystemRoot = Path.parse(resolvedTarget).root;
    if (pathsEqual(resolvedTarget, targetFilesystemRoot)) {
      throw new Error('Cleanup target cannot be a filesystem root.');
    }
    if (pathsEqual(resolvedTarget, resolvedProjectRoot)) {
      throw new Error('Cleanup target cannot be the project root.');
    }
    if (!isWithin(buildRoot, resolvedTarget)) {
      throw new Error('Cleanup target is outside the build root.');
    }
    if (!allowedTargets.some((allowed) => pathsEqual(allowed, resolvedTarget))) {
      throw new Error('Cleanup target is not an allowed output root.');
    }

    rejectSymlinkedParents(resolvedProjectRoot, resolvedTarget);
    Fs.rmSync(resolvedTarget, {recursive: true, force: true});

  }

  return Object.freeze({
    paths: Object.freeze({buildRoot, chromiumMv3Root}),
    removeOutput,
    cleanBuild() {

      removeOutput(buildRoot);

    },
    cleanChromiumMv3() {

      removeOutput(chromiumMv3Root);

    },
  });

}

const cleanup = createBuildCleanup(__dirname);

module.exports = Object.freeze({
  paths: cleanup.paths,
  removeOutput: cleanup.removeOutput,
  cleanBuild: cleanup.cleanBuild,
  cleanChromiumMv3: cleanup.cleanChromiumMv3,
  createBuildCleanup,
});
