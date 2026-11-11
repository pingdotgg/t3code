import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scheduledTaskDestinationThreads } from "./scheduledTaskDestinations.ts";

const environmentId = EnvironmentId.make("env-scheduled");
const projectId = ProjectId.make("project-scheduled");
const parentId = ThreadId.make("parent");

type Candidate = Parameters<typeof scheduledTaskDestinationThreads>[0][number];

function shell(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title: id,
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
    parentThreadId: null,
    parentRelationship: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

const childLineage = {
  rootThreadId: parentId,
  parentThreadId: parentId,
  relationshipToParent: "subagent" as const,
};

describe("scheduledTaskDestinationThreads", () => {
  it("lists delegated child chats and hides subagents, side chats, and the current thread", () => {
    const threads = [
      shell("parent", { updatedAt: "2026-11-03T00:00:00.000Z" }),
      // A delegated child keeps the provider's subagent lineage but is its own chat.
      shell("delegated-child", {
        parentThreadId: parentId,
        parentRelationship: "child",
        lineage: childLineage,
        updatedAt: "2026-11-02T00:00:00.000Z",
      }),
      shell("subagent", {
        parentThreadId: parentId,
        parentRelationship: "subagent",
        lineage: childLineage,
      }),
      shell("side-chat", {
        lineage: { ...childLineage, relationshipToParent: null, sideChat: true },
      }),
      shell("current"),
    ];

    expect(
      scheduledTaskDestinationThreads(threads, {
        environmentId,
        projectId,
        currentThreadId: ThreadId.make("current"),
        query: "",
      }).map((thread) => thread.id),
    ).toEqual(["parent", "delegated-child"]);
  });
});
