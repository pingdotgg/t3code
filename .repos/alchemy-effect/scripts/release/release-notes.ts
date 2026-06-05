#!/usr/bin/env bun
/**
 * Prepend release notes for a tag to CHANGELOG.md. Idempotent: if the tag
 * already appears as a heading in CHANGELOG.md, does nothing.
 *
 * Usage: bun scripts/release/release-notes.ts v2.0.0-beta.13
 *
 * Uses `changelogithub` to parse commits and resolve authors, then renders
 * markdown with `./render.ts` so scopes containing `/` (e.g.
 * `fix(aws/lambda): ...`) nest hierarchically instead of becoming flat
 * unrelated groups.
 */
import { $ } from "bun";
import { generate } from "changelogithub";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderMarkdown } from "./render.ts";

const tag = process.argv[2];
if (!tag) {
  console.error("Usage: bun scripts/release/release-notes.ts <tag>");
  process.exit(1);
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const existing = await readFile(changelogPath, "utf-8");
if (existing.includes(`## ${tag}\n`)) {
  console.log(`${tag} already in CHANGELOG.md, skipping`);
  process.exit(0);
}

// changelogithub uses `to` as a git revision in `git log <from>...<to>`.
// In the commit-then-tag flow this script runs BEFORE the tag is created,
// so resolve the revision to HEAD while keeping the tag string for the
// markdown heading. If the tag already exists locally (resumed run), use
// it so the diff is stable.
const tagExists =
  (await $`git rev-parse --verify ${`refs/tags/${tag}`}`.nothrow().quiet())
    .exitCode === 0;
const toRev = tagExists ? tag : "HEAD";

console.log(`Generating release notes for ${tag} (using ${toRev})`);
const { commits, config } = await generate({
  to: toRev,
  emoji: true,
  contributors: true,
  repo: "alchemy-run/alchemy-effect",
});

const md = renderMarkdown(commits, config);

await writeFile(changelogPath, `## ${tag}\n\n${md}\n\n---\n\n${existing}`);
