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
  addableTaskFolderRepositories,
  deriveTurnRepositoryChanges,
  pinnableThreadRepositories,
  pinThreadRepository,
  repositoryCheckpointScopeIds,
  repositoryFilePath,
  repositorySectionForPath,
  resolveThreadGitRepository,
  resolveWorktreeRepositorySelection,
  rewindFileRestore,
  THREAD_REPOSITORY_SECTIONS_VISIBLE,
  isRelativePathInsideFolder,
  threadChangedRepositories,
  threadGitRepositories,
  threadGitRepositoryLabel,
  threadRepositoryScopes,
  threadRepositorySections,
  unpinThreadRepository,
  turnChanges,
  turnDiffSections,
  turnHasChanges,
  worktreeRepositoryChoices,
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

  it("names an unlabelled repository after its folder on Windows and POSIX", () => {
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
    expect(
      threadRepositoryScopes({
        checkpointScopes: [
          scope("scope-root", "/work/task"),
          scope("scope-api", String.raw`/work/task\outside`, {}),
        ],
      })[0],
    ).toMatchObject({ name: String.raw`task\outside` });
  });
});

describe("threadRepositorySections", () => {
  const changed = threadChangedRepositories({ checkpoints, checkpointScopes: scopes });

  it("does not mistake a POSIX backslash for a task-folder separator", () => {
    const sibling = String.raw`/work/task\outside`;
    const child = "/work/task/outside";
    const literalChild = String.raw`/work/task/\\repo`;
    const sections = threadRepositorySections({
      changed: [
        {
          scopeId: CheckpointScopeId.make("scope-sibling"),
          name: "api",
          cwd: sibling,
          repositoryPath: sibling,
        },
        {
          scopeId: CheckpointScopeId.make("scope-child"),
          name: "api",
          cwd: child,
          repositoryPath: child,
        },
        {
          scopeId: CheckpointScopeId.make("scope-literal-child"),
          name: "repo",
          cwd: literalChild,
          repositoryPath: literalChild,
        },
      ],
      pinned: [],
      threadCwd: "/work/task",
      showAll: false,
      taskFolder: { root: "/work/task", repositories: [] },
    });
    expect(sections.visible).toEqual([
      { key: child, name: "api", cwd: child, origin: "changed" },
      { key: literalChild, name: "repo", cwd: literalChild, origin: "changed" },
    ]);
  });

  it("orders changed repositories by their latest turn, newest first", () => {
    expect(changed.map((entry) => entry.cwd)).toEqual([
      "/work/shared",
      "/work/wrapper/services/api",
      "/work/wrapper/web",
    ]);
    // A loaded snapshot lists checkpoints by scope, not in the order they were captured.
    expect(
      threadChangedRepositories({
        checkpoints: [
          checkpoint("api-3", "scope-api", 3),
          checkpoint("shared-1", "scope-shared", 1),
          checkpoint("web-2", "scope-web", 2),
          checkpoint("web-1", "scope-web", 1),
        ],
        checkpointScopes: scopes,
      }).map((entry) => entry.cwd),
    ).toEqual(["/work/wrapper/services/api", "/work/wrapper/web", "/work/shared"]);
    // A baseline alone is no change: without a turn the repository sorts last, by name.
    expect(
      threadChangedRepositories({
        checkpoints: [
          checkpoint("web-0", "scope-web", 0, { runId: null }),
          checkpoint("api-1", "scope-api", 1),
        ],
        checkpointScopes: scopes,
      }).map((entry) => entry.cwd),
    ).toEqual(["/work/wrapper/services/api", "/work/shared", "/work/wrapper/web"]);
  });

  it("puts pins first, drops the thread's own folder, and folds the rest away", () => {
    const pinned = [
      { repositoryPath: "/work/wrapper/docs", name: "docs" },
      { repositoryPath: "/work/wrapper/web", name: "web" },
      { repositoryPath: "/work/wrapper", name: "wrapper" },
    ];
    const sections = threadRepositorySections({
      changed,
      pinned,
      threadCwd: "/work/wrapper",
      showAll: false,
    });
    expect(sections.visible.map((section) => [section.key, section.origin])).toEqual([
      ["/work/wrapper/docs", "pinned"],
      ["/work/wrapper/web", "pinned"],
      ["/work/shared", "changed"],
      ["/work/wrapper/services/api", "changed"],
    ]);
    expect(sections.hidden).toEqual([]);
    // A thread that reaches no tracked repository lists what it changed, and no pin.
    expect(
      threadRepositorySections({
        changed,
        pinned,
        threadCwd: "/work/wrapper",
        showAll: false,
        reachesTracked: false,
      }).visible.map((section) => section.origin),
    ).toEqual(["changed", "changed", "changed"]);

    const many = Array.from({ length: THREAD_REPOSITORY_SECTIONS_VISIBLE + 2 }, (_, index) => ({
      repositoryPath: `/work/extra-${index}`,
      name: `extra-${index}`,
    }));
    const folded = threadRepositorySections({
      changed: [],
      pinned: many,
      threadCwd: null,
      showAll: false,
    });
    expect(folded.visible).toHaveLength(THREAD_REPOSITORY_SECTIONS_VISIBLE);
    expect(folded.hidden.map((section) => section.name)).toEqual(["extra-4", "extra-5"]);
    expect(
      threadRepositorySections({ changed: [], pinned: many, threadCwd: null, showAll: true })
        .visible,
    ).toHaveLength(many.length);
  });

  it("pins once, unpins, and offers only Git folders that are not shown", () => {
    const docs = { repositoryPath: "/work/wrapper/docs", name: "docs" };
    const pinned = pinThreadRepository([], docs);
    expect(pinThreadRepository(pinned, { ...docs, name: "renamed" })).toBe(pinned);
    expect(unpinThreadRepository(pinned, "/work/elsewhere")).toBe(pinned);
    expect(unpinThreadRepository(pinned, docs.repositoryPath)).toEqual([]);

    const sections = threadRepositorySections({
      changed,
      pinned,
      threadCwd: "/work/wrapper",
      showAll: false,
    });
    expect(
      pinnableThreadRepositories({
        sections,
        threadCwd: "/work/wrapper",
        folders: [
          { path: "/work/wrapper", name: "wrapper", state: "git" },
          { path: "/work/wrapper/docs", name: "docs", state: "git" },
          { path: "/work/wrapper/web", name: "web", state: "git" },
          { path: "/work/wrapper/notes", name: "notes", state: "plain" },
          { path: "/work/wrapper/gone", name: "gone", state: "missing" },
          { path: "/work/wrapper/cli", name: "cli", state: "git" },
        ],
      }),
    ).toEqual([{ repositoryPath: "/work/wrapper/cli", name: "cli" }]);

    expect(
      pinnableThreadRepositories({
        sections,
        threadCwd: "/work/wrapper",
        folders: [
          { path: "/work/wrapper/api", name: "api", state: "git" },
          { path: "/work/wrapper/specs/api", name: "api", state: "git" },
        ],
      }),
    ).toEqual([
      { repositoryPath: "/work/wrapper/api", name: "api" },
      { repositoryPath: "/work/wrapper/specs/api", name: "specs/api" },
    ]);
  });

  it("offers Git changes of every repository a thread reaches, changed ones first", () => {
    const changed = [{ repositoryPath: "/work/web", name: "web", cwd: "/work/web" }];
    const folders = [
      { path: "/work", name: "work", state: "git" as const },
      { path: "/work/api", name: "api", state: "git" as const },
      { path: "/work/web", name: "web", state: "git" as const },
      { path: "/work/notes", name: "notes", state: "plain" as const },
    ];
    expect(
      threadGitRepositories({ changed, taskFolder: null, folders, threadCwd: "/work" }),
    ).toEqual([...changed, { repositoryPath: "/work/api", name: "api", cwd: "/work/api" }]);
    // A worktree thread reads its own checkouts, never the shared ones.
    expect(
      threadGitRepositories({
        changed: [{ repositoryPath: "/work/api", name: "api", cwd: "/work/api" }],
        taskFolder: {
          repositories: [{ repositoryPath: "/work/api", worktreePath: "/wt/api", name: "api" }],
        },
        folders,
        threadCwd: "/wt",
      }),
    ).toEqual([{ repositoryPath: "/work/api", name: "api", cwd: "/wt/api" }]);
  });

  it("acts in the chosen repository, else the thread's folder or its first repository", () => {
    const api = { repositoryPath: "/work/api", name: "api", cwd: "/work/api" };
    const web = { repositoryPath: "/work/web", name: "web", cwd: "/work/web" };
    const repositories = [api, web];
    expect(
      resolveThreadGitRepository({ repositories, chosenPath: null, threadFolderIsRepo: true }),
    ).toBeNull();
    expect(
      resolveThreadGitRepository({ repositories, chosenPath: web.cwd, threadFolderIsRepo: true }),
    ).toBe(web);
    // A plain folder has no Git state of its own to show.
    expect(
      resolveThreadGitRepository({ repositories, chosenPath: null, threadFolderIsRepo: false }),
    ).toBe(api);
    // A repository the thread no longer reaches is never acted in.
    expect(
      resolveThreadGitRepository({
        repositories,
        chosenPath: "/work/gone",
        threadFolderIsRepo: true,
      }),
    ).toBeNull();
    expect(
      resolveThreadGitRepository({ repositories: [], chosenPath: null, threadFolderIsRepo: false }),
    ).toBeNull();
  });

  it("names a repository by its folder in the project, so two of one name stay apart", () => {
    const nested = { repositoryPath: "/work/docs/server", name: "server" };
    expect(threadGitRepositoryLabel(nested, "/work")).toBe("docs/server");
    expect(threadGitRepositoryLabel({ ...nested, repositoryPath: "/work/server" }, "/work")).toBe(
      "server",
    );
    // A folder outside the project, or no known project folder, keeps its name.
    expect(threadGitRepositoryLabel({ ...nested, repositoryPath: "/elsewhere/api" }, "/work")).toBe(
      "server",
    );
    expect(threadGitRepositoryLabel(nested, null)).toBe("server");
  });

  it("lists a task folder's worktrees, changed first, and never a shared checkout", () => {
    const taskFolder = {
      root: "/wt/task",
      projectRoot: "/work/wrapper",
      repositories: [
        { repositoryPath: "/work/wrapper/docs", worktreePath: "/wt/task/docs", name: "docs" },
        { repositoryPath: "/work/wrapper/web", worktreePath: "/wt/task/web", name: "web" },
        {
          repositoryPath: "/work/wrapper/services/api",
          worktreePath: "/wt/task/services/api",
          name: "api",
        },
      ],
    };
    const submodule = {
      scopeId: CheckpointScopeId.make("scope:lib"),
      name: "lib",
      repositoryPath: "/work/wrapper/web/vendor/lib",
      cwd: "/wt/task/web/vendor/lib",
    };
    const sections = threadRepositorySections({
      // `/work/shared` is changed but has no worktree in the task folder.
      changed: [...changed, submodule],
      pinned: [{ repositoryPath: "/work/wrapper/cli", name: "cli" }],
      threadCwd: "/wt/task",
      showAll: false,
      taskFolder,
    });
    expect(sections.visible.map((section) => [section.key, section.cwd, section.origin])).toEqual([
      ["/work/wrapper/services/api", "/wt/task/services/api", "worktree"],
      ["/work/wrapper/web", "/wt/task/web", "worktree"],
      ["/work/wrapper/docs", "/wt/task/docs", "worktree"],
      // A submodule the thread changed inside one of its worktrees.
      ["/work/wrapper/web/vendor/lib", "/wt/task/web/vendor/lib", "changed"],
    ]);
    expect(
      threadRepositorySections({
        changed,
        pinned: [],
        threadCwd: "/wt/task",
        showAll: false,
        taskFolder: { root: "/wt/task", repositories: [] },
      }).visible,
    ).toEqual([]);

    expect(
      addableTaskFolderRepositories({
        taskFolder,
        folders: [
          { path: "/work/wrapper", name: "wrapper", state: "git" },
          { path: "/work/wrapper/docs", name: "docs", state: "git" },
          { path: "/work/wrapper/notes", name: "notes", state: "plain" },
          { path: "/work/shared", name: "shared", state: "git" },
        ],
      }),
    ).toEqual([{ repositoryPath: "/work/shared", name: "shared" }]);
  });
});

