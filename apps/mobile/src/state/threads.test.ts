import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import { pendingThreadCreationOutcomesAtom } from "./pending-thread-creation";
import { threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { startOpeningEnvironmentThread } from "./threads";

const loads = vi.hoisted(() => [] as string[]);

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("./shell", () => ({ environmentShell: {} }));
vi.mock("@t3tools/client-runtime/state/threads", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const stateAtom = Atom.family((key: string) =>
    Atom.make(() => {
      loads.push(key);
      return null;
    }),
  );
  return {
    ...(await importOriginal<object>()),
    createThreadFamilyAtoms: () => ({}),
    createOlderSettledThreadAtoms: () => ({}),
    createThreadEnvironmentAtoms: () => ({}),
    createEnvironmentThreadDetailAtoms: () => ({}),
    createEnvironmentThreadShellAtoms: () => ({}),
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
