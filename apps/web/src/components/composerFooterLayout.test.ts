import { describe, expect, it } from "vite-plus/test";

import { type ContextStripCompaction, resolveContextStripCompaction } from "./BranchToolbar.logic";
import {
  type RestingComposerControlsLayout,
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsMinimumWidth,
  resolveRestingComposerControlsNarrowestWidth,
} from "./composerFooterLayout";

describe("composer footer collapse order", () => {
  const stripGap = 4;
  const chipsChromeWidth = 110;
  const envLabelWidth = 64;
  const branchLabelWidth = 180;
  const truncatedBranchLabelWidth = 96;
  const controls = {
    gap: 2,
    naturalFixedWidth: 148,
    traitsIconOnlyFixedWidth: 118,
    iconOnlyFixedWidth: 56,
    blockWidths: [58],
    iconOnlyBlockWidths: [28],
    overflowWidth: 28,
  };
  const chipsWidth = (strip: ContextStripCompaction) =>
    chipsChromeWidth +
    (strip === "none" ? envLabelWidth : 0) +
    (strip === "branch" ? truncatedBranchLabelWidth : branchLabelWidth);

  function settle(
    availableWidth: number,
    compactBelow: number,
    previous: { strip: ContextStripCompaction; controls: RestingComposerControlsLayout },
  ) {
    let { strip, controls: layout } = previous;
    for (let pass = 0; pass < 3; pass += 1) {
      strip = resolveContextStripCompaction({
        current: strip,
        neededWidth:
          chipsWidth("none") +
          stripGap +
          resolveRestingComposerControlsNarrowestWidth(controls, "none"),
        labelsNeededWidth:
          chipsWidth("labels") +
          stripGap +
          resolveRestingComposerControlsNarrowestWidth(controls, "labels"),
        availableWidth,
      });
      layout = resolveRestingComposerControlsLayout({
        ...controls,
        hostWidth: availableWidth - chipsWidth(strip) - stripGap,
        previous: layout,
        stripCompaction: strip,
        compactLabels: availableWidth < compactBelow,
      });
    }
    return { strip, controls: layout };
  }

  const order = ["mode", "effort", "env", "model", "branch", "overflow"] as const;
  const controlLabels = ["mode", "effort", "model"];
  const collapsed = ({
    strip,
    controls: layout,
  }: {
    strip: ContextStripCompaction;
    controls: RestingComposerControlsLayout;
  }) =>
    order.filter(
      (_, index) =>
        [
          (layout.iconOnlyCount ?? 0) > 0,
          layout.traitsIconOnly === true,
          strip !== "none",
          layout.pickerIconOnly === true,
          strip === "branch",
          layout.hiddenCount > 0,
        ][index],
    );

  it("collapses one item at a time above the label cutoff and every control label below it", () => {
    const sweep = (compactBelow: number) => {
      let state = {
        strip: "none" as ContextStripCompaction,
        controls: { hiddenCount: 0, visible: true } as RestingComposerControlsLayout,
      };
      const visit = (widths: number[]) => {
        const steps: string[][] = [];
        for (const width of widths) {
          state = settle(width, compactBelow, state);
          const items = collapsed(state);
          const ordered =
            width < compactBelow
              ? [...controlLabels, ...order.filter((item) => !controlLabels.includes(item))]
              : order;
          expect(items.toSorted()).toEqual(ordered.slice(0, items.length).toSorted());
          if (width < compactBelow) expect(items).toEqual(expect.arrayContaining(controlLabels));
          if (!state.controls.pickerIconOnly) {
            const hostWidth = width - chipsWidth(state.strip) - stripGap;
            expect(
              resolveRestingComposerControlsLayout({ ...controls, hostWidth }).pickerIconOnly,
            ).toBe(false);
          }
          if (steps.at(-1)?.join() !== items.join()) steps.push(items);
        }
        return steps.map((items) => items.join(" "));
      };
      const widths = Array.from({ length: 501 }, (_, index) => 700 - index);
      return { narrowing: visit(widths), widening: visit(widths.toReversed()) };
    };

    expect(sweep(0)).toEqual({
      narrowing: [
        "",
        "mode",
        "mode effort",
        "mode effort env",
        "mode effort env model",
        "mode effort env model branch",
        "mode effort env model branch overflow",
      ],
      widening: [
        "mode effort env model branch overflow",
        "mode effort env model branch",
        "mode effort env model",
        "mode effort env",
        "mode effort",
        "mode",
        "",
      ],
    });
    expect(sweep(550)).toEqual({
      narrowing: [
        "",
        "mode",
        "mode effort model",
        "mode effort env model",
        "mode effort env model branch",
        "mode effort env model branch overflow",
      ],
      widening: [
        "mode effort env model branch overflow",
        "mode effort env model branch",
        "mode effort env model",
        "mode effort model",
        "mode",
        "",
      ],
    });
    expect(sweep(470)).toEqual(sweep(0));
  });
});

describe("resolveRestingComposerControlsLayout hysteresis", () => {
  const base = {
    gap: 4,
    naturalFixedWidth: 149,
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

describe("resolveRestingComposerControlsLayout with icon-only controls", () => {
  // Picker 115 with its label, 34 as an icon. Effort 80 / 30,
  // access 99 / 30, overflow 30, gap 2.
  const tray = {
    gap: 2,
    naturalFixedWidth: 115,
    iconOnlyFixedWidth: 34,
    blockWidths: [80, 99],
    iconOnlyBlockWidths: [30, 30],
    overflowWidth: 30,
  };

  it("drops trailing labels before the model label", () => {
    // 115 + 80 + 99 + 2 * 2 = 298
    expect(resolveRestingComposerControlsLayout({ ...tray, hostWidth: 298 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 0,
      pickerIconOnly: false,
      visible: true,
    });
    // 115 + 80 + 30 + 4 = 229
    expect(resolveRestingComposerControlsLayout({ ...tray, hostWidth: 229 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 1,
      pickerIconOnly: false,
      visible: true,
    });
    // 115 + 30 + 30 + 4 = 179
    expect(resolveRestingComposerControlsLayout({ ...tray, hostWidth: 179 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 2,
      pickerIconOnly: false,
      visible: true,
    });
    // 34 + 30 + 30 + 4 = 98
    expect(resolveRestingComposerControlsLayout({ ...tray, hostWidth: 178 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 2,
      pickerIconOnly: true,
      visible: true,
    });
  });

  it("moves blocks into overflow only once every control is an icon", () => {
    expect(resolveRestingComposerControlsLayout({ ...tray, hostWidth: 97 })).toEqual({
      hiddenCount: 2,
      iconOnlyCount: 2,
      pickerIconOnly: true,
      visible: true,
    });
    const minimumWidth = resolveRestingComposerControlsMinimumWidth(tray);
    expect(resolveRestingComposerControlsLayout({ ...tray, hostWidth: minimumWidth }).visible).toBe(
      true,
    );
    expect(
      resolveRestingComposerControlsLayout({ ...tray, hostWidth: minimumWidth - 1 }).visible,
    ).toBe(false);
  });
});
