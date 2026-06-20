import * as NodeCrypto from "node:crypto";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import type { ApnsCredentials } from "../Config.ts";
import * as ApnsClient from "./ApnsClient.ts";

const isApnsJwtSigningError = Schema.is(ApnsClient.ApnsJwtSigningError);
const isApnsHttpRequestError = Schema.is(ApnsClient.ApnsHttpRequestError);

const TestLayer = ApnsClient.layer.pipe(
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("builds a low-priority update payload", () =>
    Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makeLiveActivityRequest({
        event: "update",
        token: "token",
        state,
        nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        nowIso: DateTime.formatIso(now),
      });

      expect(request.priority).toBe("5");
      expect(request.payload).toMatchObject({
        aps: {
          event: "update",
          "content-state": {
            name: "AgentActivity",
          },
        },
      });
    }).pipe(Effect.provide(TestLayer)),
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("builds a standard APNs alert payload with routing metadata", () =>
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
      expect(request.payload).toMatchObject({
        aps: {
          alert: {
            title: "Thread",
            body: "Input: Project",
          },
          sound: "default",
        },
        environmentId: "env",
        threadId: "thread",
        deepLink: "/threads/env/thread",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves JWT signing context and the crypto cause", () =>
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
      const error = yield* Effect.flip(
        apns.sendPushNotificationRequest({
          credentials: {
            teamId: "team-1",
            keyId: "key-1",
            privateKey: Redacted.make("not-a-private-key"),
            bundleId: "com.t3tools.test",
            environment: "sandbox",
          },
          request,
          issuedAtUnixSeconds: 123,
        }),
      );

      expect(isApnsJwtSigningError(error)).toBe(true);
      if (!isApnsJwtSigningError(error)) {
        return yield* Effect.die("expected APNs JWT signing error");
      }
      expect(error).toMatchObject({
        teamId: "team-1",
        keyId: "key-1",
        issuedAtUnixSeconds: 123,
        cause: expect.any(Error),
        message: "Failed to sign APNs JWT for key key-1.",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves APNs request context and the HTTP cause", () => {
    const httpCause = new Error("network unavailable");
    const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const credentials = {
      teamId: "team-1",
      keyId: "key-1",
      privateKey: Redacted.make(privateKey),
      bundleId: "com.t3tools.test",
      environment: "sandbox",
    } satisfies ApnsCredentials;
    const failingHttpClient = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: httpCause }),
        }),
      ),
    );
    const layer = ApnsClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, failingHttpClient)),
    );

    return Effect.gen(function* () {
      const apns = yield* ApnsClient.ApnsClient;
      const request = apns.makePushNotificationRequest({
        token: "long-push-token",
        notification: {
          title: "Thread",
          body: "Input: Project",
          environmentId: "env",
          threadId: "thread",
          deepLink: "/threads/env/thread",
        },
      });
      const error = yield* Effect.flip(
        apns.sendPushNotificationRequest({
          credentials,
          request,
          issuedAtUnixSeconds: 123,
        }),
      );

      expect(isApnsHttpRequestError(error)).toBe(true);
      if (!isApnsHttpRequestError(error)) {
        return yield* Effect.die("expected APNs HTTP request error");
      }
      expect(error).toMatchObject({
        requestKind: "push-notification",
        event: null,
        environment: "sandbox",
        bundleId: "com.t3tools.test",
        tokenSuffix: "sh-token",
        stage: "send",
        status: null,
        message: "APNs push-notification request failed during send in sandbox.",
      });
      expect(error.cause).toBeInstanceOf(HttpClientError.HttpClientError);
      expect((error.cause as HttpClientError.HttpClientError).reason).toMatchObject({
        _tag: "TransportError",
        cause: httpCause,
      });
    }).pipe(Effect.provide(layer));
  });
});
