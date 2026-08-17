import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PREVIEW_AUTOMATION_VIEWPORT,
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
  resolvePreviewAutomationOpenWaitPolicy,
  shouldOpenPreviewMiniPlayer,
} from "./previewAutomationOpenReadiness";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-26T00:00:00.000Z",
});

describe("preview automation open readiness", () => {
  it("opens the inline preview by default", () => {
    expect(shouldOpenPreviewMiniPlayer({} as PreviewAutomationOpenInput)).toBe(true);
  });

  it("supports explicit opt-out and the legacy show alias", () => {
    expect(shouldOpenPreviewMiniPlayer({ open: false } as PreviewAutomationOpenInput)).toBe(false);
    expect(shouldOpenPreviewMiniPlayer({ show: false } as PreviewAutomationOpenInput)).toBe(false);
    expect(
      shouldOpenPreviewMiniPlayer({ open: true, show: false } as PreviewAutomationOpenInput),
    ).toBe(true);
  });

  it("does not wait for a desktop overlay when opening an empty tab", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(false);
  });

  it("acknowledges a newly created shown tab without cold renderer readiness", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        { url: "https://example.com" } as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Loading",
          url: "https://example.com/",
          title: "",
        }),
        false,
      ),
    ).toEqual({
      acknowledgeAfterCreation: true,
      waitForOverlay: false,
      waitForVisibility: false,
    });
  });

  it("acknowledges a newly created background tab without renderer readiness", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        { url: "https://example.com", show: false } as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Loading",
          url: "https://example.com/",
          title: "",
        }),
        false,
      ),
    ).toEqual({
      acknowledgeAfterCreation: true,
      waitForOverlay: false,
      waitForVisibility: false,
    });
  });

  it("waits for the overlay and visibility when navigating a reused tab", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        { url: "https://example.com" } as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
        true,
      ),
    ).toEqual({
      acknowledgeAfterCreation: false,
      waitForOverlay: true,
      waitForVisibility: true,
    });
  });

  it("waits for an existing rendered overlay without requiring visibility when show is false", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        { show: false } as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
        true,
      ),
    ).toEqual({
      acknowledgeAfterCreation: false,
      waitForOverlay: true,
      waitForVisibility: false,
    });
  });

  it("does not require visibility for a reused empty tab", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
        true,
      ),
    ).toEqual({
      acknowledgeAfterCreation: false,
      waitForOverlay: false,
      waitForVisibility: false,
    });
  });

  it("does not require visibility for a reused failed tab", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "LoadFailed",
          url: "https://example.com/",
          title: "Example",
          code: -2,
          description: "Failed",
        }),
        true,
      ),
    ).toEqual({
      acknowledgeAfterCreation: false,
      waitForOverlay: true,
      waitForVisibility: false,
    });
  });

  it("does not require visibility when browser defaults keep a reused tab in the background", () => {
    expect(
      resolvePreviewAutomationOpenWaitPolicy(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
        true,
        false,
      ),
    ).toEqual({
      acknowledgeAfterCreation: false,
      waitForOverlay: true,
      waitForVisibility: false,
    });
  });

  it("gives newly-created automation tabs a stable desktop viewport", () => {
    expect(previewAutomationDefaultViewport(false, snapshot({ _tag: "Idle" }))).toEqual(
      DEFAULT_PREVIEW_AUTOMATION_VIEWPORT,
    );
  });

  it("preserves reused and already-fixed browser viewports", () => {
    expect(previewAutomationDefaultViewport(true, snapshot({ _tag: "Idle" }))).toBeNull();
    expect(
      previewAutomationDefaultViewport(false, {
        ...snapshot({ _tag: "Idle" }),
        viewport: { _tag: "freeform", width: 900, height: 600 },
      }),
    ).toBeNull();
  });
});

describe("shouldOpenPreviewMiniPlayer with the floating-preview preference", () => {
  it("honours the preference when the agent said nothing either way", () => {
    // `preview_open` no longer arrives with `open` pre-filled, so an agent
    // that omitted it leaves the decision to the user's setting.
    expect(shouldOpenPreviewMiniPlayer({}, false)).toBe(false);
    expect(shouldOpenPreviewMiniPlayer({}, true)).toBe(true);
  });

  it("lets an explicit request outrank the preference in both directions", () => {
    expect(shouldOpenPreviewMiniPlayer({ open: true }, false)).toBe(true);
    expect(shouldOpenPreviewMiniPlayer({ open: false }, true)).toBe(false);
    expect(shouldOpenPreviewMiniPlayer({ show: true }, false)).toBe(true);
  });
});
