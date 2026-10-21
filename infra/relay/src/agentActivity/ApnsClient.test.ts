// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { ApnsCredentials } from "../Config.ts";
import * as ApnsClient from "./ApnsClient.ts";
import { sanitizeApnsNotificationPayload } from "./agentActivityPayloads.ts";
import * as ApnsProviderTokens from "./ApnsProviderTokens.ts";

const layerTest = ApnsClient.layer.pipe(
  Layer.provide(ApnsProviderTokens.layer),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("unexpected APNs HTTP request")),
    ),
  ),
);

describe("ApnsClient", () => {
  const now = DateTime.makeUnsafe(0);
  const state: RelayAgentActivityAggregateState = {
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: 1,
    updatedAt: DateTime.formatIso(now),
    activities: [
      {
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("thread"),
        projectTitle: "Project",
        threadTitle: "Thread",
        modelTitle: "gpt-5.4",
        phase: "running" as const,
        status: "Working",
        updatedAt: DateTime.formatIso(now),
        deepLink: "/",
      },
    ],
  };

  it.effect("requests an update push token when remotely starting a Live Activity", () =>
    Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makeLiveActivityRequest({
        event: "start",
        token: "token",
        state,
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        nowIso: DateTime.formatIso(now),
      });

      expect(request.priority).toBe("10");
      expect(request.payload).toMatchObject({
        aps: {
          event: "start",
          "attributes-type": "LiveActivityAttributes",
          "input-push-token": 1,
          "content-state": {
            name: "AgentActivity",
          },
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("builds a high-priority alerting update payload when an alert is attached", () =>
    Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makeLiveActivityRequest({
        event: "update",
        token: "token",
        state,
        alert: { title: "Thread", body: "Approval: Project" },
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        nowIso: DateTime.formatIso(now),
      });

      expect(request.priority).toBe("10");
      expect(request.payload).toMatchObject({
        aps: {
          event: "update",
          alert: {
            title: "Thread",
            body: "Approval: Project",
            sound: "default",
          },
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("builds an end payload with a dismissal date", () =>
    Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makeLiveActivityRequest({
        event: "end",
        token: "token",
        state,
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        nowIso: DateTime.formatIso(now),
      });

      expect(request.priority).toBe("10");
      expect(request.payload).toMatchObject({
        aps: {
          event: "end",
          "dismissal-date": 300,
        },
      });

      const contentless = apns.makeLiveActivityRequest({
        event: "end",
        token: "token",
        state: null,
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        nowIso: DateTime.formatIso(now),
      });
      expect(contentless.payload).toMatchObject({
        aps: {
          event: "end",
          "dismissal-date": 15,
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("puts remote routing metadata only in Expo's body field", () =>
    Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makePushNotificationRequest({
        token: "push-token",
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env",
          threadId: "thread",
          deepLink: "/threads/env/thread",
        },
      });

      expect(request.priority).toBe("10");
      expect(request.payload).toEqual({
        aps: {
          alert: {
            title: "Thread",
            body: "Input: Project",
          },
          sound: "default",
          "thread-id": "env/thread",
        },
        body: {
          environmentId: "env",
          threadId: "thread",
          deepLink: "/threads/env/thread",
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fits long routing metadata and multibyte alerts within the APNs 4096-byte limit", () =>
    Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const environmentId = "é".repeat(191);
      const threadId = "t".repeat(512);
      const notification = sanitizeApnsNotificationPayload({
        title: "界".repeat(120),
        body: "界".repeat(120),
        environmentId,
        threadId,
        deepLink: `/threads/${encodeURIComponent(environmentId)}/${threadId}`,
      });
      const request = apns.makePushNotificationRequest({ token: "push-token", notification });

      expect(
        new TextEncoder().encode(JSON.stringify(request.payload)).byteLength,
      ).toBeLessThanOrEqual(4096);
      expect(request.payload).toMatchObject({
        body: {
          environmentId,
          threadId,
          deepLink: notification.deepLink,
        },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reuses the signed provider JWT across pushes within the reuse window", () => {
    ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const credentials = {
      teamId: "team-jwt-cache",
      keyId: "key-jwt-cache",
      privateKey: Redacted.make(privateKey),
      bundleId: "com.t3tools.test",
      environment: "sandbox",
    } satisfies ApnsCredentials;
    const authorizations: Array<string> = [];
    const capturingHttpClient = HttpClient.make((request) => {
      authorizations.push(request.headers.authorization ?? "");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("", { status: 200, headers: { "apns-id": "apns-id-1" } }),
        ),
      );
    });
    const layer = ApnsClient.layer.pipe(
      Layer.provide(ApnsProviderTokens.layer),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, capturingHttpClient)),
    );

    return Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makePushNotificationRequest({
        token: "push-token",
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env",
          threadId: "thread",
          deepLink: "/threads/env/thread",
        },
      });
      const send = (issuedAtUnixSeconds: number) =>
        apns.sendPushNotificationRequest({ credentials, request, issuedAtUnixSeconds });

      const window = ApnsProviderTokens.APNS_JWT_REUSE_SECONDS;
      yield* send(window + 10);
      yield* send(window * 2 - 1);
      yield* send(window * 2);

      expect(authorizations).toHaveLength(3);
      expect(authorizations[1]).toBe(authorizations[0]);
      expect(authorizations[2]).not.toBe(authorizations[0]);
      ApnsProviderTokens.__resetApnsProviderTokenCacheForTest();
    }).pipe(Effect.provide(layer));
  });
});
