import { describe, expect, it } from "vite-plus/test";

import { resolveContextStripLabelsCompact } from "./BranchToolbar.logic";
import {
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
} from "./composerFooterLayout";

describe("context strip labels and resting composer controls", () => {
  const stripWidth = 724;
  const labelWidth = 327;
  const chromeWidth = 125;
  const measurement = {
    gap: 4,
    naturalFixedWidth: 96.3828125 + 5 + 4,
    minimumFixedWidth: 52 + 5 + 4,
    blockWidths: [130.6953125, 119.671875],
    overflowWidth: 28,
  };
  const naturalWidth = resolveRestingComposerControlsNaturalWidth(measurement);

  function hostWidth(compact: boolean): number {
    return stripWidth - chromeWidth - (compact ? 0 : labelWidth);
  }

  it("keeps the labels compact when the full controls only fit beside compact labels", () => {
    const layout = resolveRestingComposerControlsLayout({
      ...measurement,
      hostWidth: hostWidth(true),
    });
    expect(layout).toEqual({ hiddenCount: 0, visible: true });

    const compact = resolveContextStripLabelsCompact({
      compact: true,
      neededWidth: chromeWidth + labelWidth + naturalWidth,
      availableWidth: stripWidth,
    });
    expect(compact).toBe(true);

    expect(
      resolveRestingComposerControlsLayout({ ...measurement, hostWidth: hostWidth(compact) }),
    ).toEqual(layout);
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
    minimumFixedWidth: 105,
    blockWidths: [60, 140],
    overflowWidth: 24,
  };

  it("settles when the measured picker width jitters below a pixel", () => {
    let layout = { hiddenCount: 0, visible: true };
    const settled: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      layout = resolveRestingComposerControlsLayout({
        ...base,
        naturalFixedWidth: index % 2 === 0 ? 149 : 149.5,
        hostWidth: 357,
        previous: layout,
      });
      if (index >= 2) settled.push(`${layout.hiddenCount}:${layout.visible}`);
    }
    expect(new Set(settled).size).toBe(1);
  });
});

describe("progressive composer controls", () => {
  const measurement = {
    gap: 4,
    naturalFixedWidth: 140,
    minimumFixedWidth: 80,
    blockWidths: [80, 140],
    iconOnlyBlockWidths: [40, 60],
    overflowWidth: 24,
  };

  it("settles through fractional label-width changes at each threshold", () => {
    for (const hostWidth of [368, 288, 248]) {
      let previous = resolveRestingComposerControlsLayout({ ...measurement, hostWidth });
      for (let index = 0; index < 10; index += 1) {
        const next = resolveRestingComposerControlsLayout({
          ...measurement,
          hostWidth,
          previous,
          naturalFixedWidth: 140 + (index % 2) * 0.5,
        });
        if (index > 1) expect(next).toEqual(previous);
        previous = next;
      }
    }
  });
});
