import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  deriveProjectSearchTerms,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
  sidebarProjectNamesUsePath = false,
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
    sidebarProjectNamesUsePath,
  };
}

function nestedProjects() {
  const rootIdentity = { ...repositoryIdentity, rootPath: "/work/delta" };
  return [
    makeProject("delta", "/work/delta", { repositoryIdentity: rootIdentity }),
    makeProject("commerce-pricing", "/work/delta/commerce-pricing", {
      repositoryIdentity: rootIdentity,
    }),
  ];
}

describe("buildProjectGroups", () => {
  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "t3code",
        "t3code-2",
        "t3code-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("uses a shared custom title as the repository group's label", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "Custom project" }),
      makeProject("second", "/work/t3code-2", { title: "Custom project" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Custom project",
    );
  });

  it("keeps the repository label when shared titles match its repository name", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "t3code" }),
      makeProject("second", "/work/t3code-2", { title: "t3code" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "T3 Code",
    );
  });

  it("keeps physical clones in separate groups when requested", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("separate") });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    expect(groups.map((group) => group.label)).toEqual(["t3code", "t3code-2", "t3code-3"]);
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses repository identity from a duplicate registration when the winner lacks it", () => {
    const identified = makeProject("identified", "/work/t3code", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshUnidentified = makeProject("fresh", "/work/t3code/", {
      repositoryIdentity: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [identified, freshUnidentified, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});

describe("nested workspaces", () => {
  it("keeps a parent workspace and a nested workspace of one repository apart", () => {
    for (const mode of ["repository", "repository_path", "separate"] as const) {
      const groups = buildProjectGroups({ projects: nestedProjects(), settings: settings(mode) });
      expect(groups).toHaveLength(2);
      expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
        "delta",
        "commerce-pricing",
      ]);
    }
  });

  it("still groups sibling clones of one remote that are each at a repository root", () => {
    const projects = [
      makeProject("t3code", "/work/t3code", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/t3code" },
      }),
      makeProject("t3code-2", "/work/t3code-2", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/t3code-2" },
      }),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
  });

  it("does not treat a sibling directory with a shared prefix as nested", () => {
    const projects = [
      makeProject("delta", "/work/delta", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/delta" },
      }),
      makeProject("delta-ops", "/work/delta-ops", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/delta-ops" },
      }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })).toHaveLength(1);
  });

  it("disambiguates colliding git labels with the repository-relative path", () => {
    const projects = nestedProjects().map((project) => ({ ...project, title: "t3code" }));
    const groups = buildProjectGroups({ projects, settings: settings("repository") });

    expect(groups.map((group) => group.label)).toEqual(["T3 Code", "T3 Code"]);
    expect(groups.map((group) => group.disambiguator)).toEqual([".", "commerce-pricing"]);
  });

  it("uses paths as the primary label without changing group keys", () => {
    const projects = nestedProjects();
    const gitNamed = buildProjectGroups({ projects, settings: settings("repository") });
    const pathNamed = buildProjectGroups({
      projects,
      settings: settings("repository", {}, true),
    });

    expect(pathNamed.map((group) => group.label)).toEqual(["delta", "commerce-pricing"]);
    expect(pathNamed.map((group) => group.key)).toEqual(gitNamed.map((group) => group.key));
    expect(pathNamed.map((group) => group.disambiguator)).toEqual([null, null]);
  });
});

describe("deriveProjectSearchTerms", () => {
  it("includes the title, git names, the workspace path, and every segment", () => {
    const [, nested] = nestedProjects();
    const terms = deriveProjectSearchTerms(nested!);

    expect(terms).toContain("commerce-pricing");
    expect(terms).toContain("delta");
    expect(terms).toContain("work");
    expect(terms).toContain("/work/delta/commerce-pricing");
    expect(terms).toContain("T3 Code");
    expect(terms).toContain("t3tools/t3code");
    expect(new Set(terms).size).toBe(terms.length);
  });
});
