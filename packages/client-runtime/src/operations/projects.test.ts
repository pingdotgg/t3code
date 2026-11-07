import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  findExistingAddProject,
  getCloneDestinationPath,
  getCloneDirectoryLeafName,
  getCloneDirectoryName,
  getCloneDirectoryPath,
  getDefaultCloneUrl,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  planAddProject,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("asks for a repository name when GitHub input is only an owner path", () => {
    const github = SourceControlProviderKind.make("github");
    expect(githubIncompleteOwnerRepositoryMessage(github, "pingdotgg/")).toBe(
      "Enter the full owner/repository name.",
    );
    expect(githubIncompleteOwnerRepositoryMessage(github, "  pingdotgg//  ")).toBe(
      "Enter the full owner/repository name.",
    );
    expect(githubIncompleteOwnerRepositoryMessage(github, "mona-cat_octo/")).toBe(
      "Enter the full owner/repository name.",
    );

    for (const input of [
      "pingdotgg/t3code",
      "mona-cat_octo/repo",
      "pingdotgg",
      "https://github.com/pingdotgg/t3code.git",
      "git@github.com:pingdotgg/t3code.git",
    ]) {
      expect(githubIncompleteOwnerRepositoryMessage(github, input)).toBeNull();
    }
    expect(
      githubIncompleteOwnerRepositoryMessage(SourceControlProviderKind.make("gitlab"), "group/"),
    ).toBeNull();
    expect(githubIncompleteOwnerRepositoryMessage("url", "owner/")).toBeNull();
    expect(
      githubIncompleteOwnerRepositoryMessage(SourceControlProviderKind.make("forgejo"), "owner/"),
    ).toBeNull();
  });

  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("lays clone folders out like ghq only when asked, and only when the URL is safe", () => {
    expect(getCloneDirectoryPath("git@github.com:owner/repo.git", false)).toBe("repo");
    expect(getCloneDirectoryPath("git@github.com:owner/repo.git", true)).toBe(
      "github.com/owner/repo",
    );
    expect(getCloneDirectoryPath("ssh://git@gitlab.com:2222/group/sub/repo.git", true)).toBe(
      "gitlab.com/group/sub/repo",
    );
    expect(getCloneDirectoryPath("https://github.com/owner/../../repo", true)).toBe("repo");
    expect(getCloneDirectoryPath("/srv/git/repo.git", true)).toBe("repo");
    expect(
      getCloneDirectoryPath(
        "git@ssh.dev.azure.com:v3/org/Project/My%20Repo",
        false,
        "Project/My Repo",
      ),
    ).toBe("My Repo");
    expect(
      getCloneDirectoryLeafName(
        "git@ssh.dev.azure.com:v3/org/Project/My%20Repo",
        true,
        "Project/My Repo",
      ),
    ).toBe("My%20Repo");
    expect(
      getCloneDestinationPath(
        "C:\\Users\\me\\ghq",
        getCloneDirectoryPath("git@github.com:owner/repo.git", true),
      ),
    ).toBe("C:\\Users\\me\\ghq\\github.com\\owner\\repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});

describe("planAddProject", () => {
  const environmentId = EnvironmentId.make("environment");
  const project = (id: string, workspaceRoot: string, inEnvironment = environmentId) =>
    ({
      id: ProjectId.make(id),
      environmentId: inEnvironment,
      title: id,
      workspaceRoot,
    }) as EnvironmentProject;
  const checkout = (
    overrides: Partial<{ selectedPath: string; rootProjectId: ProjectId }> = {},
  ) => ({
    selectedPath: "/work/repo",
    root: "/work/repo",
    rootProjectId: null,
    branch: "main",
    isLinkedWorktree: false,
    ...overrides,
  });

  it("adds the folder as asked when the host could not inspect it", () => {
    expect(planAddProject({ inspection: null, projects: [], environmentId })).toEqual({
      kind: "add",
    });
  });

  it("adds a folder outside any checkout without asking", () => {
    expect(
      planAddProject({
        inspection: { projectId: null, checkout: null },
        projects: [],
        environmentId,
      }),
    ).toEqual({ kind: "add" });
  });

  it("opens the project already at this folder, even outside a checkout", () => {
    const existing = project("existing", "/alias/folder");

    expect(
      planAddProject({
        inspection: { projectId: existing.id, checkout: null },
        projects: [existing],
        environmentId,
      }),
    ).toEqual({ kind: "open", project: existing });
  });

  it("ignores a project with the same id on another environment", () => {
    const elsewhere = project("existing", "/folder", EnvironmentId.make("elsewhere"));

    expect(
      planAddProject({
        inspection: { projectId: elsewhere.id, checkout: null },
        projects: [elsewhere],
        environmentId,
      }),
    ).toEqual({ kind: "add" });
  });

  it("confirms a checkout at its root with one choice", () => {
    const plan = planAddProject({
      inspection: { projectId: null, checkout: checkout() },
      projects: [],
      environmentId,
    });

    expect(plan).toEqual({
      kind: "confirm",
      confirmation: {
        title: "repo",
        description: "main · Main checkout",
        choices: [{ kind: "add", title: "Add project", workspaceRoot: "/work/repo" }],
      },
    });
  });

  it("names a linked worktree and a detached HEAD", () => {
    const plan = planAddProject({
      inspection: {
        projectId: null,
        checkout: { ...checkout(), branch: null, isLinkedWorktree: true },
      },
      projects: [],
      environmentId,
    });

    expect(plan.kind === "confirm" && plan.confirmation.description).toBe(
      "Detached HEAD · Linked worktree",
    );
  });

  it("offers a nested folder's repository root first, and still the folder itself", () => {
    const plan = planAddProject({
      inspection: {
        projectId: null,
        checkout: checkout({ selectedPath: "/work/repo/apps/web" }),
      },
      projects: [],
      environmentId,
    });

    expect(plan.kind === "confirm" && plan.confirmation.choices).toEqual([
      { kind: "add", title: "Add repository root", workspaceRoot: "/work/repo" },
      { kind: "add", title: "Add selected folder", workspaceRoot: "/work/repo/apps/web" },
    ]);
  });

  it("offers to open the project that already holds a nested folder's root", () => {
    const rootProject = project("repo", "/alias/repo");

    const plan = planAddProject({
      inspection: {
        projectId: null,
        checkout: checkout({ selectedPath: "/work/repo/apps/web", rootProjectId: rootProject.id }),
      },
      projects: [rootProject],
      environmentId,
    });

    expect(plan.kind === "confirm" && plan.confirmation.choices).toEqual([
      { kind: "open", title: "Open repo", workspaceRoot: "/alias/repo", project: rootProject },
      { kind: "add", title: "Add selected folder", workspaceRoot: "/work/repo/apps/web" },
    ]);
  });
});
