import type { SnapShotSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cropSnapShotSource } from "./snapShotSource";

describe("cropSnapShotSource", () => {
  it("re-anchors element bounds to the crop and drops nodes outside it", () => {
    const source: SnapShotSource = {
      kind: "snap-shot",
      capturedAt: "2026-11-10T00:00:00.000Z",
      appName: "Browser",
      windowTitle: "Page",
      accessibility: {
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 1000, height: 800 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 1000, height: 800 },
          children: [
            { role: "button", bounds: { x: 150, y: 120, width: 40, height: 20 }, children: [] },
            { role: "link", bounds: { x: 90, y: 90, width: 20, height: 20 }, children: [] },
            { role: "footer", bounds: { x: 0, y: 700, width: 1000, height: 100 }, children: [] },
          ],
        },
      },
    };

    const cropped = cropSnapShotSource(source, { x: 100, y: 100, width: 300, height: 200 });

    expect(cropped.accessibility).toMatchObject({
      imageSize: { width: 300, height: 200 },
      root: {
        bounds: { x: 0, y: 0, width: 300, height: 200 },
        children: [
          { bounds: { x: 50, y: 20, width: 40, height: 20 } },
          { bounds: { x: 0, y: 0, width: 10, height: 10 } },
          { bounds: null },
        ],
      },
    });
  });
});
