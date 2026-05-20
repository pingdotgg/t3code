import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vitest";

import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";

import { createShellSnapshotManager } from "./shellSnapshotState.ts";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

const BASE_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: "2026-04-01T00:00:00.000Z",
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
};

const TARGET = { environmentId: EnvironmentId.make("env-local") } as const;

describe("createShellSnapshotManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("starts pending when marked pending", () => {
    const manager = createShellSnapshotManager({
      getRegistry: () => atomRegistry,
    });

    manager.markPending(TARGET);

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      isPending: true,
    });
  });

  it("stores snapshots", () => {
    const manager = createShellSnapshotManager({
      getRegistry: () => atomRegistry,
    });

    manager.syncSnapshot(TARGET, BASE_SNAPSHOT);

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: BASE_SNAPSHOT,
      error: null,
      isPending: false,
    });
  });

  it("applies incremental shell events", () => {
    const manager = createShellSnapshotManager({
      getRegistry: () => atomRegistry,
    });
    const existingThread = BASE_SNAPSHOT.threads[0]!;

    manager.syncSnapshot(TARGET, BASE_SNAPSHOT);
    manager.applyEvent(TARGET, {
      kind: "thread-upserted",
      sequence: 2,
      thread: {
        ...existingThread,
        title: "Renamed thread",
      },
    });

    expect(manager.getSnapshot(TARGET).data?.threads[0]?.title).toBe("Renamed thread");
    expect(manager.getSnapshot(TARGET).data?.snapshotSequence).toBe(2);
  });

  it("invalidates per environment", () => {
    const manager = createShellSnapshotManager({
      getRegistry: () => atomRegistry,
    });

    manager.syncSnapshot(TARGET, BASE_SNAPSHOT);
    manager.invalidate(TARGET);

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      isPending: false,
    });
  });
});
