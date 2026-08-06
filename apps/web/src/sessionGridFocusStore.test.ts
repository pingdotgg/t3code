import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useSessionGridFocusStore } from "./sessionGridFocusStore";

beforeEach(() => {
  useSessionGridFocusStore.setState({ focusedThreadKey: null });
});

describe("sessionGridFocusStore", () => {
  it("publishes and clears the focused server thread", () => {
    useSessionGridFocusStore.getState().setFocusedThreadKey("env-1:thread-1");
    expect(useSessionGridFocusStore.getState().focusedThreadKey).toBe("env-1:thread-1");

    useSessionGridFocusStore.getState().setFocusedThreadKey(null);
    expect(useSessionGridFocusStore.getState().focusedThreadKey).toBeNull();
  });
});
