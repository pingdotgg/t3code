import { describe, expect, it } from "vite-plus/test";

import {
  normalizeLayoutScopedState,
  readLayoutScopedState,
  updateLayoutScopedState,
} from "./useLayoutScopedOpenState";

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

  it("ignores a stale setter after another layout becomes current", () => {
    const mobileClosed = { layout: "mobile", value: false } as const;

    expect(updateLayoutScopedState(mobileClosed, "desktop", true)).toBe(mobileClosed);
    expect(updateLayoutScopedState(mobileClosed, "desktop", (open) => !open)).toBe(mobileClosed);
  });

  it("applies direct and functional updates for the current layout", () => {
    const closed = { layout: "desktop", value: false } as const;
    const open = updateLayoutScopedState(closed, "desktop", true);

    expect(open).toEqual({ layout: "desktop", value: true });
    expect(updateLayoutScopedState(open, "desktop", (value) => !value)).toEqual({
      layout: "desktop",
      value: false,
    });
  });
});
