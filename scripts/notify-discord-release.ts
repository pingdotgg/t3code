#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

export type DiscordReleaseTarget = "prerelease" | "latest";

export interface DiscordReleaseAnnouncementOptions {
  readonly target: DiscordReleaseTarget;
  readonly roleId: string;
  readonly releaseName: string;
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: URL;
  readonly timestamp: string;
  readonly releaseNotes?: string;
}

interface DiscordWebhookPayload {
  readonly content: string;
  readonly allowed_mentions: {
    readonly parse: ReadonlyArray<never>;
    readonly roles: ReadonlyArray<string>;
  };
  readonly embeds: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly description: string;
    readonly color: number;
    readonly footer: { readonly text: string };
    readonly timestamp: string;
  }>;
}

const DISCORD_RELEASE_TARGETS = ["prerelease", "latest"] as const;
const DiscordRoleIdSchema = Schema.String.check(Schema.isPattern(/^\d+$/));
const DiscordWebhookUrl = Config.Redacted("DISCORD_WEBHOOK_URL").pipe(
  Effect.flatMap((value) =>
    Effect.try({
      try: () => new URL(Redacted.value(value)),
      catch: () => new DiscordReleaseWebhookConfigurationError({}),
    }),
  ),
);

export class DiscordReleaseWebhookConfigurationError extends Schema.TaggedError<DiscordReleaseWebhookConfigurationError>()(
  "DiscordReleaseWebhookConfigurationError",
  {},
) {
  override get message(): string {
    return "DISCORD_WEBHOOK_URL must be a valid URL.";
  }
}

const discordReleaseErrorContext = {
  target: Schema.Literals(["prerelease", "latest"]),
  releaseName: Schema.String,
  version: Schema.String,
  tag: Schema.String,
  releaseUrl: Schema.String,
  webhookOrigin: Schema.String,
  webhookPathnameSegmentCount: Schema.Number,
  contentLength: Schema.Number,
  embedCount: Schema.Number,
  allowedRoleMentionCount: Schema.Number,
  hasRoleMentionSyntax: Schema.Boolean,
};

export class DiscordReleaseWebhookRequestError extends Schema.TaggedError<DiscordReleaseWebhookRequestError>()(
  "DiscordReleaseWebhookRequestError",
  {
    ...discordReleaseErrorContext,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to post Discord ${this.target} release announcement for "${this.tag}" to ${this.webhookOrigin}.`;
  }
}

export class DiscordReleaseWebhookResponseError extends Schema.TaggedError<DiscordReleaseWebhookResponseError>()(
  "DiscordReleaseWebhookResponseError",
  {
    ...discordReleaseErrorContext,
    status: Schema.Number,
  },
) {
  override get message(): string {
    return `Discord ${this.target} release webhook for "${this.tag}" returned status ${this.status}.`;
  }
}

const targetColors = {
  prerelease: 0x5865f2,
  latest: 0x2ecc71,
} as const satisfies Record<DiscordReleaseTarget, number>;

function describeWebhookUrl(webhookUrl: URL) {
  return {
    configured: true,
    origin: webhookUrl.origin,
    pathnameSegmentCount: webhookUrl.pathname.split("/").filter(Boolean).length,
  } as const;
}

function summarizePayload(payload: DiscordWebhookPayload) {
  return {
    contentLength: payload.content.length,
    embedCount: payload.embeds.length,
    allowedRoleMentionCount: payload.allowed_mentions.roles.length,
    hasRoleMentionSyntax: payload.content.includes("<@&"),
  } as const;
}

// Keep release text inert, including occurrences of the intentionally pinged role.
const suppressMentions = (text: string) =>
  text.replace(/@(everyone|here)\b|<@[!&]?\d+>/g, (mention) => mention.replace("@", "@\u200b"));

const escapeLinkLabel = (text: string) => text.replace(/[\\[\]]/g, "\\$&");

// Compact GitHub's generated entries and comparison link, preserving custom
// notes. Contributor links are GitHub profiles, not pings.
function formatReleaseNotes(notes: string) {
  return notes
    .replace(
      /^([*-] )(.+?)(?: by @([\w-]+(?:\[bot\])?))? in (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)[ \t]*\r?$/gm,
      (
        _entry,
        bullet: string,
        title: string,
        author: string | undefined,
        pullRequestUrl: string,
      ) => {
        const change = `${bullet}[${escapeLinkLabel(title)}](${pullRequestUrl})`;
        if (!author) return change;
        const profile = author.endsWith("[bot]") ? `apps/${author.slice(0, -5)}` : author;
        return `${change} by [@${escapeLinkLabel(author)}](https://github.com/${profile})`;
      },
    )
    .replace(
      /^(?:\*\*)?Full Changelog(?:\*\*)?: (https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/\S+)[ \t]*\r?$/gm,
      "[Full Changelog]($1)",
    );
}

