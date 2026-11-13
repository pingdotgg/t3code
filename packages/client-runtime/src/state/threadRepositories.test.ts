import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveThreadCheckpointSummaries } from "./threadCheckpoints.ts";
import {
  deriveTurnRepositoryChanges,
  repositoryCheckpointScopeIds,
  repositoryFilePath,
  repositorySectionForPath,
  threadRepositoryScopes,
  turnChanges,
  turnDiffSections,
  turnHasChanges,
} from "./threadRepositories.ts";

const now = DateTime.makeUnsafe("2026-11-10T00:00:00.000Z");
const rootScopeId = CheckpointScopeId.make("scope-root");

function scope(
  id: string,
  cwd: string,
  repository?: { readonly label?: string; readonly path?: string },
): OrchestrationV2CheckpointScope {
  return {
    id: CheckpointScopeId.make(id),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: NodeId.make("node"),
    parentScopeId: repository === undefined ? null : rootScopeId,
    providerThreadId: null,
    kind: repository === undefined ? "root_run" : "manual",
    ordinalWithinParent: 0,
    advancesAppRunCount: repository === undefined,
    cwd,
    ...(repository?.label === undefined ? {} : { label: repository.label }),
    ...(repository === undefined ? {} : { repositoryPath: repository.path ?? cwd }),
    createdAt: now,
  };
}

function checkpoint(
  id: string,
  scopeId: string,
  ordinal: number,
  overrides: Partial<OrchestrationV2Checkpoint> = {},
): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(id),
    threadId: ThreadId.make("thread"),
    scopeId: CheckpointScopeId.make(scopeId),
    runId: RunId.make(`run-${ordinal}`),
    nodeId: NodeId.make("node"),
    parentCheckpointId: null,
    ordinalWithinScope: ordinal,
    appRunOrdinal: null,
    ref: CheckpointRef.make(`refs/t3/${id}`),
    status: "ready",
    files: [],
    capturedAt: now,
    ...overrides,
  };
}

const file = (path: string, additions = 1, deletions = 0) => ({
  path,
  kind: "modified",
  additions,
  deletions,
});

const scopes = [
  scope("scope-root", "/work/wrapper"),
  scope("scope-web", "/work/wrapper/web", { label: "web" }),
  scope("scope-api", "/work/wrapper/services/api", { label: "api" }),
  scope("scope-shared", "/work/shared", { label: "api" }),
];

// A plain wrapper folder: the thread's own checkpoint is missing on every turn.
const checkpoints = [
  checkpoint("root-1", "scope-root", 1, { status: "missing", appRunOrdinal: 1 }),
  checkpoint("api-0", "scope-api", 0, { runId: null }),
  checkpoint("api-1", "scope-api", 1, { files: [file("src/index.ts", 4, 2)] }),
  checkpoint("web-0", "scope-web", 0, { runId: null, status: "missing" }),
  checkpoint("web-1", "scope-web", 1),
  checkpoint("root-2", "scope-root", 2, { status: "missing", appRunOrdinal: 2 }),
  checkpoint("shared-1", "scope-shared", 1, { runId: null }),
  checkpoint("shared-2", "scope-shared", 2, {
    files: [file("a.ts")],
    filesTotal: { count: 300, additions: 900, deletions: 30 },
  }),
];

describe("threadRepositoryScopes", () => {
  it("lists repository scopes by name, then path, relative to the thread's folder", () => {
    expect(
      threadRepositoryScopes({ checkpointScopes: scopes }).map((entry) => [
        entry.name,
        entry.relativePath,
        entry.cwd,
      ]),
    ).toEqual([
      ["api", "../shared", "/work/shared"],
      ["api", "services/api", "/work/wrapper/services/api"],
      ["web", "web", "/work/wrapper/web"],
    ]);
    expect([...repositoryCheckpointScopeIds(scopes)]).toEqual([
      "scope-web",
      "scope-api",
      "scope-shared",
    ]);
  });

  it("names an unlabelled repository after its folder and handles Windows paths", () => {
    const [repository] = threadRepositoryScopes({
      checkpointScopes: [
        scope("scope-root", "C:\\Work\\Wrapper"),
        scope("scope-api", "c:\\work\\wrapper\\api", {}),
      ],
    });
    expect(repository).toMatchObject({ name: "api", relativePath: "api" });
    expect(
      threadRepositoryScopes({
        checkpointScopes: [scope("scope-root", "C:\\work"), scope("scope-api", "D:\\api", {})],
      })[0],
    ).not.toHaveProperty("relativePath");
  });
});

