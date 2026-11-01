import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createChatCanvasStore,
  resolveChatCanvasModel,
  type ChatCanvasMeasurements,
} from "./canvasStore";
import type { ChatCanvasPreview } from "./chatCanvasLayout";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThreadRef = { ...threadRef, threadId: ThreadId.make("thread-2") };
const measurements = (
  width: number,
  height = 900,
  settledWidth = width,
): ChatCanvasMeasurements => ({
  width,
  settledWidth,
  height,
  padding: 48,
  maxChatWidth: 768,
  minChatWidth: 640,
  composerHeight: 180,
  timelineGutter: 0,
  findBar: null,
});
const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};

describe("chat canvas model", () => {
  it("shows the details card inline only where the canvas fits it beside the chat", () => {
    const resolve = (width: number) =>
      resolveChatCanvasModel({
        measurements: measurements(width),
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      }).detailsCardMode;
    expect(resolve(1400)).toBe("inline");
    expect(resolve(900)).toBe("popover");
  });

  it("decides from the settled width while a panel animates the canvas", () => {
    const resolve = (width: number, settledWidth: number) =>
      resolveChatCanvasModel({
        measurements: measurements(width, 900, settledWidth),
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight: 300 },
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      });
    const opening = resolve(1400, 700);
    expect(opening.detailsCardMode).toBe("popover");
    expect(opening.laneAvoidsDetailsCard).toBe(false);
    const closing = resolve(700, 1400);
    expect(closing.detailsCardMode).toBe("inline");
    expect(closing.canvasSettling).toBe(true);
    expect(closing.detailsCardPlacement?.x).toBe(1400 - 280 - 12);
    expect(closing.laneAvoidsDetailsCard).toBe(true);
    expect(resolve(1400, 1400).canvasSettling).toBe(false);
  });

  it("moves the card into a popover when a preview below it leaves too little height", () => {
    const resolve = (fullContentHeight: number) =>
      resolveChatCanvasModel({
        measurements: measurements(1100, 300),
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
        threadRef,
        preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
        detailsCardInlineOpen: true,
      });
    const model = resolve(400);
    expect(model.layout.overlapsDetailsCard).toBe(true);
    expect(model.detailsCardMode).toBe("popover");
  });

  it("ignores a details card measured for another thread", () => {
    const model = resolveChatCanvasModel({
      measurements: measurements(1100, 300),
      detailsCardMeasurement: { threadRef: otherThreadRef, width: 280, fullContentHeight: 400 },
      threadRef,
      preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
      detailsCardInlineOpen: true,
    });
    expect(model.layout.overlapsDetailsCard).toBe(false);
    expect(model.detailsCardMode).toBe("inline");
  });

  it("keeps state identity when a measurement repeats", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400));
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400));
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    const measured = store.getState();
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    expect(measured.measurements).toBe(before.measurements);
    expect(store.getState()).toBe(measured);
  });
});
