import { describe, expect, it } from "@effect/vitest";

import { hasHoveredNestedTooltipTrigger } from "./tooltip";

function tooltipEventTarget(input: {
  readonly hovered: boolean;
  readonly withinOpenParent: boolean;
}): EventTarget {
  const parentElement = {
    closest: () => (input.withinOpenParent ? ({} as Element) : null),
  } as unknown as HTMLElement;
  const nestedTrigger = {
    matches: () => input.hovered,
    parentElement,
  } as unknown as HTMLElement;
  return {
    closest: () => nestedTrigger,
  } as unknown as EventTarget;
}

describe("hasHoveredNestedTooltipTrigger", () => {
  it("preserves only a hovered nested trigger inside its open parent", () => {
    expect(
      hasHoveredNestedTooltipTrigger(tooltipEventTarget({ hovered: true, withinOpenParent: true })),
    ).toBe(true);
    expect(
      hasHoveredNestedTooltipTrigger(
        tooltipEventTarget({ hovered: false, withinOpenParent: true }),
      ),
    ).toBe(false);
    expect(
      hasHoveredNestedTooltipTrigger(
        tooltipEventTarget({ hovered: true, withinOpenParent: false }),
      ),
    ).toBe(false);
  });

  it("does not inspect unrelated document tooltip state", () => {
    expect(hasHoveredNestedTooltipTrigger(null)).toBe(false);
    expect(hasHoveredNestedTooltipTrigger({} as EventTarget)).toBe(false);
  });
});
