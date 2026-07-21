import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as HashMap from "effect/HashMap";
import { describe, expect, it } from "vite-plus/test";

import {
  createEmptyCommandReadModel,
  findProjectById,
  findThreadById,
  fromWireReadModel,
  isThreadDeleted,
  listThreadsByProjectId,
} from "./commandReadModel.ts";

const now = "2026-01-01T00:00:00.000Z";

function makeThread(
  id: string,
  projectId: string,
  overrides?: Partial<OrchestrationThread>,
): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    latestTurn: null,
    messages: [],
    session: null,
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    deletedAt: null,
    ...overrides,
  };
}

const wireReadModel: OrchestrationReadModel = {
  snapshotSequence: 5,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    makeThread("thread-live", "project-a"),
    makeThread("thread-archived", "project-a", { archivedAt: now }),
    makeThread("thread-deleted", "project-a", { deletedAt: now }),
    makeThread("thread-other", "project-b"),
  ],
};

describe("commandReadModel", () => {
  it("creates an empty model", () => {
    const model = createEmptyCommandReadModel(now);
    expect(model.snapshotSequence).toBe(0);
    expect(HashMap.size(model.threads)).toBe(0);
    expect(HashMap.size(model.projects)).toBe(0);
    expect(model.updatedAt).toBe(now);
  });

  it("seeds from the wire model and drops deleted threads by default", () => {
    const model = fromWireReadModel(wireReadModel);
    expect(model.snapshotSequence).toBe(5);
    // deleted thread is evicted; archived + live + other retained
    expect(HashMap.size(model.threads)).toBe(3);
    expect(HashMap.has(model.threads, ThreadId.make("thread-deleted"))).toBe(false);
    expect(HashMap.has(model.threads, ThreadId.make("thread-archived"))).toBe(true);
    expect(HashMap.has(model.threads, ThreadId.make("thread-live"))).toBe(true);
    expect(HashMap.size(model.projects)).toBe(1);
    // The evicted deleted thread's id is retained so the create-twice invariant
    // survives a restart.
    expect(isThreadDeleted(model, ThreadId.make("thread-deleted"))).toBe(true);
    expect(isThreadDeleted(model, ThreadId.make("thread-live"))).toBe(false);
    expect(isThreadDeleted(model, ThreadId.make("thread-archived"))).toBe(false);
  });

  it("retains deleted threads when dropDeletedThreads is false", () => {
    const model = fromWireReadModel(wireReadModel, { dropDeletedThreads: false });
    expect(HashMap.size(model.threads)).toBe(4);
    expect(HashMap.has(model.threads, ThreadId.make("thread-deleted"))).toBe(true);
  });

  it("finds threads and projects by id with O(1) lookups", () => {
    const model = fromWireReadModel(wireReadModel);
    expect(findThreadById(model, ThreadId.make("thread-live"))?.projectId).toBe("project-a");
    expect(findThreadById(model, ThreadId.make("thread-deleted"))).toBeUndefined();
    expect(findThreadById(model, ThreadId.make("missing"))).toBeUndefined();
    expect(findProjectById(model, ProjectId.make("project-a"))?.title).toBe("Project A");
    expect(findProjectById(model, ProjectId.make("missing"))).toBeUndefined();
  });

  it("lists threads by project id", () => {
    const model = fromWireReadModel(wireReadModel);
    const ids = listThreadsByProjectId(model, ProjectId.make("project-a"))
      .map((thread) => thread.id)
      .toSorted();
    expect(ids).toEqual([ThreadId.make("thread-archived"), ThreadId.make("thread-live")]);
    expect(listThreadsByProjectId(model, ProjectId.make("project-b")).map((t) => t.id)).toEqual([
      ThreadId.make("thread-other"),
    ]);
  });
});
