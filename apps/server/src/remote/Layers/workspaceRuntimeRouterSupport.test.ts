import path from "node:path";

import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeWorkspaceRuntimeRoutingSupport } from "./workspaceRuntimeRouterSupport.ts";

const localProjectId = ProjectId.makeUnsafe("project-local");
const remoteProjectId = ProjectId.makeUnsafe("project-remote");
const remoteThreadId = ThreadId.makeUnsafe("thread-remote");

function makeSupport() {
  return makeWorkspaceRuntimeRoutingSupport({
    orchestrationEngine: {
      getReadModel: () =>
        Effect.succeed({
          projects: [
            {
              id: localProjectId,
              workspaceRoot: "/workspace/local-app",
              executionTarget: "local",
              remoteHostId: null,
              deletedAt: null,
            },
            {
              id: remoteProjectId,
              workspaceRoot: "/srv/remote-app",
              executionTarget: "ssh-remote",
              remoteHostId: "host-review",
              deletedAt: null,
            },
          ],
          threads: [
            {
              id: remoteThreadId,
              projectId: remoteProjectId,
              deletedAt: null,
            },
          ],
        } as never),
    } as never,
    path: path.posix as never,
  });
}

describe("makeWorkspaceRuntimeRoutingSupport", () => {
  it("resolves git cwd from the project workspace root when no cwd override is provided", async () => {
    const support = makeSupport();

    const result = await Effect.runPromise(
      support.resolveGitCwd({
        projectId: localProjectId,
      }),
    );

    expect(result).toBe("/workspace/local-app");
  });

  it("rejects workspace writes that escape the project root", async () => {
    const support = makeSupport();

    await expect(
      Effect.runPromise(
        support.resolveWorkspaceWritePath("/workspace/local-app", "../outside.txt"),
      ),
    ).rejects.toThrow("Workspace file path must stay within the project root.");
  });

  it("routes thread operations through the remote branch for remote projects", async () => {
    const support = makeSupport();

    const result = await Effect.runPromise(
      support.routeThread({
        threadId: remoteThreadId,
        local: () => Effect.succeed("local"),
        remote: (_resolved, remoteHostId) => Effect.succeed(`remote:${remoteHostId}`),
      }),
    );

    expect(result).toBe("remote:host-review");
  });
});
