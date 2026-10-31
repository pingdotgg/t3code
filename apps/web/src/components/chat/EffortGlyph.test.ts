import { describe, expect, it } from "vite-plus/test";

import { effortBarHeights, resolveEffortGlyph } from "./EffortGlyph";

const descriptor = (ids: ReadonlyArray<string>, promptInjectedValues?: ReadonlyArray<string>) => ({
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: ids.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })),
  ...(promptInjectedValues ? { promptInjectedValues } : {}),
});

describe("resolveEffortGlyph", () => {
  const claude = descriptor(
    ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
    ["ultrathink"],
  );

  it("fills bars up to the current level and leaves named modes off the scale", () => {
    expect(resolveEffortGlyph(claude, "xhigh")).toEqual({
      count: 5,
      filled: 4,
      kind: "bars",
      label: "Xhigh",
    });
  });

  it("includes max in the scale, including DeepSeek's three enabled levels", () => {
    expect(resolveEffortGlyph(claude, "max")).toMatchObject({
      count: 5,
      filled: 5,
      kind: "bars",
    });
    const deepseek = descriptor(["none", "low", "high", "max"]);
    expect(resolveEffortGlyph(deepseek, "none")).toMatchObject({ kind: "bars", filled: 0 });
    expect(resolveEffortGlyph(deepseek, "high")).toMatchObject({ count: 3, filled: 2 });
    expect(resolveEffortGlyph(deepseek, "max")).toMatchObject({ count: 3, filled: 3 });
  });

  it("names Ultra, Ultracode and Ultrathink instead of drawing a level", () => {
    for (const [id, label] of [
      ["ultra", "Ultra"],
      ["ultracode", "Ultracode"],
      ["ultrathink", "Ultrathink"],
    ] as const) {
      expect(resolveEffortGlyph(descriptor(["low", "high", id]), id)).toEqual({
        kind: "label",
        label,
      });
    }
  });

  it("draws the lowest level as one bar, and an off level as none", () => {
    expect(resolveEffortGlyph(claude, "low")).toMatchObject({ count: 5, filled: 1 });
    expect(resolveEffortGlyph(claude, "medium")).toMatchObject({ count: 5, filled: 2 });
    expect(resolveEffortGlyph(descriptor(["off", "low", "high"]), "off")).toEqual({
      count: 2,
      filled: 0,
      kind: "bars",
      label: "Off",
    });
    for (const ids of [
      ["off", "on"],
      ["on", "off"],
    ]) {
      expect(resolveEffortGlyph(descriptor(ids), "off")).toMatchObject({
        kind: "thinking",
        enabled: false,
      });
      expect(resolveEffortGlyph(descriptor(ids), "on")).toMatchObject({
        kind: "thinking",
        enabled: true,
      });
    }
  });

  it.each([true, false])("distinguishes binary thinking from an effort scale: %s", (enabled) => {
    expect(
      resolveEffortGlyph({ id: "thinking", label: "Thinking", type: "boolean" }, enabled),
    ).toEqual({
      kind: "thinking",
      enabled,
      label: `Thinking ${enabled ? "On" : "Off"}`,
    });
  });

  it("falls back to the word when the value is unknown or the scale has one level", () => {
    expect(resolveEffortGlyph(claude, "unknown")).toBeNull();
    expect(resolveEffortGlyph(descriptor(["high"]), "high")).toBeNull();
  });
});

describe("effortBarHeights", () => {
  it.each([3, 4, 5, 6, 7])(
    "rises by one whole-pixel step and ends at full height: %i bars",
    (count) => {
      const heights = effortBarHeights(count, 12);
      expect(heights).toHaveLength(count);
      expect(heights.at(-1)).toBe(12);
      const steps = new Set(heights.slice(1).map((height, index) => height - heights[index]!));
      expect(steps.size).toBe(1);
      const [step] = steps;
      expect(Number.isInteger(step) && step! > 0).toBe(true);
    },
  );
});
