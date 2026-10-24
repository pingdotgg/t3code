import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const stoppedAt = "2026-10-18T10:00:00.000Z";
const resetAt = "2026-10-18T11:00:00.000Z";
const candidate: ProjectionLimitRecoveryCandidate = {
  id: ThreadId.make("quota-test"),
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("stopped-run"),
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: "active",
  pendingRuntimeRequest: null,
  latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
  updatedAt: DateTime.makeUnsafe(stoppedAt),
  limitRecovery: null,
  snoozedUntil: null,
};

describe("quota reset continuation provenance", () => {
  it("attributes reset continuations to T3 while preserving the original recovery identity", () => {
    const armed = {
      ...candidate,
      limitRecovery: { runId: candidate.latestRunId!, resetAt, autoResume: true, snooze: true },
    };
    expect(limitRecoveryCommand(armed, true, Date.parse(resetAt) - 1)).toBeNull();
    const resume = limitRecoveryCommand(armed, true, Date.parse(resetAt));
    expect(resume).toMatchObject({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      usageLimitContinuationOfRunId: candidate.latestRunId,
      text: "Continue where you left off.",
    });
    expect(resume?.commandId).toEqual(
      limitRecoveryCommand(armed, true, Date.parse(resetAt) + 1)?.commandId,
    );
  });
});
