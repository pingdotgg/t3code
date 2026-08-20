import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { buildSidebarPlatformGroups } from "./sidebarPlatformGrouping";

function thread(id: string, projectId: string, instanceId: string): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    environmentId: EnvironmentId.make("local"),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("buildSidebarPlatformGroups", () => {
  it("groups chats by platform, then project, with ungrouped chats last", () => {
    const groups = buildSidebarPlatformGroups({
      threads: [
        thread("codex-loose", "loose", "codex"),
        thread("open-code", "repo", "opencode"),
        thread("codex-project", "repo", "codex-personal"),
      ],
      driverByInstanceId: new Map([
        ["codex", ProviderDriverKind.make("codex")],
        ["codex-personal", ProviderDriverKind.make("codex")],
        ["opencode", ProviderDriverKind.make("opencode")],
      ]),
      projectTitleByKey: new Map([
        ["local:repo", "t3code"],
        ["local:loose", "Chats not in a project"],
      ]),
      platformLabel: (driver, instanceId) => driver ?? instanceId,
    });

    expect(groups.map((group) => group.label)).toEqual(["codex", "opencode"]);
    expect(groups[0]?.projects.map((project) => project.title)).toEqual([
      "t3code",
      "Chats not in a project",
    ]);
    expect(groups[0]?.threadCount).toBe(2);
  });
});
