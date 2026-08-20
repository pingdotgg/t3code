import { describe, expect, it, vi } from "@effect/vitest";

import { createSidebarHeaderItems } from "./sidebar-native-header-items";

describe("createSidebarHeaderItems", () => {
  it("adds independently disabled Back and Forward controls", () => {
    const items = createSidebarHeaderItems({
      canGoBack: false,
      canGoForward: true,
      filterIcon: "line.3.horizontal.decrease",
      filterMenu: { title: "Thread list options", items: [] },
      onBack: vi.fn(),
      onForward: vi.fn(),
      onOpenSettings: vi.fn(),
    });

    expect(items.slice(0, 2)).toEqual([
      expect.objectContaining({ accessibilityLabel: "Back", disabled: true }),
      expect.objectContaining({ accessibilityLabel: "Forward", disabled: false }),
    ]);
  });
});
