// @effect-diagnostics nodeBuiltinImport:off - Image rendering test writes temporary PNGs directly.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import { renderBeforeAfterComparison } from "./annotate.ts";
import {
  buildOverlayBoxes,
  diffAuditCaptures,
  isPlatformNoise,
  renderMarkdownReport,
  type AuditCapture,
  type RawSnapshotData,
} from "./diff.ts";

describe("mobile-audit diff", () => {
  it("filters iOS UISwitch frames, dictation chrome, and scroll-edge clipped rows", () => {
    const viewport = { width: 402, height: 874 };
    expect(
      isPlatformNoise(
        {
          ref: "@e1",
          kind: "small-target",
          role: "switch",
          label: "Enable cups",
          detail: { unit: "pt", width: 63, height: 28, recommendedSize: 44 },
        },
        "ios",
        viewport,
      ),
    ).toBe(true);

    expect(
      isPlatformNoise(
        {
          ref: "@e2",
          kind: "ambiguous-name",
          role: "button",
          label: "Dictate",
          identifier: "dictation",
        },
        "ios",
        viewport,
      ),
    ).toBe(true);

    expect(
      isPlatformNoise(
        {
          ref: "@e3",
          kind: "small-target",
          role: "button",
          label: "Bottom row",
          rect: { x: 0, y: 860, width: 402, height: 14 },
        },
        "ios",
        viewport,
      ),
    ).toBe(true);

    expect(
      isPlatformNoise(
        {
          ref: "@e4",
          kind: "small-target",
          role: "text-field",
          label: "Address",
          rect: { x: 111, y: 431, width: 260, height: 23 },
          detail: { unit: "pt", width: 260, height: 23.3, recommendedSize: 44 },
        },
        "ios",
        viewport,
      ),
    ).toBe(false);
  });

  it("classifies fixed, regressed, and unchanged findings and locates fixed after bounds", () => {
    const before: AuditCapture = {
      platform: "android",
      screen: "connections-new",
      viewport: { width: 1080, height: 2424 },
      pixelDensity: 2.625,
      findings: [
        {
          ref: "@e1",
          kind: "small-target",
          role: "text-field",
          label: "Address",
          rect: { x: 293, y: 1055, width: 707, height: 61 },
          detail: { unit: "dp", width: 269.3, height: 23.2, recommendedSize: 48 },
        },
        {
          ref: "@e2",
          kind: "missing-name",
          role: "button",
          rect: { x: 11, y: 74, width: 126, height: 126 },
        },
      ],
    };

    const after: AuditCapture = {
      platform: "android",
      screen: "connections-new",
      viewport: { width: 1080, height: 2424 },
      pixelDensity: 2.625,
      findings: [
        {
          ref: "@e2",
          kind: "missing-name",
          role: "button",
          rect: { x: 11, y: 74, width: 126, height: 126 },
        },
        {
          ref: "@e9",
          kind: "small-target",
          role: "button",
          label: "Scan QR code",
          rect: { x: 100, y: 400, width: 100, height: 90 },
          detail: { unit: "dp", width: 38.1, height: 34.3, recommendedSize: 48 },
        },
      ],
    };

    const afterRaw: RawSnapshotData = {
      viewport: { width: 1080, height: 2424 },
      androidSnapshot: { pixelDensity: 2.625 },
      nodes: [
        {
          index: 10,
          type: "android.widget.EditText",
          label: "Address",
          rect: { x: 293, y: 1055, width: 707, height: 126 },
        },
      ],
    };

    const diff = diffAuditCaptures({ before, after, afterRaw });
    expect(diff.fixed).toHaveLength(1);
    expect(diff.fixed[0]?.before.label).toBe("Address");
    expect(diff.fixed[0]?.afterMeasurement).toBe("48dp ✓");
    expect(diff.regressions).toHaveLength(1);
    expect(diff.regressions[0]?.label).toBe("Scan QR code");
    expect(diff.unchanged).toHaveLength(1);

    const { beforeBoxes, afterBoxes } = buildOverlayBoxes(diff, 2.625);
    expect(beforeBoxes).toHaveLength(1);
    expect(beforeBoxes[0]?.tag).toBe("23.2dp");
    expect(afterBoxes).toHaveLength(2);
    expect(afterBoxes.map((b) => b.tag)).toEqual(["48dp ✓", "NEW: 34.3dp"]);

    const md = renderMarkdownReport([{ ...diff, imagePath: "android-connections-new.png" }]);
    expect(md).toContain("**1 fixed**, **1 regressions**");
    expect(md).toContain("![android connections-new before vs after](android-connections-new.png)");
  });

  it("composites a side-by-side annotated PNG for Retina 3x iOS screenshots", async () => {
    const tmp = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mobile-audit-test-"));
    try {
      const beforePng = NodePath.join(tmp, "before.png");
      const afterPng = NodePath.join(tmp, "after.png");
      const outPng = NodePath.join(tmp, "comparison.png");

      await sharp({
        create: {
          width: 1206,
          height: 2622,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toFile(beforePng);
      await sharp({
        create: {
          width: 1206,
          height: 2622,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        },
      })
        .png()
        .toFile(afterPng);

      const result = await renderBeforeAfterComparison({
        beforePng,
        beforeBoxes: [{ x: 111, y: 431, width: 260, height: 23, tag: "23.3pt", color: "#ef4444" }],
        beforeTitle: "BEFORE (main)",
        beforeViewport: { width: 402, height: 874 },
        afterPng,
        afterBoxes: [{ x: 111, y: 431, width: 260, height: 48, tag: "48pt ✓", color: "#16a34a" }],
        afterTitle: "AFTER (PR)",
        afterViewport: { width: 402, height: 874 },
        outPath: outPng,
      });

      const outMeta = await sharp(outPng).metadata();
      expect(outMeta.format).toBe("png");
      expect(outMeta.width).toBe(result.width);
      expect(outMeta.height).toBe(result.height);
      expect(outMeta.width).toBe(1128);
    } finally {
      await NodeFSP.rm(tmp, { recursive: true, force: true });
    }
  });
});
