import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewAnnotationScreenshot } from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
  strokes: [
    {
      id: "stroke_1",
      color: "#7c3aed",
      width: 4,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      bounds: { x: 6, y: 6, width: 18, height: 18 },
    },
  ],
  styleChanges: [
    {
      targetId: "element_1",
      selector: ".card",
      property: "border-radius",
      previousValue: "4px",
      value: "16px",
    },
  ],
  screenshot: {
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 80,
    cropRect: { x: 10, y: 20, width: 100, height: 80 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("preview annotation capture", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the crop when the fetch resolves", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Blob(["png"], { type: "image/png" })));
    const capture = await capturePreviewAnnotationScreenshot(annotation);
    expect(capture.status).toBe("captured");
  });

  it("reports none when the annotation carries no crop", async () => {
    const capture = await capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null });
    expect(capture).toEqual({ status: "none" });
  });

  it("fails instead of hanging when the crop never arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const capturePromise = capturePreviewAnnotationScreenshot(annotation, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await capturePromise).toEqual({ status: "failed" });
  });

  it("fails when the crop fetch throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("data url unreadable");
    });
    expect(await capturePreviewAnnotationScreenshot(annotation)).toEqual({ status: "failed" });
  });
});