describe("deriveTurnRepositoryChanges", () => {
  it("groups each run's repository checkpoints and marks a repository without a baseline", () => {
    const byRun = deriveTurnRepositoryChanges({ checkpoints, checkpointScopes: scopes });
    expect([...byRun.keys()]).toEqual(["run-1", "run-2"]);
    expect(byRun.get(RunId.make("run-1"))).toEqual([
      {
        scopeId: "scope-api",
        name: "api",
        repositoryPath: "/work/wrapper/services/api",
        cwd: "/work/wrapper/services/api",
        relativePath: "services/api",
        files: [file("src/index.ts", 4, 2)],
        baselineMissing: false,
      },
      {
        scopeId: "scope-web",
        name: "web",
        repositoryPath: "/work/wrapper/web",
        cwd: "/work/wrapper/web",
        relativePath: "web",
        files: [],
        baselineMissing: true,
      },
    ]);
  });

  it("leaves out a repository checkpoint with no files and a recorded baseline", () => {
    const byRun = deriveTurnRepositoryChanges({
      checkpoints: [
        checkpoint("api-0", "scope-api", 0, { runId: null }),
        checkpoint("api-1", "scope-api", 1),
      ],
      checkpointScopes: scopes,
    });
    expect(byRun.size).toBe(0);
  });

  it("keeps an unchanged turn's repositories when a later turn adds checkpoints", () => {
    const before = deriveTurnRepositoryChanges({
      checkpoints: checkpoints.slice(0, 5),
      checkpointScopes: scopes,
    });
    const after = deriveTurnRepositoryChanges({ checkpoints, checkpointScopes: scopes });
    expect(after.get(RunId.make("run-1"))).toBe(before.get(RunId.make("run-1")));
  });

  it("gives nothing for a thread without repository scopes", () => {
    expect(
      deriveTurnRepositoryChanges({
        checkpoints: [checkpoint("root-1", "scope-root", 1, { files: [file("a.ts")] })],
        checkpointScopes: [scopes[0]!],
      }).size,
    ).toBe(0);
  });
});

describe("turn changes", () => {
  const summaries = deriveThreadCheckpointSummaries({
    checkpoints,
    checkpointScopes: scopes,
    messages: [],
  });

  it("attaches repositories to the thread's own turn summary and no summary of their own", () => {
    expect(summaries.map((summary) => [summary.runId, summary.status])).toEqual([
      ["run-1", "missing"],
      ["run-2", "missing"],
    ]);
    expect(summaries[0]!.repositories?.map((repository) => repository.name)).toEqual([
      "api",
      "web",
    ]);
  });

  it("shows a turn whose own checkpoint is missing when repositories changed", () => {
    expect(summaries.map(turnHasChanges)).toEqual([true, true]);
    expect(turnHasChanges({ files: [] })).toBe(false);
    expect(turnHasChanges({ files: [file("a.ts")] })).toBe(true);
  });

  it("totals the thread folder and every repository, honoring truncated file lists", () => {
    expect(turnChanges(summaries[0]!).totals).toEqual({ count: 1, additions: 4, deletions: 2 });
    expect(
      turnChanges({ files: [file("root.ts", 2, 1)], repositories: summaries[1]!.repositories })
        .totals,
    ).toEqual({ count: 301, additions: 902, deletions: 31 });
    expect(turnChanges({ files: [file("root.ts")] })).toEqual({
      rootFiles: [file("root.ts")],
      repositories: [],
      totals: { count: 1, additions: 1, deletions: 0 },
    });
  });
});

describe("turnDiffSections", () => {
  const sections = turnDiffSections(
    {
      diff: "diff --git a/README.md b/README.md\n",
      repositories: [
        { name: "api", repositoryPath: "/work/api", relativePath: "api", diff: "diff api\n" },
        { name: "empty", repositoryPath: "/work/empty", relativePath: "empty", diff: "" },
        {
          name: "api-client",
          repositoryPath: "/work/api/client",
          relativePath: "api/client",
          diff: "diff client\n",
        },
        { name: "shared", repositoryPath: "/shared", relativePath: "../shared", diff: "diff s\n" },
      ],
    },
    "wrapper",
  );

  it("puts the thread folder first and drops empty patches", () => {
    expect(sections.map(({ key, name, relativePath }) => [key, name, relativePath])).toEqual([
      [".", "wrapper", ""],
      ["/work/api", "api", "api"],
      ["/work/api/client", "api-client", "api/client"],
      ["/shared", "shared", "../shared"],
    ]);
    expect(turnDiffSections({ diff: "" }, "wrapper")).toEqual([]);
    expect(turnDiffSections({ diff: "", repositories: [] }, "wrapper")).toEqual([]);
  });

  it("maps a thread-relative path back to the innermost repository", () => {
    expect(repositoryFilePath("api/client", "src/a.ts")).toBe("api/client/src/a.ts");
    expect(repositoryFilePath("", "src/a.ts")).toBe("src/a.ts");
    const match = repositorySectionForPath(sections, "api/client/src/a.ts");
    expect([match?.section.name, match?.path]).toEqual(["api-client", "src/a.ts"]);
    expect(repositorySectionForPath(sections, "../shared/x.ts")?.path).toBe("x.ts");
    expect(repositorySectionForPath(sections, "README.md")).toBeNull();
    expect(repositorySectionForPath(sections, "apiary/x.ts")).toBeNull();
  });
});
