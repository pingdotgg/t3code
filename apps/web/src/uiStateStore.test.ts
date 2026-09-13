import { EnvironmentId, ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  pruneTaskPreferences,
  resolveTaskExpanded,
  setTaskExpanded,
  setTaskSettledExpanded,
  markThreadUnread,
  markThreadVisited,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  reorderProjects,
  resolveProjectExpanded,
  setDefaultAdvertisedEndpointKey,
  setProjectExpanded,
  setSidebarProjectScopeKey,
  setThreadChangedFilesExpanded,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    taskExpandedByKey: {},
    taskSettledExpandedByKey: {},
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectScopeKey: null,
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    defaultAdvertisedEndpointKey: null,
    pullRequestMergeMethod: "merge",
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("stores server timestamps without moving visit state backwards", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState();
    const visited = markThreadVisited(initialState, threadId, "2026-02-25T12:30:00.700Z");

    expect(visited.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:30:00.700Z");
    expect(markThreadVisited(visited, threadId, "2026-02-25T12:30:00.000Z")).toBe(visited);
    expect(markThreadVisited(visited, threadId, "not-a-date")).toBe(visited);
  });

  it("marks a completed thread unread using the server completion timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
    expect(markThreadUnread(next, threadId, null)).toBe(next);
  });

  it("resolves project expansion from logical, physical, and legacy preference keys", () => {
    const physicalKey = "environment:/repo/project";
    const legacyKey = legacyProjectCwdPreferenceKey("/repo/project");

    expect(resolveProjectExpanded({ logical: false, [physicalKey]: true }, ["logical"])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [physicalKey]: false }, ["new-logical", physicalKey])).toBe(
      false,
    );
    expect(resolveProjectExpanded({ [legacyKey]: false }, ["new-logical", legacyKey])).toBe(false);
    expect(resolveProjectExpanded({}, ["new-logical"])).toBe(true);
  });

  it("sets expansion for every stable key belonging to a logical project", () => {
    const initialState = makeUiState();
    const keys = ["logical", "environment-a:/repo", "environment-b:/repo"];

    const next = setProjectExpanded(initialState, keys, false);

    expect(next.projectExpandedById).toEqual({
      logical: false,
      "environment-a:/repo": false,
      "environment-b:/repo": false,
    });
    expect(setProjectExpanded(next, keys, false)).toBe(next);
  });

  it("reorders from the current atom-derived project order", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const currentOrder = [project1, project2, project3];

    const next = reorderProjects(makeUiState(), currentOrder, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("moves grouped project members together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const currentOrder = [keyALocal, keyARemote, keyB, keyC];

    const next = reorderProjects(makeUiState(), currentOrder, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("does not reorder missing or identical groups", () => {
    const currentOrder = ["env-local:proj-a", "env-local:proj-b"];
    const state = makeUiState();

    expect(reorderProjects(state, currentOrder, ["env-local:missing"], ["env-local:proj-b"])).toBe(
      state,
    );
    expect(reorderProjects(state, currentOrder, ["env-local:proj-a"], ["env-local:proj-a"])).toBe(
      state,
    );
  });

  it("stores explicit changed-file expansion choices", () => {
    const threadId = ThreadId.make("thread-1");
    const collapsed = setThreadChangedFilesExpanded(makeUiState(), threadId, "turn-1", false);

    expect(collapsed.threadChangedFilesExpandedById).toEqual({
      [threadId]: {
        "turn-1": false,
      },
    });
    expect(
      setThreadChangedFilesExpanded(collapsed, threadId, "turn-1", true)
        .threadChangedFilesExpandedById,
    ).toEqual({
      [threadId]: {
        "turn-1": true,
      },
    });
  });

  it("stores the endpoint preference by stable key", () => {
    const next = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });

  it("stores the sidebar project scope and resets it to all projects", () => {
    const scoped = setSidebarProjectScopeKey(makeUiState(), "github.com/pingdotgg/t3code");

    expect(scoped.sidebarProjectScopeKey).toBe("github.com/pingdotgg/t3code");
    expect(setSidebarProjectScopeKey(scoped, "github.com/pingdotgg/t3code")).toBe(scoped);
    expect(setSidebarProjectScopeKey(scoped, null).sidebarProjectScopeKey).toBeNull();
    expect(setSidebarProjectScopeKey(scoped, "").sidebarProjectScopeKey).toBeNull();
  });
});

describe("parsePersistedState", () => {
  it("hydrates the last selected pull request merge method", () => {
    const parsed = parsePersistedState({
      pullRequestMergeMethod: "squash",
    });
    const invalid = parsePersistedState({
      pullRequestMergeMethod: "fast-forward",
    });

    expect(parsed.pullRequestMergeMethod).toBe("squash");
    expect(invalid.pullRequestMergeMethod).toBe("merge");
  });

  it("hydrates raw UI-owned state without server entities", () => {
    const parsed = parsePersistedState({
      projectExpandedById: {
        logical: false,
        invalid: "no" as unknown as boolean,
      },
      projectOrder: ["physical-b", "", "physical-a", "physical-b"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
        invalid: "not-a-date",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 2,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      taskExpandedByKey: {},
      taskSettledExpandedByKey: {},
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKey: null,
      pullRequestMergeMethod: "merge",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });

  it.each([undefined, 1])("ignores changed-file expansion version %s", (version) => {
    const parsed = parsePersistedState({
      ...(version === undefined ? {} : { threadChangedFilesExpansionVersion: version }),
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
    });

    expect(parsed.threadChangedFilesExpandedById).toEqual({});
  });

  it("migrates legacy CWD project preferences into local alias keys", () => {
    const parsed = parsePersistedState({
      collapsedProjectCwds: ["/repo/b"],
      expandedProjectCwds: ["/repo/a"],
      projectOrderCwds: ["/repo/b", "/repo/a"],
    });
    const projectAKey = legacyProjectCwdPreferenceKey("/repo/a");
    const projectBKey = legacyProjectCwdPreferenceKey("/repo/b");

    expect(parsed.projectOrder).toEqual([projectBKey, projectAKey]);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectAKey])).toBe(true);
    expect(resolveProjectExpanded(parsed.projectExpandedById, [projectBKey])).toBe(false);
    expect(resolveProjectExpanded(parsed.projectExpandedById, ["unknown"])).toBe(true);
  });

  it("preserves legacy expanded-only semantics for one-way migration", () => {
    const parsed = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/a"),
      ]),
    ).toBe(true);
    expect(
      resolveProjectExpanded(parsed.projectExpandedById, [
        legacyProjectCwdPreferenceKey("/repo/b"),
      ]),
    ).toBe(false);
  });
});

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => {
      store.clear();
    },
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe("uiStateStore persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists raw UI preferences including thread visit markers", () => {
    const state = makeUiState({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
    });

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted).toEqual({
      taskExpandedByKey: {},
      taskSettledExpandedByKey: {},
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKey: null,
      threadChangedFilesExpansionVersion: 2,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
      pullRequestMergeMethod: "merge",
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
    });
  });

  it("restores task and settled shelf expansion independently across reloads", () => {
    const task = {
      environmentId: EnvironmentId.make("environment-a"),
      taskId: TaskId.make("task-1"),
    };
    const state = setTaskSettledExpanded(setTaskExpanded(makeUiState(), task, false), task, true);
    persistState(state);
    const restored = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState,
    );
    expect(restored.taskExpandedByKey).toEqual(state.taskExpandedByKey);
    expect(restored.taskSettledExpandedByKey).toEqual(state.taskSettledExpandedByKey);
  });

  it("restores the sidebar project scope across reloads", () => {
    persistState(makeUiState({ sidebarProjectScopeKey: "github.com/pingdotgg/t3code" }));

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(parsePersistedState(persisted).sidebarProjectScopeKey).toBe(
      "github.com/pingdotgg/t3code",
    );
  });

  it("drops the temporary expanded-only migration fallback when rewriting state", () => {
    const migrated = parsePersistedState({
      expandedProjectCwds: ["/repo/a"],
    });

    persistState(migrated);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(resolveProjectExpanded(persisted.projectExpandedById ?? {}, ["unknown"])).toBe(true);
  });
});

