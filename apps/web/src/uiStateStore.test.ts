import { ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearThreadUi,
  hydratePersistedProjectState,
  markThreadUnread,
  PERSISTED_STATE_KEY,
  type PersistedUiState,
  persistState,
  reorderProjects,
  setProjectExpanded,
  setThreadChangedFilesExpanded,
  syncProjects,
  syncThreads,
  type UiState,
} from "./uiStateStore";

function makeUiState(overrides: Partial<UiState> = {}): UiState {
  return {
    projectExpandedById: {},
    projectOrder: [],
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    ...overrides,
  };
}

describe("uiStateStore pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const threadId = ThreadId.make("thread-1");
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, latestTurnCompletedAt);

    expect(next.threadLastVisitedAtById[threadId]).toBe("2026-02-25T12:29:59.999Z");
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const threadId = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [threadId]: "2026-02-25T12:35:00.000Z",
      },
    });

    const next = markThreadUnread(initialState, threadId, null);

    expect(next).toBe(initialState);
  });

  it("reorderProjects moves a project to a target index", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const initialState = makeUiState({
      projectOrder: [project1, project2, project3],
    });

    const next = reorderProjects(initialState, [project1], [project3]);

    expect(next.projectOrder).toEqual([project2, project3, project1]);
  });

  it("reorderProjects is a no-op when dragged key is not in projectOrder", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const initialState = makeUiState({
      projectOrder: [project1, project2],
    });

    const next = reorderProjects(initialState, [ProjectId.make("missing")], [project2]);

    expect(next).toBe(initialState);
  });

  it("reorderProjects moves all member keys of a multi-member group together", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyB, keyC],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("reorderProjects handles member keys scattered across projectOrder", () => {
    const keyALocal = "env-local:proj-a";
    const keyB = "env-local:proj-b";
    const keyARemote = "env-remote:proj-a";
    const keyC = "env-local:proj-c";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyB, keyARemote, keyC],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote]);
  });

  it("reorderProjects places group after target when dragged from before a non-last target", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const keyD = "env-local:proj-d";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyB, keyC, keyD],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyC]);

    expect(next.projectOrder).toEqual([keyB, keyC, keyALocal, keyARemote, keyD]);
  });

  it("reorderProjects places group before target when dragged from after", () => {
    const keyB = "env-local:proj-b";
    const keyC = "env-local:proj-c";
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const initialState = makeUiState({
      projectOrder: [keyB, keyC, keyALocal, keyARemote],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyB]);

    expect(next.projectOrder).toEqual([keyALocal, keyARemote, keyB, keyC]);
  });

  it("reorderProjects with multi-member target inserts after first target occurrence", () => {
    const keyALocal = "env-local:proj-a";
    const keyARemote = "env-remote:proj-a";
    const keyBLocal = "env-local:proj-b";
    const keyBRemote = "env-remote:proj-b";
    const initialState = makeUiState({
      projectOrder: [keyALocal, keyARemote, keyBLocal, keyBRemote],
    });

    const next = reorderProjects(initialState, [keyALocal, keyARemote], [keyBLocal, keyBRemote]);

    // Target members may become non-contiguous; this is fine because the
    // sidebar groups by logical key using first-occurrence positioning.
    expect(next.projectOrder).toEqual([keyBLocal, keyALocal, keyARemote, keyBRemote]);
  });

  it("reorderProjects is a no-op when dragged group equals target group", () => {
    const key1 = "env-local:proj-a";
    const key2 = "env-remote:proj-a";
    const initialState = makeUiState({
      projectOrder: [key1, key2, "env-local:proj-b"],
    });

    const next = reorderProjects(initialState, [key1, key2], [key1, key2]);

    expect(next).toBe(initialState);
  });

  it("reorderProjects is a no-op when dragged keys are not in projectOrder", () => {
    const initialState = makeUiState({
      projectOrder: ["env-local:proj-a", "env-local:proj-b"],
    });

    const next = reorderProjects(initialState, ["env-local:missing"], ["env-local:proj-b"]);

    expect(next).toBe(initialState);
  });

  it("syncProjects preserves current project order during snapshot recovery", () => {
    const project1 = ProjectId.make("project-1");
    const project2 = ProjectId.make("project-2");
    const project3 = ProjectId.make("project-3");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
        [project2]: false,
      },
      projectOrder: [project2, project1],
    });

    const next = syncProjects(initialState, [
      { key: project1, logicalKey: project1, cwd: "/tmp/project-1" },
      { key: project2, logicalKey: project2, cwd: "/tmp/project-2" },
      { key: project3, logicalKey: project3, cwd: "/tmp/project-3" },
    ]);

    expect(next.projectOrder).toEqual([project2, project1, project3]);
    expect(next.projectExpandedById[project2]).toBe(false);
  });

  it("syncProjects preserves manual order across project id churn at the same cwd", () => {
    // Under the current design, physical key and logical key are both
    // cwd-derived, so an internal project-id change doesn't alter the store
    // keys. This test locks in that stability: re-syncing the same cwds keeps
    // manual order and collapse state.
    const keyProject1 = "env-local:/tmp/project-1";
    const keyProject2 = "env-local:/tmp/project-2";
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [keyProject1]: true,
          [keyProject2]: false,
        },
        projectOrder: [keyProject2, keyProject1],
      }),
      [
        { key: keyProject1, logicalKey: keyProject1, cwd: "/tmp/project-1" },
        { key: keyProject2, logicalKey: keyProject2, cwd: "/tmp/project-2" },
      ],
    );

    const next = syncProjects(initialState, [
      { key: keyProject1, logicalKey: keyProject1, cwd: "/tmp/project-1" },
      { key: keyProject2, logicalKey: keyProject2, cwd: "/tmp/project-2" },
    ]);

    expect(next.projectOrder).toEqual([keyProject2, keyProject1]);
    expect(next.projectExpandedById[keyProject2]).toBe(false);
  });

  it("syncProjects returns a new state when only project cwd changes", () => {
    const project1 = ProjectId.make("project-1");
    const initialState = syncProjects(
      makeUiState({
        projectExpandedById: {
          [project1]: false,
        },
        projectOrder: [project1],
      }),
      [{ key: project1, logicalKey: project1, cwd: "/tmp/project-1" }],
    );

    const next = syncProjects(initialState, [
      { key: project1, logicalKey: project1, cwd: "/tmp/project-1-renamed" },
    ]);

    expect(next).not.toBe(initialState);
    expect(next.projectOrder).toEqual([project1]);
    expect(next.projectExpandedById[project1]).toBe(false);
  });

  it("syncProjects keys projectExpandedById by the logical key, not the physical key", () => {
    // In repository grouping mode, multiple physical projects (different
    // environments or different repo-relative paths) collapse into one
    // logical group. The group's expand state must be keyed by the logical
    // key so clicks on the grouped row toggle the shared state, and so the
    // state survives subsequent syncProjects calls (which rebuild the map
    // from incoming inputs).
    const physicalLocal = "env-local:/repo/project";
    const physicalRemote = "env-remote:/repo/project";
    const logicalKey = "repo-canonical-key";

    const initial = syncProjects(makeUiState(), [
      { key: physicalLocal, logicalKey, cwd: "/repo/project" },
      { key: physicalRemote, logicalKey, cwd: "/repo/project" },
    ]);

    expect(initial.projectExpandedById).toEqual({ [logicalKey]: true });

    const afterCollapse = { ...initial, projectExpandedById: { [logicalKey]: false } };
    const next = syncProjects(afterCollapse, [
      { key: physicalLocal, logicalKey, cwd: "/repo/project" },
      { key: physicalRemote, logicalKey, cwd: "/repo/project" },
    ]);

    expect(next.projectExpandedById[logicalKey]).toBe(false);
  });

  it("syncProjects preserves expand state when a project's logical key changes", () => {
    // Example: late-arriving repo metadata flips grouping identity from the
    // physical key to a canonical repository key. The row did not actually
    // change, so the user's collapse choice must carry over.
    const physicalKey = "env-local:/repo/project";
    const previousLogicalKey = physicalKey;
    const nextLogicalKey = "repo-canonical-key";

    const initial = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: previousLogicalKey, cwd: "/repo/project" },
    ]);

    expect(initial.projectExpandedById[previousLogicalKey]).toBe(true);

    const afterCollapse = {
      ...initial,
      projectExpandedById: { [previousLogicalKey]: false },
    };
    const next = syncProjects(afterCollapse, [
      { key: physicalKey, logicalKey: nextLogicalKey, cwd: "/repo/project" },
    ]);

    expect(next.projectExpandedById[nextLogicalKey]).toBe(false);
  });

  it("syncThreads prunes missing thread UI state", () => {
    const thread1 = ThreadId.make("thread-1");
    const thread2 = ThreadId.make("thread-2");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
        [thread2]: "2026-02-25T12:36:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
        [thread2]: {
          "turn-2": false,
        },
      },
    });

    const next = syncThreads(initialState, [{ key: thread1 }]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
  });

  it("syncThreads seeds visit state for unseen snapshot threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = syncThreads(initialState, [
      {
        key: thread1,
        seedVisitedAt: "2026-02-25T12:35:00.000Z",
      },
    ]);

    expect(next.threadLastVisitedAtById).toEqual({
      [thread1]: "2026-02-25T12:35:00.000Z",
    });
  });

  it("setProjectExpanded updates expansion without touching order", () => {
    const project1 = ProjectId.make("project-1");
    const initialState = makeUiState({
      projectExpandedById: {
        [project1]: true,
      },
      projectOrder: [project1],
    });

    const next = setProjectExpanded(initialState, project1, false);

    expect(next.projectExpandedById[project1]).toBe(false);
    expect(next.projectOrder).toEqual([project1]);
  });

  it("clearThreadUi removes visit state for deleted threads", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadLastVisitedAtById: {
        [thread1]: "2026-02-25T12:35:00.000Z",
      },
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
    });

    const next = clearThreadUi(initialState, thread1);

    expect(next.threadLastVisitedAtById).toEqual({});
    expect(next.threadChangedFilesExpandedById).toEqual({});
  });

  it("setThreadChangedFilesExpanded stores collapsed turns per thread", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState();

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", false);

    expect(next.threadChangedFilesExpandedById).toEqual({
      [thread1]: {
        "turn-1": false,
      },
    });
  });

  it("setThreadChangedFilesExpanded removes thread overrides when expanded again", () => {
    const thread1 = ThreadId.make("thread-1");
    const initialState = makeUiState({
      threadChangedFilesExpandedById: {
        [thread1]: {
          "turn-1": false,
        },
      },
    });

    const next = setThreadChangedFilesExpanded(initialState, thread1, "turn-1", true);

    expect(next.threadChangedFilesExpandedById).toEqual({});
  });
});

