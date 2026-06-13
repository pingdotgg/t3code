#!/usr/bin/env bun
/**
 * Post a release announcement to Discord as a single embed. The body is
 * read verbatim from the CHANGELOG.md entry the release-notes step just
 * wrote, so Discord matches the GitHub Release copy exactly.
 *
 * Reads DISCORD_WEBHOOK from the environment. Silently no-ops if unset.
 *
 * Usage: bun scripts/release/discord-notify.ts <tag> <release|beta|alpha|tag>
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractTagBody, toDiscordBody } from "./discord-body.ts";

const REPO = "alchemy-run/alchemy-effect";
// Discord embed description hard limit.
const EMBED_DESCRIPTION_LIMIT = 4096;

const tag = process.argv[2];
const channel = process.argv[3];
if (!tag || !channel) {
  console.error("Usage: bun scripts/release/discord-notify.ts <tag> <channel>");
  process.exit(1);
}

const webhook = process.env.DISCORD_WEBHOOK;
if (!webhook) {
  console.log("DISCORD_WEBHOOK not set, skipping Discord notification");
  process.exit(0);
}

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const changelog = await readFile(changelogPath, "utf-8");
const rawBody = extractTagBody(changelog, tag);
if (rawBody === undefined) {
  console.error(`CHANGELOG.md has no entry for ${tag}`);
  process.exit(1);
}

const body = toDiscordBody(rawBody);

const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
const description = `${body}\n\n[Full release notes →](${releaseUrl})`;

if (description.length > EMBED_DESCRIPTION_LIMIT) {
  console.error(
    `Changelog (${description.length} chars) exceeds Discord embed description limit (${EMBED_DESCRIPTION_LIMIT}). Trim the changelog or split the release.`,
  );
  process.exit(1);
}

const res = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    embeds: [
      {
        title: `${tag} (${channel}) released`,
        url: releaseUrl,
        description,
      },
    ],
    allowed_mentions: { parse: [] },
  }),
});

if (!res.ok) {
  console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`Posted Discord release notification for ${tag}`);
