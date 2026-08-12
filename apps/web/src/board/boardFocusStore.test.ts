import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useBoardFocusStore } from "./boardFocusStore.ts";

beforeEach(() => {
  useBoardFocusStore.setState({
    request: null,
    acknowledgedFocus: null,
    focusedThreadKey: null,
    expandedThreadKey: null,
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
});
