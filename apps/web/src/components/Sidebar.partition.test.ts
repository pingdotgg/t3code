import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import { partitionSidebarThreads, type SidebarThreadCapabilities } from "./Sidebar.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const now = "2026-03-10T10:00:00.000Z";

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const fullCapabilities: SidebarThreadCapabilities = {
  threadSettlement: true,
  threadSnooze: true,
  threadPinReorder: true,
};

function partition(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    capabilities?: SidebarThreadCapabilities | undefined;
    scopedProjectKeys?: ReadonlySet<string> | null;
  } = {},
) {
  return partitionSidebarThreads({
    threads,
    scopedProjectKeys: options.scopedProjectKeys ?? null,
    capabilitiesFor: () => ("capabilities" in options ? options.capabilities : fullCapabilities),
    preciseNow: now,
  });
}

const ids = (threads: ReadonlyArray<EnvironmentThreadShell>) => threads.map((thread) => thread.id);

describe("partitionSidebarThreads", () => {
  it("hides archived threads and threads outside the scoped project", () => {
    const result = partition(
      [
        makeThread("kept"),
        makeThread("archived", { archivedAt: now }),
        makeThread("elsewhere", { projectId: ProjectId.make("project-2") }),
      ],
      { scopedProjectKeys: new Set([`${environmentId}:${projectId}`]) },
    );
    expect(ids(result.activeThreads)).toEqual(["kept"]);
    expect(result.pinnedThreads).toEqual([]);
    expect(result.snoozedThreads).toEqual([]);
    expect(result.settledThreads).toEqual([]);
  });

  it("buckets snoozed over settled over pinned over active", () => {
    const result = partition([
      makeThread("active"),
      makeThread("pinned", { pinnedAt: now }),
      makeThread("settled", { settledOverride: "settled", settledAt: now, pinnedAt: now }),
      makeThread("snoozed", {
        snoozedUntil: "2026-03-11T10:00:00.000Z",
        settledOverride: "settled",
        settledAt: now,
        pinnedAt: now,
      }),
    ]);
    expect(ids(result.activeThreads)).toEqual(["active"]);
    expect(ids(result.pinnedThreads)).toEqual(["pinned"]);
    expect(ids(result.settledThreads)).toEqual(["settled"]);
    expect(ids(result.snoozedThreads)).toEqual(["snoozed"]);
    expect(result.snoozeNow).toBe(now);
  });

  it("keeps a woken snooze in the active list", () => {
    const result = partition([makeThread("woke", { snoozedUntil: "2026-03-10T09:00:00.000Z" })]);
    expect(ids(result.activeThreads)).toEqual(["woke"]);
    expect(result.settledThreads).toEqual([]);
    expect(result.snoozedThreads).toEqual([]);
  });

  it("never settles or snoozes threads on servers without the capability", () => {
    const result = partition(
      [
        makeThread("settled", { settledOverride: "settled", settledAt: now }),
        makeThread("snoozed", { snoozedUntil: "2026-03-11T10:00:00.000Z" }),
      ],
      { capabilities: undefined },
    );
    expect(ids(result.activeThreads).toSorted()).toEqual(["settled", "snoozed"]);
  });

  it("only marks pinned threads reorderable when the server supports it", () => {
    const withReorder = partition([makeThread("pinned", { pinnedAt: now })]);
    expect([...withReorder.reorderablePinnedKeys]).toEqual([`${environmentId}:pinned`]);

    const withoutReorder = partition([makeThread("pinned", { pinnedAt: now })], {
      capabilities: { threadSettlement: true, threadSnooze: true, threadPinReorder: false },
    });
    expect(ids(withoutReorder.pinnedThreads)).toEqual(["pinned"]);
    expect(withoutReorder.reorderablePinnedKeys.size).toBe(0);
  });
});
