import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useSessionGridFocusStore } from "./sessionGridFocusStore";

beforeEach(() => {
  useSessionGridFocusStore.setState({
    focusedThreadKey: null,
    focusedDraftId: null,
    changeRequestStateByKey: new Map(),
  });
});

describe("sessionGridFocusStore", () => {
  it("publishes and clears the focused server thread", () => {
    useSessionGridFocusStore.getState().setFocusedThreadKey("env-1:thread-1");
    expect(useSessionGridFocusStore.getState().focusedThreadKey).toBe("env-1:thread-1");

    useSessionGridFocusStore.getState().setFocusedThreadKey(null);
    expect(useSessionGridFocusStore.getState().focusedThreadKey).toBeNull();
  });

  it("publishes the focused draft independently from server-thread highlighting", () => {
    useSessionGridFocusStore.getState().setFocusedDraftId("draft-1");

    expect(useSessionGridFocusStore.getState().focusedDraftId).toBe("draft-1");
    expect(useSessionGridFocusStore.getState().focusedThreadKey).toBeNull();
  });

  it("shares branch-scoped change request state with the project panel", () => {
    const stateByKey = new Map([["env-1:thread-1\0feature/grid", "merged" as const]]);
    useSessionGridFocusStore.getState().setChangeRequestStateByKey(stateByKey);

    expect(useSessionGridFocusStore.getState().changeRequestStateByKey).toBe(stateByKey);
  });
});
