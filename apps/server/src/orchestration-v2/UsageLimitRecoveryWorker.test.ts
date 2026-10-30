import { assert, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, RunId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const stoppedAt = "2026-10-18T10:00:00.000Z";
const resetAt = "2026-10-18T11:00:00.000Z";
const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
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
    expect(
      UsageLimitRecoveryWorker.limitRecoveryCommand(armed, true, Date.parse(resetAt) - 1),
    ).toBeNull();
    const resume = UsageLimitRecoveryWorker.limitRecoveryCommand(armed, true, Date.parse(resetAt));
    expect(resume).toMatchObject({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      usageLimitContinuationOfRunId: candidate.latestRunId,
      text: "Continue where you left off.",
    });
    expect(resume?.commandId).toEqual(
      UsageLimitRecoveryWorker.limitRecoveryCommand(armed, true, Date.parse(resetAt) + 1)
        ?.commandId,
    );
  });
});
