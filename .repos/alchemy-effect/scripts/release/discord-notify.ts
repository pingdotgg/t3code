// Posts a release announcement to Discord as a single embed. The body is
// read verbatim from the CHANGELOG.md entry the release-notes step just
// wrote, so Discord matches the GitHub Release copy exactly.
//
// The webhook posts under `<RepoName> Releases` (e.g. "Alchemy-Effect
// Releases", "Distilled Releases"). The embed title uses the first
// hyphen-segment of the repo name as the project prefix
// (alchemy-effect → "Alchemy", distilled → "Distilled") and omits the
// channel suffix for the stable `release` channel so you don't get
// "...(release) released" doubling up.
//
//   alchemy-effect + beta → Alchemy v2.0.0-beta.42 (beta) released
//   distilled + release  → Distilled v0.21.3 released
//
// Reads DISCORD_WEBHOOK from the environment and no-ops if it is unset.
// Reads `ALCHEMY_REPO` (`<owner>/<repo>`) for the GitHub links.
//
// Usage: node scripts/release/discord-notify.ts <tag> <release|beta|alpha|rc|tag>
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command } from "effect/cli";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { repository } from "./config.ts";
import { extractTagBody, toDiscordBody } from "./discord-body.ts";

const EMBED_DESCRIPTION_LIMIT = 4096;

export class MissingChangelogEntry extends Data.TaggedError("MissingChangelogEntry")<{
  readonly message: string;
  readonly tag: string;
}> {}

export class WebhookFailed extends Data.TaggedError("WebhookFailed")<{
  readonly message: string;
  readonly status: number;
}> {}

const capitalize = (s: string) => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

/**
 * Discord embed descriptions cap at 4096 chars. If the body plus the footer
 * would overflow, truncate the body to fit and prepend a notice so the reader
 * knows there's more on GitHub. Cuts at the last newline before the budget so
 * a bullet is never sliced, falling back to a hard cut if no newline lands in
 * range.
 */
const fitDescription = (body: string, footer: string) => {
  const description = `${body}${footer}`;
  if (description.length <= EMBED_DESCRIPTION_LIMIT) return { description, truncated: false };
  const notice = "_Release notes truncated — see the full changelog on GitHub._\n\n";
  const budget = EMBED_DESCRIPTION_LIMIT - footer.length - notice.length;
  let cut = body.lastIndexOf("\n", budget);
  if (cut < budget / 2) cut = budget;
  return { description: `${notice}${body.slice(0, cut).trimEnd()}${footer}`, truncated: true };
};

const command = Command.make(
  "discord-notify",
  {
    tag: Argument.String("tag").pipe(Argument.withDescription("Release tag, e.g. v1.0.0-rc.14")),
    channel: Argument.String("channel").pipe(Argument.withDescription("Release channel")),
  },
  Effect.fn(function* ({ tag, channel }) {
    const webhook = yield* Config.option(Config.String("DISCORD_WEBHOOK"));
    if (Option.isNone(webhook) || !webhook.value.trim()) {
      yield* Console.log("DISCORD_WEBHOOK not set, skipping Discord notification");
      return;
    }

    const repo = yield* repository;
    const repoSlug = repo.split("/")[1]!;
    // "alchemy-effect" -> "Alchemy-Effect"
    const fullRepoName = repoSlug.split("-").map(capitalize).join("-");
    // "alchemy-effect" -> "Alchemy"
    const projectName = capitalize(repoSlug.split("-")[0]!);
    const titleChannel = channel === "release" ? "" : ` (${channel})`;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const rawBody = extractTagBody(yield* fs.readFileString(path.resolve("CHANGELOG.md")), tag);
    if (rawBody === undefined) {
      return yield* new MissingChangelogEntry({
        message: `CHANGELOG.md has no entry for ${tag}`,
        tag,
      });
    }

    const body = toDiscordBody(rawBody);
    const releaseUrl = `https://github.com/${repo}/releases/tag/${tag}`;
    const { description, truncated } = fitDescription(
      body,
      `\n\n[Full release notes →](${releaseUrl})`,
    );
    if (truncated) {
      yield* Console.log(
        `Changelog body (${body.length} chars) exceeded Discord limit; truncated and linked to GitHub for the full notes.`,
      );
    }

    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(webhook.value.trim()).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          username: `${fullRepoName} Releases`,
          embeds: [
            {
              title: `${projectName} ${tag}${titleChannel} released`,
              url: releaseUrl,
              description,
            },
          ],
          allowed_mentions: { parse: [] },
        }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new WebhookFailed({
        message: `Discord webhook failed: ${response.status} ${yield* response.text}`,
        status: response.status,
      });
    }
    yield* Console.log(`Posted Discord release notification for ${tag}`);
  }),
).pipe(Command.withDescription("Post a release announcement to Discord"));

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide([NodeServices.layer, FetchHttpClient.layer]),
  NodeRuntime.runMain,
);
