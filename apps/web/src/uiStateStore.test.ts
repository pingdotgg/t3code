import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  legacyProjectCwdPreferenceKey,
  markActiveThreadVisited,
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
  setThreadChangedFilesExpanded,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadLastVisitedAtById: {},
    threadExplicitlyUnreadById: {},
    threadChangedFilesExpandedById: {},
    hasTrackedActiveThreadRoute: false,
    activeThreadVisit: null,
    defaultAdvertisedEndpointKey: null,
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

  it("marks any thread explicitly unread without requiring a completion timestamp", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, "2026-02-25T12:30:00.000Z");

    expect(next.threadExplicitlyUnreadById[threadId]).toBe(true);
    expect(next.threadLastVisitedAtById).toBe(initialState.threadLastVisitedAtById);
    expect(markThreadUnread(next, threadId, null)).toBe(next);
  });

  it("keeps an active thread unread until its route or update changes", () => {
    const threadId = ThreadId.make("thread-1");
    const otherThreadId = ThreadId.make("thread-2");
    const updatedAt = "2026-02-25T12:30:00.000Z";
    const active = markActiveThreadVisited(makeUiState(), threadId, updatedAt);
    const unread = markThreadUnread(active, threadId, null);

    expect(markActiveThreadVisited(unread, threadId, updatedAt)).toBe(unread);
    expect(unread.threadExplicitlyUnreadById[threadId]).toBe(true);

    const away = markActiveThreadVisited(unread, otherThreadId, null);
    const returned = markActiveThreadVisited(away, threadId, updatedAt);
    expect(returned.threadExplicitlyUnreadById[threadId]).toBeUndefined();
  });

  it("preserves persisted unread state through initial route hydration", () => {
    const threadId = ThreadId.make("thread-1");
    const updatedAt = "2026-02-25T12:30:00.000Z";
    const restarted = parsePersistedState({
      threadLastVisitedAtById: { [threadId]: updatedAt },
      threadExplicitlyUnreadById: { [threadId]: true },
    });

    const routed = markActiveThreadVisited(restarted, threadId, null);
    const hydrated = markActiveThreadVisited(routed, threadId, updatedAt);

    expect(routed.threadExplicitlyUnreadById[threadId]).toBe(true);
    expect(hydrated.threadExplicitlyUnreadById[threadId]).toBe(true);
    expect(hydrated.activeThreadVisit).toEqual({ threadId, visitedAt: updatedAt });
  });

  it("preserves persisted unread when a draft promotes to the same thread", () => {
    const threadId = ThreadId.make("thread-1");
    const updatedAt = "2026-02-25T12:30:00.000Z";
    const restarted = parsePersistedState({
      threadLastVisitedAtById: { [threadId]: updatedAt },
      threadExplicitlyUnreadById: { [threadId]: true },
    });

    const draft = markActiveThreadVisited(restarted, threadId, null);
    const routed = markActiveThreadVisited(draft, threadId, null);
    const hydrated = markActiveThreadVisited(routed, threadId, updatedAt);

    expect(draft.hasTrackedActiveThreadRoute).toBe(true);
    expect(routed.threadExplicitlyUnreadById[threadId]).toBe(true);
    expect(hydrated.threadExplicitlyUnreadById[threadId]).toBe(true);
    expect(hydrated.activeThreadVisit).toEqual({ threadId, visitedAt: updatedAt });
  });

  it("clears persisted unread after tracking a non-chat route", () => {
    const threadId = ThreadId.make("thread-1");
    const updatedAt = "2026-02-25T12:30:00.000Z";
    const restarted = parsePersistedState({
      threadLastVisitedAtById: { [threadId]: updatedAt },
      threadExplicitlyUnreadById: { [threadId]: true },
    });

    const nonChatRoute = markActiveThreadVisited(restarted, null, null);
    const routed = markActiveThreadVisited(nonChatRoute, threadId, null);
    const hydrated = markActiveThreadVisited(routed, threadId, updatedAt);

    expect(nonChatRoute.hasTrackedActiveThreadRoute).toBe(true);
    expect(routed.threadExplicitlyUnreadById[threadId]).toBeUndefined();
    expect(hydrated.threadExplicitlyUnreadById[threadId]).toBeUndefined();
  });

  it("preserves active unread state through a transient detail gap", () => {
    const threadId = ThreadId.make("thread-1");
    const updatedAt = "2026-02-25T12:30:00.000Z";
    const active = markActiveThreadVisited(makeUiState(), threadId, updatedAt);
    const unread = markThreadUnread(active, threadId, null);

    const missing = markActiveThreadVisited(unread, threadId, null);
    const restored = markActiveThreadVisited(missing, threadId, updatedAt);

    expect(missing).toBe(unread);
    expect(restored).toBe(unread);
    expect(restored.threadExplicitlyUnreadById[threadId]).toBe(true);
  });

  it("clears explicit unread after leaving and returning to the same route", () => {
    const threadId = ThreadId.make("thread-1");
    const updatedAt = "2026-02-25T12:30:00.000Z";
    const active = markActiveThreadVisited(makeUiState(), threadId, updatedAt);
    const unread = markThreadUnread(active, threadId, null);

    const away = markActiveThreadVisited(unread, null, null);
    const returned = markActiveThreadVisited(away, threadId, updatedAt);

    expect(returned.threadExplicitlyUnreadById[threadId]).toBeUndefined();
  });

  it("clears explicit unread when the active thread updates", () => {
    const threadId = ThreadId.make("thread-1");
    const active = markActiveThreadVisited(makeUiState(), threadId, "2026-02-25T12:30:00.000Z");
    const unread = markThreadUnread(active, threadId, null);
    const updated = markActiveThreadVisited(unread, threadId, "2026-02-25T12:35:00.000Z");

    expect(updated.threadExplicitlyUnreadById[threadId]).toBeUndefined();
    expect(updated.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:35:00.000Z");
  });

  it("preserves explicit unread when an active visit timestamp regresses", () => {
    const threadId = ThreadId.make("thread-1");
    const active = markActiveThreadVisited(makeUiState(), threadId, "2026-02-25T12:35:00.000Z");
    const unread = markThreadUnread(active, threadId, null);

    const stale = markActiveThreadVisited(unread, threadId, "2026-02-25T12:30:00.000Z");

    expect(stale).toBe(unread);
    expect(stale.threadExplicitlyUnreadById[threadId]).toBe(true);
    expect(stale.activeThreadVisit).toEqual({
      threadId,
      visitedAt: "2026-02-25T12:35:00.000Z",
    });
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
      threadExplicitlyUnreadById: {
        "environment:thread-1": true,
        read: false,
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 1,
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
      threadExplicitlyUnreadById: {
        "environment:thread-1": true,
      },
      hasTrackedActiveThreadRoute: false,
      activeThreadVisit: null,
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
  });

  it("ignores changed-file expansion values saved with legacy folder semantics", () => {
    const parsed = parsePersistedState({
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
      threadExplicitlyUnreadById: {
        "environment:thread-1": true,
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
      threadExplicitlyUnreadById: {
        "environment:thread-1": true,
      },
      defaultAdvertisedEndpointKey: "desktop-core:lan:http",
      threadChangedFilesExpansionVersion: 1,
      threadChangedFilesExpandedById: {
        "environment:thread-1": {
          "turn-1": false,
          "turn-2": true,
        },
      },
    });
    expect(parsePersistedState(persisted)).toEqual({
      ...state,
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
});
