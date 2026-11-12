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
const measurements = (width: number, height = 900): ChatCanvasMeasurements => ({
  width,
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
    const resolve = (width: number, centerChatBesideDetails = false) =>
      resolveChatCanvasModel({
        measurements: measurements(width),
        centerChatBesideDetails,
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      }).detailsCardMode;
    expect(resolve(1400)).toBe("inline");
    expect(resolve(900)).toBe("popover");
    expect(resolve(1400, true)).toBe("inline");
    expect(resolve(900, true)).toBe("popover");
  });

  it("centers beside details only when opted in and an inline card is shown", () => {
    for (const [width, maxChatWidth, defaultLeft, besideLeft] of [
      [1500, 736, 382, 236],
      [2200, 736, 732, 586],
      [2200, 1024, 588, 442],
      [1108, 736, 48, 48],
      [1012, 736, 48, 48],
      [1000, 736, 132, 132],
      [1500, 10000, 48, 48],
    ] as const) {
      const resolve = (centerChatBesideDetails: boolean, detailsCardInlineOpen = true) =>
        resolveChatCanvasModel({
          measurements: { ...measurements(width), maxChatWidth },
          detailsCardMeasurement: { threadRef, width: 280, fullContentHeight: 300 },
          threadRef,
          preview: null,
          detailsCardInlineOpen,
          centerChatBesideDetails,
        });
      expect(resolve(false).layout.chat.left).toBe(defaultLeft);
      expect(resolve(true).layout.chat.left).toBe(besideLeft);
      expect(resolve(true, false)).toEqual(resolve(false, false));
      expect(resolve(true).detailsCardMode).toBe(resolve(false).detailsCardMode);
    }
  });

  it("moves the card into a popover when a preview below it leaves too little height", () => {
    const resolve = (fullContentHeight: number, centerChatBesideDetails = false) =>
      resolveChatCanvasModel({
        measurements: measurements(1100, 300),
        centerChatBesideDetails,
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
        threadRef,
        preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
        detailsCardInlineOpen: true,
      });
    const model = resolve(400);
    expect(model.layout.overlapsDetailsCard).toBe(true);
    expect(model.detailsCardMode).toBe("popover");
    expect(resolve(400, true)).toEqual(model);
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
