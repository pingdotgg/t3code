import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  isQueuedMessageDue,
  latestCompletedToolActivityId,
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
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-11T00:00:00.000Z",
  };
}

describe("queuedMessageStore", () => {
  beforeEach(() => {
    useQueuedMessageStore.setState({ queuesByThreadKey: {} });
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

  it("take hands the message to exactly one caller", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const entry = enqueue("thread-a", makeMessage("first"));

    expect(take("thread-a", entry.id, null)?.prompt).toBe("first");
    expect(take("thread-a", entry.id, null)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toBeUndefined();
  });

  it("take re-anchors the remaining messages to the current tool boundary", () => {
    const { enqueue, take } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));

    take("thread-a", first.id, "tool-2");

    const [second] = useQueuedMessageStore.getState().queuesByThreadKey["thread-a"] ?? [];
    expect(second?.queuedAfterToolActivityId).toBe("tool-2");
    expect(
      isQueuedMessageDue({ message: second!, phase: "running", latestToolActivityId: "tool-2" }),
    ).toBe(false);
  });

  it("remove keeps the other messages' anchors", () => {
    const { enqueue, remove } = useQueuedMessageStore.getState();
    const first = enqueue("thread-a", { ...makeMessage("first"), queuedAfterToolActivityId: "t1" });
    const second = enqueue("thread-a", makeMessage("second"));

    expect(remove("thread-a", second.id)?.prompt).toBe("second");
    expect(remove("thread-a", second.id)).toBeNull();
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-a"]).toEqual([first]);
  });

  it("drain empties one thread's queue in order", () => {
    const { enqueue, drain } = useQueuedMessageStore.getState();
    enqueue("thread-a", makeMessage("first"));
    enqueue("thread-a", makeMessage("second"));
    enqueue("thread-b", makeMessage("other"));

    expect(drain("thread-a").map((message) => message.prompt)).toEqual(["first", "second"]);
    expect(drain("thread-a")).toEqual([]);
    expect(useQueuedMessageStore.getState().queuesByThreadKey["thread-b"]).toHaveLength(1);
  });
});

describe("queued message dispatch timing", () => {
  const activities = [
    { id: "a1", kind: "tool.started", sequence: 1, createdAt: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "tool.completed", sequence: 2, createdAt: "2026-01-01T00:00:02Z" },
    { id: "a3", kind: "tool.updated", sequence: 3, createdAt: "2026-01-01T00:00:03Z" },
  ];

  it("finds the newest completed tool call by sequence, not position", () => {
    expect(latestCompletedToolActivityId(activities)).toBe("a2");
    expect(latestCompletedToolActivityId([])).toBeNull();
    expect(
      latestCompletedToolActivityId([
        { id: "late", kind: "tool.completed", sequence: 9, createdAt: "2026-01-01T00:00:09Z" },
        { id: "early", kind: "tool.completed", sequence: 4, createdAt: "2026-01-01T00:00:04Z" },
      ]),
    ).toBe("late");
  });

  it("waits mid-turn until a tool call finishes after the message was queued", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a2" })).toBe(
      false,
    );
    expect(isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a4" })).toBe(
      true,
    );
  });

  it("is due as soon as the turn is over, but not while a send is connecting", () => {
    const message = { queuedAfterToolActivityId: "a2" };
    expect(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a2" })).toBe(true);
    expect(isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a4" })).toBe(
      false,
    );
  });
});
