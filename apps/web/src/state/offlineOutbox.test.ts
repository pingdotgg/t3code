import { describe, expect, it } from "vite-plus/test";
import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { createOfflineOutbox, type OfflineMessage } from "./offlineOutbox";

const message = (id: string, environment = "home"): OfflineMessage => ({
  environmentId: EnvironmentId.make(environment),
  input: {
    commandId: CommandId.make(`command-${id}`),
    threadId: ThreadId.make("thread"),
    message: { messageId: MessageId.make(id), role: "user", text: id, attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    dispatchMode: "queue",
  },
  attachments: [],
});

function setup() {
  const stored = new Map<string, OfflineMessage>();
  const sent: OfflineMessage[] = [];
  const online = new Set<EnvironmentId>();
  let fail: Error | undefined;
  const options = {
    load: async () => [...stored.values()],
    put: async (entry: OfflineMessage) => {
      stored.set(entry.input.message.messageId, structuredClone(entry));
    },
    remove: async (id: string, successor?: OfflineMessage) => {
      if (successor) stored.set(successor.input.message.messageId, structuredClone(successor));
      stored.delete(id);
    },
    canSend: (entry: OfflineMessage) => online.has(entry.environmentId),
    send: async (entry: OfflineMessage) => {
      if (fail) throw fail;
      sent.push(entry);
    },
  };
  return {
    stored,
    sent,
    online,
    options,
    queue: createOfflineOutbox(options),
    fail: (error?: Error) => {
      fail = error;
    },
  };
}

describe("offline outbox", () => {
  it("persists offline messages and delivers in order to their destination after restart", async () => {
    const h = setup();
    await h.queue.enqueue(message("first"));
    await h.queue.enqueue(message("second"));
    await h.queue.enqueue(message("remote", "remote"));
    await h.queue.drain();
    expect(h.sent).toEqual([]);
    const restarted = createOfflineOutbox(h.options);
    await restarted.load();
    h.online.add(EnvironmentId.make("home"));
    await restarted.drain();
    expect(h.sent.map((entry) => entry.input.message.messageId)).toEqual(["first", "second"]);
    expect([...h.stored.keys()]).toEqual(["remote"]);
    expect(h.sent[0]?.input.commandId).toBe("command-first");
  });

  it("keeps a failed message and later messages until retry, and allows cancellation", async () => {
    const h = setup();
    await h.queue.enqueue(message("first"));
    await h.queue.enqueue(message("second"));
    h.online.add(EnvironmentId.make("home"));
    h.fail(new Error("Provider unavailable"));
    await h.queue.drain();
    expect(h.queue.getSnapshot()[0]?.error).toBe("Provider unavailable");
    h.fail();
    await h.queue.drain();
    expect(h.sent).toEqual([]);
    await h.queue.retry("first");
    await h.queue.remove("second");
    await h.queue.drain();
    expect(h.sent.map((entry) => entry.input.message.messageId)).toEqual(["first"]);
    expect(h.stored.size).toBe(0);
    const bootstrap = {
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main" },
      runSetupScript: true,
    };
    const first = message("launch");
    await h.queue.enqueue({ ...first, input: { ...first.input, bootstrap } });
    await h.queue.enqueue(message("survivor"));
    await h.queue.enqueue(message("other", "remote"));
    await h.queue.remove("launch");
    const restarted = createOfflineOutbox(h.options);
    await restarted.load();
    expect(
      restarted.getSnapshot().find((entry) => entry.input.message.messageId === "survivor")?.input
        .bootstrap,
    ).toEqual(bootstrap);
    expect(
      restarted.getSnapshot().find((entry) => entry.input.message.messageId === "other")?.input
        .bootstrap,
    ).toBeUndefined();
    await restarted.drain();
    expect(h.sent.at(-1)?.input.bootstrap).toEqual(bootstrap);
    expect(h.sent.at(-1)?.inheritedBootstrap).toBe(true);
  });

  it("does not publish a message when durable storage fails", async () => {
    const h = setup();
    const queue = createOfflineOutbox({
      ...h.options,
      put: async () => {
        throw new Error("Disk full");
      },
    });
    await expect(queue.enqueue(message("first"))).rejects.toThrow("Disk full");
    expect(queue.getSnapshot()).toEqual([]);
  });

  it("does not send a message twice or remove it during delivery", async () => {
    const h = setup();
    let finish!: () => void;
    const delivered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const queue = createOfflineOutbox({
      ...h.options,
      send: async (entry) => {
        h.sent.push(entry);
        started();
        await delivered;
      },
    });
    await queue.enqueue(message("first"));
    const canceled = message("canceled");
    const bootstrap = { prepareWorktree: { projectCwd: "/repo", baseBranch: "main" } };
    await queue.enqueue({ ...canceled, input: { ...canceled.input, bootstrap } });
    await queue.enqueue(message("survivor"));
    h.online.add(EnvironmentId.make("home"));
    const drain = queue.drain();
    await ready;
    await queue.remove("first");
    await queue.remove("canceled");
    await queue.drain();
    expect(h.stored.size).toBe(2);
    finish();
    await drain;
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.input.bootstrap).toEqual(bootstrap);
    expect(h.stored.size).toBe(0);
  });
});
