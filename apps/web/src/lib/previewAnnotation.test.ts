import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewAnnotationScreenshot } from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("preview annotation capture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the PNG bytes, MIME type, and filename without fetching", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Blocked by connect-src"));
    vi.stubGlobal("fetch", fetch);
    const capture = capturePreviewAnnotationScreenshot(annotation);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") throw new Error("Expected a screenshot file");
    expect(capture.file.name).toBe("preview-annotation-annotation_1.png");
    expect(capture.file.type).toBe("image/png");
    expect(Buffer.from(await capture.file.arrayBuffer()).toString("hex")).toBe(
      "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63fcff1f0003030200efa2a75b0000000049454e44ae426082",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports none when the annotation carries no crop", () => {
    const capture = capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null });
    expect(capture).toEqual({ status: "none" });
  });

  it.each(["data:image/jpeg;base64,AA==", "data:image/png;base64,", "data:image/png;base64,%%%"])(
    "reports a malformed screenshot as failed: %s",
    (dataUrl) => {
      const picked = { ...annotation, screenshot: { ...annotation.screenshot!, dataUrl } };
      expect(capturePreviewAnnotationScreenshot(picked)).toEqual({ status: "failed" });
    },
  );
});
