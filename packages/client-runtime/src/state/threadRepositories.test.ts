import { describe, expect, it } from "vite-plus/test";
import { CheckpointScopeId, type WorkspaceRepository } from "@t3tools/contracts";

import type { ThreadCheckpointRepositorySummary } from "./threadCheckpoints.ts";
import {
  describeOutsideEdit,
  findRepositoryFileLinkCandidates,
  groupChangedFilesByRepository,
} from "./threadRepositories.ts";

function repository(
  overrides: Partial<WorkspaceRepository> & Pick<WorkspaceRepository, "name" | "cwd">,
): WorkspaceRepository {
  return {
    originalPath: overrides.cwd,
    relativePath: "",
    kind: "repository",
    missing: false,
    ...overrides,
  };
}

function repositorySummary(
  overrides: Partial<ThreadCheckpointRepositorySummary> &
    Pick<ThreadCheckpointRepositorySummary, "name" | "repositoryPath">,
): ThreadCheckpointRepositorySummary {
  return {
    scopeId: CheckpointScopeId.make(`scope-${overrides.name}`),
    cwd: overrides.repositoryPath,
    status: "ready",
    files: [],
    ...overrides,
  };
}

const file = (path: string) => ({ path, kind: "modified", additions: 1, deletions: 0 });
const home = repository({ name: "home", cwd: "/code/home", kind: "home" });
const api = repository({ name: "api", cwd: "/code/api" });
const web = repository({ name: "web", cwd: "/code/web" });
const docs = repository({ name: "docs", cwd: "/code/docs" });

describe("groupChangedFilesByRepository", () => {
  it("lists home first, then changed repos, and gathers unchanged repos", () => {
    const grouped = groupChangedFilesByRepository({
      summary: {
        files: [file("README.md")],
        repositories: [
          repositorySummary({ name: "api", repositoryPath: "/code/api", files: [file("a.ts")] }),
          repositorySummary({ name: "docs", repositoryPath: "/code/docs", status: "error" }),
          repositorySummary({ name: "old", repositoryPath: "/code/old", files: [file("o.ts")] }),
        ],
      },
      repositories: [home, web, api, docs],
      homeName: "project",
    });

    expect(grouped.multiRepo).toBe(true);
    expect(grouped.groups.map((group) => [group.name, group.repositoryPath])).toEqual([
      ["home", null],
      ["api", "/code/api"],
      ["old", "/code/old"],
    ]);
    expect(grouped.unchanged).toEqual([
      { name: "web", failed: false },
      { name: "docs", failed: true },
    ]);
  });

  it("puts an unchanged home on the unchanged line", () => {
    const grouped = groupChangedFilesByRepository({
      summary: {
        files: [],
        repositories: [
          repositorySummary({ name: "api", repositoryPath: "/code/api", files: [file("a.ts")] }),
        ],
      },
      repositories: [home, api],
      homeName: "project",
    });

    expect(grouped.groups.map((group) => group.name)).toEqual(["api"]);
    expect(grouped.unchanged).toEqual([{ name: "home", failed: false }]);
  });

  it("keeps single-repo threads as one home group", () => {
    const grouped = groupChangedFilesByRepository({
      summary: { files: [file("README.md")], repositories: [] },
      repositories: null,
      homeName: "project",
    });

    expect(grouped).toEqual({
      multiRepo: false,
      groups: [
        {
          key: "home",
          name: "project",
          kind: "home",
          repositoryPath: null,
          cwd: null,
          files: [file("README.md")],
        },
      ],
      unchanged: [],
    });
  });
});

describe("findRepositoryFileLinkCandidates", () => {
  const repositories = [home, api, web];
  const nothingExists = (paths: ReadonlyArray<string>) => Promise.resolve(paths.map(() => false));

  it("prefers files the thread edited that end with the link path", async () => {
    const candidates = await findRepositoryFileLinkCandidates({
      path: "./src/server.ts",
      editedPaths: ["/code/web/src/client.ts", "/code/api/src/server.ts", "/tmp/xsrc/server.ts"],
      repositories,
      exists: () => Promise.reject(new Error("edited matches need no lookup")),
    });

    expect(candidates).toEqual([{ path: "/code/api/src/server.ts", repositoryName: "api" }]);
  });

  it("returns every edited match so the caller can ask", async () => {
    const candidates = await findRepositoryFileLinkCandidates({
      path: "package.json",
      editedPaths: ["/code/api/package.json", "/code/web/package.json"],
      repositories,
      exists: nothingExists,
    });

    expect(candidates.map((candidate) => candidate.repositoryName)).toEqual(["api", "web"]);
  });

  it("falls back to the repos where the path exists", async () => {
    const candidates = await findRepositoryFileLinkCandidates({
      path: "src/app.tsx",
      editedPaths: ["/code/api/src/server.ts"],
      repositories,
      exists: (paths) => Promise.resolve(paths.map((path) => path === "/code/web/src/app.tsx")),
    });

    expect(candidates).toEqual([{ path: "/code/web/src/app.tsx", repositoryName: "web" }]);
  });

  it("leaves paths that already name one place to the plain join", async () => {
    for (const path of ["../api/src/server.ts", "~/notes.md", "/code/api/src/server.ts"]) {
      expect(
        await findRepositoryFileLinkCandidates({
          path,
          editedPaths: ["/code/api/src/server.ts"],
          repositories,
          exists: nothingExists,
        }),
      ).toEqual([]);
    }
  });

  it("matches Windows paths without case", async () => {
    const candidates = await findRepositoryFileLinkCandidates({
      path: "src/Server.ts",
      editedPaths: ["C:\\code\\api\\SRC\\server.ts"],
      repositories: [repository({ name: "api", cwd: "C:\\code\\api" })],
      exists: nothingExists,
    });

    expect(candidates).toEqual([{ path: "C:\\code\\api\\SRC\\server.ts", repositoryName: "api" }]);
  });
});

describe("describeOutsideEdit", () => {
  it("names the folder from home and says why it has no history", () => {
    const edit = { name: "infra", files: ["main.tf"], fileCount: 3 };
    expect(describeOutsideEdit({ ...edit, root: "/Users/theo/code/infra", tracked: false })).toBe(
      "Edited 3 files in ~/code/infra, which this project does not track",
    );
    expect(describeOutsideEdit({ ...edit, root: "C:\\Users\\theo\\infra", tracked: true })).toBe(
      "Edited 3 files in ~/infra, which this thread has no history for",
    );
    expect(describeOutsideEdit({ ...edit, root: "/srv/infra", fileCount: 1, tracked: false })).toBe(
      "Edited 1 file in /srv/infra, which this project does not track",
    );
  });
});
