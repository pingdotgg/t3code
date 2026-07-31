import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { resolveThreadLifecycleSupport, selectSnoozeShelfBulkTargets } from "./SidebarV2.logic";
import { DEFAULT_INTERACTION_MODE, type SidebarThreadSummary } from "../types";

const now = "2026-01-01T12:00:00.000Z";
const capableEnvironmentId = EnvironmentId.make("environment-capable");
const staleEnvironmentId = EnvironmentId.make("environment-stale");

function descriptor(
  environmentId: EnvironmentId,
  capabilities: { threadSettlement: boolean; threadSnooze: boolean },
): ExecutionEnvironmentDescriptor {
  return { environmentId, capabilities } as unknown as ExecutionEnvironmentDescriptor;
}

function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(`thread-${Math.random()}`),
    environmentId: capableEnvironmentId,
    projectId: ProjectId.make("project-1"),
    parentThreadId: null,
    title: "Thread",
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("resolveThreadLifecycleSupport", () => {
  it("keeps each environment's capabilities independent", () => {
    const support = resolveThreadLifecycleSupport([
      descriptor(capableEnvironmentId, { threadSettlement: true, threadSnooze: true }),
      descriptor(staleEnvironmentId, { threadSettlement: false, threadSnooze: false }),
    ]);

    expect(support.get(capableEnvironmentId)).toEqual({ settlement: true, snooze: true });
    expect(support.get(staleEnvironmentId)).toEqual({ settlement: false, snooze: false });
  });

  it("ignores absent descriptors and reports unknown environments as unsupported", () => {
    const support = resolveThreadLifecycleSupport([null, undefined]);

    expect(support.get(capableEnvironmentId)).toBeUndefined();
  });
});

describe("selectSnoozeShelfBulkTargets", () => {
  const lifecycleSupport = resolveThreadLifecycleSupport([
    descriptor(capableEnvironmentId, { threadSettlement: true, threadSnooze: true }),
    descriptor(staleEnvironmentId, { threadSettlement: false, threadSnooze: false }),
  ]);

  it("excludes threads whose environment cannot snooze", () => {
    const capable = thread();
    const stale = thread({ environmentId: staleEnvironmentId });

    const targets = selectSnoozeShelfBulkTargets({
      snoozed: [capable, stale],
      lifecycleSupport,
      now,
    });

    expect(targets.wakeable).toEqual([capable]);
    expect(targets.reschedulable).toEqual([capable]);
  });

  it("keeps blocked-on-you threads wakeable but not reschedulable", () => {
    const quiet = thread();
    const awaitingApproval = thread({ hasPendingApprovals: true });
    const awaitingInput = thread({ hasPendingUserInput: true });

    const targets = selectSnoozeShelfBulkTargets({
      snoozed: [quiet, awaitingApproval, awaitingInput],
      lifecycleSupport,
      now,
    });

    expect(targets.wakeable).toEqual([quiet, awaitingApproval, awaitingInput]);
    expect(targets.reschedulable).toEqual([quiet]);
  });

  it("excludes a thread whose queued turn has not started yet", () => {
    const queued = thread({ latestUserMessageAt: "2026-01-01T11:59:00.000Z" });

    const targets = selectSnoozeShelfBulkTargets({
      snoozed: [queued],
      lifecycleSupport,
      now,
    });

    expect(targets.wakeable).toEqual([queued]);
    expect(targets.reschedulable).toEqual([]);
  });
});
