import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadGroup,
  deleteThreadGroup,
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  moveThreadsToGroup,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  renameThreadGroup,
  reorderProjects,
  reorderThreadGroups,
  reorderThreads,
  resolveProjectExpanded,
  sanitizePersistedThreadGroups,
  setDefaultAdvertisedEndpointKey,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
  setThreadGroupExpanded,
  syncThreadGroups,
  toggleThreadGroup,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    threadOrderByProject: {},
    defaultAdvertisedEndpointKey: null,
    worktreeLabelByPath: {},
    threadGroupsById: {},
    threadGroupOrderByProjectKey: {},
    threadGroupExpandedById: {},
    groupIdByThreadKey: {},
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

  it("stores only collapsed changed-file turns", () => {
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
    ).toEqual({});
  });

  it("stores the endpoint preference by stable key", () => {
    const next = setDefaultAdvertisedEndpointKey(makeUiState(), "desktop-core:lan:http");

    expect(next.defaultAdvertisedEndpointKey).toBe("desktop-core:lan:http");
    expect(setDefaultAdvertisedEndpointKey(next, "desktop-core:lan:http")).toBe(next);
    expect(setDefaultAdvertisedEndpointKey(next, "")).toMatchObject({
      defaultAdvertisedEndpointKey: null,
    });
  });
});

describe("parsePersistedState", () => {
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
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });

    expect(parsed).toEqual({
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      threadOrderByProject: {},
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
      worktreeLabelByPath: {},
      threadGroupsById: {},
      threadGroupOrderByProjectKey: {},
      threadGroupExpandedById: {},
      groupIdByThreadKey: {},
    });
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
      projectExpandedById: {
        logical: false,
      },
      projectOrder: ["physical-b", "physical-a"],
      threadLastVisitedAtById: {
        "environment:thread-1": "2026-02-25T12:35:00.000Z",
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
      worktreeLabelByPath: {},
      threadGroups: [],
      threadGroupOrderByProjectKey: {},
      collapsedThreadGroupIds: [],
      threadOrderByProject: {},
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
        },
      },
    });
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

  it("persists manual thread order verbatim across restart", () => {
    // Thread keys are stable, so unlike project order this round-trips with no
    // id→cwd remapping: what reorderThreads stores is exactly what reloads.
    const state = reorderThreads(
      makeUiState(),
      "env-local:proj-a",
      ["t-1", "t-2", "t-3"],
      ["t-3"],
      "t-1",
    );
    expect(state.threadOrderByProject["env-local:proj-a"]).toEqual(["t-3", "t-1", "t-2"]);

    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.threadOrderByProject).toEqual({
      "env-local:proj-a": ["t-3", "t-1", "t-2"],
    });
    expect(parsePersistedState(persisted).threadOrderByProject).toEqual({
      "env-local:proj-a": ["t-3", "t-1", "t-2"],
    });
  });

  it("round-trips thread folders (membership, order, collapse) across restart", () => {
    let state = createThreadGroup(makeUiState(), {
      projectKey: "proj-A",
      id: "g1",
      name: "PRs in review",
      threadKeys: ["env:t1", "env:t2"],
    });
    state = createThreadGroup(state, { projectKey: "proj-A", id: "g2", name: "Experiments" });
    state = reorderThreadGroups(state, "proj-A", "g2", "g1");
    state = setThreadGroupExpanded(state, "g1", false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.threadGroupOrderByProjectKey).toEqual({ "proj-A": ["g2", "g1"] });
    expect(persisted.collapsedThreadGroupIds).toEqual(["g1"]);

    const rehydrated = sanitizePersistedThreadGroups(persisted);
    expect(rehydrated.threadGroupsById.g1!.threadKeys).toEqual(["env:t1", "env:t2"]);
    expect(rehydrated.threadGroupOrderByProjectKey).toEqual({ "proj-A": ["g2", "g1"] });
    expect(rehydrated.threadGroupExpandedById).toEqual({ g1: false });
    expect(rehydrated.groupIdByThreadKey).toEqual({ "env:t1": "g1", "env:t2": "g1" });
  });
});

describe("uiStateStore thread order", () => {
  it("reorderThreads moves a thread down past its target within a project", () => {
    const next = reorderThreads(makeUiState(), "proj", ["t1", "t2", "t3"], ["t1"], "t3");
    expect(next.threadOrderByProject.proj).toEqual(["t2", "t3", "t1"]);
  });

  it("reorderThreads moves a thread up before its target within a project", () => {
    const next = reorderThreads(makeUiState(), "proj", ["t1", "t2", "t3"], ["t3"], "t1");
    expect(next.threadOrderByProject.proj).toEqual(["t3", "t1", "t2"]);
  });

  it("reorderThreads is a no-op when dragging onto itself", () => {
    const state = makeUiState();
    expect(reorderThreads(state, "proj", ["t1", "t2"], ["t1"], "t1")).toBe(state);
  });

  it("reorderThreads is a no-op when the target is not in the live list", () => {
    const state = makeUiState();
    expect(reorderThreads(state, "proj", ["t1", "t2"], ["t1"], "missing")).toBe(state);
  });
});

