import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createChatCanvasStore,
  selectCanvasMeasurements,
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
  direction: "ltr",
  width,
  height,
  padding: 48,
  maxChatWidth: 768,
  maxHtmlPreviewWidth: 768,
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
  it.each(["ltr", "rtl"] as const)("fits the details card beside the chat in %s", (direction) => {
    const resolve = (width: number, narrowestWidth = width) =>
      resolveChatCanvasModel({
        measurements: { ...measurements(width), narrowestWidth, direction },
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      });
    expect(resolve(1400).detailsCardMode).toBe("inline");
    expect(resolve(1400).detailsCardPlacement?.x).toBe(direction === "rtl" ? 12 : 1108);
    expect(resolve(900).detailsCardMode).toBe("popover");
    expect(resolve(1400, 900).detailsCardMode).toBe("popover");
  });

  it("keeps the html preview lane offset logical in rtl on an asymmetric canvas", () => {
    const resolve = (direction: "ltr" | "rtl") =>
      resolveChatCanvasModel({
        measurements: { ...measurements(1200), maxHtmlPreviewWidth: 960, direction },
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight: 300 },
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      });
    const ltr = resolve("ltr");
    const rtl = resolve("rtl");
    expect(rtl.layout.htmlPreview.width).toBe(ltr.layout.htmlPreview.width);
    expect(rtl.layout.htmlPreview.left - rtl.layout.chat.left).toBe(
      ltr.layout.htmlPreview.left - ltr.layout.chat.left,
    );
  });

  it.each(["ltr", "rtl"] as const)(
    "avoids the card when a preview leaves too little height in %s",
    (direction) => {
      const resolve = (fullContentHeight: number) =>
        resolveChatCanvasModel({
          measurements: { ...measurements(1100, 300), direction },
          detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
          threadRef,
          preview: {
            ...preview,
            position: { x: direction === "rtl" ? 20 : 760, y: 150 },
            lastInteraction: "drag",
          },
          detailsCardInlineOpen: true,
        });
      const model = resolve(400);
      expect(model.layout.overlapsDetailsCard).toBe(true);
      expect(model.detailsCardMode).toBe("popover");
    },
  );

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
    store.getState().setMeasurements(measurements(1400), false);
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400), false);
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    const measured = store.getState();
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    expect(measured.measurements).toBe(before.measurements);
    expect(store.getState()).toBe(measured);
    store.getState().setMeasurements({ ...measurements(1400), narrowestWidth: 900 }, false);
    expect(store.getState().measurements.narrowestWidth).toBe(900);
    expect(store.getState()).not.toBe(measured);
  });

  it("lays out with the width last measured for the right panel's state", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400), false);
    expect(selectCanvasMeasurements(store.getState(), true).width).toBe(1400);
    store.getState().setMeasurements(measurements(860), true);
    store.getState().setMeasurements(measurements(1400), false);
    const closed = store.getState();
    expect(selectCanvasMeasurements(closed, true).width).toBe(860);
    store.getState().setMeasurements(measurements(860), true);
    expect(selectCanvasMeasurements(store.getState(), true)).toBe(
      selectCanvasMeasurements(closed, true),
    );
  });
});
