import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import type { QueuedThreadMessage } from "./thread-outbox-model";

vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  const entry = (environmentId: string) => ({ enabled: true, target: { environmentId } });
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([
          ["work", entry("work")],
          ["home", entry("home")],
        ]),
        focusAllowlist: new Set(["work"]),
      }),
    },
  };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentShell: { stateValueAtom: () => Atom.make({ status: "live" }) } };
});

vi.mock("./thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadOutboxManager: {
      queuedMessagesByThreadKeyAtom: Atom.make<
        Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>
      >({}).pipe(Atom.keepAlive),
    },
  };
});
vi.mock("./atom-registry", () => ({ appAtomRegistry: undefined }));

import { threadOutboxManager } from "./thread-outbox";
import { queuedThreadKeysAtom, threadOutboxShellStatusesAtom } from "./use-thread-outbox";

it("retains queue membership while chat lists are hidden and follows queued messages", () => {
  const scheduled = new Set<() => void>();
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.add(task);
      return () => {
        scheduled.delete(task);
      };
    },
  });
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const flush = () => {
    for (const task of scheduled) {
      scheduled.delete(task);
      task();
    }
  };
  const release = registry.mount(queuedThreadKeysAtom);
  const initial = registry.get(queuedThreadKeysAtom);
  expect([...initial]).toEqual([]);
  release();
  flush();
  expect(registry.get(queuedThreadKeysAtom)).toBe(initial);

  const message: QueuedThreadMessage = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    commandId: CommandId.make("command-1"),
    text: "Follow up",
    attachments: [],
    createdAt: "2026-10-29T12:00:00.000Z",
  };
  registry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
    "environment-1:thread-1": [message],
    "environment-1:new-thread": [
      {
        ...message,
        threadId: ThreadId.make("new-thread"),
        creation: {
          projectId: ProjectId.make("project-1"),
          workspaceMode: "local",
          branch: null,
          worktreePath: null,
        },
      },
    ],
  });
  const queued = registry.get(queuedThreadKeysAtom);
  expect([...queued]).toEqual(["environment-1:thread-1"]);
  const releaseAgain = registry.mount(queuedThreadKeysAtom);
  releaseAgain();
  flush();
  expect(registry.get(queuedThreadKeysAtom)).toBe(queued);

  registry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {});
  expect([...registry.get(queuedThreadKeysAtom)]).toEqual([]);
});

it("leaves out a Focus-paused environment whose shell still reads live", () => {
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const message: QueuedThreadMessage = {
    environmentId: EnvironmentId.make("work"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    commandId: CommandId.make("command"),
    text: "Follow up",
    attachments: [],
    createdAt: "2026-10-29T12:00:00.000Z",
  };
  registry.set(threadOutboxManager.queuedMessagesByThreadKeyAtom, {
    "work:thread": [message],
    "home:thread": [{ ...message, environmentId: EnvironmentId.make("home") }],
  });
  expect(registry.get(threadOutboxShellStatusesAtom)).toEqual(
    new Map([[EnvironmentId.make("work"), "live"]]),
  );
});
