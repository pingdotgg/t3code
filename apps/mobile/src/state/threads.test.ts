import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeRawThreadShell } from "../test-fixtures";
import { appAtomRegistry } from "./atom-registry";
import { forgetThread } from "./forgotten-threads";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import {
  environmentThreadShells,
  startOpeningEnvironmentThread,
  steadyNavigationThreadShellsAtom,
} from "./threads";

const loads = vi.hoisted(() => [] as string[]);
const fixtures = vi.hoisted(() => ({ snapshotAtom: null as unknown }));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([["environment-1", { enabled: true }]]),
  }).pipe(Atom.keepAlive);
  const connectionAtom = Atom.make(AsyncResult.initial());
  return { environmentCatalog: { catalogValueAtom, stateAtom: () => connectionAtom } };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/reactivity");
  const shellState = Atom.make({ status: "live", generation: 1 }).pipe(Atom.keepAlive);
  return { environmentShell: { stateValueAtom: () => shellState } };
});
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  const noHiddenTags = Atom.make(null);
  return { serverEnvironment: { hiddenThreadTagsAtom: () => noHiddenTags } };
});
vi.mock("@t3tools/client-runtime/state/threads", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const stateAtom = Atom.family((key: string) =>
    Atom.make(() => {
      loads.push(key);
      return null;
    }),
  );
  const snapshotAtom = Atom.make<unknown>(null).pipe(Atom.keepAlive);
  fixtures.snapshotAtom = snapshotAtom;
  const noRowActions = Atom.make(0);
  return {
    ...(await importOriginal<object>()),
    createThreadFamilyAtoms: () => ({}),
    createOlderSettledThreadAtoms: () => ({}),
    createThreadEnvironmentAtoms: () => ({
      snapshotAtom: () => snapshotAtom,
      rowActionsAtom: () => noRowActions,
    }),
    createEnvironmentThreadDetailAtoms: () => ({}),
    createEnvironmentThreadStateAtoms: () => ({
      stateAtom: (environmentId: string, threadId: string) =>
        stateAtom(`${environmentId}:${threadId}`),
    }),
  };
});

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const threadKey = `${environmentId}:${threadId}`;
const creation: QueuedThreadMessage = {
  environmentId,
  threadId,
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the flaky login test",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "local",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};

describe("startOpeningEnvironmentThread", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    loads.length = 0;
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
    appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {});
  });

  it("waits for a queued thread creation to be delivered before loading the thread", () => {
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      [threadKey]: [creation],
    });
    startOpeningEnvironmentThread(environmentId, threadId);
    expect(loads).toEqual([]);

    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
    appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {
      [threadKey]: { kind: "delivered", message: creation },
    });
    startOpeningEnvironmentThread(environmentId, threadId);
    expect(loads).toEqual([threadKey]);
  });

  it("does not load a thread whose creation failed", () => {
    appAtomRegistry.set(pendingThreadCreationOutcomesAtom, {
      [threadKey]: { kind: "failed", message: creation, reason: "Checkout failed" },
    });
    startOpeningEnvironmentThread(environmentId, threadId);
    expect(loads).toEqual([]);
  });

  it("loads threads without a pending creation", () => {
    const { creation: _creation, ...followUp } = creation;
    const otherThreadId = ThreadId.make("thread-2");
    appAtomRegistry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
      [threadKey]: [followUp],
    });
    startOpeningEnvironmentThread(environmentId, threadId);
    startOpeningEnvironmentThread(environmentId, otherThreadId);
    expect(loads).toEqual([threadKey, `${environmentId}:${otherThreadId}`]);
  });
});

describe("Remove from list", () => {
  it("hides the thread from lists but keeps it where queued messages look it up", () => {
    const kept = makeRawThreadShell({ id: ThreadId.make("kept") });
    const removed = makeRawThreadShell({ id: ThreadId.make("removed") });
    appAtomRegistry.set(fixtures.snapshotAtom as Atom.Writable<unknown>, {
      snapshotSequence: 1,
      threads: [kept, removed],
    });
    const ids = (atom: Atom.Atom<ReadonlyArray<{ readonly id: ThreadId }>>) =>
      appAtomRegistry.get(atom).map((thread) => thread.id);
    const unmountList = appAtomRegistry.mount(steadyNavigationThreadShellsAtom);
    const unmountShells = appAtomRegistry.mount(environmentThreadShells.threadShellsAtom);
    expect(ids(steadyNavigationThreadShellsAtom)).toEqual([kept.id, removed.id]);

    forgetThread(environmentId, removed.id);

    expect(ids(steadyNavigationThreadShellsAtom)).toEqual([kept.id]);
    // The outbox deletes queued messages for a thread missing from these shells.
    expect(ids(environmentThreadShells.threadShellsAtom)).toEqual([kept.id, removed.id]);
    unmountShells();
    unmountList();
  });
});
