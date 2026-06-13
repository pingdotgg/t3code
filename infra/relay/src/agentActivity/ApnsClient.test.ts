import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as ApnsClient from "./ApnsClient.ts";

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
});
