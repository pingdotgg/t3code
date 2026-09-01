import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useThreadErrorBannerStore } from "./threadErrorBannerStore";

describe("threadErrorBannerStore", () => {
  beforeEach(() => {
    useThreadErrorBannerStore.setState({ dismissedRuntimeErrorKeysByThreadKey: {} });
  });

  it("retains dismissed occurrences outside the ChatView lifecycle", () => {
    useThreadErrorBannerStore.getState().dismissRuntimeError("environment:thread-a", "error:1");

    expect(useThreadErrorBannerStore.getState().dismissedRuntimeErrorKeysByThreadKey).toEqual({
      "environment:thread-a": "error:1",
    });
  });

  it("keeps dismissals scoped by thread and replaces a later occurrence", () => {
    const store = useThreadErrorBannerStore.getState();
    store.dismissRuntimeError("environment:thread-a", "error:1");
    store.dismissRuntimeError("environment:thread-b", "error:2");
    store.dismissRuntimeError("environment:thread-a", "error:3");

    expect(useThreadErrorBannerStore.getState().dismissedRuntimeErrorKeysByThreadKey).toEqual({
      "environment:thread-a": "error:3",
      "environment:thread-b": "error:2",
    });
  });
});
