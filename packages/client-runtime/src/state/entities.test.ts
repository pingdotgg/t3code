import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import {
  InvalidScopedProjectKeyError,
  InvalidScopedProjectRefCollectionKeyError,
  InvalidScopedThreadKeyError,
  parseProjectKey,
  parseProjectRefCollectionKey,
  parseThreadKey,
} from "./entities.ts";
import type { EnvironmentShellState } from "./shell.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threads.ts";
import { createEnvironmentProjectAtoms } from "./projectEntities.ts";
import { createEnvironmentSnapshotAtom } from "./snapshots.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { mergeEnvironmentThread } from "./threadDetail.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const THREAD_ID = ThreadId.make("thread-1");
const OTHER_THREAD_ID = ThreadId.make("thread-2");

describe("scoped entity keys", () => {
  it("preserves an invalid project key as structured error data", () => {
    const key = "missing-project-key-separator";
    let error: unknown;

    try {
      parseProjectKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toEqual(new InvalidScopedProjectKeyError({ key }));
  });

  it("preserves an invalid thread key as structured error data", () => {
    const key = "missing-thread-key-separator";
    let error: unknown;

    try {
      parseThreadKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toEqual(new InvalidScopedThreadKeyError({ key }));
  });

  it("preserves malformed project reference collection input and its cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseProjectRefCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidScopedProjectRefCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.anything() });
  });

  it("rejects invalid project reference collection shapes", () => {
    const key = JSON.stringify([["environment-1"]]);

    expect(() => parseProjectRefCollectionKey(key)).toThrowError(
      InvalidScopedProjectRefCollectionKeyError,
    );
  });
});

const THREAD_SHELL = {
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as const;

const SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: "2026-06-01T00:00:00.000Z",
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: OTHER_PROJECT_ID,
      title: "Other project",
      workspaceRoot: "/other-repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  threads: [
    THREAD_SHELL,
    {
      ...THREAD_SHELL,
      id: OTHER_THREAD_ID,
      projectId: OTHER_PROJECT_ID,
      title: "Other thread",
    },
  ],
};

function shellState(snapshot: OrchestrationShellSnapshot): EnvironmentShellState {
  return {
    snapshot: Option.some(snapshot),
    status: "live",
    error: Option.none(),
  };
}

function makeHarness(environmentIds: ReadonlyArray<EnvironmentId> = [ENVIRONMENT_ID]) {
  const shellStateAtoms = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(AsyncResult.success(shellState(SNAPSHOT))),
  );
  const threadStateAtoms = Atom.family((_key: string) =>
    Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map(
      environmentIds.map((environmentId) => [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
        },
      ]),
    ),
  });
  const snapshotAtom = createEnvironmentSnapshotAtom(shellStateAtoms);
  const projects = createEnvironmentProjectAtoms({
    catalogValueAtom,
    snapshotAtom,
  });
  const threadShells = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom,
  });
  const threadDetails = createEnvironmentThreadDetailAtoms((environmentId, threadId) =>
    threadStateAtoms(`${environmentId}\u0000${threadId}`),
  );

  return {
    registry: AtomRegistry.make(),
    catalogValueAtom,
    shellStateAtom: shellStateAtoms(ENVIRONMENT_ID),
    shellStateAtomForEnvironment: shellStateAtoms,
    threadStateAtom: (threadId: ThreadId) => threadStateAtoms(`${ENVIRONMENT_ID}\u0000${threadId}`),
    projects,
    threadShells,
    threadDetails,
  };
}

