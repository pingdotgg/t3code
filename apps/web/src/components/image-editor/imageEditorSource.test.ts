import { describe, expect, it } from "vite-plus/test";
import type { SnapShotAccessibilityNode, SnapShotSource } from "@t3tools/contracts";
import { createImageEditorDocument, setImageEditorCrop } from "./imageEditorDocument";
import { editedImageSource } from "./imageEditorSource";

function node(
  name: string,
  bounds: SnapShotAccessibilityNode["bounds"],
  children: SnapShotAccessibilityNode[] = [],
): SnapShotAccessibilityNode {
  return { role: "button", name, bounds, children };
}

function source(): SnapShotSource {
  return {
    kind: "snap-shot",
    capturedAt: "2026-11-15T12:00:00.000Z",
    appName: "Test app",
    windowTitle: "Window",
    accessibleText: "Visible Partial Outside Unknown",
    accessibility: {
      format: "element-tree",
      coordinateSpace: "captured-image",
      imageSize: { width: 1000, height: 500 },
      truncated: false,
      root: node("Root", { x: 0, y: 0, width: 1000, height: 500 }, [
        node("Visible", { x: 250, y: 150, width: 200, height: 100 }),
        node("Partial", { x: 100, y: 100, width: 200, height: 150 }),
        node("Outside", { x: 800, y: 0, width: 100, height: 100 }),
        node("Unknown", null),
      ]),
    },
  };
}

describe("edited screenshot metadata", () => {
  it("preserves unchanged metadata and scales coordinates when decoded pixels differ", () => {
    const original = source();
    expect(editedImageSource(undefined, createImageEditorDocument(1000, 500))).toBeUndefined();
    expect(editedImageSource(original, createImageEditorDocument(1000, 500))).toBe(original);
    const resized = editedImageSource(original, createImageEditorDocument(2000, 1000));
    expect(resized?.accessibility).toMatchObject({
      imageSize: { width: 2000, height: 1000 },
      root: { children: [{ bounds: { x: 500, y: 300, width: 400, height: 200 } }, {}, {}, {}] },
    });
    expect(resized?.accessibleText).toBe(original.accessibleText);
  });

  it("rebases intersecting elements into the exported crop and removes text outside it", () => {
    const original = source();
    const document = setImageEditorCrop(createImageEditorDocument(2000, 1000), {
      x: 400,
      y: 200,
      width: 800,
      height: 400,
    });
    const edited = editedImageSource(original, document);
    expect(edited?.appName).toBe(original.appName);
    expect(edited?.capturedAt).toBe(original.capturedAt);
    expect(edited?.accessibleText).toBeUndefined();
    expect(edited?.accessibility).toMatchObject({
      imageSize: { width: 800, height: 400 },
      root: {
        bounds: { x: 0, y: 0, width: 800, height: 400 },
        children: [
          { name: "Visible", bounds: { x: 100, y: 100, width: 400, height: 200 } },
          { bounds: { x: 0, y: 0, width: 200, height: 300 } },
        ],
      },
    });
    const json = JSON.stringify(edited);
    expect(json).not.toContain("Partial");
    expect(json).not.toContain("Outside");
    expect(json).not.toContain("Unknown");
    expect(original.accessibleText).toContain("Outside");
  });

  it("rounds fractional crops to PNG dimensions and drops unlocated flat text", () => {
    const original = source();
    const document = setImageEditorCrop(createImageEditorDocument(1000, 500), {
      x: 250.25,
      y: 150.25,
      width: 100.5,
      height: 50.5,
    });
    const edited = editedImageSource(original, document);
    expect(edited?.accessibility).toMatchObject({
      imageSize: { width: 101, height: 51 },
      root: { bounds: { x: 0, y: 0, width: 101, height: 51 } },
    });
    const flat: SnapShotSource = {
      ...original,
      accessibility: { format: "flat-text", text: "Text removed by crop", truncated: false },
    };
    const flatEdited = editedImageSource(flat, document);
    expect(flatEdited?.accessibility).toBeUndefined();
    expect(flatEdited?.accessibleText).toBeUndefined();
    expect(editedImageSource(flat, createImageEditorDocument(1000, 500))).toBe(flat);
  });
});
