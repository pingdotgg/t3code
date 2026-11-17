import { describe, expect, it } from "vite-plus/test";

import { resolveChatCanvasLayout } from "../chat/chatCanvasLayout";
import {
  type PreviewMiniPlayerGesture,
  settlePreviewMiniPlayerResize,
  stepPreviewMiniPlayerGesture,
} from "./previewMiniPlayerGesture";

const container = { width: 1_440, height: 900 };
const frame = { x: 996, y: 433, width: 268, height: 179 };
const gesture: PreviewMiniPlayerGesture = {
  pointerId: 1,
  pointerType: "mouse",
  pointerX: 996,
  pointerY: 433,
  frame,
  direction: "northwest",
  source: { width: 1_200, height: 800 },
  moved: true,
};
const pointer = { pointerId: 1, buttons: 1, clientX: 936, clientY: 393 };

describe("stepPreviewMiniPlayerGesture", () => {
  it("ends on a move without the primary button instead of following the hover", () => {
    expect(stepPreviewMiniPlayerGesture(gesture, pointer, container).kind).toBe("resize");
    expect(stepPreviewMiniPlayerGesture(gesture, { ...pointer, buttons: 0 }, container)).toEqual({
      kind: "end",
    });
    expect(stepPreviewMiniPlayerGesture(gesture, { ...pointer, buttons: 2 }, container)).toEqual({
      kind: "end",
    });
    expect(stepPreviewMiniPlayerGesture(gesture, { ...pointer, pointerId: 2 }, container)).toEqual({
      kind: "ignore",
    });
  });

  it("resizes at the shape the gesture started with", () => {
    const step = stepPreviewMiniPlayerGesture(gesture, pointer, container);
    expect(step).toEqual({ kind: "resize", frame: { x: 936, y: 393, width: 328, height: 219 } });
  });
});

describe("settlePreviewMiniPlayerResize", () => {
  it("keeps the corner opposite the handle when the source changed shape mid-resize", () => {
    const source = { width: 1_200, height: 1_000 };
    const settled = settlePreviewMiniPlayerResize({
      frame,
      direction: "northwest",
      held: gesture.source,
      source,
      container,
    });
    expect(settled).toEqual({ x: 1_018, y: 407, width: 246, height: 205 });
    expect(
      resolveChatCanvasLayout({
        container,
        preview: {
          key: "browser:tab",
          width: settled!.width,
          position: settled,
          source,
          lastInteraction: "resize",
        },
      }).frame,
    ).toEqual(settled);
    expect(
      settlePreviewMiniPlayerResize({
        frame,
        direction: "northwest",
        held: gesture.source,
        source: { width: 600, height: 400 },
        container,
      }),
    ).toBeNull();
  });
});
