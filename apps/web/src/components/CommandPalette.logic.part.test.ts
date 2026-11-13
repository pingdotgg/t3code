import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  newThreadNoProjectIndex,
  buildNestedSearchItems,
  resolveCommandPaletteProject,
  buildThreadActionItems,
  buildLinkedThreadActionItems,
  filterPinnedBrowseEntries,
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  resolveAddProjectEntry,
  createCommandPaletteSearchState,
  reduceCommandPaletteSearchState,
  type CommandPaletteUiState,
} from "./CommandPalette.logic";

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

const PROJECT_ID = ProjectId.make("project-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("filterPinnedBrowseEntries", () => {
  it("matches an existing pinned destination without Windows casing", () => {
    const windowsEntries = [
      { name: "Repo", fullPath: "C:\\projects\\Repo" },
      { name: "work", fullPath: "C:\\projects\\work" },
    ];
    expect(
      filterPinnedBrowseEntries({
        browseEntries: windowsEntries,
        filterQuery: "repo",
        pinnedDirectoryName: "repo",
        caseSensitive: false,
      }),
    ).toEqual({
      visibleEntries: windowsEntries,
      exactEntry: windowsEntries[0],
    });
  });
});

it.each([
  "#10839",
  "10839",
  "pingdotgg/t3code#10839",
  "https://github.com/pingdotgg/t3code/pull/10839",
])("finds linked threads from PR query %s", (query) => {
  const items = buildThreadActionItems({
    threads: [
      makeThread({
        title: "Implementation",
        pullRequests: [
          {
            host: "github.com",
            repository: "pingdotgg/t3code",
            number: 10839,
            url: "https://github.com/pingdotgg/t3code/pull/10839",
            source: "manual",
            linkedAt: "2026-09-08T00:00:00Z",
            snapshot: null,
            stack: null,
          },
        ],
      }),
      makeThread({ id: ThreadId.make("unrelated"), title: "Other work" }),
    ],
    projectByKey: new Map(),
    icon: null,
    runThread: async () => undefined,
  });
  const groups = filterCommandPaletteGroups({
    activeGroups: [],
    query,
    isInSubmenu: false,
    projectSearchItems: [],
    threadSearchItems: items,
  });
  expect(groups.flatMap((group) => group.items.map((item) => item.title))).toEqual([
    "Implementation",
  ]);
});

describe("command palette search return", () => {
  const picker = { addonIcon: null, groups: [] };

  it("restores each parent query when backing out of nested pickers", () => {
    let state = createCommandPaletteSearchState(">new thread");
    state = reduceCommandPaletteSearchState(state, { type: "push", view: picker });
    expect(state.query).toBe("");
    state = reduceCommandPaletteSearchState(state, { type: "query", query: "remote project" });
    state = reduceCommandPaletteSearchState(state, {
      type: "push",
      view: { ...picker, initialQuery: "~/" },
    });
    expect(state.query).toBe("~/");

    state = reduceCommandPaletteSearchState(state, { type: "query", query: "" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("remote project");
    expect(state.views).toHaveLength(1);
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe(">new thread");
    expect(state.views).toHaveLength(0);
  });

  it("cannot return to an old picker after a new search replaces it", () => {
    let state = reduceCommandPaletteSearchState(createCommandPaletteSearchState("old"), {
      type: "push",
      view: picker,
    });
    state = reduceCommandPaletteSearchState(state, { type: "reset", query: "fresh" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state.query).toBe("fresh");
    expect(state.views).toHaveLength(0);
  });
});

describe("returning from file and content search", () => {
  const root: CommandPaletteUiState = {
    open: true,
    mode: "command",
    openIntent: null,
    session: 0,
  };
  const query = "https://github.com/acme/web/pull/7";
  const context = {
    query,
    linkedThreadSearch: {
      kind: "search" as const,
      query,
      linkedThreads: {
        environmentId: EnvironmentId.make("remote"),
        threads: [
          {
            id: ThreadId.make("linked-thread"),
            projectId: ProjectId.make("project"),
            title: "Completed work",
            archivedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
  };

  it.each(["files", "content"] as const)(
    "Escape from %s restores the query and linked-thread results",
    (mode) => {
      const child = reduceCommandPaletteUiState(root, { _tag: "OpenChildSearch", mode, context });
      expect(child.mode).toBe(mode);
      const returned = reduceCommandPaletteUiState(child, { _tag: "BackToCommand" });
      expect(returned).toEqual({ ...root, restoredSearch: context });
      expect(reduceCommandPaletteUiState(returned, { _tag: "BackToCommand" })).toEqual(returned);
    },
  );

  it("closing a child search discards its return context before reopening", () => {
    const child: CommandPaletteUiState = { ...root, mode: "files", parentSearch: context };
    const closed = reduceCommandPaletteUiState(child, { _tag: "SetOpen", open: false });
    expect(closed).toEqual({ open: false, mode: "files", openIntent: null, session: 0 });
    expect(reduceCommandPaletteUiState(closed, { _tag: "BackToCommand" })).toEqual(closed);
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual(root);
  });
});

it("resolves project metadata and browse roots within the active environment", () => {
  const local = { title: "Local project", workspaceRoot: "/local/repo" };
  const remote = { title: "Remote project", workspaceRoot: "/remote/repo" };
  const projects = new Map([
    ["local:shared-project", local],
    ["remote:shared-project", remote],
  ]);
  expect(
    resolveCommandPaletteProject(projects, EnvironmentId.make("local"), PROJECT_ID),
  ).toBeUndefined();
  const sharedId = ProjectId.make("shared-project");
  expect(resolveCommandPaletteProject(projects, EnvironmentId.make("local"), sharedId)).toBe(local);
  expect(resolveCommandPaletteProject(projects, EnvironmentId.make("remote"), sharedId)).toBe(
    remote,
  );
  expect(resolveCommandPaletteProject(projects, null, sharedId)).toBeUndefined();
  expect(resolveCommandPaletteProject(projects, EnvironmentId.make("local"), null)).toBeUndefined();
});

describe("newThreadNoProjectIndex", () => {
  const entry = (pinned = false, isPreferred = false, isScratch = false) => ({
    pinned,
    isPreferred,
    isScratch,
  });

  it("goes after the pinned projects and the first unpinned one", () => {
    expect(newThreadNoProjectIndex([entry(true), entry(true), entry(false, true), entry()])).toBe(
      3,
    );
    expect(newThreadNoProjectIndex([entry(false, true), entry(), entry(false, false, true)])).toBe(
      1,
    );
  });

  it("keeps a pinned or current scratch project in its own place", () => {
    expect(newThreadNoProjectIndex([entry(false, true, true), entry()])).toBe(0);
    expect(newThreadNoProjectIndex([entry(true), entry(true, false, true), entry()])).toBe(1);
  });
});
