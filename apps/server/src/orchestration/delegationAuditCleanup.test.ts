import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import { deriveDelegationCleanupIntents } from "./delegationAuditCleanup.ts";

const event = (
  sequence: number,
  eventType:
    | "thread.created"
    | "thread.delete.requested"
    | "thread.deletion.accepted"
    | "cleanup.completed",
  payload: unknown,
): Parameters<typeof deriveDelegationCleanupIntents>[0][number] => ({
  sequence,
  eventId: EventId.make(`event-${sequence}`),
  operationId: "operation",
  attemptId: "attempt",
  sourceThreadId: ThreadId.make("source"),
  sourceTurnId: null,
  sourceMessageId: null,
  childThreadId: ThreadId.make("child"),
  eventType,
  occurredAt: "2026-09-27T00:00:00.000Z",
  evidenceStatus: "complete",
  redacted: false,
  context: {
    authorization: {
      sourceThreadId: ThreadId.make("source"),
      sourceTurnId: null,
      initiatingMessageId: null,
      scope: "orchestration:operate",
    },
    toolName: "delegate_work",
    toolVersion: "1",
    toolCallId: "call",
    providerInstanceId: null,
    model: null,
    workspaceRoot: null,
    gitRevision: null,
    buildRevision: "build",
  },
  payload,
});

it("keeps the newest applicable cleanup intent for each attempt", () => {
  const attempts = deriveDelegationCleanupIntents([
    event(9, "thread.deletion.accepted", { cleanupWorktree: false }),
    event(7, "thread.created", { worktreePath: null }),
    event(6, "thread.created", { worktreePath: null }),
    event(3, "thread.deletion.accepted", { cleanupWorktree: true }),
  ]);

  assert.deepStrictEqual(attempts, [
    {
      attemptId: "attempt",
      childThreadId: ThreadId.make("child"),
      cleanupRequested: false,
    },
  ]);
});

it("keeps cleanup intent unknown when a page contains no deletion intent", () => {
  const attempts = deriveDelegationCleanupIntents([event(4, "thread.created", {})]);

  assert.deepStrictEqual(attempts, [
    {
      attemptId: "attempt",
      childThreadId: ThreadId.make("child"),
      cleanupRequested: null,
    },
  ]);
});

it("preserves an explicit no-worktree deletion decision", () => {
  const attempts = deriveDelegationCleanupIntents([
    event(9, "thread.deletion.accepted", { cleanupWorktree: false }),
    event(4, "thread.delete.requested", { cleanupWorktree: true }),
  ]);

  assert.deepStrictEqual(attempts, [
    {
      attemptId: "attempt",
      childThreadId: ThreadId.make("child"),
      cleanupRequested: false,
    },
  ]);
});

it("treats an observed cleanup transition as explicit cleanup intent", () => {
  const attempts = deriveDelegationCleanupIntents([
    event(8, "cleanup.completed", {}),
    event(4, "thread.deletion.accepted", { cleanupWorktree: false }),
  ]);

  assert.deepStrictEqual(attempts, [
    {
      attemptId: "attempt",
      childThreadId: ThreadId.make("child"),
      cleanupRequested: true,
    },
  ]);
});
