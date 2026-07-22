import { describe, expect, it } from "vite-plus/test";

import { normalizeLayoutScopedState, readLayoutScopedState } from "./useLayoutScopedOpenState";

describe("layout-scoped open state", () => {
  it("hides stale open state immediately and resets it for future remounts", () => {
    const desktopOpen = { layout: "desktop", value: true } as const;

    expect(readLayoutScopedState(desktopOpen, "mobile", false)).toBe(false);

    const mobileClosed = normalizeLayoutScopedState(desktopOpen, "mobile", false);
    expect(mobileClosed).toEqual({ layout: "mobile", value: false });
    expect(readLayoutScopedState(mobileClosed, "desktop", false)).toBe(false);
    expect(normalizeLayoutScopedState(mobileClosed, "desktop", false)).toEqual({
      layout: "desktop",
      value: false,
    });
  });

  it("preserves state while the rendered layout is unchanged", () => {
    const open = { layout: "expanded", value: true } as const;
    expect(normalizeLayoutScopedState(open, "expanded", false)).toBe(open);
    expect(readLayoutScopedState(open, "expanded", false)).toBe(true);
  });
});
