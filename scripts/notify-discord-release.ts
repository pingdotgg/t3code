#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Data, Effect, Layer, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

export type DiscordReleaseTarget = "prerelease" | "latest";

interface DiscordReleaseAnnouncementOptions {
  readonly target: DiscordReleaseTarget;
  readonly roleId: string;
  readonly releaseName: string;
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly timestamp: string;
}

interface DiscordWebhookPayload {
  readonly content: string;
  readonly allowed_mentions: {
    readonly roles: ReadonlyArray<string>;
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
const DiscordRoleIdSchema = Schema.String.check(Schema.isPattern(/^\d+$/));
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
  content: `<@&${options.roleId}> ${targetLabels[options.target]} published: ${options.releaseName}`,
  allowed_mentions: {
    roles: [options.roleId],
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
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      times: 3,
    }),
    HttpClient.filterStatusOk,
  );

  yield* HttpClientRequest.post(webhookUrl).pipe(
    HttpClientRequest.bodyJson(payload),
    Effect.flatMap(httpClient.execute),
    Effect.mapError(
      (cause) =>
        new DiscordReleaseAnnouncementError({
          message: "Failed to post Discord release announcement.",
          cause,
        }),
    ),
  );
});

const runtimeLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);

export const notifyDiscordReleaseCommand = Command.make(
  "notify-discord-release",
  {
    target: Argument.choice("target", DISCORD_RELEASE_TARGETS).pipe(
      Argument.withDescription("Discord announcement target: prerelease or latest."),
    ),
    roleId: Flag.string("role-id").pipe(
      Flag.withSchema(DiscordRoleIdSchema),
      Flag.withDescription("Discord role ID to mention in the release announcement."),
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
  ({ target, roleId, releaseName, version, tag, releaseUrl }) =>
    Effect.gen(function* () {
      const webhookUrl = yield* DiscordWebhookUrl;
      yield* postDiscordWebhook(
        webhookUrl,
        buildDiscordReleaseAnnouncement({
          target,
          roleId,
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
    Effect.provide(runtimeLayer),
    NodeRuntime.runMain,
  );
}
