import { MessageId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import {
  applyOptimisticUserMessagesAction,
  createOptimisticBlobPreviews,
  dropOptimisticHandoff,
  emptyOptimisticUserMessages,
  loadedHandoffMessageIdsAtom,
  reconcileOptimisticUserMessages,
} from "./optimisticUserMessages";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function message(id: string, previewUrl?: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "user",
    text: id,
    runId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    streaming: false,
    ...(previewUrl
      ? {
          attachments: [
            {
              type: "image",
              id: `${id}-image`,
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
              previewUrl,
            },
          ],
        }
      : {}),
  } as ChatMessage;
}

const ids = (...values: string[]) => new Set(values.map((value) => MessageId.make(value)));

describe("optimistic user messages", () => {
  it("an acknowledged message stays gone after the server drops its row", () => {
    let state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      message("m1"),
      message("m2", "blob:two"),
    ]);
    state = reconcileOptimisticUserMessages(state, threadA, ids("m1", "m2"));
    expect(state.messages).toEqual([]);
    expect(state.handoff).toEqual({ m2: ["blob:two"] });

    // A cancelled queued run or a rewind removes the server's copy again.
    state = reconcileOptimisticUserMessages(state, threadA, ids());
    expect(state.messages).toEqual([]);

    state = dropOptimisticHandoff(state, threadA, MessageId.make("m2"));
    expect(state.handoff).toEqual({});
  });

  it("releases the previous thread's messages when the thread changes", () => {
    let state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      message("a1"),
    ]);
    state = reconcileOptimisticUserMessages(state, threadB, ids());
    state = reconcileOptimisticUserMessages(state, threadA, ids());
    expect(state).toEqual(emptyOptimisticUserMessages(threadA));
  });

  it("drops a late update for a thread the view has left", () => {
    const state = reconcileOptimisticUserMessages(
      applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
        message("a1"),
      ]),
      threadB,
      ids(),
    );
    expect(applyOptimisticUserMessagesAction(state, threadA, [message("a2")])).toBe(state);
  });

  it("revokes a thread's blob previews once, when their use ends or the thread is left", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    previews.track(threadA, message("a1", "blob:a1"));
    previews.track(threadA, message("a2", "blob:a2"));
    previews.track(threadB, message("b1", "blob:b1"));

    previews.revoke(threadA, ["blob:a1"]);
    previews.revokeThread(threadA);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:a1", "blob:a2"]);
  });

  it("a send that fails after the server acknowledged it leaves the handed-off previews shown", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    const sent = message("m1", "blob:m1");
    previews.track(threadA, sent);
    let state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      sent,
    ]);
    state = reconcileOptimisticUserMessages(state, threadA, ids("m1"));
    previews.handOff(state);

    previews.release(threadA, sent);
    expect(revoke).not.toHaveBeenCalled();

    previews.revokeThread(threadA);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:m1"]);
  });

  it("a send that fails before acknowledgement revokes its previews", () => {
    using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const previews = createOptimisticBlobPreviews();
    const sent = message("m1", "blob:m1");
    previews.track(threadA, sent);
    const state = applyOptimisticUserMessagesAction(emptyOptimisticUserMessages(threadA), threadA, [
      sent,
    ]);
    previews.handOff(reconcileOptimisticUserMessages(state, threadA, ids()));

    previews.release(threadA, sent);
    expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:m1"]);
  });
});

class FakeImage {
  static readonly created: FakeImage[] = [];
  src = "";
  private readonly listeners = new Map<string, () => void>();
  constructor() {
    FakeImage.created.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
  fire(type: "load" | "error") {
    this.listeners.get(type)?.();
  }
}

describe("handoff preloads", () => {
  it("reports a handoff loaded, and revokes its blobs, once every server preview loads", async () => {
    vi.stubGlobal("Image", FakeImage);
    try {
      using revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      FakeImage.created.length = 0;
      const registry = AtomRegistry.make();
      const atom = loadedHandoffMessageIdsAtom(
        JSON.stringify([
          ["m-loaded", ["https://server/a.png", "https://server/b.png"], ["blob:a", "blob:b"]],
          ["m-failed", ["https://server/c.png"], ["blob:c"]],
        ]),
      );
      const release = registry.mount(atom);
      const image = (src: string) => FakeImage.created.find((candidate) => candidate.src === src);

      image("https://server/a.png")?.fire("load");
      image("https://server/c.png")?.fire("error");
      await Promise.resolve();
      expect(registry.get(atom)).toEqual([]);

      image("https://server/b.png")?.fire("load");
      await vi.waitFor(() => expect(registry.get(atom)).toEqual(["m-loaded"]));
      expect(revoke.mock.calls.map(([url]) => url)).toEqual(["blob:a", "blob:b"]);
      release();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