// Preserve every character and prefer whole lines, then words. A single oversized
// line still needs splitting, but never between the halves of a Unicode character.
function splitDescription(text: string, limit: number) {
  const chunks: string[] = [];
  while (text.length > limit) {
    const newline = text.lastIndexOf("\n", limit - 1);
    const space = text.lastIndexOf(" ", limit - 1);
    let end = newline > 0 ? newline + 1 : space > 0 ? space + 1 : limit;
    const lastCodeUnit = text.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
    chunks.push(text.slice(0, end));
    text = text.slice(end);
  }
  chunks.push(text);
  return chunks;
}

export const buildDiscordReleaseAnnouncement = (
  options: DiscordReleaseAnnouncementOptions,
): ReadonlyArray<DiscordWebhookPayload> => {
  const releaseName = suppressMentions(options.releaseName);
  const version = suppressMentions(options.version);
  const footerText = `v${version.replace(/^v/, "")}`;
  const content = `-# <@&${options.roleId}>`;
  if (!/^\d+$/.test(options.roleId)) throw new RangeError("Invalid Discord release role ID.");
  if (releaseName.length > 256)
    throw new RangeError("Discord release title exceeds 256 characters.");
  if (content.length > 2000)
    throw new RangeError("Discord release content exceeds 2000 characters.");
  if (footerText.length > 2048) {
    throw new RangeError("Discord release footer exceeds 2048 characters.");
  }

  const intro =
    options.target === "prerelease"
      ? "A new T3 Code prerelease is available for nightly testers."
      : `[View full release notes on GitHub](${options.releaseUrl.href})`;
  const notes =
    options.target === "prerelease"
      ? suppressMentions(formatReleaseNotes(options.releaseNotes?.trim() ?? ""))
      : "";
  const description = notes ? `${intro}\n\n${notes}` : intro;
  // One embed per message avoids Discord's URL deduplication. Reserve a full
  // title and the version footer within the 6000-character aggregate limit.
  const limit = Math.min(4096, 6000 - 256 - footerText.length);
  const descriptions = splitDescription(description, limit);

  return descriptions.map((description, index) => ({
    content: index === 0 ? content : "",
    allowed_mentions: {
      parse: [],
      roles: index === 0 ? [options.roleId] : [],
    },
    embeds: [
      {
        title:
          index === 0 ? releaseName : `Changelog continued (${index + 1}/${descriptions.length})`,
        url: options.releaseUrl.href,
        description,
        color: targetColors[options.target],
        footer: { text: footerText },
        timestamp: options.timestamp,
      },
    ],
  }));
};

