#!/usr/bin/env bun
/**
 * Create a GitHub release for a tag, with channel-aware prerelease/latest flags.
 *
 * GitHub's API does not allow a release to be both `prerelease=true` and
 * `latest=true`. To show an alpha/beta as "Latest" when no stable release
 * exists yet, we publish it with `prerelease=false` — a masquerade. This
 * script compensates on the next release: if the currently-latest release
 * has a pre-release-style tag and prerelease=false, we flip it back to
 * `prerelease=true` before publishing the new one. That keeps the latest
 * badge where the user wants it without leaving stale "stable" markers on
 * alpha/beta tags.
 *
 * Channel → flags on the new release:
 *   release        prerelease=false, latest=true
 *   beta | alpha   if any true-stable release exists: prerelease=true, latest=false
 *                  else:                              prerelease=false, latest=true (masquerade)
 *   tag            prerelease=true, latest=false (always)
 *
 * Usage: bun scripts/release/github-release.ts <tag> <release|beta|alpha|tag>
 */
import { $ } from "bun";
import { generate } from "changelogithub";

type Channel = "release" | "beta" | "alpha" | "tag";
const CHANNELS: readonly Channel[] = ["release", "beta", "alpha", "tag"];

// A tag looks stable iff it's `v?X.Y.Z` with no prerelease suffix.
// A "true stable" release is one with such a tag AND prerelease=false on GH;
// a masquerading alpha/beta has prerelease=false but a non-stable-shaped tag.
function isStableTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+$/.test(tag);
}

const tag = process.argv[2];
const channel = process.argv[3] as Channel | undefined;
if (!tag || !channel || !CHANNELS.includes(channel)) {
  console.error(
    "Usage: bun scripts/release/github-release.ts <tag> <release|beta|alpha|tag>",
  );
  process.exit(1);
}

const view = await $`gh release view ${tag}`.nothrow().quiet();
if (view.exitCode === 0) {
  console.log(`Release ${tag} already exists on GitHub, skipping`);
  process.exit(0);
}

// Decide flags.
let prerelease: boolean;
let latest: boolean;
if (channel === "release") {
  prerelease = false;
  latest = true;
} else if (channel === "tag") {
  prerelease = true;
  latest = false;
} else {
  // alpha/beta — latest iff no true-stable release already exists.
  const list = await $`gh release list --limit 500 --json tagName,isPrerelease`
    .nothrow()
    .quiet();
  let hasStable = false;
  if (list.exitCode === 0) {
    const raw = list.stdout.toString().trim();
    const releases = raw
      ? (JSON.parse(raw) as Array<{ tagName: string; isPrerelease: boolean }>)
      : [];
    hasStable = releases.some((r) => isStableTag(r.tagName) && !r.isPrerelease);
  }
  if (hasStable) {
    prerelease = true;
    latest = false;
  } else {
    prerelease = false;
    latest = true;
    console.log(
      "No true-stable release exists; publishing this prerelease with prerelease=false so it can be marked latest.",
    );
  }
}

// If we're about to become the new latest, correct the previous masquerade.
// GH auto-removes the `latest` flag from the prior release when a new one
// claims it — but it leaves prerelease=false in place, which is the lie we
// need to undo. We must also pass --latest=false because GH's API rejects
// prerelease=true + latest=true in one go.
if (latest) {
  const cur = await $`gh release view --latest --json tagName,isPrerelease`
    .nothrow()
    .quiet();
  if (cur.exitCode === 0) {
    const raw = cur.stdout.toString().trim();
    if (raw) {
      const current = JSON.parse(raw) as {
        tagName: string;
        isPrerelease: boolean;
      };
      if (
        current.tagName !== tag &&
        !isStableTag(current.tagName) &&
        !current.isPrerelease
      ) {
        console.log(
          `Demoting previous masquerading latest ${current.tagName}: prerelease=false → true`,
        );
        await $`gh release edit ${current.tagName} --prerelease=true --latest=false`;
      }
    }
  }
}

const prev = await $`git describe --tags --abbrev=0 ${`${tag}^`}`
  .nothrow()
  .quiet();
const from = prev.exitCode === 0 ? prev.stdout.toString().trim() : undefined;

console.log(
  `Generating release notes for ${tag}${from ? ` from ${from}` : ""}`,
);
const { md } = await generate({
  from,
  to: tag,
  emoji: true,
  contributors: true,
  repo: "alchemy-run/alchemy-effect",
});

const args = [
  "release",
  "create",
  tag,
  "--title",
  tag,
  "--notes",
  md,
  `--latest=${latest ? "true" : "false"}`,
];
if (prerelease) args.push("--prerelease");

await $`gh ${args}`;
