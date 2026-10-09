#!/usr/bin/env bun
/**
 * Post a release announcement to Discord as a single embed. The body is
 * read verbatim from the CHANGELOG.md entry the release-notes step just
 * wrote, so Discord matches the GitHub Release copy exactly.
 *
 * The webhook posts under `<RepoName> Releases` (e.g. "Alchemy-Effect
 * Releases", "Distilled Releases"). The embed title uses the first
 * hyphen-segment of the repo name as the project prefix
 * (alchemy-effect → "Alchemy", distilled → "Distilled") and omits the
 * channel suffix for stable `release` channel so you don't get
 * "...(release) released" doubling up.
 *
 *   alchemy-effect + beta → Alchemy v2.0.0-beta.42 (beta) released
 *   distilled + release  → Distilled v0.21.3 released
 *
 * Reads DISCORD_WEBHOOK from the environment. Silently no-ops if unset.
 *
 * Usage: bun discord-notify.ts <tag> <release|beta|alpha|tag>
 *
 * Reads ALCHEMY_REPO for the GitHub repo to link to.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "./config.ts";
import { extractTagBody, toDiscordBody } from "./discord-body.ts";

const EMBED_DESCRIPTION_LIMIT = 4096;

const tag = process.argv[2];
const channel = process.argv[3];
if (!tag || !channel) {
  console.error("Usage: bun discord-notify.ts <tag> <channel>");
  process.exit(1);
}

const webhook = process.env.DISCORD_WEBHOOK;
if (!webhook) {
  console.log("DISCORD_WEBHOOK not set, skipping Discord notification");
  process.exit(0);
}

const REPO = repo();
const repoSlug = REPO.split("/")[1]!;
const capitalize = (s: string) =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
// "alchemy-effect" -> "Alchemy-Effect"
const fullRepoName = repoSlug.split("-").map(capitalize).join("-");
// "alchemy-effect" -> "Alchemy"
const projectName = capitalize(repoSlug.split("-")[0]!);
const botName = `${fullRepoName} Releases`;
const titleChannel = channel === "release" ? "" : ` (${channel})`;
const title = `${projectName} ${tag}${titleChannel} released`;

const changelogPath = join(process.cwd(), "CHANGELOG.md");
const changelog = await readFile(changelogPath, "utf-8");
const rawBody = extractTagBody(changelog, tag);
if (rawBody === undefined) {
  console.error(`CHANGELOG.md has no entry for ${tag}`);
  process.exit(1);
}

const body = toDiscordBody(rawBody);

const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
const footer = `\n\n[Full release notes →](${releaseUrl})`;
// Discord embed descriptions cap at 4096 chars. If the rendered body
// plus the footer would overflow, truncate the body to fit and prepend
// a notice line so the reader knows there's more on GitHub. We cut at
// the last newline before the budget so we never slice mid-bullet, then
// fall back to a hard slice if no newline lands in range.
const truncationNotice =
  "_Release notes truncated — see the full changelog on GitHub._\n\n";
let description = `${body}${footer}`;
if (description.length > EMBED_DESCRIPTION_LIMIT) {
  const budget =
    EMBED_DESCRIPTION_LIMIT - footer.length - truncationNotice.length;
  let cut = body.lastIndexOf("\n", budget);
  if (cut < budget / 2) cut = budget; // no convenient newline — hard cut
  const truncated = body.slice(0, cut).trimEnd();
  description = `${truncationNotice}${truncated}${footer}`;
  console.log(
    `Changelog body (${body.length} chars) exceeded Discord limit; truncated to ${truncated.length} chars and linked to GitHub for the full notes.`,
  );
}

const res = await fetch(webhook, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: botName,
    embeds: [
      {
        title,
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