export const postDiscordWebhook = Effect.fn("postDiscordWebhook")(function* (
  webhookUrl: URL,
  payload: DiscordWebhookPayload,
  announcement: DiscordReleaseAnnouncementOptions,
) {
  const requestUrl = new URL(webhookUrl);
  requestUrl.searchParams.set("wait", "true");
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      times: 3,
      schedule: Schedule.recurs(3).pipe(
        Schedule.addDelay(
          (
            metadata: Schedule.Metadata<
              number,
              HttpClientResponse.HttpClientResponse | HttpClientError.HttpClientError
            >,
          ) => {
            const response = !HttpClientError.isHttpClientError(metadata.input)
              ? metadata.input
              : metadata.input.reason._tag === "StatusCodeError"
                ? metadata.input.reason.response
                : undefined;
            const retryAfterSeconds = Number(response?.headers["retry-after"]);
            return Effect.succeed(
              Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
                ? retryAfterSeconds * 1000
                : 1000,
            );
          },
        ),
      ),
    }),
  );

  yield* Effect.logInfo("discord webhook request dispatching").pipe(
    Effect.annotateLogs({
      ...describeWebhookUrl(webhookUrl),
      ...summarizePayload(payload),
    }),
  );

  const errorContext = {
    target: announcement.target,
    releaseName: announcement.releaseName,
    version: announcement.version,
    tag: announcement.tag,
    releaseUrl: announcement.releaseUrl.href,
    webhookOrigin: webhookUrl.origin,
    webhookPathnameSegmentCount: webhookUrl.pathname.split("/").filter(Boolean).length,
    ...summarizePayload(payload),
  } as const;

  const response = yield* HttpClientRequest.post(requestUrl).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(httpClient.execute),
    // Bound requests and retry waits together without shortening Retry-After.
    Effect.timeout("1 minute"),
    Effect.mapError(
      (error) =>
        new DiscordReleaseWebhookRequestError({
          ...errorContext,
          // HTTP errors retain the request URL, including the webhook token.
          reason: error._tag === "HttpClientError" ? error.reason._tag : error._tag,
        }),
    ),
  );

  yield* Effect.logInfo("discord webhook response received").pipe(
    Effect.annotateLogs({
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
    }),
  );

  yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError(
      () =>
        new DiscordReleaseWebhookResponseError({
          ...errorContext,
          status: response.status,
        }),
    ),
  );
});

export const notifyDiscordReleaseCommand = Command.make(
  "notify-discord-release",
  {
    target: Argument.Literals("target", DISCORD_RELEASE_TARGETS).pipe(
      Argument.withDescription("Discord announcement target: prerelease or latest."),
    ),
    roleId: Flag.String("role-id").pipe(
      Flag.withSchema(DiscordRoleIdSchema),
      Flag.withDescription("Discord role ID to mention in the release announcement."),
    ),
    releaseName: Flag.String("release-name").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Human-readable release name."),
    ),
    releaseVersion: Flag.String("release-version").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Release version."),
    ),
    tag: Flag.String("tag").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Git tag for the release."),
    ),
    releaseUrl: Flag.String("release-url").pipe(
      Flag.withSchema(Schema.URLFromString),
      Flag.withDescription("Public GitHub release URL."),
    ),
    releaseNotesFile: Flag.String("release-notes-file").pipe(
      Flag.optional,
      Flag.withDescription("File containing the published GitHub release notes."),
    ),
  },
  ({ target, roleId, releaseName, releaseVersion, tag, releaseUrl, releaseNotesFile }) =>
    Effect.gen(function* () {
      yield* Effect.logInfo("discord release announcement starting").pipe(
        Effect.annotateLogs({
          target,
          roleIdProvided: roleId.length > 0,
          roleIdLength: roleId.length,
          releaseName,
          version: releaseVersion,
          tag,
          releaseUrl,
        }),
      );

      const webhookUrl = yield* DiscordWebhookUrl;
      const fs = yield* FileSystem.FileSystem;
      const releaseNotes =
        target === "prerelease" && Option.isSome(releaseNotesFile)
          ? yield* fs.readFileString(releaseNotesFile.value)
          : "";
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const announcement = {
        target,
        roleId,
        releaseName,
        version: releaseVersion,
        tag,
        releaseUrl,
        timestamp,
        releaseNotes,
      } satisfies DiscordReleaseAnnouncementOptions;
      const payloads = yield* Effect.sync(() => buildDiscordReleaseAnnouncement(announcement));

      yield* Effect.logInfo("discord release announcement payloads built").pipe(
        Effect.annotateLogs({ messageCount: payloads.length }),
      );
      for (const payload of payloads) {
        yield* postDiscordWebhook(webhookUrl, payload, announcement);
      }
      yield* Effect.logInfo("discord release announcement completed");
    }),
).pipe(Command.withDescription("Post a T3 Code release announcement to Discord."));

if (import.meta.main) {
  Command.run(notifyDiscordReleaseCommand, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
