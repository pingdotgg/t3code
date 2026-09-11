#!/usr/bin/env bun
/**
 * Prepend release notes for a tag to CHANGELOG.md. Idempotent: if the tag
 * already appears as a heading in CHANGELOG.md, does nothing.
 *
 * Usage: bun release-notes.ts v2.0.0-beta.13
 *
 * Reads ALCHEMY_REPO for the GitHub repo to query commits/authors from.
 */
import { $ } from "bun";
import { generate } from "./changelog.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "./config.ts";
import { renderMarkdown } from "./render.ts";

const tag = process.argv[2];
if (!tag) {
  console.error("Usage: bun release-notes.ts <tag>");
  process.exit(1);
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const existing = await readFile(changelogPath, "utf-8").catch((e) => {
  if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
  throw e;
});
if (existing.includes(`## ${tag}\n`)) {
  console.log(`${tag} already in CHANGELOG.md, skipping`);
  process.exit(0);
}

const tagExists =
  (await $`git rev-parse --verify ${`refs/tags/${tag}`}`.nothrow().quiet())
    .exitCode === 0;
const toRev = tagExists ? tag : "HEAD";

console.log(`Generating release notes for ${tag} (using ${toRev})`);
const { commits, config } = await generate({
  to: toRev,
  emoji: true,
  contributors: true,
  repo: repo(),
});

const md = renderMarkdown(commits, config);

await writeFile(changelogPath, `## ${tag}\n\n${md}\n\n---\n\n${existing}`);
