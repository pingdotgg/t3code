import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isQueuedMessageDue,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "./queuedMessageStore";

function makeMessage(prompt: string): Omit<QueuedComposerMessage, "id"> {
  return {
    prompt,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {}, drainGeneration: 0 });
  });

  it("keeps messages in submission order per thread", () => {
    const { enqueue } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    const queues = useQueuedMessageStore.getState().queuesByThreadKey;
    expect(queues["thread-a"]?.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queues["thread-b"]?.map((message) => message.prompt)).toEqual(["other"]);
  });

  it("remove hands the message to exactly one caller", () => {
    const { enqueue, remove } = useQueuedMessageStore.getState();
    const entry = enqueue("thread-a", makeMessage("first"));

    expect(remove("thread-a", entry.id)?.prompt).toBe("first");
    expect(remove("thread-a", entry.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("remove leaves the other messages in order", () => {
    const { enqueue, remove } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toEqual([first]);
  });

  it("holdAtFront returns a failed message to the head, held", () => {
    const { enqueue, remove, holdAtFront } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    const taken = remove("thread-a", first.id)!;

    holdAtFront("thread-a", taken);

    const queue = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(queue.map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(queue[0]?.holdUntilUserAction).toBe(true);
    expect(isQueuedMessageDue({ message: queue[0]!, phase: "ready" })).toBe(false);
  });

  it("drain empties one thread's queue in order", () => {
    const { enqueue, drain } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    expect(drain("thread-a").map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(useQueuedMessageStore.getState().drainGeneration).toBe(1);
    expect(drain("thread-a")).toEqual([]);
    expect(useQueuedMessageStore.getState().drainGeneration).toBe(1);
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-b"]).toHaveLength(1);
  });
});

describe("queued message dispatch timing", () => {
  it.each(["connecting", "running"] as const)("holds follow-ups while %s", (phase) => {
    expect(isQueuedMessageDue({ message: makeMessage("follow-up"), phase })).toBe(false);
  });

  it.each(["ready", "disconnected"] as const)("releases follow-ups when %s", (phase) => {
    expect(isQueuedMessageDue({ message: makeMessage("follow-up"), phase })).toBe(true);
  });

  it.each(["connecting", "running", "ready", "disconnected"] as const)(
    "never auto-sends a held message while %s",
    (phase) => {
      expect(isQueuedMessageDue({ message: { holdUntilUserAction: true }, phase })).toBe(false);
    },
  );
});