describe("uiStateStore persistence round-trip", () => {
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

  let localStorageStub: Storage;

  beforeEach(() => {
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", { localStorage: localStorageStub });
    vi.stubGlobal("localStorage", localStorageStub);
    // Reset module-level persistence state so tests don't bleed into each other.
    hydratePersistedProjectState({ collapsedProjectCwds: [], expandedProjectCwds: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves all-collapsed project state across restart", () => {
    // Regression: pre-fix, persistState only wrote `expandedProjectCwds`, so
    // an empty array on rehydrate was indistinguishable from a fresh install
    // and the syncProjects fallback re-expanded every row.
    const projectA = { key: "kA", logicalKey: "kA", cwd: "/projA" };
    const projectB = { key: "kB", logicalKey: "kB", cwd: "/projB" };

    let state = syncProjects(makeUiState(), [projectA, projectB]);
    state = setProjectExpanded(state, projectA.key, false);
    state = setProjectExpanded(state, projectB.key, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB]);

    expect(rehydrated.projectExpandedById).toEqual({
      [projectA.key]: false,
      [projectB.key]: false,
    });
  });

  it("respects mixed expand state on rehydrate and defaults new projects to expanded", () => {
    const projectA = { key: "kA", logicalKey: "kA", cwd: "/projA" };
    const projectB = { key: "kB", logicalKey: "kB", cwd: "/projB" };
    const projectC = { key: "kC", logicalKey: "kC", cwd: "/projC" };

    let state = syncProjects(makeUiState(), [projectA, projectB]);
    state = setProjectExpanded(state, projectB.key, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB, projectC]);

    expect(rehydrated.projectExpandedById).toEqual({
      [projectA.key]: true,
      [projectB.key]: false,
      [projectC.key]: true,
    });
  });

  it("preserves legacy not-in-expanded-list = collapsed for one upgrade session", () => {
    // Pre-fix shape only stored expandedProjectCwds. Absence of
    // collapsedProjectCwds opts the session into the legacy fallback so
    // upgrade users do not see previously collapsed rows pop open.
    hydratePersistedProjectState({
      expandedProjectCwds: ["/projA"],
    });

    const rehydrated = syncProjects(makeUiState(), [
      { key: "kA", logicalKey: "kA", cwd: "/projA" },
      { key: "kB", logicalKey: "kB", cwd: "/projB" },
    ]);

    expect(rehydrated.projectExpandedById).toEqual({
      kA: true,
      kB: false,
    });
  });

  it("preserves manual project order across restart", () => {
    const projectA = { key: "kOrderA", logicalKey: "kOrderA", cwd: "/order-projA" };
    const projectB = { key: "kOrderB", logicalKey: "kOrderB", cwd: "/order-projB" };
    const projectC = { key: "kOrderC", logicalKey: "kOrderC", cwd: "/order-projC" };

    let state = syncProjects(makeUiState(), [projectA, projectB, projectC]);
    state = reorderProjects(state, [projectC.key], [projectA.key]);
    expect(state.projectOrder).toEqual([projectC.key, projectA.key, projectB.key]);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    expect(persisted.projectOrderCwds).toEqual([projectC.cwd, projectA.cwd, projectB.cwd]);

    hydratePersistedProjectState(persisted);
    // Fresh state (empty projectOrder) so syncProjects derives order from
    // persistedProjectOrderCwds rather than the in-memory projectOrder branch.
    const rehydrated = syncProjects(makeUiState(), [projectA, projectB, projectC]);

    expect(rehydrated.projectOrder).toEqual([projectC.key, projectA.key, projectB.key]);
  });

  it("preserves expand state across restart when project's logical key changes", () => {
    // After restart, in-memory previousExpandedById is empty, so the
    // previousLogicalKey-to-state bridge in syncProjects cannot help. The
    // persisted-cwd fallback is the only mechanism that can carry collapse
    // state across a restart that also flips a project into a new logical
    // group (e.g. late-arriving repo metadata). This locks in that path.
    const physicalKey = "env-local:/lk-restart-proj";
    const previousLogicalKey = physicalKey;
    const cwd = "/lk-restart-proj";

    let state = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: previousLogicalKey, cwd },
    ]);
    state = setProjectExpanded(state, previousLogicalKey, false);
    persistState(state);

    const persisted = JSON.parse(
      localStorageStub.getItem(PERSISTED_STATE_KEY) ?? "{}",
    ) as PersistedUiState;
    hydratePersistedProjectState(persisted);

    const nextLogicalKey = "lk-restart-canonical";
    const rehydrated = syncProjects(makeUiState(), [
      { key: physicalKey, logicalKey: nextLogicalKey, cwd },
    ]);

    expect(rehydrated.projectExpandedById[nextLogicalKey]).toBe(false);
  });
});
