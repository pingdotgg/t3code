#!/usr/bin/env bun
/**
 * Publish one workspace package to npm, idempotently.
 *
 * - Skips if {name}@{version} is already on the registry.
 * - Rewrites `workspace:*` in dependency sections to the concrete sibling
 *   version read from each sibling's package.json. `bun pm pack`'s own
 *   substitution resolves `workspace:*` via bun.lock, which can lag behind
 *   a fresh version bump — in beta.12 every package shipped with its
 *   siblings pinned to beta.11 for that reason. Doing the rewrite here
 *   sidesteps the lockfile entirely.
 * - Selects the npm dist-tag based on the release channel:
 *     release → latest
 *     beta|alpha → next
 *     tag → derived from the version's prerelease suffix (e.g.
 *           2.0.0-experimental.1 → experimental-1)
 *
 * Usage: bun scripts/release/publish-package.ts <package-dir> <channel>
 */
import { $ } from "bun";
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type DepMap = Record<string, string>;
type PackageJson = {
  name: string;
  version: string;
  dependencies?: DepMap;
  devDependencies?: DepMap;
  peerDependencies?: DepMap;
  optionalDependencies?: DepMap;
};

type Channel = "release" | "beta" | "alpha" | "tag";

const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const satisfies readonly (keyof PackageJson)[];

const CHANNELS: readonly Channel[] = ["release", "beta", "alpha", "tag"];

const packageArg = process.argv[2];
const channel = process.argv[3] as Channel | undefined;
if (!packageArg || !channel || !CHANNELS.includes(channel)) {
  console.error(
    "Usage: bun scripts/release/publish-package.ts <package-dir> <release|beta|alpha|tag>",
  );
  process.exit(1);
}

const repoRoot = process.cwd();
const packageDir = resolve(repoRoot, packageArg);
const pkgPath = join(packageDir, "package.json");

if (!existsSync(pkgPath)) {
  console.error(`No package.json at ${pkgPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageJson;
const { name, version } = pkg;

console.log(`--- Publishing ${name}@${version} (channel: ${channel}) ---`);

const existing = await $`npm view ${`${name}@${version}`} version`
  .nothrow()
  .quiet();
if (existing.exitCode === 0 && existing.stdout.toString().trim().length > 0) {
  console.log(`${name}@${version} already published, skipping`);
  process.exit(0);
}

const siblingVersions = new Map<string, string>();
const packagesRoot = join(repoRoot, "packages");
for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const siblingPkgPath = join(packagesRoot, entry.name, "package.json");
  if (!existsSync(siblingPkgPath)) continue;
  const sibling = JSON.parse(readFileSync(siblingPkgPath, "utf-8")) as {
    name?: string;
    version?: string;
  };
  if (sibling.name && sibling.version) {
    siblingVersions.set(sibling.name, sibling.version);
  }
}

let rewrote = false;
for (const section of DEP_SECTIONS) {
  const deps = pkg[section];
  if (!deps) continue;
  for (const [dep, value] of Object.entries(deps)) {
    if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
    const spec = value.slice("workspace:".length);
    const concrete = siblingVersions.get(dep);
    if (!concrete) {
      console.error(
        `${name}: ${section}.${dep} is ${value} but no workspace package provides ${dep}`,
      );
      process.exit(1);
    }
    const rewritten =
      spec === "*" || spec === ""
        ? concrete
        : spec === "^"
          ? `^${concrete}`
          : spec === "~"
            ? `~${concrete}`
            : spec;
    deps[dep] = rewritten;
    console.log(`  ${section}.${dep}: ${value} → ${rewritten}`);
    rewrote = true;
  }
}

if (rewrote) {
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const $pkg = $.cwd(packageDir);
await $pkg`bun pm pack --destination .`;

const tarballs = readdirSync(packageDir).filter((f) => f.endsWith(".tgz"));
if (tarballs.length !== 1) {
  console.error(
    `Expected exactly one .tgz in ${packageDir}, found ${tarballs.length}: ${tarballs.join(", ")}`,
  );
  process.exit(1);
}
const tarball = tarballs[0]!;

const distTag =
  channel === "release"
    ? "latest"
    : channel === "beta" || channel === "alpha"
      ? "next"
      : version.replace(/^\d+\.\d+\.\d+-/, "").replace(/\./g, "-");
console.log(`Publishing tarball: ${tarball} (dist-tag: ${distTag})`);

await $pkg`npm publish ${tarball} --access public --tag ${distTag}`;

unlinkSync(join(packageDir, tarball));

console.log(`--- Published ${name}@${version} ---`);
