import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewAutomationSnapshotResponse } from "./previewAutomationReviewSnapshot";

const fullSnapshot: PreviewAutomationSnapshot = {
  url: "https://example.com/review",
  title: "Review",
  loading: false,
  viewport: {
    width: 1_000,
    height: 600,
    scrollX: 0,
    scrollY: 120,
    devicePixelRatio: 2,
  },
  pageRevision: "page-1",
  capturedAt: "2026-07-30T12:00:00.000Z",
  visibleText: "Private diagnostic text",
  interactiveElements: [
    {
      tag: "button",
      role: "button",
      name: "Save",
      selector: "#save",
      x: 10,
      y: 20,
      width: 80,
      height: 32,
    },
  ],
  accessibilityTree: { nodes: [{ nodeId: "1" }] },
  consoleEntries: [
    {
      level: "log",
      text: "private console entry",
      timestamp: "2026-07-30T12:00:00.000Z",
    },
  ],
  networkEntries: [
    {
      url: "https://example.com/api/private",
      method: "GET",
      status: 200,
      failed: false,
      timestamp: "2026-07-30T12:00:00.000Z",
    },
  ],
  actionTimeline: [
    {
      id: "action-1",
      action: "click",
      status: "succeeded",
      startedAt: "2026-07-30T12:00:00.000Z",
    },
  ],
  screenshot: {
    mimeType: "image/png",
    data: "cG5n",
    width: 1_280,
    height: 768,
    scale: 1.28,
  },
};

describe("capturePreviewAutomationSnapshotResponse", () => {
  it("requests review mode and strips diagnostic fields before relay", async () => {
    const capture = vi.fn(async () => fullSnapshot);

    const result = await capturePreviewAutomationSnapshotResponse({
      requestInput: { mode: "review" },
      capture,
    });

    expect(capture).toHaveBeenCalledWith({ mode: "review" });
    expect(result).toEqual({
      url: fullSnapshot.url,
      title: fullSnapshot.title,
      loading: fullSnapshot.loading,
      viewport: fullSnapshot.viewport,
      pageRevision: fullSnapshot.pageRevision,
      capturedAt: fullSnapshot.capturedAt,
      interactiveElements: fullSnapshot.interactiveElements,
      screenshot: fullSnapshot.screenshot,
    });
    expect(result).not.toHaveProperty("visibleText");
    expect(result).not.toHaveProperty("accessibilityTree");
    expect(result).not.toHaveProperty("consoleEntries");
    expect(result).not.toHaveProperty("networkEntries");
    expect(result).not.toHaveProperty("actionTimeline");
  });

  it("keeps legacy snapshot requests full and calls the bridge without options", async () => {
    const capture = vi.fn(async () => fullSnapshot);

    const result = await capturePreviewAutomationSnapshotResponse({
      requestInput: {},
      capture,
    });

    expect(capture.mock.calls).toEqual([[]]);
    expect(result).toBe(fullSnapshot);
  });

  it("accepts review responses from legacy hosts without viewport metadata", async () => {
    const legacyHostSnapshot: PreviewAutomationSnapshot = {
      url: fullSnapshot.url,
      title: fullSnapshot.title,
      loading: fullSnapshot.loading,
      visibleText: fullSnapshot.visibleText,
      interactiveElements: fullSnapshot.interactiveElements,
      accessibilityTree: fullSnapshot.accessibilityTree,
      consoleEntries: fullSnapshot.consoleEntries,
      networkEntries: fullSnapshot.networkEntries,
      actionTimeline: fullSnapshot.actionTimeline,
      screenshot: {
        mimeType: "image/png",
        data: "cG5n",
        width: 1_000,
        height: 600,
      },
    };
    const capture = vi.fn(async () => legacyHostSnapshot);

    const result = await capturePreviewAutomationSnapshotResponse({
      requestInput: { mode: "review" },
      capture,
    });

    expect(result).toEqual({
      url: legacyHostSnapshot.url,
      title: legacyHostSnapshot.title,
      loading: legacyHostSnapshot.loading,
      interactiveElements: legacyHostSnapshot.interactiveElements,
      screenshot: legacyHostSnapshot.screenshot,
    });
  });
});
