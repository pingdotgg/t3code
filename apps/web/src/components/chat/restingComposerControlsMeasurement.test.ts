import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveRestingComposerControlsLayout } from "../composerFooterLayout";
import {
  measureRestingComposerControls,
  measureRestingComposerControlsHostWidth,
} from "./restingComposerControlsMeasurement";

function measurePicker(input: { clientWidth: number; flexGrow: string; maxWidth?: string }) {
  const label = { clientWidth: input.clientWidth, scrollWidth: 160 };
  const picker = {
    getBoundingClientRect: () => ({ width: 52 }),
    querySelector: () => label,
  };
  const controls = {
    querySelector: (selector: string) => {
      if (selector === "[data-chat-provider-model-picker]") return picker;
      if (selector === "[data-resting-controls-overflow]") {
        return { getBoundingClientRect: () => ({ width: 24 }) };
      }
      return null;
    },
    querySelectorAll: () => [
      {
        dataset: {},
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 140 }),
      },
    ],
  };
  vi.stubGlobal("getComputedStyle", (element: unknown) => {
    if (element === label) return { flexGrow: input.flexGrow };
    if (element === picker) return { minWidth: "52px", maxWidth: input.maxWidth ?? "none" };
    return { columnGap: "4px" };
  });
  return measureRestingComposerControls(controls as unknown as HTMLElement)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("measureRestingComposerControlsHostWidth", () => {
  function hostWith(input: { promptWidth: number; previewsWidth?: number }) {
    const previews =
      input.previewsWidth === undefined
        ? null
        : { getBoundingClientRect: () => ({ width: input.previewsWidth }) };
    const reserved = { dataset: { restingControlsReserved: String(input.promptWidth) } };
    const host = {
      clientWidth: 600,
      querySelector: (selector: string) =>
        selector === "[data-resting-controls-reserved]" ? reserved : previews,
    };
    vi.stubGlobal("getComputedStyle", (target: unknown) => {
      if (target === host) return { paddingLeft: "16px", paddingRight: "80px", columnGap: "4px" };
      return { marginInlineStart: "0px", marginInlineEnd: "0px" };
    });
    return host as unknown as HTMLElement;
  }

  it("subtracts the host padding and the prompt's reservation", () => {
    expect(measureRestingComposerControlsHostWidth(hostWith({ promptWidth: 160 }))).toBe(
      600 - 16 - 80 - 160 - 4,
    );
  });

  it("also reserves the rendered width of image previews beside the prompt", () => {
    expect(
      measureRestingComposerControlsHostWidth(hostWith({ promptWidth: 160, previewsWidth: 132 })),
    ).toBe(600 - 16 - 80 - (160 + 4 + 132) - 4);
  });

  it("uses the whole content box without a reserved group", () => {
    const host = { clientWidth: 300, querySelector: () => null };
    vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "0px", paddingRight: "0px" }));
    expect(measureRestingComposerControlsHostWidth(host as unknown as HTMLElement)).toBe(300);
  });
});

describe("measureRestingComposerControls", () => {
  it("keeps controls inline when the model label is deliberately collapsed", () => {
    const measurement = measurePicker({ clientWidth: 0, flexGrow: "0" });

    expect(measurement.naturalFixedWidth).toBe(52);
    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 0,
      visible: true,
    });
  });

  it("recovers truncated text while the model label is flexible", () => {
    const measurement = measurePicker({ clientWidth: 20, flexGrow: "1" });

    expect(measurement.naturalFixedWidth).toBe(192);
    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 1,
      iconOnlyCount: 1,
      visible: true,
    });
  });

  it("recovers flexible text squeezed to zero instead of mistaking it for collapsed text", () => {
    const measurement = measurePicker({ clientWidth: 0, flexGrow: "1" });

    expect(measurement.naturalFixedWidth).toBe(212);
    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 1,
      iconOnlyCount: 1,
      visible: true,
    });
  });

  it("still caps recovered text at the model picker's maximum width", () => {
    expect(
      measurePicker({ clientWidth: 0, flexGrow: "1", maxWidth: "180px" }).naturalFixedWidth,
    ).toBe(180);
  });
});
