import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import {
  buildDiscordReleaseAnnouncement,
  isDiscordReleaseAnnouncementError,
  postDiscordWebhook,
} from "./notify-discord-release.ts";

const latestAnnouncement = {
  target: "latest",
  roleId: "222222222222222222",
  releaseName: "T3 Code v1.2.3",
  version: "1.2.3",
  tag: "v1.2.3",
  releaseUrl: new URL("https://github.com/t3dotgg/t3-code/releases/tag/v1.2.3"),
  timestamp: "2026-05-01T01:41:00.000Z",
} as const;

const webhookUrl = new URL("https://discord.com/api/webhooks/123456/secret-token");

it("builds a prerelease Discord announcement for nightly subscribers", () => {
  assert.deepStrictEqual(
    buildDiscordReleaseAnnouncement({
      target: "prerelease",
      roleId: "111111111111111111",
      releaseName: "T3 Code Nightly 1.2.4-nightly.20260501.17 (abcdef123456)",
      version: "1.2.4-nightly.20260501.17",
      tag: "v1.2.4-nightly.20260501.17",
      releaseUrl: new URL(
        "https://github.com/t3dotgg/t3-code/releases/tag/v1.2.4-nightly.20260501.17",
      ),
      timestamp: "2026-05-01T01:41:00.000Z",
    }),
    {
      content:
        "<@&111111111111111111> Prerelease published: T3 Code Nightly 1.2.4-nightly.20260501.17 (abcdef123456)",
      allowed_mentions: {
        roles: ["111111111111111111"],
      },
      embeds: [
        {
          title: "T3 Code Nightly 1.2.4-nightly.20260501.17 (abcdef123456)",
          url: "https://github.com/t3dotgg/t3-code/releases/tag/v1.2.4-nightly.20260501.17",
          description: "A new T3 Code prerelease is available for nightly testers.",
          color: 0x5865f2,
          fields: [
            {
              name: "Version",
              value: "1.2.4-nightly.20260501.17",
              inline: true,
            },
            {
              name: "Tag",
              value: "v1.2.4-nightly.20260501.17",
              inline: true,
            },
          ],
          timestamp: "2026-05-01T01:41:00.000Z",
        },
      ],
    },
  );
});

it("builds a latest Discord announcement for stable subscribers", () => {
  assert.deepStrictEqual(buildDiscordReleaseAnnouncement(latestAnnouncement), {
    content: "<@&222222222222222222> Latest published: T3 Code v1.2.3",
    allowed_mentions: {
      roles: ["222222222222222222"],
    },
    embeds: [
      {
        title: "T3 Code v1.2.3",
        url: "https://github.com/t3dotgg/t3-code/releases/tag/v1.2.3",
        description: "A new T3 Code latest release is available.",
        color: 0x2ecc71,
        fields: [
          {
            name: "Version",
            value: "1.2.3",
            inline: true,
          },
          {
            name: "Tag",
            value: "v1.2.3",
            inline: true,
          },
        ],
        timestamp: "2026-05-01T01:41:00.000Z",
      },
    ],
  });
});

it.effect("preserves webhook request context and the full client cause chain", () => {
  const payload = buildDiscordReleaseAnnouncement(latestAnnouncement);
  const requestCause = new Error("request encoder unavailable");
  let clientError: HttpClientError.HttpClientError | undefined;
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      clientError = new HttpClientError.HttpClientError({
        reason: new HttpClientError.EncodeError({
          request,
          cause: requestCause,
        }),
      });
      return Effect.fail(clientError);
    }),
  );

  return Effect.gen(function* () {
    const error = yield* postDiscordWebhook(webhookUrl, payload, latestAnnouncement).pipe(
      Effect.provide(httpClientLayer),
      Effect.flip,
    );

    if (error._tag !== "DiscordReleaseWebhookRequestError") {
      assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.target, "latest");
    assert.equal(error.releaseName, latestAnnouncement.releaseName);
    assert.equal(error.version, latestAnnouncement.version);
    assert.equal(error.tag, latestAnnouncement.tag);
    assert.equal(error.releaseUrl, latestAnnouncement.releaseUrl.href);
    assert.equal(error.webhookOrigin, webhookUrl.origin);
    assert.equal(error.webhookPathnameSegmentCount, 4);
    assert.equal(error.contentLength, payload.content.length);
    assert.equal(error.embedCount, 1);
    assert.equal(error.allowedRoleMentionCount, 1);
    assert.equal(error.hasRoleMentionSyntax, true);
    assert.equal(error.cause, clientError);
    assert.equal((error.cause as HttpClientError.HttpClientError).cause, requestCause);
    assert.ok(!error.message.includes(requestCause.message));
    assert.equal(isDiscordReleaseAnnouncementError(error), true);
  });
});

it.effect("preserves a non-success response error with structured status context", () => {
  const payload = buildDiscordReleaseAnnouncement(latestAnnouncement);
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("invalid webhook", { status: 400 })),
      ),
    ),
  );

  return Effect.gen(function* () {
    const error = yield* postDiscordWebhook(webhookUrl, payload, latestAnnouncement).pipe(
      Effect.provide(httpClientLayer),
      Effect.flip,
    );

    if (error._tag !== "DiscordReleaseWebhookResponseError") {
      assert.fail(`Unexpected error: ${error._tag}`);
    }
    assert.equal(error.target, "latest");
    assert.equal(error.tag, latestAnnouncement.tag);
    assert.equal(error.webhookOrigin, webhookUrl.origin);
    assert.equal(error.webhookPathnameSegmentCount, 4);
    assert.equal(error.status, 400);
    if (!HttpClientError.isHttpClientError(error.cause)) {
      assert.fail("Expected HttpClientError cause");
    }
    assert.equal(error.cause.reason._tag, "StatusCodeError");
    assert.ok(!error.message.includes(error.cause.message));
    assert.equal(isDiscordReleaseAnnouncementError(error), true);
  });
});
