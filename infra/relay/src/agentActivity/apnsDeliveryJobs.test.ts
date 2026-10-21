import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import {
  makeApnsDeliveryJobPayload,
  signApnsDeliveryJob,
  verifySignedApnsDeliveryJob,
} from "./apnsDeliveryJobs.ts";

const secret = Redacted.make("queue-signing-secret");

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
      _tag: "ApnsDeliveryJobSignatureInvalid",
      jobId: "job-1",
      kind: "live_activity_end",
      userId: "user-1",
      deviceId: "device-1",
      message: "Invalid signature for APNs delivery job job-1.",
    });
  });
});
