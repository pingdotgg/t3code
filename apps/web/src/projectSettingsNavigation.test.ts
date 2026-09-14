import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import { projectSettingsSearch } from "./projectSettingsNavigation";
import { projectSettingsRepresentative } from "./components/settings/ProjectSettingsPanel.logic";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");
const projects = [
  { environmentId: remote, id: ProjectId.make("remote"), workspaceRoot: "/work/repo" },
  { environmentId: primary, id: ProjectId.make("default"), workspaceRoot: "/work/repo" },
  { environmentId: primary, id: ProjectId.make("gold"), workspaceRoot: "/work/repo-gold" },
].map((project) => ({
  ...project,
  title: "repo",
  repositoryIdentity: {
    canonicalKey: "github.com/example/repo",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/example/repo.git",
    },
    provider: "github",
    owner: "example",
    name: "repo",
    displayName: "repo",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  faviconPath: project.id === "gold" ? "gold.png" : null,
}));
const group = buildSidebarProjectSnapshots({
  projects,
  settings: { sidebarProjectGroupingMode: "repository", sidebarProjectGroupingOverrides: {} },
  primaryEnvironmentId: primary,
  resolveEnvironmentLabel: () => null,
})[0]!;

describe("project settings checkout context", () => {
  it("keeps the exact checkout when the same machine has two copies", () => {
    const project = group.memberProjects.find((member) => member.id === "gold")!;
    const search = projectSettingsSearch(group.projectKey, project);
    const members = group.memberProjects.filter(
      (member) =>
        member.environmentId === search.machine && member.physicalProjectKey === search.checkout,
    );
    expect(members).toEqual([project]);
    expect(projectSettingsRepresentative(group, members).faviconPath).toBe("gold.png");
  });

  it("keeps a remote checkout instead of selecting the primary machine", () => {
    expect(projectSettingsSearch(group.projectKey, projects[0])).toEqual({
      project: group.projectKey,
      machine: remote,
      checkout: "remote:/work/repo",
    });
  });

  it("keeps the physical scope when duplicate records have different project IDs", () => {
    const duplicate = { ...projects[2]!, id: ProjectId.make("old-gold") };
    expect(projectSettingsSearch(group.projectKey, duplicate)).toEqual(
      projectSettingsSearch(group.projectKey, projects[2]),
    );
  });

  it("leaves a group action unscoped", () => {
    expect(projectSettingsSearch(group.projectKey)).toEqual({
      project: group.projectKey,
      machine: undefined,
      checkout: undefined,
    });
  });

  it("uses the sidebar representative even when another member sorts first", () => {
    const gold = group.memberProjects.find((member) => member.id === "gold")!;
    expect(
      projectSettingsRepresentative({ ...group, environmentId: gold.environmentId, id: gold.id }),
    ).toBe(gold);
  });
});
