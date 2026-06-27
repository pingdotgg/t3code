import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadNavigationGroups } from "./thread-navigation-groups";

const environmentId = EnvironmentId.make("environment-1");

function makeProject(input: Pick<EnvironmentProject, "id" | "title">): EnvironmentProject {
  return {
    environmentId,
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Pick<EnvironmentThreadShell, "id" | "projectId" | "title"> &
    Partial<EnvironmentThreadShell>,
): EnvironmentThreadShell {
  return {
    environmentId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("buildThreadNavigationGroups", () => {
  const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
  const threads = [
    makeThread({
      id: ThreadId.make("older"),
      projectId: project.id,
      title: "Fix reconnect flow",
      updatedAt: "2026-06-02T00:00:00.000Z",
    }),
    makeThread({
      id: ThreadId.make("newer"),
      projectId: project.id,
      title: "Build adaptive sidebar",
      updatedAt: "2026-06-03T00:00:00.000Z",
    }),
  ];

  it("sorts each group by recent activity", () => {
    expect(
      buildThreadNavigationGroups({ projects: [project], threads })[0]?.threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["newer", "older"]);
  });

  it("matches thread titles without dropping their group", () => {
    const groups = buildThreadNavigationGroups({
      projects: [project],
      threads,
      searchQuery: "reconnect",
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["older"]);
  });

  it("keeps every thread when the project title matches", () => {
    expect(
      buildThreadNavigationGroups({
        projects: [project],
        threads,
        searchQuery: "t3 code",
      })[0]?.threads.map((thread) => thread.id),
    ).toEqual(["newer", "older"]);
  });

  it("excludes archived threads from the navigation sidebar", () => {
    const archived = makeThread({
      id: ThreadId.make("archived"),
      projectId: project.id,
      title: "Archived work",
      archivedAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(
      buildThreadNavigationGroups({
        projects: [project],
        threads: [...threads, archived],
      })[0]?.threads.map((thread) => thread.id),
    ).toEqual(["newer", "older"]);
  });
});
