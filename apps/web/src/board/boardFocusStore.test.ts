import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "../composerDraftStore.ts";
import { useBoardFocusStore } from "./boardFocusStore.ts";

beforeEach(() => {
  useBoardFocusStore.setState({
    request: null,
    acknowledgedFocus: null,
    focusedThreadKey: null,
    expandedTarget: null,
  });
});

describe("boardFocusStore", () => {
  it("acknowledges only the current focus request", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const request = useBoardFocusStore.getState().request;
    expect(request).not.toBeNull();

    store.acknowledgeFocus("thread-a", (request?.nonce ?? 0) - 1);
    expect(useBoardFocusStore.getState().acknowledgedFocus).toBeNull();

    store.acknowledgeFocus("thread-a", request?.nonce ?? 0);
    expect(useBoardFocusStore.getState().request).toBeNull();
    expect(useBoardFocusStore.getState().acknowledgedFocus).toEqual({
      threadKey: "thread-a",
      requestNonce: request?.nonce,
    });
    expect(useBoardFocusStore.getState().focusedThreadKey).toBe("thread-a");
  });

  it("preserves an acknowledgement for a later request to the same thread", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const firstNonce = useBoardFocusStore.getState().request?.nonce ?? 0;
    store.acknowledgeFocus("thread-a", firstNonce);

    store.requestFocus("thread-a");
    expect(useBoardFocusStore.getState().request?.nonce).toBe(firstNonce + 1);
    expect(useBoardFocusStore.getState().acknowledgedFocus?.requestNonce).toBe(firstNonce);
  });

  it("clears only the matching pending request", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    const nonce = useBoardFocusStore.getState().request?.nonce ?? 0;

    store.clearRequest("thread-a", nonce - 1);
    expect(useBoardFocusStore.getState().request?.nonce).toBe(nonce);

    store.clearRequest("thread-a", nonce);
    expect(useBoardFocusStore.getState().request).toBeNull();
  });

  it("clears acknowledgement when focus moves to another thread", () => {
    const store = useBoardFocusStore.getState();
    store.requestFocus("thread-a");
    store.acknowledgeFocus("thread-a", useBoardFocusStore.getState().request?.nonce ?? 0);

    store.requestFocus("thread-b");
    expect(useBoardFocusStore.getState().acknowledgedFocus).toBeNull();
    store.setFocused("thread-b");
    expect(useBoardFocusStore.getState().focusedThreadKey).toBe("thread-b");
  });

  it("opens either a thread or a draft in the shared expanded surface", () => {
    const store = useBoardFocusStore.getState();

    store.setExpanded({ kind: "thread", threadKey: "thread-a" });
    expect(useBoardFocusStore.getState().expandedTarget).toEqual({
      kind: "thread",
      threadKey: "thread-a",
    });

    const draftId = DraftId.make("draft-a");
    store.setExpanded({ kind: "draft", draftId });
    expect(useBoardFocusStore.getState().expandedTarget).toEqual({ kind: "draft", draftId });

    store.setExpanded(null);
    expect(useBoardFocusStore.getState().expandedTarget).toBeNull();
  });

  it("does not publish a store update for the same expanded target", () => {
    const updates: unknown[] = [];
    const unsubscribe = useBoardFocusStore.subscribe((state) => updates.push(state.expandedTarget));

    useBoardFocusStore.getState().setExpanded({ kind: "thread", threadKey: "thread-a" });
    useBoardFocusStore.getState().setExpanded({ kind: "thread", threadKey: "thread-a" });
    useBoardFocusStore.getState().setExpanded(null);
    useBoardFocusStore.getState().setExpanded(null);
    unsubscribe();

    expect(updates).toEqual([{ kind: "thread", threadKey: "thread-a" }, null]);
  });
});