describe("task expansion preferences", () => {
  const envA = EnvironmentId.make("environment-a");
  const envB = EnvironmentId.make("environment-b");
  const taskId = TaskId.make("task-1");
  const refA = { environmentId: envA, taskId };
  const refB = { environmentId: envB, taskId };

  it("starts active tasks expanded and parked tasks collapsed without writing defaults", () => {
    expect(resolveTaskExpanded({}, refA, false)).toBe(true);
    expect(resolveTaskExpanded({}, refA, true)).toBe(false);
  });

  it("keeps explicit expansion and settled shelf choices scoped across lifecycle changes", () => {
    const state = setTaskSettledExpanded(setTaskExpanded(makeUiState(), refA, false), refA, true);
    expect(resolveTaskExpanded(state.taskExpandedByKey, refA, false)).toBe(false);
    expect(resolveTaskExpanded(state.taskExpandedByKey, refB, false)).toBe(true);
    expect(state.taskSettledExpandedByKey).toEqual({ "environment-a:task-1": true });
    expect(setTaskExpanded(state, refA, false)).toBe(state);
    expect(setTaskSettledExpanded(state, refA, true)).toBe(state);
    const opened = setTaskExpanded(state, refA, true);
    expect(resolveTaskExpanded(opened.taskExpandedByKey, refA, true)).toBe(true);
  });

  it("rehydrates only boolean preferences with valid scoped keys", () => {
    const parsed = parsePersistedState({
      taskExpandedByKey: {
        "environment-a:task-1": false,
        "environment-b:task-1": true,
        unscoped: true,
        ":missing-environment": false,
        "environment-a:": false,
        "environment-a:invalid-value": "false" as unknown as boolean,
      },
      taskSettledExpandedByKey: { "environment-a:task-1": true },
    });
    expect(parsed.taskExpandedByKey).toEqual({
      "environment-a:task-1": false,
      "environment-b:task-1": true,
    });
    expect(parsed.taskSettledExpandedByKey).toEqual({ "environment-a:task-1": true });
    expect(parsePersistedState({}).taskExpandedByKey).toEqual({});
    expect(
      parsePersistedState({ taskExpandedByKey: [] as unknown as Record<string, boolean> })
        .taskExpandedByKey,
    ).toEqual({});
  });

  it("preserves every preference while inventory is cached, disconnected or loading", () => {
    const state = setTaskSettledExpanded(setTaskExpanded(makeUiState(), refA, false), refB, true);
    expect(pruneTaskPreferences(state, envA, [], false)).toBe(state);
    expect(pruneTaskPreferences(state, envB, [], false)).toBe(state);
  });

  it("prunes only missing tasks in the authoritative environment", () => {
    let state = setTaskExpanded(makeUiState(), refA, false);
    state = setTaskExpanded(state, refB, true);
    state = setTaskSettledExpanded(state, refA, true);
    state = setTaskSettledExpanded(state, refB, false);
    expect(pruneTaskPreferences(state, envA, [taskId], true)).toBe(state);
    const pruned = pruneTaskPreferences(state, envA, [], true);
    expect(pruned.taskExpandedByKey).toEqual({ "environment-b:task-1": true });
    expect(pruned.taskSettledExpandedByKey).toEqual({ "environment-b:task-1": false });
    expect(pruneTaskPreferences(pruned, envA, [], true)).toBe(pruned);
  });
});
