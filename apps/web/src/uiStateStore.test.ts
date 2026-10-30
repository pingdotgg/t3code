import { PROJECT_COLLECTIONS_STORAGE_KEY } from "./projectCollections";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  useUiStateStore,
  reorderProjects,
  resolveProjectExpanded,
  setProjectExpanded,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    sidebarProjectScopeKeys: [],
    activeProjectCollectionId: null,
    sidebarScopeRouteKey: null,
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

  it("moves grouped project members together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const currentOrder = [keyALocal, keyARemote, keyB, keyC];

    const next = reorderProjects(makeUiState(), currentOrder, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
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
      threadChangedFilesExpansionVersion: 2,
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
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      sidebarProjectScopeKeys: [],
      activeProjectCollectionId: null,
      sidebarScopeRouteKey: null,
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
      sidebarProjectScopeKeys: [],
      activeProjectCollectionId: null,
      sidebarScopeRouteKey: null,
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

  it("persists collection edits synchronously and keeps stale navigation writes separate", async () => {
    const group = { id: "work", name: " Work ", members: [] };
    expect(useUiStateStore.getState().saveProjectCollection(group)).toBeNull();
    useUiStateStore.getState().selectProjectCollection("work", "env:open-thread");
    expect(JSON.parse(localStorageStub.getItem(PROJECT_COLLECTIONS_STORAGE_KEY) ?? "null")).toEqual(
      [{ ...group, name: "Work" }],
    );
    persistState(makeUiState());
    expect(
      JSON.parse(localStorageStub.getItem(PROJECT_COLLECTIONS_STORAGE_KEY) ?? "null"),
    ).toHaveLength(1);
    expect(
      useUiStateStore.getState().saveProjectCollection({ ...group, name: "Renamed" }),
    ).toBeNull();
    useUiStateStore.getState().selectProjectCollection("work", "env:child");
    vi.resetModules();
    const { useUiStateStore: reloaded } = await import("./uiStateStore");
    expect(reloaded.getState()).toMatchObject({
      activeProjectCollectionId: "work",
      sidebarScopeRouteKey: "env:child",
      projectCollections: [{ id: "work", name: "Renamed", members: [] }],
    });
    reloaded.getState().deleteProjectCollection("work", "env:child");
    expect(reloaded.getState()).toMatchObject({
      activeProjectCollectionId: null,
      projectCollections: [],
      sidebarProjectScopeKeys: [],
    });
    localStorageStub.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({ activeProjectCollectionId: "deleted" }),
    );
    vi.resetModules();
    const { useUiStateStore: dangling } = await import("./uiStateStore");
    expect(dangling.getState().activeProjectCollectionId).toBeNull();
  });

  it("observes cross-window edits and learns against the latest definitions", async () => {
    const listeners = new Map<string, (event: { key: string | null }) => void>();
    vi.stubGlobal("window", {
      localStorage: localStorageStub,
      addEventListener: (key: string, callback: (event: { key: string | null }) => void) =>
        listeners.set(key, callback),
    });
    vi.resetModules();
    const { useUiStateStore: store } = await import("./uiStateStore");
    const groups = [{ id: "other-window", name: "Other", members: [] }];
    localStorageStub.setItem(PROJECT_COLLECTIONS_STORAGE_KEY, JSON.stringify(groups));
    store.getState().learnProjectCollectionAliases([]);
    expect(store.getState().projectCollections).toEqual(groups);
    expect(JSON.parse(localStorageStub.getItem(PROJECT_COLLECTIONS_STORAGE_KEY) ?? "null")).toEqual(
      groups,
    );
    const projectMember = {
      kind: "project" as const,
      physicalKey: "env:/repo",
      label: "Repo",
      repositoryKey: "github.com/example/repo",
      repositoryPathKey: "github.com/example/repo",
    };
    const learned = { id: "learned", name: "Learned", members: [projectMember] };
    localStorageStub.setItem(PROJECT_COLLECTIONS_STORAGE_KEY, JSON.stringify([...groups, learned]));
    store.getState().saveProjectCollection({
      ...learned,
      members: [{ ...projectMember, repositoryKey: null, repositoryPathKey: null }],
    });
    expect(store.getState().projectCollections).toEqual([...groups, learned]);
    store.getState().selectProjectCollection("learned", "env:thread");
    store.getState().setSidebarProjectScopeKeys(["repo"]);
    localStorageStub.setItem(PROJECT_COLLECTIONS_STORAGE_KEY, "malformed");
    listeners.get("storage")?.({ key: PROJECT_COLLECTIONS_STORAGE_KEY });
    expect(store.getState().projectCollections).toEqual([]);
    expect(store.getState().activeProjectCollectionId).toBeNull();
    expect(store.getState().sidebarProjectScopeKeys).toEqual([]);
  });

  it("restores the sidebar project scope across reloads", () => {
    const keys = ["github.com/pingdotgg/t3code", "github.com/pingdotgg/uploadthing"];
    persistState(makeUiState({ sidebarProjectScopeKeys: keys }));

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(parsePersistedState(persisted).sidebarProjectScopeKeys).toEqual(keys);
  });

  it("keeps a single-project scope readable by older clients", () => {
    persistState(makeUiState({ sidebarProjectScopeKeys: ["github.com/pingdotgg/t3code"] }));

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;

    expect(persisted.sidebarProjectScopeKey).toBe("github.com/pingdotgg/t3code");
  });

  it("restores a single-project scope saved before multi-project filtering", () => {
    expect(
      parsePersistedState({ sidebarProjectScopeKey: "github.com/pingdotgg/t3code" })
        .sidebarProjectScopeKeys,
    ).toEqual(["github.com/pingdotgg/t3code"]);
  });
});
