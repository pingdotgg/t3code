#!/usr/bin/env bun
/**
 * Compute and apply a version bump across all publishable workspace packages.
 *
 * Writes: packages/{alchemy,better-auth,pr-package}/package.json
 * and (via `bun install`) bun.lock.
 *
 * Prints the chosen version to stdout. All progress messages go to stderr,
 * so callers can capture the version with
 *     VERSION=$(bun scripts/release/bump.ts ...)
 *
 * Does NOT commit or push. The release workflow commits only after every
 * package has been published to npm, so an interrupted publish leaves no
 * orphan commit behind.
 *
 * Channels:
 *   release <patch|minor|major|x.y.z>
 *     Stable release. Bumps the named semver part relative to the current
 *     max stable version on npm, or uses the explicit version as-is.
 *
 *   beta [N] / alpha [N]
 *     Auto-incrementing pre-release. With no spec, queries npm for the
 *     max 2.0.0-{channel}.N across every publishable package and increments.
 *     Pass N explicitly to force 2.0.0-{channel}.<N>.
 *
 *     Resume behavior: if a prior release published some packages but not
 *     others, or published everything but the git tag is missing on the
 *     remote, we resume at that N instead of incrementing past it.
 *
 *   tag <version>
 *     Use <version> verbatim. Intended for ad-hoc channels like
 *     `tag 2.0.0-experimental.1` — publish-package.ts derives a custom
 *     npm dist-tag from the prerelease suffix.
 *
 * Examples:
 *   bun scripts/release/bump.ts release patch
 *   bun scripts/release/bump.ts release 2.1.0
 *   bun scripts/release/bump.ts beta
 *   bun scripts/release/bump.ts beta 15
 *   bun scripts/release/bump.ts alpha
 *   bun scripts/release/bump.ts tag 2.0.0-experimental.1
 */
import { $ } from "bun";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PUBLISHABLE_DIRS = ["alchemy", "better-auth", "pr-package"] as const;

const PUBLISHABLE_NAMES = [
  "alchemy",
  "@alchemy.run/better-auth",
  "@alchemy.run/pr-package",
] as const;

// Pre-release versions the beta/alpha auto-increment considers when deciding
// whether to resume. Keeps the line `2.0.0-...` since that is the series
// currently being released; change here when the stable line advances.
const CURRENT_MAJOR_MINOR_PATCH = "2.0.0";

type Channel = "release" | "beta" | "alpha" | "tag";

const CHANNELS: readonly Channel[] = ["release", "beta", "alpha", "tag"];

function usage(): never {
  console.error(
    "Usage:\n" +
      "  bun scripts/release/bump.ts release <patch|minor|major|x.y.z>\n" +
      "  bun scripts/release/bump.ts beta [N]\n" +
      "  bun scripts/release/bump.ts alpha [N]\n" +
      "  bun scripts/release/bump.ts tag <version>",
  );
  process.exit(1);
}

