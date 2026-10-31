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

  it("fills bars up to the current level and leaves max and workflow levels off the scale", () => {
    expect(resolveEffortGlyph(claude, "xhigh")).toMatchObject({
      count: 4,
      filled: 4,
      label: "Xhigh",
      sparkles: 0,
    });
  });

  it("draws max and workflow levels as full bars plus sparkles", () => {
    expect(resolveEffortGlyph(claude, "max")).toMatchObject({ filled: 4, sparkles: 1 });
    expect(resolveEffortGlyph(claude, "ultracode")).toMatchObject({ filled: 4, sparkles: 2 });
    const codex = descriptor(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(resolveEffortGlyph(codex, "ultra")).toMatchObject({ count: 4, filled: 4, sparkles: 2 });
    const short = descriptor(["high", "ultra"]);
    expect(resolveEffortGlyph(short, "ultra")).toMatchObject({ count: 1, filled: 1, sparkles: 2 });
    for (const named of [descriptor(["max", "ultra"]), descriptor(["off", "ultra"])]) {
      expect(resolveEffortGlyph(named, "ultra")).toMatchObject({ count: 1, sparkles: 2 });
    }
    expect(resolveEffortGlyph(claude, "ultrathink")).toMatchObject({
      filled: 4,
      sparkles: 2,
      label: "Ultrathink",
    });
  });

  it("colors only the levels that cost more than usual", () => {
    expect(resolveEffortGlyph(claude, "low")?.tone).toBeNull();
    expect(resolveEffortGlyph(claude, "medium")?.tone).toBeNull();
    expect(resolveEffortGlyph(claude, "high")?.tone).toContain("amber");
    expect(resolveEffortGlyph(claude, "xhigh")?.tone).toContain("red");
    expect(resolveEffortGlyph(claude, "max")?.tone).toContain("purple");
  });

  it("draws the lowest level as one bar, and an off level as none", () => {
    expect(resolveEffortGlyph(claude, "low")).toMatchObject({ count: 4, filled: 1 });
    expect(resolveEffortGlyph(claude, "medium")).toMatchObject({ count: 4, filled: 2 });
    expect(resolveEffortGlyph(descriptor(["off", "low", "high"]), "off")).toMatchObject({
      count: 2,
      filled: 0,
      label: "Off",
    });
  });

  it("falls back to the word when the value is unknown or the scale is too short or long", () => {
    expect(resolveEffortGlyph(claude, "unknown")).toBeNull();
    expect(resolveEffortGlyph(descriptor(["high"]), "high")).toBeNull();
    const levels = Array.from({ length: 8 }, (_, index) => `level${index}`);
    expect(resolveEffortGlyph(descriptor(levels), "level0")).toBeNull();
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
