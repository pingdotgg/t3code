import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import * as Redacted from "effect/Redacted";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  verifySignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";

const secret = Redacted.make("queue-signing-secret");
const aggregate: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-05-25T00:00:00.000Z",
  activities: [
    {
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      projectTitle: "Project",
      threadTitle: "Thread",
      modelTitle: "gpt-5.4",
      phase: "running",
      status: "Working",
      updatedAt: "2026-05-25T00:00:00.000Z",
      deepLink: "/threads/env/thread",
    },
  ],
};

const notification = {
  title: "Thread",
  body: "Input: Project",
  environmentId: "env",
  threadId: "thread",
  deepLink: "/threads/env/thread",
};

describe("apnsDeliveryJobs", () => {
  it("rejects tampered signed queue jobs", () => {
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_end",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate: null,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-1",
    });
    const signed = signApnsDeliveryJob({ secret, payload });
    const tampered = {
      ...signed,
      payload: {
        ...signed.payload,
        target: {
          ...signed.payload.target,
          token: "attacker-token",
        },
      },
    };

    const result = verifySignedApnsDeliveryJob({
      secret,
      job: tampered,
      nowMs: 0,
    });

    expect(result).toMatchObject({
      _tag: "ApnsDeliveryJobInvalid",
    });
  });

  it("rejects Live Activity start jobs without aggregate state", () => {
    const payload = makeApnsDeliveryJobPayload({
      kind: "live_activity_start",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate: null,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-start-invalid",
    });
    const signed = signApnsDeliveryJob({ secret, payload });

    const result = verifySignedApnsDeliveryJob({
      secret,
      job: signed,
      nowMs: 0,
    });

    expect(result).toMatchObject({
      _tag: "ApnsDeliveryJobInvalid",
      message: "Live Activity start/update jobs require an aggregate.",
    });
  });

  it("rejects push notification jobs carrying aggregate state", () => {
    const payload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate,
      notification,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-push-invalid",
    });
    const signed = signApnsDeliveryJob({ secret, payload });

    const result = verifySignedApnsDeliveryJob({
      secret,
      job: signed,
      nowMs: 0,
    });

    expect(result).toMatchObject({
      _tag: "ApnsDeliveryJobInvalid",
      message: "Push notification jobs must not carry aggregate state.",
    });
  });

  it("accepts minimal kind-specific signed queue jobs", () => {
    const pushPayload = makeApnsDeliveryJobPayload({
      kind: "push_notification",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate: null,
      notification,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-push-valid",
    });
    const liveActivityPayload = makeApnsDeliveryJobPayload({
      kind: "live_activity_update",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:05:00.000Z",
      jobId: "job-live-valid",
    });

    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload: pushPayload }),
        nowMs: 0,
      }),
    ).toEqual(pushPayload);
    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload: liveActivityPayload }),
        nowMs: 0,
      }),
    ).toEqual(liveActivityPayload);
  });

  it("rejects jobs with invalid or overlong time windows", () => {
    const basePayload = makeApnsDeliveryJobPayload({
      kind: "live_activity_end",
      userId: "user-1",
      deviceId: "device-1",
      token: "token-1",
      aggregate: null,
      createdAt: "2026-05-25T00:00:00.000Z",
      expiresAt: "2026-05-25T00:10:00.000Z",
      jobId: "job-window",
    });
    const invalidCreatedAt = {
      ...basePayload,
      createdAt: "not-a-date",
    };
    const invertedWindow = {
      ...basePayload,
      expiresAt: "2026-05-24T23:59:59.000Z",
    };
    const overlongWindow = {
      ...basePayload,
      expiresAt: "2026-05-25T00:10:01.000Z",
    };

    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload: invalidCreatedAt }),
        nowMs: 0,
      }),
    ).toMatchObject({
      _tag: "ApnsDeliveryJobInvalid",
      message: "Invalid APNs delivery job creation time.",
    });
    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload: invertedWindow }),
        nowMs: 0,
      }),
    ).toMatchObject({
      _tag: "ApnsDeliveryJobInvalid",
      message: "Invalid APNs delivery job time window.",
    });
    expect(
      verifySignedApnsDeliveryJob({
        secret,
        job: signApnsDeliveryJob({ secret, payload: overlongWindow }),
        nowMs: 0,
      }),
    ).toMatchObject({
      _tag: "ApnsDeliveryJobInvalid",
      message: "APNs delivery job time window is too long.",
    });
  });
});
