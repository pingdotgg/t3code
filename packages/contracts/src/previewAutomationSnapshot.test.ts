import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationSnapshot } from "./previewAutomation.ts";

const legacySnapshot = {
  url: "https://example.test/",
  title: "Page",
  loading: false,
  visibleText: "Whole page",
  interactiveElements: [
    {
      tag: "button",
      role: null,
      name: "Open",
      selector: "#open",
      x: 0,
      y: 0,
      width: 80,
      height: 20,
    },
  ],
  accessibilityTree: null,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: "image", width: 300, height: 200 },
};
const decode = Schema.decodeUnknownSync(PreviewAutomationSnapshot);

describe("PreviewAutomationSnapshot", () => {
  it("accepts snapshots from desktop hosts without scroll context", () => {
    expect(decode(legacySnapshot)).toEqual(legacySnapshot);
  });

  it("preserves viewport text, scroll context, and omission flags across the wire", () => {
    const snapshot = {
      ...legacySnapshot,
      viewportText: "Current view",
      interactiveElements: [{ ...legacySnapshot.interactiveElements[0], inViewport: true }],
      scroll: {
        x: 0,
        y: 2_000,
        width: 300,
        height: 200,
        scrollWidth: 300,
        scrollHeight: 5_000,
        containers: [
          {
            selector: "#list",
            x: 10,
            y: 600,
            width: 100,
            height: 100,
            scrollWidth: 200,
            scrollHeight: 1_000,
          },
        ],
        containersTruncated: false,
      },
      truncated: { visibleText: true, viewportText: false, interactiveElements: true },
    };
    expect(decode(snapshot)).toEqual(snapshot);
  });
});