describe("rewindFileRestore", () => {
  const projection = { checkpointScopes: scopes, checkpoints };
  const missingRoot = (appRunOrdinal: number | null) =>
    ({ status: "missing", appRunOrdinal }) as const;
  const linkedProjectFolder = { projectIsWorktree: false };

  it.each([
    {
      why: "a ready snapshot restores every file",
      checkpoint: { status: "ready", appRunOrdinal: 1 } as const,
      taskFolder: null,
      restores: "files",
    },
    {
      why: "a linked project folder restores a repository's own checkpoint",
      checkpoint: missingRoot(1),
      taskFolder: linkedProjectFolder,
      restores: "repositories",
    },
    {
      why: "the thread start restores a repository's baseline",
      checkpoint: missingRoot(null),
      taskFolder: linkedProjectFolder,
      restores: "repositories",
    },
    {
      why: "no repository changed after the target",
      checkpoint: missingRoot(3),
      taskFolder: linkedProjectFolder,
      restores: null,
    },
    {
      why: "a worktree project folder needs its own snapshot",
      checkpoint: missingRoot(1),
      taskFolder: { projectIsWorktree: true },
      restores: null,
    },
    {
      why: "a thread outside a task folder has only its own snapshot",
      checkpoint: missingRoot(1),
      taskFolder: null,
      restores: null,
    },
    {
      why: "a stale snapshot restores nothing",
      checkpoint: { status: "stale", appRunOrdinal: 1 } as const,
      taskFolder: linkedProjectFolder,
      restores: null,
    },
    { why: "no target", checkpoint: undefined, taskFolder: linkedProjectFolder, restores: null },
  ])("$why", ({ checkpoint: target, taskFolder, restores }) => {
    expect(rewindFileRestore({ projection, checkpoint: target, taskFolder })).toBe(restores);
  });

  it("ignores the thread's own scope when looking for repository snapshots", () => {
    expect(
      rewindFileRestore({
        projection: {
          checkpointScopes: [scope("scope-root", "/work/wrapper")],
          checkpoints: [checkpoint("root-1", "scope-root", 1, { appRunOrdinal: 1 })],
        },
        checkpoint: missingRoot(1),
        taskFolder: linkedProjectFolder,
      }),
    ).toBe(null);
  });
});

