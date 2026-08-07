import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { ComposerImageAttachment } from "./composerDraftStore";
import {
  MAX_QUEUED_MESSAGES,
  readThreadMessageQueue,
  useMessageQueueStore,
  type QueuedMessage,
} from "./messageQueueStore";

const THREAD_KEY = "env-1::thread-1";

function makeImage(id: string): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 4,
    previewUrl: `blob:${id}`,
    file: new File(["img"], `${id}.png`, { type: "image/png" }),
  };
}

function makeMessage(id: string, images: ComposerImageAttachment[] = []): QueuedMessage {
  return {
    id,
    text: `prompt ${id}`,
    images,
    createdAt: "2026-08-06T12:00:00.000Z",
  };
}

let revoked: string[] = [];
let originalRevokeObjectUrl: typeof URL.revokeObjectURL;

beforeEach(() => {
  useMessageQueueStore.setState({ queuesByThreadKey: {} });
  revoked = [];
  originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  URL.revokeObjectURL = originalRevokeObjectUrl;
  useMessageQueueStore.setState({ queuesByThreadKey: {} });
});

describe("messageQueueStore", () => {
  it("keeps enqueued messages in FIFO order per thread", () => {
    const { enqueueMessage } = useMessageQueueStore.getState();
    enqueueMessage(THREAD_KEY, makeMessage("a"));
    enqueueMessage(THREAD_KEY, makeMessage("b"));
    enqueueMessage("env-1::thread-2", makeMessage("c"));

    expect(readThreadMessageQueue(THREAD_KEY).map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(readThreadMessageQueue("env-1::thread-2").map((entry) => entry.id)).toEqual(["c"]);
  });

  it("refuses to enqueue beyond the limit instead of dropping a prompt", () => {
    const { enqueueMessage } = useMessageQueueStore.getState();
    for (let index = 0; index < MAX_QUEUED_MESSAGES; index += 1) {
      expect(enqueueMessage(THREAD_KEY, makeMessage(`entry-${index}`))).toBe(true);
    }

    expect(enqueueMessage(THREAD_KEY, makeMessage("overflow"))).toBe(false);
    expect(readThreadMessageQueue(THREAD_KEY)).toHaveLength(MAX_QUEUED_MESSAGES);
  });

  it("takes a message without revoking its preview urls", () => {
    const { enqueueMessage, takeMessage } = useMessageQueueStore.getState();
    enqueueMessage(THREAD_KEY, makeMessage("a", [makeImage("shot")]));
    enqueueMessage(THREAD_KEY, makeMessage("b"));

    const taken = takeMessage(THREAD_KEY, "a");

    expect(taken?.id).toBe("a");
    expect(revoked).toEqual([]);
    expect(readThreadMessageQueue(THREAD_KEY).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("returns null when taking an entry that is already gone", () => {
    expect(useMessageQueueStore.getState().takeMessage(THREAD_KEY, "missing")).toBeNull();
  });

  it("requeues a failed send at the head and never duplicates it", () => {
    const { enqueueMessage, requeueMessage } = useMessageQueueStore.getState();
    enqueueMessage(THREAD_KEY, makeMessage("b"));
    const failed = makeMessage("a");

    requeueMessage(THREAD_KEY, failed);
    requeueMessage(THREAD_KEY, failed);

    expect(readThreadMessageQueue(THREAD_KEY).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("revokes preview urls when the user discards a message", () => {
    const { enqueueMessage, discardMessage } = useMessageQueueStore.getState();
    enqueueMessage(THREAD_KEY, makeMessage("a", [makeImage("one"), makeImage("two")]));

    discardMessage(THREAD_KEY, "a");

    expect(revoked).toEqual(["blob:one", "blob:two"]);
    expect(readThreadMessageQueue(THREAD_KEY)).toEqual([]);
  });

  it("drops the thread entry once its queue is empty", () => {
    const { enqueueMessage, discardMessage } = useMessageQueueStore.getState();
    enqueueMessage(THREAD_KEY, makeMessage("a"));

    discardMessage(THREAD_KEY, "a");

    expect(Object.keys(useMessageQueueStore.getState().queuesByThreadKey)).toEqual([]);
  });

  it("clears a whole thread queue and revokes every preview url", () => {
    const { enqueueMessage, clearThreadQueue } = useMessageQueueStore.getState();
    enqueueMessage(THREAD_KEY, makeMessage("a", [makeImage("one")]));
    enqueueMessage(THREAD_KEY, makeMessage("b", [makeImage("two")]));

    clearThreadQueue(THREAD_KEY);

    expect(revoked).toEqual(["blob:one", "blob:two"]);
    expect(readThreadMessageQueue(THREAD_KEY)).toEqual([]);
  });
});
