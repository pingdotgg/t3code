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
    { id: "a1", kind: "tool.started" },
    { id: "a2", kind: "tool.completed" },
    { id: "a3", kind: "tool.updated" },
  ];

  it("finds the newest completed tool call", () => {
    expect(latestCompletedToolActivityId(activities)).toBe("a2");
    expect(latestCompletedToolActivityId([])).toBeNull();
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
