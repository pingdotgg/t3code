import { describe, expect, it } from "@effect/vitest";

import { hasHoveredNestedTooltipTrigger } from "./tooltip";

function tooltipFixture(input: { readonly hovered: boolean; readonly withinParent: boolean }) {
  const nestedTrigger = {
    matches: () => input.hovered,
  } as unknown as HTMLElement;
  const target = {
    closest: () => nestedTrigger,
  } as unknown as EventTarget;
  const parentTrigger = {
    contains: (element: Element) => input.withinParent && element === nestedTrigger,
    querySelector: () => (input.hovered && input.withinParent ? nestedTrigger : null),
  } as unknown as HTMLElement;
  return { nestedTrigger, parentTrigger, target };
}

describe("hasHoveredNestedTooltipTrigger", () => {
  it("preserves only a hovered nested trigger inside its open parent", () => {
    const nested = tooltipFixture({ hovered: true, withinParent: true });
    expect(hasHoveredNestedTooltipTrigger(nested.parentTrigger, nested.target)).toBe(true);
    const unhovered = tooltipFixture({ hovered: false, withinParent: true });
    expect(hasHoveredNestedTooltipTrigger(unhovered.parentTrigger, unhovered.target)).toBe(false);
    const unrelated = tooltipFixture({ hovered: true, withinParent: false });
    expect(hasHoveredNestedTooltipTrigger(unrelated.parentTrigger, unrelated.target)).toBe(false);
  });

  it("scopes synthetic provider closes to the current parent trigger", () => {
    const nested = tooltipFixture({ hovered: true, withinParent: true });
    expect(hasHoveredNestedTooltipTrigger(nested.parentTrigger, null)).toBe(true);

    const unrelated = tooltipFixture({ hovered: true, withinParent: false });
    expect(hasHoveredNestedTooltipTrigger(unrelated.parentTrigger, null)).toBe(false);
    expect(hasHoveredNestedTooltipTrigger(null, null)).toBe(false);
  });
});
