import { describe, expect, it } from "vite-plus/test";

import {
  snapShotAccessibilityDetails,
  snapShotIncludesAccessibility,
} from "./SnapShotAttachmentDetails";

describe("SnapShotAttachmentDetails", () => {
  it("reports screenshot-only captures without inventing accessibility data", () => {
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-08-27T00:00:00.000Z",
      appName: "Safari",
      windowTitle: "T3 Code",
    };

    expect(snapShotIncludesAccessibility(source)).toBe(false);
    expect(snapShotAccessibilityDetails(source)).toBeUndefined();
  });

  it("formats a structured accessibility tree as JSON", () => {
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-08-27T00:00:00.000Z",
      appName: "Safari",
      windowTitle: "T3 Code",
      accessibility: {
        format: "element-tree" as const,
        coordinateSpace: "captured-image" as const,
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          name: "T3 Code",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: [
            {
              role: "button",
              name: "Save",
              bounds: { x: 10, y: 10, width: 80, height: 24 },
              children: [],
            },
          ],
        },
      },
    };

    expect(snapShotIncludesAccessibility(source)).toBe(true);
    const details = snapShotAccessibilityDetails(source);
    expect(details?.format).toBe("json");
    expect(details?.content).toBe(JSON.stringify(source.accessibility, null, 2));
    expect(JSON.parse(details?.content ?? "")).toEqual(source.accessibility);
  });

  it("prefers structured JSON over duplicate legacy text", () => {
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-08-27T00:00:00.000Z",
      appName: "Safari",
      windowTitle: "T3 Code",
      accessibleText: "T3 Code\nSave",
      accessibility: {
        format: "element-tree" as const,
        coordinateSpace: "captured-image" as const,
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          name: "T3 Code",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: [],
        },
      },
    };

    expect(snapShotAccessibilityDetails(source)).toEqual({
      content: JSON.stringify(source.accessibility, null, 2),
      format: "json",
    });
  });

  it("falls back to flat accessibility text", () => {
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-08-27T00:00:00.000Z",
      appName: "Terminal",
      windowTitle: "Logs",
      accessibleText: "legacy duplicate",
      accessibility: {
        format: "flat-text" as const,
        text: "Current terminal text",
        truncated: false,
      },
    };

    expect(snapShotAccessibilityDetails(source)).toEqual({
      content: "Current terminal text",
      format: "text",
    });
  });
});