async function fetchNpmVersions(pkg: string): Promise<string[]> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${pkg}`);
    if (!r.ok) return [];
    const data = (await r.json()) as { versions?: Record<string, unknown> };
    return Object.keys(data.versions ?? {});
  } catch {
    return [];
  }
}

function maxPrereleaseN(
  versions: readonly string[],
  channel: "beta" | "alpha",
): number {
  const re = new RegExp(`^${CURRENT_MAJOR_MINOR_PATCH}-${channel}\\.(\\d+)$`);
  const ns = versions
    .map((v) => {
      const m = v.match(re);
      return m ? parseInt(m[1]!, 10) : 0;
    })
    .filter((n) => n > 0);
  return ns.length > 0 ? Math.max(...ns) : 0;
}

function maxStable(versions: readonly string[]): string | null {
  const stables = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  if (stables.length === 0) return null;
  return stables.sort(compareSemver)[stables.length - 1]!;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

async function getHeadTagVersion(): Promise<string | null> {
  const r = await $`git describe --exact-match --tags HEAD`.nothrow().quiet();
  if (r.exitCode !== 0) return null;
  const tag = r.stdout.toString().trim();
  if (!/^v\d+\.\d+\.\d+(-[\w.-]+)?$/.test(tag)) return null;
  return tag.slice(1);
}

async function remoteTagExists(tag: string): Promise<boolean> {
  const r =
    await $`git ls-remote --exit-code --tags origin ${`refs/tags/${tag}`}`
      .nothrow()
      .quiet();
  return r.exitCode === 0;
}

async function resolveRelease(spec: string | undefined): Promise<string> {
  if (!spec) {
    console.error("release channel requires a spec: patch|minor|major|<x.y.z>");
    process.exit(1);
  }
  if (/^\d+\.\d+\.\d+$/.test(spec)) {
    console.error(`Explicit release version: ${spec}`);
    return spec;
  }
  if (spec !== "patch" && spec !== "minor" && spec !== "major") {
    console.error(
      `Invalid release spec: ${spec}. Use patch|minor|major|<x.y.z>.`,
    );
    process.exit(1);
  }
  const versions = await fetchNpmVersions("alchemy");
  const current = maxStable(versions);
  if (!current) {
    console.error(
      "No stable `alchemy` versions on npm; cannot bump relative to current.",
    );
    process.exit(1);
  }
  const [maj, min, pat] = current.split(".").map((n) => parseInt(n, 10)) as [
    number,
    number,
    number,
  ];
  const bumped =
    spec === "major"
      ? `${maj + 1}.0.0`
      : spec === "minor"
        ? `${maj}.${min + 1}.0`
        : `${maj}.${min}.${pat + 1}`;
  console.error(`Bumping ${spec}: ${current} → ${bumped}`);
  return bumped;
}

async function resolvePrerelease(
  channel: "beta" | "alpha",
  spec: string | undefined,
): Promise<string> {
  if (spec !== undefined) {
    if (!/^\d+$/.test(spec)) {
      console.error(
        `${channel} channel spec must be an integer N (got: ${spec})`,
      );
      process.exit(1);
    }
    const explicit = `${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${spec}`;
    console.error(`Explicit ${channel} version: ${explicit}`);
    return explicit;
  }

  console.error(`Resolving next ${channel} version from npm state...`);
  const perPkgMax = await Promise.all(
    PUBLISHABLE_NAMES.map(async (name) => {
      const versions = await fetchNpmVersions(name);
      return maxPrereleaseN(versions, channel);
    }),
  );
  const maxN = Math.max(0, ...perPkgMax);
  const allAtMax = maxN > 0 && perPkgMax.every((n) => n === maxN);

  let nextN: number;
  if (maxN === 0) {
    nextN = 1;
    console.error(
      `No ${channel} versions on npm yet; starting at ${channel}.${nextN}`,
    );
  } else if (!allAtMax) {
    nextN = maxN;
    console.error(
      `Partial publish at ${channel}.${maxN} (per-package: ${JSON.stringify(
        Object.fromEntries(PUBLISHABLE_NAMES.map((n, i) => [n, perPkgMax[i]])),
      )}). Resuming at ${channel}.${nextN}.`,
    );
  } else if (
    !(await remoteTagExists(`v${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${maxN}`))
  ) {
    nextN = maxN;
    console.error(
      `All packages at ${channel}.${maxN} on npm but tag v${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${maxN} missing on remote. Resuming at ${channel}.${nextN}.`,
    );
  } else {
    nextN = maxN + 1;
    console.error(
      `Bumping to next ${channel}: ${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${nextN}`,
    );
  }
  return `${CURRENT_MAJOR_MINOR_PATCH}-${channel}.${nextN}`;
}

function resolveTag(spec: string | undefined): string {
  // The tag channel is the explicit-version escape hatch. Whatever the
  // caller passes is used verbatim — this is the equivalent of the old
  // `version-override` input. We enforce an x.y.z-<suffix> shape (no plain
  // stable versions) because `tag` releases are always pre-releases; use
  // the `release` channel for stable x.y.z versions.
  if (!spec) {
    console.error(
      "tag channel requires an explicit version (e.g. 2.0.0-experimental.1)",
    );
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+-[\w.-]+$/.test(spec)) {
    console.error(
      `tag channel version must be x.y.z-<suffix> (always a pre-release); got: ${spec}`,
    );
    process.exit(1);
  }
  console.error(`Using tag version: ${spec}`);
  return spec;
}

const channel = process.argv[2] as Channel | undefined;
const spec = process.argv[3];

if (!channel || !CHANNELS.includes(channel)) {
  usage();
}

let newVersion: string;

// Durability: if HEAD is already an exact release tag (commit-then-publish
// flow committed and tagged on a previous attempt that failed before npm
// publish completed), reuse that version instead of computing a new one.
// Skipped for `tag` channel, where the explicit spec is authoritative.
const headTagVersion = channel !== "tag" ? await getHeadTagVersion() : null;
if (headTagVersion) {
  console.error(
    `HEAD is already tagged v${headTagVersion}; resuming with this version.`,
  );
  newVersion = headTagVersion;
} else {
  switch (channel) {
    case "release":
      newVersion = await resolveRelease(spec);
      break;
    case "beta":
    case "alpha":
      newVersion = await resolvePrerelease(channel, spec);
      break;
    case "tag":
      newVersion = resolveTag(spec);
      break;
  }
}

for (const dir of PUBLISHABLE_DIRS) {
  const pkgPath = join(process.cwd(), "packages", dir, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
  pkg.version = newVersion;
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.error("Running bun install to refresh bun.lock workspace versions...");
await $`bun install`.quiet();

console.log(newVersion);