describe("environment entity projections", () => {
  it("composes detail collections with authoritative shell workspace metadata", () => {
    const messages: OrchestrationThread["messages"] = [];
    const detail = {
      ...THREAD_SHELL,
      environmentId: ENVIRONMENT_ID,
      title: "Cached thread",
      branch: "stale-branch",
      worktreePath: "/repo/stale-worktree",
      deletedAt: null,
      messages,
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    } satisfies OrchestrationThread & { readonly environmentId: EnvironmentId };
    const shell = {
      ...THREAD_SHELL,
      environmentId: ENVIRONMENT_ID,
      title: "Current thread",
      branch: "current-branch",
      worktreePath: "/repo/current-worktree",
    };

    const merged = mergeEnvironmentThread(detail, shell);

    expect(merged).toMatchObject({
      title: "Current thread",
      branch: "current-branch",
      worktreePath: "/repo/current-worktree",
    });
    expect(merged?.messages).toBe(messages);
  });

  it("preserves untouched project and thread identities across unrelated shell updates", () => {
    const harness = makeHarness();
    const projectRefsAtom = harness.projects.environmentProjectRefsAtom(ENVIRONMENT_ID);
    const threadRefsAtom = harness.threadShells.environmentThreadRefsAtom(ENVIRONMENT_ID);
    const projectsAtom = harness.projects.projectsAtom;
    const projectAtom = harness.projects.projectAtom({
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
    });
    const threadAtom = harness.threadShells.threadShellAtom({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    });
    const projectRefs = harness.registry.get(projectRefsAtom);
    const threadRefs = harness.registry.get(threadRefsAtom);
    const projects = harness.registry.get(projectsAtom);
    const project = harness.registry.get(projectAtom);
    const thread = harness.registry.get(threadAtom);

    harness.registry.set(
      harness.shellStateAtom,
      AsyncResult.success(
        shellState({
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: SNAPSHOT.threads.map((candidate) =>
            candidate.id === OTHER_THREAD_ID
              ? { ...candidate, title: "Renamed other thread" }
              : candidate,
          ),
        }),
      ),
    );

    expect(harness.registry.get(projectRefsAtom)).toBe(projectRefs);
    expect(harness.registry.get(threadRefsAtom)).toBe(threadRefs);
    expect(harness.registry.get(projectsAtom)).toBe(projects);
    expect(harness.registry.get(projectAtom)).toBe(project);
    expect(harness.registry.get(threadAtom)).toBe(thread);
  });

  it("preserves project-scoped thread collections across unrelated project updates", () => {
    const harness = makeHarness();
    const projectRef = {
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
    };
    const refsByProjectAtom =
      harness.threadShells.environmentThreadRefsByProjectAtom(ENVIRONMENT_ID);
    const threadsAtom = harness.threadShells.threadShellsForProjectRefsAtom([projectRef]);
    const membership = harness.registry.get(refsByProjectAtom);
    const refs = membership.get(PROJECT_ID);
    const threads = harness.registry.get(threadsAtom);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe(THREAD_ID);

    harness.registry.set(
      harness.shellStateAtom,
      AsyncResult.success(
        shellState({
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: SNAPSHOT.threads.map((thread) =>
            thread.id === OTHER_THREAD_ID ? { ...thread, title: "Updated elsewhere" } : thread,
          ),
        }),
      ),
    );

    expect(harness.registry.get(refsByProjectAtom).get(PROJECT_ID)).toBe(refs);
    expect(harness.registry.get(refsByProjectAtom)).toBe(membership);
    expect(harness.registry.get(threadsAtom)).toBe(threads);
  });

  it("shares list values with point reads without retaining one atom per listed thread", () => {
    const harness = makeHarness();
    let snapshot: OrchestrationShellSnapshot = {
      ...SNAPSHOT,
      threads: Array.from({ length: 200 }, (_, index) => ({
        ...THREAD_SHELL,
        id: ThreadId.make(`listed-${index}`),
      })),
    };
    harness.registry.set(harness.shellStateAtom, AsyncResult.success(shellState(snapshot)));
    const listAtom = harness.threadShells.threadShellsAtom;
    const projectListAtom = harness.threadShells.threadShellsForProjectRefsAtom([
      { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    const disposeProjectList = harness.registry.mount(projectListAtom);
    try {
      const before = harness.registry.get(listAtom);
      expect(before).toHaveLength(200);
      expect(harness.registry.get(projectListAtom)).toEqual(before);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
      const firstAtom = harness.threadShells.threadShellAtom({
        environmentId: ENVIRONMENT_ID,
        threadId: snapshot.threads[0]!.id,
      });
      expect(harness.registry.get(firstAtom)).toBe(before[0]);

      snapshot = applyShellStreamEvent(snapshot, {
        kind: "thread-upserted",
        sequence: 2,
        thread: { ...snapshot.threads.at(-1)!, title: "Updated last thread" },
      });
      harness.registry.set(harness.shellStateAtom, AsyncResult.success(shellState(snapshot)));
      const after = harness.registry.get(listAtom);
      expect(after[0]).toBe(before[0]);
      expect(after.at(-1)).not.toBe(before.at(-1));
      expect(after.at(-1)?.title).toBe("Updated last thread");
      expect(harness.registry.get(projectListAtom).at(-1)).toBe(after.at(-1));
      expect(harness.registry.get(firstAtom)).toBe(after[0]);
      expect(harness.registry.getNodes().size).toBeLessThan(20);
    } finally {
      disposeProjectList();
      disposeList();
      harness.registry.dispose();
    }
  });

  it("keeps scoped identities and list order across project and environment changes", () => {
    const remoteEnvironmentId = EnvironmentId.make("remote-environment");
    const harness = makeHarness([ENVIRONMENT_ID, remoteEnvironmentId]);
    const listAtom = harness.threadShells.threadShellsAtom;
    const localRef = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
    const remoteRef = { environmentId: remoteEnvironmentId, threadId: THREAD_ID };
    const selectedAtom = harness.threadShells.threadShellsForProjectRefsAtom([
      { environmentId: remoteEnvironmentId, projectId: PROJECT_ID },
      { environmentId: ENVIRONMENT_ID, projectId: OTHER_PROJECT_ID },
      { environmentId: remoteEnvironmentId, projectId: PROJECT_ID },
      { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
    ]);
    const disposeList = harness.registry.mount(listAtom);
    const disposeSelected = harness.registry.mount(selectedAtom);
    try {
      const original = harness.registry.get(listAtom);
      const local = harness.registry.get(harness.threadShells.threadShellAtom(localRef));
      const remote = harness.registry.get(harness.threadShells.threadShellAtom(remoteRef));
      expect(original).toHaveLength(4);
      expect(original[0]).toBe(local);
      expect(original[2]).toBe(remote);
      expect(local).not.toBe(remote);
      expect(local?.environmentId).toBe(ENVIRONMENT_ID);
      expect(remote?.environmentId).toBe(remoteEnvironmentId);
      expect(harness.registry.get(selectedAtom)).toEqual([remote, original[1], local]);

      harness.registry.set(
        harness.shellStateAtomForEnvironment(remoteEnvironmentId),
        AsyncResult.success(shellState({ ...SNAPSHOT, threads: SNAPSHOT.threads.toReversed() })),
      );
      expect([
        ...harness.registry
          .get(harness.threadShells.environmentThreadRefsByProjectAtom(remoteEnvironmentId))
          .keys(),
      ]).toEqual([OTHER_PROJECT_ID, PROJECT_ID]);
      harness.registry.set(
        harness.shellStateAtomForEnvironment(remoteEnvironmentId),
        AsyncResult.success(shellState(SNAPSHOT)),
      );

      let snapshot = applyShellStreamEvent(SNAPSHOT, {
        kind: "thread-upserted",
        sequence: 2,
        thread: { ...THREAD_SHELL, projectId: OTHER_PROJECT_ID, title: "Moved thread" },
      });
      harness.registry.set(harness.shellStateAtom, AsyncResult.success(shellState(snapshot)));
      const moved = harness.registry.get(harness.threadShells.threadShellAtom(localRef));
      expect(harness.registry.get(selectedAtom)).toEqual([remote, moved, original[1]]);
      expect(harness.registry.get(listAtom)[2]).toBe(remote);

      snapshot = applyShellStreamEvent(snapshot, {
        kind: "thread-removed",
        sequence: 3,
        threadId: OTHER_THREAD_ID,
      });
      harness.registry.set(harness.shellStateAtom, AsyncResult.success(shellState(snapshot)));
      expect(harness.registry.get(selectedAtom)).toEqual([remote, moved]);
      expect(
        harness.registry.get(
          harness.threadShells.threadShellAtom({
            environmentId: ENVIRONMENT_ID,
            threadId: OTHER_THREAD_ID,
          }),
        ),
      ).toBeNull();

      const createdId = ThreadId.make("created-thread");
      snapshot = applyShellStreamEvent(snapshot, {
        kind: "thread-upserted",
        sequence: 4,
        thread: { ...THREAD_SHELL, id: createdId },
      });
      harness.registry.set(harness.shellStateAtom, AsyncResult.success(shellState(snapshot)));
      const created = harness.registry.get(listAtom)[1];
      expect(created?.id).toBe(createdId);
      expect(harness.registry.get(selectedAtom)).toEqual([remote, moved, created]);

      const catalog = harness.registry.get(harness.catalogValueAtom);
      harness.registry.set(harness.catalogValueAtom, {
        ...catalog,
        entries: new Map([...catalog.entries].toReversed()),
      });
      expect(harness.registry.get(listAtom)).toEqual([remote, original[3], moved, created]);
      harness.registry.set(harness.catalogValueAtom, {
        ...catalog,
        entries: new Map([[remoteEnvironmentId, catalog.entries.get(remoteEnvironmentId)!]]),
      });
      expect(harness.registry.get(listAtom)).toEqual([remote, original[3]]);
      harness.registry.set(
        harness.shellStateAtomForEnvironment(remoteEnvironmentId),
        AsyncResult.success(shellState({ ...SNAPSHOT, threads: [] })),
      );
      expect(harness.registry.get(listAtom)).toEqual([]);
      expect(harness.registry.get(harness.threadShells.threadShellAtom(remoteRef))).toBeNull();
    } finally {
      disposeSelected();
      disposeList();
      harness.registry.dispose();
    }
  });

  it("updates only the requested thread detail and preserves untouched field identities", () => {
    const harness = makeHarness();
    const threadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
    };
    const otherThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: OTHER_THREAD_ID,
    };
    const threadDetailAtom = harness.threadDetails.detailAtom(threadRef);
    const messagesAtom = harness.threadDetails.messagesAtom(threadRef);
    const activitiesAtom = harness.threadDetails.activitiesAtom(threadRef);
    const statusAtom = harness.threadDetails.statusAtom(threadRef);
    const otherThreadDetailAtom = harness.threadDetails.detailAtom(otherThreadRef);
    const otherValue = harness.registry.get(otherThreadDetailAtom);
    const detail = {
      ...THREAD_SHELL,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    } satisfies OrchestrationThread;

    harness.registry.set(
      harness.threadStateAtom(THREAD_ID),
      AsyncResult.success<EnvironmentThreadState>({
        data: Option.some(detail),
        status: "live",
        error: Option.none(),
        page: Option.none(),
      }),
    );

    const scopedDetail = harness.registry.get(threadDetailAtom);
    const messages = harness.registry.get(messagesAtom);
    const activities = harness.registry.get(activitiesAtom);

    expect(scopedDetail).toEqual({ ...detail, environmentId: ENVIRONMENT_ID });
    expect(harness.registry.get(statusAtom)).toBe("live");
    expect(harness.registry.get(otherThreadDetailAtom)).toBe(otherValue);

    harness.registry.set(
      harness.threadStateAtom(THREAD_ID),
      AsyncResult.success<EnvironmentThreadState>({
        data: Option.some({
          ...detail,
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-06-01T00:01:00.000Z",
          },
        }),
        status: "live",
        error: Option.none(),
        page: Option.none(),
      }),
    );

    expect(harness.registry.get(messagesAtom)).toBe(messages);
    expect(harness.registry.get(activitiesAtom)).toBe(activities);
  });
});
