import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewAutomationOpenWaitPolicy } from "./previewAutomationOpenReadiness";

const snapshot = (navStatus: PreviewSessionSnapshot["navStatus"]): PreviewSessionSnapshot => ({
  threadId: "thread-1",
  tabId: "tab-1",
  navStatus,
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-06-26T00:00:00.000Z",
});

describe("preview automation open readiness", () => {
  it("acknowledges a newly created URL tab before cold renderer readiness", () => {
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
});
