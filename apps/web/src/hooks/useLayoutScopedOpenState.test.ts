import { describe, expect, it } from "vite-plus/test";

import {
  normalizeLayoutScopedOpenState,
  readLayoutScopedOpenState,
} from "./useLayoutScopedOpenState";

describe("layout-scoped open state", () => {
  it("hides stale open state immediately and resets it for future remounts", () => {
    const desktopOpen = { layout: "desktop", open: true } as const;

    expect(readLayoutScopedOpenState(desktopOpen, "mobile")).toBe(false);

    const mobileClosed = normalizeLayoutScopedOpenState(desktopOpen, "mobile");
    expect(mobileClosed).toEqual({ layout: "mobile", open: false });
    expect(readLayoutScopedOpenState(mobileClosed, "desktop")).toBe(false);
    expect(normalizeLayoutScopedOpenState(mobileClosed, "desktop")).toEqual({
      layout: "desktop",
      open: false,
    });
  });

  it("preserves state while the rendered layout is unchanged", () => {
    const open = { layout: "expanded", open: true } as const;
    expect(normalizeLayoutScopedOpenState(open, "expanded")).toBe(open);
    expect(readLayoutScopedOpenState(open, "expanded")).toBe(true);
  });
});
