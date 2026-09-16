import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

import { ThreadCliUsageError, resolveThreadCliTarget, resolveThreadCliWakeTime } from "./thread.ts";

const THREAD_ID = ThreadId.make("thread-1");
const snapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestTurn: null,
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
  updatedAt: "2026-09-16T00:00:00.000Z",
};

it("resolves the current T3 thread from the agent environment", () => {
  const thread = resolveThreadCliTarget(snapshot, undefined, { T3_THREAD_ID: THREAD_ID });
  assert.strictEqual(thread.id, THREAD_ID);
});

it("prefers an explicit thread id over the agent environment", () => {
  const thread = resolveThreadCliTarget(snapshot, THREAD_ID, { T3_THREAD_ID: "other-thread" });
  assert.strictEqual(thread.id, THREAD_ID);
});

it("requires a target thread", () => {
  assert.throws(() => resolveThreadCliTarget(snapshot, undefined, {}), ThreadCliUsageError);
});

it("computes a future wake time from a duration", () => {
  const wake = resolveThreadCliWakeTime({
    duration: Duration.days(10),
    until: undefined,
    now: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
  });
  assert.strictEqual(wake, "2026-09-26T00:00:00.000Z");
});

it("requires exactly one wake-time option", () => {
  assert.throws(
    () =>
      resolveThreadCliWakeTime({
        duration: Duration.hours(1),
        until: "2026-09-17T00:00:00.000Z",
        now: DateTime.makeUnsafe("2026-09-16T00:00:00.000Z"),
      }),
    ThreadCliUsageError,
  );
});
