import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
import {
  COORDINATOR_THREAD_TAG,
  findProjectCoordinator,
  projectAgentThreads,
} from "./projectCoordinator.logic";

const environmentId = EnvironmentId.make("environment-test");
const projectId = ProjectId.make("project-test");

function thread(id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}): Thread {
  return makeThreadFixture({ id: ThreadId.make(id), title: id, ...overrides });
}

function coordinator(id: string, overrides: Parameters<typeof makeThreadFixture>[0] = {}): Thread {
  const shell = thread(id, overrides);
  return { ...shell, source: { ...shell.source, tags: [COORDINATOR_THREAD_TAG] } };
}

describe("project coordinator", () => {
  it("picks the newest live tagged thread in the project", () => {
    const shells = [
      coordinator("older", { createdAt: "2026-11-01T00:00:00.000Z" }),
      coordinator("newer", { createdAt: "2026-11-02T00:00:00.000Z" }),
      coordinator("archived", {
        createdAt: "2026-11-03T00:00:00.000Z",
        archivedAt: "2026-11-04T00:00:00.000Z",
      }),
      coordinator("deleted", {
        createdAt: "2026-11-03T00:00:00.000Z",
        deletedAt: "2026-11-04T00:00:00.000Z",
      }),
      coordinator("other-project", {
        projectId: ProjectId.make("other"),
        createdAt: "2026-11-05T00:00:00.000Z",
      }),
      thread("untagged", { createdAt: "2026-11-06T00:00:00.000Z" }),
    ];
    expect(findProjectCoordinator(shells, environmentId, projectId)?.id).toBe("newer");
    expect(findProjectCoordinator(shells.slice(5), environmentId, projectId)).toBeNull();
  });

  it("lists the project's other threads by latest activity, without the coordinator or side chats", () => {
    const shells = [
      coordinator("coordinator", { updatedAt: "2026-11-09T00:00:00.000Z" }),
      thread("stale", { updatedAt: "2026-11-01T00:00:00.000Z" }),
      thread("fresh", { updatedAt: "2026-11-08T00:00:00.000Z" }),
      thread("side-chat", {
        updatedAt: "2026-11-07T00:00:00.000Z",
        lineage: {
          rootThreadId: ThreadId.make("fresh"),
          parentThreadId: ThreadId.make("fresh"),
          relationshipToParent: "fork",
          sideChat: true,
        },
      }),
      thread("elsewhere", { environmentId: EnvironmentId.make("remote") }),
    ];
    expect(projectAgentThreads(shells, environmentId, projectId).map((shell) => shell.id)).toEqual([
      "fresh",
      "stale",
    ]);
  });
});
