import { describe, expect, it } from "vite-plus/test";
import {
  addImageEditorObject,
  anchoredImageEditorResize,
  buildImageEditorPrompt,
  commitImageEditorDocument,
  createImageEditorDocument,
  createImageEditorHistory,
  hitTestImageEditorObject,
  imageEditorObjectBounds,
  imageEditorSvgMarkup,
  redoImageEditor,
  removeImageEditorObject,
  reorderImageEditorObject,
  setImageEditorCrop,
  undoImageEditor,
  updateImageEditorObject,
  type ImageEditorObject,
} from "./imageEditorDocument";

function stroke(overrides: Partial<ImageEditorObject> = {}): ImageEditorObject {
  return {
    id: "stroke",
    kind: "freehand",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    rotation: 0,
    color: "#123456",
    strokeWidth: 10,
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 50 },
    ],
    ...overrides,
  } as ImageEditorObject;
}

describe("image editor documents", () => {
  it.each([0, 30, 90, -90, 180])(
    "anchors a resized object's rotated top-left at %s degrees",
    (rotation) => {
      const original = { x: 200, y: 150, width: 100, height: 40, rotation };
      const resized = anchoredImageEditorResize(original, 380, 100);
      const topLeft = (box: { x: number; y: number; width: number; height: number }) => {
        const angle = (rotation * Math.PI) / 180;
        return {
          x:
            box.x +
            box.width / 2 -
            (box.width / 2) * Math.cos(angle) +
            (box.height / 2) * Math.sin(angle),
          y:
            box.y +
            box.height / 2 -
            (box.width / 2) * Math.sin(angle) -
            (box.height / 2) * Math.cos(angle),
        };
      };
      expect(topLeft(resized).x).toBeCloseTo(topLeft(original).x);
      expect(topLeft(resized).y).toBeCloseTo(topLeft(original).y);
    },
  );

  it("resizes local stroke geometry without changing prior versions and invalidates redo after branching", () => {
    const original = createImageEditorDocument(800, 600);
    let history = createImageEditorHistory(original);
    const added = addImageEditorObject(original, stroke());
    history = commitImageEditorDocument(history, added);
    const resized = updateImageEditorObject(added, "stroke", { width: 200, height: 25, x: 90 });
    history = commitImageEditorDocument(history, resized);
    expect(resized.objects[0]).toMatchObject({
      x: 90,
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 25 },
      ],
    });
    expect(added.objects[0]).toMatchObject({
      x: 10,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 50 },
      ],
    });
    history = undoImageEditor(history);
    expect(history.present).toBe(added);
    expect(redoImageEditor(history).present).toBe(resized);
    history = commitImageEditorDocument(
      history,
      removeImageEditorObject(history.present, "stroke"),
    );
    expect(redoImageEditor(history)).toBe(history);
    expect(undoImageEditor(history).present).toBe(added);
    expect(original.objects).toEqual([]);
  });

  it("selects actual rotated strokes rather than their empty bounds and follows stacking order", () => {
    const original = createImageEditorDocument(800, 600);
    const bottom = stroke({ id: "bottom" });
    const top = stroke({ id: "top" });
    let document = addImageEditorObject(addImageEditorObject(original, bottom), top);
    expect(hitTestImageEditorObject(document, { x: 60, y: 45 })?.id).toBe("top");
    expect(hitTestImageEditorObject(document, { x: 10, y: 70 })).toBeNull();
    document = reorderImageEditorObject(document, "top", "backward");
    expect(hitTestImageEditorObject(document, { x: 60, y: 45 })?.id).toBe("bottom");
    document = updateImageEditorObject(document, "bottom", { rotation: 90 });
    document = removeImageEditorObject(document, "top");
    expect(hitTestImageEditorObject(document, { x: 85, y: -5 })?.id).toBe("bottom");
    expect(hitTestImageEditorObject(document, { x: 10, y: 20 })).toBeNull();
    const bounds = imageEditorObjectBounds(document.objects[0]!);
    expect(bounds.x).toBeCloseTo(35);
    expect(bounds.y).toBeCloseTo(-5);
    expect(bounds.width).toBeCloseTo(50);
    expect(bounds.height).toBeCloseTo(100);
  });

  it("keeps a six-display-pixel target around thin annotations on large fitted images", () => {
    const document = addImageEditorObject(
      createImageEditorDocument(4000, 3000),
      stroke({
        x: 100,
        y: 100,
        width: 500,
        height: 1,
        strokeWidth: 2,
        points: [
          { x: 0, y: 0 },
          { x: 500, y: 0 },
        ],
      }),
    );
    expect(hitTestImageEditorObject(document, { x: 300, y: 125 })).toBeNull();
    expect(hitTestImageEditorObject(document, { x: 300, y: 125 }, 0.2)?.id).toBe("stroke");
    expect(hitTestImageEditorObject(document, { x: 300, y: 135 }, 0.2)).toBeNull();
    expect(hitTestImageEditorObject(document, { x: 300, y: 104 }, 2)).toBeNull();
  });

  it("bounds crops to the source and keeps annotation coordinates in source space", () => {
    const original = addImageEditorObject(createImageEditorDocument(800, 600), stroke());
    const cropped = setImageEditorCrop(original, { x: 750, y: -20, width: 200, height: 1000 });
    expect(cropped.crop).toEqual({ x: 750, y: 0, width: 50, height: 600 });
    expect(cropped.objects).toBe(original.objects);
    expect(setImageEditorCrop(cropped, null).crop).toBeNull();
    expect(setImageEditorCrop(original, { x: Number.NaN, y: 0, width: 100, height: 100 })).toBe(
      original,
    );
  });

  it("exports only removal geometry to masks, escapes text and preserves arrow direction", () => {
    let document = createImageEditorDocument(800, 600);
    document = addImageEditorObject(document, stroke({ kind: "remove" }));
    document = addImageEditorObject(
      document,
      stroke({
        id: "arrow",
        kind: "arrow",
        points: [
          { x: 100, y: 0 },
          { x: 0, y: 50 },
        ],
      }),
    );
    document = addImageEditorObject(document, {
      id: "text",
      kind: "text",
      x: 0,
      y: 0,
      width: 400,
      height: 100,
      rotation: 0,
      color: "#ffffff",
      strokeWidth: 1,
      text: '<script>&"',
      fontFamily: 'a" onload="bad',
      fontSize: 20,
      align: "left",
      letterSpacing: 2,
      lineHeight: 1.2,
      stretch: 1,
      curve: 0,
    });
    const resizedText = updateImageEditorObject(document, "text", { width: 800, height: 200 });
    expect(resizedText.objects.at(-1)).toMatchObject({
      fontSize: 40,
      stretch: 1,
      letterSpacing: 4,
    });
    const wideText = updateImageEditorObject(document, "text", { width: 800 });
    expect(wideText.objects.at(-1)).toMatchObject({ fontSize: 20, stretch: 2 });
    const markup = imageEditorSvgMarkup(document);
    expect(markup).toContain("M100 0 L0 50");
    expect(markup).toContain("&lt;script&gt;&amp;&quot;");
    expect(markup).toContain("a&quot; onload=&quot;bad");
    expect(markup).not.toContain("<script>");
    const curved = updateImageEditorObject(document, "text", { curve: 20, stretch: 2 });
    expect(imageEditorSvgMarkup(curved)).toContain('transform="scale(2 1)"');
    expect(imageEditorSvgMarkup(curved)).toContain("Q100 4 180 44");
    const mask = imageEditorSvgMarkup(document, { mode: "mask" });
    expect(mask).toContain('stroke="#ffffff"');
    expect(mask).toContain("M0 0 L100 50");
    expect(mask).not.toContain("M100 0 L0 50");
    expect(mask).not.toContain("<text");
    expect(mask).not.toContain("opacity");
  });

  it("numbers surviving location comments consistently and maps them into the cropped attachment", () => {
    let document = createImageEditorDocument(800, 600);
    const pin: ImageEditorObject = {
      id: "pin",
      kind: "pin",
      x: 390,
      y: 290,
      width: 20,
      height: 20,
      rotation: 0,
      color: "#ff0000",
      strokeWidth: 2,
      comment: "Replace this sign",
    };
    document = addImageEditorObject(document, { ...pin, id: "deleted" });
    document = addImageEditorObject(document, pin);
    document = removeImageEditorObject(document, "deleted");
    document = addImageEditorObject(document, {
      ...pin,
      id: "outside",
      x: 0,
      y: 0,
      comment: "Omitted comment",
    });
    document = setImageEditorCrop(document, { x: 200, y: 100, width: 400, height: 400 });
    const prompt = buildImageEditorPrompt(document, {
      instructions: "Keep the lighting",
      removeBackground: true,
      aspectRatio: "16:9",
    });
    expect(imageEditorSvgMarkup(document)).toContain(">1</text>");
    expect(prompt).toContain("1. At 50% from the left, 50% from the top: Replace this sign");
    expect(prompt).not.toContain("Omitted comment");
    expect(prompt).toContain("Keep the lighting");
    expect(prompt).toContain("transparent background");
    expect(prompt).toContain("16:9 aspect ratio");
  });
});