describe("uiStateStore thread folders", () => {
  const P = "proj-A";

  it("createThreadGroup registers the folder and appends to project order", () => {
    const next = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "Experiments" });

    expect(next.threadGroupsById.g1).toEqual({
      id: "g1",
      projectKey: P,
      name: "Experiments",
      threadKeys: [],
    });
    expect(next.threadGroupOrderByProjectKey[P]).toEqual(["g1"]);
  });

  it("createThreadGroup with members removes them from prior folders and indexes them", () => {
    let state = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "A" });
    state = moveThreadsToGroup(state, ["t1", "t2"], "g1");
    state = createThreadGroup(state, {
      projectKey: P,
      id: "g2",
      name: "B",
      threadKeys: ["t2", "t3"],
    });

    expect(state.threadGroupsById.g1!.threadKeys).toEqual(["t1"]);
    expect(state.threadGroupsById.g2!.threadKeys).toEqual(["t2", "t3"]);
    expect(state.groupIdByThreadKey).toEqual({ t1: "g1", t2: "g2", t3: "g2" });
  });

  it("moveThreadsToGroup is a single-folder move (at most one folder per thread)", () => {
    let state = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "A" });
    state = createThreadGroup(state, { projectKey: P, id: "g2", name: "B" });
    state = moveThreadsToGroup(state, ["t1"], "g1");
    state = moveThreadsToGroup(state, ["t1"], "g2");

    expect(state.threadGroupsById.g1!.threadKeys).toEqual([]);
    expect(state.threadGroupsById.g2!.threadKeys).toEqual(["t1"]);
    expect(state.groupIdByThreadKey.t1).toBe("g2");
  });

  it("moveThreadsToGroup inserts before the target thread for ordering", () => {
    let state = createThreadGroup(makeUiState(), {
      projectKey: P,
      id: "g1",
      name: "A",
      threadKeys: ["t1", "t2", "t3"],
    });
    state = moveThreadsToGroup(state, ["t3"], "g1", "t1");

    expect(state.threadGroupsById.g1!.threadKeys).toEqual(["t3", "t1", "t2"]);
  });

  it("moveThreadsToGroup with null target removes membership (back to ungrouped)", () => {
    let state = createThreadGroup(makeUiState(), {
      projectKey: P,
      id: "g1",
      name: "A",
      threadKeys: ["t1", "t2"],
    });
    state = moveThreadsToGroup(state, ["t1"], null);

    expect(state.threadGroupsById.g1!.threadKeys).toEqual(["t2"]);
    expect(state.groupIdByThreadKey).toEqual({ t2: "g1" });
  });

  it("deleteThreadGroup returns members to ungrouped and drops order/expanded entries", () => {
    let state = createThreadGroup(makeUiState(), {
      projectKey: P,
      id: "g1",
      name: "A",
      threadKeys: ["t1"],
    });
    state = setThreadGroupExpanded(state, "g1", false);
    state = deleteThreadGroup(state, "g1");

    expect(state.threadGroupsById).toEqual({});
    expect(state.threadGroupOrderByProjectKey).toEqual({});
    expect(state.threadGroupExpandedById).toEqual({});
    expect(state.groupIdByThreadKey).toEqual({});
  });

  it("renameThreadGroup trims and ignores empty names", () => {
    let state = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "A" });
    state = renameThreadGroup(state, "g1", "  PRs in review  ");
    expect(state.threadGroupsById.g1!.name).toBe("PRs in review");
    expect(renameThreadGroup(state, "g1", "   ")).toBe(state);
  });

  it("toggleThreadGroup flips collapse, defaulting to expanded", () => {
    let state = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "A" });
    state = toggleThreadGroup(state, "g1");
    expect(state.threadGroupExpandedById.g1).toBe(false);
    state = toggleThreadGroup(state, "g1");
    expect(state.threadGroupExpandedById.g1).toBe(true);
  });

  it("reorderThreadGroups moves a folder before another within the project", () => {
    let state = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "A" });
    state = createThreadGroup(state, { projectKey: P, id: "g2", name: "B" });
    state = createThreadGroup(state, { projectKey: P, id: "g3", name: "C" });
    state = reorderThreadGroups(state, P, "g3", "g1");
    expect(state.threadGroupOrderByProjectKey[P]).toEqual(["g3", "g1", "g2"]);
  });

  it("syncThreadGroups prunes dead threads and drops empty folders in dead projects", () => {
    let state = createThreadGroup(makeUiState(), {
      projectKey: P,
      id: "g1",
      name: "A",
      threadKeys: ["t1", "t2"],
    });
    state = createThreadGroup(state, { projectKey: "dead-proj", id: "g2", name: "B" });

    const next = syncThreadGroups(state, {
      liveThreadKeys: new Set(["t1"]),
      liveProjectKeys: new Set([P]),
    });

    expect(next.threadGroupsById.g1!.threadKeys).toEqual(["t1"]);
    expect(next.threadGroupsById.g2).toBeUndefined();
    expect(next.groupIdByThreadKey).toEqual({ t1: "g1" });
  });

  it("syncThreadGroups keeps empty folders that belong to a live project", () => {
    const state = createThreadGroup(makeUiState(), { projectKey: P, id: "g1", name: "A" });
    const next = syncThreadGroups(state, {
      liveThreadKeys: new Set<string>(),
      liveProjectKeys: new Set([P]),
    });
    expect(next).toBe(state);
  });

  it("syncThreadGroups prunes stale manual ungrouped order entries", () => {
    const state = reorderThreads(makeUiState(), P, ["t1", "t2", "t3"], ["t3"], "t1");
    const next = syncThreadGroups(state, {
      liveThreadKeys: new Set(["t1", "t3"]),
      liveProjectKeys: new Set([P]),
    });
    expect(next.threadOrderByProject[P]).toEqual(["t3", "t1"]);
  });
});
