import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { makeLiveActivityRequest, makePushNotificationRequest } from "./apns.ts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

describe("makeLiveActivityRequest", () => {
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

  it("requests an update push token when remotely starting a Live Activity", () => {
    const request = makeLiveActivityRequest({
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
  });

  it("builds a low-priority update payload", () => {
    const request = makeLiveActivityRequest({
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
  });

  it("builds an end payload with a dismissal date", () => {
    const request = makeLiveActivityRequest({
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
  });

  it("builds a standard APNs alert payload with routing metadata", () => {
    const request = makePushNotificationRequest({
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
  });
});
