import { ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  adoptUiStateFromOtherWindow,
  legacyProjectCwdPreferenceKey,
  markThreadUnread,
  markThreadVisited,
  parsePersistedState,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  reorderProjects,
  resolveProjectExpanded,
  setProjectExpanded,
  type UiState,
  useUiStateStore,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
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
      pullRequestMergeMethod: "merge",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });

  it("keeps a persisted fast-forward merge method", () => {
    expect(
      parsePersistedState({ pullRequestMergeMethod: "fast-forward" }).pullRequestMergeMethod,
    ).toBe("fast-forward");
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
    vi.useRealTimers();
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

  it("keeps legacy projects omitted from the expanded list collapsed across a save and reload", () => {
    const projectAKey = legacyProjectCwdPreferenceKey("/repo/a");
    const projectBKey = legacyProjectCwdPreferenceKey("/repo/b");
    const migrated = parsePersistedState({ expandedProjectCwds: ["/repo/a"] });
    expect(resolveProjectExpanded(migrated.projectExpandedById, [projectBKey])).toBe(false);

    persistState({ ...migrated, pullRequestMergeMethod: "squash" });
    const reloaded = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState,
    );

    expect(resolveProjectExpanded(reloaded.projectExpandedById, [projectAKey])).toBe(true);
    expect(resolveProjectExpanded(reloaded.projectExpandedById, [projectBKey])).toBe(false);
  });

  it("keeps another window's visit mark when this window writes over a stale copy", () => {
    const loaded = makeUiState({ projectOrder: ["physical-a"] });
    persistState(loaded);
    const otherWindow = {
      ...loaded,
      threadLastVisitedAtById: { "environment:thread-2": "2026-02-25T12:35:00.000Z" },
    };
    localStorageStub.setItem(PERSISTED_STATE_KEY, JSON.stringify(otherWindow));

    persistState({ ...loaded, projectOrder: ["physical-b", "physical-a"] });

    const persisted = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState,
    );
    expect(persisted.projectOrder).toEqual(["physical-b", "physical-a"]);
    expect(persisted.threadLastVisitedAtById).toEqual({
      "environment:thread-2": "2026-02-25T12:35:00.000Z",
    });
  });

  it("keeps a pending change when another window writes during the debounce", () => {
    vi.useFakeTimers();
    useUiStateStore.getState().setProjectExpanded("mine", false);
    const otherWindow = JSON.stringify({
      ...makeUiState(),
      threadLastVisitedAtById: { "environment:thread-2": "2026-02-25T12:35:00.000Z" },
    });
    localStorageStub.setItem(PERSISTED_STATE_KEY, otherWindow);
    adoptUiStateFromOtherWindow(otherWindow);

    expect(useUiStateStore.getState().projectExpandedById.mine).toBe(false);
    vi.advanceTimersByTime(500);

    const persisted = parsePersistedState(
      JSON.parse(localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}") as PersistedUiState,
    );
    expect(persisted.projectExpandedById.mine).toBe(false);
    expect(persisted.threadLastVisitedAtById["environment:thread-2"]).toBe(
      "2026-02-25T12:35:00.000Z",
    );
  });

  it("schedules no write when it adopts another window's write", () => {
    vi.useFakeTimers();
    const otherWindow = JSON.stringify({ ...makeUiState(), projectOrder: ["physical-c"] });
    localStorageStub.setItem(PERSISTED_STATE_KEY, otherWindow);
    const setItem = vi.spyOn(localStorageStub, "setItem");

    adoptUiStateFromOtherWindow(otherWindow);
    vi.advanceTimersByTime(500);

    expect(useUiStateStore.getState().projectOrder).toEqual(["physical-c"]);
    expect(setItem).not.toHaveBeenCalled();
  });
});
