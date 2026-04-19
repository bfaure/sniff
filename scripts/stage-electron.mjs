#!/usr/bin/env node
/**
 * Physically populate apps/electron/node_modules/ with the production
 * dependency tree so electron-builder can package it.
 *
 * Why this exists: in our npm-workspaces layout, deps are hoisted to the
 * repo-root node_modules and @sniff/* packages live as symlinks. When
 * electron-builder follows those symlinks it gets realpaths that fall
 * outside the app dir (apps/electron) and aborts with
 *   `<file> must be under <appDir>`
 *
 * This script resolves the closure of production deps starting from
 * apps/electron/package.json + apps/backend/package.json and copies
 * each package as a real directory under apps/electron/node_modules/.
 * Workspace packages (@sniff/backend, @sniff/shared) are copied from
 * their built source.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROOT_NM = path.join(REPO, 'node_modules');
const ELECTRON_DIR = path.join(REPO, 'apps', 'electron');
const ELECTRON_NM = path.join(ELECTRON_DIR, 'node_modules');

const WORKSPACE_PKGS = {
  '@sniff/backend': {
    sourceDir: path.join(REPO, 'apps', 'backend'),
    include: ['dist', 'prisma/schema.sql', 'prisma/schema.prisma', 'package.json'],
  },
  '@sniff/shared': {
    sourceDir: path.join(REPO, 'packages', 'shared'),
    include: ['dist', 'package.json'],
  },
};

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function readJSON(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dst, opts = {}) {
  const skip = opts.skip || (() => false);
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (skip(s, e)) continue;
    if (e.isSymbolicLink()) {
      const real = await fs.realpath(s);
      const stat = await fs.stat(real);
      if (stat.isDirectory()) await copyDir(real, d, opts);
      else await fs.copyFile(real, d);
    } else if (e.isDirectory()) {
      await copyDir(s, d, opts);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

async function copyFileEnsured(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

// Skip patterns inside copied packages — keep the package small but functional.
function nodeModuleSkip(srcPath, dirent) {
  const name = dirent.name;
  if (dirent.isDirectory()) {
    if (name === '__tests__' || name === 'test' || name === 'tests' || name === 'docs') return true;
    if (name === 'example' || name === 'examples' || name === 'benchmark' || name === 'benchmarks') return true;
    if (name === '.bin') return true;
    return false;
  }
  // Only filter top-level docs files at the package root, not nested .js source files.
  // Match conservatively: only common docs filenames where they appear by themselves
  // or with a typical doc extension. We skip the "starts with HISTORY" check because
  // it would also match e.g. node_modules/<pkg>/dist/routes/history.js.
  const upper = name.toUpperCase();
  const docExt = /\.(MD|MARKDOWN|RST|TXT)?$/;
  if (/^(README|CHANGELOG|CHANGES|LICENSE|LICENCE|NOTICE|AUTHORS|CONTRIBUTING|UPGRADING|GOVERNANCE|CODE_OF_CONDUCT)/.test(upper) && docExt.test(upper)) return true;
  if (/\.(md|markdown|map)$/.test(name)) return true;
  if (name.endsWith('.ts') && !name.endsWith('.d.ts')) return true;
  return false;
}

async function copyWorkspacePackage(pkgName, info) {
  const dst = path.join(ELECTRON_NM, ...pkgName.split('/'));
  await rmrf(dst);
  await fs.mkdir(dst, { recursive: true });
  for (const rel of info.include) {
    const src = path.join(info.sourceDir, rel);
    if (!(await exists(src))) {
      throw new Error(`[stage] missing required file ${src} for ${pkgName} — did you build first?`);
    }
    const dest = path.join(dst, rel);
    const stat = await fs.stat(src);
    if (stat.isDirectory()) {
      await copyDir(src, dest, { skip: nodeModuleSkip });
    } else {
      await copyFileEnsured(src, dest);
    }
  }
}

async function findPackageDir(pkgName, fromDir) {
  // Walk up node_modules chain like Node's resolution.
  let dir = fromDir;
  while (true) {
    const candidate = path.join(dir, 'node_modules', ...pkgName.split('/'));
    if (await exists(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const copied = new Set();
const queue = [];

async function enqueueDeps(pkgJsonPath, fromDir) {
  const pkg = await readJSON(pkgJsonPath);
  const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  for (const dep of Object.keys(deps)) {
    queue.push({ name: dep, fromDir });
  }
}

async function copyExternalPackage(pkgName, fromDir) {
  if (copied.has(pkgName)) return;
  if (pkgName in WORKSPACE_PKGS) return; // handled separately
  const src = await findPackageDir(pkgName, fromDir);
  if (!src) {
    console.warn(`[stage] WARN: could not resolve ${pkgName} from ${fromDir}`);
    return;
  }
  copied.add(pkgName);
  const dst = path.join(ELECTRON_NM, ...pkgName.split('/'));
  await rmrf(dst);
  await copyDir(src, dst, { skip: nodeModuleSkip });
  // Recurse into its deps.
  await enqueueDeps(path.join(src, 'package.json'), src);
}

async function main() {
  console.log('[stage] cleaning apps/electron/node_modules (preserving electron binary)');
  // Preserve `electron` package (heavy, no transitive runtime deps we ship)
  // by removing only the things we'll repopulate.
  const existingNm = await exists(ELECTRON_NM);
  if (existingNm) {
    const entries = await fs.readdir(ELECTRON_NM);
    for (const name of entries) {
      if (name === 'electron' || name === '.package-lock.json') continue;
      await rmrf(path.join(ELECTRON_NM, name));
    }
  } else {
    await fs.mkdir(ELECTRON_NM, { recursive: true });
  }

  console.log('[stage] copying workspace packages');
  for (const [name, info] of Object.entries(WORKSPACE_PKGS)) {
    console.log(`  - ${name}`);
    await copyWorkspacePackage(name, info);
    await enqueueDeps(path.join(info.sourceDir, 'package.json'), info.sourceDir);
  }

  // Also include electron's own non-electron deps (none currently, but future-proof)
  await enqueueDeps(path.join(ELECTRON_DIR, 'package.json'), ELECTRON_DIR);

  console.log('[stage] copying transitive prod dependencies from root node_modules');
  while (queue.length) {
    const { name, fromDir } = queue.shift();
    if (name === 'electron') continue; // shipped by electron-builder
    if (copied.has(name)) continue;
    await copyExternalPackage(name, fromDir);
  }

  // Special case: ensure .prisma/client (generated client) is present alongside @prisma/client.
  const dotPrismaSrc = path.join(ROOT_NM, '.prisma');
  if (await exists(dotPrismaSrc)) {
    console.log('[stage] copying .prisma/ (generated client + native engine)');
    const dotPrismaDst = path.join(ELECTRON_NM, '.prisma');
    await rmrf(dotPrismaDst);
    await copyDir(dotPrismaSrc, dotPrismaDst, { skip: nodeModuleSkip });
  } else {
    console.warn('[stage] WARN: root node_modules/.prisma not found — did `prisma generate` run?');
  }

  console.log(`[stage] staged ${copied.size} packages into apps/electron/node_modules`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
