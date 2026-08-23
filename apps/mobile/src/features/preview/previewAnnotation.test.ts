import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// expo-crypto reaches for native modules in a node test; ids only need to be unique.
vi.mock("../../lib/uuid", () => {
  let counter = 0;
  return { uuidv4: () => `uuid-${++counter}` };
});

import {
  addBoxMarker,
  addPinMarker,
  buildPreviewAnnotationAttachment,
  buildPreviewAnnotationText,
  removeMarker,
  updateMarkerNote,
} from "./previewAnnotation";

describe("preview annotation markers", () => {
  it("numbers markers contiguously and renumbers after removal", () => {
    let markers = addPinMarker([], { x: 0.1, y: 0.2 });
    markers = addBoxMarker(markers, { startX: 0.5, startY: 0.5, endX: 0.7, endY: 0.6 });
    markers = addPinMarker(markers, { x: 0.9, y: 0.9 });
    expect(markers.map((marker) => marker.index)).toEqual([1, 2, 3]);

    markers = removeMarker(markers, markers[1]!.id);
    expect(markers.map((marker) => marker.index)).toEqual([1, 2]);
    expect(markers.map((marker) => marker.kind)).toEqual(["pin", "pin"]);
  });

  it("normalizes boxes dragged from any corner and clamps to the image", () => {
    const markers = addBoxMarker([], { startX: 0.8, startY: 0.9, endX: 0.2, endY: 0.3 });
    expect(markers[0]).toMatchObject({ x: 0.2, y: 0.3 });
    expect(markers[0]!.width).toBeCloseTo(0.6);
    expect(markers[0]!.height).toBeCloseTo(0.6);

    const clamped = addPinMarker([], { x: -0.5, y: 1.5 });
    expect(clamped[0]).toMatchObject({ x: 0, y: 1 });
  });

  it("keeps notes attached to their marker", () => {
    let markers = addPinMarker([], { x: 0.1, y: 0.1 });
    markers = addPinMarker(markers, { x: 0.2, y: 0.2 });
    markers = updateMarkerNote(markers, markers[1]!.id, "align this button");
    expect(markers[0]!.note).toBe("");
    expect(markers[1]!.note).toBe("align this button");
  });

  it("builds numbered note text matching the badges", () => {
    let markers = addPinMarker([], { x: 0.1, y: 0.1 });
    markers = updateMarkerNote(markers, markers[0]!.id, "wrong color");
    markers = addBoxMarker(markers, { startX: 0.2, startY: 0.2, endX: 0.4, endY: 0.4 });
    const text = buildPreviewAnnotationText({
      pageUrl: "http://localhost:5173/",
      markers,
    });
    expect(text).toBe(
      [
        "Annotated preview screenshot of http://localhost:5173/ (attached):",
        "1. wrong color",
        "2. (see marker in screenshot)",
      ].join("\n"),
    );
  });
});

describe("buildPreviewAnnotationAttachment", () => {
  const base64Png = Buffer.from("fake png bytes").toString("base64");

  it("wraps a capture in the composer attachment shape", () => {
    const result = buildPreviewAnnotationAttachment({
      base64: base64Png,
      existingAttachmentCount: 0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachment).toMatchObject({
      type: "image",
      name: "preview-annotation.png",
      mimeType: "image/png",
    });
    expect(result.attachment.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(result.attachment.sizeBytes).toBeGreaterThan(0);
  });

  it("enforces the existing attachment count limit", () => {
    const result = buildPreviewAnnotationAttachment({
      base64: base64Png,
      existingAttachmentCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects empty captures", () => {
    expect(
      buildPreviewAnnotationAttachment({ base64: "", existingAttachmentCount: 0 }),
    ).toMatchObject({ ok: false });
  });
});
