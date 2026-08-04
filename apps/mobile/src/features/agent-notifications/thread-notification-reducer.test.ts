import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createThreadNotificationState,
  reduceThreadNotifications,
} from "./thread-notification-reducer";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function shell(
  id: string,
  input: {
    readonly turnId?: string;
    readonly turnState?: "pending" | "running" | "completed" | "interrupted" | "error";
    readonly completedAt?: string | null;
    readonly sessionStatus?: "starting" | "running" | "ready" | "error";
    readonly sessionUpdatedAt?: string;
    readonly hasPendingApprovals?: boolean;
    readonly hasPendingUserInput?: boolean;
    readonly updatedAt?: string;
  } = {},
): EnvironmentThreadShell {
  const updatedAt = input.updatedAt ?? "2026-08-02T00:00:00.000Z";
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: `Thread ${id}`,
    updatedAt,
    latestTurn:
      input.turnId === undefined
        ? null
        : {
            turnId: TurnId.make(input.turnId),
            state: input.turnState ?? "running",
            requestedAt: "2026-08-02T00:00:00.000Z",
            startedAt: "2026-08-02T00:00:01.000Z",
            completedAt: input.completedAt ?? null,
            assistantMessageId: null,
          },
    session:
      input.sessionStatus === undefined
        ? null
        : {
            status: input.sessionStatus,
            updatedAt: input.sessionUpdatedAt ?? updatedAt,
          },
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
  } as EnvironmentThreadShell;
}

describe("thread notification reducer", () => {
  it("seeds initial hydration without notifying for existing terminal or attention states", () => {
    const result = reduceThreadNotifications(createThreadNotificationState(), [
      shell("completed", {
        turnId: "turn-completed",
        turnState: "completed",
        completedAt: "2026-08-02T00:00:04.000Z",
      }),
      shell("approval", { hasPendingApprovals: true }),
    ]);

    expect(result.events).toEqual([]);
  });

  it("emits one completion when an observed turn completes", () => {
    const seeded = reduceThreadNotifications(createThreadNotificationState(), [
      shell("task", { turnId: "turn-1", turnState: "running" }),
    ]).state;
    const completed = shell("task", {
      turnId: "turn-1",
      turnState: "completed",
      completedAt: "2026-08-02T00:00:04.000Z",
      updatedAt: "2026-08-02T00:00:04.000Z",
    });

    const first = reduceThreadNotifications(seeded, [completed]);
    const repeated = reduceThreadNotifications(first.state, [completed]);

    expect(first.events).toEqual([
      expect.objectContaining({
        id: "environment-1:task:completed:turn-1",
        kind: "completed",
        environmentId,
        threadId: ThreadId.make("task"),
        threadTitle: "Thread task",
      }),
    ]);
    expect(repeated.events).toEqual([]);
  });

  it("emits failure once and does not duplicate the same failure from session and turn state", () => {
    const seeded = reduceThreadNotifications(createThreadNotificationState(), [
      shell("task", { turnId: "turn-1", turnState: "running", sessionStatus: "running" }),
    ]).state;
    const failed = shell("task", {
      turnId: "turn-1",
      turnState: "error",
      completedAt: "2026-08-02T00:00:04.000Z",
      sessionStatus: "error",
      sessionUpdatedAt: "2026-08-02T00:00:04.000Z",
      updatedAt: "2026-08-02T00:00:04.000Z",
    });

    const result = reduceThreadNotifications(seeded, [failed]);

    expect(result.events).toEqual([
      expect.objectContaining({ id: "environment-1:task:failed:turn-1", kind: "failed" }),
    ]);
  });

  it("emits approval and user-input edges without repeating unchanged flags", () => {
    const seeded = reduceThreadNotifications(createThreadNotificationState(), [
      shell("task"),
    ]).state;
    const approval = reduceThreadNotifications(seeded, [
      shell("task", { hasPendingApprovals: true, updatedAt: "2026-08-02T00:00:02.000Z" }),
    ]);
    const approvalRepeated = reduceThreadNotifications(approval.state, [
      shell("task", { hasPendingApprovals: true, updatedAt: "2026-08-02T00:00:02.000Z" }),
    ]);
    const cleared = reduceThreadNotifications(approvalRepeated.state, [shell("task")]);
    const input = reduceThreadNotifications(cleared.state, [
      shell("task", { hasPendingUserInput: true, updatedAt: "2026-08-02T00:00:05.000Z" }),
    ]);

    expect(approval.events.map((event) => event.kind)).toEqual(["approval-required"]);
    expect(approvalRepeated.events).toEqual([]);
    expect(input.events.map((event) => event.kind)).toEqual(["user-input-required"]);
  });

  it("notifies a newly observed completed turn on a known thread after reconnect catch-up", () => {
    const seeded = reduceThreadNotifications(createThreadNotificationState(), [
      shell("task", {
        turnId: "turn-old",
        turnState: "completed",
        completedAt: "2026-08-02T00:00:01.000Z",
      }),
    ]).state;

    const result = reduceThreadNotifications(seeded, [
      shell("task", {
        turnId: "turn-new",
        turnState: "completed",
        completedAt: "2026-08-02T00:00:08.000Z",
        updatedAt: "2026-08-02T00:00:08.000Z",
      }),
    ]);

    expect(result.events.map((event) => event.id)).toEqual([
      "environment-1:task:completed:turn-new",
    ]);
  });

  it("forgets deleted shells without notifying if the identifier is later reused", () => {
    const seeded = reduceThreadNotifications(createThreadNotificationState(), [
      shell("task", { turnId: "turn-1", turnState: "running" }),
    ]).state;
    const removed = reduceThreadNotifications(seeded, []);
    const recreated = reduceThreadNotifications(removed.state, [
      shell("task", {
        turnId: "turn-2",
        turnState: "completed",
        completedAt: "2026-08-02T00:00:08.000Z",
      }),
    ]);

    expect(removed.events).toEqual([]);
    expect(recreated.events).toEqual([]);
  });

  it("does not duplicate a terminal event after an out-of-order rollback snapshot", () => {
    const seeded = reduceThreadNotifications(createThreadNotificationState(), [
      shell("task", { turnId: "turn-1", turnState: "running" }),
    ]).state;
    const completedShell = shell("task", {
      turnId: "turn-1",
      turnState: "completed",
      completedAt: "2026-08-02T00:00:04.000Z",
      updatedAt: "2026-08-02T00:00:04.000Z",
    });
    const completed = reduceThreadNotifications(seeded, [completedShell]);
    const staleRunning = reduceThreadNotifications(completed.state, [
      shell("task", {
        turnId: "turn-1",
        turnState: "running",
        updatedAt: "2026-08-02T00:00:03.000Z",
      }),
    ]);
    const replayedCompletion = reduceThreadNotifications(staleRunning.state, [completedShell]);

    expect(completed.events).toHaveLength(1);
    expect(replayedCompletion.events).toEqual([]);
  });

  it("honors persisted event ids after a process restart", () => {
    const eventId = "environment-1:task:completed:turn-1";
    const seeded = reduceThreadNotifications(createThreadNotificationState([eventId]), [
      shell("task", { turnId: "turn-1", turnState: "running" }),
    ]).state;
    const result = reduceThreadNotifications(seeded, [
      shell("task", {
        turnId: "turn-1",
        turnState: "completed",
        completedAt: "2026-08-02T00:00:04.000Z",
      }),
    ]);

    expect(result.events).toEqual([]);
  });
});
