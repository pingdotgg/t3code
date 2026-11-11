import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { buildProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import { describe, expect, it } from "vite-plus/test";
import {
  pullRequestFilterProjects,
  pullRequestProjectFilterQueries,
} from "@t3tools/client-runtime/pull-request-project-filter";

const cups = EnvironmentId.make("env-cups");
const nucbox = EnvironmentId.make("env-nucbox");
function project(
  id: string,
  environmentId = nucbox,
  canonicalKey: string | null = "github.com/pingdotgg/t3code",
) {
  return {
    id: ProjectId.make(id),
    environmentId,
    title: "t3code",
    workspaceRoot: `/work/${id}`,
    repositoryIdentity:
      canonicalKey === null
        ? null
        : {
            canonicalKey,
            locator: {
              source: "git-remote" as const,
              remoteName: "origin",
              remoteUrl: `https://${canonicalKey}`,
            },
          },
    faviconPath: `${id}/favicon.png`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}
const groupsFor = (
  projects: ReadonlyArray<ReturnType<typeof project>>,
  mode: "repository" | "repository_path" | "separate" = "repository",
) =>
  buildProjectGroups({
    projects,
    settings: { sidebarProjectGroupingMode: mode, sidebarProjectGroupingOverrides: {} },
  });

describe("pull request project filter choices", () => {
  it("uses sidebar labels and order and reads every selected member within the server scope", () => {
    const projects = [
      project("main"),
      project("worktree"),
      project("main", cups),
      { ...project("fleet", cups, "github.com/pingdotgg/fleet"), title: "fleet" },
    ];
    const selected = projects[1]!;
    const choices = pullRequestFilterProjects(projects, groupsFor(projects).toReversed(), selected);
    expect(choices.map(({ title }) => title)).toEqual(["fleet", "t3code"]);
    expect(choices[1]?.id).toBe(selected.id);
    expect(choices[1]?.faviconPath).toBe(selected.faviconPath);
    expect(pullRequestProjectFilterQueries(choices, [cups, nucbox], selected)).toEqual([
      { environmentId: cups, projectIds: [ProjectId.make("main")] },
      { environmentId: nucbox, projectIds: [ProjectId.make("main"), selected.id] },
    ]);
    expect(pullRequestProjectFilterQueries(choices, [cups], selected)).toEqual([
      { environmentId: cups, projectIds: [ProjectId.make("main")] },
    ]);
    expect(pullRequestProjectFilterQueries(choices, [cups, nucbox])).toEqual([
      { environmentId: cups },
      { environmentId: nucbox },
    ]);
    expect(pullRequestProjectFilterQueries(choices, [cups], project("missing"))).toEqual([]);
  });

  it("collapses checkouts across machines and keeps a saved member selected", () => {
    const projects = [
      project("main"),
      project("worktree-1"),
      project("worktree-2"),
      project("main", cups),
    ];
    const groups = groupsFor(projects);
    const choices = pullRequestFilterProjects(projects, groups);
    expect(choices.map(({ title }) => title)).toEqual(["t3code"]);
    expect(choices[0]?.memberProjectRefs).toHaveLength(4);
    const selected = projects[3]!;
    expect(pullRequestFilterProjects(projects, groups, selected)[0]).toEqual({
      ...selected,
      memberProjectRefs: choices[0]!.memberProjectRefs,
    });
  });

  it("keeps different repositories, hosts and unidentified checkouts separate", () => {
    const projects = [
      project("upstream"),
      project("fork", nucbox, "github.com/juliusmarminge/t3code"),
      project("enterprise", nucbox, "git.example.com/pingdotgg/t3code"),
      project("unknown-1", nucbox, null),
      project("unknown-2", cups, null),
    ];
    const choices = pullRequestFilterProjects(projects, groupsFor(projects));
    expect(choices.map(({ id }) => id)).toEqual(projects.map(({ id }) => id));
  });

  it("honors the sidebar's separate and repository-path grouping", () => {
    const main = project("main");
    const remote = project("main", cups);
    const nested = {
      ...project("nested"),
      workspaceRoot: "/work/main/apps/web",
      repositoryIdentity: { ...main.repositoryIdentity!, rootPath: "/work/main" },
    };
    const projects = [main, remote, nested];
    expect(pullRequestFilterProjects(projects, groupsFor(projects, "separate"))).toHaveLength(3);
    expect(
      pullRequestFilterProjects(projects, groupsFor(projects, "repository_path")),
    ).toHaveLength(2);
    expect(pullRequestFilterProjects([remote], groupsFor(projects))[0]?.memberProjectRefs).toEqual([
      { environmentId: cups, projectId: remote.id },
    ]);
  });
});
