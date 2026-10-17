// Copies the Prisma CLI and everything it needs at runtime into a
// standalone node_modules tree, so the production image can run
// `npx prisma migrate deploy` as Render's pre-deploy command and
// `npx prisma db seed` from a Render shell.
//
// The Next.js standalone output only traces what the *app* imports
// (@prisma/client, pg, ...) — not the CLI, its ~130 transitive packages,
// the schema-engine binary, the `dotenv` that prisma.config.ts imports, or
// the @prisma/adapter-pg that prisma/seed.mjs imports (the app bundles the
// adapter into its server chunks, so it isn't in .next/standalone).
// This script derives that closure from package-lock.json (no hardcoded
// package list) and copies it from the already-installed node_modules, so
// the result is byte-identical to what `npm ci` produced in the deps stage
// (including the schema-engine binary fetched by @prisma/engines'
// postinstall). Symlinks — notably node_modules/.bin/prisma — are copied
// as symlinks, not followed.
//
// Usage: node scripts/collect-prisma-cli.mjs <outDir>
//   reads ./package-lock.json and ./node_modules, writes <outDir>/node_modules.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";

const ROOTS = ["prisma", "dotenv", "@prisma/adapter-pg"];

const outDir = process.argv[2];
if (!outDir) {
  throw new Error("Usage: node scripts/collect-prisma-cli.mjs <outDir>");
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.lockfileVersion < 2 || !lock.packages) {
  throw new Error(`Unsupported lockfile version ${lock.lockfileVersion}: expected v2/v3 with a "packages" map.`);
}
const packages = lock.packages;

// Node's resolution algorithm over lockfile keys: from the package at
// `fromKey`, look in its own node_modules, then each ancestor's, up to the
// top-level node_modules.
function resolve(name, fromKey) {
  let base = fromKey;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) {
      return candidate;
    }
    if (!base) {
      return null;
    }
    const idx = base.lastIndexOf("/node_modules/");
    base = idx === -1 ? "" : base.slice(0, idx);
  }
}

const included = new Set();

function visit(key) {
  if (included.has(key)) {
    return;
  }
  const entry = packages[key];
  if (entry.link) {
    throw new Error(`${key} is a linked (workspace) package; not supported.`);
  }
  if (entry.dev) {
    throw new Error(`${key} is a devDependency-only package but was reached from a production root.`);
  }
  if (!existsSync(key)) {
    throw new Error(`${key} is in package-lock.json but not installed; run \`npm ci\` first.`);
  }
  included.add(key);

  for (const name of Object.keys(entry.dependencies ?? {})) {
    const dep = resolve(name, key);
    if (!dep) {
      throw new Error(`Cannot resolve dependency "${name}" of ${key} in package-lock.json.`);
    }
    visit(dep);
  }

  // Optional deps (e.g. per-platform binaries) are only included when npm
  // actually installed them on this platform.
  for (const name of Object.keys(entry.optionalDependencies ?? {})) {
    const dep = resolve(name, key);
    if (dep && existsSync(dep)) {
      visit(dep);
    }
  }

  // Optional peers (e.g. prisma -> typescript) are skipped: the package
  // works without them, and here they'd only be present via devDependencies.
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (entry.peerDependenciesMeta?.[name]?.optional === true) {
      continue;
    }
    const dep = resolve(name, key);
    if (!dep) {
      throw new Error(`Cannot resolve required peer dependency "${name}" of ${key} in package-lock.json.`);
    }
    visit(dep);
  }
}

for (const name of ROOTS) {
  const key = resolve(name, "");
  if (!key) {
    throw new Error(`Root package "${name}" not found in package-lock.json.`);
  }
  visit(key);
}

rmSync(outDir, { recursive: true, force: true });

const sorted = [...included].sort();
for (const key of sorted) {
  const nestedModules = path.join(key, "node_modules");
  // Copy the package itself but not its nested node_modules — nested
  // packages that are part of the closure are their own lockfile entries
  // and get copied on their own; the rest must not leak in.
  cpSync(key, path.join(outDir, key), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => src !== nestedModules,
  });
}

// Recreate top-level .bin entries that point into copied packages, as
// symlinks with their original relative targets.
const binDir = "node_modules/.bin";
const outBinDir = path.join(outDir, binDir);
mkdirSync(outBinDir, { recursive: true });
let binCount = 0;
for (const bin of readdirSync(binDir).sort()) {
  const binPath = path.join(binDir, bin);
  if (!lstatSync(binPath).isSymbolicLink()) {
    continue;
  }
  const target = readlinkSync(binPath);
  const targetKey = path.relative(".", path.resolve(binDir, target));
  if (sorted.some((key) => targetKey.startsWith(`${key}/`) && !targetKey.slice(key.length + 1).startsWith("node_modules/"))) {
    symlinkSync(target, path.join(outBinDir, bin));
    binCount += 1;
  }
}

if (!existsSync(path.join(outBinDir, "prisma"))) {
  throw new Error("node_modules/.bin/prisma was not collected.");
}

console.log(`[collect-prisma-cli] ${sorted.length} packages, ${binCount} bin links -> ${outDir}/node_modules`);
