import type { PreviewAutomationOpenInput, PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_PREVIEW_AUTOMATION_VIEWPORT,
  PREVIEW_PRESENTATION_CLAIM_GRACE_MS,
  PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS,
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
  previewPresentationSettleDecision,
  shouldPresentPreview,
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
  it("presents the browser panel by default", () => {
    expect(shouldPresentPreview({} as PreviewAutomationOpenInput)).toBe(true);
  });

  it("supports explicit opt-out and the legacy show alias", () => {
    expect(shouldPresentPreview({ open: false } as PreviewAutomationOpenInput)).toBe(false);
    expect(shouldPresentPreview({ show: false } as PreviewAutomationOpenInput)).toBe(false);
    expect(shouldPresentPreview({ open: true, show: false } as PreviewAutomationOpenInput)).toBe(
      true,
    );
  });

  it("does not wait for a desktop overlay when opening an empty tab", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(false);
  });

  it("waits when an empty tab is immediately given a URL", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        { url: "https://example.com" } as PreviewAutomationOpenInput,
        snapshot({ _tag: "Idle" }),
      ),
    ).toBe(true);
  });

  it("waits for existing tabs that already have rendered content", () => {
    expect(
      previewAutomationOpenNeedsOverlay(
        {} as PreviewAutomationOpenInput,
        snapshot({
          _tag: "Success",
          url: "https://example.com/",
          title: "Example",
        }),
      ),
    ).toBe(true);
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

  it("stops presentation settle once the surface is visible", () => {
    expect(
      previewPresentationSettleDecision({
        visible: true,
        claimed: true,
        elapsedMs: 0,
      }),
    ).toBe("done");
  });

  it("does not burn the full settle budget when no surface claims the tab", () => {
    expect(
      previewPresentationSettleDecision({
        visible: false,
        claimed: false,
        elapsedMs: PREVIEW_PRESENTATION_CLAIM_GRACE_MS,
      }),
    ).toBe("done");
    expect(
      previewPresentationSettleDecision({
        visible: false,
        claimed: false,
        elapsedMs: PREVIEW_PRESENTATION_CLAIM_GRACE_MS - 1,
      }),
    ).toBe("continue");
  });

  it("keeps waiting for a claimed surface until visible or timeout", () => {
    expect(
      previewPresentationSettleDecision({
        visible: false,
        claimed: true,
        elapsedMs: PREVIEW_PRESENTATION_CLAIM_GRACE_MS,
      }),
    ).toBe("continue");
    expect(
      previewPresentationSettleDecision({
        visible: false,
        claimed: true,
        elapsedMs: PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS,
      }),
    ).toBe("done");
  });
});
