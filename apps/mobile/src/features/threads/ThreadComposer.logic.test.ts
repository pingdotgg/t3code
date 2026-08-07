import { describe, expect, it } from "vite-plus/test";

import { collapsedComposerActions } from "./ThreadComposer.logic";

describe("collapsed composer actions", () => {
  it("keeps Send primary and exposes Stop beside a settled draft", () => {
    expect(
      collapsedComposerActions({
        canStopThread: true,
        hasContent: true,
        activeThreadBusy: false,
      }),
    ).toEqual({ showStopPrimary: false, showStopSecondary: true });
  });

  it("uses Stop as the primary action when the draft is empty or busy", () => {
    expect(
      collapsedComposerActions({
        canStopThread: true,
        hasContent: false,
        activeThreadBusy: false,
      }),
    ).toEqual({ showStopPrimary: true, showStopSecondary: false });
    expect(
      collapsedComposerActions({
        canStopThread: true,
        hasContent: true,
        activeThreadBusy: true,
      }),
    ).toEqual({ showStopPrimary: true, showStopSecondary: false });
  });
});
