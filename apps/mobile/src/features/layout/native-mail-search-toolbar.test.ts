import { describe, expect, it, vi } from "vite-plus/test";

import { createNativeMailSearchToolbarItem } from "./native-mail-search-toolbar";

vi.mock("../../native/native-glass", () => ({
  NATIVE_LIQUID_GLASS_SUPPORTED: true,
}));

describe("createNativeMailSearchToolbarItem", () => {
  it("restores the visible native search text from the retained list query", () => {
    const item = createNativeMailSearchToolbarItem({
      onSearchTextChange: vi.fn(),
      placeholder: "Search",
      searchTextChangeId: "home-search-text",
      value: "sidebar",
    });

    expect(item).toMatchObject({
      searchText: "sidebar",
      type: "mailSearchToolbar",
      useFallbackSearchField: true,
    });
    expect(item).not.toHaveProperty("value");
  });
});