describe("isRelativePathInsideFolder", () => {
  it.each([
    ["api", undefined, true],
    ["..api", undefined, true],
    ["../api", undefined, false],
    ["..", undefined, false],
    ["D:/api", undefined, false],
    [String.raw`\\repo`, "/work/task", true],
    [String.raw`\\repo`, String.raw`C:\work\task`, false],
  ])("%j relative to %j is inside: %j", (relativePath, folder, inside) => {
    expect(isRelativePathInsideFolder(relativePath, folder)).toBe(inside);
  });
});

describe("worktree repository selection", () => {
  const folders = [
    { path: "/work/wrapper/web", name: "web", state: "git" },
    { path: "/work/wrapper/services/api", name: "api", state: "git" },
    { path: "/work/wrapper/notes", name: "notes", state: "plain" },
    { path: "/work/shared", name: "shared", state: "git" },
  ] as const;
  const choices = worktreeRepositoryChoices({ folders, projectRoot: "/work/wrapper" });

  it("offers tracked Git folders with their place inside the project folder", () => {
    expect(choices).toEqual([
      { repositoryPath: "/work/wrapper/web", name: "web", relativePath: "web" },
      { repositoryPath: "/work/wrapper/services/api", name: "api", relativePath: "services/api" },
      { repositoryPath: "/work/shared", name: "shared" },
    ]);
  });

  it("does not mistake a POSIX backslash for a project-folder separator", () => {
    const sibling = String.raw`/work/task\outside`;
    const child = "/work/task/outside";
    const literalChild = String.raw`/work/task/\\repo`;
    expect(
      worktreeRepositoryChoices({
        projectRoot: "/work/task",
        folders: [
          { path: sibling, name: "api", state: "git" },
          { path: child, name: "api", state: "git" },
          { path: literalChild, name: "repo", state: "git" },
        ],
      }),
    ).toEqual([
      { repositoryPath: sibling, name: "api" },
      { repositoryPath: child, name: "api", relativePath: "outside" },
      { repositoryPath: literalChild, name: "repo", relativePath: String.raw`\\repo` },
    ]);
  });

  it("takes every repository by default and sends nothing until the user chooses", () => {
    expect(resolveWorktreeRepositorySelection({ choices, chosen: undefined })).toEqual({
      selected: ["/work/wrapper/web", "/work/wrapper/services/api", "/work/shared"],
      label: "All repositories",
      needsChoice: false,
      strategyRepositories: undefined,
    });
  });

  it("sends the chosen repositories the project still tracks, and an empty choice as none", () => {
    expect(
      resolveWorktreeRepositorySelection({
        choices,
        chosen: ["/work/shared", "/work/untracked", "/work/wrapper/web"],
      }),
    ).toMatchObject({
      label: "2 repositories",
      strategyRepositories: [{ path: "/work/wrapper/web" }, { path: "/work/shared" }],
    });
    expect(resolveWorktreeRepositorySelection({ choices, chosen: [] })).toMatchObject({
      label: "No repositories",
      needsChoice: false,
      strategyRepositories: [],
    });
  });

  it("takes none by default above the server's limit and asks for a choice", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      repositoryPath: `/work/wrapper/repo-${index}`,
      name: `repo-${index}`,
    }));
    expect(resolveWorktreeRepositorySelection({ choices: many, chosen: undefined })).toEqual({
      selected: [],
      label: "Choose repositories",
      needsChoice: true,
      strategyRepositories: undefined,
    });
    expect(
      resolveWorktreeRepositorySelection({ choices: many.slice(0, 8), chosen: undefined }).selected,
    ).toHaveLength(8);
  });

  it("sends a stored choice as it is while the tracked folders are still loading", () => {
    expect(
      resolveWorktreeRepositorySelection({ choices: null, chosen: ["/work/shared"] }),
    ).toMatchObject({ needsChoice: false, strategyRepositories: [{ path: "/work/shared" }] });
    expect(
      resolveWorktreeRepositorySelection({ choices: null, chosen: undefined }).strategyRepositories,
    ).toBeUndefined();
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
