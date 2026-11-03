import {
  ThreadId,
  type WorkspaceListRepositoriesResult,
  type WorkspaceScannedFolder,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addTrackedFolder,
  failedSetupRepositories,
  initialScanSelection,
  keptTaskFolderRepositories,
  relocateTrackedFolder,
  resolveLaunchRepositories,
  scannedFoldersTitle,
  taskFolderDeleteConfirmation,
  trackedFolderState,
  untrackedScannedFolders,
} from "./multiRepo";

const repos = [{ originalPath: "/code/api" }, { originalPath: "/code/web" }];

function scanned(count: number, isGitRepository = true): WorkspaceScannedFolder[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `/code/app/pkg-${index}`,
    name: `pkg-${index}`,
    isGitRepository,
    source: "child",
  }));
}

describe("resolveLaunchRepositories", () => {
  it("omits the list when every repo is in with its default base", () => {
    expect(resolveLaunchRepositories(repos, undefined)).toBeUndefined();
    expect(resolveLaunchRepositories(repos, { excludedPaths: [], baseRefs: {} })).toBeUndefined();
    expect(
      resolveLaunchRepositories(repos, { excludedPaths: [], baseRefs: { "/code/api": "  " } }),
    ).toBeUndefined();
    // A path the project stopped tracking does not count as left out.
    expect(
      resolveLaunchRepositories(repos, { excludedPaths: ["/code/gone"], baseRefs: {} }),
    ).toBeUndefined();
  });

  it("lists the included repos when one is left out or has its own base", () => {
    expect(
      resolveLaunchRepositories(repos, { excludedPaths: ["/code/web"], baseRefs: {} }),
    ).toEqual([{ path: "/code/api" }]);
    expect(
      resolveLaunchRepositories(repos, {
        excludedPaths: [],
        baseRefs: { "/code/web": " release/2.0 " },
      }),
    ).toEqual([{ path: "/code/api" }, { path: "/code/web", baseRef: "release/2.0" }]);
    expect(
      resolveLaunchRepositories(repos, {
        excludedPaths: ["/code/api", "/code/web"],
        baseRefs: {},
      }),
    ).toEqual([]);
  });
});

describe("scanned folders", () => {
  it("checks every folder up to eight, and none above that", () => {
    expect(initialScanSelection(scanned(8)).size).toBe(8);
    expect(initialScanSelection(scanned(9)).size).toBe(0);
  });

  it("names repositories and plain folders separately", () => {
    expect(scannedFoldersTitle(scanned(1))).toBe("Found 1 repository");
    expect(scannedFoldersTitle([...scanned(3), ...scanned(1, false)])).toBe(
      "Found 3 repositories and 1 folder",
    );
  });

  it("offers only untracked folders on rescan", () => {
    expect(
      untrackedScannedFolders([{ path: "/code/app/pkg-0/", name: "pkg-0" }], scanned(2)).map(
        (folder) => folder.name,
      ),
    ).toEqual(["pkg-1"]);
  });
});

describe("trackedFolderState", () => {
  const workspace: WorkspaceListRepositoriesResult = {
    repositories: [
      {
        name: "app",
        cwd: "/code/app",
        originalPath: "/code/app",
        relativePath: "",
        kind: "home",
        missing: false,
      },
      {
        name: "api",
        cwd: "/code/api",
        originalPath: "/code/api",
        relativePath: "../api",
        kind: "repository",
        missing: true,
      },
    ],
    references: [{ name: "docs", path: "/shared/docs", missing: false }],
    taskFolder: null,
  };

  it("reads Git-ness and missing folders from the server list", () => {
    expect(trackedFolderState({ path: "/code/api", name: "api" }, workspace)).toEqual({
      kind: "repository",
      missing: true,
    });
    expect(trackedFolderState({ path: "/shared/docs", name: "docs" }, workspace)).toEqual({
      kind: "reference",
      missing: false,
    });
    expect(trackedFolderState({ path: "/code/app/notes", name: "notes" }, workspace).kind).toBe(
      "folder",
    );
    expect(trackedFolderState({ path: "/code/api", name: "api" }, null).kind).toBe("unknown");
  });
});

describe("task folder delete", () => {
  const repositories = [
    { name: "app", hasChanges: false },
    { name: "api", hasChanges: true },
    { name: "web", hasChanges: null },
  ];

  it("lists every repo with its state", () => {
    expect(taskFolderDeleteConfirmation({ root: "~/worktrees/fix-login", repositories })).toBe(
      [
        "This thread is the only one using this task folder:",
        "~/worktrees/fix-login",
        "",
        "app: clean",
        "api: has changes",
        "web: status unknown",
        "",
        "Delete the task folder too? Repos with changes are kept.",
      ].join("\n"),
    );
  });

  it("reports only repos known to have changes as kept", () => {
    expect(keptTaskFolderRepositories(repositories)).toEqual(["api"]);
  });
});

describe("tracked folder edits", () => {
  const tracked = [
    { path: "/code/api", name: "api" },
    { path: "/code/web", name: "frontend" },
  ];

  it("adds a folder once, named after its last segment", () => {
    expect(addTrackedFolder(tracked, "/code/docs/")).toEqual([
      ...tracked,
      { path: "/code/docs/", name: "docs" },
    ]);
    expect(addTrackedFolder(tracked, "/code/api/")).toEqual(tracked);
  });

  it("keeps the name and position when a missing folder is located", () => {
    expect(relocateTrackedFolder(tracked, "/code/web", "/src/web")).toEqual([
      { path: "/code/api", name: "api" },
      { path: "/src/web", name: "frontend" },
    ]);
  });
});

describe("failedSetupRepositories", () => {
  const snapshot = (phase: "running" | "failed"): WorktreeSetupSnapshot => ({
    threadId: ThreadId.make("thread-1"),
    phase,
    startedAt: "2026-10-27T00:00:00.000Z",
    endedAt: null,
    branch: null,
    baseRef: null,
    worktreePath: null,
    setupScript: null,
    stages: [],
    repositories: [
      { name: "api", path: "/code/api", status: "failed", detail: "bad ref" },
      { name: "web", path: "/code/web", status: "done", detail: null },
    ],
    error: null,
    sequence: 1,
  });

  it("offers only repos that failed, once setup has stopped", () => {
    expect(
      failedSetupRepositories(snapshot("failed")).map((repository) => repository.name),
    ).toEqual(["api"]);
    expect(failedSetupRepositories(snapshot("running"))).toEqual([]);
    expect(failedSetupRepositories(null)).toEqual([]);
  });
});
