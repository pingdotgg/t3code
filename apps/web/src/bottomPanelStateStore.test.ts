import { scopeThreadRef, scopedThreadKey } from "@forma/client-runtime";
import { ThreadId } from "@forma/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectThreadBottomPanelState, useBottomPanelStateStore } from "./bottomPanelStateStore";

const THREAD_KEY = scopedThreadKey(
  scopeThreadRef("environment-a" as never, ThreadId.make("thread-preview")),
);

describe("bottomPanelStateStore", () => {
  beforeEach(() => {
    useBottomPanelStateStore.setState({ byThreadKey: {} });
  });

  it("returns a closed default state for unknown threads", () => {
    expect(
      selectThreadBottomPanelState(useBottomPanelStateStore.getState().byThreadKey, THREAD_KEY),
    ).toEqual({
      mode: "closed",
      previewHeight: 360,
    });
  });

  it("tracks preview mode and per-thread preview height", () => {
    const store = useBottomPanelStateStore.getState();
    store.setMode(THREAD_KEY, "preview");
    store.setPreviewHeight(THREAD_KEY, 420);

    expect(
      selectThreadBottomPanelState(useBottomPanelStateStore.getState().byThreadKey, THREAD_KEY),
    ).toEqual({
      mode: "preview",
      previewHeight: 420,
    });
  });
});
