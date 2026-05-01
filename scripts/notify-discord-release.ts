#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

export type DiscordReleaseTarget = "prerelease" | "latest";

interface DiscordReleaseAnnouncementOptions {
  readonly target: DiscordReleaseTarget;
  readonly mention: string;
  readonly releaseName: string;
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly timestamp: string;
}

interface DiscordWebhookPayload {
  readonly content: string;
  readonly allowed_mentions: {
    readonly parse: ReadonlyArray<"roles">;
  };
  readonly embeds: ReadonlyArray<{
    readonly title: string;
    readonly url: string;
    readonly description: string;
    readonly color: number;
    readonly fields: ReadonlyArray<{
      readonly name: string;
      readonly value: string;
      readonly inline: boolean;
    }>;
    readonly timestamp: string;
  }>;
}

const DISCORD_RELEASE_TARGETS = ["prerelease", "latest"] as const;
const WebUrlSchema = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/));
const DiscordWebhookUrl = Config.nonEmptyString("DISCORD_WEBHOOK_URL");

class DiscordReleaseAnnouncementError extends Data.TaggedError("DiscordReleaseAnnouncementError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const targetLabels = {
  prerelease: "Prerelease",
  latest: "Latest",
} as const satisfies Record<DiscordReleaseTarget, string>;

const targetColors = {
  prerelease: 0x5865f2,
  latest: 0x2ecc71,
} as const satisfies Record<DiscordReleaseTarget, number>;

export const buildDiscordReleaseAnnouncement = (
  options: DiscordReleaseAnnouncementOptions,
): DiscordWebhookPayload => ({
  content: `${options.mention} ${targetLabels[options.target]} published: ${options.releaseName}`,
  allowed_mentions: {
    parse: ["roles"],
  },
  embeds: [
    {
      title: options.releaseName,
      url: options.releaseUrl,
      description:
        options.target === "prerelease"
          ? "A new T3 Code prerelease is available for nightly testers."
          : "A new T3 Code latest release is available.",
      color: targetColors[options.target],
      fields: [
        {
          name: "Version",
          value: options.version,
          inline: true,
        },
        {
          name: "Tag",
          value: options.tag,
          inline: true,
        },
      ],
      timestamp: options.timestamp,
    },
  ],
});

const postDiscordWebhook = Effect.fn("postDiscordWebhook")(function* (
  webhookUrl: string,
  payload: DiscordWebhookPayload,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    catch: (cause) =>
      new DiscordReleaseAnnouncementError({
        message: "Failed to post Discord release announcement.",
        cause,
      }),
  });

  if (!response.ok) {
    const body = yield* Effect.promise(() => response.text().catch(() => ""));
    return yield* new DiscordReleaseAnnouncementError({
      message: `Discord release announcement failed with HTTP ${response.status}${
        body ? `: ${body}` : ""
      }`,
    });
  }
});

export const notifyDiscordReleaseCommand = Command.make(
  "notify-discord-release",
  {
    target: Argument.choice("target", DISCORD_RELEASE_TARGETS).pipe(
      Argument.withDescription("Discord announcement target: prerelease or latest."),
    ),
    mention: Flag.string("mention").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Discord mention text included at the start of the message."),
    ),
    releaseName: Flag.string("release-name").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Human-readable release name."),
    ),
    version: Flag.string("version").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Release version."),
    ),
    tag: Flag.string("tag").pipe(
      Flag.withSchema(Schema.NonEmptyString),
      Flag.withDescription("Git tag for the release."),
    ),
    releaseUrl: Flag.string("release-url").pipe(
      Flag.withSchema(WebUrlSchema),
      Flag.withDescription("Public GitHub release URL."),
    ),
  },
  ({ target, mention, releaseName, version, tag, releaseUrl }) =>
    Effect.gen(function* () {
      const webhookUrl = yield* DiscordWebhookUrl;
      yield* postDiscordWebhook(
        webhookUrl,
        buildDiscordReleaseAnnouncement({
          target,
          mention,
          releaseName,
          version,
          tag,
          releaseUrl,
          timestamp: new Date().toISOString(),
        }),
      );
    }),
).pipe(Command.withDescription("Post a T3 Code release announcement to Discord."));

if (import.meta.main) {
  Command.run(notifyDiscordReleaseCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
